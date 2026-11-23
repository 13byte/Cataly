import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { report, startLane } from "../src/lanes.ts";
import { LEAD, LEAD_REF, setup } from "./harness-setup.ts";

const lead1 = LEAD_REF;

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { group: "w1" });
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: `tern:${LEAD}`, action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("an empty or blank --text is refused by send, report and ready; nothing is queued or delivered", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { group: "w1" });
    lead.received.length = 0;
    for (const argv of [
      ["send", "lead", "--text", ""],
      ["send", "lead", "--text", "  \n "],
      ["report", "a-lane", "--text", ""],
      ["ready", "a-lane", "--text", " ", "--evidence", "https://example.com/pr/1"],
    ]) {
      await expect(main(argv, d)).rejects.toThrow("the message is empty");
    }
    expect(lead.received).toEqual([]);
    expect(d.store.queued(lead1)).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});
