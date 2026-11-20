/**
 * Persistent monitors for the Dori session: a command runs in the background (argv, never a shell) and every
 * stdout/stderr line matching its filter wakes the session. This is the "your monitor tool" the Dori setup
 * expects; omp has no built-in equivalent.
 */
import type { Subprocess } from "bun";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import type { HeadAdmissions } from "./head-admission.ts";
import { MonitorOutputFile, readMonitorOutput } from "./monitor-output";

/** Lines arriving within this window after the first one are delivered together. */
export const BATCH_MS = 300;
/** A burst longer than this is split so one message never grows unbounded. */
const BATCH_MAX_LINES = 100;
const BATCH_MAX_BYTES = 64 * 1024;

type Running = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: RegExp;
  readonly cwd: string;
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Session the monitor was started in; its lines are delivered only while that session is current. */
  readonly session: string;
  readonly signal: AbortSignal;
  readonly restart?: MonitorSpec["restart"];
  stopped: boolean;
  admitting: boolean;
  prepared?: {
    readonly epoch: number;
    readonly headFile: string;
    readonly identity: unknown;
    readonly fingerprint: unknown;
    readonly content: unknown;
  };
};

export type MonitorInfo = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly pid: number;
  readonly cwd: string;
  readonly restart?: MonitorSpec["restart"];
};

export type MonitorDelivery = {
  readonly session: string;
  readonly signal: AbortSignal;
  readonly details?: unknown;
  isCurrent(): boolean;
};
type Deliver = (content: string, delivery: MonitorDelivery) => unknown;

export class Monitors {
  readonly #running = new Map<string, Running>();
  readonly #restarts = new Map<string, { entry: Running; timer: Timer }>();
  #pending: Array<{ readonly entry: Running; readonly text: string }> = [];
  #timer: Timer | undefined;
  #pendingBytes = 0;
  #generation = new AbortController();
  #admissionEpoch = 0;
  #flight: Promise<void> | undefined;
  readonly #deliver: Deliver;
  readonly #admissions: HeadAdmissions | undefined;
  readonly #currentSession: () => string | undefined;
  readonly #batchMs: number;
  readonly #restartMs: number;

  constructor(
    deliver: Deliver,
    currentSession: () => string | undefined,
    batchMs = BATCH_MS,
    restart: number | HeadAdmissions = 5_000,
  ) {
    this.#deliver = deliver;
    this.#currentSession = currentSession;
    this.#batchMs = batchMs;
    this.#restartMs = typeof restart === "number" ? restart : 5_000;
    this.#admissions = typeof restart === "number" ? undefined : restart;
  }

