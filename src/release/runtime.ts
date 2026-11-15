import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { consumerPaths, owned, realDirectory, regularFile } from "./files.ts";
import { assertNativeSource } from "./native.ts";
import { assertSourceBundle, readSourceBundle, SourceBundleError } from "./source-bundle.ts";

/** Managed cache paths follow this loaded release's lock without changing the user's config. */
export function resolveConsumerOmpUlwPath(
  configuredPath: string,
  {
    home = homedir(),
    sourceRoot = resolve(import.meta.dir, "../.."),
    useDefault = false,
  }: {
    readonly home?: string;
    readonly sourceRoot?: string;
    readonly useDefault?: boolean;
  } = {},
): string {
  const paths = consumerPaths(home);
  const entry = relative(paths.dependencies, configuredPath);
  if (
    !useDefault &&
    (configuredPath !== join(paths.dependencies, entry) ||
      !/^omp-ulw-[a-f0-9]{40}(?:-[a-f0-9]{64})?(?:\/index\.ts)?$/.test(entry))
  )
    return configuredPath;

  // Resolve the helper's physical location at call time, never the mutable ~/.dori/src pointer.
  const source = realpathSync(sourceRoot);
  if (dirname(source) !== paths.releases || !/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(basename(source)))
    return configuredPath;
  try {
    owned(source);
    const lock = join(source, "omp-ulw.lock");
    if (!regularFile(lock)) throw new Error(`Missing consumer release lock: ${lock}`);
    const commit = readFileSync(lock, "utf8").trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid consumer release lock: ${lock}`);

    const receipt = join(paths.manifests, `${basename(source)}.json`);
    const required = regularFile(receipt) && JSON.parse(readFileSync(receipt, "utf8")).requirements.omp === "18.20.0";
    const bundle = required || regularFile(join(source, "omp-ulw.overlay.lock")) ? readSourceBundle(source) : undefined;
    if (bundle && bundle.lock.commit !== commit) throw new Error("Consumer release ULW base and overlay differ");
    const dependency = join(paths.dependencies, `omp-ulw-${commit}${bundle ? `-${bundle.identity}` : ""}`);
    realDirectory(dependency);
    owned(dependency);
    if (!regularFile(join(dependency, "index.ts"))) throw new Error(`Missing consumer dependency entry: ${dependency}`);
    if (bundle) assertSourceBundle(dependency, bundle, home);
    return entry.endsWith("/index.ts") ? join(dependency, "index.ts") : dependency;
  } catch (error) {
    throw new SourceBundleError(error instanceof Error ? error.message : String(error));
  }
}

/** Default/previously managed native commands follow this frozen release; absolute custom commands are explicit overrides. */
export function resolveConsumerOmpCommand(
  configured: readonly string[],
  {
    home = homedir(),
    sourceRoot = resolve(import.meta.dir, "../.."),
  }: { readonly home?: string; readonly sourceRoot?: string } = {},
): readonly string[] {
  const source = realpathSync(sourceRoot);
  const paths = consumerPaths(home);
  if (dirname(source) !== paths.releases || !/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(basename(source))) return configured;
  const manifest = JSON.parse(readFileSync(join(paths.manifests, `${basename(source)}.json`), "utf8"));
  if (manifest.requirements.omp !== "18.20.0") return configured;
  const first = configured[0] ?? "omp";
  const managed =
    first === join(paths.dori, "bin/omp") ||
    /^[a-f0-9]{40}-[a-f0-9]{16}\/scripts\/consumer\/omp$/.test(relative(paths.releases, first));
  if (first !== "omp" && !managed) return configured;
  assertNativeSource(source, home);
  return [join(source, "scripts/consumer/omp"), ...configured.slice(1)];
}

/** Managed executable paths replace installer defaults; legacy argv overrides still apply only to literal omp. */
export function resolveProcessOmpCommand(configured: readonly string[], configFile: string): readonly string[] {
  const executable = process.env["DORI_AGENT_EXECUTABLE"];
  const installation = dirname(configFile);
  const installed =
    executable !== undefined &&
    (existsSync(join(installation, ".omp-dori")) || existsSync(join(installation, "releases/consumer-owner.json"))) &&
    configured[0] === join(realpathSync(installation), "bin/omp");
  const selected =
    configured[0] === "omp"
      ? (executable ?? (process.env["DORI_AGENT_CMD"] || undefined))
      : installed
        ? executable
        : undefined;
  return selected === undefined ? configured : [selected, ...configured.slice(1)];
}

/** A managed process selects its prepared default, while an explicit external dependency remains a user choice. */
export function resolveProcessOmpUlwPath(configured: string, home: string): string {
  const selected = process.env["DORI_OMP_ULW_PATH"];
  if (!selected) return configured;
  const managed = /^omp-ulw-[a-f0-9]{40}(?:-[a-f0-9]{64})?(?:\/index\.ts)?$/.test(
    relative(consumerPaths(home).dependencies, configured),
  );
  if (configured !== "" && configured !== join(home, ".dori/omp-ulw/index.ts") && !managed) return configured;
  if (/^omp-ulw-[a-f0-9]{64}\/index\.ts$/.test(relative(join(home, ".cache/omp-dori"), selected))) {
    try {
      assertSourceBundle(dirname(selected), readSourceBundle(resolve(import.meta.dir, "../..")), home);
    } catch (error) {
      throw new SourceBundleError(error instanceof Error ? error.message : String(error));
    }
  }
  return selected;
}
