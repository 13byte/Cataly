import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { makeCli } from "../src/cli-context.ts";
import { decisionCommands } from "../src/cli-decisions.ts";
import { parseSkillFlags } from "../src/cli-flags.ts";
import { depsFor, fakeClock, nativeLane, newWorld, sid, type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-04T00:00:00Z");

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("no decision answer or choice grants a native approval: the lane's open approval stays held", async () => {
  // Given a native lane held on an open tool approval.
  const world = newWorld();
  const approval = { id: "approval-1", kind: "approval", title: "Run the migration?" } as const;
  nativeLane(world, 1, { held: true, dialogs: [approval] });
  const before = structuredClone(world.sessions[sid(1)]);
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  /** One `cataly decision` command in process, against the fake supervisor; returns what it printed. */
  const decide = async (...rest: string[]): Promise<string[]> => {
    stdout.mockClear();
    await decisionCommands["decision"]?.(makeCli("decision", rest, parseSkillFlags(rest), deps.config, deps));
    return stdout.mock.calls.map(([line]) => String(line));
  };
  try {
    const ask = ["--source", "d:t/1", "--thread", "d:t", "--option", "yes", "--option", "no"];
    const [ownerLine] = await decide("ask", "Let the lane run the migration?", ...ask);
    const [leadLine] = await decide("ask", "Run the migration now?", ...ask, "--kind", "routine");
    const owner = JSON.parse(ownerLine ?? "");
    const lead = JSON.parse(leadLine ?? "");
    // When the owner answers yes to one and the lead chooses yes on the other.
    const answered = await decide("answer", owner.id, "1", "--source", "d:t/3");
    const chosen = await decide("choose", lead.id, "1", "--reason", "r", "--source", "d:t/5", "--thread", "d:t");
    // Then each prints only its decision, and the supervisor is never asked anything: the approval stays open.
    expect(answered).toHaveLength(1);
    expect(chosen).toHaveLength(1);
    expect(JSON.parse(answered[0] ?? "")).toMatchObject({ answer: "1", option: 1, authority: "owner" });
    expect(JSON.parse(chosen[0] ?? "")).toMatchObject({ answer: "yes", option: 1, authority: "lead" });
    expect(world.calls).toEqual([]);
    expect(world.sessions[sid(1)]).toEqual(before);
  } finally {
    stdout.mockRestore();
  }
});
