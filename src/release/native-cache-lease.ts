import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bootId, processExists, procStat } from "../update/proc.ts";
import { owned, realDirectory } from "./files.ts";
import { liveTasks } from "./process-cwd.ts";

/**
 * Shared leases and the exclusive prune lock of the native cache.
 *
 * Every writer that creates, verifies, publishes or launches an identity first leases it (`leaseNativeIdentity`), then
 * reads the prune lock; a prune claims the lock (`claimNativePrune`), then reads the leases. Either the prune sees the
 * lease and keeps the identity, or the writer sees the lock and waits until the prune is over.
 */

/** A process as a lease or the lock records it. `exec` keeps all three, so a shell's lease covers what it execs. */
export type CacheHolder = { readonly pid: number; readonly startTicks: string; readonly bootId: string };

const LEASES = "native-leases";
const LOCK = "native-prune.lock";
const IDENTITY = /^[a-f0-9]{64}$/;
const LEASE = /^([1-9]\d*)-(\d+)-([A-Za-z0-9-]+)$/;
/** How long a writer waits for a running prune before it gives up. */
const WAIT_MS = 300_000;

export const nativeCacheRoot = (home: string): string => join(home, ".cache/omp-dori");

/** The running process `pid` as a holder; a process that is gone or a zombie cannot hold anything. */
export function cacheHolder(pid: number): CacheHolder {
  try {
    const stat = procStat(pid);
    if (Number.isSafeInteger(pid) && pid > 0 && /^\d+$/.test(stat.startTicks) && !stat.zombie)
      return { pid, startTicks: stat.startTicks, bootId: bootId() };
  } catch {
    // Reported below.
  }
  throw new Error(`Native cache holder process ${pid} is unavailable`);
}

/** Whether a recorded holder has certainly ended; what cannot be confirmed counts as still running. */
export function holderEnded(holder: CacheHolder, boot = bootId()): boolean {
  if (holder.bootId !== boot) return true;
  try {
    const stat = procStat(holder.pid);
    if (stat.startTicks !== holder.startTicks) return true;
    // A Linux thread group lives on after its leader exits (the leader then shows as a zombie).
    return stat.zombie && (process.platform !== "linux" || liveTasks(String(holder.pid)) === undefined);
  } catch {
    try {
      return !processExists(holder.pid);
    } catch {
      return false;
    }
  }
}

export const leaseName = (holder: CacheHolder): string => `${holder.pid}-${holder.startTicks}-${holder.bootId}`;
function parseLease(name: string): CacheHolder | undefined {
  const match = LEASE.exec(name);
  return match ? { pid: Number(match[1]), startTicks: match[2]!, bootId: match[3]! } : undefined;
}

/** The holder of a script's lease: the shell `DORI_NATIVE_LEASE_PID` names, else the parent that will exec OMP. */
export function scriptLeaseHolder(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const named = env["DORI_NATIVE_LEASE_PID"];
  if (named !== undefined && !/^[1-9]\d*$/.test(named)) throw new Error("DORI_NATIVE_LEASE_PID must be a process id");
  if (named) return Number(named);
  // An orphan's parent is init, which never ends; the script itself holds then.
  return process.ppid > 1 ? process.ppid : process.pid;
}

/** A private directory that concurrent writers may create at the same moment. */
function directory(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      realDirectory(path, true);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3) throw error;
    }
  }
  owned(path);
}

function readHolder(lock: string): CacheHolder | undefined {
  try {
    const value = JSON.parse(readFileSync(lock, "utf8")) as Partial<CacheHolder> | null;
    const { pid, startTicks, bootId: boot } = value ?? {};
    if (Number.isSafeInteger(pid) && pid! > 0 && typeof startTicks === "string" && /^\d+$/.test(startTicks))
      if (typeof boot === "string" && boot !== "") return { pid: pid!, startTicks, bootId: boot };
  } catch {
    // Reported by the caller as a lock it cannot read.
  }
  return undefined;
}

/** Who holds the prune lock while that prune may still run; undefined without a lock or once its holder ended. */
function pruneHolder(cache: string): string | undefined {
  const lock = join(cache, LOCK);
  if (!lstatSync(lock, { throwIfNoEntry: false })) return undefined;
  const holder = readHolder(lock);
  if (!holder) return `unreadable ${lock}`;
  return holderEnded(holder) ? undefined : `pid ${holder.pid}`;
}

/**
 * Lease `identity` for `holder` until that process ends, then wait while a prune holds the cache. Callers create,
 * verify or launch the identity only after this returns, so one a prune removed meanwhile fails their verification.
 */
