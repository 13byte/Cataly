import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

function consumer(side: boolean, platform: string, arch: string) {
  const f = fixture(true);
  const home = join(f.paths.home, side ? ".omp-dori" : ".dori");
  mkdirSync(home, { recursive: true });
  const config = join(home, "config.json");
  const env = { HOME: f.paths.home, PATH: process.env["PATH"] ?? "", CATALY_HOME: home, CATALY_CONFIG: config };
  const host = `Object.defineProperty(process, "platform", {value:${JSON.stringify(platform)}});
Object.defineProperty(process, "arch", {value:${JSON.stringify(arch)}});`;
  const cli = (argv: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `${host}
const { runConsumerUpdate } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/cli.ts"))});
process.exit(await runConsumerUpdate(${JSON.stringify(argv)}));`,
      ],
      { env },
    );
  const unchanged = () => {
    expect(existsSync(join(home, "src"))).toBe(false);
    expect(existsSync(join(home, "releases/consumer-installed.json"))).toBe(false);
  };
  return { f, home, config, cli, unchanged };
}

posix.each([
  ["linux/x64 primary", { platform: "linux", arch: "x64", side: false }],
  ["linux/x64 side", { platform: "linux", arch: "x64", side: true }],
  ["darwin/arm64 primary", { platform: "darwin", arch: "arm64", side: false }],
  ["darwin/arm64 side", { platform: "darwin", arch: "arm64", side: true }],
] as const)("%s refuses a historical terminal-only release target", (_, { platform, arch, side }) => {
  const c = consumer(side, platform, arch);
  const preserved = JSON.stringify({ defaultModel: "owner/model", ownerValue: "unchanged" });
  writeFileSync(c.config, preserved);
  const release = c.f.release("historical profile\n");
  for (const command of ["check", "install"]) {
    const result = c.cli([command, "--home", c.home, "--from", release.dist]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(`does not support ${platform}/${arch}/headless`);
    expect(readFileSync(c.config, "utf8")).toBe(preserved);
    c.unchanged();
  }
});

posix.each([{ runtime: "herdr" }, { runtime: "hc" }, { sessionRuntime: "herdr" }, { sessionRuntime: "hc" }])(
  "a preserved legacy selection %j stops check, install and rollback with upgrade instructions",
  (selection) => {
    const c = consumer(false, "linux", "x64");
    const preserved = JSON.stringify({ defaultModel: "owner/model", ...selection });
    writeFileSync(c.config, preserved);
    const release = c.f.release("legacy config\n");
    for (const argv of [["check", "--from", release.dist], ["install", "--from", release.dist], ["rollback"]]) {
      const result = c.cli([...argv, "--home", c.home]);
      expect(result.exitCode).toBe(2);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("This Cataly home still uses the herdr/hc terminal runtime");
      expect(stderr).toContain(`Remove "runtime" (if it names herdr or hc) and "sessionRuntime" from ${c.config}.`);
      expect(readFileSync(c.config, "utf8")).toBe(preserved);
      c.unchanged();
    }
  },
);

posix("the removed legacy release flags are rejected", () => {
  const c = consumer(false, "linux", "x64");
  for (const argv of [
    ["install", "--runtime", "herdr"],
    ["retire-legacy-roles", "--home", c.home],
    ["install", "--legacy-session", "default"],
  ]) {
    const result = c.cli(argv);
    expect(result.exitCode).toBe(2);
    c.unchanged();
  }
});
