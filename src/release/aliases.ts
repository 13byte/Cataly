import { dirname, join } from "node:path";
import { type ConsumerPaths, isPrimaryConsumer, owned, pointer, realDirectory, replacePointer } from "./files.ts";

/** An old updater can still validate its v1 wrapper receipt. Canonical aliases are separate from that wire format. */
export function installLegacyAliases(paths: ConsumerPaths, publish = true): void {
  if (paths.layout === "cataly") return;
  const names: readonly (readonly [string, string])[] = [
    ["cataly", "dori"],
    ["cataly-harness", "dori-harness"],
    ...(isPrimaryConsumer(paths) ? [] : ([["omp-cataly", "omp-dori"]] as const)),
  ];
  for (const [alias, target] of names) {
    const path = join(paths.cataly, "bin", alias);
    const expected = join(paths.cataly, "bin", target);
    realDirectory(dirname(path), publish);
    const current = pointer(path);
    if (current !== undefined && current !== expected) throw new Error(`Unmanaged Cataly compatibility link: ${path}`);
    if (publish && current === undefined) {
      owned(dirname(path));
      replacePointer(path, undefined, expected);
    }
  }
}
