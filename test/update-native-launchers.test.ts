import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpAgentCommand } from "../src/harness.ts";
import { loadUpdateConfig, nativeAgent } from "../src/update/load.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const load = (argv: readonly string[], engine?: "omp" | "external") => {
  const directory = mkdtempSync(join(tmpdir(), "dori-native-launchers-"));
  directories.push(directory);
  for (const name of ["candidate", "remote"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const agent = { argv: ["omp", "--model=anthropic/claude-opus-5-5", "{prompt}"], timeoutMs: 1000 };
  const path = join(directory, "update.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      target: "dori",
      runtime: "herdr",
      root: join(directory, "updates"),
      remote: join(directory, "remote"),
      ref: "refs/heads/main",
      baseUpstream: "a".repeat(40),
      localSource: join(directory, "candidate"),
      worker: { ...agent, name: "port", argv, ...(engine === undefined ? {} : { engine }) },
      reviewer: { ...agent, name: "review" },
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    }),
  );
  return loadUpdateConfig(path);
};
const MODEL = "--model=anthropic/claude-opus-5-5";
const PREFIX_REFUSED = 'set worker.engine to "external"';
const pkg = "/opt/native/source/packages/coding-agent/";

// Every launch form the change-before classifier (e829d3c) guarded: each must still refuse a resumed session, either
// through the native guard or as an unreadable prefix, unless the configuration explicitly opts out as external.
test.each([
  ["direct", ["omp"]],
  ["absolute", ["/opt/bin/omp"]],
  ["spaced path", ["/home/user/agent tools/omp"]],
  ["env assignment", ["env", "X=1", "omp"]],
  ["env -u", ["env", "-u", "FOO", "omp"]],
  ["env -i", ["env", "-i", "omp"]],
  ["env -S", ["env", "-S", "omp"]],
  ["env --", ["env", "--", "omp"]],
  ["env -C", ["env", "-C", "/repo", "omp"]],
  ["abbreviated env option", ["env", "--un", "FOO", "omp"]],
  ["nested env", ["env", "X=1", "env", "Y=2", "omp"]],
  ["env inside env options", ["env", "-i", "/usr/bin/env", "-u", "FOO", "A=1", "omp"]],
  ["bun run", ["bun", "run", "/x/omp"]],
  ["bun run with a separate cwd", ["bun", "run", "--cwd", "/repo", "/x/omp"]],
  ["bun run with an attached cwd", ["bun", "run", "--cwd=/repo", "/x/omp"]],
  ["bunx", ["bunx", "--no-install", "--package", "@oh-my-pi/pi-coding-agent", "omp"]],
  ["npx", ["npx", "--no-install", "--package", "@oh-my-pi/pi-coding-agent", "omp"]],
  ["bun x", ["bun", "x", "omp"]],
  ["npx -c naming OMP", ["npx", "-c", "omp --mode json"]],
  ["the source launcher", ["bun", "--preload", `${pkg}scripts/omp.ts`, `${pkg}scripts/../src/cli.ts`]],
  ["node published CLI", ["node", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"]],
  ["bun published CLI", ["bun", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"]],
  ["sh -c exec omp", ["sh", "-c", 'exec omp "$@"', "audit"]],
  ["sh -c exec /path/omp", ["sh", "-c", 'exec /opt/bin/omp "$@"', "audit"]],
  ["sh -c with OMP as $0", ["sh", "-c", 'exec "$0" "$@"', "omp"]],
  ["sh -cl exec omp", ["sh", "-cl", 'exec omp "$@"', "audit"]],
  ["sh -c with a quoted OMP path", ["sh", "-c", 'exec "$HOME/bin/omp" "$@"', "audit"]],
  ["the side wrapper", ["omp-dori", "omp"]],
  ["the side wrapper by path", ["/home/user/.omp-dori/bin/omp-dori", "omp"]],
  ["the installed wrapper", ["/home/user/.dori/bin/omp"]],
  ["node --require separate", ["node", "--require", "/hook.js", "/x/omp"]],
  ["node --require attached", ["node", "--require=/hook.js", "/x/omp"]],
  ["timeout", ["timeout", "-k", "5", "600", "/opt/bin/omp"]],
  ["timeout with an abbreviated option", ["timeout", "--kill", "5", "600", "/opt/bin/omp"]],
  ["timeout with a short cluster", ["timeout", "-vk", "5", "600", "/opt/bin/omp"]],
  ["caffeinate with an attached value", ["caffeinate", "-it600", "omp"]],
  ["npx --call= naming OMP", ["npx", "--call=omp --mode json"]],
  ["nice and nohup", ["nice", "-n", "5", "nohup", "omp"]],
  ["caffeinate", ["caffeinate", "-i", "-t", "3600", "omp"]],
  ["setsid", ["setsid", "-w", "omp"]],
  ["stdbuf", ["stdbuf", "-oL", "omp"]],
])("%s keeps OMP from resuming a session", (_, prefix) => {
  const argv = [...prefix, MODEL, "--resume", "s", "{prompt}"];
  for (const engine of [undefined, "omp"] as const) {
    expect(() => load(argv, engine)).toThrow(/without session resume|cannot read/);
  }
  const external = load(argv, "external").worker;
  expect(nativeAgent(external)).toBe(false);
});

test.each([
  ["nested env", ["env", "X=1", "env", "Y=2", "omp"]],
  ["bunx", ["bunx", "--package", "@oh-my-pi/pi-coding-agent", "omp"]],
  ["npx", ["npx", "--yes", "omp"]],
  ["the side wrapper", ["omp-dori", "omp"]],
  ["timeout", ["timeout", "600", "omp"]],
])("%s is native OMP: it keeps the capability guard and its own arguments", (_, prefix) => {
  for (const flag of ["-e", "--profile", "--dori-role"]) {
    expect(() => load([...prefix, MODEL, flag, "untrusted", "{prompt}"])).toThrow("controller-owned");
  }
  expect(nativeAgent(load([...prefix, MODEL, "{prompt}"]).worker)).toBe(true);
});

test.each([
  ["a shell script naming OMP", ["sh", "-c", 'exec omp "$@"', "audit"]],
  ["npx -c naming OMP", ["npx", "-c", "omp --mode json"]],
  ["timeout with an unknown separate option value", ["timeout", "--frobnicate", "5", "600", "omp"]],
  ["an external wrapper behind a launcher", ["nohup", "/opt/wrapper", "/x/omp"]],
])("%s is refused as unreadable even when it declares engine omp", (_, prefix) => {
  for (const engine of [undefined, "omp"] as const) {
    expect(() => load([...prefix, MODEL, "{prompt}"], engine)).toThrow(PREFIX_REFUSED);
  }
});

// External commands that do not run OMP keep their own contract, as do wrappers whose arguments merely mention it.
test.each([
  ["a launcher running another agent", ["timeout", "600", "codex"]],
  ["a shell running another agent", ["sh", "-c", "exec codex", "sh"]],
  ["a shell passing another agent a quoted omp value", ["sh", "-c", "exec codex -c 'x=\"omp\"' \"$@\"", "sh"]],
  ["npx -c running another agent", ["npx", "-c", "codex"]],
  ["an external script", ["node", "/opt/not-omp.js", "/x/omp"]],
  ["echo", ["echo", "omp"]],
  ["the side wrapper's other commands", ["omp-dori", "hc", "run", "--", "omp"]],
  ["bunx whose cwd value names omp", ["bunx", "--cwd", "/tmp/omp", "--no-install", "echo"]],
  ["npx whose cache value names omp", ["npx", "--offline", "--cache", "/tmp/omp", "--", "/bin/echo"]],
])("%s stays external", (_, prefix) => {
  const argv = [...prefix, MODEL, "--resume", "s", "{prompt}"];
  expect(nativeAgent(load(argv).worker)).toBe(false);
  // The harness gives the OMP role only to OMP: an option value that names omp does not make the command OMP.
  expect(isOmpAgentCommand(prefix.join(" "))).toBe(false);
});
