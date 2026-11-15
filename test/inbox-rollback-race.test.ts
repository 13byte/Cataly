import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { moveBack, moveInbox } from "../src/migrate-inbox.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { setup } from "./inbox-setup.ts";

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;
const REAL_RM = fs.rmSync;
const REAL_EXISTS = fs.existsSync;

afterEach(() => mock.restore());

/**
 * Runs `during` the first time moveBack removes the old inbox's `.forward` marker: the rollback holds the replacement's
 * inbox lock by then and has moved its spool into its queue once. Returns whether it ran.
 */
function atMarkerRemoval(d: Deps, during: () => void): () => boolean {
  let armed = true;
  spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (armed && String(p) === `${d.store.inboxPath(OLD)}.forward`) {
      armed = false;
      during();
    }
    return REAL_RM(p, o);
  }) as never);
  return () => !armed;
}

const spooled = (d: Deps, ref: SessionRef): string[] => {
  try {
    return fs.readdirSync(`${d.store.inboxPath(ref)}.spool`);
  } catch {
    return [];
  }
};

describe("a rollback that puts the inbox back on the old session", () => {
  test("a send to the replacement after the rollback took its lock waits; nothing is left in its spool", async () => {
    const s = setup();
    s.w.addPane("w1:p4", "idle");
    s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "first" });
    await moveInbox(s.d, OLD, NEW, opts);
    // The sender cannot wait for real while the rollback runs in this thread: it waits out its tries and is refused.
    const waits = spyOn(Bun, "sleepSync").mockImplementation(() => {});
    let sent: unknown;
    const paused = atMarkerRemoval(s.d, () => {
      try {
        sent = s.d.store.enqueue(NEW, { at: s.d.now(), from: "cli", text: "late" });
      } catch (e) {
        sent = e;
      }
    });
    await moveBack(s.d, OLD, NEW, opts);
    expect(paused()).toBe(true);
    expect(waits).toHaveBeenCalled();
    expect(sent).toBeInstanceOf(Refusal);
    expect({ spool: spooled(s.d, NEW), queue: s.d.store.queued(NEW) }).toEqual({ spool: [], queue: [] });
    waits.mockRestore();
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["first"]);
  });

  test("a send to the replacement already writing when the rollback starts is waited for and goes back", async () => {
    const s = setup();
    s.w.addPane("w1:p4", "idle");
    await moveInbox(s.d, OLD, NEW, opts);
    // The sender holds the replacement's route and has found no marker on it; the rollback starts right then.
    let armed = true;
    let rolledBack: Promise<void> = Promise.resolve();
    spyOn(fs, "existsSync").mockImplementation(((p: fs.PathLike) => {
      if (armed && String(p) === `${s.d.store.inboxPath(NEW)}.forward`) {
        armed = false;
        rolledBack = moveBack(s.d, OLD, NEW, opts);
      }
      return REAL_EXISTS(p);
    }) as never);
    expect(s.d.store.enqueue(NEW, { at: s.d.now(), from: "cli", text: "late" })).toBe("queued");
    expect(armed).toBe(false);
    await rolledBack;
    expect({ spool: spooled(s.d, NEW), queue: s.d.store.queued(NEW) }).toEqual({ spool: [], queue: [] });
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["late"]);
  });
});
