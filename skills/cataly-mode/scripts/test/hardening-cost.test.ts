import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLane } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, nativeLane, newWorld, withState } from "./fakes.ts";
import { closableLane } from "./native-close-fixture.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const MIN = 60_000;

const lane: Lane = {
  key: "hardening-qa",
  title: "QA",
  thread: "none",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};

test("a lane whose supervision state is corrupt is reported once and the sweep goes on for the others", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + MIN), state.dir, {
      nudgeAfterMin: 999,
      supervision: { defaults: { wallMinutes: 1 }, gitActivity: false },
    });
    const bad = { ...lane, key: "bad-lane", ...nativeLane(world, 2) };
    const good = { ...lane, key: "good-lane", ...nativeLane(world, 1) };
    await deps.registry.write(bad);
    await deps.registry.write(good);
    const reports = new Reports(state.dir);
    await reports.report(bad.key, "milestone", "started", T0);
    await reports.report(good.key, "milestone", "started", T0);
    writeFileSync(join(state.dir, "lanes", bad.key, "supervision.json"), "{not json");
    const first = await freshnessTick(deps, "/home/test");
    expect(first.map((a) => [a.kind, a.lane]).sort()).toEqual([
      ["blocked", good.key],
      ["supervision-error", bad.key],
    ]);
    // The same error is not printed again on the next tick.
    expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "supervision-error")).toEqual([]);
  } finally {
    state.done();
  }
});

test("a sweep with no usage hook writes no cost readings", async () => {
  const state = withState();
  try {
    const world = newWorld(),
      clock = fakeClock(T0);
    const deps = depsFor(world, clock, state.dir, { nudgeAfterMin: 999, supervision: { gitActivity: false } });
    await deps.registry.write({ ...lane, ...nativeLane(world, 1) });
    await new Reports(state.dir).report(lane.key, "milestone", "started", T0);
    await freshnessTick(deps, "/home/test");
    clock.at += MIN;
    await freshnessTick(deps, "/home/test");
    expect(existsSync(join(state.dir, "lanes", lane.key, "cost.jsonl"))).toBe(false);
  } finally {
    state.done();
  }
});

test("a failing cost hook is reported and does not stop an authorized close", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      supervision: { usageArgv: ["usage", "{key}"], recordCostArgv: ["record-cost", "{key}"] },
    });
    mkdirSync(join(state.dir, "lanes"), { recursive: true });
    const external = deps.run;
    const bound = { ...lane, ...closableLane(world, 1, join(state.dir, "repo")) };
    await deps.registry.create(bound);
    const result = await closeLane(
      {
        ...deps,
        run: async (argv, opts) => {
          if (argv[0] === "usage") return { code: 0, out: '{"tokens":10,"costUsd":0.1}', err: "" };
          if (argv[0] === "record-cost") return { code: 1, out: "", err: "ledger down" };
          return external(argv, opts);
        },
      },
      bound,
      "verified",
    );
    expect(result.closed).toBe(true);
    expect(result.lines).toContain(`COST ${lane.key} not recorded: recordCost failed for ${lane.key}: ledger down`);
    expect((await deps.registry.read(lane.key))?.status).toBe("closed");
  } finally {
    state.done();
  }
});

test("authorized close records known cost and keeps it in the lane journal", async () => {
  // Given live done signals and a configured read-only usage source.
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      supervision: { usageArgv: ["usage", "{key}"], recordCostArgv: ["record-cost", "{key}", "{tokens}", "{costUsd}"] },
    });
    const external = deps.run;
    const calls: (readonly string[])[] = [];
    const bound = { ...lane, ...closableLane(world, 1, join(state.dir, "repo")) };
    await deps.registry.create(bound);
    const result = await closeLane(
      {
        ...deps,
        run: async (argv, opts) => {
          calls.push(argv);
          if (argv[0] === "usage") return { code: 0, out: '{"tokens":1200,"costUsd":0.5}', err: "" };
          if (argv[0] === "record-cost") return { code: 0, out: "recorded", err: "" };
          return external(argv, opts);
        },
      },
      bound,
      "verified",
    );
    // Then the close surface reports the same cumulative values it persisted.
    expect(result.closed).toBe(true);
    expect(result.lines).toContain(`COST ${lane.key} tokens=1200 costUsd=0.5`);
    const cost = JSON.parse(readFileSync(join(state.dir, "lanes", lane.key, "cost.jsonl"), "utf8"));
    expect({ tokens: cost.tokens, costUsd: cost.costUsd }).toEqual({ tokens: 1200, costUsd: 0.5 });
    expect(calls).toContainEqual(["record-cost", lane.key, "1200", "0.5"]);
    expect((await deps.registry.read(lane.key))?.status).toBe("closed");
  } finally {
    state.done();
  }
});
