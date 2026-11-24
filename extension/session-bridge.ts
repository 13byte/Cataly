import { MONITOR_MESSAGE, recordedRole, SESSION_WIRE } from "../skills/cataly-mode/scripts/src/session-compat.ts";
import { COMPLETION_ENTRY } from "../skills/cataly-mode/scripts/src/tool-evidence.ts";
import { sameMonitorSpecs } from "../src/update/deployment-monitors.ts";
import { recordedIntake } from "./bootstrap.ts";
import { MONITOR_ENTRY, type RecordedMonitor, recordedMonitorStates } from "./monitor-state.ts";

/*
 * THE ONE BRIDGE FROM THE PREVIOUS MAIN (the release before the legacy removal) for OMP session entries.
 *
 * That release recorded session state under `omp-dori:*` names, wrote the lead role as "dori", and delivered Discord
 * lane input and head-admission receipts as `dori-monitor` messages. This extension reads only `omp-cataly:*` and
 * `cataly-monitor`, so a session resumed by any path (`omp --resume`, a lane reopen, the deployment bridge) would
 * otherwise come back without its role, monitors, intake, lane policy, receiver, ask lane or completion receipts.
 *
 * `bridgePreviousMain` appends the current-name equivalent of exactly what the previous readers saw, once, through the
 * same `appendEntry` every other write uses. It never rewrites, reorders or truncates what OMP stored, and a branch that
 * already carries that state appends nothing, so a second resume is a no-op. Everything else stays strict: only this
 * module names the previous spelling.
 *
 * `dori-monitor` messages are read here but never appended. Their content is model context, and an accepted admission
 * receipt exists only as a `custom_message`; this API appends custom entries, so re-emitting one would put the inbound
 * text into the context a second time. A delivery whose receipt reached the transcript but not the receiver's own
 * record when the previous main stopped therefore stays unresolved, and the receiver's existing recovery line names it.
 *
 * Nothing writes these shapes any more; delete this file with the next release.
 */

type Entry = {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly details?: unknown;
};
export type SessionAppend = (customType: string, data?: unknown) => void;

const PREVIOUS = "omp-dori:";
const CURRENT = "omp-cataly:";
const PREVIOUS_MONITOR_MESSAGE = "dori-monitor";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A previous-main entry under its current name, with its one renamed payload field. */
const currentEntry = (entry: Entry): Entry => {
  if (entry.type !== "custom" || typeof entry.customType !== "string" || !entry.customType.startsWith(PREVIOUS))
    return entry;
  const customType = `${CURRENT}${entry.customType.slice(PREVIOUS.length)}`;
  if (customType === SESSION_WIRE.role && entry.data === "dori") return { ...entry, customType, data: "cataly" };
  if (customType === SESSION_WIRE.admissionRejected && object(entry.data) && "ompDoriAdmission" in entry.data) {
    const { ompDoriAdmission, ...rest } = entry.data;
    return { ...entry, customType, data: { ...rest, ompCatalyAdmission: ompDoriAdmission } };
  }
  return { ...entry, customType };
};

/** The newest data per key, in first-seen order: what a keyed reader resolves to. */
const keyed = (
  entries: readonly Entry[],
  type: string,
  key: (data: Record<string, unknown>) => string | undefined,
): Map<string, Record<string, unknown>> => {
  const state = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== type || !object(entry.data)) continue;
    const found = key(entry.data);
    if (found !== undefined) state.set(found, entry.data);
  }
  return state;
};

const lastEntry = (entries: readonly Entry[], type: string): Entry | undefined =>
  entries.findLast((entry) => entry.type === "custom" && entry.customType === type);

const sameRecord = (left: RecordedMonitor, right: RecordedMonitor): boolean =>
  left.completed === right.completed &&
  left.id === right.id &&
  JSON.stringify(left.exit) === JSON.stringify(right.exit) &&
  sameMonitorSpecs([left.spec], [right.spec]);

/** One receipt per call, job and tool: the reader takes the newest for that triple. */
const completionKey = (data: Record<string, unknown>): string | undefined => {
  const { call, job, tool } = data;
  return typeof call === "string" && typeof job === "string" && typeof tool === "string"
    ? JSON.stringify([call, job, tool])
    : undefined;
};

/** The admission metadata a head-admission reader sees, in either spelling. */
const admissionMetadata = (value: unknown): { readonly identity: string } | undefined => {
  if (!object(value)) return;
  const admission = object(value["ompCatalyAdmission"]) ? value["ompCatalyAdmission"] : value["ompDoriAdmission"];
  return object(admission) && typeof admission["identity"] === "string"
    ? { identity: admission["identity"] }
    : undefined;
};