export function leaseNativeIdentity(home: string, identity: string, holder = process.pid, waitMs = WAIT_MS): void {
  if (!IDENTITY.test(identity)) throw new Error(`Invalid native cache identity: ${identity}`);
  const cache = nativeCacheRoot(home);
  const leases = join(cache, LEASES, identity);
  const own = cacheHolder(holder);
  const name = leaseName(own);
  for (let attempt = 0; ; attempt++) {
    directory(leases);
    try {
      closeSync(openSync(join(leases, name), "wx", 0o600));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") break;
      // A prune removes an identity's empty lease directory; it is made again.
      if (code !== "ENOENT" || attempt >= 3) throw error;
    }
  }
  const boot = own.bootId;
  for (const other of readdirSync(leases)) {
    const ended = other === name ? undefined : parseLease(other);
    if (ended && holderEnded(ended, boot)) rmSync(join(leases, other), { force: true });
  }
  const deadline = Date.now() + waitMs;
  for (let running = pruneHolder(cache); running; running = pruneHolder(cache)) {
    if (Date.now() >= deadline)
      throw new Error(`A native cache prune (${running}) holds ${cache}; retry once it has finished`);
    Bun.sleepSync(100);
  }
}

/**
 * Live leases by identity, and leases this cannot read (they keep every identity). With `sweep`, which only a prune
 * holding the lock passes, a lease whose holder ended and an emptied identity directory are removed.
 */
export function readLeases(cache: string, sweep: boolean): { byIdentity: Map<string, string[]>; unread: string[] } {
  const root = join(cache, LEASES);
  const byIdentity = new Map<string, string[]>();
  const unread: string[] = [];
  if (!lstatSync(root, { throwIfNoEntry: false })) return { byIdentity, unread };
  realDirectory(root);
  owned(root);
  const boot = bootId();
  for (const identity of readdirSync(root)) {
    const dir = join(root, identity);
    if (!IDENTITY.test(identity) || !lstatSync(dir).isDirectory()) {
      unread.push(`unrecognized lease ${dir}`);
      continue;
    }
    const held: string[] = [];
    for (const name of readdirSync(dir)) {
      const holder = parseLease(name);
      if (!holder) held.push(`unrecognized lease ${join(dir, name)}`);
      else if (!holderEnded(holder, boot)) held.push(`lease of process ${holder.pid}`);
      else if (sweep) rmSync(join(dir, name), { force: true });
    }
    if (held.length) byIdentity.set(identity, held);
    else if (sweep)
      try {
        rmdirSync(dir);
      } catch {
        // A writer leased it meanwhile; it stays.
      }
  }
  return { byIdentity, unread };
}

/** Claim the prune lock for this process. Another prune that may still run, or a lock this cannot read, refuses. */
export function claimNativePrune(home: string): () => void {
  const cache = nativeCacheRoot(home);
  realDirectory(cache);
  owned(cache);
  const lock = join(cache, LOCK);
  const own = cacheHolder(process.pid);
  const held = (holder?: CacheHolder) =>
    new Error(`Another native cache prune holds ${lock}${holder ? ` (pid ${holder.pid})` : ""}; nothing was removed`);
  // The lock is a file that appears whole: its owner is written first, then hard-linked into place, which never
  // replaces anything already there (an empty directory included).
  const claim = join(cache, `native-prune.claim-${randomUUID()}`);
  writeFileSync(claim, JSON.stringify(own), { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(claim, lock);
    } catch (error) {
      // A claim another prune swept away under its lock (see below) lost to that prune.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw held();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(lock);
      if (!holder || !holderEnded(holder)) throw held(holder);
      // An ended holder's lock is first linked to a tombstone named after it, which only one recoverer can create; one
      // that read the holder late may link a newer lock, which it then sees by its owner and leaves in place.
      const tomb = `${lock}.ended-${leaseName(holder)}`;
      try {
        linkSync(lock, tomb);
      } catch {
        throw held();
      }
      const linked = readHolder(tomb);
      if (linked?.pid !== holder.pid || linked.startTicks !== holder.startTicks) {
        unlinkSync(tomb);
        throw held(linked);
      }
      try {
        unlinkSync(lock);
        linkSync(claim, lock);
      } catch {
        throw held();
      }
    }
  } finally {
    rmSync(claim, { force: true });
  }
  // Under the lock, what ended prunes left goes: tombstones (see above) and claims never linked.
  for (const name of readdirSync(cache))
    if (/^native-prune\.(?:lock\.ended-|claim-)/.test(name)) rmSync(join(cache, name), { force: true });
  return () => {
    const holder = readHolder(lock);
    if (holder?.pid !== own.pid || holder.startTicks !== own.startTicks)
      throw new Error(`Native cache prune lock changed: ${lock}`);
    unlinkSync(lock);
  };
}
