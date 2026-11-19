import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Checkpoint } from "./checkpoints.ts";
import type { Progress } from "./reports.ts";
import { gitStatus, IncompleteGitObservation, inDirectory } from "./supervision-git.ts";
import type { SupervisedLane, SupervisionOptions } from "./supervision-observe.ts";
import type { SupervisionDeps } from "./supervision.ts";

type FileSample = [path: string, mtime: number, ctime: number, size: number] | [path: string, missing: null];
export type DeclaredActivity = { readonly files: ReadonlyMap<string, FileSample>; readonly changes: readonly string[] };
export type ActivitySample = {
  readonly signature: (progress: Progress | null, checkpoint: Checkpoint | null) => string;
  readonly declared: DeclaredActivity | undefined;
  readonly gitObserved: boolean;
};

export const writerDir = (stateDir: string): string => resolve(stateDir, "lanes", ".supervision-writers");
const canonicalIfPresent = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    // Missing cwd still follows the existing Git failure path.
    return resolve(path);
  }
};
const statPath = (path: string): FileSample => {
  try {
    const stat = lstatSync(path);
    return [path, stat.mtimeMs, stat.ctimeMs, stat.size];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [path, null];
  }
};

/** Preserve explicitly watched lane paths at the pre-hook sample when absorbing incidental hook activity. */
export const laneActivity = async (
  { run, stateDir }: Pick<SupervisionDeps, "run" | "stateDir">,
  options: SupervisionOptions,
  lane: SupervisedLane,
  before?: ActivitySample,
): Promise<ActivitySample> => {
  const locks = canonicalIfPresent(writerDir(stateDir));
  // Keep the existing spelling in persisted activity signatures. Canonicalize only for exclusion.
  const cwd = resolve(lane.cwd ?? ".");
  const retained = before?.declared;
  const paths = new Set(
    [...(options.activityPaths ?? []), ...(lane.activityPaths ?? [])]
      .map((path) => resolve(cwd, path))
      .filter((path) => !inDirectory(relative(locks, canonicalIfPresent(path)))),
  );
  const watching = !retained && paths.size > 0 ? new Set(paths) : undefined;
  const declared = watching ? { files: new Map<string, FileSample>(), changes: [] as string[] } : undefined;
  const changes: string[] = [];
  let gitObserved = false;
  // Don't absorb the first successful Git result into an effect baseline; the next sweep must see it as progress.
  if (options.gitActivity !== false && lane.cwd && (!before || before.gitObserved)) {
    const result = await gitStatus(run, lane.cwd, canonicalIfPresent(lane.cwd), locks);
    if (result.code === 124 || (before?.gitObserved && result.code !== 0)) {
      throw new IncompleteGitObservation(`git status exited ${result.code}`);
    }
    if (result.code === 0) {
      gitObserved = true;
      const entries = result.out.split("\0");
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const path = resolve(cwd, entry.slice(3));
        const rel = relative(cwd, path);
        // Dependency churn and paths outside the lane's cwd are not lane progress.
        if (inDirectory(rel) && !rel.split("/").includes("node_modules") && !retained?.files.has(path)) {
          paths.add(path);
          changes.push(entry);
          if (watching?.has(path)) declared?.changes.push(entry);
        }
        if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index++;
      }
    }
  }
  if (retained) for (const path of retained.files.keys()) paths.add(path);
  const files = [...paths].sort().map((path) => {
    const current = statPath(path);
    if (watching?.has(path)) declared?.files.set(path, current);
    return retained?.files.get(path) ?? current;
  });
  if (retained) for (const entry of retained.changes) changes.push(entry);
  changes.sort();
  return {
    signature: (progress, checkpoint) =>
      JSON.stringify({ report: progress?.lastReport ?? null, checkpoint, files, changes }),
    declared,
    gitObserved,
  };
};
