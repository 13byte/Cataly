import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dutyTick } from "../src/duty.ts";
import { flushInbox } from "../src/inbox.ts";
import { inboxList, releaseHeld } from "../src/inbox-held.ts";
import { doneIds } from "../src/inbox-files.ts";
import { formatRef, type SessionRef } from "../src/runtime/types.ts";
import { World, href, sid } from "./fake.ts";

const NEW = href(sid(7));
const SHOWN = formatRef(NEW);
const OLD: SessionRef = { runtime: "herdr", id: "w1:p3" };
const m = (text: string, at = 1) => ({ at, from: "cli", text });

/**
 * A herdr pane an older binary moved to a native session: its old inbox carries a .forward marker naming the new ref,
 * and nothing ever reaches the removed herdr runtime.
 */
function setup(state: "idle" | "working" = "idle") {
  const w = new World();
  const d = w.deps();
  const pane = w.addPane(NEW.id, state);
  const old = d.store.inboxPath(OLD);
  writeFileSync(`${old}.forward`, `${SHOWN}\n`);
  /** What an older binary still does: append to the old file, knowing nothing of the marker. */
  const oldWriter = (msg: ReturnType<typeof m>) => appendFileSync(old, `${JSON.stringify(msg)}\n`);
  return { w, d, pane, old, oldWriter };
}

describe("a forwarded inbox (.forward marker)", () => {
  test("new messages for the old ref go to the new inbox; old-path entries are merged by the next flush, once", async () => {
    const { d, pane, old, oldWriter } = setup();
    await d.store.enqueue(OLD, m("via new binary", 2), false);
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["via new binary"]);
    oldWriter(m("via old binary", 1));
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(pane.received).toHaveLength(1);
    expect(pane.received[0]).toContain("via new binary");
    expect(pane.received[0]).toContain("via old binary");
    expect(d.store.queued(NEW)).toEqual([]);
    expect(d.store.queued(OLD)).toEqual([]);
    expect(existsSync(`${old}.forward`)).toBe(true);
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(pane.received).toHaveLength(1);
  });

  test("an entry already merged by a merge cut short is not added twice", async () => {
    const { d, old, oldWriter } = setup("working");
    d.store.saveInbox(NEW, [m("first", 1)]);
    oldWriter(m("first", 1));
    oldWriter(m("second", 2));
    writeFileSync(`${old}.merging`, `${JSON.stringify(m("first", 1))}\n`);
    expect(await flushInbox(d, NEW)).toBe("queued");
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["first", "second"]);
    expect(existsSync(`${old}.merging`)).toBe(false);
  });

  test("an old-path entry whose id was recorded as delivered is not merged; the id moves with the merge", async () => {
    const { d, pane, old, oldWriter } = setup();
    // A pass that recorded the notice as delivered was stopped before it rewrote the old queue.
    oldWriter({ ...m("[LOST k] gone", 1), id: "lost:k:1" } as ReturnType<typeof m>);
    oldWriter(m("still due", 2));
    writeFileSync(`${old}.ids`, "lost:k:1\n");
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(pane.received).toEqual(["still due"]);
    expect(d.store.enqueueOnce(NEW, { at: 3, from: "duty", text: "[LOST k] gone", id: "lost:k:1" })).toBe(false);
  });

  test("same-tuple notices with distinct ids settle only the eligible id and never replay it", async () => {
    const { d, pane, oldWriter } = setup();
    const msg = { at: 1, from: "duty", text: "[LOST k] gone" };
    const held = {
      ...msg,
      id: "lost:k:first",
      attempt: { at: 2, state: "ambiguous" as const, detail: "timeout" },
    };
    const delivered = { ...msg, id: "lost:k:second" };
    d.store.saveInbox(NEW, [held]);
    oldWriter(delivered);
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(pane.received).toEqual([msg.text]);
    expect(d.store.queued(NEW)).toEqual([held]);
    expect(doneIds(d.store.inboxPath(NEW))).toEqual(new Set([delivered.id]));
    expect(d.store.enqueueOnce(NEW, delivered)).toBe(false);
    // A stopped old writer leaves the delivered copy to be merged again.
    oldWriter(delivered);
    expect(await flushInbox(d, OLD)).toBe("held");
    expect(await flushInbox(d, NEW)).toBe("held");
    expect(d.store.queued(NEW)).toEqual([held]);
    expect(doneIds(d.store.inboxPath(NEW))).toEqual(new Set([delivered.id]));
    expect(pane.received).toEqual([msg.text]);
  });

  test("legacy tuple settlement leaves an identified held notice with the same tuple untouched", async () => {
    const { d, pane, oldWriter } = setup();
    const legacy = m("same legacy tuple");
    const held = {
      ...legacy,
      id: "held:identified",
      attempt: { at: 2, state: "ambiguous" as const, detail: "timeout" },
    };
    d.store.saveInbox(NEW, [held]);
    oldWriter(legacy);
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(d.store.queued(NEW)).toEqual([held]);
    expect(doneIds(d.store.inboxPath(NEW))).toEqual(new Set());
    expect(await flushInbox(d, NEW)).toBe("held");
    expect(pane.received).toEqual([legacy.text]);
  });

  test("inbox list <old ref> shows the moved entries plus those still at the old path, merged once", () => {
    const { d, old, oldWriter } = setup("working");
    d.store.saveInbox(NEW, [m("moved", 1)]);
    oldWriter(m("late", 2));
    const listed = inboxList(d, "w1:p3");
    expect(listed.paneId).toBe(SHOWN);
    expect(listed.entries.map((e) => e.preview)).toEqual(['"moved"', '"late"']);
    expect(d.store.queued(OLD)).toEqual([]);
    expect(existsSync(`${old}.forward`)).toBe(true);
    expect(inboxList(d, "w1:p3").entries).toHaveLength(2);
  });

  test("inbox ack and resend <old ref> <n> act on the moved held entries", () => {
    const { d, oldWriter } = setup("working");
    const held = { at: 3, state: "ambiguous" as const, detail: "timeout" };
    d.store.saveInbox(NEW, [{ ...m("held-a", 1), attempt: held }]);
    oldWriter({ ...m("held-b", 2), attempt: held } as ReturnType<typeof m>);
    expect(releaseHeld(d, "w1:p3", 1, "ack")).toBe(SHOWN);
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["held-b"]);
    expect(releaseHeld(d, "w1:p3", 1, "resend")).toBe(SHOWN);
    expect(d.store.queued(NEW)).toEqual([m("held-b", 2)]);
    expect(d.store.queued(OLD)).toEqual([]);
  });

  test("the duty pass counts held entries where they live now, not at the old path", async () => {
    const { d, pane, oldWriter } = setup("working");
    d.store.saveInbox(NEW, [{ ...m("held", 1), attempt: { at: 3, state: "ambiguous", detail: "timeout" } }]);
    oldWriter(m("waiting", 2));
    expect(await dutyTick(d)).toContainEqual({
      pane: "w1:p3",
      action: "delivery-ambiguous",
      detail: "1 message(s) held, not resent",
    });
    expect(d.store.queued(NEW).map((x) => x.text)).toEqual(["held", "waiting"]);
    expect(pane.received).toEqual([]);
  });

  test("the duty pass finds the old file and flushes it at the new ref", async () => {
    const { d, pane, oldWriter } = setup();
    oldWriter(m("left behind"));
    await dutyTick(d);
    expect(pane.received).toEqual(["left behind"]);
    expect(d.store.inboxPanes()).toEqual([]);
  });
});
