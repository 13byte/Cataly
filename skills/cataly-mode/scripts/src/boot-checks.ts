// The boot checks a fresh lead cannot make by itself (#188): lanes whose session is gone while the registry still calls
// them open. Each finding is one line and fails the boot.
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { formatRef, type SessionInfo, type SessionRef } from "../../../../src/runtime/types.ts";
import type { CatalyConfig } from "./config.ts";
import { type BootLane, finished } from "./boot-monitors.ts";
import { reconcilePanes } from "./reconcile.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import type { ChosenRuntimes, Runner } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { listSessions } from "./sessions.ts";

/**
 * `DRIFT n=<count>`: lanes not finished (closed, verified-done, or a done report, the lanes VANISHED skips too) whose session the runtime's own probe reports `gone`. Only lanes the session list
 * no longer shows are probed, so a live lane costs no extra call; a probe that fails is named. Any drift or failed probe fails the boot.
 */
export const driftCheck = async (
  rts: Runtimes,
  lanes: readonly BootLane[],
  sessions: readonly SessionInfo[],
): Promise<{ readonly lines: string[]; readonly failed: boolean }> => {
  const live = new Set(sessions.map((s) => `${s.ref.runtime}:${s.ref.id}`));
  const gone: string[] = [];
  const lines: string[] = [];
  let failed = false;
  for (const lane of lanes) {
    const ref = sessionOf(lane);
    if (!ref || finished(lane) || live.has(`${ref.runtime}:${ref.id}`)) continue;
    try {
      if ((await rts.for(ref).probe(ref)).status === "gone") gone.push(lane.key);
    } catch (e) {
      failed = true;
      lines.push(`DRIFT probe-failed ${lane.key} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return {
    lines: [`DRIFT n=${gone.length}${gone.length ? ` ${gone.join(" ")}` : ""}`, ...lines],
    failed: failed || gone.length > 0,
  };
};

export const bootSessions = async (
  run: Runner,
  config: CatalyConfig,
  rts: ChosenRuntimes,
  registered: readonly Lane[],
  lanes: readonly BootLane[],
  leadRef?: SessionRef,
): Promise<{ lines: string[]; failed: boolean }> => {
  const lines: string[] = [];
  let failed = false;
  let panes: SessionInfo[];
  try {
    const active = registered.filter((lane) => statusOf(lane) !== "closed");
    panes = await listSessions(rts, { lanes: leadRef ? [...active, { sessionRef: leadRef }] : active });
  } catch {
    return { lines: ["PANES unavailable (session list failed)"], failed: true };
  }
  if (
    panes.some(
      (session) => session.ref.runtime === "headless" && (session.status === "unknown" || session.status === "error"),
    )
  ) {
    failed = true;
    lines.push("SESSIONS native state unavailable for one or more addresses; liveness unverified");
  }
  const lead = leadRef ? formatRef(leadRef) : "unconfigured";
  const leadSeen = leadRef && panes.find((session) => formatRef(session.ref) === formatRef(leadRef));
  let leadState = !leadRef ? "unconfigured" : leadSeen ? "live" : "missing";
  if (leadRef?.runtime === "headless") {
    if (!leadSeen) failed = true;
    else if ((await trustedPaneState(run, config.stateDir, leadRef, rts).catch(() => null))?.role !== "cataly") {
      leadState = "unknown";
      failed = true;
    }
  }
  const result = reconcilePanes(lanes, panes);
  const unregistered = result.unregistered.filter(
    (id) => !(leadRef?.runtime === "headless" && leadState === "live" && id === leadRef.id),
  );
  const done = new Set(lanes.filter(finished).map((lane) => lane.key));
  const vanished = result.lanes.filter((lane) => lane.paneState === "vanished" && !done.has(lane.key));
  lines.push(
    `PANES lead=${lead} leadState=${leadState} registeredLive=${result.lanes.filter((l) => l.paneState === "live" && l.status !== "closed").length} vanished=${vanished.length} unregistered=${unregistered.length}`,
  );
  for (const lane of vanished)
    lines.push(
      `VANISHED ${lane.key} pane=${lane.pane} status=${lane.status}; registry and worktrees preserved; no relaunch`,
    );
  if (unregistered.length) lines.push(`UNREGISTERED ${unregistered.join(" ")}`);
  const drift = await driftCheck(rts, lanes, panes);
  return { lines: [...lines, ...drift.lines], failed: failed || drift.failed };
};
