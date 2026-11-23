import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import type { HostSample } from "../src/host-guard.ts";
import type { LaunchInput } from "../src/launch-input.ts";
import type { Lane } from "../src/registry.ts";
import { type Runner, runtimesFor } from "../src/run.ts";
import { depsFor, newWorld, withState, type TestState, type World } from "./fakes.ts";

export type QueueFixture = {
  state: TestState;
  world: World;
  deps: FlowDeps;
  input: LaunchInput;
  prior: Lane;
  creates: () => number;
  advance: (ms: number) => void;
  failStart: () => void;
};
export const roomy = async (): Promise<HostSample> => ({
  load1: 0,
  memFreePct: 90,
  diskFreeGb: 100,
  swapFreeGb: 10,
  panes: 0,
});

/** A lane launch on the world's fake headless supervisor; `creates` counts its native reservations. */
export const queueFixture = async (): Promise<QueueFixture> => {
  const state = withState();
  const world = newWorld();
  let at = Date.parse("2026-01-01T12:00:00Z");
  let creates = 0;
  world.onCreate = () => {
    creates++;
  };
  const clock = {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
      await Bun.sleep(1);
    },
  };
  const base = depsFor(world, clock, state.dir, { defaultCwd: state.dir });
  const deps: FlowDeps = { ...base, env: { CATALY_CONFIG: join(state.dir, "config.json") } };
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# Implement the recorded request\n");
  const input: LaunchInput = { key: "next-lane", title: "Next lane", brief, done: "closed acme/app#2" };
  const prior: Lane = {
    key: "prior-lane",
    title: "Prior lane",
    thread: "none",
    brief,
    done: "closed acme/app#1",
    openedAt: new Date(at).toISOString(),
    status: "closed",
    closedAt: new Date(at).toISOString(),
    receipt: { checks: [{ signal: "closed acme/app#1", ok: true }] },
  };
  await deps.registry.write(prior);
  return {
    state,
    world,
    deps,
    input,
    prior,
    creates: () => creates,
    advance: (ms) => {
      at += ms;
    },
    failStart: () => {
      world.onStart = () => {
        throw new Error("start failed");
      };
    },
  };
};

/**
 * The fixture's deps with Tern as the session runtime and no `tern` binary to spawn: a create that provably made
 * nothing. `before` runs at that attempt.
 */
export const unspawnableTern = (f: QueueFixture, before = (): void => {}): FlowDeps => {
  const run: Runner = async (argv, options) => {
    if (argv[0] !== "tern") return f.deps.run(argv, options);
    before();
    return { code: 127, out: "", err: "tern: not found", spawnFailed: true };
  };
  const config = { ...f.deps.config, runtime: "tern" as const, laneRuntime: "terminal" as const };
  return { ...f.deps, config, run, rts: runtimesFor(config, f.deps.env ?? {}, run, f.deps.clock) };
};
