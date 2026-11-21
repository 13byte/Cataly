import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { recordExecution } from "./lane-run.ts";
import { type Lane, sameLaneGeneration, sessionOf, statusOf } from "./registry.ts";

export type DiscordLaneWakeResult =
  | { readonly kind: "started"; readonly ref: SessionRef }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "unconfirmed"; readonly reason: string };

export const held = (reason: string): DiscordLaneWakeResult => ({ kind: "held", reason });
export const unconfirmed = (reason: string): DiscordLaneWakeResult => ({ kind: "unconfirmed", reason });

const PREFIX = "discord-wake-pending:";
const BOUND_PREFIX = `${PREFIX}bound:`;

export const isDiscordWakePending = (epoch: string | undefined): boolean => epoch?.startsWith(PREFIX) === true;

export const discordWakePendingEpoch = (epoch: string): string => PREFIX + epoch;

export const discordWakeBoundEpoch = (epoch: string): string => BOUND_PREFIX + epoch;

export const discordWakeCompletedEpoch = (epoch: string): string | undefined =>
  epoch.startsWith(BOUND_PREFIX) ? epoch.slice(BOUND_PREFIX.length) : undefined;

export function sameWakeTarget(seen: Lane, current: Lane): boolean {
  const before = sessionOf(seen);
  const now = sessionOf(current);
  const status = statusOf(current);
  return (
    sameLaneGeneration(seen, current) &&
    (status === "working" || status === "not-done") &&
    !current.hold &&
    !current.nativeCloseIntent &&
    before?.runtime === now?.runtime &&
    before?.id === now?.id &&
    before?.group === now?.group &&
    seen.thread === current.thread &&
    seen.session === current.session &&
    seen.sessionFile === current.sessionFile &&
    seen.cwd === current.cwd
  );
}

export async function completeDiscordWake(
  deps: FlowDeps,
  lane: Lane,
  ref: SessionRef,
  epoch: string,
  session: string,
): Promise<DiscordLaneWakeResult> {
  const completed = await deps.registry.transition(lane, (current) => {
    if (!sameWakeTarget(lane, current)) return null;
    const next = { ...current, lifecycleEpoch: epoch };
    // Bind the final reporting generation to the exact attested OMP session.
    recordExecution(deps.config.stateDir, next, deps.clock.now(), session);
    return next;
  });
  return completed ? { kind: "started", ref } : unconfirmed("the lane changed during startup attestation");
}
