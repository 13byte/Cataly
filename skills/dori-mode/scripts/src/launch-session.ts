import { renameSync, rmSync } from "node:fs";

import { type CreateSpec, formatRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { type Lane, type Registry, sessionFields } from "./registry.ts";
import type { ChosenRuntimes } from "./run.ts";

export type OpenedLane =
  | { readonly kind: "opened"; readonly lane: Lane; readonly ref: SessionRef }
  | { readonly kind: "taken" }
  | { readonly kind: "create-failed"; readonly error: unknown };

/**
 * Opens a lane's session and registers it before its agent starts (dori report refuses an unknown key, so a fast
 * lane's first report would be lost). The brief is staged beside its path first, so a full disk or an unwritable
 * directory fails before anything exists, and it replaces the brief only once this launch owns the key. A key that
 * another launch or adopt registered meanwhile is `taken`: its record and brief stay, and the session opened here is
 * closed.
 */
export const openLaneSession = async (
  registry: Registry,
  rts: ChosenRuntimes,
  spec: CreateSpec,
  draft: Lane,
  brief: string,
  preamble: string,
): Promise<OpenedLane> => {
  const staged = `${brief}.${process.pid}.launch`;
  await Bun.write(staged, preamble);
  let ref: SessionRef;
  try {
    ref = await rts.default.create(spec);
  } catch (error) {
    rmSync(staged, { force: true });
    return { kind: "create-failed", error };
  }
  const lane: Lane = { ...draft, ...sessionFields(ref) };
  if (!(await registry.create(lane))) {
    rmSync(staged, { force: true });
    await rts
      .for(ref)
      .close(ref, ref.container ? "container" : "session")
      .catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        process.stderr.write(`dori: could not close ${formatRef(ref)} after lane ${draft.key} was refused (${why})\n`);
      });
    return { kind: "taken" };
  }
  renameSync(staged, brief);
  return { kind: "opened", lane, ref };
};
