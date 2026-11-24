import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { readArchive } from "../src/release/archive.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { createConsumerSmokeContext } from "./consumer-smoke-context.ts";
import { assertNativeExecutable, currentNativeHost, nativeHosts, nativeReleasePath } from "./release-native.ts";

const { values } = parseArgs({
  options: {
    "source-a": { type: "string" },
    "source-b": { type: "string" },
    "working-tree": { type: "boolean" },
    out: { type: "string" },
    "tar-bin": { type: "string" },
  },
});
assert(
  values["source-a"] && values["source-b"] && values.out && isAbsolute(values.out),
  "Required: --source-a V0.1.3 --source-b CANDIDATE --out FRESH_ABSOLUTE_DIR [--working-tree] [--tar-bin GNU_TAR]",
);
const sourceA = realpathSync(values["source-a"]);
const sourceB = realpathSync(values["source-b"]);
const host = currentNativeHost();
assert(host, "Requires Linux x64 or Darwin arm64");
const tar = values["tar-bin"] ?? Bun.which(process.platform === "darwin" ? "gtar" : "tar");
assert(tar, "A real GNU tar is required by the production release builder; supply --tar-bin");
const { out, side, tools, run, unchangedPrimary } = createConsumerSmokeContext(values.out, tar);
const bun = join(tools, "bun");
const git = join(tools, "git");
const cli = join(side, "bin/cataly");
const distA = join(out, "release-a");
const distB = join(out, "release-b");
const manifestFile = (dist: string) => join(dist, "release-manifest.json");
const readManifest = (dist: string) => validateReleaseManifest(JSON.parse(readFileSync(manifestFile(dist), "utf8")));

async function build(source: string, dist: string): Promise<void> {
  const clean = await run("clean-committed-snapshot", [git, "-C", source, "status", "--porcelain"]);
  assert.equal(clean.stdout, "");
  await run(
    "build-committed-release",
    [bun, join(source, "scripts/release.ts"), "build", "--out", dist, "--prerelease"],
    { producer: true },
  );
  const verify =
    "const {verifyDistribution}=await import(process.argv[1]); " +
    "console.log(JSON.stringify((await verifyDistribution(process.argv[2],process.argv[3])).manifest));";
  await run(
    "verify-committed-distribution",
    [bun, "-e", verify, join(source, "scripts/release-build.ts"), source, dist],
    { producer: true },
  );
}

assert.match((await run("gnu-tar", [join(tools, "tar"), "--version"])).stdout, /GNU tar/);
await build(sourceA, distA);
const working = values["working-tree"]
  ? JSON.parse(
      (
        await run(
          "package-working-candidate",
          [bun, join(sourceB, "scripts/consumer-smoke-candidate.ts"), sourceB, join(out, "candidate-tree"), distB],
          { producer: true },
        )
      ).stdout,
    )
  : undefined;
if (!working) await build(sourceB, distB);
const a = readManifest(distA);
const b = readManifest(distB);
assert.equal(a.tag, "v0.1.3");
assert.equal(a.commit, "97371823c4936f7e83f656cfa6ca9d446ecf1995", "Source A must be the actual old tagged updater");
assert.equal(b.tag, "v0.1.4");
const crossesNativeGeneration = b.requirements.omp.startsWith("19.");
// A local candidate rebuilds only this host's native binary; the public producer also receives the other host's.
const controllerPath = nativeReleasePath(host);
for (const other of nativeHosts.filter((entry) => entry !== host)) {
  const foreign = nativeReleasePath(other);
  assert(!b.source.files.some(({ path }) => path === foreign), `Local smoke unexpectedly bundles ${foreign}`);
}
assert(
  b.source.files.find(({ path }) => path === controllerPath)?.executable,
  "Release lacks an executable native controller",
);
const controller = readArchive(readFileSync(join(distB, b.archive.name)), b).find(
  ({ path }) => path === controllerPath,
);
assert(controller, "Release lacks the native executable payload");
assertNativeExecutable(host, controller.bytes);
for (const resource of ["SKILL.md", "references/setup.md", "assets/cataly-avatar.png"]) {
  const canonical = b.source.files.find((file) => file.path === `skills/cataly-mode/${resource}`);
  const historical = b.source.files.find((file) => file.path === `skills/dori-mode/${resource}`);
  assert(canonical && historical && canonical.sha256 === historical.sha256, `Legacy primary skill lacks ${resource}`);
}
assert.deepEqual(
  b.source.files.filter(({ path }) => path.startsWith("skills/dori-mode/scripts/")).map(({ path }) => path),
  ["skills/dori-mode/scripts/src/cli.ts"],
);
assert.notEqual(a.source.hash, b.source.hash);
assert.notEqual(a.archive.sha256, b.archive.sha256);
await run("ancestor", [git, "-C", sourceB, "merge-base", "--is-ancestor", a.commit, working?.base ?? b.commit]);

// An already installed older updater must still parse the new package: it admits the v1 profile of an OMP 18 release
// and refuses a newer native generation, which only this release's bootstrap installs.
const checked = await run(
  "historical-check",
  [bun, join(sourceA, "src/release/cli.ts"), "check", "--from", distB, "--home", side, "--version", b.tag],
  { allowFailure: crossesNativeGeneration },
);
if (crossesNativeGeneration) {
  assert.equal(checked.code, 2);
  assert.match(checked.stderr, /Release requirements do not match the supported runtime/);
} else assert.equal(JSON.parse(checked.stdout).available, b.tag);

await run("fresh-bootstrap", [
  join(tools, "bash"),
  join(distB, "install.sh"),
  "--from",
  distB,
  "--version",
  b.tag,
  "--home",
  side,
]);
// The installed release activates the bundled binary for this host in its own source tree.
const installedController = join(side, "src", controllerPath);
accessSync(installedController, constants.X_OK);
assert(readFileSync(installedController).equals(controller.bytes), "Installed native controller differs");
const config = JSON.parse(readFileSync(join(side, "config.json"), "utf8"));
assert.equal(config.runtime, undefined);
assert.equal(config.sessionRuntime, undefined);
assert.equal(
  (await run("headless-native-version", [join(side, "bin/omp"), "--version"])).stdout.trim(),
  b.requirements.omp,
);
assert.equal(JSON.parse((await run("headless-status", [cli, "update", "status"])).stdout).installed.tag, b.tag);
try {
  await run("fresh-harness-up", [cli, "harness", "up"]);
  const { stdout } = await run("fresh-harness-status", [cli, "harness", "status"]);
  assert.match(stdout, /NATIVE lead headless:\S+ idle pid=\d+ session=\S+/);
  assert.match(stdout, /NATIVE duty headless:\S+ idle pid=\d+ session=\S+/);
} finally {
  await run("fresh-harness-stop", [cli, "harness", "stop"]);
}
await run("check-installed", [cli, "update", "check", "--from", distB]);
await run("reinstall", [cli, "update", "install", "--from", distB]);
await run("installed-native-bindings", [
  bun,
  join(import.meta.dir, "consumer-smoke-inspect.ts"),
  side,
  manifestFile(distB),
]);
await run("installed-harness-command", [
  bun,
  join(import.meta.dir, "consumer-smoke-harness.ts"),
  "--side",
  side,
  "--expected-source",
  realpathSync(join(side, "src")),
]);
unchangedPrimary();
writeFileSync(
  join(out, "result.json"),
  `${JSON.stringify({ a, b, working, runtime: "headless", platform: process.platform, arch: process.arch }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(`Consumer release checks completed; evidence: ${out}`);