  start(
    name: string,
    argv: readonly string[],
    filter: string,
    cwd: string,
    session: string,
    restart?: MonitorSpec["restart"],
  ): MonitorInfo {
    if (!name) throw new Error("monitor name is required");
    if (this.#running.has(name) || this.#restarts.has(name))
      throw new Error(`monitor "${name}" is already running or waiting to restart; stop it first`);
    return this.#spawn({ name, argv, filter, cwd, ...(restart ? { restart } : {}) }, session, 0);
  }

  #spawn({ name, argv, filter, cwd, restart }: MonitorSpec, session: string, attempt: number): MonitorInfo {
    if (argv.length === 0) throw new Error("argv must name the command to run");
    const pattern = new RegExp(filter);
    let entry: Running;
    const proc = Bun.spawn([...argv], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(this.#admissions
        ? {
            env: { ...process.env, DORI_MONITOR_ADMISSION: "1" },
            serialization: "json" as const,
            ipc: (message: unknown) => this.#ipc(entry, message),
          }
        : {}),
    });
    entry = {
      name,
      argv: [...argv],
      filter: pattern,
      cwd,
      proc,
      session,
      signal: this.#generation.signal,
      stopped: false,
      admitting: false,
      restart,
    };
    this.#running.set(name, entry);
    const finish = proc.exited.then((code) => {
      this.#admissions?.stop(proc.pid);
      return code;
    });
    let previous = attempt;
    const startedAt = performance.now();
    const exited =
      restart === "on-failure"
        ? finish.then((code) => {
            // Only time spent running the child resets a failure streak, not blocked output delivery.
            if (performance.now() - startedAt >= 60_000) previous = 0;
            return code;
          })
        : finish;
    void Promise.all([this.#pump(entry, proc.stdout, "stdout"), this.#pump(entry, proc.stderr, "stderr"), exited])
      .then(async ([, , code]) => {
        if (this.#running.get(name) !== entry) return;
        const retryable = restart === "on-failure" && (code !== 0 || Boolean(proc.signalCode));
        if (retryable && !entry.stopped && this.#current(entry)) {
          // Do not replace the child while delivery from this incarnation can still fail.
          await this.#flush();
          if (this.#running.get(name) !== entry) return;
        }
        this.#running.delete(name);
        if (entry.stopped || !this.#current(entry)) return;
        if (retryable && this.#scheduleRestart(entry, previous)) return;
        await this.#queue(
          entry,
          `[${name}] monitor exited (${proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`}): ${argv.join(" ")}`,
        );
      })
      .catch(async (error: unknown) => {
        if (entry.stopped || !this.#current(entry)) return;
        entry.stopped = true;
        this.#admissions?.stop(proc.pid);
        entry.proc.kill();
        if (this.#running.get(name) === entry) this.#running.delete(name);
        await this.#queue(
          entry,
          `[monitor] output failed for name=${JSON.stringify(name.slice(0, 256))}${name.length > 256 ? "..." : ""} pid=${proc.pid}; stopped; raw output may be incomplete: ${String(error).slice(0, 2048)}`,
        );
      })
      .catch((error: unknown) => console.error("monitor failure reporting failed", error));
    return { name, argv: entry.argv, filter, cwd, pid: proc.pid, ...(restart ? { restart } : {}) };
  }

  #scheduleRestart(entry: Running, previous: number): boolean {
    if (previous >= 3) return false;
    const timer = setTimeout(() => {
      if (this.#restarts.get(entry.name)?.entry !== entry) return;
      this.#restarts.delete(entry.name);
      if (entry.stopped || !this.#current(entry)) return;
      try {
        const { name, argv, filter, cwd, restart, session } = entry;
        this.#spawn({ name, argv, filter: filter.source, cwd, ...(restart ? { restart } : {}) }, session, previous + 1);
      } catch (error) {
        void this.#queue(entry, `[${entry.name}] monitor restart failed: ${String(error).slice(0, 1024)}`).catch(
          (reportError: unknown) => console.error("monitor restart reporting failed", reportError),
        );
      }
    }, this.#restartMs);
    this.#restarts.set(entry.name, { entry, timer });
    return true;
  }

  /** Live and scheduled specifications, without mistaking a scheduled retry for a live child. */
  specs(): MonitorSpec[] {
    return [...this.#running.values(), ...Array.from(this.#restarts.values(), ({ entry }) => entry)].map(
      ({ name, argv, filter, cwd, restart }) => ({
        name,
        argv,
        filter: filter.source,
        cwd,
        ...(restart ? { restart } : {}),
      }),
    );
  }

  stop(name: string): boolean {
    const restart = this.#restarts.get(name);
    if (restart) {
      restart.entry.stopped = true;
      clearTimeout(restart.timer);
      this.#restarts.delete(name);
      return true;
    }
    const entry = this.#running.get(name);
    if (!entry) return false;
    entry.stopped = true;
    this.#admissions?.stop(entry.proc.pid);
    entry.proc.kill();
    this.#running.delete(name);
    return true;
  }

  list(): MonitorInfo[] {
    return [...this.#running.values()].map((entry) => ({
      name: entry.name,
      argv: entry.argv,
      filter: entry.filter.source,
      pid: entry.proc.pid,
      cwd: entry.cwd,
      ...(entry.restart ? { restart: entry.restart } : {}),
    }));
  }

  /** Session end: kill every monitor and drop undelivered lines, which belong to the session that is going away. */
  stopAll(): void {
    this.#generation.abort();
    this.#generation = new AbortController();
    this.invalidateAdmissions();
    for (const name of [...this.#running.keys()]) this.stop(name);
    for (const name of this.#restarts.keys()) this.stop(name);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  /** A branch/tree change invalidates pending native handoffs without stopping ordinary monitors. */
  invalidateAdmissions(): void {
    this.#admissionEpoch++;
    this.#admissions?.stop();
  }

  #ipc(entry: Running, raw: unknown): void {
    const admissions = this.#admissions;
    const epoch = this.#admissionEpoch;
    const sourceIsRunning = () =>
      !entry.stopped &&
      entry.proc.exitCode === null &&
      entry.proc.signalCode === null &&
      this.#running.get(entry.name) === entry;
    const isCurrent = () => epoch === this.#admissionEpoch && sourceIsRunning() && this.#current(entry);
    if (
      !admissions ||
      !sourceIsRunning() ||
      raw === null ||
      typeof raw !== "object" ||
      !("protocol" in raw) ||
      raw.protocol !== "dori-head-admission-v1"
    )
      return;
    const fail = () => {
      entry.admitting = false;
      if (!sourceIsRunning()) return;
      entry.stopped = true;
      admissions.stop(entry.proc.pid);
      this.#running.delete(entry.name);
      entry.proc.kill();
      void this.#queue(entry, `[monitor] ${entry.name} native admission failed; intake state retained`).catch(
        (error: unknown) => console.error("monitor admission failure reporting failed", error),
      );
    };
    if (!isCurrent()) {
      delete entry.prepared;
      if (
        !("request" in raw) ||
        typeof raw.request !== "string" ||
        raw.request.length === 0 ||
        raw.request.length > 64
      ) {
        fail();
        return;
      }
      try {
        entry.proc.send({ protocol: raw.protocol, request: raw.request, outcome: "unresolved" });
      } catch {
        fail();
      }
      return;
    }
    if (entry.admitting) {
      fail();
      return;
    }
    // A prepared delivery is single-use and belongs to this child, source and head activation.
    const prepared = entry.prepared;
    delete entry.prepared;
    if (
      "op" in raw &&
      raw.op === "dispatch" &&
      (!prepared ||
        prepared.epoch !== epoch ||
        !("headFile" in raw) ||
        raw.headFile !== prepared.headFile ||
        !("identity" in raw) ||
        raw.identity !== prepared.identity ||
        !("fingerprint" in raw) ||
        raw.fingerprint !== prepared.fingerprint ||
        !("content" in raw) ||
        raw.content !== prepared.content)
    ) {
      fail();
      return;
    }
    entry.admitting = true;
    void admissions
      .receive(raw, {
        source: entry.proc.pid,
        session: entry.session,
        accepts(content) {
          if (!isCurrent()) throw new Error("inactive head source");
          return content.split("\n").some((line) => entry.filter.test(line));
        },
        deliver: async (content, details) => {
          if (!isCurrent()) throw new Error("inactive head source");
          await this.#flush(async () => {
            if (!isCurrent()) throw new Error("inactive head source");
            const text = content
              .split("\n")
              .map((line) => `[${entry.name}] ${line}`)
              .join("\n");
            await this.#deliver(this.#bounded(entry, text), {
              session: entry.session,
              signal: entry.signal,
              isCurrent,
              details,
            });
          });
          if (!isCurrent()) throw new Error("inactive head source");
        },
      })
      .then((reply) => {
        entry.admitting = false;
        if (isCurrent() && reply.outcome === "ready" && "identity" in raw && "fingerprint" in raw && "content" in raw) {
          entry.prepared = {
            epoch,
            headFile: reply.headFile,
            identity: raw.identity,
            fingerprint: raw.fingerprint,
            content: raw.content,
          };
        }
        if (sourceIsRunning())
          entry.proc.send(
            isCurrent() ? reply : { protocol: reply.protocol, request: reply.request, outcome: "unresolved" },
          );
      })
      .catch(fail);
  }

  async #pump(entry: Running, stream: ReadableStream<Uint8Array>, source: string): Promise<void> {
    await readMonitorOutput(
      stream,
      (line) => this.#line(entry, line),
      (notice) => (entry.stopped ? undefined : this.#queue(entry, `[${entry.name}] monitor ${source} ${notice}`)),
      () => entry.stopped || !this.#current(entry),
    );
  }

  #current(entry: Running): boolean {
    return (
      !entry.signal.aborted && entry.signal === this.#generation.signal && entry.session === this.#currentSession()
    );
  }

  async #line(entry: Running, line: string): Promise<void> {
    if (!entry.stopped && entry.filter.test(line)) await this.#queue(entry, `[${entry.name}] ${line}`);
  }

  #bounded(entry: Running, text: string): string {
    const bytes = Buffer.byteLength(text);
    if (bytes > BATCH_MAX_BYTES) {
      const output = new MonitorOutputFile();
      try {
        output.write(Buffer.from(text));
      } finally {
        output.close();
      }
      text = `[monitor] message saved for name=${JSON.stringify(entry.name.slice(0, 256))}${entry.name.length > 256 ? "..." : ""} pid=${entry.proc.pid}: ${bytes} bytes; file=${JSON.stringify(output.path)}`;
    }
    return text;
  }

  async #queue(entry: Running, text: string): Promise<void> {
    if (!this.#current(entry)) return;
    text = this.#bounded(entry, text);
    const bytes = Buffer.byteLength(text);
    while (
      this.#pending.length >= BATCH_MAX_LINES ||
      this.#pendingBytes + bytes + (this.#pending.length ? 1 : 0) > BATCH_MAX_BYTES
    ) {
      await this.#flush();
      if (!this.#current(entry)) return;
    }
    this.#pendingBytes += bytes + (this.#pending.length ? 1 : 0);
    this.#pending.push({ entry, text });
    if (this.#pending.length >= BATCH_MAX_LINES || this.#pendingBytes >= BATCH_MAX_BYTES) await this.#flush();
    else
      this.#timer ??= setTimeout(() => {
        void this.#flush().catch((error: unknown) => console.error("monitor flush failed", error));
      }, this.#batchMs);
  }

  async #flush(admit?: () => Promise<void>): Promise<void> {
    const signal = this.#generation.signal;
    while (this.#flight) {
      await this.#flight;
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const lines = this.#pending.filter(({ entry }) => this.#current(entry));
    this.#pending = [];
    this.#pendingBytes = 0;
    const first = lines[0]?.entry;
    if (!first && !admit) return;
    const done = (async () => {
      if (first) {
        const delivery: MonitorDelivery = {
          session: first.session,
          signal: first.signal,
          isCurrent: () => this.#current(first),
        };
        try {
          await this.#deliver(lines.map(({ text }) => text).join("\n"), delivery);
        } catch (error) {
          if (delivery.signal.aborted && error === delivery.signal.reason) return;
          if (!delivery.isCurrent()) {
            console.error("monitor delivery failed after session invalidation", error);
            return;
          }
          const entries = [...new Set(lines.map(({ entry }) => entry))];
          for (const entry of entries) {
            entry.stopped = true;
            this.#admissions?.stop(entry.proc.pid);
            if (this.#running.get(entry.name) === entry) {
              entry.proc.kill();
              this.#running.delete(entry.name);
            }
          }
          const notice = `[monitor] delivery failed for name=${JSON.stringify(first.name.slice(0, 256))}; stopped ${entries.length} monitor(s); raw output may be incomplete: ${String(error).slice(0, 2048)}`;
          try {
            if (delivery.isCurrent()) await this.#deliver(notice, delivery);
          } catch (reportError) {
            console.error(notice, reportError);
          }
        }
      }
      await admit?.();
    })();
    // Other writers wait for completion; this caller still receives its own delivery failure.
    const completed = done.catch(() => undefined);
    this.#flight = completed;
    try {
      await done;
    } finally {
      if (this.#flight === completed) this.#flight = undefined;
    }
  }
}

export const MONITOR_DESCRIPTION = [
  "Persistent background monitors for this Dori session.",
  'op "start" runs `argv` (an argument array, never a shell string) in the session cwd and reads its stdout and stderr line by line. Matching `filter` lines wake this session as a message `[name] line`; lines arriving together are delivered in one message. Exits are reported unless an explicit `restart: "on-failure"` schedules a retry. That option retries nonzero exits or signals up to three times in a failure streak, after five seconds each. Clean exits are never retried.',
  "Lines over 64 KiB are streamed to a private temporary file instead of filtered or truncated. An immediate warning gives its path; completion gives its raw byte count. Batches are limited to 64 KiB including prefixes and separators; an oversized rendered message is preserved in a file too. Read those files for the complete output. They survive monitor stop; remove them only when no longer needed. Storage/read failure stops the monitor and reports potentially incomplete output.",
  'op "stop" kills the monitor `name` and forgets it. op "list" shows running monitors. Names are unique: starting a running name fails.',
  "Started monitors are recorded in this session. Their processes stop when omp exits, and when the session is resumed (herdr restoring it after a restart, or `omp --resume`) every monitor that was not stopped is started again and announced as `[monitor] restored ...`; you do not need to start them again.",
].join("\n");
