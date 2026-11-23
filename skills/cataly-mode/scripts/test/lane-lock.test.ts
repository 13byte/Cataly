import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import { closableLane } from "./native-close-fixture.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

let state: TestState;
let world: World;
/** The lane on live native session 1. */
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

const stored = async (deps: FlowDeps): Promise<Lane> => (await deps.registry.read(lane.key)) ?? lane;

test("a lane lock left by a dead writer is taken over and released after the update", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  const dead = Bun.spawnSync(["true"]).pid;
  const owner = { pid: dead, host: hostname(), at: new Date().toISOString(), nonce: "left-behind" };
  writeFileSync(`${deps.registry.path(lane.key)}.lock`, JSON.stringify(owner));

  const updated = await deps.registry.update(lane.key, (current) => current && { ...current, title: "taken over" });

  expect(updated?.title).toBe("taken over");
  expect((await stored(deps)).title).toBe("taken over");
  expect(existsSync(`${deps.registry.path(lane.key)}.lock`)).toBe(false);
});
