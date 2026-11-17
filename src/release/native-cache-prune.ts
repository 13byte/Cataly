import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claimNativePrune, nativeCacheRoot } from "./native-cache-lease.ts";
import { exclusiveBytes, type NativeCacheEntry, receiptHolds, reportNativeCache } from "./native-cache.ts";
import { protections } from "./native-cache-refs.ts";
import { startOf, type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import { processCwds } from "./process-cwd.ts";

type NativeCacheRemoval = {
  readonly directory: string;
  readonly identity: string;
  readonly bytes: number;
  readonly why: string;
};
export type NativeCachePrune = {
  readonly removed: readonly NativeCacheRemoval[];
  readonly kept: readonly NativeCacheEntry[];
  /** Each `--trust-process PID@START` and whether it still named that process at the last look before removal. */
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
};

const LEFTOVER = new RegExp(`^native-${process.platform}-${process.arch}-([a-f0-9]{64})\\.(pruning|deleting)$`);
const AGAIN = "detached copy kept: its live name exists again; remove it by hand once nothing uses it";

/** What an interrupted prune left: `.pruning` (detached, not decided) and `.deleting` (removal decided under the lock). */
export function interruptedPrune(home: string): { directory: string; identity: string; state: string }[] {
  const cache = nativeCacheRoot(home);
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  return readdirSync(cache).flatMap((name) => {
    const match = LEFTOVER.exec(name);
    return match ? [{ directory: join(cache, name), identity: match[1]!, state: match[2]! }] : [];
  });
}

/** Put a detached copy back under its live name; when that name exists again, the copy stays where it is. */
function attach(entry: NativeCacheEntry): boolean {
  const detached = `${entry.directory}.pruning`;
  if (!lstatSync(detached, { throwIfNoEntry: false })) return true;
  if (lstatSync(entry.directory, { throwIfNoEntry: false })) return false;
  renameSync(detached, entry.directory);
  return true;
}

/** After an error: every copy still detached goes back where it can; the error says which could not. */
function restore(entries: readonly NativeCacheEntry[], error: unknown): never {
  const left = entries.flatMap((entry) => {
    try {
      return attach(entry) ? [] : [`${entry.directory}.pruning`];
    } catch {
      return [`${entry.directory}.pruning`];
    }
  });
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(left.length ? `${message}; kept detached: ${left.join(", ")}` : message);
}

/**
 * Remove the native cache identities nothing uses, holding the prune lock from the first look to the last removal.
 *
 * An interrupted prune is recovered first. Every identity the report finds unused is then detached (`.pruning`), so a
 * launcher never sees one half removed, and looked at again under both names; whatever is found then goes back. Only
 * then is a copy marked `.deleting` and removed. An error before that mark puts every detached identity back; an error
 * while removing leaves `.deleting`, which the next prune finishes.
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
  const trusted = (pid: string) => tokens.has(pid) && startOf(pid) === tokens.get(pid);
  const read = options.readCwds ?? processCwds;
  const readCwds: typeof processCwds = (pids, platform) => {
    const found = read(pids, platform);
    return found && { cwds: found.cwds, unreadable: found.unreadable.filter((pid) => !trusted(pid)) };
  };
  // Privileged processes the user let `--trust-root-cwd` pass, across every look of this run.
  const privileged = new Set<string>();
  const uses: UseHoldOptions = {
    readCwds,
    privileged,
    trustRootCwd: options.trustRootCwd === true,
    ...(options.table ? { table: options.table } : {}),
  };
  if (!lstatSync(cache, { throwIfNoEntry: false })) return { removed: [], kept: [], trusted: [], rootCwdTrusted: 0 };
  const release = claimNativePrune(home);
  try {
    const removed: NativeCacheRemoval[] = [];
    const kept: NativeCacheEntry[] = [];
    for (const { directory, identity, state } of interruptedPrune(home)) {
      const live = directory.slice(0, -`.${state}`.length);
      const bytes = exclusiveBytes(directory);
      if (state === "deleting") {
        rmSync(directory, { recursive: true, force: true });
        removed.push({ directory: live, identity, bytes, why: "an interrupted prune had decided to remove it" });
      } else if (lstatSync(live, { throwIfNoEntry: false }))
        kept.push({ directory, identity, bytes, protectedBy: [AGAIN] });
      // Put back, it is judged below like any other identity.
      else renameSync(directory, live);
    }
    const entries = reportNativeCache(home, sources, roots, readCwds, { ...uses, sweep: true });
    kept.push(...entries.filter((entry) => entry.protectedBy.length));
    const detached: NativeCacheEntry[] = [];
    const confirmed: NativeCacheEntry[] = [];
    try {
      for (const entry of entries.filter((candidate) => !candidate.protectedBy.length)) {
        // A copy left detached earlier is kept, so its name is taken and this identity stays too.
        if (lstatSync(`${entry.directory}.pruning`, { throwIfNoEntry: false }))
          kept.push({ ...entry, protectedBy: ["a detached copy of it is kept (see the .pruning entry)"] });
        else {
          renameSync(entry.directory, `${entry.directory}.pruning`);
          detached.push(entry);
        }
      }
      const keys = detached.flatMap(({ identity }) => [identity, `${identity}.pruning`]);
      const refs = detached.length ? protections(cache, keys, sources, roots, readCwds) : new Map<string, string[]>();
      const held = detached.length ? useHolds(cache, keys, uses) : new Map<string, string[]>();
      for (const entry of detached) {
        const reasons = new Set(
          [entry.identity, `${entry.identity}.pruning`].flatMap((key) => [
            ...(refs.get(key) ?? []),
            ...(held.get(key) ?? []),
          ]),
        );
        for (const reason of receiptHolds(`${entry.directory}.pruning`, entry.identity, entry.directory))
          reasons.add(reason);
        if (!reasons.size) confirmed.push(entry);
        else if (attach(entry)) kept.push({ ...entry, protectedBy: [...reasons] });
        else kept.push({ ...entry, directory: `${entry.directory}.pruning`, protectedBy: [...reasons, AGAIN] });
      }
    } catch (error) {
      restore(detached, error);
    }
    try {
      for (const entry of confirmed) {
        renameSync(`${entry.directory}.pruning`, `${entry.directory}.deleting`);
        rmSync(`${entry.directory}.deleting`, { recursive: true, force: true });
        removed.push({
          directory: entry.directory,
          identity: entry.identity,
          bytes: entry.bytes,
          why: "nothing uses it",
        });
      }
    } catch (error) {
      restore(confirmed, error);
    }
    return {
      removed,
      kept,
      trusted: [...tokens].map(([pid, start]) => ({ process: `${pid}@${start}`, trusted: trusted(pid) })),
      rootCwdTrusted: options.trustRootCwd ? privileged.size : 0,
    };
  } finally {
    release();
  }
}
