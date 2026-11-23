import { restorePointer } from "./deployment-files.ts";
import { captureStartedMonitors } from "./deployment-handoff.ts";
import { readInventory, startHarness, stopHarness } from "./deployment-harness.ts";
import { waitDeploymentHealth } from "./deployment-health.ts";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import { stopRecordedMonitors } from "./deployment-stop.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment-types.ts";

/**
 * Restore the previous source and its harness. A still-running old lead only needs its pointers back; otherwise the
 * partially started harness is stopped, the exact old links are restored, and the prior source starts its own harness
 * with the prior toolchain. None of the previous source or owner state is deleted or copied over.
 */
export async function rollbackDeployment(
  config: DeploymentConfig,
  record: DeploymentRecord,
  persist: (record: DeploymentRecord) => void,
  signal?: AbortSignal,
): Promise<DeploymentRecord> {
  const { oldRuntime, oldSource, oldToolchain } = record;
  if (!oldRuntime || !oldSource || !record.oldSourceHash || !oldToolchain)
    throw new DeploymentHeld("rollback lacks the pre-effect handoff journal");
  const since = record.rollbackLaunchRequestedAt ?? oldRuntime.startedAt;
  if (record.status === "rolled-back" && record.step === "done") {
    const expected = record.rollbackRuntime;
    if (!expected || !record.rollbackHealthyAt)
      throw new DeploymentHeld("completed rollback lacks healthy runtime receipts");
    const runtime = await waitDeploymentHealth(config, record, oldSource, since, signal, true);
    if (!sameProcess(expected, runtime) || expected.sessionId !== runtime.sessionId)
      throw new DeploymentHeld("completed rollback runtime differs from its receipt");
    return record;
  }
  record.step = "rollback";
  record.rollbackRequestedAt ??= new Date().toISOString();
  persist(record);
  if (!record.rollbackLaunchRequestedAt && sameProcess(oldRuntime)) {
    for (const pointer of [...(record.pointers ?? [])].reverse()) restorePointer(pointer);
  } else {
    if (!record.rollbackLaunchRequestedAt) {
      record.runtimeMonitors = await captureStartedMonitors(config, record);
      // The prior source's own stop retires whatever part of the new harness started.
      await stopHarness(config, oldSource, signal);
      await stopRecordedMonitors(config, record.runtimeMonitors);
      await stopRecordedMonitors(config, record.oldMonitors ?? []);
      for (const pointer of [...(record.pointers ?? [])].reverse()) restorePointer(pointer);
      record.rollbackLaunchRequestedAt = new Date().toISOString();
      persist(record);
    }
    // The prior source resumes the same lead session the forward start would have.
    if (!readInventory(config))
      await startHarness(config, oldSource, oldToolchain, oldRuntime.cwd, oldRuntime.sessionId, signal);
  }
  record.rollbackRuntime = await waitDeploymentHealth(
    config,
    record,
    oldSource,
    record.rollbackLaunchRequestedAt ?? oldRuntime.startedAt,
    signal,
    true,
  );
  record.status = "rolled-back";
  record.step = "done";
  record.rollbackHealthyAt = new Date().toISOString();
  persist(record);
  return record;
}
