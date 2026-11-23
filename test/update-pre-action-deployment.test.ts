import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CatalyUpdater } from "../src/update/controller.ts";
import { deployRelease } from "../src/update/deployment.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { reportPreAction } from "../src/update/pre-action-notice.ts";
import { digest } from "../src/update/source.ts";
import { persistJob, readJob } from "../src/update/state.ts";
import type { UpdateJob } from "../src/update/types.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";
import { recordingReporter, waitFor } from "./update-pre-action-setup.ts";
import { fixture } from "./update-setup.ts";

/** A prepared rollout of a running native harness, owned by a persisted update job with a recorded reporter. */
async function forwardFixture(mode: "accepted" | "failed" | "ambiguous") {
  const f = fixture();
  const h = await headlessDeployment();
  const sink = recordingReporter(f.directory, mode);
  const ctx = new CatalyUpdater({ ...f.config, reporter: sink.command }, () => {}).context;
  const id = digest(`${ctx.configHash}\n${h.input.commit}`);
  const directory = join(ctx.config.root, "jobs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const candidate = join(directory, "candidate");
  symlinkSync(h.input.candidate, candidate, "dir");
  const at = new Date().toISOString();
  const job: UpdateJob = {
    version: 1,
    id,
    upstream: h.input.commit,
    baseUpstream: f.config.baseUpstream,
    configHash: ctx.configHash,
    createdAt: at,
    updatedAt: at,
    directory,
    candidate,
    sourceHash: h.input.sourceHash,
    phase: "ready",
    commands: [],
    history: [{ phase: "ready", at }],
    promotion: { version: 1, status: "deploying", deployment: h.record },
  };
  saveDeploymentJson(join(h.record.directory, "deployment.json"), h.record);
  persistJob(job);
  const old = (await h.lead())!;
  const run = (interruptAfterNotice = false) => {
    const resumed = readJob(ctx.config.root, id);
    return deployRelease(
      h.config,
      h.input,
      resumed.promotion!.deployment,
      (value) => {
        if (value.stopRequestedAt) {
          expect(readJob(ctx.config.root, id).preActionNotices!["cataly-replacement"]).toMatchObject({
            state: "accepted",
            exitCode: 0,
          });
        }
        resumed.promotion!.deployment = structuredClone(value);
        persistJob(resumed);
      },
      undefined,
      async (deployment) => {
        await reportPreAction(ctx, resumed, { action: "cataly-replacement", deployment });
        if (interruptAfterNotice) throw new Error("fixture interruption after accepted notice and before native stop");
      },
    );
  };
  return { ...h, ctx, id, old, sink, run };
}

test.skipIf(process.platform !== "linux").each(["accepted", "failed", "ambiguous"] as const)(
  "forward stop awaits its configured reporter and retains its exact notice across failures: %s",
  async (mode) => {
    const f = await forwardFixture(mode);
    const pending = f.run(mode === "accepted");
    try {
      await waitFor(() => existsSync(f.sink.started));
      expect((await f.lead())?.pid).toBe(f.old.pid);
      const sending = readJob(f.ctx.config.root, f.id);
      expect(sending.promotion!.deployment!.stopRequestedAt).toBeUndefined();
      expect(f.sink.attempts()).toMatchObject([
        {
          outcome: "before-cataly-replacement",
          job: f.id,
          deploymentIntent: sending.promotion!.deployment!.id,
          publicationCommit: sending.promotion!.deployment!.commit,
        },
      ]);
      if (mode === "accepted") {
        expect(sending.preActionNotices!["cataly-replacement"]!.state).toBe("sending");
        expect(f.sink.delivered()).toEqual([]);
        f.sink.release();
      }
      const first = await pending;
      const retained = readJob(f.ctx.config.root, f.id);
      expect(retained.preActionNotices!["cataly-replacement"]!.state).toBe(mode);
      expect(first).toMatchObject({ status: "held", step: "prepare" });
      expect(first.stopRequestedAt).toBeUndefined();
      expect(first.launchRequestedAt).toBeUndefined();
      expect((await f.lead())?.pid).toBe(f.old.pid);
      const repeated = await f.run();
      if (mode === "accepted") {
        // The accepted notice admits the real native stop and replacement exactly once.
        expect(repeated).toMatchObject({ status: "healthy", step: "done" });
        expect(repeated.stopRequestedAt).toBeString();
        expect((await f.lead())?.pid).not.toBe(f.old.pid);
        expect(f.sink.delivered()).toHaveLength(1);
      } else {
        expect(repeated.status).toBe("held");
        expect(repeated.stopRequestedAt).toBeUndefined();
        expect((await f.lead())?.pid).toBe(f.old.pid);
        expect(f.sink.delivered()).toEqual([]);
      }
      expect(f.sink.attempts()).toHaveLength(1);
    } finally {
      f.sink.release();
      await pending.catch(() => undefined);
      await f.teardown();
    }
  },
  90_000,
);
