import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { processCwds } from "./process-cwd.ts";
import { readSourceBundle } from "./source-bundle.ts";

const CHUNK = 1024 * 1024;
/** An identity's length, so one cut by a chunk edge is whole in the next window. */
const OVERLAP = 64;

/** Walk without following links; `visit` sees every directory, every symbolic link and every regular file. */
function walk(root: string, visit: (path: string, kind: "directory" | "file" | "link") => void): void {
  const stack = [root];
  while (stack.length) {
    const path = stack.pop()!;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) visit(path, "link");
    else if (stat.isFile()) visit(path, "file");
    else if (stat.isDirectory()) {
      visit(path, "directory");
      for (const name of readdirSync(path))
        if (name !== ".git" && name !== "node_modules") stack.push(join(path, name));
    }
  }
}

/** A file of any size, read whole in overlapping windows: no name it holds goes unread. */
function readWindows(path: string, read: (text: string) => void): void {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    let carry = "";
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      const text = carry + buffer.toString("latin1", 0, n);
      read(text);
      carry = text.slice(-OVERLAP);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * What uses each identity: a source under `sources`/`roots` binds it, a file of any size under `roots` (wrappers,
 * consumer state, deployment records/toolchains) names it, or a running process names it. What this scan cannot
 * confirm is reported against every identity: a source lock that cannot be read, a link that cannot be read or leads to
 * an unscanned directory, and process working directories that cannot be read. An unreadable process table or reference
 * file throws instead of reporting nothing as used.
 */
export function protections(
  cache: string,
  keys: readonly string[],
  sources: readonly string[],
  roots: readonly string[],
  readCwds: typeof processCwds,
): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const add = (key: string, reason: string) => {
    const kept = reasons.get(key) ?? [];
    if (!kept.includes(reason)) reasons.set(key, [...kept, reason]);
  };
  const all = (reason: string) => {
    for (const key of keys) add(key, reason);
  };
  const names = (text: string, reason: string) => {
    for (const key of keys) if (text.includes(key)) add(key, reason);
  };
  const bind = (source: string, where: string) => {
    // No lock binds nothing; a lock that cannot be read could bind any identity.
    if (!lstatSync(join(source, "native-omp.lock"), { throwIfNoEntry: false })) return;
    try {
      add(readSourceBundle(source, true).identity, `source ${where}`);
    } catch {
      all(`unreadable source lock ${where}`);
    }
  };
  for (const source of sources) bind(source, source);
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
      if (kind === "directory") return bind(path, path);
      if (kind === "file") return readWindows(path, (text) => names(text, `reference ${path}`));
      // A link into the cache (an `omp` on PATH, a release's toolchain link) keeps its target, through link chains too.
      let target: string;
      try {
        target = readlinkSync(path);
      } catch {
        return all(`unreadable link ${path}`);
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
      if (stat?.isFile()) readWindows(resolved, (text) => names(text, `reference ${path}`));
      else if (stat?.isDirectory()) {
        if (lstatSync(join(resolved, "native-omp.lock"), { throwIfNoEntry: false })) bind(resolved, path);
        else if (!rootsReal.some((dir) => resolved === dir || resolved.startsWith(`${dir}/`)))
          all(`link to an unscanned directory ${path}`);
      }
    });
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("Process table is unavailable; native cache use cannot be ruled out");
  const lines = ps.stdout.toString().split("\n");
  const pids = lines.map((line) => line.trim().split(/\s+/, 1)[0] ?? "");
  // A process also uses an entry through its working directory; with none readable, any identity may be in use.
  const cwds = readCwds(pids.filter(Boolean));
  if (!cwds) all("process working directories unavailable");
  lines.forEach((line, at) => {
    const pid = pids[at] ?? "";
    names(`${line}\0${cwds?.get(pid) ?? ""}`, `process ${pid}`);
  });
  return reasons;
}
