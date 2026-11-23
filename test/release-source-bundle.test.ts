import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import { automaticUpdate } from "../src/release/automatic.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import {
  resolveConsumerOmpCommand,
  resolveConsumerOmpUlwPath,
  resolveProcessOmpUlwPath,
} from "../src/release/runtime.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { releasePath } from "../src/release/state.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { isPolicyLaneCommand } from "../skills/cataly-mode/scripts/src/lane-policy-launch.ts";
import { archive, type ConsumerFixture, fixture, withArchive } from "./release-consumer-setup.ts";
import { fixtureGit, nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

function bundledRelease(
  f: ConsumerFixture,
  selected: string,
  nativeSource?: string,
  nativeVersion = "18.20.0",
  headless = false,
) {
  const original = f.release(selected);
  const source = join(f.root, `bundled-${selected}`);
  extractArchive(original.bundle.files, original.bundle.manifest, source);
  const ulw = overlayFixture(source, join(f.root, `ulw-${selected}`), false, selected);
  if (nativeSource) {
    mkdirSync(join(source, "native-addon"), { mode: 0o700 });
    for (const path of ["native-omp.lock", "native-omp.patch", "native-addon/package.json", "native-addon/bun.lock"])
      copyFileSync(join(nativeSource, path), join(source, path));
  } else {
    const native = overlayFixture(source, join(f.root, `native-${selected}`), true, "reviewed-overlay", nativeVersion);
    nativeCacheFixture(source, f.paths.home, native.checkout);
  }
  mkdirSync(join(source, "scripts/consumer"), { recursive: true, mode: 0o700 });
  // Real helper bytes are carried; addon loading remains a separate real isolated installation gate.
  copyFileSync(
    resolve(import.meta.dir, "../scripts/source-dependencies.ts"),
    join(source, "scripts/source-dependencies.ts"),
  );
  copyFileSync(resolve(import.meta.dir, "../scripts/consumer/omp"), join(source, "scripts/consumer/omp"));
  chmodSync(join(source, "scripts/consumer/omp"), 0o755);
  if (headless) {
    for (const path of ["release-capabilities.json", "release-headless.json"])
      copyFileSync(resolve(import.meta.dir, "..", path), join(source, path));
  }
  const publicSource = sourceManifest(source);
  const bytes = archive(
    publicSource.files.map((file) => ({
      name: `${original.bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    validateReleaseManifest({
      ...original.bundle.manifest,
      source: publicSource,
      requirements: {
        ...original.bundle.manifest.requirements,
        omp: readSourceBundle(source, true).lock.nativeVersion,
      },
      ompUlw: { repository: ulw.lock.repository, commit: ulw.commit },
    }),
    bytes,
  );
  const bundle = readSourceBundle(source);
  const dependency = join(f.paths.dependencies, `omp-ulw-${ulw.commit}-${bundle.identity}`);
  renameSync(ulw.checkout, dependency);
  saveJson(`${dependency}.json`, {
    version: 1,
    repository: ulw.lock.repository,
    commit: ulw.commit,
    identity: bundle.identity,
  });
  const metadata = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(original.dist, manifest.archive.name), bytes);
  writeFileSync(join(original.dist, "release-manifest.json"), metadata);
  writeFileSync(
    join(original.dist, "SHA256SUMS"),
    `${digest(bytes)}  ${manifest.archive.name}\n${digest(metadata)}  release-manifest.json\n`,
  );
  return { source, dependency, dist: original.dist, bundle: { manifest, files: readArchive(bytes, manifest) } };
}

posix(
  "consumer install, update and reuse select each loaded release's bound overlay without rewriting config",
  async () => {
    const f = fixture();
    const first = bundledRelease(f, "first");
    const one = await installBundle(f.paths, first.bundle, undefined);
    const config = readFileSync(f.paths.config);
    const configured = JSON.parse(config.toString());
    const sourceOne = releasePath(f.paths, one.current);
    const omp = resolveConsumerOmpCommand(["omp", "{prompt}"], { home: f.paths.home, sourceRoot: sourceOne });
    expect(omp[0]).toBe(readlinkSync(join(f.paths.dori, "bin/omp")));
    expect(omp).toEqual([
      join(sourceOne, "scripts/consumer/omp"),
      "--no-extensions",
      "-e",
      join(sourceOne, "extension"),
      "{prompt}",
    ]);
    expect(configured.agentCommand[0]).toBe(join(f.paths.dori, "bin/omp"));
    expect(
      isPolicyLaneCommand(
        resolveConsumerOmpCommand([join(f.paths.dori, "bin/omp"), "--cataly-role", "lane", "{prompt}"], {
          home: f.paths.home,
          sourceRoot: sourceOne,
        }),
      ),
    ).toBe(true);
    const second = bundledRelease(f, "second", first.source);
    const two = await installBundle(f.paths, second.bundle, one);
    const sourceTwo = releasePath(f.paths, two.current);
    const effective = (sourceRoot: string) =>
      resolveConsumerOmpUlwPath(configured.ompUlwPath, { home: f.paths.home, sourceRoot });
    expect(effective(sourceOne)).toBe(join(first.dependency, "index.ts"));
    expect(effective(sourceTwo)).toBe(join(second.dependency, "index.ts"));
    expect(readFileSync(effective(sourceOne), "utf8")).toContain('selected = "first"');
    expect(readFileSync(effective(sourceTwo), "utf8")).toContain('selected = "second"');
    expect(fixtureGit(first.dependency, "rev-parse", "HEAD")).toBe(one.current.ompUlw.commit);
    expect(await installBundle(f.paths, second.bundle, two)).toEqual(two);
    expect(readFileSync(f.paths.config)).toEqual(config);
    expect(resolveConsumerOmpCommand(["/owner/custom-omp"], { home: f.paths.home, sourceRoot: sourceTwo })).toEqual([
      "/owner/custom-omp",
    ]);
    const rolled = await rollbackRelease(f.paths, two);
    expect(effective(sourceOne)).toBe(join(first.dependency, "index.ts"));
    expect(readFileSync(f.paths.config)).toEqual(config);
    writeFileSync(join(second.dependency, "index.ts"), "owner edit\n");
    expect(() => effective(sourceTwo)).toThrow();
    await expect(installBundle(f.paths, second.bundle, rolled)).rejects.toThrow();
    expect(readlinkSync(f.paths.live)).toBe(sourceOne);
  },
);

posix.each(["19.0.0", "19.1.2"])(
  "bound OMP %s installs and rolls back to retained 18.20.0 without a stock fallback",
  async (version) => {
    const f = fixture();
    const prior = bundledRelease(f, "prior");
    const one = await installBundle(f.paths, prior.bundle, undefined);
    const next = bundledRelease(f, "next", undefined, version);
    const two = await installBundle(f.paths, next.bundle, one);
    expect(two.current.requirements.omp).toBe(version);
    const source = releasePath(f.paths, two.current);
    expect(readlinkSync(join(f.paths.dori, "bin/omp"))).toBe(join(source, "scripts/consumer/omp"));
    expect(resolveConsumerOmpCommand(["omp"], { home: f.paths.home, sourceRoot: source })[0]).toBe(
      join(source, "scripts/consumer/omp"),
    );
    const rolled = await rollbackRelease(f.paths, two);
    expect(rolled.current.requirements.omp).toBe("18.20.0");
    expect(readlinkSync(join(f.paths.dori, "bin/omp"))).toBe(
      join(releasePath(f.paths, one.current), "scripts/consumer/omp"),
    );
    expect(rolled.previous).toBeUndefined();
    expect(readFileSync(join(releasePath(f.paths, two.current), "native-omp.lock"), "utf8")).toContain(
      `"nativeVersion":"${version}"`,
    );
  },
);

posix.each(["20.0.0", "19.0.0-beta.1", "19.01.0", "19.0.0;echo injected"])(
  "unreviewed native runtime %s is rejected",
  (version) => {
    const f = fixture();
    const release = bundledRelease(f, "reviewed", undefined, "19.0.0").bundle.manifest;
    expect(() =>
      validateReleaseManifest({ ...release, requirements: { ...release.requirements, omp: version } }),
    ).toThrow("supported runtime");
  },
);

posix(
  "rollback to a genuine older archive keeps its no-lock protocol instead of requiring new source locks",
  async () => {
    const f = fixture();
    const old = await installBundle(f.paths, f.release("older").bundle, undefined);
    const next = bundledRelease(f, "newer");
    const state = await installBundle(f.paths, next.bundle, old);
    expect(existsSync(join(f.paths.dori, "bin/omp"))).toBe(true);
    const restored = await rollbackRelease(f.paths, state);
    expect(restored.current.requirements.omp).toBe("18.18.8");
    expect(existsSync(join(f.paths.dori, "bin/omp"))).toBe(false);
  },
);

const onReleaseHost = test.skipIf(
  !(
    (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "darwin" && process.arch === "arm64")
  ),
);

onReleaseHost.each(["manual", "automatic"] as const)(
  "%s consumer update no longer requires the old terminal tool, but rollback does",
  async (mode) => {
    const f = fixture(true);
    const old = bundledRelease(f, "terminal");
    const before = await installBundle(f.paths, old.bundle, undefined);
    const candidate = bundledRelease(f, "native", old.source, "18.20.0", true);
    const saved = readFileSync(f.paths.config);
    const runtime = process.platform === "darwin" ? "hc" : "herdr";
    expect(JSON.parse(saved.toString()).runtime).toBe(runtime);
    const tools = "/usr/bin:/bin";
    expect(Bun.which("hc", { PATH: tools })).toBeNull();
    expect(Bun.which("herdr", { PATH: tools })).toBeNull();
    const cli = (...args: string[]) =>
      Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../src/release/cli.ts"), ...args], {
        env: { ...process.env, PATH: tools, CATALY_RUNTIME: "" },
      });
    const check = cli("check", "--from", candidate.dist);
    expect(check.exitCode, check.stderr.toString()).toBe(0);
    if (mode === "manual") {
      const install = cli("install", "--from", candidate.dist);
      expect(install.exitCode, install.stderr.toString()).toBe(0);
    } else {
      const oldPath = process.env["PATH"];
      const previousRuntime = process.env["CATALY_RUNTIME"];
      process.env["PATH"] = tools;
      process.env["CATALY_RUNTIME"] = "";
      try {
        const stable = { ...candidate.bundle, manifest: { ...candidate.bundle.manifest, prerelease: false } };
        expect(await automaticUpdate(f.paths, { now: 10_000, acquire: async () => stable })).toBe(
          releasePath(f.paths, candidate.bundle.manifest),
        );
      } finally {
        if (oldPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = oldPath;
        if (previousRuntime === undefined) delete process.env["CATALY_RUNTIME"];
        else process.env["CATALY_RUNTIME"] = previousRuntime;
      }
    }
    const retained = readlinkSync(f.paths.live);
    expect(retained).toBe(releasePath(f.paths, candidate.bundle.manifest));
    const rollback = cli("rollback", "--version", before.current.tag);
    expect(rollback.exitCode).toBe(2);
    expect(rollback.stderr.toString()).toContain(`${runtime} is required`);
    const downgrade = cli("install", "--from", old.dist);
    expect(downgrade.exitCode).toBe(2);
    expect(downgrade.stderr.toString()).toContain("cannot downgrade");
    expect(readlinkSync(f.paths.live)).toBe(retained);
    expect(readFileSync(f.paths.config)).toEqual(saved);
  },
);

test("a managed process selects its prepared default but retains an explicit external ULW path", () => {
  const before = process.env["CATALY_OMP_ULW_PATH"];
  try {
    process.env["CATALY_OMP_ULW_PATH"] = "/prepared/omp-ulw/index.ts";
    expect(resolveProcessOmpUlwPath("", "/home/fixture")).toBe("/prepared/omp-ulw/index.ts");
    expect(resolveProcessOmpUlwPath(join("/home/fixture", ".dori", "omp-ulw", "index.ts"), "/home/fixture")).toBe(
      "/prepared/omp-ulw/index.ts",
    );
    expect(resolveProcessOmpUlwPath("/owner/custom-ulw/index.ts", "/home/fixture")).toBe("/owner/custom-ulw/index.ts");
  } finally {
    if (before === undefined) delete process.env["CATALY_OMP_ULW_PATH"];
    else process.env["CATALY_OMP_ULW_PATH"] = before;
  }
});
