import { existsSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { laneEntry, readPrivate, type StopReceipt, writePrivate } from "./runtime/headless-record.ts";
import { HEADLESS_ADDRESS, type SessionRef } from "./runtime/types.ts";

/** The lead session the last `cataly harness stop` closed, kept after the inventory is retired. */
type LeadRecord = {
  readonly version: 1;
  readonly stateDir: string;
  readonly ref: SessionRef;
  readonly sessionId: string;
  readonly sessionFile: string;
};
export type LeadResume = { readonly file: string; readonly sessionId: string };

/** A managed deployment names the exact lead session its restart must resume; `up` refuses anything else. */
export const RESUME_SESSION_ENV = "CATALY_HARNESS_RESUME_SESSION";

const recordPath = (d: Deps) => join(d.store.root, "harness-lead.json");

/** A started lead replaces the stopped one: an older session must never be resumed after it. */
export const clearStoppedLead = (d: Deps): void => rmSync(recordPath(d), { force: true });

/**
 * Record the lead this stop retired. A lead that never proved a session leaves the record alone: a proven lead already
 * cleared it, so it still names the last lead that ran.
 */
export function recordStoppedLead(
  d: Deps,
  stateDir: string,
  lead: { readonly ref: SessionRef; readonly sessionId: string | undefined; readonly sessionFile: string | undefined },
): void {
  const { ref, sessionId, sessionFile } = lead;
  if (sessionId && sessionFile && isAbsolute(sessionFile))
    writePrivate(recordPath(d), { version: 1, stateDir, ref, sessionId, sessionFile } satisfies LeadRecord);
}

/** Why the last lead cannot be resumed, or its session when its stop closed exactly that session cleanly. */
function lastLead(d: Deps, stateDir: string): LeadResume | string {
  const saved = readPrivate<LeadRecord>(recordPath(d));
  if (!saved) return "no lead session was recorded by a harness stop";
  if (
    saved.version !== 1 ||
    typeof saved.stateDir !== "string" ||
    saved.ref?.runtime !== "headless" ||
    !HEADLESS_ADDRESS.test(saved.ref.id) ||
    typeof saved.sessionId !== "string" ||
    !saved.sessionId ||
    typeof saved.sessionFile !== "string" ||
    !isAbsolute(saved.sessionFile)
  )
    return "the recorded lead session is invalid";
  if (!existsSync(saved.stateDir) || realpathSync(saved.stateDir) !== realpathSync(stateDir))
    return "the recorded lead session belongs to another state directory";
  const entry = laneEntry(stateDir, saved.ref);
  const receipt = entry?.reservation.role === "lead" && readPrivate<StopReceipt>(join(entry.dir, "stopped.json"));
  if (!receipt || receipt.detail !== undefined || receipt.closedSessionId !== saved.sessionId)
    return "the last lead stop did not cleanly close its recorded session";
  if (!existsSync(saved.sessionFile)) return "the recorded lead transcript no longer exists";
  return { file: saved.sessionFile, sessionId: saved.sessionId };
}

/**
 * The lead session `up` resumes: the cleanly stopped previous lead unless `fresh`. A required session (managed
 * deployment) must be exactly that session; it is never replaced by a new one.
 */
export function leadResume(d: Deps, stateDir: string, fresh: boolean): LeadResume | undefined {
  const required = process.env[RESUME_SESSION_ENV] || undefined;
  if (fresh && required) throw new Refusal(`--fresh conflicts with the required lead session ${required}`);
  if (fresh) return undefined;
  const last = lastLead(d, stateDir);
  if (required && (typeof last === "string" || last.sessionId !== required))
    throw new Refusal(
      `cannot resume the required lead session ${required}: ${typeof last === "string" ? last : `the last stopped lead was ${last.sessionId}`}`,
    );
  return typeof last === "string" ? undefined : last;
}
