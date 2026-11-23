import { realpathSync } from "node:fs";
import { convergedHealth } from "./deployment-handoff.ts";
import { assertHarnessRoles, captureRuntime } from "./deployment-harness.ts";
import { monitorProcessReceipts } from "./deployment-monitor-receipts.ts";
import { assertFreshIntake, desiredMonitors, sameMonitorSpecs } from "./deployment-monitors.ts";
import { runtimeUsesToolchain } from "./deployment-prior.ts";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import { assertRuntimeToolchain } from "./deployment-toolchain.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity } from "./deployment-types.ts";
import { sourceManifest } from "./source.ts";

/**
 * The harness started at or after `since` from `source`: every bound role is running, the lead resumed the old lead's
 * own session, its extension reports fresh health for that source with exactly the monitors the session wanted before
 * the stop, a fresh intake heartbeat arrived, and its native image is the journaled toolchain.
 */
export async function observeDeploymentHealth(
  config: DeploymentConfig,
  record: DeploymentRecord,
  source: string,
  since: string,
  prior = false,
): Promise<RuntimeIdentity> {
  const runtime = await captureRuntime(config, true);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs) || !(Date.parse(runtime.startedAt) >= sinceMs))
    throw new DeploymentHeld("native lead predates its journaled start");
  if (runtime.sessionId !== record.oldRuntime?.sessionId || runtime.sessionFile !== record.oldRuntime.sessionFile)
    throw new DeploymentHeld("resumed native session identity differs");
  await assertHarnessRoles(config);
  if (realpathSync(config.liveSource) !== realpathSync(source))
    throw new DeploymentHeld("running source pointer differs");
  const wanted = record.monitors;
  if (!wanted) throw new DeploymentHeld("desired monitor state was not captured before the stop");
  const health = convergedHealth(config, runtime, source, sinceMs);
  if (!sameMonitorSpecs(health.monitors, wanted.monitors))
    throw new DeploymentHeld("resumed lead monitors differ from before the stop");
  const desired = desiredMonitors(config, runtime.sessionId);
  if (
    !sameMonitorSpecs(desired.monitors, wanted.monitors) ||
    JSON.stringify(desired.intake) !== JSON.stringify(wanted.intake)
  )
    throw new DeploymentHeld("restored desired monitor state differs");
  monitorProcessReceipts(runtime, health);
  assertFreshIntake(wanted.intake, sinceMs);
  const expectedHash =
    realpathSync(source) === realpathSync(record.releasePath) ? record.sourceHash : record.oldSourceHash;
  if (sourceManifest(realpathSync(source)).hash !== expectedHash)
    throw new DeploymentHeld("running source bytes differ");
  const toolchain = prior ? record.oldToolchain : record.toolchain;
  if (!toolchain || !runtimeUsesToolchain(runtime, toolchain))
    throw new DeploymentHeld("running native image differs from its receipt");
  assertRuntimeToolchain(config, toolchain);
  if (!sameProcess(runtime)) throw new DeploymentHeld("native runtime changed during health observation");
  return { ...runtime, nativeVersion: toolchain.nativeVersion, entrypointHash: toolchain.ompEntryHash };
}

export async function waitDeploymentHealth(
  config: DeploymentConfig,
  record: DeploymentRecord,
  source: string,
  since: string,
  signal?: AbortSignal,
  prior = false,
): Promise<RuntimeIdentity> {
  const deadline = Date.now() + config.healthTimeoutMs;
  // The final observation runs at the deadline, so a failure always reports its actual reason.
  for (;;) {
    if (signal?.aborted) throw new DeploymentHeld("deployment health observation interrupted");
    try {
      return await observeDeploymentHealth(config, record, source, since, prior);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}
