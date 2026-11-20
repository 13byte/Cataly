import { readFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { SupervisionOptions } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

export const T0 = Date.parse("2026-01-01T12:00:00Z");
export const MIN = 60_000;
export const usageCommand = "fixture-usage";
export const usage = { code: 0, out: '{"tokens":1,"costUsd":0}', err: "" };

export const fixture = (supervision: SupervisionOptions) => {
  const state = withState();
  const world = newWorld();
  const clock = fakeClock(T0);
  const lane: Lane = {
    key: "resample-lane",
    title: "Supervision resample",
    thread: "none",
    pane: "w:p1",
    brief: "/b.md",
    done: "",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
    cwd: state.dir,
  };
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
  const deps = depsFor(world, clock, state.dir, {
    agentCommand: ["omo", "--model", "{model}", "{prompt}"],
    nudgeAfterMin: 999,
    postAfterMin: 999,
    supervision,
  });
  const reports = new Reports(state.dir);
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
    tick: (screen: string, run = deps.run) => {
      world.screen = screen;
      return freshnessTick({ ...deps, run }, state.dir);
    },
  };
};
