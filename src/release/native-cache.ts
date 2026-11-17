import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { owned, readJson, realDirectory } from "./files.ts";
import type { NativeReceipt } from "./native.ts";
import { protections } from "./native-cache-refs.ts";
import { processCwds } from "./process-cwd.ts";
import { readSourceBundle } from "./source-bundle.ts";

export type NativeCacheEntry = {
  readonly directory: string;
  readonly identity: string;
  /** Bytes whose every hard link lies inside this directory, so removal actually frees them. */
  readonly bytes: number;
  /** Empty only when no live source, reference file or running process names this identity. */
  readonly protectedBy: readonly string[];
};
export type NativeCachePrune = { readonly entries: NativeCacheEntry[]; readonly removed: string[] };

const ENTRY = new RegExp(`^native-${process.platform}-${process.arch}-([a-f0-9]{64})(\\.pruning)?$`);

/** Freed bytes: inodes whose link count is fully accounted for inside the directory (shared Bun cache links are not). */
function exclusiveBytes(directory: string): number {
  const inodes = new Map<string, { size: number; links: number; seen: number }>();
  const stack = [directory];
  while (stack.length) {
    const path = stack.pop()!;
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name));
    const key = `${stat.dev}:${stat.ino}`;
    const inode = inodes.get(key) ?? { size: stat.size, links: stat.nlink, seen: 0 };
    inode.seen++;
    inodes.set(key, inode);
  }
  let bytes = 0;
  for (const inode of inodes.values()) if (inode.seen >= inode.links) bytes += inode.size;
  return bytes;
}

/** A live entry's receipt keeps it while unrecognized or while the source that prepared it still binds it. */
function receiptHolds(directory: string, identity: string, live: string): string[] {
  try {
    realDirectory(directory);
    owned(directory);
    const receipt = readJson(join(directory, "receipt.json"));
    if (!recognized(receipt, identity, live)) return ["unrecognized receipt"];
    try {
      return readSourceBundle(receipt.source, true).identity === identity ? ["receipt source"] : [];
    } catch {
      return []; // The source that prepared this identity is gone or now binds another identity.
    }
  } catch {
    return ["unrecognized receipt"];
  }
}

/** Report every native cache identity of this platform with the reasons it must be kept (see `protections`). */
export function reportNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
  readCwds: typeof processCwds = processCwds,
): NativeCacheEntry[] {
  const cache = join(home, ".cache/omp-dori");
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  realDirectory(cache);
  owned(cache);
  const found = readdirSync(cache)
    .map((name) => ({ name, match: ENTRY.exec(name) }))
    .filter((entry) => entry.match)
    .map(({ name, match }) => ({ directory: join(cache, name), identity: match![1]!, detached: !!match![2] }));
  // A live entry is keyed by its identity; a detached one by its own `<identity>.pruning` name, which only a process
  // or reference still using that very directory names. That name resolves through no launcher or receipt.
  const keyOf = (entry: { readonly identity: string; readonly detached: boolean }) =>
    entry.detached ? `${entry.identity}.pruning` : entry.identity;
  const reasons = protections(cache, found.map(keyOf), sources, roots, readCwds);
  return found.map((entry) => {
    const { directory, identity, detached } = entry;
    const protectedBy = [...(reasons.get(keyOf(entry)) ?? [])];
    if (!detached) protectedBy.push(...receiptHolds(directory, identity, directory));
    return { directory, identity, bytes: exclusiveBytes(directory), protectedBy };
  });
}

// The receipt contract `prepareNative` writes (src/release/native.ts NativeReceipt): any other shape is kept unread.
const RECEIPT_TEXT = [
  "source",
  "directory",
  "omp",
  "ompHash",
  "entry",
  "bun",
  "bunHash",
  "addonLockHash",
  "addon",
  "addonHash",
];
function recognized(receipt: unknown, identity: string, directory: string): receipt is NativeReceipt {
  if (typeof receipt !== "object" || receipt === null) return false;
  const fields = receipt as Record<string, unknown>;
  return (
    fields["version"] === 1 &&
    fields["identity"] === identity &&
    fields["directory"] === directory &&
    RECEIPT_TEXT.every((name) => typeof fields[name] === "string" && fields[name] !== "")
  );
}

/**
 * Detach, check again, then remove only the unprotected entries of a fresh report; without `apply` nothing changes.
 * Detaching first means a launcher never sees a half-removed identity, and a reference or process that appeared after
 * the report is seen by the second check, which puts its identity back instead of removing it.
 */
export function pruneNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
  apply: boolean,
  readCwds: typeof processCwds = processCwds,
): NativeCachePrune {
  const entries = reportNativeCache(home, sources, roots, readCwds);
  const removed: string[] = [];
  if (!apply) return { entries, removed };
  const reported = new Map(entries.map((entry) => [entry.directory, entry]));
  const detached: { readonly identity: string; readonly path: string; readonly live?: string }[] = [];
  for (const entry of entries) {
    if (entry.protectedBy.length || entry.directory.endsWith(".pruning")) continue;
    // An older detached copy is replaced only when it is itself unprotected; a copy something still uses keeps this
    // identity in place until a later prune.
    const path = `${entry.directory}.pruning`;
    const older = reported.get(path);
    if (older?.protectedBy.length) continue;
    if (older) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
    renameSync(entry.directory, path);
    detached.push({ identity: entry.identity, path, live: entry.directory });
  }
  for (const entry of entries)
    if (!entry.protectedBy.length && entry.directory.endsWith(".pruning") && !removed.includes(entry.directory))
      detached.push({ identity: entry.identity, path: entry.directory });
  if (!detached.length) return { entries, removed };
  const keys = detached.flatMap(({ identity, live }) => [`${identity}.pruning`, ...(live ? [identity] : [])]);
  const again = protections(join(home, ".cache/omp-dori"), keys, sources, roots, readCwds);
  for (const { identity, path, live } of detached) {
    const held = [
      ...(again.get(`${identity}.pruning`) ?? []),
      ...(live ? [...(again.get(identity) ?? []), ...receiptHolds(path, identity, live)] : []),
    ];
    if (!held.length) {
      rmSync(path, { recursive: true, force: true });
      removed.push(live ?? path);
    } else if (live && !lstatSync(live, { throwIfNoEntry: false })) renameSync(path, live);
  }
  return { entries, removed };
}
