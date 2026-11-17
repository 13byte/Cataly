import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeCacheRoot, nativeStage } from "./native-cache-lease.ts";
import { type NativeCacheEntry, receiptHolds } from "./native-cache.ts";
import type { NativeCacheRemoval } from "./native-cache-prune.ts";
import { protections } from "./native-cache-refs.ts";
import { type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import type { processCwds } from "./process-cwd.ts";

const LEFTOVER = new RegExp(
  `^native-${process.platform}-${process.arch}-([a-f0-9]{64})\\.(pruning|deleting-[a-f0-9]{16})$`,
);
export const QUARANTINE = "native-quarantine";

/**
 * What waits in the cache: quarantined identities (`quarantined`, with the time they were moved aside; a copy an
 * interrupted `--delete-quarantined` left as `.deleting-<nonce>` counts as one), a preparation whose owner ended
 * (`stage`) and one that names no owner (`older stage`, remove it by hand once no older checkout prepares anything).
 */
export function cachePending(home: string): { directory: string; identity: string; state: string; since?: string }[] {
  const cache = nativeCacheRoot(home);
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  return readdirSync(cache).flatMap((name) => {
    const directory = join(cache, name);
    const match = LEFTOVER.exec(name);
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

export type Doomed = {
  readonly identity: string;
  readonly directory: string;
  readonly bytes: number;
  readonly since: string;
};

/**
 * `--delete-quarantined`: each copy unused through its grace period is renamed `.deleting-<nonce>`, then looked at once
 * more under all three names; one used by now goes back to its live name, the rest are removed. What remains possible,
 * and what the user accepts by asking, is an older writer that publishes a use between that last look and the removal.
 */
export function deleteQuarantined(
  cache: string,
  doomed: readonly Doomed[],
  sources: readonly string[],
  roots: readonly string[],
  readCwds: typeof processCwds,
  uses: UseHoldOptions,
  result: { removed: NativeCacheRemoval[]; kept: NativeCacheEntry[] },
): void {
  const nonce = randomBytes(8).toString("hex");
  for (const { directory } of doomed) renameSync(`${directory}.pruning`, `${directory}.deleting-${nonce}`);
  const keys = doomed.flatMap(({ identity }) => [identity, `${identity}.pruning`, `${identity}.deleting-${nonce}`]);
  const refs = protections(cache, keys, sources, roots, readCwds);
  const held = useHolds(cache, keys, uses);
  for (const { identity, directory, bytes, since } of doomed) {
    const doomedCopy = `${directory}.deleting-${nonce}`;
    const reasons = new Set([
      ...[identity, `${identity}.pruning`, `${identity}.deleting-${nonce}`].flatMap((key) => [
        ...(refs.get(key) ?? []),
        ...(held.get(key) ?? []),
      ]),
      ...receiptHolds(doomedCopy, identity, directory),
    ]);
    if (reasons.size || lstatSync(directory, { throwIfNoEntry: false })) {
      // Used after all: back to its live name when that is free, else back into quarantine.
      const back = lstatSync(directory, { throwIfNoEntry: false }) ? `${directory}.pruning` : directory;
      renameSync(doomedCopy, back);
      if (back === directory) rmSync(join(cache, QUARANTINE, identity), { force: true });
      result.kept.push({
        directory: back,
        identity,
        bytes,
        protectedBy: [...reasons, "kept at the check before removal"],
      });
      continue;
    }
    rmSync(join(cache, QUARANTINE, identity), { force: true });
    rmSync(doomedCopy, { recursive: true, force: true });
    result.removed.push({
      directory,
      identity,
      bytes,
      why: `unused through its quarantine since ${since}; removal asked`,
    });
  }
}
