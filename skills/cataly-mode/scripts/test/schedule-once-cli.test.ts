import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cataly-schedule-once-cli-"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ runtime: "herdr", stateDir: join(dir, "state") }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function invoke(...args: string[]) {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", cli, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      PATH: process.env["PATH"],
      CATALY_CONFIG: join(dir, "config.json"),
      CATALY_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}

test("public CLI preserves offset instant, claims once and reports no next occurrence", () => {
  const future = new Date(Date.now() + 3_600_000 + 9 * 3_600_000).toISOString().replace("Z", "+09:00");
  const added = invoke(
    "schedule",
    "add",
    "once",
    "--at",
    future,
    "--deliver",
    "log",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').appendFileSync('runs', 'x')",
  );
  expect(added.code).toBe(0);
  const job = JSON.parse(added.out);
  expect(job.at).toBe(Date.parse(future));
  expect(job.cron).toBeUndefined();
  const path = join(dir, "state/schedule.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  // Controlled durable-clock fixture; command execution and scheduler CLI are real.
  document.jobs[0].at = document.jobs[0].nextAt = Date.now() - 1000;
  writeFileSync(path, JSON.stringify(document));
  expect(invoke("scheduler", "--loop", "0")).toEqual({ code: 0, out: "", err: "" });
  const listed = JSON.parse(invoke("schedule", "list").out).jobs[0];
  expect(listed).toMatchObject({ paused: true, next: null, last: { status: "exited", code: 0, delivery: "logged" } });
  expect(invoke("scheduler", "--loop", "0").code).toBe(0);
  expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
  expect(invoke("schedule", "resume", "once").err).toContain("consumed");
});

test.each(
  [
    ["--at", "2099-01-01T00:00:00"],
    ["--at", "2000-01-01T00:00:00Z"],
    ["--at", "2099-02-30T00:00:00Z"],
    ["--at", "2099-01-01T00:00:00Z", "--cron", "* * * * *", "--tz", "UTC"],
    ["--at", "2099-01-01T00:00:00Z", "--tz", "UTC"],
  ].map((flags) => ({ flags })),
)("public CLI refuses ambiguous, stale or conflicting one-shot arguments: %j", ({ flags }) => {
  const result = invoke("schedule", "add", "bad", ...flags, "--", "false");
  expect(result.code).toBe(1);
  expect(JSON.parse(invoke("schedule", "list").out).jobs).toEqual([]);
});

test("missing trigger names both supported alternatives", () => {
  expect(invoke("schedule", "add", "bad", "--", "false").err).toContain("--at ISO_INSTANT or --cron");
});
