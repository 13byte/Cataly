import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { alive, inspect, LOCK_STALE_MS, type LockOwner, ownerOf } from "../checkpoint-lock.ts";
import { MessengerError } from "./http.ts";

export const tsAfter = (a: string, b: string): boolean => Number(a) > Number(b);

export type LedgerThread = { readonly channel: string; readonly rootTs: string; readonly seenTs: string };
type Threads = Map<string, LedgerThread>;

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 10_000;
const keyOf = (channel: string, rootTs: string): string => `${channel}:${rootTs}`;

/**
 * The Slack threads the Dori posted in, shared by every `dori send slack` and the long-lived receiver. Nothing is
 * cached: a read takes the file as it is now, and a change re-reads it under a writer lock, merges, and replaces it
 * atomically, so no process writes an old snapshot over another's threads and a seen position only moves forward.
 */
export class ThreadLedger {
  constructor(
    private readonly file: string,
    private readonly wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  private read(): Threads {
    const threads: Threads = new Map();
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return threads;
      throw error;
    }
    for (const t of JSON.parse(raw) as LedgerThread[]) threads.set(keyOf(t.channel, t.rootTs), t);
    return threads;
  }

  /**
   * Take the writer lock and return its release. A live writer holds it for milliseconds and is waited for; a lock
   * whose pid is dead on this host, or LOCK_STALE_MS old, is moved aside and removed only if it is still the one judged
   * stale. A lock with no owner record yet is aged by its mtime.
   */
  private async lock(): Promise<() => void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const record = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      at: new Date().toISOString(),
      nonce: randomUUID(),
    } satisfies LockOwner);
    for (let waited = 0; ; ) {
      try {
        writeFileSync(lock, record, { flag: "wx", mode: 0o600 });
        // Only this live writer could have made the lock stale, so it is still ours here.
        return () => {
          if (inspect(lock)?.raw === record) rmSync(lock, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = inspect(lock);
      if (!seen) continue;
      const owner = ownerOf(seen.raw);
      const at = owner ? Date.parse(owner.at) : NaN;
      const since = Number.isFinite(at) ? at : seen.mtimeMs;
      if ((owner?.host === hostname() && !alive(owner.pid)) || Date.now() - since >= LOCK_STALE_MS) {
        const moved = `${lock}.${process.pid}.${randomUUID()}.stale`;
        try {
          renameSync(lock, moved);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const taken = inspect(moved);
        // A newer writer's lock: put it back without replacing another one, and never delete it. Until it is back, a
        // third writer can take the empty path, so two writers may briefly overlap; this needs two takeovers of one
        // stale lock to interleave within microseconds, and then one overlapping write can lose the other's change.
        if (taken?.ino !== seen.ino || taken.raw !== seen.raw)
          try {
            linkSync(moved, lock);
          } catch {
            throw new MessengerError(
              `slack thread ledger lock of another writer could not be put back from ${moved}`,
              0,
            );
          }
        rmSync(moved, { force: true });
        continue;
      }
      if (waited >= LOCK_WAIT_MS)
        throw new MessengerError(`slack thread ledger ${lock} stayed locked by pid ${owner?.pid ?? "unknown"}`, 0);
      await this.wait(LOCK_RETRY_MS);
      waited += LOCK_RETRY_MS;
    }
  }

  /** Apply `change` to the latest threads on disk; a change that returns false writes nothing. */
  private async update(change: (threads: Threads) => boolean): Promise<void> {
    const release = await this.lock();
    try {
      const threads = this.read();
      if (!change(threads)) return;
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...threads.values()], null, 1));
      renameSync(tmp, this.file);
    } finally {
      release();
    }
  }

  /**
   * Registers a thread the Dori posted in. A new thread is read from the Dori's post on; a known one keeps its seen
   * position, which only the receiver moves (`markSeen`, after delivery): a reply that arrived before this post but has
   * not been delivered yet must still be read, and the Dori's own messages are skipped as they are read.
   */
  async record(channel: string, rootTs: string, postedTs: string): Promise<void> {
    await this.update((threads) => {
      if (threads.has(keyOf(channel, rootTs))) return false;
      threads.set(keyOf(channel, rootTs), { channel, rootTs, seenTs: postedTs });
      return true;
    });
  }

  async markSeen(channel: string, rootTs: string, ts: string): Promise<void> {
    await this.update((threads) => {
      const prev = threads.get(keyOf(channel, rootTs));
      if (!prev || !tsAfter(ts, prev.seenTs)) return false;
      threads.set(keyOf(channel, rootTs), { ...prev, seenTs: ts });
      return true;
    });
  }

  async list(): Promise<LedgerThread[]> {
    return [...this.read().values()];
  }
}
