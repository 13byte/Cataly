import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { procStat } from "../update/proc.ts";
import { readLeases } from "./native-cache-lease.ts";
import { processCwds, processStart } from "./process-cwd.ts";

/**
 * Dori processes that create, verify or launch identities. Writers from this release lease what they use; an already
 * running older checkout does not, so while any of them runs for this cache no identity is confirmed unused.
 */
const WRITER = [
  /\/scripts\/install-source\.sh(?:\s|$)/,
  /\/src\/release\/cli\.ts\s+(?:install|rollback)(?:\s|$)/,
  /\/cli\.ts\s+(?:update|upstream)\s+(?:install|rollback|check|stage|watch|restart|recover)(?:\s|$)/,
];
/** Its cache home is an argument (`<action> <source> <home>`), not the environment. */
const SOURCE_WRITER = /\/scripts\/source-dependencies\.ts\s+(?:native|assert-native|consumer)(?:\s|$)/;
/** Linux `PF_KTHREAD`: a kernel thread has no working directory in a user's files. */
const KERNEL_THREAD = 0x0020_0000n;
/** `CAP_DAC_OVERRIDE` and `CAP_DAC_READ_SEARCH`: a process holding either can enter an owner-only directory. */
const ENTERS_ANY = 0b110n;

/** `pid uid args` per running process, as `ps` prints them. */
function processTable(): string {
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,uid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("Process table is unavailable; native cache use cannot be ruled out");
  return ps.stdout.toString();
}

/** A process's start as the report prints it and `--trust-process` names it; a reused pid has another. */
export function startOf(pid: string): string | undefined {
  if (process.platform === "linux") return processStart(pid);
  try {
    return procStat(Number(pid)).startTicks;
  } catch {
    return undefined;
  }
}

/**
 * Whether another user's process could be inside an owner-only entry: root, or (Linux) one holding a capability that
 * ignores directory permissions; never a kernel thread. Other users cannot enter (receipts keep an entry whose directory
 * lets them). A process this cannot inspect counts as able to.
 */
function entersAny(pid: string, uid: number): boolean {
  if (process.platform !== "linux") return uid === 0;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (BigInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[6] ?? "0") & KERNEL_THREAD) return false;
    if (uid === 0) return true;
    const caps = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return caps === undefined || (BigInt(`0x${caps}`) & ENTERS_ANY) !== 0n;
  } catch {
    return true;
  }
}

/** Whether a Dori writer works on the cache under `homes`: by its home argument, else by its environment's HOME. */
function writesHere(pid: string, args: string, homes: readonly string[]): boolean {
  if (homes.some((home) => args.includes(home))) return true;
  // A source dependency writer that does not name this home works on another cache.
  if (SOURCE_WRITER.test(args)) return false;
  if (process.platform !== "linux") return true;
  try {
    const home = /(?:^|\0)HOME=([^\0]*)/.exec(readFileSync(`/proc/${pid}/environ`, "latin1"))?.[1];
    return home === undefined || homes.includes(resolve(home));
  } catch {
    return true;
  }
}

export type UseHoldOptions = {
  /** Under the prune lock: remove leases whose holder ended. */
  readonly sweep?: boolean;
  readonly table?: () => string;
  readonly readCwds?: typeof processCwds;
  /** `--trust-root-cwd`: privileged processes whose working directory cannot be read are not held on. */
  readonly trustRootCwd?: boolean;
  /** Receives `PID@START (args)` of every privileged process whose working directory could not be read. */
  readonly privileged?: Set<string>;
};

/**
 * What keeps identities besides what the report reads (see `protections`, which judges this user's processes): a live
 * lease keeps its identity; a lease that cannot be read, a preparation in progress or interrupted (`native-stage-*`), a
 * running Dori writer for this cache and a privileged process whose working directory cannot be read keep every
 * identity. Keys may also be detached names (`<identity>.pruning`), which a lease on that identity keeps too.
 */
export function useHolds(cache: string, keys: readonly string[], options: UseHoldOptions = {}): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const add = (key: string, reason: string) => {
    const kept = reasons.get(key) ?? [];
    if (!kept.includes(reason)) reasons.set(key, [...kept, reason]);
  };
  const all = (reason: string) => {
    for (const key of keys) add(key, reason);
  };
  const leases = readLeases(cache, options.sweep === true);
  for (const reason of leases.unread) all(reason);
  for (const key of keys) for (const reason of leases.byIdentity.get(key.slice(0, 64)) ?? []) add(key, reason);
  for (const name of readdirSync(cache))
    if (name.startsWith("native-stage-")) all(`native preparation in progress or interrupted ${join(cache, name)}`);
  const home = resolve(cache, "../..");
  const homes = [...new Set([home, realpathSync(home)])];
  const uid = process.getuid?.();
  const privileged: { pid: string; args: string }[] = [];
  for (const line of (options.table ?? processTable)().split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!row) continue;
    const [, pid, owner, raw] = row as unknown as [string, string, string, string];
    const args = raw.trim();
    if ((SOURCE_WRITER.test(args) || WRITER.some((writer) => writer.test(args))) && writesHere(pid, args, homes))
      all(`Dori cache writer process ${pid} (${args})`);
    if (Number(owner) !== uid && entersAny(pid, Number(owner))) privileged.push({ pid, args });
  }
  if (!privileged.length) return reasons;
  // This process's own directory is always readable, so no answer at all means the reader failed.
  const read = (options.readCwds ?? processCwds)([String(process.pid), ...privileged.map((row) => row.pid)]);
  if (!read) all("process working directories unavailable");
  const unread = privileged.filter((row) => read?.unreadable.includes(row.pid));
  for (const { pid } of privileged)
    for (const key of keys) if (read?.cwds.get(pid)?.includes(key)) add(key, `process ${pid}`);
  for (const { pid, args } of unread) options.privileged?.add(`${pid}@${startOf(pid) ?? "?"} (${args})`);
  if (unread.length && !options.trustRootCwd)
    all(`unreadable working directories of ${unread.length} root or privileged processes (see --trust-root-cwd)`);
  return reasons;
}
