import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConsumerPaths } from "./files.ts";
import { reportNativeCache } from "./native-cache.ts";
import { interruptedPrune, pruneNativeCache } from "./native-cache-prune.ts";

type CacheOptions = {
  readonly reference?: readonly string[] | undefined;
  readonly prune?: boolean | undefined;
  readonly "trust-process"?: readonly string[] | undefined;
  readonly "trust-root-cwd"?: boolean | undefined;
};

/** A process of this user a prune would hold on, printed as `PID@START` so `--trust-process` can name it. */
const UNREADABLE = /^unreadable working directory of process (\d+@\d+) /;

/**
 * `dori update cache`: the report by default, which removes nothing and lists the processes `--trust-process` could
 * name (`trustable`) and the privileged ones `--trust-root-cwd` lets pass as a whole (`privileged`); `--prune`
 * removes under the prune lock. Both scan the running release, the Dori home, the side home and every `--reference`
 * root.
 */
export function runCacheCommand(paths: ConsumerPaths, options: CacheOptions): number {
  const trust = options["trust-process"];
  const trustRootCwd = options["trust-root-cwd"] === true;
  if ((trust || trustRootCwd) && !options.prune)
    throw new Error("--trust-process and --trust-root-cwd apply to cache --prune; the report trusts nothing");
  const sources = [resolve(import.meta.dir, "../..")];
  const roots = [
    paths.dori,
    process.env["OMP_DORI_HOME"] || join(homedir(), ".omp-dori"),
    ...(options.reference ?? []).map((path) => resolve(path)),
  ];
  if (options.prune) {
    const pruned = pruneNativeCache(paths.home, sources, roots, { ...(trust ? { trust } : {}), trustRootCwd });
    console.log(JSON.stringify(pruned, null, 2));
    return 0;
  }
  const privileged = new Set<string>();
  const entries = reportNativeCache(paths.home, sources, roots, undefined, { privileged });
  const trustable = new Set(
    entries.flatMap((entry) => entry.protectedBy.flatMap((reason) => UNREADABLE.exec(reason)?.[1] ?? [])),
  );
  const interrupted = interruptedPrune(paths.home);
  console.log(
    JSON.stringify(
      { removes: "nothing", entries, interrupted, trustable: [...trustable], privileged: [...privileged] },
      null,
      2,
    ),
  );
  return 0;
}
