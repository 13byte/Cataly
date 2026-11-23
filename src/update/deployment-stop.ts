import { realpathSync } from "node:fs";
import { captureRuntime, observeLead, stopHarness } from "./deployment-harness.ts";
import { desiredMonitors } from "./deployment-monitors.ts";
import { DeploymentHeld, processIdentity, sameProcess, underProcess } from "./deployment-process.ts";
import { consumeQuiesceCheckpoint } from "./deployment-quiesce.ts";
import { terminateBoundProcess } from "./deployment-signal.ts";
import type { DeploymentConfig, DeploymentRecord, MonitorProcessIdentity } from "./deployment-types.ts";
import { sourceManifest } from "./source.ts";

export function forwardStopStarted(record: DeploymentRecord): boolean {
  return Boolean(record.stopRequestedAt || record.nativeExitObservedAt);
}

/** A retry window never authorizes a native effect after its durable deadline. */
export function assertRetryDeadline(record: DeploymentRecord): void {
  if (forwardStopStarted(record) || record.retryDeadlineAt === undefined) return;
  if (!(Date.now() < Date.parse(record.retryDeadlineAt)))
    throw new DeploymentHeld("deployment pre-stop retry deadline expired or is invalid");
}

/** A requested stop whose old lead is still running is never certified as restored; its forward intent resumes. */
export function holdPendingStop(record: DeploymentRecord): boolean {
  if (record.step !== "stop" || !record.stopRequestedAt || !record.oldRuntime || !sameProcess(record.oldRuntime))
    return false;
  record.status = "held";
  return true;
}

async function waitLeadGone(config: DeploymentConfig, until: number): Promise<void> {
  while ((await observeLead(config)).status !== "gone") {
    if (Date.now() >= until) throw new DeploymentHeld("native lead exit was not confirmed by its broker");
    await Bun.sleep(50);
  }
}

/**
 * One identity-bound forward stop of the whole native harness. An idle lead is closed by `cataly harness stop`; a lead
 * held busy under an explicit quiesce checkpoint is first terminated by its bound process identity.
 */
export async function stopRuntime(
  config: DeploymentConfig,
  record: DeploymentRecord,
  persist: (record: DeploymentRecord) => void,
  allowQuiesce = false,
  finalAdmission?: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const expected = record.oldRuntime;
  if (!expected || !record.oldSource) throw new DeploymentHeld("native stop has no journaled owner identity");
  if (!sameProcess(expected)) {
    if (processIdentity(expected.pid)) throw new DeploymentHeld("native PID has been reused");
    assertRetryDeadline(record);
    record.monitors ??= desiredMonitors(config, expected.sessionId);
    if (!forwardStopStarted(record)) await finalAdmission?.();
    record.stopRequestedAt ??= new Date().toISOString();
    record.nativeExitObservedAt ??= new Date().toISOString();
    persist(record);
    consumeQuiesceCheckpoint(config, record);
    await stopHarness(config, record.oldSource, signal);
    return;
  }
  const actual = await captureRuntime(config, false, allowQuiesce ? record : undefined);
  if (
    !sameProcess(expected, actual) ||
    actual.ref !== expected.ref ||
    actual.startedAt !== expected.startedAt ||
    actual.sessionFile !== expected.sessionFile
  )
    throw new DeploymentHeld("native runtime changed before stop");
  if (expected.pid === process.pid || underProcess(process.pid, expected.pid))
    throw new DeploymentHeld("replacement controller must run outside the target actor");
  for (const monitor of record.oldMonitors ?? []) {
    if (!sameProcess(monitor) || monitor.pid === expected.pid || !underProcess(monitor.pid, expected.pid))
      throw new DeploymentHeld("monitor identity changed before native stop");
  }
  if (record.oldSourceHash && sourceManifest(realpathSync(config.liveSource)).hash !== record.oldSourceHash)
    throw new DeploymentHeld("previous source changed after its handoff journal");
  // The session's desired monitors, read while its lead still runs: the resumed lead must restore exactly these.
  record.monitors = desiredMonitors(config, expected.sessionId);
  assertRetryDeadline(record);
  if (!forwardStopStarted(record)) await finalAdmission?.();
  record.stopRequestedAt ??= new Date().toISOString();
  persist(record);
  consumeQuiesceCheckpoint(config, record);
  const until = Date.now() + config.stopTimeoutMs;
  if (actual.busy) {
    // Only a verified quiesce checkpoint admits a busy lead; `harness stop` closes idle roles only.
    terminateBoundProcess(expected);
    while (sameProcess(expected) && Date.now() < until) await Bun.sleep(50);
    if (sameProcess(expected)) throw new DeploymentHeld("quiesced native lead did not stop within its bound");
    await waitLeadGone(config, until);
  }
  await stopHarness(config, record.oldSource, signal);
  while (sameProcess(expected) && Date.now() < until) await Bun.sleep(50);
  if (sameProcess(expected)) throw new DeploymentHeld("native runtime did not stop within its bound");
  if (processIdentity(expected.pid)) throw new DeploymentHeld("native PID was reused after stop");
}

export async function stopRecordedMonitors(
  config: DeploymentConfig,
  monitors: readonly MonitorProcessIdentity[],
): Promise<void> {
  for (const monitor of monitors) {
    if (!sameProcess(monitor)) continue;
    terminateBoundProcess(monitor);
  }
  const until = Date.now() + config.stopTimeoutMs;
  while (monitors.some((identity) => sameProcess(identity)) && Date.now() < until) await Bun.sleep(50);
  if (monitors.some((identity) => sameProcess(identity))) throw new DeploymentHeld("owned old monitors did not stop");
}
