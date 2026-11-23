import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyDiscordFixture, legacyDiscordRecipe } from "../../../../test/fixtures/legacy-discord-recipe.ts";
import { loadConfig } from "../src/config.ts";
import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { Registry, type Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, type World, withState } from "./fakes.ts";
import { closableLane } from "./native-close-fixture.ts";

const now = Date.parse("2026-01-01T12:21:00Z");
const laneIn = (world: World, status: "idle" | "working", cwd: string): Lane => ({
  key: "demo-lane",
  title: "demo",
  thread: "discord:40",
  ...closableLane(world, 1, cwd, { status }),
  brief: "/briefs/demo.md",
  done: "merged acme/app#1",
  openedAt: "2026-01-01T12:00:00.000Z",
  lastNudgeAt: now,
  reportProtocol: "jsonl-v1",
});

test.skipIf(process.platform === "win32").each(["threadReply", "threadDone"] as const)(
  "the saved %s Discord recipe delivers using only the selected config and its explicit token file",
  async (hook) => {
    const home = withState();
    try {
      const fixture = legacyDiscordFixture(home.dir, hook === "threadReply" ? join(home.dir, "settings") : home.dir);
      const saved = JSON.stringify({
        stateDir: fixture.stateDir,
        ompUlwPath: "",
        hooks: { [hook]: legacyDiscordRecipe[hook] },
      });
      writeFileSync(fixture.configFile, saved);
      const env = {
        ...fixture.env,
        ...(hook === "threadReply" ? { CATALY_DISCORD_TOKEN: "", DORI_DISCORD_TOKEN: "" } : {}),
      };
      const config = await loadConfig(fixture.configFile, home.dir, {
        ...env,
        CATALY_HOME: hook === "threadReply" ? home.dir : undefined,
      });
      const world = newWorld();
      // A quiet thread can still have an actively working lane. An idle lane this old is held as stalled.
      const lane = laneIn(world, hook === "threadReply" ? "working" : "idle", home.dir);
      const deps = depsFor(world, fakeClock(now), fixture.stateDir);
      const registry = new Registry(fixture.stateDir);
      const flow: FlowDeps = {
        ...deps,
        config,
        registry,
        env,
        run: (argv, options) =>
          argv[0] === "bash" ? run(argv, { ...options, timeoutMs: 5_000 }) : deps.run(argv, options),
      };
      await registry.write(lane);
      if (hook === "threadReply") {
        await new Reports(config.stateDir).report(lane.key, "milestone", "all checks green", Date.parse(lane.openedAt));
        expect((await freshnessTick(flow, home.dir)).map((act) => act.kind)).toEqual(["posted"]);
        expect(JSON.parse(readFileSync(fixture.fetchLog, "utf8"))).toMatchObject({
          key: "POST /channels/40/messages",
          body: { content: expect.stringContaining("all checks green") },
        });
      } else {
        const result = await closeLane(flow, lane, "verified complete");
        expect(result.closed).toBe(true);
        expect((await registry.read(lane.key))?.receipt).toMatchObject({
          cleanup: expect.arrayContaining(["thread marked done"]),
        });
        expect(JSON.parse(readFileSync(fixture.fetchLog, "utf8"))).toEqual({
          key: "PATCH /channels/40",
          body: { archived: true },
        });
      }
      expect(readFileSync(fixture.configFile, "utf8")).toBe(saved);
    } finally {
      home.done();
    }
  },
  10_000,
);
