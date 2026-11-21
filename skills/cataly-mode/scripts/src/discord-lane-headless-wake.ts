import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { HeadlessRuntime, headlessArgv } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { configPath } from "./config.ts";
import { headlessDiscordReceiver } from "./discord-lane-headless-state.ts";
import { exactDiscordLaneTranscript } from "./discord-lane-transcript.ts";
import { wakeCommand } from "./discord-lane-wake-command.ts";
import { wakeLeaseState } from "./discord-lane-wake-lease.ts";
import {
  type DiscordLaneWakeResult,
  completeDiscordWake,
  discordWakeBoundEpoch,
  discordWakeCompletedEpoch,
  discordWakePendingEpoch,
  held,
  sameWakeTarget,
  unconfirmed,
} from "./discord-lane-wake-pending.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sampleHost } from "./host-guard.ts";
import { recordExecution } from "./lane-run.ts";
import { type Lane, sessionFields, statusOf } from "./registry.ts";
import { canLaunch } from "./routing.ts";
import { runtimesOf } from "./run.ts";
import { listSessions } from "./sessions.ts";
import { laneLaunchEnv } from "./slack-token.ts";

export async function attestHeadlessWake(
  deps: FlowDeps,
  lane: Lane,
  ref: SessionRef,
  expectedModel?: string,
): Promise<DiscordLaneWakeResult> {
  const epoch = lane.lifecycleEpoch && discordWakeCompletedEpoch(lane.lifecycleEpoch);
  const { session, sessionFile, cwd } = lane;
  if (!epoch || !session || !sessionFile || !cwd) return held("earlier wake requires inspection");
  const runtime = runtimesOf(deps).for(ref);
  const registration = headlessDiscordReceiver(deps.config.stateDir, lane);
  // The private activation record preserves the selected model from the original start attempt.
  const model =
    expectedModel ??
    (await exactDiscordLaneTranscript(sessionFile, { root: deps.config.sessionsDir, session, cwd }))?.model;
  const state = runtime instanceof HeadlessRuntime ? await runtime.observe(ref) : undefined;
  if (
    !model ||
    !registration ||
    registration.stopped ||
    registration.receiver.retiredGoal !== undefined ||
    registration.receiver.wakeModel !== model ||
    state?.role !== "lane" ||
    state.ref.id !== ref.id ||
    state.ref.runtime !== "headless" ||
    state.status !== "idle" ||
    state.detail !== undefined ||
    state.held !== false ||
    state.dialogs.length ||
    state.pid !== registration.receiver.pid ||
    state.sessionId !== session ||
    state.sessionFile !== sessionFile ||
    state.cwd !== cwd ||
    state.model !== model
  )
    return unconfirmed("waiting for exact live native transcript, receiver and saved model");
  return completeDiscordWake(deps, lane, ref, epoch, session);
}

export async function startHeadlessWake(
  deps: FlowDeps,
  lane: Lane,
  prior: SessionRef,
  reserve: () => void,
): Promise<DiscordLaneWakeResult> {
  const rts = runtimesOf(deps);
  const runtime = rts.for(prior);
  const { stateDir, sessionsDir, agentCommand } = deps.config;
  const session = lane.session;
  const binding = headlessDiscordReceiver(stateDir, lane);
  const goal = binding?.receiver.retiredGoal;
  const command = wakeCommand(agentCommand);
  if (
    !(runtime instanceof HeadlessRuntime) ||
    !session ||
    !binding ||
    binding.stopped?.closedSessionId !== session ||
    (goal !== "none" && goal !== "active" && goal !== "complete" && goal !== "dropped") ||
    !command
  )
    return held("no settled retired native lane identity");
  const { cwd, file } = binding.receiver;
  if (!(await stat(cwd)).isDirectory()) return held("recorded lane directory differs");
  const transcript = await exactDiscordLaneTranscript(file, { root: sessionsDir, session, cwd });
  const model = transcript?.model;
  if (!model) return held("exact saved transcript and model not verified");
  const argv = headlessArgv([...command.launch, "{prompt}"], model);
  const check = { argv: command.lease, session, cwd };
  const scanned = await deps.registry.scan();
  const lanes = scanned.lanes.filter((peer) => statusOf(peer) !== "closed");
  if (
    scanned.unreadable.length ||
    lanes.some(
      (peer) =>
        peer.key !== lane.key &&
        (peer.thread === lane.thread ||
          peer.session === session ||
          (peer.sessionRef?.runtime === "headless" && peer.sessionRef.id === prior.id)),
    )
  )
    return held("native lane owner is ambiguous");
  const peers = await listSessions(rts, { lanes });
  for (const { ref } of peers) {
    if (ref.runtime === "headless" && ref.id === prior.id) return held("registered native session still exists");
    const peer = await rts.for(ref).probe(ref, { foregroundOnly: true });
    if (peer.sessionId === session || peer.status === "unknown") return held("native transcript ownership unverified");
  }
  if (!canLaunch(await sampleHost(deps.run, cwd, rts), deps.config.guard).ok) return held("host launch guard holds");
  if ((await wakeLeaseState(deps, check)) !== "free") return held("OMP session lease is held or unverified");
  const baseEnv = deps.env ?? process.env;
  const env = laneLaunchEnv(baseEnv, baseEnv["CATALY_CONFIG"] ?? configPath(), deps.config);
  const epoch = randomUUID();
  const run = lane.requestId === undefined ? {} : { runId: randomUUID() };
  const intent = await deps.registry.transition(lane, (current) => {
    if (!sameWakeTarget(lane, current)) return null;
    const next = { ...current, ...run, lifecycleEpoch: discordWakePendingEpoch(epoch) };
    recordExecution(stateDir, { ...next, lifecycleEpoch: epoch }, deps.clock.now());
    return next;
  });
  if (!intent) return held("lane changed before wake");
  reserve();
  const ref = await runtime.create({
    name: lane.key,
    cwd,
    env,
    role: "lane",
    container: "tab",
    ...(prior.group ? { group: prior.group } : {}),
  });
  const bound = await deps.registry.transition(intent, (current) =>
    sameWakeTarget(intent, current)
      ? { ...current, ...sessionFields(ref), cwd, sessionFile: file, lifecycleEpoch: discordWakeBoundEpoch(epoch) }
      : null,
  );
  if (!bound) return unconfirmed("lane changed before starting the native session");
  if ((await wakeLeaseState(deps, check)) !== "free")
    return unconfirmed("OMP session acquired another owner during wake");
  await runtime.startNative(
    ref,
    [...argv, "--config", join(import.meta.dir, "discord-lane-wake.yml")],
    {
      ...env,
      CATALY_LANE_RUN: run.runId ?? "",
      CATALY_DISCORD_WAKE_SESSION: session,
      CATALY_DISCORD_WAKE_GOAL: goal,
      CATALY_DISCORD_WAKE_MODEL: model,
    },
    { file, sessionId: session },
  );
  return await attestHeadlessWake(deps, bound, ref, model);
}
