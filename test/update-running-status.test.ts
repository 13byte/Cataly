import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimNativePrune, readLeases } from "../src/release/native-cache-lease.ts";
import { writePrivate } from "../src/runtime/headless-record.ts";
import { inspectActiveDeployment, saveActiveDeployment } from "../src/update/deployment-active.ts";
import { captureRuntime } from "../src/update/deployment-harness.ts";
import { leadRuntimeHealth } from "../src/update/deployment-monitor-receipts.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { sourceManifest } from "../src/update/source.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";
import { waitFor } from "./update-detection-setup.ts";
import { fixture } from "./update-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

test("public upstream status awaits the running observation instead of serializing a Promise", async () => {
  const f = fixture();
  const config = join(f.directory, "config.json");
  f.write(f.directory, "config.json", JSON.stringify(f.config));
  const cli = join(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");
  const proc = Bun.spawn([process.execPath, cli, "upstream", "status", "--config", config], {
    env: { PATH: process.env["PATH"], HOME: f.directory },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ target: "cataly", running: { status: "unknown" }, jobs: [] });
});

/** A running native harness whose active receipt names its current lead and the previous release it runs. */
const activeFixture = async () => {
  const f = await headlessDeployment();
  try {
    const runtime = await captureRuntime(f.config, true);
    await waitFor(() => leadRuntimeHealth(f.config.stateDir, runtime) !== undefined);
    const record: DeploymentRecord = { ...f.record, sourceHash: sourceManifest(f.oldSource).hash, runtime };
    saveActiveDeployment(f.config, record);
    return { ...f, runtime, record, active: join(f.config.releaseRoot, "active.json") };
  } catch (error) {
    await f.teardown();
    throw error;
  }
};

linux(
  "running revision is read back without activation, native effects or deployment-state writes",
  async () => {
    const f = await activeFixture();
    try {
      const before = readFileSync(f.active, "utf8");
      const running = await inspectActiveDeployment(f.config);
      expect(running).toMatchObject({
        status: "running",
        source: f.oldSource,
        sourceHash: f.record.sourceHash,
        pid: f.runtime.pid,
        sessionId: f.runtime.sessionId,
        nativeVersion: f.toolchain.nativeVersion,
      });
      expect(readFileSync(f.active, "utf8")).toBe(before);
      expect(sameProcess(f.runtime)).toBe(true);
      // A busy lead is still the running revision; observation never waits for or interrupts it.
      const seen = await f.lead();
      await f.rt.deliver(seen!.ref, "background job", { expectedSessionId: seen!.sessionId! });
      expect((await inspectActiveDeployment(f.config)).status).toBe("running");
      expect(sameProcess(f.runtime)).toBe(true);
    } finally {
      await f.teardown();
    }
  },
  30_000,
);

linux(
  "an aborted status probe does not act on the runtime",
  async () => {
    const f = await activeFixture();
    try {
      const before = readFileSync(f.active, "utf8");
      const controller = new AbortController();
      controller.abort();
      expect((await inspectActiveDeployment(f.config, controller.signal)).status).toBe("unknown");
      expect(readFileSync(f.active, "utf8")).toBe(before);
      expect(sameProcess(f.runtime)).toBe(true);
    } finally {
      await f.teardown();
    }
  },
  30_000,
);

linux(
  "status retains cache leases and cancels a held prune without deployment effects",
  async () => {
    const f = await activeFixture();
    try {
      const identity = "e".repeat(64);
      const cache = join(f.config.home, ".cache/omp-cataly");
      const bin = join(cache, `native-${process.platform}-${process.arch}-${identity}`, "bin");
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      const alias = join(bin, "omp");
      symlinkSync(f.toolchain.omp, alias);
      saveActiveDeployment(f.config, { ...f.record, toolchain: { ...f.toolchain, omp: alias } });
      const before = readFileSync(f.active, "utf8");
      expect((await inspectActiveDeployment(f.config)).status).toBe("running");
      expect(readdirSync(join(cache, "native-leases", identity))).toHaveLength(1);
      expect(readLeases(cache, false).byIdentity.size).toBe(0);
      // A real cross-process kernel lock cannot be exercised with fake timers.
      const release = claimNativePrune(f.config.home);
      const abort = new AbortController();
      const pending = inspectActiveDeployment(f.config, abort.signal);
      try {
        await waitFor(() => readLeases(cache, false).byIdentity.has(identity));
        abort.abort();
        expect((await pending).status).toBe("unknown");
        expect(readLeases(cache, false).byIdentity.size).toBe(0);
        expect(readFileSync(f.active, "utf8")).toBe(before);
        expect(sameProcess(f.runtime)).toBe(true);
      } finally {
        abort.abort();
        await pending;
        release();
      }
    } finally {
      await f.teardown();
    }
  },
  30_000,
);

for (const change of ["source", "native", "session", "receipt"] as const)
  linux(
    `historical deployment cannot attest changed ${change}`,
    async () => {
      const f = await activeFixture();
      try {
        if (change === "source") writeFileSync(join(f.oldSource, "changed.ts"), "export const changed = true;");
        if (change === "native")
          writeFileSync(f.toolchain.omp, `${readFileSync(f.toolchain.omp, "utf8")}\n// changed\n`);
        if (change === "session") {
          const binding = f.inventory()!.roles["lead"]!;
          writePrivate(join(f.config.catalyHome, "harness-native.json"), {
            version: 1,
            stateDir: f.config.stateDir,
            roles: { ...f.inventory()!.roles, lead: { ...binding, sessionId: "different-session" } },
          });
        }
        if (change === "receipt") {
          const active = JSON.parse(readFileSync(f.active, "utf8"));
          active.runtime.startTicks += "-stale";
          writeFileSync(f.active, JSON.stringify(active));
        }
        const current = readFileSync(f.active, "utf8");
        const result = await inspectActiveDeployment(f.config);
        expect(result.status).toBe("unknown");
        if (change === "source")
          expect(result).toHaveProperty("reason", "running source bytes differ from the verified receipt");
        if (change === "native")
          expect(result).toHaveProperty("reason", "managed native toolchain or per-process update fence changed");
        expect(result).not.toHaveProperty("sourceHash");
        expect(readFileSync(f.active, "utf8")).toBe(current);
        expect(sameProcess(f.runtime)).toBe(true);
      } finally {
        await f.teardown();
      }
    },
    30_000,
  );
