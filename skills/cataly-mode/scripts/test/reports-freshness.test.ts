import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import { Reports } from "../src/reports.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, type FakeSession, nativeLane, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const MIN = 60_000;

const lane: Lane = {
  key: "report-lane",
  title: "reports",
  thread: "chat:team/1",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};
/** The report lane bound to a live native session `sid(7)` in `world`. */
const watched = (world: World, patch: Partial<FakeSession> = {}): Lane => ({ ...lane, ...nativeLane(world, 7, patch) });

let state: ReturnType<typeof withState>;

let reports: Reports;

beforeEach(() => {
  state = withState();
  reports = new Reports(state.dir);
});

afterEach(() => state.done());

test("compaction failure stalls immediately and Working resumes progress", async () => {
  // Given a fresh running lane.
  await reports.report(lane.key, "milestone", "started", T0);
  // When compaction fails and subsequently real activity resumes.
  expect((await reports.observe(lane.key, "Error: compaction failed\n❯ ", T0 + MIN, 15 * MIN))?.state).toBe("stalled");
  expect((await reports.observe(lane.key, "Working (2s)\n❯ ", T0 + 2 * MIN, 15 * MIN))?.state).toBe("running");
  // Then the last report still supplies the report clock.
  expect(reports.read(lane.key)?.lastReport?.at).toBe(new Date(T0).toISOString());
});

test("a compaction error left above a later Working line does not keep the lane stalled", async () => {
  // Given a lane that stalled on a compaction failure.
  await reports.report(lane.key, "milestone", "started", T0);
  expect((await reports.observe(lane.key, "Error: compaction failed\n❯ ", T0 + MIN, 15 * MIN))?.state).toBe("stalled");
  // When it recovers while the old error is still on screen; then Working below it wins.
  expect(
    (await reports.observe(lane.key, "Error: compaction failed\n❯ retry\nWorking (3s)\n❯ ", T0 + 2 * MIN, 15 * MIN))
      ?.state,
  ).toBe("running");
  // And a new failure below the Working line stalls it again.
  expect(
    (await reports.observe(lane.key, "Working (3s)\nauto-compaction failed\n❯ ", T0 + 3 * MIN, 15 * MIN))?.state,
  ).toBe("stalled");
});

test("only a stale idle prompt stalls and repeated observations do not grow the log", async () => {
  // Given a milestone with a fresh prompt.
  await reports.report(lane.key, "milestone", "started", T0);
  expect((await reports.observe(lane.key, "❯ ", T0 + MIN, 15 * MIN))?.state).toBe("running");
  // When the same prompt outlives the freshness threshold.
  expect((await reports.observe(lane.key, "❯ ", T0 + 16 * MIN, 15 * MIN))?.state).toBe("stalled");
  await reports.observe(lane.key, "❯ ", T0 + 17 * MIN, 15 * MIN);
  // Then one state transition, rather than every poll, is persisted.
  expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(2);
});

test.each(["blocker", "halted", "done"] as const)(
  "pane activity cannot overwrite a declared %s state",
  async (kind) => {
    // Given explicit lane intent.
    await reports.report(lane.key, kind, "paused", T0);
    const expected = reports.read(lane.key)?.state;
    // When the pane still shows Working or a compaction failure.
    await reports.observe(lane.key, "Working (25m)\ncompaction failed\n❯ ", T0 + 30 * MIN, 15 * MIN);
    // Then intent takes precedence over stale screen content.
    expect(new Reports(state.dir).read(lane.key)?.state).toBe(expected);
  },
);

test("freshness forwards a durable report after it has scrolled off the session output", async () => {
  // Given a stale report, but an actively working session with no report text.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 21 * MIN), state.dir, {
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  await deps.registry.write({ ...watched(world, { status: "working" }), lastNudgeAt: T0 + 20 * MIN });
  await reports.report(lane.key, "milestone", "all checks green", T0);
  // When freshness reads its authoritative journal.
  const acts = await freshnessTick(deps, "/home/test");
  // Then forwarding uses the report, never NO-REPORT.
  expect(acts.map((act) => act.kind)).toEqual(["posted"]);
  expect(world.calls.find((call) => call[0] === "notify")?.[2]).toContain("all checks green");
});

