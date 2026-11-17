import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";

/**
 * Paths this user's running processes use besides their working directory, by pid: on Linux the executable they run
 * (`/proc/<pid>/exe`), every open descriptor (`fd/*`, a directory included) and every mapped file (`maps`); elsewhere
 * what `lsof` lists for this user (open files, the executable, mapped files). `unread` holds live pids whose files
 * could not be read: on Linux the same processes whose working directory cannot be read either. Null when nothing at
 * all could be read.
 */
export function processFiles(): { files: Map<string, string[]>; unread: string[] } | null {
  const files = new Map<string, string[]>();
  const unread: string[] = [];
  const uid = process.getuid?.();
  if (process.platform !== "linux") {
    const lsof = Bun.spawnSync(["lsof", "-n", ...(uid === undefined ? [] : ["-u", String(uid)]), "-F", "pn"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    if (lsof.exitedDueToTimeout || lsof.signalCode || !lsof.stdout.length) return null;
    let pid = "";
    for (const line of lsof.stdout.toString().split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("n/") && pid) files.set(pid, [...(files.get(pid) ?? []), line.slice(1)]);
    }
    return { files, unread };
  }
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${pid}`).uid !== uid) continue;
    } catch {
      continue;
    }
    const paths: string[] = [];
    try {
      paths.push(readlinkSync(`/proc/${pid}/exe`));
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
        } catch {
          // A descriptor closed meanwhile.
        }
      }
      for (const line of readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
        const mapped = /^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(\/.*)$/.exec(line)?.[1];
        if (mapped) paths.push(mapped);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // An exited process uses nothing.
      if (code !== "ENOENT" && code !== "ESRCH") unread.push(pid);
      continue;
    }
    files.set(pid, paths);
  }
  return files.size ? { files, unread } : null;
}

/** Whether a path a process uses is `directory` itself or lies inside it (a deleted one keeps its old path). */
export const usesDirectory = (path: string, directory: string): boolean => {
  const plain = path.endsWith(" (deleted)") ? path.slice(0, -" (deleted)".length) : path;
  return plain === directory || plain.startsWith(`${directory}/`);
};
