import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpdateConfig, nativeAgent } from "../src/update/load.ts";
import { runCommand } from "../src/update/process.ts";
import type { UpdateJob } from "../src/update/types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A launcher's own options (`stdbuf -e L`) are not OMP's: the native launch checks only the OMP argv after it.
test.each([
  ["stdbuf with a separate -e value", (omp: string) => ["/usr/bin/stdbuf", "-e", "L", omp]],
  ["env unsetting a flag-shaped name", (omp: string) => ["/usr/bin/env", "-u", "--profile", omp]],
])("%s starts native OMP with the controller's options", async (_, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), "dori-native-prefix-"));
  directories.push(dir);
  for (const name of ["candidate", "remote", "bin"]) mkdirSync(join(dir, name));
  const omp = join(dir, "bin", "omp");
  writeFileSync(omp, '#!/bin/sh\nprintf "ARG=%s\\n" "$@"\n', { mode: 0o755 });
  const model = "--model=anthropic/claude-opus-5-5";
  const agent = { argv: [omp, model, "{prompt}"], timeoutMs: 2000 };
  const path = join(dir, "update.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      target: "dori",
      runtime: "herdr",
      root: join(dir, "updates"),
      remote: join(dir, "remote"),
      ref: "refs/heads/main",
      baseUpstream: "a".repeat(40),
      localSource: join(dir, "candidate"),
      worker: { ...agent, name: "worker", argv: [...prefix(omp), model, "{prompt}"] },
      reviewer: { ...agent, name: "reviewer" },
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    }),
  );
  const config = loadUpdateConfig(path);
  expect(nativeAgent(config.worker)).toBe(true);
  const at = new Date().toISOString();
  const directory = mkdtempSync(join(dir, "job-"));
  const job = {
    version: 1,
    id: "a".repeat(64),
    upstream: config.baseUpstream,
    baseUpstream: config.baseUpstream,
    configHash: "b".repeat(64),
    createdAt: at,
    updatedAt: at,
    phase: "verifying",
    candidate: join(dir, "candidate"),
    directory,
    sourceHash: "c".repeat(64),
    commands: [],
    history: [],
  } as unknown as UpdateJob;
  try {
    // The fixture prints its arguments, not OMP's JSON stream, so the run ends without a final message once started.
    await expect(
      runCommand(
        { config, configHash: job.configHash, emit: () => {} },
        job,
        config.worker,
        { prompt: "probe" },
        "model",
      ),
    ).rejects.toThrow("no successfully completed final assistant message");
  } finally {
    // The isolated runtime owns a short socket alias outside the job directory.
    const runtime = JSON.parse(readFileSync(join(directory, "runtime", "000", "runtime-paths.json"), "utf8"));
    unlinkSync(runtime.alias);
  }
  const stdout = readFileSync(job.commands[0]!.stdout, "utf8");
  expect(stdout).toContain("ARG=--no-extensions");
  expect(stdout).toContain("ARG=--system-prompt");
});
