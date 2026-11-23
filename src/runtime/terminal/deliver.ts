import type { AgentIdentity, Probe } from "../types.ts";

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
export const PASTE_SETTLE_MS = 400;
/** How often the Enter that submits typed fallback text is tried before the delivery is reported as failed. */
export const ENTER_ATTEMPTS = 3;

export type Sleep = (ms: number) => Promise<void>;

/** The agent a probe saw: what submitTyped must find again before an Enter may land (#108). */
export const identity = (seen: Probe): AgentIdentity => ({
  ...(seen.agent !== undefined ? { agent: seen.agent } : {}),
  ...(seen.pgid !== undefined ? { pgid: seen.pgid } : {}),
  ...(seen.pid !== undefined ? { pid: seen.pid } : {}),
  ...(seen.sessionId !== undefined ? { sessionId: seen.sessionId } : {}),
});
/** True when the probe still shows the agent `into` names; a field it does not record is not compared. */
export const sameAgent = (into: AgentIdentity, seen: Probe): boolean =>
  (into.agent === undefined || into.agent === seen.agent) &&
  (into.pgid === undefined || into.pgid === seen.pgid) &&
  (into.pid === undefined || into.pid === seen.pid) &&
  (into.sessionId === undefined || into.sessionId === seen.sessionId);
