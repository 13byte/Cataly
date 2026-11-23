import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { consumerPaths, initialize, saveJson } from "../src/release/files.ts";
import { installBundle, preflightInstallation } from "../src/release/install.ts";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

test.each([".dori/nested", ".", ".dori/.."])("consumer side home %s cannot overlap primary ownership", (target) => {
  expect(() => consumerPaths("/sandbox/home", join("/sandbox/home", target))).toThrow("primary");
});

posix("a historical custom home recovers references interrupted before publishing any wrapper", async () => {
  const f = fixture(true);
  const location = join(f.paths.home, "custom side");
  const custom = consumerPaths(f.paths.home, location);
  initialize(custom);
  const dependency = join(custom.dependencies, basename(f.ownedDependency));
  renameSync(f.ownedDependency, dependency);
  renameSync(`${f.ownedDependency}.json`, `${dependency}.json`);

  // The historical updater always used its legacy inventory, regardless of the custom directory's name.
  const bundle = f.release("first\n").bundle;
  const historical = { ...custom, layout: "legacy" } as const;
  const before = await installBundle(historical, bundle, undefined);
  const receipt = join(custom.root, "consumer-references.json");
  const pending = join(custom.root, "consumer-references-pending.json");
  const recorded = JSON.parse(readFileSync(receipt, "utf8"));
  const references = Object.fromEntries(
    Object.keys(recorded).map((path) => [
      path,
      { bytes: readFileSync(join(location, path), "utf8"), executable: path.startsWith("bin/") },
    ]),
  );
  for (const path of Object.keys(references)) unlinkSync(join(location, path));
  expect(consumerPaths(f.paths.home, location).layout).toBe("legacy");
  unlinkSync(receipt);
  unlinkSync(custom.live);
  unlinkSync(custom.state);
  saveJson(pending, { before: {}, references });
  const recoveredPaths = consumerPaths(f.paths.home, location);
  const after = await installBundle(recoveredPaths, bundle, undefined);
  expect(after).toEqual(before);
  expect(existsSync(pending)).toBe(false);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(recorded);
  expect(existsSync(join(location, "bin/dori"))).toBe(true);
});

posix("a custom side home holds when receipt inventories disagree", () => {
  const f = fixture();
  const location = join(f.paths.home, "ambiguous side");
  const paths = consumerPaths(f.paths.home, location);
  initialize(paths);
  const digest = "a".repeat(64);
  saveJson(join(paths.root, "consumer-references.json"), {
    "bin/cataly": digest,
    "bin/cataly-harness": digest,
    "bin/omp": digest,
    "bin/omp-cataly": digest,
    "omp.yml": digest,
  });
  saveJson(join(paths.root, "consumer-references-pending.json"), {
    before: {},
    references: Object.fromEntries(
      ["bin/dori", "bin/dori-harness", "bin/omp", "bin/omp-dori", "omp.yml"].map((path) => [
        path,
        { bytes: "pending reference\n", executable: path.startsWith("bin/") },
      ]),
    ),
  });
  expect(() => consumerPaths(f.paths.home, location)).toThrow("Invalid consumer reference receipt");
});

posix("an unreceipted historical command holds rather than being mistaken for an owned side layout", () => {
  const f = fixture();
  const location = join(f.paths.home, "ambiguous side");
  const paths = consumerPaths(f.paths.home, location);
  initialize(paths);
  mkdirSync(join(location, "bin"));
  const historical = join(location, "bin/dori");
  writeFileSync(historical, "owner command\n");
  expect(() => preflightInstallation(paths)).toThrow("Ambiguous consumer command layout");
  expect(readFileSync(historical, "utf8")).toBe("owner command\n");
  expect(existsSync(join(location, "bin/cataly"))).toBe(false);
});
