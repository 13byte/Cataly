import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeHealth } from "../src/update/deployment-monitor-receipts.ts";
import { managedOmpCommand } from "../src/update/deployment-process.ts";
import type { ToolchainReceipt } from "../src/update/deployment-types.ts";
import { assertSourceAdmission } from "../src/update/source.ts";
import type { SourceManifest } from "../src/update/types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const procedure =
  "was written by an earlier Cataly; stop the harness (cataly harness stop), deploy, then cataly harness up " +
  "(see docs/releases.md#managed-deployments-across-the-legacy-removal)";

test("a lead health file from an earlier Cataly names the one-time manual move", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cataly-earlier-health-"));
  roots.push(stateDir);
  const pane = "headless:lead";
  mkdirSync(join(stateDir, "runtime"));
  const now = new Date().toISOString();
  writeFileSync(
    join(stateDir, "runtime", `${encodeURIComponent(pane)}.json`),
    JSON.stringify({
      version: 1,
      monitors: [],
      paneId: pane,
      sessionId: "session",
      role: "cataly",
      presetLoaded: true,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
    }),
    { mode: 0o600 },
  );
  expect(() => readRuntimeHealth({ stateDir, pane, sessionId: "session" })).toThrow(
    `runtime health schema differs; the health file ${procedure}`,
  );
});

test("a toolchain receipt from an earlier Cataly names the one-time manual move", () => {
  const earlier = { omp: "/omp", nativeConfig: "/omp.yml" } as unknown as ToolchainReceipt;
  expect(() => managedOmpCommand(earlier, "/source")).toThrow(
    `managed extension source differs from its prepared toolchain; its receipt ${procedure}`,
  );
});

test("a leftover ref directory holds local admission and says to delete it", () => {
  const manifest = { excluded: ["ref"] } as unknown as SourceManifest;
  expect(() => assertSourceAdmission(manifest, "local")).toThrow(
    "local source admission held: ref; delete the leftover ref/ directory (the former omp-ulw fixture)",
  );
});
