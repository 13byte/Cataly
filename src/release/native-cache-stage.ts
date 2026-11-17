import { basename, dirname } from "node:path";
import { nativeStage, readLeases } from "./native-cache-lease.ts";
import { protections } from "./native-cache-refs.ts";
import { type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import type { processCwds } from "./process-cwd.ts";
import { processFiles, usesDirectory } from "./process-files.ts";

/**
 * This user's processes with a file open, mapped or running under `path`, the stage itself open as a directory
 * included (openat and readdir work through it), and those whose files cannot be read: the same processes whose working
 * directory `readCwds` cannot read (unless the user trusted them), as those hide both.
 */
function openUnder(path: string, readCwds: typeof processCwds): string[] {
  const found = processFiles();
  if (!found) return ["open files of processes cannot be read"];
  // This process's own directory is always readable, so no answer at all means the reader failed.
  const read = found.unread.length ? readCwds([String(process.pid), ...found.unread]) : undefined;
  const hidden = new Set(read === null ? found.unread : (read?.unreadable ?? []));
  return [
    ...[...found.files]
      .filter(([, paths]) => paths.some((used) => usesDirectory(used, path)))
      .map(([pid]) => `process ${pid} has a file open in it`),
    ...found.unread.filter((pid) => hidden.has(pid)).map((pid) => `open files of process ${pid} cannot be read`),
  ];
}

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
