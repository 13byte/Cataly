import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { finished } from "../src/boot-monitors.ts";
import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { openDiscordLaneInbox } from "../src/messenger/discord-lane-inbox.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { Reports, reportId } from "../src/reports.ts";
import { closableLane } from "./native-close-fixture.ts";
import { depsFor, fakeClock, newWorld, sent, sid, type TestState, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;

let state: TestState;
let world: World;
/** The demo lane on live native session 1, working in `repo`. */
let lane: Lane;
let repo: string;
const at = (ms: number) =>
  depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "headless" && c[1] === "close");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  const bound = closableLane(world, 1, join(state.dir, "repo"));
  repo = bound.cwd ?? "";
  lane = {
    key: "demo-lane",
    title: "demo",
    thread: "chat:team/123",
    brief: "/briefs/demo.md",
    done: "merged acme/app#1; closed acme/app#2",
    openedAt: new Date(T0 - 60 * MIN).toISOString(),
    ...bound,
  };
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  // This scenario confirms the claim notice; uncertain notifications are fenced in tell-fence-flow.test.ts.
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("a recorded claim runs its follow-up even when telling the lane throws; a claim that lost the race runs none", async () => {
  // The native supervisor stops answering while the claim notice is delivered.
  world.deliverOutcome = () => {
    throw new Error("supervisor timed out");
  };
  const followed: string[] = [];
  await expect(claimDone(at(T0), lane, "merged acme/app#1", () => followed.push("first"))).rejects.toThrow(
    "supervisor timed out",
  );
  // The notice was attempted once and never retried.
  expect(sent(world)).toHaveLength(1);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("done-claimed");
  expect(followed).toEqual(["first"]);
  // The stale record no longer matches the stored lane: nothing is recorded and nothing follows.
  expect(await claimDone(at(T0), lane, "again", () => followed.push("second"))).toStartWith("LANE_CHANGED");
  expect(followed).toEqual(["first"]);
});

test("five quiet minutes after a claim the lane is closed, its thread marked done and its worktree removed", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual([`LANE_DONE_CLAIMED demo-lane ${sid(1)} merged acme/app#1 abc123`]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["headless", "close", sid(1)]]);
  expect(world.calls).toContainEqual(["notify", "chat:team/123", "Done: merged acme/app#1 abc123"]);
  expect(world.calls).toContainEqual(["git", "-C", repo, "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

// A lane that never created a worktree works straight in its cwd. discoverWorktrees only returns
// worktrees named after the lane key, so that lane used to be checked nowhere and closed on dirty work.
test("a lane with no worktree of its own is still checked in its cwd", async () => {
  world.worktreeList = `worktree ${repo}\nbranch refs/heads/main`;
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${repo}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a lane whose worktree is clean is not blocked by the human's checkout", async () => {
  world.dirty = { [WT]: "", [repo]: " M notes/todo.md" };
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await watchTick(at(T0 + 4 * MIN));
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("a cwd that is not a git checkout raises no objection of its own", async () => {
  world.worktreeList = "";
  world.isGitRepo = "false";
  world.dirty = "";
  world.aheadCount = "0";
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await watchTick(at(T0 + 4 * MIN));
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
});

// The not-a-checkout skip is for the cwd fallback only: a worktree the lane owns whose git state cannot be read must
// still block the close, as it did before #39 (#42).
test("a lane-owned worktree whose git state is unreadable still blocks the close", async () => {
  world.isGitRepo = "false";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([
    `unpushed work in ${WT} (git state unreadable)`,
  ]);
  expect(closedVia()).toHaveLength(0);
});

test("an unpushed commit in the cwd of a lane with no worktree blocks the close", async () => {
  world.worktreeList = `worktree ${repo}\nbranch refs/heads/main`;
  world.dirty = "";
  world.aheadCount = { [repo]: "2" };
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${repo}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a failed live check overrides a done report; retry closes with fresh evidence only", async () => {
  const reports = new Reports(state.dir);
  const original = reports.report(lane.key, "done", `Earlier local review: ${reports.path(lane.key)}`, T0);
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, `report:${reportId(original)}; merged acme/app#1 abc123`);
  await watchTick(at(T0 + 6 * MIN));
  const rejected = await at(T0).registry.read(lane.key);
  if (!rejected) throw new Error("rejected lane missing");
  expect(statusOf(rejected)).toBe("not-done");
  expect(rejected.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  const stale = reports.read(lane.key);
  expect(stale?.lastReport).toEqual(original);
  expect(finished({ ...rejected, reportState: stale?.state })).toBe(false);
  const control = at(T0 + 6 * MIN);
  const paused = await pauseLane(control, rejected, "owner requested a pause");
  expect(paused).toMatchObject({ code: 0, lane: { status: "paused", pausedFrom: "not-done" } });
  expect(world.sessions[sid(1)]?.goal?.status).toBe("paused");
  expect(finished({ ...paused.lane, reportState: stale?.state })).toBe(false);
  const resumed = await resumeLane(control, paused.lane, "owner requested resumption");
  expect(resumed).toMatchObject({ code: 0, lane: { status: "not-done" } });
  expect(world.sessions[sid(1)]?.goal?.status).toBe("active");
  expect(finished({ ...resumed.lane, reportState: stale?.state })).toBe(false);
  expect(closedVia()).toHaveLength(0);
  expect(world.calls.filter(([command]) => command === "notify")).toEqual([]);

  reports.report(lane.key, "milestone", "Issue is open; recheck before retrying.", T0 + 7 * MIN);
  expect(reports.read(lane.key)?.state).toBe("running");
  world.issueState = "CLOSED";
  const fresh = reports.report(lane.key, "done", "Merge and issue closure read back again.", T0 + 8 * MIN);
  const evidence = `report:${reportId(fresh)}; merged acme/app#1 abc123; closed acme/app#2`;
  await claimDone(at(T0 + 8 * MIN), resumed.lane, evidence);
  await watchTick(at(T0 + 12 * MIN));
  expect(closedVia()).toHaveLength(0);
  expect((await watchTick(at(T0 + 14 * MIN)))[0]).toStartWith(`LANE_CLOSED ${lane.key}`);
  expect(world.calls.filter(([command]) => command === "notify")).toEqual([
    ["notify", lane.thread, `Done: ${evidence}`],
  ]);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 6 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the session alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

// The native Discord inbox requires POSIX ownership and permission checks.
const posix = test.skipIf(process.platform === "win32");

posix("a close waits for accepted Discord work to reach the native lane", async () => {
  const deps = at(T0);
  const discordLane = { ...lane, thread: "discord:123", session: "session-1" };
  await deps.registry.write(discordLane);
  const inbox = openDiscordLaneInbox(state.dir);
  try {
    inbox.add(discordLane.session, {
      channel: "123",
      message: "456",
      text: "owner work",
      reference: null,
      replyTo: null,
      attachments: [],
    });
    const blocked = await closeLane(deps, discordLane, "manual");
    expect(blocked.closed).toBe(false);
    expect(blocked.lines.at(-1)).toContain("Discord messages are still pending");
    expect(closedVia()).toHaveLength(0);
    inbox.acknowledge(discordLane.session, "123", "456");
    expect((await closeLane(deps, discordLane, "manual")).closed).toBe(true);
    expect(closedVia()).toEqual([["headless", "close", sid(1)]]);
  } finally {
    inbox.close();
  }
});
