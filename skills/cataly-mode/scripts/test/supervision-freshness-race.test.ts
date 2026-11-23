import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Clock, Runner } from "../src/run.ts";
import { type Observation, writeObservation } from "../src/supervision-evidence-state.ts";
import { depsFor, nativeLane, newWorld, type TestState, withState } from "./fakes.ts";
import { integrationFixture, options, start } from "./supervision-integration.fixture.ts";

let state: TestState;
let restore = () => {};
beforeEach(() => {
  state = withState();
});
afterEach(() => {
  restore();
  restore = () => {};
  state.done();
});

for (const heldHung of [true, false]) {
  test(`a discarded freshness sweep cannot ${heldHung ? "resume held hung" : "stall fresh evidence"} or deliver its stale observation`, async () => {
    const f = await integrationFixture(state);
    restore = f.restore;
    const world = newWorld();
    // One continuing native call that started 21 minutes before the first sweep, as freshness observes it.
    const activeSince = start - 21 * 60_000;
    const lane = { ...f.lane, ...nativeLane(world, 7, { status: "working", activeSince }), thread: "test-thread" };
    const deps = depsFor(world, f.clock, state.dir, {
      nudgeAfterMin: 1,
      postAfterMin: 0,
      hooks: { threadReply: ["notify", "{thread}", "{text}"] },
      supervision: options,
    });
    const run: Runner = (argv, args) =>
      argv[0] === "git" || argv[0] === "usage" ? f.run(argv, args) : deps.run(argv, args);
    await f.registry.write(lane);
    expect((await f.supervisor().sweep(lane, "", activeSince)).hung).toBe(false);
    if (heldHung) {
      f.clock.at += 60_000;
      expect((await f.supervisor().sweep(lane, "", activeSince)).heldHung).toBe(true);
    }
    f.clock.at += 60_000;
    // Changed metadata forces a hash, but these are the same bytes and must not release a held evidence stall.
    writeFileSync(f.source, "first");
    const releasePeer = Promise.withResolvers<void>();
    const resumeStale = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const hold = f.holdAtHash(releasePeer.promise);
    const slowClock: Clock = {
      now: f.clock.now,
      sleep: async () => {
        waiting.resolve();
        await resumeStale.promise;
      },
    };
    const stale = freshnessTick({ ...deps, run, clock: slowClock }, state.dir);
    try {
      await Promise.race([
        waiting.promise,
        stale.then(() => {
          throw new Error("stale sweep never waited to commit its observed candidate");
        }),
      ]);
      expect(hold.free).toBe(true);
      // A still owns the sweep lease. An independent writer under the held delivery lock can replace its evidence.
      if (!heldHung) {
        writeFileSync(f.source, "new evidence during A's wait");
        const evidence = [fileEvidence(f.source, state.dir)];
        await f.registry.withCurrent(lane.key, () =>
          f.reports.report(
            lane.key,
            "milestone",
            "new evidence",
            f.clock.at,
            lane.lifecycleEpoch,
            undefined,
            undefined,
            evidence,
          ),
        );
      }
      const observed = JSON.parse(f.snapshot().observation ?? "null") as Observation;
      writeObservation(f.files.observation, { ...observed, at: f.clock.at + 1 });
      releasePeer.resolve();
      expect((await hold.peer)?.ok).toBe(true);
      expect(f.reports.read(lane.key, { generation: lane.lifecycleEpoch })?.state).toBe(
        heldHung ? "stalled" : "running",
      );
      const committed = f.snapshot();
      const registry = await f.registry.read(lane.key);
      const calls = world.calls.length;
      resumeStale.resolve();
      expect(await stale).toEqual([]);
      expect(f.snapshot()).toEqual(committed);
      expect(await f.registry.read(lane.key)).toEqual(registry);
      expect(world.calls).toHaveLength(calls);
    } finally {
      releasePeer.resolve();
      resumeStale.resolve();
      await stale;
    }
  });
}
