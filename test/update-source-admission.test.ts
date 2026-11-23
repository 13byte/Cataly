import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent } from "../src/update/deployment-restart-state.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { readSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux(
  "the public lead restart command restarts the harness on the installed source without GitHub or a source update",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const result = await f.cli("lead", "restart", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "healthy", step: "done" });
      const active = readActiveDeployment(f.config.deployment)!;
      const lead = (await f.deployment.lead())!;
      expect(active.runtime).toMatchObject({ pid: lead.pid, sessionId: lead.sessionId });
      expect(sameProcess(active.runtime)).toBe(true);
      expect(sameProcess(f.runtime)).toBe(false);
      expect(await currentSource(f.config)).toEqual(f.current);
      expect(readRestartIntent(f.config.deployment)).toBeUndefined();
      expect(existsSync(f.sourceState)).toBe(false);
      expect(existsSync(f.requests)).toBe(false);
    } finally {
      await f.close();
    }
  },
  120_000,
);

linux(
  "a lane opened after the first idle check prevents source stop intent and every native effect",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      f.openLaneOnGitHub();
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 4, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "held",
        step: "prepare",
        error: "open lanes: late-owner-work(working)",
      });
      const record = readSourceState(f.config).job!.deployment!;
      expect(record.stopRequestedAt).toBeUndefined();
      expect(sameProcess(f.runtime)).toBe(true);
      expect((await f.deployment.lead())!.pid).toBe(f.runtime.pid);
      expect(await currentSource(f.config)).toEqual(f.current);
    } finally {
      await f.close();
    }
  },
  120_000,
);
