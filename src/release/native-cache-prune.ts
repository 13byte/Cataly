import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realDirectory } from "./files.ts";
import { claimNativePrune, nativeCacheRoot, nativeStage } from "./native-cache-lease.ts";
import { exclusiveBytes, type NativeCacheEntry, receiptHolds, reportNativeCache } from "./native-cache.ts";
import { protections } from "./native-cache-refs.ts";
import { stageHolds } from "./native-cache-stage.ts";
import { type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import { processCwds, processStart } from "./process-cwd.ts";

type NativeCacheRemoval = {
  readonly directory: string;
  readonly identity: string;
  readonly bytes: number;
  readonly why: string;
};
type Quarantined = {
  readonly directory: string;
  readonly identity: string;
  readonly bytes: number;
  readonly since: string;
  readonly removableAfter: string;
};
export type NativeCachePrune = {
  readonly removed: readonly NativeCacheRemoval[];
  /** Unused identities moved aside (`.pruning`), removed by a later prune once still unused after the grace period. */
  readonly quarantined: readonly Quarantined[];
  readonly kept: readonly NativeCacheEntry[];
  /** Each `--trust-process PID@START` and whether it still named that process at the last look. */
  readonly trusted: readonly { readonly process: string; readonly trusted: boolean }[];
  /** With `--trust-root-cwd`: how many privileged processes with an unreadable working directory were not held. */
  readonly rootCwdTrusted: number;
};
export type NativeCachePruneOptions = {
  readonly readCwds?: typeof processCwds;
  readonly table?: () => string;
  /** `PID@START` of processes whose unreadable working directory the user vouches for, as the report printed them. */
  readonly trust?: readonly string[];
  /** Count privileged processes whose working directory cannot be read as outside the cache (their arguments count). */
  readonly trustRootCwd?: boolean;
  /** How long an identity stays quarantined, unused, before a prune may remove it (`--grace MINUTES`). */
  readonly graceMs?: number;
  readonly now?: number;
};

export const GRACE_MS = 10 * 60_000;
const LEFTOVER = new RegExp(`^native-${process.platform}-${process.arch}-([a-f0-9]{64})\\.(pruning|deleting)$`);
const AGAIN = "quarantined copy kept: its live name exists again; remove it by hand once nothing uses it";
const QUARANTINE = "native-quarantine";

/**
 * What waits in the cache: quarantined identities (`quarantined`, with the time they were moved aside), a removal an
 * interrupted prune had decided (`deleting`), a preparation whose owner ended (`stage`) and one that names no owner
 * (`older stage`, remove it by hand once no older checkout prepares anything).
 */
export function cachePending(home: string): { directory: string; identity: string; state: string; since?: string }[] {
  const cache = nativeCacheRoot(home);
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  return readdirSync(cache).flatMap((name) => {
    const directory = join(cache, name);
    const match = LEFTOVER.exec(name);
    if (match?.[2] === "deleting") return [{ directory, identity: match[1]!, state: "deleting" }];
    if (match) {
      const since = quarantinedSince(cache, match[1]!);
      return [{ directory, identity: match[1]!, state: "quarantined", ...(since ? { since } : {}) }];
    }
    if (!name.startsWith("native-stage-")) return [];
    const stage = nativeStage(name);
    if (!stage) return [{ directory, identity: "", state: "older stage" }];
    return stage.ended ? [{ directory, identity: stage.identity, state: "stage" }] : [];
  });
}

/** When an identity was quarantined, as its record says; undefined without a readable record. */
function quarantinedSince(cache: string, identity: string): string | undefined {
  try {
    const since = readFileSync(join(cache, QUARANTINE, identity), "utf8").trim();
    return Number.isNaN(Date.parse(since)) ? undefined : since;
  } catch {
    return undefined;
  }
}

/**
 * Remove the native cache identities nothing uses, in two prunes, holding the prune lock throughout each.
 *
 * A prune first finishes what an interrupted one decided (`.deleting`) and removes preparations nothing can still
 * finish. One look then judges every identity and every quarantined copy under both its names. An unused identity is
 * quarantined: recorded, then moved aside (`.pruning`), so no launcher runs it half removed. A quarantined copy that is
 * used by now goes back; one unused since at least `graceMs` is removed. A writer from an older checkout, which takes
 * no lease, therefore has the whole grace period, not one scan, to make its use seen before anything is removed.
 */
export function pruneNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
  options: NativeCachePruneOptions = {},
): NativeCachePrune {
  const cache = nativeCacheRoot(home);
  const tokens = new Map<string, string>();
  for (const token of options.trust ?? []) {
    const match = /^([1-9]\d*)@(\d+)$/.exec(token);
    if (!match) throw new Error(`--trust-process takes PID@START as the report prints it, not ${token}`);
    tokens.set(match[1]!, match[2]!);
  }
  // A trusted pid counts only while it is still the process the user named; a reused pid is not trusted.
  const trusted = (pid: string) => tokens.has(pid) && processStart(pid) === tokens.get(pid);
  const read = options.readCwds ?? processCwds;
  const readCwds: typeof processCwds = (pids, platform) => {
    const found = read(pids, platform);
    return found && { cwds: found.cwds, unreadable: found.unreadable.filter((pid) => !trusted(pid)) };
  };
  const privileged = new Set<string>();
  const uses: UseHoldOptions = {
    readCwds,
    privileged,
    trustRootCwd: options.trustRootCwd === true,
    ...(options.table ? { table: options.table } : {}),
  };
  const graceMs = options.graceMs ?? GRACE_MS;
  const now = options.now ?? Date.now();
  const result = {
    removed: [] as NativeCacheRemoval[],
    quarantined: [] as Quarantined[],
    kept: [] as NativeCacheEntry[],
  };
  const report = () => ({
    ...result,
    trusted: [...tokens].map(([pid, start]) => ({ process: `${pid}@${start}`, trusted: trusted(pid) })),
    rootCwdTrusted: options.trustRootCwd ? privileged.size : 0,
  });
  if (!lstatSync(cache, { throwIfNoEntry: false })) return report();
  const release = claimNativePrune(home);
  try {
    const records = join(cache, QUARANTINE);
    realDirectory(records, true);
    const waiting: { identity: string; directory: string; since: string }[] = [];
    for (const { directory, identity, state, since } of cachePending(home)) {
      if (state === "deleting") {
        const bytes = exclusiveBytes(directory);
        rmSync(directory, { recursive: true, force: true });
        result.removed.push({
          directory: directory.slice(0, -".deleting".length),
          identity,
          bytes,
          why: "an interrupted prune had decided to remove it",
        });
      } else if (state === "stage") {
        const held = stageHolds(directory, readCwds, uses);
        const entry = { directory, identity, bytes: exclusiveBytes(directory) };
        if (held.length) result.kept.push({ ...entry, protectedBy: held });
        else {
          rmSync(directory, { recursive: true, force: true });
          result.removed.push({ ...entry, why: "a preparation whose owner ended and that nothing uses" });
        }
      } else if (state === "quarantined") {
        // A copy without a record (moved aside by an older run) starts its grace period now.
        const start = since ?? new Date(now).toISOString();
        if (!since) writeFileSync(join(records, identity), `${start}\n`, { mode: 0o600 });
        waiting.push({ identity, directory: directory.slice(0, -".pruning".length), since: start });
      }
    }
    // A record whose copy is gone (put back by hand, or a run that failed before moving it) records nothing.
    for (const identity of readdirSync(records))
      if (!waiting.some((entry) => entry.identity === identity)) rmSync(join(records, identity), { force: true });
    const entries = reportNativeCache(home, sources, roots, readCwds, { ...uses, sweep: true });
    const keys = waiting.flatMap(({ identity }) => [identity, `${identity}.pruning`]);
    const refs = keys.length ? protections(cache, keys, sources, roots, readCwds) : new Map<string, string[]>();
    const held = keys.length ? useHolds(cache, keys, uses) : new Map<string, string[]>();
    for (const { identity, directory, since } of waiting) {
      const copy = `${directory}.pruning`;
      const bytes = exclusiveBytes(copy);
      const reasons = new Set([
        ...[identity, `${identity}.pruning`].flatMap((key) => [...(refs.get(key) ?? []), ...(held.get(key) ?? [])]),
        ...receiptHolds(copy, identity, directory),
      ]);
      if (lstatSync(directory, { throwIfNoEntry: false }))
        result.kept.push({ directory: copy, identity, bytes, protectedBy: [...reasons, AGAIN] });
      else if (reasons.size) {
        renameSync(copy, directory);
        rmSync(join(records, identity), { force: true });
        result.kept.push({ directory, identity, bytes, protectedBy: [...reasons, "put back from quarantine"] });
      } else if (now - Date.parse(since) < graceMs) {
        const removableAfter = new Date(Date.parse(since) + graceMs).toISOString();
        result.quarantined.push({ directory, identity, bytes, since, removableAfter });
      } else {
        renameSync(copy, `${directory}.deleting`);
        rmSync(join(records, identity), { force: true });
        rmSync(`${directory}.deleting`, { recursive: true, force: true });
        result.removed.push({ directory, identity, bytes, why: `unused through its quarantine since ${since}` });
      }
    }
    for (const entry of entries) {
      if (entry.protectedBy.length) result.kept.push(entry);
      else if (waiting.some(({ identity }) => identity === entry.identity))
        result.kept.push({ ...entry, protectedBy: ["a quarantined copy of it is kept (see its .pruning entry)"] });
      else {
        const since = new Date(now).toISOString();
        writeFileSync(join(records, entry.identity), `${since}\n`, { mode: 0o600 });
        renameSync(entry.directory, `${entry.directory}.pruning`);
        const removableAfter = new Date(now + graceMs).toISOString();
        result.quarantined.push({
          directory: entry.directory,
          identity: entry.identity,
          bytes: entry.bytes,
          since,
          removableAfter,
        });
      }
    }
    return report();
  } finally {
    release();
  }
}
