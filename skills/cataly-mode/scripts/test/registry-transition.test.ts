import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { type Lane, Registry, withStatus } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";
import { closableLane } from "./native-close-fixture.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "discarded-lane",
  title: "registration rollback",
  thread: "chat:team/123",
  brief: "/b.md",
  done: "closed acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a stale status transition never recreates a registration discarded by launch rollback", async () => {
  const registry = new Registry(state.dir);
  await registry.create(lane);
  const seen = await registry.read(lane.key);
  expect(seen).not.toBeNull();
  await registry.discard(lane);
  const result = await registry.transition(seen!, (current) =>
    withStatus(current, "paused", "stale sweep", new Date(T0).toISOString()),
  );
  expect(result).toBeNull();
  expect(await registry.read(lane.key)).toBeNull();
});

test("a close whose registration disappears during signal I/O touches no thread or pane", async () => {
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), state.dir, {
    hooks: { threadDone: ["notify", "{thread}", "{text}"] },
  });
  const bound = { ...lane, ...closableLane(world, 9, join(state.dir, "repo")) };
  await base.registry.create(bound);
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "gh") await base.registry.discard(bound);
      return base.run(argv);
    },
  };
  const result = await closeLane(deps, bound, "late close");
  expect(result.closed).toBe(false);
  expect(result.lines.at(-1)).toStartWith("LANE_CHANGED discarded-lane");
  expect(result.lines.at(-1)).toContain("(now not registered, was working)");
  expect(await base.registry.read(lane.key)).toBeNull();
  expect(world.calls.some((argv) => argv[0] === "notify" || (argv[0] === "headless" && argv[1] === "close"))).toBe(
    false,
  );
});
