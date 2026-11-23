import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { readSourceState } from "../src/update/source-update-state.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux(
  "actual source CLI dry-run and full apply replace the native harness and verify its health",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      const idle = await f.cli("idle-check");
      expect(idle).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(idle.stdout)).toMatchObject({ status: "idle", receivers: 1 });
      for (const args of [
        ["update", "source", "apply"],
        ["lead", "restart"],
      ]) {
        const dry = await f.cli(...args, "--when", "idle", "--dry-run");
        expect(dry).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(dry.stdout)).toMatchObject({ status: "ready", dryRun: true });
        expect(existsSync(f.sourceState)).toBe(false);
        expect(existsSync(join(f.config.deployment.releaseRoot, "source-candidates"))).toBe(false);
        expect(sameProcess(f.runtime)).toBe(true);
      }
      const result = await f.cli("update", "source", "apply", "--when", "idle");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "healthy", commit: f.target.commit, step: "done" });
      const record = readSourceState(f.config).job!.deployment!;
      expect(record.oldRuntime).toMatchObject({ pid: f.runtime.pid, sessionId: f.runtime.sessionId });
      const lead = (await f.deployment.lead())!;
      expect(record.runtime).toMatchObject({ pid: lead.pid, sessionId: lead.sessionId, ref: lead.ref.id });
      expect(sameProcess(record.runtime!)).toBe(true);
      expect(sameProcess(f.runtime)).toBe(false);
      expect(realpathSync(f.config.deployment.liveSource)).toBe(record.releasePath);
      expect((await currentSource(f.config)).commit).toBe(f.target.commit);
      expect(readActiveDeployment(f.config.deployment)!.runtime.pid).toBe(record.runtime!.pid);
    } finally {
      await f.close();
    }
  },
  120_000,
);

linux(
  "failed source health rolls back and blocks the same target until an explicit retry",
  async () => {
    const f = await sourceRolloutFixture();
    try {
      f.rejectHealth(join(f.config.deployment.releaseRoot, "releases", `${f.target.commit}-`));
      const failed = await f.cli("update", "source", "apply", "--when", "idle");
      expect(failed).toMatchObject({ code: 4, stderr: "" });
      expect(JSON.parse(failed.stdout).status).toBe("rolled-back");
      const state = readSourceState(f.config);
      expect(state.failedCommits).toEqual([f.target.commit]);
      const restored = state.job!.deployment!.rollbackRuntime!;
      expect(sameProcess(restored)).toBe(true);
      expect(restored.pid).not.toBe(f.runtime.pid);
      expect((await currentSource(f.config)).commit).toBe(f.current.commit);
      for (const suffix of [[], ["--dry-run"]]) {
        const held = await f.cli("update", "source", "apply", "--when", "idle", ...suffix);
        expect(held.code).toBe(4);
        expect(held.stderr).toContain("--retry-failed");
        // A blocked target never touches the restored harness.
        expect(sameProcess(restored)).toBe(true);
      }
      f.rejectHealth(undefined);
      const retried = await f.cli("update", "source", "apply", "--when", "idle", "--retry-failed");
      expect(retried).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(retried.stdout).status).toBe("healthy");
      expect(readSourceState(f.config).failedCommits).toBeUndefined();
      expect((await currentSource(f.config)).commit).toBe(f.target.commit);
      expect(sameProcess(restored)).toBe(false);
    } finally {
      await f.close();
    }
  },
  180_000,
);
