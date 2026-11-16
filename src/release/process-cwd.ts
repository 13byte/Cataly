import { readlinkSync } from "node:fs";

/**
 * Working directories of running processes by pid: `/proc/<pid>/cwd` on Linux, `lsof` elsewhere (macOS has no /proc).
 * A process whose directory cannot be read (another user's, or one that exited) is absent. Null when no directory could
 * be read at all, so a caller can hold instead of treating every process as using nothing.
 */
export function processCwds(pids: readonly string[], platform = process.platform): Map<string, string> | null {
  const cwds = new Map<string, string>();
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Another user's or an exited process exposes no working directory.
      }
    }
    return cwds;
  }
  let output: string;
  try {
    // -F output: a `p<pid>` line opens each process, its cwd follows as `n<path>`; other fields are skipped.
    const lsof = Bun.spawnSync(["lsof", "-n", "-a", "-d", "cwd", "-F", "pn"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    output = lsof.stdout.toString();
  } catch {
    return null;
  }
  let pid = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds.size > 0 ? cwds : null;
}
