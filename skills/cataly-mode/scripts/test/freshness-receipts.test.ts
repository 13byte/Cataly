import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import { footer } from "../src/launch-footer.ts";
import { parkLane } from "../src/park.ts";
import { type Lane, sessionOf } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { Reports, reportId, reportLine } from "../src/reports.ts";
import {
  depsFor,
  fakeClock,
  type FakeSession,
  nativeLane,
  newWorld,
  sid,
  type TestState,
  withState,
  type World,
} from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const lane: Lane = {
  key: "receipt-lane",
  title: "receipt",
  thread: "discord:123",
  brief: "/b",
  done: "file /done",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};
/** The receipt lane bound to a live native session `sid(7)` in `world`. */
const watched = (world: World, patch: Partial<FakeSession> = {}): Lane => ({ ...lane, ...nativeLane(world, 7, patch) });
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a kind filter without a hook emits one notice for each exact unrelayed report", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { autoPostKinds: [] } });
  await deps.registry.write(watched(world, { status: "working" }));
  const reports = new Reports(state.dir);
  reports.report(lane.key, "blocker", "same detail", T0, undefined, "first summary");
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  reports.report(lane.key, "blocker", "same detail", T0, undefined, "new summary");
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  reports.report(lane.key, "blocker", "same detail", T0 + MIN, undefined, "new summary");
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
});

test("default policy does not repost an identical report just because its timestamp changed", async () => {
  const world = newWorld();
  const clock = fakeClock(T0 + 30 * MIN);
  const deps = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{text}"] } });
  await deps.registry.write(watched(world, { status: "working" }));
  const reports = new Reports(state.dir);
  reports.report(lane.key, "milestone", "tests green", T0);
  expect((await freshnessTick(deps, state.dir)).some((a) => a.kind === "posted")).toBe(true);
  clock.at += 30 * MIN;
  reports.report(lane.key, "milestone", "tests green", clock.at);
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["stale-report"]);
  reports.report(lane.key, "milestone", "tests green", clock.at + 1);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("an acknowledgement arriving during the hook cannot be overwritten by the older post", async () => {
  const world = newWorld();
  const clock = fakeClock(T0 + 30 * MIN);
  const deps = depsFor(world, clock, state.dir, {
    freshness: { nudge: "idle-only" },
    hooks: { threadReply: ["notify"] },
  });
  await deps.registry.write(watched(world, { status: "working" }));
  const reports = new Reports(state.dir);
  reports.report(lane.key, "milestone", "first detail", T0);
  let relayed = "";
  await freshnessTick(
    {
      ...deps,
      run: async (argv, options) => {
        if (argv[0] === "notify") {
          const newer = reports.report(lane.key, "milestone", "second detail", clock.at, undefined, "Second summary");
          relayed = reportId(newer);
          await deps.registry.update(
            lane.key,
            (live) =>
              live && {
                ...live,
                lastPostedReport: reportLine(newer),
                lastPostedReportOwner: newer.owner,
                lastPostedReportId: relayed,
                lastRelayedAt: clock.at,
              },
          );
        }
        return deps.run(argv, options);
      },
    },
    state.dir,
  );
  expect(relayed).not.toBe("");
  expect((await deps.registry.read(lane.key))?.lastPostedReportId).toBe(relayed);
  clock.at += 30 * MIN;
  await freshnessTick(deps, state.dir);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("a receipt changed since the tick snapshot is rechecked before calling the hook", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    freshness: { nudge: "idle-only" },
    hooks: { threadReply: ["notify"] },
  });
  await deps.registry.write(watched(world, { status: "working" }));
  const report = new Reports(state.dir).report(lane.key, "milestone", "detail", T0);
  const read = deps.registry.read.bind(deps.registry);
  let changed = false;
  deps.registry.read = async (key) => {
    const snapshot = await read(key);
    if (!changed) {
      changed = true;
      await deps.registry.update(
        key,
        (live) =>
          live && {
            ...live,
            lastPostedReportId: reportId(report),
            lastPostedReport: reportLine(report),
            lastRelayedAt: T0 + 30 * MIN,
          },
      );
    }
    return snapshot;
  };
  await freshnessTick(deps, state.dir);
  expect(changed).toBe(true);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test("idle-only delivery failure alerts once without consuming the nudge", async () => {
  const world = newWorld();
  // The supervisor refuses the text even though the session looked idle.
  world.deliverOutcome = () => ({ kind: "not-ready", status: "unknown" });
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { nudge: "idle-only" } });
  await deps.registry.write(watched(world));
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["nudge-failed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  expect((await deps.registry.read(lane.key))?.lastNudgeAt).toBeUndefined();
});

test("summary-only launch footer requests the owner field, while the default command stays unchanged", () => {
  expect(footer(lane, "", {}, "headless", { postRaw: false })).toContain('--owner "$owner"');
  expect(footer(lane, "", {}, "headless")).not.toContain('--owner "$owner"');
});

test("an old receipt cannot suppress identical content after the lane is parked and reopened", async () => {
  const world = newWorld();
  const cwd = join(realpathSync(state.dir), "repo");
  mkdirSync(cwd);
  const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
  const file = join(cwd, `2026-01-01T12-00-00-000Z_${session}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: session, cwd })}\n`);
  const now = T0 + 60 * MIN;
  const deps = depsFor(world, fakeClock(now), state.dir, { defaultCwd: cwd, startupWaitSeconds: 1 });
  const reports = new Reports(state.dir);
  const prior = reports.report(lane.key, "milestone", "same detail", now, undefined, "Same summary");
  const original: Lane = {
    ...lane,
    ...nativeLane(world, 7, { sessionId: session, sessionFile: file, cwd }),
    cwd,
    lastPostedReport: reportLine(prior),
    lastPostedReportId: reportId(prior),
    lastPostedReportOwner: prior.owner,
    lastRelayedAt: now,
  };
  await deps.registry.write(original);
  const parked = await parkLane(deps, original, "wait");
  expect(parked.code).toBe(0);
  expect(world.sessions[sid(7)]).toBeUndefined();
  const reopened = await reopenLane(deps, parked.lane);
  expect(reopened.code).toBe(0);
  const epoch = reopened.lane.lifecycleEpoch;
  if (!epoch) throw new Error("expected the reopened lane generation");
  const ref = sessionOf(reopened.lane);
  const resumed = ref && world.sessions[ref.id];
  if (!resumed) throw new Error("expected the reopened native session");
  expect(resumed).toMatchObject({ sessionId: session, sessionFile: file });
  resumed.status = "working";
  const fresh = reports.report(lane.key, prior.kind, prior.text, Date.parse(prior.at), epoch, prior.owner);
  expect(reportId(fresh)).not.toBe(reportId(prior));
  const later = {
    ...deps,
    clock: fakeClock(now + 30 * MIN),
    config: { ...deps.config, nudgeAfterMin: 1000, hooks: { threadReply: ["notify", "{text}"] } },
  };
  const acts = await freshnessTick(later, state.dir);
  expect(acts.map((a) => a.kind)).toEqual(["posted"]);
  expect((await later.registry.read(lane.key))?.lastPostedReportId).toBe(reportId(fresh));
});
