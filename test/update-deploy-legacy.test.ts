import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LegacyRuntimeError } from "../src/runtime/registry.ts";
import { deployRelease, parseDeploymentConfig, restartDeployment } from "../src/update/deployment.ts";
import { ownReleaseRoot, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { readRestartIntent, saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { sourceRecoveryPending } from "../src/update/source-update-state.ts";
import { fixture } from "./update-deploy-setup.ts";

test("a terminal-era deployment config is refused by the upgrade guard", () => {
  const { root, config } = fixture();
  expect(() =>
    parseDeploymentConfig({ ...config, runtime: "herdr", herdr: "/bin/herdr", pane: "w1:p1" }, root),
  ).toThrow(LegacyRuntimeError);
  expect(() => parseDeploymentConfig({ ...config, hc: "/bin/hc", pane: "t7" }, root)).toThrow(LegacyRuntimeError);
});

test("a terminal-era in-flight journal is held as written: never resumed, rolled back or restarted", async () => {
  const { root, config } = fixture();
  ownReleaseRoot(config);
  const input = {
    remote: root,
    candidate: config.liveSource,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    publicManifest: { version: 1 as const, files: [], excluded: [], hash: "d".repeat(64) },
  };
  const id = crypto.randomUUID();
  const paneRuntime = {
    pid: process.pid,
    startTicks: "1",
    bootId: "boot",
    executable: process.execPath,
    pane: "w1:p1",
    role: "cataly",
    sessionId: "terminal-session",
    sessionFile: join(root, "terminal-session.jsonl"),
    startedAt: new Date().toISOString(),
    cwd: root,
  };
  const record = {
    version: 1,
    id,
    inputHash: digest(JSON.stringify(input)),
    configHash: digest(JSON.stringify(config)),
    commit: input.commit,
    tree: input.tree,
    sourceHash: input.sourceHash,
    releasePath: join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`),
    directory: join(config.releaseRoot, "transactions", id),
    createdAt: new Date().toISOString(),
    status: "stopping",
    step: "stop",
    nativeUiExitRequestedAt: new Date().toISOString(),
    oldRuntime: paneRuntime,
  } as unknown as DeploymentRecord;
  saveDeploymentJson(join(record.directory, "deployment.json"), record);
  const before = readFileSync(join(record.directory, "deployment.json"), "utf8");
  const persisted: DeploymentRecord[] = [];
  await expect(deployRelease(config, input, structuredClone(record), (value) => persisted.push(value))).rejects.toThrow(
    LegacyRuntimeError,
  );
  expect(persisted).toEqual([]);
  expect(readFileSync(join(record.directory, "deployment.json"), "utf8")).toBe(before);
  expect(sourceRecoveryPending({ deployment: record } as Parameters<typeof sourceRecoveryPending>[0])).toBe(true);

  const restart = {
    ...record,
    id: `restart-${id}`,
    directory: join(config.releaseRoot, "transactions", `restart-${id}`),
  };
  saveRestartIntent(config, restart);
  const pending = readFileSync(join(config.releaseRoot, "restart-pending.json"), "utf8");
  await expect(restartDeployment(config)).rejects.toThrow(LegacyRuntimeError);
  expect(readFileSync(join(config.releaseRoot, "restart-pending.json"), "utf8")).toBe(pending);
  expect(readRestartIntent(config)?.status).toBe("stopping");
});
