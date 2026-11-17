import { readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { nativeStage, readLeases } from "./native-cache-lease.ts";
import { protections } from "./native-cache-refs.ts";
import { type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import type { processCwds } from "./process-cwd.ts";

/**
 * This user's processes with a file open under `path` (Linux), and those whose open files cannot be read: the same
 * processes whose working directory `readCwds` cannot read (unless the user trusted them), as those hide both.
 */
function openUnder(path: string, readCwds: typeof processCwds): string[] {
  if (process.platform !== "linux") return ["open files cannot be read without /proc"];
  const uid = process.getuid?.();
  const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name) && ownedBy(name, uid));
  const hidden = new Set(readCwds(pids)?.unreadable ?? pids);
  const reasons: string[] = [];
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH" && hidden.has(pid))
        reasons.push(`open files of process ${pid} cannot be read`);
      continue;
    }
    for (const fd of fds) {
      try {
        // The stage itself open as a directory counts too (openat and readdir work through it).
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (target === path || target.startsWith(`${path}/`)) reasons.push(`process ${pid} has a file open in it`);
      } catch {
        // A descriptor closed meanwhile.
      }
    }
  }
  return [...new Set(reasons)];
}

/** Another user's process cannot enter the owner-only stage; one whose owner cannot be read may be this user's. */
const ownedBy = (pid: string, uid: number | undefined): boolean => {
  try {
    return uid === undefined || statSync(`/proc/${pid}`).uid === uid;
  } catch {
    return false;
  }
};

/**
 * What still uses a preparation whose owner ended: a lease on its identity, a process that names it or works or has a
 * file open in it (the owner's detached children: git, bun install), and everything the report cannot confirm (a
 * running Dori writer, unreadable working directories). Empty only when nothing may still finish or read it.
 */
export function stageHolds(stage: string, readCwds: typeof processCwds, uses: UseHoldOptions): string[] {
  const cache = dirname(stage);
  const key = basename(stage);
  const found = nativeStage(key);
  const leased = found && readLeases(cache, false).byIdentity.get(found.identity);
  return [
    ...new Set([
      ...(leased ?? []),
      ...(protections(cache, [key], [], [], readCwds).get(key) ?? []),
      ...(useHolds(cache, [key], { ...uses, readCwds }).get(key) ?? []),
      ...openUnder(stage, readCwds),
    ]),
  ];
}
