import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { deployRelease, restartDeployment } from "../src/update/deployment.ts";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { ownReleaseRoot, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";

// The headless harness needs a Unix socket and the process readers that bind deployment identity.
const native = test.skipIf(process.platform !== "linux");

const journal = (record: DeploymentRecord): DeploymentRecord =>
  JSON.parse(readFileSync(join(record.directory, "deployment.json"), "utf8")) as DeploymentRecord;

native(
  "an idle harness is stopped, switched and restarted on the new release, then attested healthy",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      const saved: DeploymentRecord[] = [];
      const result = await deployRelease(f.config, f.input, f.record, (value) => saved.push(structuredClone(value)));
      expect(result).toMatchObject({ status: "healthy", step: "done", oldSource: f.oldSource });
      expect(result.error).toBeUndefined();
      expect(result.stopRequestedAt).toBeString();
      expect(result.launchRequestedAt).toBeString();
      expect(result.oldRuntime).toMatchObject({ pid: old.pid, sessionId: old.sessionId, role: "cataly" });
      expect(sameProcess(result.oldRuntime!)).toBe(false);
      expect(realpathSync(f.config.liveSource)).toBe(f.newSource);
      const lead = (await f.lead())!;
      expect(result.runtime).toMatchObject({ pid: lead.pid, sessionId: lead.sessionId, ref: lead.ref.id });
      expect(sameProcess(result.runtime!)).toBe(true);
      expect(Date.parse(result.runtime!.startedAt)).toBeGreaterThanOrEqual(Date.parse(result.launchRequestedAt!));
      expect(readActiveDeployment(f.config)).toMatchObject({ source: f.newSource, sourceHash: f.input.sourceHash });
      expect(readActiveDeployment(f.config)!.runtime.pid).toBe(lead.pid);
      // Every role of the harness came back from the new release.
      expect(Object.keys(f.inventory()!.roles).sort()).toEqual(["duty", "duty-loop", "hourly-loop", "lead"]);
      expect(journal(result)).toEqual(result);
      expect(saved.map((record) => record.step)).toContain("switch");
    } finally {
      await f.teardown();
    }
  },
  90_000,
);

native(
  "a busy lead holds the rollout before any native effect, and the same intent resumes at its idle boundary",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      await f.rt.deliver(old.ref, "background job", { expectedSessionId: old.sessionId! });
      await f.until(async () => ((await f.lead())?.status === "working" ? true : undefined), "a busy lead");
      let saved: DeploymentRecord | undefined;
      const persist = (value: DeploymentRecord): void => {
        saved = structuredClone(value);
      };
      const held = await deployRelease(f.config, f.input, f.record, persist);
      expect(held).toMatchObject({ status: "held", step: "stop", retryableHold: true });
      expect(held.error).toContain("idle boundary");
      expect(held.stopRequestedAt).toBeUndefined();
      expect(held.launchRequestedAt).toBeUndefined();
      expect(sameProcess(held.oldRuntime!)).toBe(true);
      expect(realpathSync(f.config.liveSource)).toBe(f.oldSource);
      expect((await f.lead())?.pid).toBe(old.pid);
      f.settle(old.pid);
      await f.until(async () => ((await f.lead())?.status === "idle" ? true : undefined), "an idle lead again");
      const resumed = await deployRelease(f.config, f.input, saved, persist);
      expect(resumed).toMatchObject({ id: held.id, status: "healthy", step: "done" });
      expect(realpathSync(f.config.liveSource)).toBe(f.newSource);
      expect(sameProcess(held.oldRuntime!)).toBe(false);
    } finally {
      await f.teardown();
    }
  },
  90_000,
);

native(
  "a pending approval holds the rollout before stop and never answers the dialog",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      await f.rt.deliver(old.ref, "request approval", { expectedSessionId: old.sessionId! });
      await f.until(async () => ((await f.lead())?.dialogs.length ? true : undefined), "a pending approval");
      const held = await deployRelease(f.config, f.input, f.record, () => {});
      expect(held).toMatchObject({ status: "held" });
      expect(held.error).toContain("approval");
      expect(held.retryableHold).toBeUndefined();
      expect(held.stopRequestedAt).toBeUndefined();
      expect(realpathSync(f.config.liveSource)).toBe(f.oldSource);
      const seen = (await f.lead())!;
      expect(seen.pid).toBe(old.pid);
      expect(seen.dialogs).toHaveLength(1);
    } finally {
      await f.teardown();
    }
  },
  90_000,
);

native(
  "a once monitor of the lead session holds the stop until it finishes",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      saveDeploymentJson(join(f.config.stateDir, "monitors", `${encodeURIComponent(old.sessionId!)}.json`), {
        version: 2,
        sessionId: old.sessionId,
        monitors: [{ name: "batch", argv: [process.execPath, "--version"], filter: ".", cwd: f.work, mode: "once" }],
      });
      const held = await deployRelease(f.config, f.input, f.record, () => {});
      expect(held).toMatchObject({ status: "held", step: "stop" });
      expect(held.error).toBe(
        'managed restart waits for once monitor "batch" to finish successfully or be explicitly stopped',
      );
      expect(held.stopRequestedAt).toBeUndefined();
      expect(sameProcess(held.oldRuntime!)).toBe(true);
      expect(realpathSync(f.config.liveSource)).toBe(f.oldSource);
    } finally {
      await f.teardown();
    }
  },
  90_000,
);

native(
  "failed health of the new harness restores the previous release and restarts its harness",
  async () => {
    let next = "";
    const f = await headlessDeployment({ healthy: (source) => source !== next });
    next = f.newSource;
    try {
      const old = (await f.lead())!;
      const result = await deployRelease(f.config, f.input, f.record, () => {});
      expect(result).toMatchObject({ status: "rolled-back", step: "done" });
      expect(result.error).toBe("native lead code health has not converged on its source");
      expect(result.rollbackError).toBeUndefined();
      expect(result.rollbackLaunchRequestedAt).toBeString();
      expect(realpathSync(f.config.liveSource)).toBe(f.oldSource);
      const lead = (await f.lead())!;
      expect(result.rollbackRuntime).toMatchObject({ pid: lead.pid, sessionId: lead.sessionId });
      // The rollback resumes the very session the forward start resumed.
      expect(lead.sessionId).toBe(old.sessionId);
      expect(sameProcess(result.rollbackRuntime!)).toBe(true);
      expect(sameProcess(result.oldRuntime!)).toBe(false);
      expect(readActiveDeployment(f.config)).toMatchObject({ source: f.oldSource, sourceHash: result.oldSourceHash });
      expect(journal(result)).toEqual(result);
    } finally {
      await f.teardown();
    }
  },
  120_000,
);

native(
  "a managed restart replaces the harness on its current source",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      ownReleaseRoot(f.config);
      // A restart's commit identity is read from the running source's Git checkout.
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=f", "-c", "user.email=f@example.invalid", ...args], {
          cwd: f.oldSource,
        });
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-q", "-m", "previous");
      const result = await restartDeployment(f.config);
      expect(result).toMatchObject({ status: "healthy", step: "done", releasePath: f.oldSource });
      expect(sameProcess(result.oldRuntime!)).toBe(false);
      expect(result.runtime!.pid).not.toBe(old.pid);
      expect(result.runtime!.sessionId).toBe(old.sessionId!);
      expect(sameProcess(result.runtime!)).toBe(true);
      expect(readRestartIntent(f.config)).toBeUndefined();
      expect(realpathSync(f.config.liveSource)).toBe(f.oldSource);
    } finally {
      await f.teardown();
    }
  },
  90_000,
);
