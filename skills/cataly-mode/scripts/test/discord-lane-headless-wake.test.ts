import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HeadlessObservation } from "../../../../src/runtime/headless-protocol.ts";
import { laneEntry, writePrivate } from "../../../../src/runtime/headless-record.ts";
import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { publishHeadlessDiscordReceiver } from "../src/discord-lane-headless-state.ts";
import { isDiscordWakePending } from "../src/discord-lane-wake-pending.ts";
import { wakeDiscordLane } from "../src/discord-lane-wake.ts";
import { discordLaneRoute, enqueueDiscordLane } from "../src/messenger/discord-lane-routing.ts";
import { Registry, sessionFields } from "../src/registry.ts";
import { ChosenRuntimes } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

test.skipIf(process.platform === "win32")(
  "native wake reserves exactly once and recovers a lost start receipt without replacing the original transcript",
  async () => {
    const f = await lifecycleFixture();
    try {
      const stateDir = f.state.dir;
      const cwd = realpathSync(f.deps.config.defaultCwd);
      const model = "fixture/saved";
      const at = new Date().toISOString();
      const thread = "discord:900000000000000101";
      let observed: HeadlessObservation | undefined;
      let starts = 0;
      let leaseHeld = false;
      class WakeRuntime extends HeadlessRuntime {
        override observe(ref: SessionRef) {
          return observed?.ref.id === ref.id ? Promise.resolve(observed) : super.observe(ref);
        }
        override async startNative(
          ref: SessionRef,
          argv: readonly string[],
          env: Readonly<Record<string, string | undefined>>,
          resume?: { file: string; sessionId: string },
        ): Promise<HeadlessObservation> {
          starts++;
          expect(resume).toEqual({ file: f.file, sessionId: f.session });
          expect(argv.some((option) => option.endsWith("/discord-lane-wake.yml"))).toBe(true);
          expect(env["CATALY_DISCORD_WAKE_MODEL"]).toBe(model);
          expect(isDiscordWakePending((await f.deps.registry.read(f.lane.key))?.lifecycleEpoch)).toBe(true);
          expect(publishHeadlessDiscordReceiver(stateDir, ref, f.session, f.file, cwd, undefined, model)).toBe(true);
          observed = {
            ref,
            cwd,
            startedAt: at,
            updatedAt: at,
            status: "idle",
            held: false,
            dialogs: [],
            recent: [],
            role: "lane",
            pid: process.pid,
            sessionId: f.session,
            sessionFile: f.file,
            model,
            goal: { status: "paused" },
          };
          throw new Error("lost startup receipt");
        }
      }
      const rt = new WakeRuntime(stateDir);
      const prior = await rt.create({ name: f.lane.key, role: "lane", cwd, container: "tab", env: {} });
      const lane = { ...f.lane, ...sessionFields(prior), cwd, thread };
      await f.deps.registry.write(lane);
      writeFileSync(
        f.file,
        [
          { type: "session", id: f.session, cwd },
          { type: "model_change", id: "initial", parentId: null, model },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      expect(publishHeadlessDiscordReceiver(stateDir, prior, f.session, f.file, cwd)).toBe(true);
      expect(publishHeadlessDiscordReceiver(stateDir, prior, f.session, f.file, cwd, "active")).toBe(true);
      const entry = laneEntry(stateDir, prior)!;
      const deps = {
        ...f.deps,
        config: {
          ...f.deps.config,
          agentCommand: ["omp", "--cataly-role", "lane", "--model", "{model}", "{prompt}"],
          sessionRuntime: "headless" as const,
          guard: { ...f.deps.config.guard, diskFreeMinGb: 0, memFreeMinPct: 0 },
        },
        rts: new ChosenRuntimes(
          () => ({ kind: "headless", source: "default" }),
          (kind) => {
            if (kind !== "headless") throw new Error("unexpected terminal backend");
            return rt;
          },
        ),
        run: async (argv: readonly string[]) => ({
          code: 0,
          out: argv[1] === "session" ? JSON.stringify({ held: leaseHeld ? [f.session] : [], unknown: [] }) : "",
          err: "",
        }),
      };
      expect((await wakeDiscordLane(deps, lane)).kind).toBe("held");
      writePrivate(join(entry.dir, "stopped.json"), { closedSessionId: f.session });
      leaseHeld = true;
      expect((await wakeDiscordLane(deps, lane)).kind).toBe("held");
      expect(starts).toBe(0);
      leaseHeld = false;
      expect((await wakeDiscordLane(deps, lane)).kind).toBe("unconfirmed");
      const bound = (await f.deps.registry.read(lane.key))!;
      expect(bound.sessionRef?.runtime).toBe("headless");
      expect(bound.sessionRef?.id).not.toBe(prior.id);
      expect(bound).toMatchObject({ session: f.session, sessionFile: f.file, thread });
      expect((await wakeDiscordLane(deps, bound)).kind).toBe("started");
      expect(starts).toBe(1);
      expect(isDiscordWakePending((await f.deps.registry.read(lane.key))?.lifecycleEpoch)).toBe(false);
    } finally {
      f.state.done();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "normal native intake never falls through to the lead from a stale receiver alone",
  async () => {
    const { dir, done } = withState();
    try {
      const registry = new Registry(dir);
      const key = "discord-work";
      const channel = "123";
      const session = "native-session";
      const rt = new HeadlessRuntime(dir);
      const ref = await rt.create({ name: key, cwd: dir, role: "lane", container: "tab", env: {} });
      const entry = laneEntry(dir, ref)!;
      const cwd = entry.reservation.cwd;
      const file = join(cwd, "session.jsonl");
      const lane = {
        key,
        title: "Discord work",
        thread: `discord:${channel}`,
        brief: "",
        done: "",
        cwd,
        session,
        sessionRef: ref,
        sessionFile: file,
        openedAt: new Date().toISOString(),
      };
      await registry.write(lane);
      expect(await discordLaneRoute(dir, channel)).toEqual({ kind: "native-unavailable", key });
      expect(publishHeadlessDiscordReceiver(dir, ref, session, file, cwd)).toBe(true);
      expect(await discordLaneRoute(dir, channel)).toEqual({ kind: "native-unavailable", key });
      expect(publishHeadlessDiscordReceiver(dir, ref, session, file, cwd, "active")).toBe(true);
      writePrivate(join(entry.dir, "stopped.json"), { closedSessionId: "replacement" });
      const queued: string[] = [];
      const queue = (thread: string) =>
        enqueueDiscordLane({ registry, clock: fakeClock(Date.now()) }, dir, thread, false, (id) => {
          queued.push(id);
        });
      await expect(queue(channel)).rejects.toThrow("identity unverified; cursor not advanced");
      expect(queued).toEqual([]);
      writePrivate(join(entry.dir, "stopped.json"), { closedSessionId: session });
      expect(await queue("124")).toBe(false);
      expect(await queue(channel)).toBe(true);
      expect(queued).toEqual([session]);
      await registry.write({ ...lane, key: "duplicate-work" });
      await expect(queue(channel)).rejects.toThrow("owner ambiguous; cursor not advanced");
      expect(queued).toEqual([session]);
    } finally {
      done();
    }
  },
);
