import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpdateConfig } from "../src/update/load.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Native OMP admission applies to argv that starts OMP, including the Linux source launcher's Bun command; an
// external wrapper that only runs OMP later keeps its own contract.
const load = (argv: readonly string[]) => {
  const directory = mkdtempSync(join(tmpdir(), "dori-native-source-"));
  directories.push(directory);
  for (const name of ["candidate", "remote", "model-client"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const agent = (name: string) => ({
    name,
    argv: ["omp", "--model", "anthropic/claude-opus-5-5", "-p", "{prompt}"],
    timeoutMs: 1000,
  });
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
      worker: { ...agent("port"), argv },
      reviewer: agent("review"),
      provision: [],
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
      modelAgentDir: join(directory, "model-client"),
    }),
  );
  return loadUpdateConfig(path);
};

test("the Linux source launcher argv is admitted as native OMP, not as an external wrapper", () => {
  const pkg = "/opt/agent tools/packages/coding-agent/";
  const source = ["bun", "--preload", `${pkg}scripts/omp.ts`, `${pkg}scripts/../src/cli.ts`];
  expect(() => load([...source, "--resume", "session", "{prompt}"])).toThrow();
  expect(() => load(["sh", "-c", 'exec "$0" "$@"', "omp", "--resume", "session", "{prompt}"])).not.toThrow();
});
