import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run, type Runner } from "../src/run.ts";
import type { Observation } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const key = "freshness-git-timeout";
const probes = ["rev-parse", "status"] as const;
type Probe = (typeof probes)[number];

const setup = async (home: string, budget: boolean) => {
  const repo = join(home, "repo");
  const cwd = join(repo, "app");
  // The writer directory is inside the worktree but outside cwd, requiring the Git root probe.
  const stateDir = join(repo, "dori-state");
  mkdirSync(cwd, { recursive: true });
  const git = async (...args: string[]) => {
    const result = await run(["git", "-C", repo, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);
  };
  await git("init", "--quiet");
  await git("config", "core.excludesFile", "/dev/null");
  writeFileSync(join(repo, ".git", "info", "exclude"), "/dori-state/\n");
  writeFileSync(join(cwd, "work.txt"), "staged work\n");
  await git("add", "--", "app/work.txt");

  const lane: Lane = {
    key,
    title: "Freshness Git timeout",
    thread: budget ? "none" : "123",
    pane: "w:p1",
    brief: "/b.md",
    done: "",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
    cwd,
  };
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
  const deps = depsFor(world, clock, stateDir, {
    nudgeAfterMin: 999,
    postAfterMin: 22,
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
    supervision: {
      hungAfterMinutes: 20,
      staleAfterMinutes: 20,
      ...(budget ? { defaults: { wallMinutes: 5, tokens: 10 }, usageArgv: ["fixture-usage"] } : {}),
    },
  });
  await deps.registry.write(lane);
  const reports = new Reports(stateDir);
  const journalPath = reports.path(key);
  reports.report(key, "milestone", "staged the initial change", T0);
  const posted: string[][] = [];
  let usageReads = 0;
  return {
    reports,
    posted,
    edit: () => writeFileSync(join(cwd, "work.txt"), "unstaged work after the verified sample\n"),
    usageReads: () => usageReads,
    stored: () => deps.registry.read(key),
    journal: () => readFileSync(journalPath, "utf8"),
    observation: (): Observation => JSON.parse(readFileSync(join(dirname(journalPath), "supervision.json"), "utf8")),
    tick: async (minutes: number, failure?: Probe) => {
      let injected = false;
      const runner: Runner = (argv, opts) => {
        if (argv[0] === "git") {
          if (!injected && failure !== undefined && argv[3] === failure) {
            injected = true;
            return Promise.resolve({ code: 124, out: "", err: "timeout" });
          }
          return run(argv, opts);
        }
        if (argv[0] === "notify") posted.push([...argv.slice(1)]);
        if (argv[0] === "fixture-usage") {
          usageReads++;
          return Promise.resolve({ code: 0, out: JSON.stringify({ tokens: minutes < 5 ? 1 : 10 }), err: "" });
        }
        return deps.run(argv, opts);
      };
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      const acts = await freshnessTick({ ...deps, run: runner }, home);
      expect(injected).toBe(failure !== undefined);
      return acts;
    },
  };
};

test("a required Git root timeout suppresses a current stalled milestone but still posts a new question", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, false);
    expect(await f.tick(0)).toEqual([]);
    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    // The current journal event is the stall, not the older milestone it retains as its last report.
    expect(f.reports.read(key)).toMatchObject({
      state: "stalled",
      lastEvent: { type: "activity", state: "stalled" },
      lastReport: { kind: "milestone", text: "staged the initial change" },
    });
    expect((await f.stored())?.lastPostedReport).toBeUndefined();
    const stalled = f.journal();
    expect(await f.tick(22, "rev-parse")).toEqual([
      { kind: "supervision-error", lane: key, detail: expect.stringContaining("git rev-parse exited 124") },
    ]);
    expect(f.posted).toEqual([]);
    expect(f.journal()).toBe(stalled);
    expect((await f.stored())?.lastPostedReport).toBeUndefined();

    f.reports.report(key, "question", "which option should I take?", T0 + 23 * MIN);
    expect(f.reports.read(key)?.state).toBe("blocked");
    const detail = "Progress (from the lane's last report): which option should I take?";
    expect(await f.tick(23, "rev-parse")).toEqual([{ kind: "posted", lane: key, detail }]);
    expect(await f.tick(24, "rev-parse")).toEqual([]);
    expect(f.posted).toEqual([["123", detail]]);
  } finally {
    fixture.done();
  }
});

test.each(probes)("an initial Git %s timeout still applies and deduplicates wall and usage ceilings", async (probe) => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true);
    expect(await f.tick(0)).toEqual([]);
    expect(f.reports.read(key)?.state).toBe("running");
    expect(f.usageReads()).toBe(1);
    const verified = f.observation();
    if (verified.activity === null) throw new Error("missing verified activity sample");
    const previous = JSON.parse(verified.activity);
    expect(previous.changes).toEqual(["A  app/work.txt"]);
    expect(previous.files).toHaveLength(1);
    f.edit();

    const ceilings = ["wallMinutes ceiling reached (5)", "tokens ceiling reached (10)"];
    const effects = await f.tick(5, probe);
    expect(effects.filter((act) => act.kind === "supervision-error")).toEqual([
      { kind: "supervision-error", lane: key, detail: expect.stringContaining(`git ${probe} exited 124`) },
    ]);
    expect(effects.filter((act) => act.kind === "blocked").map((act) => act.detail)).toEqual(ceilings);
    expect(f.usageReads()).toBe(2);
    expect(f.reports.read(key)).toMatchObject({
      state: "blocked",
      lastReport: { kind: "blocker", text: ceilings.join("; "), at: new Date(T0 + 5 * MIN).toISOString() },
    });
    const blocked = f.journal();
    expect(await f.tick(6, probe)).toEqual([]);
    expect(f.usageReads()).toBe(3);
    expect(f.journal()).toBe(blocked);
    // The alert receipt changes, but the verified Git signature and activity clock do not.
    expect(f.observation()).toEqual({ ...verified, alerts: ceilings });
  } finally {
    fixture.done();
  }
});

test("budget alerts before any successful Git sample do not create an activity baseline", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true);
    const ceilings = ["wallMinutes ceiling reached (5)", "tokens ceiling reached (10)"];
    expect((await f.tick(5, "status")).filter((act) => act.kind === "blocked").map((act) => act.detail)).toEqual(
      ceilings,
    );
    expect(f.observation()).toMatchObject({ activity: null, timer: null, alerts: ceilings });
    expect(await f.tick(6, "status")).toEqual([]);
    expect(await f.tick(7)).toEqual([]);
    expect(f.observation()).toMatchObject({
      activity: expect.stringContaining("A  app/work.txt"),
      activeAt: T0 + 7 * MIN,
      alerts: ceilings,
    });
  } finally {
    fixture.done();
  }
});
