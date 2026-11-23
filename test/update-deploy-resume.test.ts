import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { deployRelease } from "../src/update/deployment.ts";
import { observeDeploymentHealth } from "../src/update/deployment-health.ts";
import { sameProcess, underProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { desiredPath } from "./update-deploy-headless-lead.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";

// The headless harness needs a Unix socket and the process readers that bind deployment identity.
const native = test.skipIf(process.platform !== "linux");

native(
  "a deployment resumes the old lead session with its monitors, and health fails if the session changed",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      const result = await deployRelease(f.config, f.input, f.record, () => {});
      expect(result).toMatchObject({ status: "healthy", step: "done" });
      const lead = (await f.lead())!;
      expect(lead.pid).not.toBe(old.pid);
      expect(lead.sessionId).toBe(old.sessionId);
      expect(lead.sessionFile).toBe(old.sessionFile);
      expect(result.runtime).toMatchObject({ sessionId: old.sessionId, sessionFile: old.sessionFile });
      // The desired monitors captured before the stop are what the resumed lead runs again, under its own process.
      expect(result.monitors?.sessionId).toBe(old.sessionId);
      expect(result.monitors?.monitors.map(({ name }) => name)).toEqual(["intake"]);
      expect(result.oldMonitors?.map(({ name }) => name)).toEqual(["intake"]);
      expect(result.runtimeMonitors?.map(({ name }) => name)).toEqual(["intake"]);
      for (const monitor of result.runtimeMonitors!) {
        expect(sameProcess(monitor)).toBe(true);
        expect(underProcess(monitor.pid, lead.pid)).toBe(true);
      }

      const healthy = (record: DeploymentRecord) =>
        observeDeploymentHealth(f.config, record, f.newSource, result.launchRequestedAt!);
      expect((await healthy(result)).sessionId).toBe(old.sessionId!);
      const otherSession = { ...result, oldRuntime: { ...result.oldRuntime!, sessionId: "another-session" } };
      await expect(healthy(otherSession)).rejects.toThrow("resumed native session identity differs");
      const otherFile = { ...result, oldRuntime: { ...result.oldRuntime!, sessionFile: `${old.sessionFile}.other` } };
      await expect(healthy(otherFile)).rejects.toThrow("resumed native session identity differs");
      const monitors = result.monitors!;
      const moreMonitors = {
        ...result,
        monitors: { ...monitors, monitors: [...monitors.monitors, { ...monitors.monitors[0]!, name: "missing" }] },
      };
      await expect(healthy(moreMonitors)).rejects.toThrow("resumed lead monitors differ from before the stop");
      const { monitors: _captured, ...uncaptured } = result;
      await expect(healthy(uncaptured)).rejects.toThrow("desired monitor state was not captured before the stop");
      // A heartbeat older than the restart is not fresh intake; the paused monitor cannot refresh it meanwhile.
      const intake = result.runtimeMonitors![0]!;
      process.kill(intake.pid, "SIGSTOP");
      try {
        writeFileSync(monitors.intake.path, String(Date.parse(result.launchRequestedAt!) - 1_000));
        await expect(healthy(result)).rejects.toThrow("fresh inbound heartbeat has not arrived");
      } finally {
        process.kill(intake.pid, "SIGCONT");
      }
    } finally {
      await f.teardown();
    }
  },
  90_000,
);

native(
  "a deployment holds before any native effect when the lead session's desired monitor state is unreadable",
  async () => {
    const f = await headlessDeployment();
    try {
      const old = (await f.lead())!;
      // The stand-in extension only writes an absent manifest, so an unreadable one stays.
      writeFileSync(desiredPath(f.config, old.sessionId!), "{");
      const held = await deployRelease(f.config, f.input, f.record, () => {});
      expect(held).toMatchObject({ status: "held", step: "stop" });
      expect(held.error).toStartWith("lead desired monitor state is unavailable");
      expect(held.stopRequestedAt).toBeUndefined();
      expect(sameProcess(held.oldRuntime!)).toBe(true);
    } finally {
      await f.teardown();
    }
  },
  90_000,
);