test("new report time suppresses nudges even when registry lastReplyAt is old", async () => {
  // Given a newly reported milestone, an old registry timestamp and an idle session that could take a nudge.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write(watched(world));
  await reports.report(lane.key, "milestone", "just completed step", T0 + 29 * MIN);
  // When freshness runs; then no stale-registry nudge is sent.
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
});

test("a stalled structured lane alerts once even without a thread hook", async () => {
  // Given a lane whose one native call has run past the hung threshold without fresh progress.
  const world = newWorld();
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir);
  await deps.registry.write({ ...watched(world, { status: "working", activeSince: T0 }), thread: "none" });
  await reports.report(lane.key, "milestone", "started", T0);
  // When observed past the stale threshold after its baseline sample; then one alert is emitted and no input is
  // injected.
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  clock.at += 20 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["stalled"]);
  clock.at += MIN;
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
});

test.each(["blocker", "halted", "done", "question"] as const)(
  "a %s report still reaches the thread, but the lane is not nudged",
  async (kind) => {
    // Given a lane that declared %s and then stayed silent and idle past both thresholds.
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
      hooks: { threadReply: ["notify", "{thread}", "{text}"] },
    });
    await deps.registry.write(watched(world));
    await reports.report(lane.key, kind, "needs the owner", T0);
    // When freshness runs; then the report is posted and nothing is sent to the session.
    expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
    expect(world.calls.find((call) => call[0] === "notify")?.[2]).toContain("needs the owner");
    expect(sent(world)).toEqual([]);
  },
);

test("a lane that reports every 10 minutes still gets its latest report posted, at most once per postAfterMin", async () => {
  // Given a working lane whose reports keep the nudge clock fresh while its thread stays quiet.
  const world = newWorld();
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps.registry.write(watched(world, { status: "working" }));
  await reports.report(lane.key, "milestone", "step one", T0 + 5 * MIN);
  await reports.report(lane.key, "milestone", "step two", T0 + 15 * MIN);
  const posts = () => world.calls.filter((call) => call[0] === "notify").map((call) => call[2]);
  // When freshness runs 21 minutes after launch; then the latest report is posted.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  expect(posts().at(-1)).toContain("step two");
  // And a newer report waits until the thread has been quiet for postAfterMin again.
  await reports.report(lane.key, "milestone", "step three", T0 + 30 * MIN);
  clock.at = T0 + 31 * MIN;
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  clock.at = T0 + 41 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  expect(posts()).toHaveLength(2);
  expect(posts().at(-1)).toContain("step three");
});

test("a report written in the same millisecond as the last post is still posted later, once", async () => {
  // Given a post at T0+21 and a blocker the working lane writes in that same millisecond, just after the tick.
  const world = newWorld();
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps.registry.write(watched(world, { status: "working" }));
  await reports.report(lane.key, "milestone", "step one", T0 + 15 * MIN);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  await reports.report(lane.key, "blocker", "needs the owner", T0 + 21 * MIN);
  // When the thread has been quiet for postAfterMin again; then the blocker is posted, and only once.
  clock.at = T0 + 45 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  clock.at = T0 + 70 * MIN;
  await freshnessTick(deps, "/home/test");
  const posts = world.calls.filter((call) => call[0] === "notify").map((call) => call[2]);
  expect(posts).toHaveLength(2);
  expect(posts.at(-1)).toContain("needs the owner");
});

test("structured lanes never fall back to report-like session output", async () => {
  // Given a lane with no journal whose recent output only quotes the report grammar.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  const recent = [`[REPORT] ${lane.key} | done | example, not durable`];
  await deps.registry.write({ ...watched(world, { status: "working", recent }), lastNudgeAt: T0 + 29 * MIN });
  // When forwarding is due; then the missing journal remains explicit.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["no-report"]);
  expect(world.calls.some((call) => call[0] === "notify")).toBe(false);
});
