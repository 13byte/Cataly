import { spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { SupervisionOptions } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, nativeLane, newWorld, withState } from "./fakes.ts";

export const T0 = Date.parse("2026-01-01T12:00:00Z");
export const MIN = 60_000;
export const usageCommand = "fixture-usage";
export const usage = { code: 0, out: '{"tokens":1,"costUsd":0}', err: "" };

/** A working native lane whose current call started 21 minutes before T0, so its timer reads `21 + minutes`. */
export const fixture = (supervision: SupervisionOptions) => {
  const state = withState();
  const world = newWorld();
  const clock = fakeClock(T0);
  const lane: Lane = {
    key: "resample-lane",
    title: "Supervision resample",
    thread: "none",
    ...nativeLane(world, 1, { status: "working", activeSince: T0 - 21 * MIN }),
    brief: "/b.md",
    done: "",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
    cwd: state.dir,
  };
  const deps = depsFor(world, clock, state.dir, {
    agentCommand: ["omo", "--model", "{model}", "{prompt}"],
    nudgeAfterMin: 999,
    postAfterMin: 999,
    supervision,
  });
  const reports = new Reports(state.dir);
  const wall = Date.now();
  return {
    state,
    world,
    clock,
    lane,
    deps,
    reports,
    journal: () => readFileSync(reports.path(lane.key), "utf8"),
    seed: async () => {
      await deps.registry.write(lane);
      reports.report(lane.key, "milestone", "started", T0);
    },
    tick: async (run = deps.run) => {
      const now = spyOn(Date, "now").mockImplementation(() => wall + clock.at - T0);
      try {
        return await freshnessTick({ ...deps, run }, state.dir);
      } finally {
        now.mockRestore();
      }
    },
  };
};
