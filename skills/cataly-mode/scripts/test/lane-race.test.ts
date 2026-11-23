import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { launchLane } from "../src/launch.ts";
import { pauseLane } from "../src/pause.ts";
import { type Lane, statusOf, withStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { type Runner, runtimesOf } from "../src/run.ts";
import { closableLane } from "./native-close-fixture.ts";
import { depsFor, fakeClock, newWorld, sid, type TestState, withState, type World } from "./fakes.ts";

// Another writer (a CLI claim, objection or resume) lands while a sweep awaits native, git or hook I/O. Each test
// injects that write at one exact call of the fake runner or the fake supervisor, so the interleaving is the same on
// every run.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;

let state: TestState;
let world: World;
/** The race lane on live native session 1. */
let lane: Lane;
beforeEach(() => {
  state = withState();
  world = newWorld();
  lane = {
    key: "race-lane",
    title: "race",
    thread: "none",
    brief: "/b.md",
    done: "closed acme/app#1",
    openedAt: new Date(T0).toISOString(),
    ...closableLane(world, 1, join(state.dir, "repo")),
  };
  // Session 1 is the lane's: a reservation gets the next one.
  world.next = 1;
});
afterEach(() => state.done());

/** `base` with `write` run once, before the first runner call that `at` matches. */
const interleaved = (base: FlowDeps, at: (argv: readonly string[]) => boolean, write: () => Promise<unknown>) => {
  let pending = true;
  const run: Runner = async (argv, opts) => {
    if (pending && at(argv)) {
      pending = false;
      await write();
    }
    return base.run(argv, opts);
  };
  return { ...base, run };
};
/** `write` run once, before the first `op` call reaches the fake supervisor of `base`. */
const beforeNative = (base: FlowDeps, op: "observe" | "deliver" | "setGoal", write: () => Promise<unknown>): void => {
  const runtime = runtimesOf(base).default;
  const original = (runtime as unknown as Record<typeof op, (...args: unknown[]) => Promise<unknown>>)[op];
  let pending = true;
  spyOn(runtime as unknown as Record<typeof op, (...args: unknown[]) => Promise<unknown>>, op).mockImplementation(
    async (...args: unknown[]) => {
      if (pending) {
        pending = false;
        await write();
      }
      return original.apply(runtime, args);
    },
  );
};
const stored = async (deps: FlowDeps): Promise<Lane> => (await deps.registry.read(lane.key)) ?? lane;
const sessionCloses = () => world.calls.filter((c) => c[0] === "headless" && c[1] === "close");

test("a nudge recorded after its native delivery keeps a done claim written meanwhile", async () => {
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { nudgeAfterMin: 1, postAfterMin: 999 });
  const reporting: Lane = { ...lane, reportProtocol: "jsonl-v1" };
  await deps.registry.write(reporting);
  beforeNative(deps, "deliver", async () => claimDone(deps, await stored(deps), "merged during the nudge"));

  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);

  const after = await stored(deps);
  expect(statusOf(after)).toBe("done-claimed");
  expect(after.claim?.evidence).toBe("merged during the nudge");
  expect(after.lastNudgeAt).toBe(T0 + 30 * MIN);
});

test("the watcher does not close a lane objected to while its git state was read", async () => {
  const base = depsFor(world, fakeClock(T0 + 6 * MIN), state.dir, { closeAfterMin: 5 });
  const claim = { at: new Date(T0).toISOString(), evidence: "finished", emitted: true };
  await base.registry.write({ ...lane, status: "done-claimed", claim });
  const deps = interleaved(
    base,
    (argv) => argv[0] === "git" && argv.includes("worktree") && argv.includes("list"),
    async () => objectDone(base, await stored(base), ["owner objection before closure"]),
  );

  const lines = await watchTick(deps);

  expect(lines).toEqual([
    "LANE_CHANGED race-lane moved on while this ran (now not-done, was done-claimed); verification not recorded",
  ]);
  expect(statusOf(await stored(deps))).toBe("not-done");
  expect((await stored(deps)).objection?.reasons).toEqual(["owner objection before closure"]);
  expect(sessionCloses()).toEqual([]);
});

