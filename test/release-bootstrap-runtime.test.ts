import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { darwin, fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang runtime stubs.
const posix = test.skipIf(process.platform === "win32");

posix.each(["{}", '{"runtime":"hc"}'])(
  "legacy bootstrap holds unbound or conflicting preserved runtime %s before its old CLI can activate",
  (preserved) => {
    const f = fixture(linux);
    f.assets();
    const home = join(f.home, ".dori"),
      config = join(home, "config.json");
    mkdirSync(home);
    writeFileSync(config, preserved);
    const choice = () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
const {loadConfig} = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/config.ts"))});
const {runtimeChoice} = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/run.ts"))});
console.log(JSON.stringify(runtimeChoice(await loadConfig(), process.env)));`,
        ],
        {
          env: { HOME: f.home, DORI_HOME: home, DORI_CONFIG: config, PATH: join(f.root, "bin") },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(choice()).toEqual({ kind: "headless", source: "default" });
    const held = f.run(["--runtime", "herdr"]);
    expect(held.exitCode).not.toBe(0);
    expect(held.stderr.toString()).toContain(
      preserved === "{}"
        ? "Preserved config must explicitly select runtime"
        : "conflicts with preserved config runtime",
    );
    expect(readFileSync(config, "utf8")).toBe(preserved);
    expect(existsSync(f.result)).toBe(false);
    expect(existsSync(join(home, "legacy-installed"))).toBe(false);
    const selected = '{"runtime":"herdr","ownerValue":"preserved"}';
    writeFileSync(config, selected);
    const installed = f.run(["--runtime", "herdr"]);
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    expect(choice()).toEqual({ kind: "headless", source: "default" });
    expect(readFileSync(config, "utf8")).toBe(selected);
  },
);

posix.each([
  [linux, ".dori"],
  [darwin, ".omp-dori"],
] as const)("headless bootstrap accepts historical config without either executable: %j", (profile, folder) => {
  const f = fixture(profile);
  f.assets(
    { version: 1, profiles: [linux, darwin] },
    { version: 1, profiles: [linux, darwin].map((host) => ({ ...host, runtime: "headless" })) },
  );
  const home = join(f.home, folder);
  mkdirSync(home);
  const config = join(home, "config.json");
  const old = `{"runtime":"${profile.runtime}","ownerValue":"keep"}\n`;
  writeFileSync(config, old);
  const bin = join(f.root, "bin");
  for (const tool of ["hc", "herdr"]) renameSync(join(bin, tool), join(f.root, tool));
  const fresh = f.run([], { PATH: `${bin}:/usr/bin:/bin` });
  expect(fresh.exitCode, fresh.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(join(f.home, folder === ".dori" ? ".cataly" : ".omp-cataly"), "headless"));
  const result = f.run(["--home", home], { PATH: `${bin}:/usr/bin:/bin` });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home, "headless"));
  expect(readFileSync(config, "utf8")).toBe(old);
  const explicit = f.run(["--runtime", profile.runtime], { PATH: `${bin}:/usr/bin:/bin` });
  expect(explicit.exitCode).not.toBe(0);
  expect(explicit.stderr.toString()).toContain(`${profile.runtime} is required`);
});

posix("bootstrap retirement dispatches the verified new CLI without installation or terminal prerequisites", () => {
  const f = fixture(linux);
  const home = join(f.home, ".dori");
  const args = [
    "--retire-legacy-roles",
    "--home",
    home,
    "--legacy-session",
    "original",
    "--legacy-migrated-session",
    "migration",
  ];
  const old = f.run(args);
  expect(old.exitCode).not.toBe(0);
  expect(old.stderr.toString()).toContain("requires the new verified release");
  expect(existsSync(f.result)).toBe(false);
  f.assets({ version: 1, profiles: [linux] }, { version: 1, profiles: [{ ...linux, runtime: "headless" }] });
  const bin = join(f.root, "bin");
  for (const tool of ["hc", "herdr"]) renameSync(join(bin, tool), join(f.root, tool));
  const historicalState = join(home, "historical-state");
  const retirement = f.run(args, { PATH: `${bin}:/usr/bin:/bin`, DORI_STATE_DIR: historicalState });
  expect(retirement.exitCode, retirement.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual({
    command: "retire-legacy-roles",
    home,
    "legacy-session": "original",
    "legacy-migrated-session": "migration",
    historicalState,
  });
  expect(existsSync(home)).toBe(false);
});

posix("ordinary bootstrap does not hand a home with historical roles to an old updater", () => {
  const f = fixture(linux);
  f.assets();
  const home = join(f.home, ".dori");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), '{"runtime":"herdr"}\n');
  const roles = join(home, "roles.json");
  const original = '{"lead":"w1:p1"}\n';
  writeFileSync(roles, original);
  const result = f.run(["--home", home, "--runtime", "herdr"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("--retire-legacy-roles");
  expect(readFileSync(roles, "utf8")).toBe(original);
  expect(existsSync(join(home, "legacy-installed"))).toBe(false);
});
