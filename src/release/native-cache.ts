import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { owned, readJson, realDirectory } from "./files.ts";
import { readSourceBundle } from "./source-bundle.ts";

export type NativeCacheEntry = {
  readonly directory: string;
  readonly identity: string;
  /** Bytes whose every hard link lies inside this directory, so removal actually frees them. */
  readonly bytes: number;
  /** Empty only when no live source, reference file or running process names this identity. */
  readonly protectedBy: readonly string[];
};

const ENTRY = new RegExp(`^native-${process.platform}-${process.arch}-([a-f0-9]{64})(\\.pruning)?$`);
const MAX_REFERENCE = 1024 * 1024;

/** Walk without following links; `visit` sees every directory and every small regular file. */
function walk(root: string, visit: (path: string, file: boolean) => void): void {
  const stack = [root];
  while (stack.length) {
    const path = stack.pop()!;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (stat.size <= MAX_REFERENCE) visit(path, true);
    } else if (stat.isDirectory()) {
      visit(path, false);
      for (const name of readdirSync(path))
        if (name !== ".git" && name !== "node_modules") stack.push(join(path, name));
    }
  }
}

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

/**
 * Report every native cache identity of this platform with the reasons it must be kept. An identity is protected
 * when a source under `sources`/`roots` binds it, its receipt's own source still binds it, any small file under
 * `roots` (wrappers, consumer state, deployment records/toolchains) names it, or a running process names it. An
 * unreadable process table throws instead of reporting nothing as protected.
 */
export function reportNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
): NativeCacheEntry[] {
  const cache = join(home, ".cache/omp-dori");
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  realDirectory(cache);
  owned(cache);
  const found = readdirSync(cache)
    .map((name) => ({ name, match: ENTRY.exec(name) }))
    .filter((entry) => entry.match)
    .map(({ name, match }) => ({ directory: join(cache, name), identity: match![1]!, detached: !!match![2] }));
  const identities = found.map((entry) => entry.identity);
  const reasons = new Map<string, string[]>();
  const add = (identity: string, reason: string) => reasons.set(identity, [...(reasons.get(identity) ?? []), reason]);
  const bind = (source: string, reason: string) => {
    try {
      add(readSourceBundle(source, true).identity, reason);
    } catch {
      // A missing, invalid or foreign lock binds no identity.
    }
  };
  for (const source of sources) bind(source, `source ${source}`);
  for (const root of roots)
    walk(root, (path, file) => {
      if (!file) {
        if (lstatSync(join(path, "native-omp.lock"), { throwIfNoEntry: false })) bind(path, `source ${path}`);
        return;
      }
      const text = readFileSync(path, "latin1");
      for (const identity of identities) if (text.includes(identity)) add(identity, `reference ${path}`);
    });
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("Process table is unavailable; native cache use cannot be ruled out");
  for (const line of ps.stdout.toString().split("\n")) {
    const pid = line.trim().split(/\s+/, 1)[0] ?? "";
    let cwd = "";
    try {
      if (process.platform === "linux" && pid) cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // Another user's or an exited process exposes no working directory; its argv was still checked.
    }
    for (const identity of identities)
      if (line.includes(identity) || cwd.includes(identity)) add(identity, `process ${pid}`);
  }
  return found.map(({ directory, identity, detached }) => {
    // A directory detached by an interrupted prune has a name no launcher or receipt resolves.
    if (detached) return { directory, identity, bytes: exclusiveBytes(directory), protectedBy: [] };
    const protectedBy = [...(reasons.get(identity) ?? [])];
    try {
      realDirectory(directory);
      owned(directory);
      const receipt = readJson(join(directory, "receipt.json")) as { identity?: unknown; source?: unknown };
      if (receipt.identity !== identity) protectedBy.push("unrecognized receipt");
      else if (typeof receipt.source === "string") {
        try {
          if (readSourceBundle(receipt.source, true).identity === identity) protectedBy.push("receipt source");
        } catch {
          // The source that prepared this identity is gone or now binds another identity.
        }
      }
    } catch {
      protectedBy.push("unrecognized receipt");
    }
    return { directory, identity, bytes: exclusiveBytes(directory), protectedBy };
  });
}

/** Detach then remove only the unprotected entries of a fresh report. Without `apply` nothing changes. */
export function pruneNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
  apply: boolean,
): { readonly entries: NativeCacheEntry[]; readonly removed: string[] } {
  const entries = reportNativeCache(home, sources, roots);
  const removed: string[] = [];
  if (!apply) return { entries, removed };
  for (const entry of entries) {
    if (entry.protectedBy.length) continue;
    // Detach first so a launcher never sees a half-removed identity; an older detached copy is already unreachable.
    const detached = entry.directory.endsWith(".pruning") ? entry.directory : `${entry.directory}.pruning`;
    if (detached !== entry.directory) {
      rmSync(detached, { recursive: true, force: true });
      renameSync(entry.directory, detached);
    }
    rmSync(detached, { recursive: true, force: true });
    removed.push(entry.directory);
  }
  return { entries, removed };
}
