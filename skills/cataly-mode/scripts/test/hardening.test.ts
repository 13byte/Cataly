import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run } from "../src/run.ts";
import { depsFor, type FakeSession, fakeClock, nativeLane, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const MIN = 60_000;

/** The QA lane, bound to live native session 1 in `world`. */
const qaLane = (world: World, session: Partial<FakeSession> = {}): Lane => ({
  key: "hardening-qa",
  title: "QA",
  thread: "none",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
  ...nativeLane(world, 1, session),
});

test("freshness keeps a hung timer stalled without duplicate transitions or alerts", async () => {
  // Given the full freshness path and a running timer.
  const state = withState();
  try {
    const world = newWorld(),
      clock = fakeClock(T0);
    const deps = depsFor(world, clock, state.dir, { nudgeAfterMin: 999, supervision: { gitActivity: false } });
    // A native lane that has been working one continuous stretch for 21 minutes.
    const lane = qaLane(world, { status: "working", activeSince: T0 - 21 * MIN });
    await deps.registry.write(lane);
    const reports = new Reports(state.dir);
    await reports.report(lane.key, "milestone", "started", T0);
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    // When the same stretch grows beyond the no-activity threshold.
    clock.at += 20 * MIN;
    expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["stalled"]);
    const captured = readFileSync(reports.path(lane.key), "utf8");
    clock.at += MIN;
    // Then the still-working native observation cannot undo the stall every sweep.
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    expect(readFileSync(reports.path(lane.key), "utf8")).toBe(captured);
    expect(reports.read(lane.key)?.state).toBe("stalled");
    expect(world.calls.filter((c) => c[0] === "headless" && (c[1] === "deliver" || c[1] === "close"))).toEqual([]);
  } finally {
    state.done();
  }
});

test("freshness persists a wall ceiling blocker without sending or terminating", async () => {
  // Given a new lane at its configured ceiling.
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + MIN), state.dir, {
      supervision: { defaults: { wallMinutes: 1 }, gitActivity: false },
    });
    const lane = qaLane(world);
    await deps.registry.write(lane);
    await new Reports(state.dir).report(lane.key, "milestone", "started", T0);
    // When the regular freshness command runs its supervision step.
    const result = await freshnessTick(deps, "/home/test");
    // Then state and alert agree, and only a native observation was needed: nothing was sent, closed or run.
    expect(result.map((a) => a.kind)).toEqual(["blocked"]);
    expect(new Reports(state.dir).read(lane.key)?.state).toBe("blocked");
    expect(world.calls).toEqual([]);
  } finally {
    state.done();
  }
});

test("a launched lane with no report journal is not supervised by freshness", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + MIN), state.dir, {
      nudgeAfterMin: 999,
      supervision: { defaults: { wallMinutes: 1 }, gitActivity: false },
    });
    const lane = qaLane(world, { status: "working", activeSince: T0 - 40 * MIN });
    await deps.registry.write(lane);
    expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).not.toContain("blocked");
    expect(existsSync(join(state.dir, "lanes", lane.key, "supervision.json"))).toBe(false);
    expect(existsSync(new Reports(state.dir).path(lane.key))).toBe(false);
  } finally {
    state.done();
  }
});

test("a usage warning does not hide the idle nudge of the same lane", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + 20 * MIN), state.dir, {
      nudgeAfterMin: 15,
      supervision: { defaults: { tokens: 1000 }, gitActivity: false },
    });
    // An idle native lane on an active goal whose last report is 20 minutes old.
    const lane = qaLane(world, { status: "idle" });
    await deps.registry.write(lane);
    await new Reports(state.dir).report(lane.key, "milestone", "started", T0);
    const acts = await freshnessTick(deps, "/home/test");
    expect(acts.map((a) => a.kind)).toEqual(["warning", "nudged"]);
    expect(acts[0]?.detail).toBe("tokens ceiling cannot be checked: usage unavailable");
    expect(sent(world)).toHaveLength(1);
  } finally {
    state.done();
  }
});

test("Runner preserves leading status columns and NUL delimiters when requested", async () => {
  // Given git-like machine output; when passed through the actual runner.
  const result = await run([process.execPath, "-e", 'process.stdout.write(" M source.ts\\u0000")'], {
    preserveOutput: true,
  });
  // Then activity parsers receive the first filename without truncation.
  expect(result.code).toBe(0);
  expect(result.out).toBe(" M source.ts\0");
});
