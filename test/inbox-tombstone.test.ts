import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import type { Deps } from "../src/harness.ts";
import { flushInbox } from "../src/inbox.ts";
import { inboxList, releaseHeld } from "../src/inbox-held.ts";
import { readQueue } from "../src/inbox-files.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { drainForward, moveBack, moveInbox } from "../src/migrate-inbox.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";
import { setup } from "./inbox-setup.ts";

// After a migration's final drain the old inbox is closed: only its tombstone (`.migrated`) names the replacement.
// Every path that starts from the old ref must reach the replacement's inbox, never write to or flush the closed one.

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;

async function migrated(d: Deps, from = OLD, to = NEW) {
  await moveInbox(d, from, to, opts);
  await drainForward(d, from, to, opts);
}

describe("an inbox closed by a finished migration", () => {
  test("a duty notice for a lane still recorded on the old ref is queued for the replacement", async () => {
    const s = await quietLane();
    s.w.addPane(NEW.id, "working");
    const old: SessionRef = s.lane.sessionRef;
    await migrated(s.d, old);
    await s.at(10);
    expect(readQueue(s.d.store.inboxPath(old))).toEqual([]);
    expect(s.d.store.queued(NEW).map((m) => m.from)).toEqual(["duty"]);
  });

  test("inbox list and ack on the old ref act on the replacement's queue", async () => {
    const s = setup();
    s.w.addPane(NEW.id, "working");
    await migrated(s.d);
    s.d.store.saveInbox(NEW, [{ at: 1, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    expect(inboxList(s.d, OLD.id)).toMatchObject({ paneId: NEW.id, entries: [{ state: "held" }] });
    expect(releaseHeld(s.d, OLD.id, 1, "ack")).toBe(NEW.id);
    expect(s.d.store.queued(NEW)).toEqual([]);
  });

  test("a flush of the old ref delivers the replacement's queue and leaves the closed inbox unlocked and empty", async () => {
    const s = setup();
    const next = s.w.addPane(NEW.id, "idle");
    await migrated(s.d);
    s.d.store.saveInbox(NEW, [{ at: 1, from: "cli", text: "for the new session" }]);
    expect(await flushInbox(s.d, OLD)).toBe("delivered");
    expect(next.received).toEqual(["for the new session"]);
    expect(s.pane.received).toEqual([]);
    expect(existsSync(`${s.d.store.inboxPath(OLD)}.lock`)).toBe(false);
  });

  test("a later migration back to the old session opens it again; nothing ping-pongs between the two", async () => {
    const s = setup();
    s.w.addPane(NEW.id, "working");
    await migrated(s.d);
    await migrated(s.d, NEW, OLD);
    s.d.store.enqueue(OLD, { at: 2, from: "cli", text: "home again" });
    expect(s.d.store.queued(OLD).map((m) => m.text)).toEqual(["home again"]);
    expect(readdirSync(`${s.d.store.root}/inbox`).filter((f) => f.endsWith(".migrated"))).toEqual([
      "w1_p4.jsonl.migrated",
    ]);
  });

  test("a rollback leaves the old inbox open, even when an earlier migration had closed it", async () => {
    const s = setup();
    s.w.addPane(NEW.id, "working");
    await migrated(s.d);
    await moveInbox(s.d, NEW, OLD, opts);
    await moveBack(s.d, NEW, OLD, opts);
    s.d.store.enqueue(NEW, { at: 2, from: "cli", text: "stays" });
    expect(s.d.store.queued(NEW).map((m) => m.text)).toEqual(["stays"]);
    expect(s.d.store.queued(OLD)).toEqual([]);
  });
});
