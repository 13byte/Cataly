import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { takeLock } from "../src/checkpoint-lock.ts";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { pauseLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Clock } from "../src/run.ts";
import { tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";
import { closableLane } from "./native-close-fixture.ts";

// PR #66 review: a pause that completes between tell's lane read and its send must hold the send. tell and pause
// share the lane's delivery lock, and tell reads the lane again under it.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
let working: Lane;
beforeEach(() => {
  state = withState();
  world = newWorld();
  // An idle native session; a pause sets its goal through the supervisor, never by typing.
  working = {
    key: "race-lane",
    title: "race",
    thread: "none",
    ...closableLane(world, 7, state.dir),
    brief: "/b.md",
    done: "merged acme/app#1",
    openedAt: new Date(T0).toISOString(),
  };
});
afterEach(() => state.done());

const deps = (clock: Clock = fakeClock(T0)) => depsFor(world, clock, state.dir);
/** A clock whose sleeps pass time, so a wait for a held lock reaches its deadline. */
const passing = (): Clock & { at: number } => {
  const c = {
    at: T0,
    now: () => c.at,
    sleep: async (ms: number) => {
      c.at += ms;
    },
  };
  return c;
};
/** The texts offered to the lane and the goal changes made on it, in the order the supervisor saw them. */
const effects = () =>
  world.calls
    .filter((c) => c[0] === "headless" && (c[1] === "deliver" || c[1] === "goal"))
    .map((c) => (c[1] === "goal" ? `goal ${c[3]}` : c[3]));
const stored = async () => statusOf((await deps().registry.read(working.key)) ?? working);

test("a pause recorded after tell's caller read the lane holds the send", async () => {
  await deps().registry.write({ ...working, status: "paused" });
  // The CLI read the lane while it was still working.
  expect(await tellLane(deps(), working, "owner chose option 2")).toEqual({
    line: "TELL_FAILED race-lane delivery=failed: the lane is paused; resume it first; nothing was sent",
    code: 2,
  });
  expect(sent(world)).toEqual([]);
});

test("a tell racing a pause that started first waits for it and then sends nothing", async () => {
  await deps().registry.write(working);
  const [paused, told] = await Promise.all([
    pauseLane(deps(), working, "owner said wait"),
    tellLane(deps(), working, "owner chose option 2"),
  ]);
  expect(paused.lines[0]).toStartWith("PAUSED race-lane");
  expect(told.line).toBe(
    "TELL_FAILED race-lane delivery=failed: the lane is paused; resume it first; nothing was sent",
  );
  expect(effects()).toEqual(["goal paused"]);
});

test("a pause racing a tell that started first sends its goal command after the message", async () => {
  await deps().registry.write(working);
  const [told, paused] = await Promise.all([
    tellLane(deps(), working, "owner chose option 2"),
    pauseLane(deps(), working, "owner said wait"),
  ]);
  expect(told.code).not.toBe(2);
  expect(paused.lines[0]).toStartWith("PAUSED race-lane");
  expect(effects()).toEqual(["owner chose option 2", "goal paused"]);
  expect(await stored()).toBe("paused");
});

test("a delivery lock that stays held makes tell send nothing and pause leave the lane as it was", async () => {
  await deps().registry.write(working);
  const lock = join(deps().registry.dir, `${working.key}.deliver.lock`);
  const release = takeLock(lock, T0, (m) => new Error(m));
  if (typeof release === "string") throw new Error(release);
  try {
    const told = await tellLane(deps(passing()), working, "owner chose option 2");
    expect(told.code).toBe(2);
    expect(told.line).toMatch(
      /^TELL_FAILED race-lane delivery=failed: a pause or another tell holds the lane's delivery lock \(pid \d+/,
    );
    const paused = await pauseLane(deps(passing()), working, "owner said wait");
    expect(paused.code).toBe(3);
    expect(paused.lines[0]).toMatch(
      /^PAUSE_UNVERIFIED race-lane a message to the lane is in flight .*; lane left working$/,
    );
    expect(effects()).toEqual([]);
    expect(await stored()).toBe("working");
  } finally {
    release();
  }
});

test("a close and a tell are ordered: a tell after the close sends nothing, one before it is sent first", async () => {
  await deps().registry.write(working);
  const registered = deps().registry.path(working.key);
  // While the text is being sent, the close that started alongside has not recorded the lane closed yet.
  const statusAtSend: string[] = [];
  world.onDeliver = () => statusAtSend.push(statusOf(JSON.parse(readFileSync(registered, "utf8")) as Lane));
  const [first, closed] = await Promise.all([
    tellLane(deps(), working, "owner chose option 2"),
    closeLane(deps(), working, "done"),
  ]);
  expect([first.code === 2, closed.closed, statusAtSend]).toEqual([false, true, ["working"]]);
  const sendAt = world.calls.findIndex((c) => c[0] === "headless" && c[1] === "deliver");
  const closeAt = world.calls.findIndex((c) => c[0] === "headless" && c[1] === "close");
  expect(sendAt).toBeGreaterThanOrEqual(0);
  expect(closeAt).toBeGreaterThan(sendAt);
  // A tell that reads the lane after the close sends nothing.
  world.calls = [];
  expect((await tellLane(deps(), working, "owner chose option 2")).line).toBe(
    "TELL_FAILED race-lane delivery=failed: the lane was closed; nothing was sent",
  );
  expect(sent(world)).toEqual([]);
});

test("a send that holds the lock past the wait keeps the lane open: close refuses, the watch retries next tick", async () => {
  const claimed: Lane = {
    ...working,
    status: "done-claimed",
    claim: { at: new Date(T0).toISOString(), evidence: "merged", emitted: true },
  };
  await deps().registry.write(working);
  const lock = join(deps().registry.dir, `${working.key}.deliver.lock`);
  const release = takeLock(lock, T0, (m) => new Error(m));
  if (typeof release === "string") throw new Error(release);
  const later = () => {
    const clock = passing();
    clock.at = T0 + 60 * 60_000;
    return deps(clock);
  };
  try {
    const closed = await closeLane(deps(passing()), working, "done");
    expect(closed.closed).toBe(false);
    expect(closed.lines.at(-1)).toMatch(/^HELD race-lane a message to the lane is in flight \(pid \d+/);
    expect(await stored()).toBe("working");
    await deps().registry.write(claimed);
    const [line] = await watchTick(later());
    expect(line).toMatch(/^LANE_HELD race-lane a message to the lane is in flight \(pid \d+.*\); retried next tick$/);
    expect(await stored()).toBe("done-claimed");
  } finally {
    release();
  }
  expect((await watchTick(later()))[0]).toStartWith("LANE_CLOSED race-lane");
  expect(await stored()).toBe("closed");
});

test("a live holder keeps the delivery lock past the two-minute age limit; a dead holder's lock is taken over", async () => {
  await deps().registry.write(working);
  const lock = join(deps().registry.dir, `${working.key}.deliver.lock`);
  // A pause still in a slow pane round trip ten minutes on: its lock is not taken over by age.
  const release = takeLock(lock, T0 - 10 * 60_000, (m) => new Error(m));
  if (typeof release === "string") throw new Error(release);
  try {
    const told = await tellLane(deps(passing()), working, "owner chose option 2");
    expect(told.line).toMatch(/holds the lane's delivery lock \(pid \d+, 6\d\d s old\)/);
    expect(effects()).toEqual([]);
  } finally {
    release();
  }
  // A holder that died leaves its lock to the next taker.
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  writeFileSync(lock, JSON.stringify({ pid: gone.pid, host: hostname(), at: new Date(T0).toISOString(), nonce: "x" }));
  expect((await tellLane(deps(), working, "owner chose option 2")).line).toBe("TOLD race-lane delivery=confirmed");
});
