import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => {
  chmodSync(join(state.dir, "briefs"), 0o700);
  state.done();
});

test("a brief that cannot be written stops the launch before a tab or a lane record exists", async () => {
  const briefs = join(state.dir, "briefs");
  mkdirSync(briefs);
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  chmodSync(briefs, 0o500);
  const deps = depsFor(world, fakeClock(T0), state.dir);

  await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: "closed acme/app#1" })).rejects.toThrow();

  expect(world.calls.filter((c) => c[0] === "herdr" && c[1] === "tab")).toEqual([]);
  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(readFileSync(brief, "utf8")).toBe("brief");
  expect(readdirSync(briefs)).toEqual(["lane.md"]);
});
