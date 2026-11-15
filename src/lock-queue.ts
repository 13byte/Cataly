import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";

/**
 * A named lock shared with the shell waiters that only `mkdir <root>/state/<name>.lock` and write
 * `<lane> <YYYY-MM-DD HH:MM:SS> pid=<pid>` (local time) into its `owner` file. On top of that directory, waiters queue:
 * each writes a ticket into `<root>/state/locks/<name>/`, and only the head (lowest priority number, then first come)
 * tries the directory. A shell waiter still tries it on its own and may win a free lock; it is never turned away.
 */
export type LockEnv = {
  root: string;
  pid: number;
  now: () => number;
  alive: (pid: number) => boolean;
  /** One retry interval (RETRY_MS in production). */
  sleep: () => Promise<void>;
};

export type Ticket = { id: string; lane: string; pid: number; at: number; priority: number };
export type Holder = { owner: string; lane: string; pid?: number; since: number };

export const RETRY_MS = 2_000;
/** A lock directory with no owner line is a holder that died between mkdir and writing it, once it is this old. */
export const OWNERLESS_MS = 60_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new Refusal(`lock name must match ${NAME_RE}`);
  return name;
}

/** A priority as given: 1 (first) to 9 (last), 5 when none is. Backlog items, lanes and lock waiters share it. */
export function checkPriority(p: number | undefined): number {
  const priority = p ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9)
    throw new Refusal("--priority must be 1 (first) to 9 (last)");
  return priority;
}

export const lockDir = (root: string, name: string): string => join(root, "state", `${name}.lock`);
export const queueDir = (root: string, name: string): string => join(root, "state", "locks", name);

const pad = (n: number): string => String(n).padStart(2, "0");
/** The shell lock's owner time: local, second precision. */
export function stamp(ms: number): string {
  const t = new Date(ms);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

const readOr = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};
const pidOf = (owner: string): number | undefined => {
  const m = /pid=(\d+)/.exec(owner);
  return m ? Number(m[1]) : undefined;
};

/** The current holder from the owner line; a lock without one (yet) reports its directory time. */
export function holder(root: string, name: string): Holder | undefined {
  const dir = lockDir(root, name);
  let mtime: number;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const owner = readOr(join(dir, "owner"));
  if (owner === undefined) return { owner: "", lane: "?", since: mtime };
  const m = /^(\S+) (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(owner);
  const since = m ? new Date(`${m[2]}T${m[3]}`).getTime() : mtime;
  const pid = pidOf(owner);
  return { owner, lane: m?.[1] ?? owner.split(" ")[0]!, ...(pid !== undefined ? { pid } : {}), since };
}

const order = (a: Ticket, b: Ticket): number => a.priority - b.priority || a.at - b.at || a.id.localeCompare(b.id);

/** The queue in turn order. Tickets of dead waiters are removed; one that can't be read is skipped. */
export function tickets(env: LockEnv, name: string): Ticket[] {
  const dir = queueDir(env.root, name);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const live: Ticket[] = [];
  for (const f of files) {
    let t: Ticket;
    try {
      t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Ticket;
    } catch {
      continue;
    }
    if (env.alive(t.pid)) live.push({ ...t, id: f.slice(0, -5) });
    else rmSync(join(dir, f), { force: true });
  }
  return live.sort(order);
}

export function enqueue(env: LockEnv, name: string, lane: string, priority: number): Ticket {
  const dir = queueDir(env.root, name);
  mkdirSync(dir, { recursive: true });
  const at = env.now();
  const t: Ticket = { id: `${at}-${env.pid}-${randomUUID().slice(0, 8)}`, lane, pid: env.pid, at, priority };
  writeTicket(dir, t);
  return t;
}

// Written whole under another name and renamed, so a reader never sees half a ticket.
const writeTicket = (dir: string, t: Ticket): void => {
  const { id, ...body } = t;
  writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(body));
  renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
};

/** Why the lock in place is left behind (and may be cleared), or undefined while its holder may still be running. */
function staleWhy(env: LockEnv, dir: string, owner: string | undefined): string | undefined {
  if (owner === undefined) {
    const age = env.now() - statSync(dir).mtimeMs;
    return age > OWNERLESS_MS ? `ownerless lock older than ${OWNERLESS_MS / 1000}s` : undefined;
  }
  const pid = pidOf(owner);
  return pid !== undefined && !env.alive(pid) ? `stale lock from dead pid ${pid} (${owner})` : undefined;
}

/**
 * The stale lock is moved aside with rename(2), which only one process wins; if what was moved is not the lock judged
 * stale (a shell waiter cleared it and took a new one in between), it is moved back.
 */
function clear(env: LockEnv, dir: string, seen: string | undefined): void {
  const aside = `${dir}.stale.${env.pid}.${randomUUID().slice(0, 8)}`;
  try {
    renameSync(dir, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (readOr(join(aside, "owner")) === seen) rmSync(aside, { recursive: true, force: true });
  else renameSync(aside, dir);
}

/** One attempt at the lock directory: the owner line written, or why it is busy. */
export function tryTake(
  env: LockEnv,
  name: string,
  lane: string,
  log: (line: string) => void,
): { owner: string } | { busy: string } {
  const dir = lockDir(env.root, name);
  for (let i = 0; i < 3; i++) {
    try {
      mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const seen = readOr(join(dir, "owner"));
      let why: string | undefined;
      try {
        why = staleWhy(env, dir, seen);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (why === undefined) return { busy: seen ?? "a holder still writing its owner line" };
      log(`LOCK ${name}: ${why}; clearing`);
      clear(env, dir, seen);
      continue;
    }
    const owner = `${lane} ${stamp(env.now())} pid=${env.pid}`;
    writeFileSync(join(dir, "owner.tmp"), `${owner}\n`);
    renameSync(join(dir, "owner.tmp"), join(dir, "owner"));
    return { owner };
  }
  return { busy: "contended" };
}

/** Removes the lock only while it is still this owner's. */
export function release(root: string, name: string, owner: string): void {
  const dir = lockDir(root, name);
  if (readOr(join(dir, "owner")) === owner) rmSync(dir, { recursive: true, force: true });
}

/**
 * Queues, waits for this ticket's turn and takes the lock: its owner line, or undefined once `stop` aborts (the
 * ticket is withdrawn either way). A line goes to `log` whenever what it waits on changes.
 */
export async function take(
  env: LockEnv,
  name: string,
  lane: string,
  priority: number,
  stop: AbortSignal,
  log: (line: string) => void = () => {},
): Promise<string | undefined> {
  const mine = enqueue(env, name, lane, priority);
  const { promise: stopped, resolve } = Promise.withResolvers<void>();
  stop.addEventListener("abort", () => resolve(), { once: true });
  let said = "";
  try {
    while (!stop.aborted) {
      const queue = tickets(env, name);
      const at = queue.findIndex((t) => t.id === mine.id);
      if (at < 0) writeTicket(queueDir(env.root, name), mine);
      let waiting: string;
      if (at === 0) {
        const got = tryTake(env, name, lane, log);
        if ("owner" in got) return got.owner;
        waiting = `held by ${got.busy}`;
      } else waiting = `${at < 0 ? queue.length + 1 : at + 1} in line after ${queue[0]?.lane ?? "?"}`;
      if (waiting !== said) log(`LOCK ${name}: waiting (p${priority}), ${waiting}`);
      said = waiting;
      await Promise.race([env.sleep(), stopped]);
    }
    return undefined;
  } finally {
    rmSync(join(queueDir(env.root, name), `${mine.id}.json`), { force: true });
  }
}
