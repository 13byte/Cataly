import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// Nothing seen before the 20 s startup check confirms a start: a failure can still show on the screen it reads.

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

test("neither a ready status nor an early goal confirms a start before the 20 s check reads the screen", async () => {
  // Given a herdr pane whose screen changes with the time launch has waited, as a provider failure shows a few
  // seconds after the agent came up.
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const launch = async (
    key: string,
    status: string,
    screenAt: (ms: number) => string,
    patch: { goalMarker?: string } = {},
  ) => {
    world = newWorld();
    let elapsed = 0;
    const sleep = async (ms: number) => {
      elapsed += ms;
    };
    const base = depsFor(world, { ...fakeClock(T0), sleep }, state.dir, {
      agentCommand: ["omo", "--model", "{model}", "{prompt}"],
      ...patch,
    });
    const run = async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list")
        return {
          code: 0,
          out: JSON.stringify({
            result: { panes: [{ pane_id: "w:p9", workspace_id: "w", agent: "pi", agent_status: status }] },
          }),
          err: "",
        };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "read") world.screen = screenAt(elapsed);
      return base.run(argv);
    };
    return (await launchLane({ ...base, run }, { key, title: "t", brief, done: "closed acme/app#3" })).startup;
  };
  const failsFrom = (at: number) => (ms: number) => (ms < at ? "❯ " : "❯ \nNo API key found\n$ ");
  // With no goal marker nothing but the ready status confirms the start, so the 20 s screen still decides it.
  expect(await launch("optout-late", "idle", failsFrom(20_000), { goalMarker: "" })).toBe(
    "STARTUP_ERROR optout-late w:p9: No API key",
  );
  // A working agent with no goal yet: the screen at 20 s is checked whatever the status, as the first check always was.
  expect(await launch("working-late", "working", failsFrom(10_000))).toBe(
    "STARTUP_ERROR working-late w:p9: No API key",
  );
  // A goal that shows at once does not confirm the start before the 20 s screen is checked: an idle agent that shows a
  // failure by then has not started.
  const goalThenFail = (ms: number) => `❯ \n Pursuing goal (1m)${ms < 10_000 ? "" : "\nNo API key found\n$ "}`;
  expect(await launch("goal-then-fail", "idle", goalThenFail)).toBe("STARTUP_ERROR goal-then-fail w:p9: No API key");
  // A clean start is still confirmed at the 20 s check, with or without a marker.
  expect(await launch("optout-clean", "idle", () => "❯ ", { goalMarker: "" })).toBe("STARTUP_OK optout-clean w:p9");
  expect(await launch("goal-clean", "idle", () => "❯ \n Pursuing goal (1m)")).toBe("STARTUP_OK goal-clean w:p9");
});
