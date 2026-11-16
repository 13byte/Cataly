import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { replacePointer, saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { prerequisites } from "../src/release/provision.ts";
import { resolveConsumerOmpCommand, resolveConsumerOmpUlwPath } from "../src/release/runtime.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { recoverInstalled, releasePath } from "../src/release/state.ts";
import { fixture } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// These real Git/receipt fixtures exercise source admission, not a loadable native addon or provider session.
test("isolated source releases need no stock OMP and bind both native and ULW defaults to the loaded release", async () => {
  const f = fixture(true);
  const first = boundRelease(f, "first");
  const tools = join(f.root, "bound-tools");
  mkdirSync(tools, { mode: 0o700 });
  const git = Bun.which("git");
  if (!git) throw new Error("The Git fixture prerequisite is unavailable");
  symlinkSync(git, join(tools, "git"));
  const runtime = process.platform === "darwin" ? "hc" : "herdr";
  writeFileSync(join(tools, runtime), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env["PATH"] = tools;
  expect(Bun.which("omp", { PATH: tools })).toBeNull();
  prerequisites(runtime, true, false, f.paths);

  const one = await installBundle(f.paths, first.bundle, undefined);
  const sourceOne = releasePath(f.paths, one.current);
  const config = readFileSync(f.paths.config);
  const receipt = join(f.paths.manifests, `${basename(sourceOne)}.json`);
  const metadata = readFileSync(receipt);
  saveJson(receipt, { ...one.current, requirements: { ...one.current.requirements, omp: "18.18.8" } });
  const inconsistent = Bun.spawnSync(["/bin/bash", join(f.paths.dori, "bin/omp"), "--version"], {
    env: { HOME: f.paths.home, PATH: tools },
  });
  expect(inconsistent.exitCode).not.toBe(0);
  expect(inconsistent.stderr.toString()).toContain("Unsupported or inconsistent consumer native protocol");
  expect(inconsistent.stdout.toString()).toBe("");
  writeFileSync(receipt, metadata);
  expect(JSON.parse(config.toString()).agentCommand[0]).toBe(join(f.paths.dori, "bin/omp"));
  expect(lstatSync(join(f.paths.dori, "bin/omp")).isSymbolicLink()).toBe(false);
  const command = (sourceRoot: string) =>
    resolveConsumerOmpCommand([join(f.paths.dori, "bin/omp"), "{prompt}"], { home: f.paths.home, sourceRoot });
  expect(command(sourceOne)).toEqual([
    join(sourceOne, "scripts/consumer/omp"),
    "--no-extensions",
    "-e",
    join(sourceOne, "extension"),
    "--config",
    join(f.paths.dori, "omp.yml"),
    "--config",
    join(f.paths.root, "consumer-discovery", basename(sourceOne), "omp.yml"),
    "{prompt}",
  ]);
  const dependency = (sourceRoot: string) =>
    join(
      f.paths.dependencies,
      `omp-ulw-${readSourceBundle(sourceRoot).lock.commit}-${readSourceBundle(sourceRoot).identity}`,
      "index.ts",
    );
  const effective = (sourceRoot: string) =>
    resolveConsumerOmpUlwPath("", { home: f.paths.home, sourceRoot, useDefault: true });
  expect(effective(sourceOne)).toBe(dependency(sourceOne));
  expect(readFileSync(effective(sourceOne), "utf8")).toContain('selected = "first"');

  const second = boundRelease(f, "second", first.source);
  const two = await installBundle(f.paths, second.bundle, one);
  const sourceTwo = releasePath(f.paths, two.current);
  expect(command(sourceOne)[0]).toBe(join(sourceOne, "scripts/consumer/omp"));
  expect(command(sourceTwo)[0]).toBe(join(sourceTwo, "scripts/consumer/omp"));
  expect(effective(sourceTwo)).toBe(dependency(sourceTwo));
  expect(readFileSync(effective(sourceTwo), "utf8")).toContain('selected = "second"');
  expect(resolveConsumerOmpCommand(["/owner/custom-omp"], { home: f.paths.home, sourceRoot: sourceTwo })).toEqual([
    "/owner/custom-omp",
  ]);
  expect(resolveConsumerOmpUlwPath("/owner/custom-ulw/index.ts", { home: f.paths.home, sourceRoot: sourceTwo })).toBe(
    "/owner/custom-ulw/index.ts",
  );
  expect(await installBundle(f.paths, second.bundle, two)).toEqual(two);
  expect(readFileSync(f.paths.config)).toEqual(config);

  replacePointer(f.paths.live, sourceTwo, sourceOne);
  saveJson(f.paths.state, one);
  saveJson(f.paths.journal, { version: 1, before: one, after: two });
  expect(recoverInstalled(f.paths)).toEqual(one);
  expect(readlinkSync(f.paths.live)).toBe(sourceOne);
  const reactivated = await installBundle(f.paths, second.bundle, one);
  const rolled = await rollbackRelease(f.paths, reactivated);
  expect(rolled.current).toEqual(one.current);
  expect(effective(sourceOne)).toBe(dependency(sourceOne));
  expect(readFileSync(f.paths.config)).toEqual(config);

  writeFileSync(effective(sourceTwo), "owner change\n");
  expect(() => effective(sourceTwo)).toThrow();
  await expect(installBundle(f.paths, second.bundle, rolled)).rejects.toThrow();
  expect(readlinkSync(f.paths.live)).toBe(sourceOne);
  expect(readFileSync(f.paths.config)).toEqual(config);
});

test("isolated rollback retains the independent-native protocol without replacing its owned wrapper with a symlink", async () => {
  const f = fixture(true);
  const legacy = await installBundle(f.paths, f.release("independent").bundle, undefined);
  const config = readFileSync(f.paths.config);
  const bound = boundRelease(f, "bound");
  const current = await installBundle(f.paths, bound.bundle, legacy);
  expect(lstatSync(join(f.paths.dori, "bin/omp")).isSymbolicLink()).toBe(false);
  const rolled = await rollbackRelease(f.paths, current);
  expect(rolled.current).toEqual(legacy.current);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, legacy.current));
  expect(lstatSync(join(f.paths.dori, "bin/omp")).isSymbolicLink()).toBe(false);
  expect(recoverInstalled(f.paths)).toEqual(rolled);
  expect(readFileSync(f.paths.config)).toEqual(config);
});
