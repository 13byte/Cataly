import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, type Monitor, monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// Which words of a watch's own command may name a lane: base matched every word; a dori program's own words are
// excluded only where that program starts a command, and never by crashing on a legacy record.
const lane = (key: string, status: LaneStatus): Lane => ({
  key,
  status,
  pane: `w1:${key}`,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: "2026-01-01T12:00:00.000Z",
});

const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })),
  },
});

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a legacy record whose argv holds a non-string is still matched by its command, as before", () => {
  const dir = join(state.dir, "legacy");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "owner.json"),
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [
        { sessionId: "owner", persistent: true, monitorId: "mon_TEST", argv: [7], command: "dori checkpoints api" },
      ],
    }),
  );
  const read = readMonitorManifests(join(state.dir, "missing"), [dir]);
  expect(read.errors).toEqual([]);
  expect(monitorCleanup([lane("api", "closed")], read.manifests).map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_TEST", ["api:command:key"]],
  ]);
});

test("a closed lane named in an argument position is still claimed, even when its key is a dori program name", () => {
  const lanes = ["dori", "omp-dori", "api-fix", "harness-lane"].map((key) => lane(key, "closed"));
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["dori", "checkpoints", "dori"], monitorId: "mon_DORI" },
      { argv: ["dori", "checkpoints", "omp-dori"], monitorId: "mon_OMP" },
      { command: "dori checkpoints dori", monitorId: "mon_COMMAND" },
      { argv: ["rg", "-n", "/src/omp-dori", "api-fix"], monitorId: "mon_PATH" },
      { argv: ["bun", "/repo/src/cli.ts", "send", "harness-lane", "hi"], monitorId: "mon_HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_DORI", ["dori:argv:key"]],
    ["mon_OMP", ["omp-dori:argv:key"]],
    ["mon_COMMAND", ["dori:command:key"]],
    ["mon_PATH", ["api-fix:argv:key"]],
    ["mon_HARNESS", ["harness-lane:argv:key"]],
  ]);
});

test("a shared dori watch behind a launcher with options is still not claimed by its own command words", () => {
  const lanes = ["dori", "inbound", "slack"].map((key) => lane(key, "closed"));
  const argv = [
    ["env", "-u", "NODE_OPTIONS", "dori", "inbound", "slack"],
    ["env", "-i", "/home/user/.dori/bin/dori", "inbound", "slack"],
    ["timeout", "60", "dori", "inbound", "slack"],
    ["timeout", "--signal", "TERM", "60", "dori", "inbound", "slack"],
    ["nice", "-n", "10", "dori", "inbound", "slack"],
    ["stdbuf", "-oL", "dori", "inbound", "slack"],
    ["FOO=a b", "dori", "inbound", "slack"],
  ];
  const commands = [
    'FOO="a b" dori inbound slack',
    "env -u NODE_OPTIONS dori inbound slack",
    "bash -lc 'exec -a intake dori inbound slack'",
    'sh -c "nohup dori inbound slack"',
  ];
  const monitors = [...argv.map((words) => ({ argv: words })), ...commands.map((command) => ({ command }))];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
});

test("a relative source entry is read from the watch's cwd: the skill CLI is dori, the harness CLI is not", () => {
  const lanes = ["freshness", "api-fix"].map((key) => lane(key, "closed"));
  const skill = "/w/skills/dori-mode/scripts";
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["bun", "src/cli.ts", "freshness"], cwd: skill, monitorId: "mon_SKILL" },
      { command: "bun run src/cli.ts freshness", cwd: skill, monitorId: "mon_SKILL_COMMAND" },
      { argv: ["bun", "src/cli.ts", "send", "api-fix", "hi"], cwd: "/w", monitorId: "mon_HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["mon_HARNESS", ["api-fix:argv:key"]]]);
});

test("-c starts a script only after a shell: rg -c dori api-fix still names lane api-fix", () => {
  const result = monitorCleanup(
    [lane("api-fix", "closed")],
    [
      manifest([
        { argv: ["rg", "-c", "dori", "api-fix"], monitorId: "mon_ARGV" },
        { command: "rg -c dori api-fix", monitorId: "mon_COMMAND" },
      ]),
    ],
  );
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_ARGV", ["api-fix:argv:key"]],
    ["mon_COMMAND", ["api-fix:command:key"]],
  ]);
});
