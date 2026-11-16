import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

import { claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { pauseLane } from "../src/pause.ts";
import { type Lane, statusOf, withStatus } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

// Another writer (a CLI claim, objection or resume) lands while a sweep awaits pane, git or hook I/O. Each test injects
// that write at one exact call of the fake runner, so the interleaving is the same on every run.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = {
  key: "race-lane",
  title: "race",
  thread: "none",
  pane: "w:p1",
  brief: "/b.md",
  done: "closed acme/app#1",
  openedAt: new Date(T0).toISOString(),
};

let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
});
afterEach(() => state.done());

/** `base` with `write` run once, before the first runner call that `at` matches. */
const interleaved = (base: FlowDeps, at: (argv: readonly string[]) => boolean, write: () => Promise<unknown>) => {
  let pending = true;
  const run: Runner = async (argv, opts) => {
    if (pending && at(argv)) {
      pending = false;
      await write();
    }
    return base.run(argv, opts);
  };
  return { ...base, run };
};
const stored = async (deps: FlowDeps): Promise<Lane> => (await deps.registry.read(lane.key)) ?? lane;
const paneCloses = () => world.calls.filter((c) => c[0] === "herdr" && c[2] === "close");

test("a nudge recorded after its pane I/O keeps a done claim written meanwhile", async () => {
  world.onEnterStatus = "working";
  const base = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { nudgeAfterMin: 1, postAfterMin: 999 });
  await base.registry.write(lane);
  const deps = interleaved(
    base,
    (argv) => argv[0] === "herdr" && argv[2] === "list",
    async () => claimDone(base, await stored(base), "merged during the nudge"),
  );

  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);

  const after = await stored(deps);
  expect(statusOf(after)).toBe("done-claimed");
  expect(after.claim?.evidence).toBe("merged during the nudge");
  expect(after.lastNudgeAt).toBe(T0 + 30 * MIN);
});

test("the watcher does not close a lane objected to while its git state was read", async () => {
  const base = depsFor(world, fakeClock(T0 + 6 * MIN), state.dir, { closeAfterMin: 5 });
  const claim = { at: new Date(T0).toISOString(), evidence: "finished", emitted: true };
  await base.registry.write({ ...lane, status: "done-claimed", claim });
  const deps = interleaved(
    base,
    (argv) => argv[0] === "git" && argv.includes("worktree") && argv.includes("list"),
    async () => objectDone(base, await stored(base), ["owner objection before closure"]),
  );

  const lines = await watchTick(deps);

  expect(lines).toEqual(["LANE_CHANGED race-lane is now not-done, not done-claimed; verification not recorded"]);
  expect(statusOf(await stored(deps))).toBe("not-done");
  expect((await stored(deps)).objection?.reasons).toEqual(["owner objection before closure"]);
  expect(paneCloses()).toEqual([]);
});

test("a close is refused, before the pane is closed, when an objection lands during the Done signal read", async () => {
  const base = depsFor(world, fakeClock(T0), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
  await base.registry.write({ ...lane, thread: "chat:team/1" });
  const deps = interleaved(
    base,
    (argv) => argv[0] === "gh",
    async () => objectDone(base, await stored(base), ["not merged yet"]),
  );

  const result = await closeLane(deps, { ...lane, thread: "chat:team/1" }, "closed by the lead");

  expect(result.closed).toBe(false);
  expect(result.lines.at(-1)).toBe("LANE_CHANGED race-lane is now not-done, not working; close not recorded");
  expect(statusOf(await stored(deps))).toBe("not-done");
  expect(paneCloses()).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toEqual([]);
});

test("a paused lane resumed during the freshness status read is not turned back to paused", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  const base = depsFor(world, fakeClock(T0 + MIN), state.dir);
  await base.registry.write({ ...lane, status: "paused", pausedFrom: "working" });
  const deps = interleaved(
    base,
    (argv) => argv[0] === "herdr",
    async () => base.registry.write(withStatus(await stored(base), "working", "resumed", new Date(T0).toISOString())),
  );

  await freshnessTick(deps, "/home/test");

  const after = await stored(deps);
  expect(statusOf(after)).toBe("working");
  expect(after.pausedSeenWorking).toBeUndefined();
});

test("a done claim written while /goal pause is confirmed is not overwritten with paused", async () => {
  const base = depsFor(world, fakeClock(T0 + MIN), state.dir, { agentCommand: ["omo", "{prompt}"] });
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "idle" }];
  world.screens = ["❯ ", "Goal paused\n❯ "];
  await base.registry.write(lane);
  const deps = interleaved(
    base,
    (argv) => argv[0] === "herdr" && argv[2] === "send-text",
    async () => {
      const at = new Date(T0).toISOString();
      await base.registry.write(withStatus(lane, "done-claimed", "done", at, { claim: { at, evidence: "done" } }));
    },
  );

  const r = await pauseLane(deps, lane, "owner said wait");

  expect(r.code).toBe(3);
  expect(statusOf(await stored(deps))).toBe("done-claimed");
  expect((await stored(deps)).claim?.evidence).toBe("done");
});

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
