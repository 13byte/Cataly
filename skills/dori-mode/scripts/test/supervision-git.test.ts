import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run, type Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;

const layouts = ["direct", "cwd symlink", "state symlink", "literal mode", "cwd symlink parent"];
test.each(layouts)("freshness preserves tracked Git activity but not its writer lock (%s)", async (layout) => {
  const fixture = withState();
  try {
    const repo = join(fixture.dir, "worktree");
    mkdirSync(repo);
    const throughParent = layout === "cwd symlink parent";
    const actualState = join(repo, "dori-state");
    const alias = join(fixture.dir, "alias");
    if (layout === "cwd symlink") symlinkSync(repo, alias, "dir");
    if (layout === "state symlink") symlinkSync(actualState, alias, "dir");
    const link = join(fixture.dir, "link");
    if (throughParent) {
      const subdir = join(repo, "subdir");
      mkdirSync(subdir);
      symlinkSync(subdir, link, "dir");
      symlinkSync(actualState, join(fixture.dir, "dori-state"), "dir");
    }
    const stateDir = layout === "state symlink" ? alias : actualState;
    const key = "git-lock-lane";
    const lanePath = `dori-state/lanes/${key}`;
    const trackedPath = `${lanePath}/tracked.txt`;
    const git = async (...args: string[]) => {
      const result = await run(["git", "-C", repo, ...args]);
      if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);
    };
    await git("init", "--quiet");
    await git("config", "core.excludesFile", "/dev/null");
    mkdirSync(join(repo, lanePath), { recursive: true });
    // A tracked file here keeps Git from collapsing this lane's lock into an untracked directory entry.
    writeFileSync(join(repo, trackedPath), "initial\n");
    writeFileSync(
      join(repo, ".gitignore"),
      [`/dori-state/lanes/${key}.json`, `/${lanePath}/reports.jsonl`, `/${lanePath}/supervision.json`, ""].join("\n"),
    );
    await git("add", "--", ".gitignore", trackedPath);
    await git(
      "-c",
      "user.name=Dori Fixture",
      "-c",
      "user.email=dori@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "Seed lane",
    );

    const clock = fakeClock(T0);
    const world = newWorld();
    const lane: Lane = {
      key,
      title: "Git writer lock",
      thread: "none",
      pane: "w:p1",
      brief: "/b.md",
      done: "",
      openedAt: new Date(T0).toISOString(),
      reportProtocol: "jsonl-v1",
      cwd: throughParent ? `${link}/..` : layout === "cwd symlink" ? alias : repo,
    };
    world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
    const deps = depsFor(world, clock, stateDir, {
      nudgeAfterMin: 999,
      postAfterMin: 999,
      supervision: { hungAfterMinutes: 20, staleAfterMinutes: 20 },
    });
    const reports = new Reports(stateDir);
    await deps.registry.write(lane);
    reports.report(key, "milestone", "started", T0);

    const statuses: string[][] = [];
    const sample: Runner = async (argv, opts) => {
      if (argv[0] !== "git" || !argv.includes("status")) return deps.run(argv, opts);
      const env = layout === "literal mode" ? { GIT_LITERAL_PATHSPECS: "1", ...opts?.env } : opts?.env;
      const result = await run(argv, env ? { ...opts, env } : opts);
      if (result.code !== 0) throw new Error(`git status: ${result.err}`);
      const entries = result.out.split("\0");
      statuses.push(entries);
      for (const entry of entries) {
        const path = entry.slice(3);
        const oldLock =
          path.startsWith(`${lanePath}/`) &&
          /^supervision\.json\.[a-f0-9]{64}\.lock$/.test(path.slice(lanePath.length + 1));
        if (entry.startsWith("?? ") && (oldLock || path === "dori-state/lanes/.supervision-writers/")) {
          // Give any reported writer artifact distinct mtimes, without replacing real Git output.
          const stamp = clock.now() / 1000;
          utimesSync(join(repo, path), stamp, stamp);
        }
      }
      return result;
    };
    const tick = (minutes: number) => {
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      return freshnessTick({ ...deps, run: sample }, fixture.dir);
    };

    expect(await tick(0)).toEqual([]);
    writeFileSync(join(repo, trackedPath), "real lane work\n");
    const firstChangedSample = statuses.length;
    expect(await tick(20)).toEqual([]);
    expect(statuses[firstChangedSample]).toContain(` M ${trackedPath}`);
    expect(reports.read(key)?.state).toBe("running");

    // The tracked edit is still dirty, but unchanged. Another full interval without activity must stall.
    expect((await tick(40)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(reports.read(key)?.state).toBe("stalled");
  } finally {
    fixture.done();
  }
});
