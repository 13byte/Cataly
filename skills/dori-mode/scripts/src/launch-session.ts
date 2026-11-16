import { realpathSync, renameSync, rmSync } from "node:fs";

import { type CreateSpec, formatRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { type Lane, type Registry, sessionFields } from "./registry.ts";
import type { ChosenRuntimes } from "./run.ts";

export type OpenedLane =
  | { readonly kind: "opened"; readonly lane: Lane; readonly ref: SessionRef }
  | { readonly kind: "taken" }
  | { readonly kind: "failed"; readonly what: string; readonly error: unknown };

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// A brief that is a link (a shared template) is written through it, as a plain write would.
const briefTarget = (brief: string): string => {
  try {
    return realpathSync(brief);
  } catch {
    return brief;
  }
};

/**
 * Opens a lane's session and registers it before its agent starts (dori report refuses an unknown key, so a fast
 * lane's first report would be lost). The brief is staged beside its path first, so a full disk or an unwritable
 * directory fails before anything exists, and it replaces the brief only once this launch owns the key. A key that
 * another launch or adopt registered meanwhile is `taken`: its record and brief stay. Whenever this launch does not
 * open, it closes the session it created and removes its staged brief and its own record.
 */
export const openLaneSession = async (
  registry: Registry,
  rts: ChosenRuntimes,
  spec: CreateSpec,
  draft: Lane,
  brief: string,
  preamble: string,
): Promise<OpenedLane> => {
  const target = briefTarget(brief);
  const staged = `${target}.${process.pid}.launch`;
  try {
    await Bun.write(staged, preamble);
  } catch (error) {
    rmSync(staged, { force: true });
    return { kind: "failed", what: "brief not writable", error };
  }
  let ref: SessionRef;
  try {
    ref = await rts.default.create(spec);
  } catch (error) {
    rmSync(staged, { force: true });
    return { kind: "failed", what: "session create failed", error };
  }
  const lane: Lane = { ...draft, ...sessionFields(ref) };
  let registered = false;
  let failure: OpenedLane = { kind: "taken" };
  try {
    registered = await registry.create(lane);
    if (registered) {
      renameSync(staged, target);
      return { kind: "opened", lane, ref };
    }
  } catch (error) {
    failure = { kind: "failed", what: registered ? "brief not written" : "lane not registered", error };
  }
  rmSync(staged, { force: true });
  if (registered)
    await registry.discard(lane).catch((error: unknown) => {
      process.stderr.write(`dori: could not remove lane ${lane.key} after its launch failed (${why(error)})\n`);
    });
  await rts
    .for(ref)
    .close(ref, ref.container ? "container" : "session")
    .catch((error: unknown) => {
      process.stderr.write(
        `dori: could not close ${formatRef(ref)} after lane ${lane.key} did not open (${why(error)})\n`,
      );
    });
  return failure;
};
