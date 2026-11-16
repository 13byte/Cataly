import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { owned, readJson, realDirectory } from "./files.ts";
import type { NativeReceipt } from "./native.ts";
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

/** Walk without following links; `visit` sees every directory, every symbolic link and every small regular file. */
function walk(root: string, visit: (path: string, kind: "directory" | "file" | "link") => void): void {
  const stack = [root];
  while (stack.length) {
    const path = stack.pop()!;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) visit(path, "link");
    else if (stat.isFile()) {
      if (stat.size <= MAX_REFERENCE) visit(path, "file");
    } else if (stat.isDirectory()) {
      visit(path, "directory");
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
  // A live entry is keyed by its identity; a detached one by its own `<identity>.pruning` name, which only a process
  // or reference still using that very directory names.
  const keyOf = (entry: { readonly identity: string; readonly detached: boolean }) =>
    entry.detached ? `${entry.identity}.pruning` : entry.identity;
  const keys = found.map(keyOf);
  const reasons = new Map<string, string[]>();
  const add = (key: string, reason: string) => reasons.set(key, [...(reasons.get(key) ?? []), reason]);
  const names = (text: string, reason: string) => {
    for (const key of keys)
      if ((key.endsWith(".pruning") ? text : text.replaceAll(`${key}.pruning`, "")).includes(key)) add(key, reason);
  };
  const bind = (source: string, reason: string) => {
    try {
      add(readSourceBundle(source, true).identity, reason);
    } catch {
      // A missing, invalid or foreign lock binds no identity.
    }
  };
  for (const source of sources) bind(source, `source ${source}`);
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const cacheReal = real(cache);
  const rootsReal = roots.map(real);
  // A root given as a link (a `--reference` alias) is walked at its real path, so its contents are read.
  for (const root of rootsReal)
    walk(root, (path, kind) => {
      if (kind === "directory") {
        if (lstatSync(join(path, "native-omp.lock"), { throwIfNoEntry: false })) bind(path, `source ${path}`);
        return;
      }
      if (kind === "file") return names(readFileSync(path, "latin1"), `reference ${path}`);
      // A link into the cache (an `omp` on PATH, a release's toolchain link) keeps its target, through link chains too.
      let target: string;
      try {
        target = readlinkSync(path);
      } catch {
        for (const key of keys) add(key, `unreadable link ${path}`);
        return;
      }
      let resolved = "";
      try {
        resolved = realpathSync(path);
      } catch {
        // A dangling link names only its own target text.
      }
      names(`${target}\0${resolved}`, `link ${path}`);
      // A target inside the cache is identified by its path alone.
      if (!resolved || resolved === cacheReal || resolved.startsWith(`${cacheReal}/`)) return;
      // A link to a file (a wrapper elsewhere) keeps what that file names. A link to a directory keeps the source it
      // binds; one outside the scanned roots and the cache is not walked, so it keeps every identity.
      const stat = lstatSync(resolved, { throwIfNoEntry: false });
      if (stat?.isFile()) {
        if (stat.size <= MAX_REFERENCE) names(readFileSync(resolved, "latin1"), `reference ${path}`);
      } else if (stat?.isDirectory()) {
        if (lstatSync(join(resolved, "native-omp.lock"), { throwIfNoEntry: false })) bind(resolved, `source ${path}`);
        else if (!rootsReal.some((dir) => resolved === dir || resolved.startsWith(`${dir}/`)))
          for (const key of keys) add(key, `link to an unscanned directory ${path}`);
      }
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
    names(`${line}\0${cwd}`, `process ${pid}`);
  }
  return found.map((entry) => {
    const { directory, identity, detached } = entry;
    const protectedBy = [...(reasons.get(keyOf(entry)) ?? [])];
    // A directory detached by an interrupted prune has a name no launcher or receipt resolves: only a process or
    // reference that still names that very directory keeps it.
    if (detached) return { directory, identity, bytes: exclusiveBytes(directory), protectedBy };
    try {
      realDirectory(directory);
      owned(directory);
      const receipt = readJson(join(directory, "receipt.json"));
      if (!recognized(receipt, identity, directory)) protectedBy.push("unrecognized receipt");
      else {
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
  const reported = new Map(entries.map((entry) => [entry.directory, entry]));
  for (const entry of entries) {
    if (entry.protectedBy.length || removed.includes(entry.directory)) continue;
    // Detach first so a launcher never sees a half-removed identity. An older detached copy is replaced only when it
    // is itself unprotected; a copy something still uses keeps this identity in place until a later prune.
    const detached = entry.directory.endsWith(".pruning") ? entry.directory : `${entry.directory}.pruning`;
    if (detached !== entry.directory) {
      const older = reported.get(detached);
      if (older?.protectedBy.length) continue;
      if (older && !removed.includes(detached)) {
        rmSync(detached, { recursive: true, force: true });
        removed.push(detached);
      }
      renameSync(entry.directory, detached);
    }
    rmSync(detached, { recursive: true, force: true });
    removed.push(entry.directory);
  }
  return { entries, removed };
}