/** The receipt of one head admission, as the native and TypeScript readers resolve it. */
const receiptOf = (entry: Entry): { readonly identity: string; readonly accepted: boolean } | undefined => {
  if (
    entry.type === "custom_message" &&
    (entry.customType === MONITOR_MESSAGE || entry.customType === PREVIOUS_MONITOR_MESSAGE)
  ) {
    const found = admissionMetadata(entry.details);
    return found && { ...found, accepted: true };
  }
  if (entry.type === "custom" && entry.customType === SESSION_WIRE.admissionRejected) {
    const found = admissionMetadata(entry.data);
    return found && { ...found, accepted: false };
  }
};

/** Every identity's latest admission outcome, in first-seen order. */
const outcomes = (entries: readonly Entry[]): Map<string, boolean> => {
  const found = new Map<string, boolean>();
  for (const entry of entries) {
    const receipt = receiptOf(entry);
    if (receipt) found.set(receipt.identity, receipt.accepted);
  }
  return found;
};

/** Appends that bring the strict readers from `branch`'s state to the state `previous`'s readers saw. */
const planMonitors = (previous: readonly Entry[], branch: readonly Entry[], plan: [string, unknown][]): void => {
  const before = recordedMonitorStates(previous);
  const after = recordedMonitorStates(branch);
  for (const name of after.keys()) if (!before.has(name)) plan.push([MONITOR_ENTRY, { op: "stop", name }]);
  for (const [name, record] of before) {
    const kept = after.get(name);
    if (kept && sameRecord(kept, record)) continue;
    const id = record.id === undefined ? {} : { id: record.id };
    plan.push([MONITOR_ENTRY, { op: "start", ...record.spec, ...id }]);
    if (record.exit)
      plan.push([MONITOR_ENTRY, { op: record.completed ? "stop" : "exit", name, ...id, exit: record.exit }]);
  }
};

/**
 * Append what the previous main's readers saw under the current names, and report whether anything was appended.
 * `branch` is the session's current branch; `append` is the extension's `pi.appendEntry`.
 */
export function bridgePreviousMain(append: SessionAppend, branch: readonly Entry[]): boolean {
  const previous = branch.map(currentEntry);
  const plan: [string, unknown][] = [];
  const role = recordedRole(previous);
  if (role !== undefined && role !== recordedRole(branch)) plan.push([SESSION_WIRE.role, role]);
  planMonitors(previous, branch, plan);
  const intake = recordedIntake(previous);
  if (intake !== undefined && JSON.stringify(intake) !== JSON.stringify(recordedIntake(branch)))
    plan.push([SESSION_WIRE.intake, intake]);
  const bootstraps = (entries: readonly Entry[]) =>
    keyed(entries, SESSION_WIRE.monitorBootstrap, (data) =>
      typeof data["hash"] === "string" ? data["hash"] : undefined,
    );
  const seenBootstraps = bootstraps(branch);
  for (const [hash, data] of bootstraps(previous))
    if (!seenBootstraps.has(hash)) plan.push([SESSION_WIRE.monitorBootstrap, data]);
  // A lane policy binding is a string, or an invalid snapshot the readers turn into an error; a null entry is that
  // error, so any other recorded value is bridged as null.
  const policy = lastEntry(previous, SESSION_WIRE.lanePolicy);
  const currentPolicy = lastEntry(branch, SESSION_WIRE.lanePolicy);
  if (policy !== undefined && policy.data !== currentPolicy?.data)
    plan.push([SESSION_WIRE.lanePolicy, typeof policy.data === "string" ? policy.data : null]);
  const askLane = lastEntry(previous, SESSION_WIRE.askLane)?.data;
  if (
    askLane !== undefined &&
    JSON.stringify(askLane) !== JSON.stringify(lastEntry(branch, SESSION_WIRE.askLane)?.data)
  )
    plan.push([SESSION_WIRE.askLane, askLane]);
  const receivers = new Set(branch.map((entry) => entry.customType === SESSION_WIRE.laneReceiver && entry.data));
  for (const entry of previous)
    if (entry.customType === SESSION_WIRE.laneReceiver && !receivers.has(entry.data))
      plan.push([SESSION_WIRE.laneReceiver, entry.data]);
  const completions = keyed(branch, COMPLETION_ENTRY, completionKey);
  for (const [key, data] of keyed(previous, COMPLETION_ENTRY, completionKey))
    if (JSON.stringify(completions.get(key)) !== JSON.stringify(data)) plan.push([COMPLETION_ENTRY, data]);
  // A rejection is a receipt too: append only the newest outcome for an identity the current readers cannot answer.
  const current = outcomes(branch);
  const rejections = new Map<string, unknown>();
  for (const entry of previous) {
    const receipt = receiptOf(entry);
    if (receipt && !receipt.accepted) rejections.set(receipt.identity, entry.data);
  }
  for (const [identity, accepted] of outcomes(previous))
    if (!accepted && !current.has(identity)) plan.push([SESSION_WIRE.admissionRejected, rejections.get(identity)]);
  for (const [type, data] of plan) append(type, data);
  return plan.length > 0;
}
