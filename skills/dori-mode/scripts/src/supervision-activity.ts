import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Checkpoint } from "./checkpoints.ts";
import type { Progress } from "./reports.ts";
import { gitStatus, IncompleteGitObservation, inDirectory, noWorktree } from "./supervision-git.ts";
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
  // Keep the existing spelling in persisted activity signatures; use physical paths only for comparisons.
  const cwd = resolve(lane.cwd ?? ".");
  const retained = before?.declared;
  const paths = new Set(
    [...(options.activityPaths ?? []), ...(lane.activityPaths ?? [])]
      .map((path) => resolve(cwd, path))
      .filter((path) => !inDirectory(relative(locks, canonicalIfPresent(path)))),
  );
  const watched = new Set(paths);
  const watching = !retained && watched.size > 0 ? new Set(watched) : undefined;
  const declared = watching ? { files: new Map<string, FileSample>(), changes: [] as string[] } : undefined;
  const changes: string[] = [];
  let gitObserved = false;
  // Don't absorb the first successful Git result into an effect baseline; the next sweep must see it as progress.
  if (options.gitActivity !== false && lane.cwd && (!before || before.gitObserved)) {
    const physicalCwd = canonicalIfPresent(lane.cwd);
    const result = await gitStatus(run, lane.cwd, physicalCwd, locks, watched.size > 0);
    if (result.code !== 0 && (before?.gitObserved || !noWorktree(result))) {
      throw new IncompleteGitObservation(`git status exited ${result.code}`);
    }
    if (result.code === 0) {
      gitObserved = true;
      const watchedIdentities = new Set([...watched].map(canonicalIfPresent));
      const entries = result.out.split("\0");
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const name = entry.slice(3);
        const path = resolve(cwd, name);
        // Keep the lexical match for deleted paths; realpath also matches live files watched through an alias.
        const gitPath = resolve(result.root ?? physicalCwd, name);
        const lanePath = resolve(cwd, relative(physicalCwd, gitPath));
        const isWatched =
          watched.has(lanePath) || (watchedIdentities.size > 0 && watchedIdentities.has(canonicalIfPresent(gitPath)));
        const rel = relative(cwd, path);
        // Dependency churn and paths outside the lane's cwd are not lane progress.
        if (inDirectory(rel) && !rel.split(sep).includes("node_modules") && !(retained && isWatched)) {
          paths.add(path);
          changes.push(entry);
          if (isWatched) {
            watching?.add(path);
            declared?.changes.push(entry);
          }
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
