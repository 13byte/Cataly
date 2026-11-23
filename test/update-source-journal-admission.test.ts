import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent } from "../src/update/deployment-restart-state.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { readSourceState, saveSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux(
  "source apply rechecks its policy while recovering a pending separate restart",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      f.openLane();
      const held = await f.cli("lead", "restart", "--when", "idle");
      expect(held.code).toBe(4);
      expect(readRestartIntent(f.config.deployment)).toMatchObject({ status: "held" });
      expect(readRestartIntent(f.config.deployment)?.stopRequestedAt).toBeUndefined();
      // The lane is gone for the first idle check but reopens before the pending restart's admission.
      f.closeLane();
      f.openLaneOnGitHub();
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result.code).toBe(4);
      const intent = readRestartIntent(f.config.deployment)!;
      expect(intent.error).toContain("open lanes");
      expect(intent.stopRequestedAt).toBeUndefined();
      expect(sameProcess(f.runtime)).toBe(true);
      expect(await currentSource(f.config)).toEqual(f.current);
    } finally {
      await f.close();
    }
  },
  120_000,
);

linux(
  "a held pre-stop attempt past its retry window does not prevent a fresh safe source attempt",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      f.openLaneOnGitHub();
      expect((await f.cli("update", "source", "apply", "--when", "idle")).code).toBe(4);
      const state = readSourceState(f.config);
      const record = state.job!.deployment!;
      expect(record.stopRequestedAt).toBeUndefined();
      record.retryDeadlineAt = new Date(Date.now() - 3_600_000).toISOString();
      saveDeploymentJson(join(record.directory, "deployment.json"), record);
      saveSourceState(f.config, state);
      f.closeLane();
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const fresh = readSourceState(f.config).job!.deployment!;
      expect(fresh.id).not.toBe(record.id);
      expect(fresh.status).toBe("healthy");
      // The abandoned attempt stays exactly as held; it never gained a stop receipt.
      expect(
        JSON.parse(readFileSync(join(record.directory, "deployment.json"), "utf8")).stopRequestedAt,
      ).toBeUndefined();
      expect(sameProcess(f.runtime)).toBe(false);
    } finally {
      await f.close();
    }
  },
  120_000,
);
