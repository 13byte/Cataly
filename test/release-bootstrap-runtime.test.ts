import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { darwin, fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang tool stubs.
const posix = test.skipIf(process.platform === "win32");

posix.each(['{"runtime":"herdr"}', '{"runtime":"hc"}', '{"sessionRuntime":"hc"}', '{"sessionRuntime":"herdr"}'])(
  "a preserved legacy runtime config %s stops with the upgrade instructions and is never rewritten",
  (preserved) => {
    const f = fixture(linux);
    const home = join(f.home, ".cataly"),
      config = join(home, "config.json");
    mkdirSync(home);
    writeFileSync(config, preserved);
    const result = f.run();
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("This Cataly home still uses the herdr/hc terminal runtime, which this version removed.");
    expect(stderr).toContain(`2. Remove "runtime" (if it names herdr or hc) and "sessionRuntime" from ${config}.`);
    expect(stderr).not.toContain("Retire the historical roles");
    expect(readFileSync(config, "utf8")).toBe(preserved);
    expect(existsSync(f.result)).toBe(false);
  },
);

posix("a headless config without runtime keys installs and keeps its bytes", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly"),
    config = join(home, "config.json");
  mkdirSync(home);
  const preserved = '{"sessionRuntime":"headless","ownerValue":"keep"}\n';
  writeFileSync(config, preserved);
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
  expect(readFileSync(config, "utf8")).toBe(preserved);
});

posix("a Tern config installs headless and keeps its bytes", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly"),
    config = join(home, "config.json");
  mkdirSync(home);
  const preserved = '{"runtime":"tern","sessionRuntime":"tern","laneRuntime":"terminal"}\n';
  writeFileSync(config, preserved);
  writeFileSync(join(home, "roles.json"), '{"lead":"tern:7"}\n');
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
  expect(readFileSync(config, "utf8")).toBe(preserved);
});

posix.each([
  [linux, "18.20.0"],
  [darwin, "18.20.0"],
  [linux, "19.0.1"],
  [darwin, "19.0.1"],
] as const)("headless bootstrap installs %j with OMP %s", (profile, version) => {
  const f = fixture(profile);
  f.assets({ version: 1, profiles: [linux, darwin] }, version);
  const home = join(f.home, ".omp-cataly");
  const result = f.run(["--home", home]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
});

posix("bootstrap permits an OMP 18-to-19 upgrade but holds a pre-19 install over a 19 receipt", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly");
  const releases = join(home, "releases");
  mkdirSync(releases, { recursive: true });
  const receipt = join(releases, "consumer-installed.json");
  const state = (omp: string) => JSON.stringify({ current: { requirements: { omp } } });
  const headless = { version: 1, profiles: [linux] };
  writeFileSync(receipt, state("18.20.0"));
  f.assets(headless, "19.0.1");
  const upgraded = f.run(["--home", home]);
  expect(upgraded.exitCode, upgraded.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
  const selected = state("19.0.1");
  writeFileSync(receipt, selected);
  f.assets(headless, "18.20.0");
  const held = f.run(["--home", home]);
  expect(held.exitCode).not.toBe(0);
  expect(held.stderr.toString()).toContain("cannot downgrade");
  expect(readFileSync(receipt, "utf8")).toBe(selected);
});

posix.each(["18.18.8", "19.0.1-rc.1", "20.0.0"])("headless bootstrap refuses unsupported OMP %s", (version) => {
  const f = fixture(linux);
  f.assets({ version: 1, profiles: [linux] }, version);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("has no bound headless profile");
  expect(existsSync(f.result)).toBe(false);
});

posix("historical terminal roles stop installation with the retirement step", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly");
  mkdirSync(home);
  const roles = join(home, "roles.json");
  const original = '{"lead":"w1:p1"}\n';
  writeFileSync(roles, original);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "Retire the historical roles with your previous Cataly version (cataly update --retire-legacy-roles).",
  );
  expect(readFileSync(roles, "utf8")).toBe(original);
  expect(existsSync(f.result)).toBe(false);
});

posix("native harness roles are not historical", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly");
  mkdirSync(home);
  writeFileSync(join(home, "roles.json"), '{"lead":"headless:lead-1"}\n');
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
