import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { platform } from "../src/platform/index.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { digest } from "../src/update/source.ts";
import { createConsumerSmokeContext } from "./consumer-smoke-context.ts";
import { snapshot } from "./consumer-smoke-inspect.ts";

const { values } = parseArgs({
  options: {
    "source-a": { type: "string" },
    "source-b": { type: "string" },
    "working-tree": { type: "boolean" },
    out: { type: "string" },
    "runtime-bin": { type: "string" },
    "tar-bin": { type: "string" },
  },
});
assert(
  values["source-a"] && values["source-b"] && values.out && isAbsolute(values.out),
  "Required: --source-a V0.1.3 --source-b CANDIDATE --out FRESH_ABSOLUTE_DIR [--working-tree] [--runtime-bin LEGACY_BINARY] [--tar-bin GNU_TAR]",
);
const sourceA = realpathSync(values["source-a"]);
const sourceB = realpathSync(values["source-b"]);
const legacyRuntime = process.platform === "darwin" ? "hc" : "herdr";
assert(
  (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "darwin" && process.arch === "arm64"),
  "Requires Linux x64 or Darwin arm64",
);
const runtimeBin = values["runtime-bin"] && realpathSync(values["runtime-bin"]);
const tar = values["tar-bin"] ?? Bun.which(process.platform === "darwin" ? "gtar" : "tar");
assert(tar, "A real GNU tar is required by the production release builder; supply --tar-bin");
const { out, home, side, tools, run, unchangedPrimary } = createConsumerSmokeContext(
  values.out,
  tar,
  runtimeBin ? { runtime: legacyRuntime, binary: runtimeBin } : undefined,
);
const bun = join(tools, "bun");
const git = join(tools, "git");
const legacyCli = join(side, "bin/dori");
const cli = join(side, "bin/cataly");
const distA = join(out, "release-a");
const distB = join(out, "release-b");
const manifestFile = (dist: string) => join(dist, "release-manifest.json");
const readManifest = (dist: string) => validateReleaseManifest(JSON.parse(readFileSync(manifestFile(dist), "utf8")));

async function build(source: string, dist: string): Promise<void> {
  const clean = await run("clean-committed-snapshot", [git, "-C", source, "status", "--porcelain"]);
  assert.equal(clean.stdout, "");
  await run("build-committed-release", [
    bun,
    join(source, "scripts/release.ts"),
    "build",
    "--out",
    dist,
    "--prerelease",
  ]);
  const verify =
    "const {verifyDistribution}=await import(process.argv[1]); " +
    "console.log(JSON.stringify((await verifyDistribution(process.argv[2],process.argv[3])).manifest));";
  await run("verify-committed-distribution", [
    bun,
    "-e",
    verify,
    join(source, "scripts/release-build.ts"),
    source,
    dist,
  ]);
}

await run("headless-tools", [
  bun,
  "-e",
  'for (const tool of ["hc", "herdr"]) if (Bun.which(tool)) throw Error(`Unexpected terminal tool: ${tool}`);',
]);
assert.match((await run("gnu-tar", [join(tools, "tar"), "--version"])).stdout, /GNU tar/);
await build(sourceA, distA);
const working = values["working-tree"]
  ? JSON.parse(
      (
        await run("package-working-candidate", [
          bun,
          join(sourceB, "scripts/consumer-smoke-candidate.ts"),
          sourceB,
          join(out, "candidate-tree"),
          distB,
        ])
      ).stdout,
    )
  : undefined;
if (!working) await build(sourceB, distB);
const a = readManifest(distA);
const b = readManifest(distB);
assert.equal(a.tag, "v0.1.3");
assert.equal(a.commit, "97371823c4936f7e83f656cfa6ca9d446ecf1995", "Source A must be the actual old tagged updater");
assert.equal(b.tag, "v0.1.4");
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

const bootstrap = (dist: string, target: string, manifest: ReleaseManifest, legacy = false) =>
  run(
    `bootstrap-${manifest.tag}`,
    [join(tools, "bash"), join(dist, "install.sh"), "--from", dist, "--version", manifest.tag, "--home", target],
    { legacy },
  );

// Even without the old binary, the actual old updater must parse the new package and admit its v1 profile.
const checked = await run("historical-check", [
  bun,
  join(sourceA, "src/release/cli.ts"),
  "check",
  "--from",
  distB,
  "--home",
  side,
  "--version",
  b.tag,
]);
assert.equal(JSON.parse(checked.stdout).available, b.tag);