test("a close is refused, before the session is closed, when an objection lands during the Done signal read", async () => {
  const base = depsFor(world, fakeClock(T0), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
  await base.registry.write({ ...lane, thread: "chat:team/1" });
  const deps = interleaved(
    base,
    (argv) => argv[0] === "gh",
    async () => objectDone(base, await stored(base), ["not merged yet"]),
  );

  const result = await closeLane(deps, { ...lane, thread: "chat:team/1" }, "closed by the lead");

  expect(result.closed).toBe(false);
  expect(result.lines.at(-1)).toBe(
    "LANE_CHANGED race-lane moved on while this ran (now not-done, was working); close not recorded",
  );
  expect(statusOf(await stored(deps))).toBe("not-done");
  expect(sessionCloses()).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toEqual([]);
});

test("a close of a not-done lane is refused when a new objection lands during the Done signal read", async () => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  const at = new Date(T0).toISOString();
  const objected = withStatus(lane, "not-done", "tests fail", at, { objection: { at, reasons: ["tests fail"] } });
  await base.registry.write(objected);
  const deps = interleaved(
    base,
    (argv) => argv[0] === "gh",
    async () => objectDone(base, await stored(base), ["still not merged"]),
  );

  const result = await closeLane(deps, objected, "closed by the lead");

  expect(result.closed).toBe(false);
  expect(result.lines.at(-1)).toBe(
    "LANE_CHANGED race-lane moved on while this ran (now not-done, was not-done); close not recorded",
  );
  const after = await stored(deps);
  expect(statusOf(after)).toBe("not-done");
  expect(after.objection?.reasons).toEqual(["still not merged"]);
  expect(sessionCloses()).toEqual([]);
});

test("a launch keeps an uncoordinated registry writer's registered and objected record", async () => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "brief");
  world.onCreate = async () => {
    await base.registry.create({ ...lane, title: "registered meanwhile", cwd: base.config.defaultCwd });
    await objectDone(base, await stored(base), ["registered lane objected"]);
  };

  await expect(launchLane(base, { key: lane.key, title: "race", brief, done: lane.done })).rejects.toThrow(
    "lane race-lane is already registered",
  );

  const after = await stored(base);
  expect(after.title).toBe("registered meanwhile");
  expect(statusOf(after)).toBe("not-done");
  expect(after.objection?.reasons).toEqual(["registered lane objected"]);
  expect(sessionCloses()).toEqual([["headless", "close", sid(2)]]);
  expect(readFileSync(brief, "utf8")).toBe("brief");
});

test("a paused lane resumed during the freshness status read is not turned back to paused", async () => {
  const session = world.sessions[sid(1)];
  if (session) session.status = "working";
  const deps = depsFor(world, fakeClock(T0 + MIN), state.dir);
  await deps.registry.write({ ...lane, status: "paused", pausedFrom: "working" });
  beforeNative(deps, "observe", async () =>
    deps.registry.write(withStatus(await stored(deps), "working", "resumed", new Date(T0).toISOString())),
  );

  await freshnessTick(deps, "/home/test");

  const after = await stored(deps);
  expect(statusOf(after)).toBe("working");
  expect(after.pausedSeenWorking).toBeUndefined();
});

test("a done claim written while /goal pause is confirmed is not overwritten with paused", async () => {
  const deps = depsFor(world, fakeClock(T0 + MIN), state.dir);
  await deps.registry.write(lane);
  beforeNative(deps, "setGoal", async () => {
    const at = new Date(T0).toISOString();
    await deps.registry.write(withStatus(lane, "done-claimed", "done", at, { claim: { at, evidence: "done" } }));
  });

  const r = await pauseLane(deps, lane, "owner said wait");

  expect(r.code).toBe(3);
  expect(r.lines).toEqual([
    "LANE_CHANGED race-lane moved on while this ran (now done-claimed, was working); pause (its goal is paused) not recorded",
  ]);
  expect(world.sessions[sid(1)]?.goal?.status).toBe("paused");
  expect(statusOf(await stored(deps))).toBe("done-claimed");
  expect((await stored(deps)).claim?.evidence).toBe("done");
});

test("a failed thread hook leaves the report unposted and the next tick sends it again", async () => {
  const clock = fakeClock(T0 + 30 * MIN);
  const base = depsFor(world, clock, state.dir, {
    nudgeAfterMin: 999,
    postAfterMin: 1,
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  const reporting: Lane = { ...lane, thread: "telegram:1/2", reportProtocol: "jsonl-v1" };
  await base.registry.write(reporting);
  await new Reports(state.dir).report(reporting.key, "blocker", "needs owner decision", T0);
  const outcomes = [{ code: 1, out: "", err: "token=synthetic-private /home/test/secret w1:p9" }];
  const hookCalls: string[][] = [];
  const deps: FlowDeps = {
    ...base,
    run: async (argv, opts) => {
      if (argv[0] !== "notify") return base.run(argv, opts);
      hookCalls.push([...argv]);
      return outcomes.shift() ?? { code: 0, out: "", err: "" };
    },
  };

  expect(await freshnessTick(deps, "/home/test")).toEqual([
    { kind: "post-failed", lane: reporting.key, detail: "thread hook failed (exit 1)" },
  ]);
  const unposted = await stored(deps);
  expect([unposted.lastPostedReport, unposted.lastAutoReplyAt]).toEqual([undefined, undefined]);

  clock.at += 2 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["posted"]);
  expect((await stored(deps)).lastPostedReport).toBe("[REPORT] race-lane | blocker | needs owner decision");
  clock.at += 2 * MIN;
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(hookCalls).toHaveLength(2);
});
