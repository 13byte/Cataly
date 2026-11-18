import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, type Monitor, monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import { decisionCommands } from "../src/cli-decisions.ts";
import { journalCommands } from "../src/cli-journal.ts";
import { laneCommands } from "../src/cli-lanes.ts";
import { messengerCommands } from "../src/cli-messenger.ts";
import { opsCommands } from "../src/cli-ops.ts";
import { prCommands } from "../src/cli-pr.ts";
import { DORI_COMMANDS, DORI_VALUE_OPTIONS } from "../src/monitor-dori.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// Which words of a watch's own command may name a lane: base matched every word; each command's program, and a dori
// program's command and platform, are excluded (src/monitor-command.ts), and a legacy record never crashes the match.
// test/boot-monitor-matrix.test.ts holds every reviewed counterexample.
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

test("a relative cli.ts entry is dori's own, and an argument after its command still names a lane", () => {
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

test("a word after a dori program that is no dori command still names a lane: rg -c dori api-fix", () => {
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

test("a shared dori watch inside a loop, a condition, a subshell, a cd or an env -C stays unclaimed", () => {
  const scripts = "/w/skills/dori-mode/scripts";
  const lanes = ["slack", "freshness"].map((key) => lane(key, "closed"));
  const monitors: Monitor[] = [
    { command: "while true; do dori inbound slack --loop 1; sleep 3; done" },
    { command: "while true; do exec dori inbound slack --loop 1; done" },
    { command: "if test -f /ready; then dori inbound slack --loop 1; fi" },
    { command: "( dori inbound slack --loop 1 )" },
    { command: `cd ${scripts} && bun src/cli.ts freshness`, cwd: "/repo" },
    { argv: ["env", "-C", scripts, "bun", "src/cli.ts", "freshness"], cwd: "/repo" },
    { argv: ["bun", "src/cli.ts", "freshness"], cwd: scripts },
    { argv: ["timeout", "-vk", "5", "60", "dori", "inbound", "slack"] },
    { command: "bash -O extglob -c 'exec dori inbound slack --loop 1'" },
  ];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
  // An open lane named anywhere still keeps the watch.
  const open = [lane("slack", "working"), lane("api", "closed")];
  expect(monitorCleanup(open, [manifest([{ command: "while true; do dori inbound slack; done # api" }])])).toEqual([]);
});

test("the dori command vocabulary is every command the CLI dispatches", () => {
  const tables = [
    ["cli-journal.ts", journalCommands],
    ["cli-lanes.ts", laneCommands],
    ["cli-ops.ts", opsCommands],
    ["cli-messenger.ts", messengerCommands],
    ["cli-decisions.ts", decisionCommands],
    ["cli-pr.ts", prCommands],
  ] as const;
  // Every word the CLI dispatches, and the module the command lives in: cli.ts's own three come before its tables.
  const groupOf = new Map<string, string>([
    ["harness", "cli-harness.ts"],
    ["update", "/src/release/cli.ts"],
    ["upstream", "/src/update/cli.ts"],
  ]);
  for (const [module, table] of tables) for (const name of Object.keys(table)) groupOf.set(name, module);
  expect(Object.keys(DORI_COMMANDS).sort()).toEqual([...groupOf.keys()].sort());

  const config = join(state.dir, "config.json");
  mkdirSync(join(state.dir, "state/lanes"), { recursive: true });
  writeFileSync(config, JSON.stringify({ runtime: "herdr", stateDir: join(state.dir, "state"), ompUlwPath: "" }));
  writeFileSync(join(state.dir, "state/lanes/zzz.json"), JSON.stringify(lane("zzz", "working")));
  // The real CLI; the preload fails the load of a blocked module, so a dispatched command stops at its own command
  // module before doing anything and a word no table holds only reaches the usage.
  const invoke = (args: readonly string[], blocked: readonly string[] = []) => {
    const preload = join(state.dir, "load-guard.ts");
    writeFileSync(
      preload,
      `import { plugin } from "bun";
import { readFileSync } from "node:fs";
const blocked = ${JSON.stringify(blocked)};
plugin({ name: "dispatch-guard", setup(build) {
  build.onLoad({ filter: /[.]ts$/ }, ({ path }) => {
    const hit = blocked.find((suffix) => path.split("\\\\").join("/").endsWith(suffix));
    if (hit) throw new Error("BLOCKED_IMPORT:" + hit);
    return { contents: readFileSync(path, "utf8"), loader: "ts" };
  });
} });
`,
    );
    const run = Bun.spawnSync(
      [process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args],
      {
        cwd: state.dir,
        env: {
          HOME: state.dir,
          PATH: process.env["PATH"] ?? "",
          DORI_CONFIG: config,
          DORI_RUNTIME: "herdr",
          DORI_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
        timeout: 20_000,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
  };
  const missed = [...groupOf].filter(([word, module]) => {
    const run = invoke([word], [module]);
    return run.code === 0 || !run.err.includes(`BLOCKED_IMPORT:${module}`) || run.out.includes("dori <command>");
  });
  expect(missed).toEqual([]);
  // A word no table holds reaches no command module: the CLI prints its usage instead.
  const stray = invoke(["not-a-command"], [...new Set(groupOf.values())]);
  expect({ dispatched: stray.err.includes("BLOCKED_IMPORT"), usage: stray.out.includes("dori <command>") }).toEqual({
    dispatched: false,
    usage: true,
  });
  // A value option consumes the word after it, so the registered lane "zzz" becomes its value and the command finds no
  // lane key: the bare and the followed run both fail. A flag leaves "zzz" the key and reads its journal instead.
  const broken = Object.keys(DORI_VALUE_OPTIONS).filter(
    (option) =>
      invoke(["checkpoints", `--${option}`, "zzz"]).code === 0 || invoke(["checkpoints", `--${option}`]).code === 0,
  );
  expect(broken).toEqual([]);
  // cli.ts exposes no option list, so its parseArgs declaration text is the only source of truth here: every option
  // declared to take a value must be listed, and no flag may be listed as one.
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
  const declared = [...cli.matchAll(/^\s+"?([\w-]+)"?: \{ type: "string"/gm)].map((match) => match[1] ?? "");
  expect(declared.sort()).toEqual(Object.keys(DORI_VALUE_OPTIONS).sort());
  expect(invoke(["checkpoints", "--dry-run", "zzz"])).toMatchObject({ code: 0, out: "[]\n" });
}, 120_000);