if (runtimeBin) {
  await run("historical-runtime-version", [runtimeBin, "--version"]);
  await bootstrap(distA, side, a, true);
  const config = readFileSync(join(side, "config.json"));
  const wrappers = snapshot(join(side, "bin"));
  const bytes = snapshot(realpathSync(join(side, "src")));
  const owner = readFileSync(join(side, "releases/consumer-owner.json"));
  const before = snapshot(side);
  for (const kind of ["checksum", "manifest"] as const) {
    const bad = join(out, `rejected-${kind}`);
    cpSync(distB, bad, { recursive: true, errorOnExist: true, force: false });
    if (kind === "checksum") {
      const archive = join(bad, b.archive.name);
      writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("corrupt")]));
    } else {
      const metadata = `${JSON.stringify({ ...b, tag: "invalid-negative-test-tag" }, null, 2)}\n`;
      writeFileSync(manifestFile(bad), metadata);
      const sums = readFileSync(join(bad, "SHA256SUMS"), "utf8").replace(
        /^[a-f0-9]{64} {2}release-manifest\.json$/m,
        `${digest(metadata)}  release-manifest.json`,
      );
      writeFileSync(join(bad, "SHA256SUMS"), sums);
    }
    const rejected = await run(`reject-${kind}`, [legacyCli, "update", "install", "--from", bad], {
      allowFailure: true,
      legacy: true,
    });
    assert.equal(rejected.code, 2);
    assert.match(
      rejected.stderr,
      kind === "checksum" ? /Release checksum differs/ : /Release identity\/version\/tag\/commit\/tree is invalid/,
    );
    assert.equal(snapshot(side), before, `${kind} rejection mutated prior state/config/wrappers`);
  }
  const held = await run("legacy-updater-needs-tool", [legacyCli, "update", "install", "--from", distB], {
    allowFailure: true,
  });
  assert.equal(held.code, 2);
  assert.match(held.stderr, new RegExp(`${legacyRuntime} is required`));
  await run("historical-updater-installs-headless", [legacyCli, "update", "install", "--from", distB], {
    legacy: true,
  });
  assert(readFileSync(join(side, "config.json")).equals(config));
  // Nothing else has installed this identity. Prove the first operator launch before any reinstall can repair it.
  const source = realpathSync(join(side, "src"));
  const identity = `${platform.nativeCacheLabel()}-${readSourceBundle(source, true).identity}`;
  const oldCache = join(home, ".cache/omp-dori", identity);
  const newCache = join(home, ".cache/omp-cataly", identity);
  const receipt = readFileSync(join(oldCache, "receipt.json"));
  const launcher = readFileSync(join(oldCache, "bin/omp"));
  assert(!existsSync(newCache));
  assert.equal(
    (await run("first-upgraded-native-version", [join(side, "bin/omp"), "--version"])).stdout.trim(),
    b.requirements.omp,
  );
  try {
    await run("first-upgraded-harness-up", [cli, "harness", "up"]);
    const { stdout } = await run("first-upgraded-harness-status", [cli, "harness", "status"]);
    assert.match(stdout, /NATIVE lead headless:\S+ idle pid=\d+ session=\S+/);
    assert.match(stdout, /NATIVE duty headless:\S+ idle pid=\d+ session=\S+/);
  } finally {
    await run("first-upgraded-harness-stop", [cli, "harness", "stop"]);
  }
  assert(readFileSync(join(oldCache, "receipt.json")).equals(receipt));
  assert(readFileSync(join(oldCache, "bin/omp")).equals(launcher));
  assert(!existsSync(newCache), "First launch must not duplicate the authenticated native cache");
  await run("check-without-terminal", [cli, "update", "check", "--from", distB]);
  await run("reinstall-without-terminal", [cli, "update", "install", "--from", distB]);
  await run("installed-native-bindings", [
    bun,
    join(import.meta.dir, "consumer-smoke-inspect.ts"),
    side,
    manifestFile(distB),
    manifestFile(distA),
    "headless",
  ]);
  await run("installed-harness-command", [
    bun,
    join(import.meta.dir, "consumer-smoke-harness.ts"),
    "--side",
    side,
    "--expected-source",
    realpathSync(join(side, "src")),
  ]);
  const verified = snapshot(side);
  const rollback = await run("hold-rollback-without-tool", [cli, "update", "rollback", "--version", a.tag], {
    allowFailure: true,
  });
  assert.equal(rollback.code, 2);
  assert.match(rollback.stderr, new RegExp(`${legacyRuntime} is required`));
  assert.equal(snapshot(side), verified);
  await run("rollback-with-legacy-tool", [cli, "update", "rollback", "--version", a.tag], { legacy: true });
  assert.deepEqual(
    JSON.parse(snapshot(join(side, "bin"))).filter(
      ([name]: [string]) => !["cataly", "cataly-harness", "omp-cataly"].includes(name),
    ),
    JSON.parse(wrappers),
    "Rollback did not restore exact legacy wrappers",
  );
  assert.equal(snapshot(realpathSync(join(side, "src"))), bytes, "Rollback did not restore exact legacy source");
  // Rescue the same home with the new bootstrap after withholding access to the legacy binary again.
  await bootstrap(distB, side, b);
  assert(readFileSync(join(side, "config.json")).equals(config));
  assert(readFileSync(join(side, "releases/consumer-owner.json")).equals(owner));
}

// A fresh install and an upgrade must never supply each other's missing native dependencies.
const isolated = createConsumerSmokeContext(join(out, "fresh"), tar);
const fresh = join(isolated.home, ".omp-cataly");
await isolated.run("fresh-bootstrap", [
  join(isolated.tools, "bash"),
  join(distB, "install.sh"),
  "--from",
  distB,
  "--home",
  fresh,
]);
const freshConfig = JSON.parse(readFileSync(join(fresh, "config.json"), "utf8"));
assert.equal(freshConfig.runtime, undefined);
assert.equal(freshConfig.sessionRuntime, undefined);
assert.match(
  (await isolated.run("headless-native-version", [join(fresh, "bin/omp"), "--version"])).stdout,
  /\b18\.20\.0\b/,
);
assert.equal(
  JSON.parse((await isolated.run("headless-status", [join(fresh, "bin/cataly"), "update", "status"])).stdout).installed
    .tag,
  b.tag,
);
isolated.unchangedPrimary();
unchangedPrimary();
writeFileSync(
  join(out, "result.json"),
  `${JSON.stringify({ a, b, working, runtime: "headless", legacyTransition: !!runtimeBin, platform: process.platform, arch: process.arch }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(`Consumer transition checks completed; evidence: ${out}`);
