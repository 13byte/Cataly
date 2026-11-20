import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import { formatRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { recordExecution } from "./lane-run.ts";
import { lastLines } from "./launch-finished.ts";
import type { LaunchInput } from "./launch-input.ts";
import { type OpenedLane, startLaunchRun } from "./launch-session.ts";
import { type Lane, sessionOf } from "./registry.ts";
import { Reports } from "./reports.ts";
import { type ChosenRuntimes, iso } from "./run.ts";

class HeadlessStartupError extends Error {}

export const startHeadless = async (
  deps: FlowDeps,
  input: LaunchInput,
  {
    opened: { lane, ref },
    rts,
    argv,
    env,
  }: {
    readonly opened: Extract<OpenedLane, { kind: "opened" }>;
    readonly rts: ChosenRuntimes;
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  },
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const target = `${input.key} ${formatRef(ref)}`;
  let bound = lane;
  try {
    const runtime = rts.for(ref);
    if (ref.runtime !== "headless" || lane.lifecycleEpoch !== ref.id || !(runtime instanceof HeadlessRuntime))
      throw new HeadlessStartupError("headless lane runtime unavailable");
    const provenance = lane.requestId === undefined ? undefined : await startLaunchRun(deps, lane);
    if (provenance === null) throw new HeadlessStartupError("lane generation changed before native start");
    const seen = await runtime.startNative(ref, argv, { ...env, DORI_LANE_RUN: provenance?.runId ?? "" });
    const { sessionId: session, sessionFile, pid } = seen;
    if (
      seen.ref.runtime !== ref.runtime ||
      seen.ref.id !== ref.id ||
      seen.role !== "lane" ||
      seen.detail !== undefined ||
      (seen.status !== "idle" && seen.status !== "working" && seen.status !== "blocked") ||
      !session ||
      !sessionFile ||
      pid === undefined ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      realpathSync(seen.cwd) !== realpathSync(lane.cwd ?? deps.config.defaultCwd)
    )
      throw new HeadlessStartupError("native lane identity is unconfirmed");
    const ready =
      seen.held === false && seen.dialogs.length === 0 && seen.status === "idle" && seen.goal?.status === "none";
    // Bind the broker-proven transcript and execution before a turn can report or claim done.
    const confirmed = await deps.registry.transition(lane, (current) => {
      const live = sessionOf(current);
      if (
        live?.runtime !== ref.runtime ||
        live.id !== ref.id ||
        current.nativeCloseIntent ||
        current.session ||
        current.requestId !== lane.requestId ||
        current.runId !== lane.runId
      )
        return null;
      if (provenance && ready) recordExecution(deps.config.stateDir, current, deps.clock.now(), session);
      return { ...current, session, sessionFile, sessionVia: "rpc-ui" };
    });
    if (!confirmed) throw new HeadlessStartupError("lane generation changed before native kickoff");
    bound = confirmed;
    if (!ready) throw new HeadlessStartupError("native lane is held or not ready for kickoff");
    new Reports(deps.config.stateDir).append({
      type: "activity",
      key: lane.key,
      at: iso(deps.clock),
      state: "running",
      text: `lane launched in ${formatRef(ref)}`,
      generation: ref.id,
      ...(provenance
        ? {
            provenance: { ...provenance, nativeRef: { sessionId: session, ref: { runtime: ref.runtime, id: ref.id } } },
          }
        : {}),
    });
    // The broker rechecks the exact session, approval and settled state before creating the goal.
    const started = await runtime.begin(
      ref,
      session,
      `Read and execute the lane brief at ${resolve(input.brief)} in full. You are the ${input.key} lane; report as the brief's footer says. Done = ${input.done}`,
    );
    if (
      started.ref.runtime !== ref.runtime ||
      started.ref.id !== ref.id ||
      started.role !== "lane" ||
      started.detail !== undefined ||
      started.sessionId !== session ||
      started.sessionFile !== sessionFile ||
      started.pid !== pid ||
      started.held !== false ||
      started.dialogs.length ||
      (started.goal?.status !== "active" && started.goal?.status !== "complete") ||
      (started.status !== "idle" && started.status !== "working")
    )
      throw new HeadlessStartupError("native goal was acknowledged but lane readiness is unconfirmed");
    return { lane: bound, startup: `STARTUP_OK ${target}` };
  } catch (error) {
    // No retry: goal creation could have landed. Keep the registered and inspectable identity.
    return { lane: bound, startup: `STARTUP_UNCONFIRMED ${target}: ${lastLines(String(error))}` };
  }
};
