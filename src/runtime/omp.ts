import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import type { ForegroundProcess, Probe } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;
type PaneState = {
  readonly paneId: string;
  readonly role: "dori" | "lane";
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly approvalPending: boolean;
  readonly agentStatus?: "idle" | "working";
};
type Proc = { readonly pid: number; readonly ppid: number; readonly command: string };

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** The extension's config/state precedence; callers with loaded config pass stateDir explicitly. */
export function ompStateDir(env: Env): string {
  if (env["DORI_STATE_DIR"] !== undefined) return expandHome(env["DORI_STATE_DIR"]);
  const doriHome = env["DORI_HOME"] ?? join(homedir(), ".dori");
  const path = env["DORI_CONFIG"] ?? join(doriHome, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(doriHome, "state");
  }
  const config = JSON.parse(raw) as { stateDir?: string };
  return expandHome(config.stateDir ?? join(doriHome, "state"));
}

// The one classification of OMP's launch forms: the `omp` command, its published package CLI under Bun or Node, and the
// pinned source launcher (`bun --preload <pkg>/scripts/omp.ts [--preload <timer>] <pkg>/[scripts/../]src/cli.ts`).
// Each representation has its own parser below; none of them attests a live process (withOmpState does that).
const OMP_COMMAND =
  /^(?:(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+)?(?:\S*\/)?omp(?:\s|$)|^(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+\S*@oh-my-pi\/pi-coding-agent\/dist\/cli\.js(?:\s|$)/;
const SOURCE_OMP_COMMAND =
  /^(?:\S*\/)?bun\s+--preload\s+(.+\/packages\/coding-agent\/)scripts\/omp\.ts\s+(?:--preload\s+\1scripts\/\.\.\/\.\.\/utils\/src\/module-timer\.ts\s+)?\1(?:scripts\/\.\.\/)?src\/cli\.ts(?:\s|$)/;
const OMP_EXECUTABLE = /(?:^|\/)omp$|@oh-my-pi\/pi-coding-agent\/dist\/cli\.js$/;

const sourceOmpArgv = (argv: readonly string[]): boolean => {
  if (!/(?:^|\/)bun$/.test(argv[0] ?? "") || argv[1] !== "--preload") return false;
  const root = /^(.+\/packages\/coding-agent\/)scripts\/omp\.ts$/.exec(argv[2] ?? "")?.[1];
  if (root === undefined) return false;
  const timing = argv[3] === "--preload";
  if (timing && argv[4] !== `${root}scripts/../../utils/src/module-timer.ts`) return false;
  const entry = argv[timing ? 5 : 3];
  return entry === `${root}src/cli.ts` || entry === `${root}scripts/../src/cli.ts`;
};

/** A `ps` command line of an OMP process. Its argument boundaries are lost, so source roots may contain spaces. */
export const isOmpProcessCommand = (command: string): boolean =>
  OMP_COMMAND.test(command) || SOURCE_OMP_COMMAND.test(command);

/**
 * A `ps` command line that names OMP anywhere, as `bun run <omp>` or a published CLI under a spaced root does. Only
 * discovery without the extension's record uses it (the start-time session folder); trust keeps the exact forms above.
 */
export const namesOmpProcess = (command: string): boolean =>
  isOmpProcessCommand(command) || /(?:^|\s)(?:\S*\/)?omp(?:\s|$)|pi-coding-agent\/dist\/cli\.js/.test(command);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// GNU env's long options: those that take a separate operand when written without `=`, and those that take none.
const ENV_LONG: Record<string, "flag" | "operand"> = {
  "ignore-environment": "flag",
  null: "flag",
  debug: "flag",
  "block-signal": "flag",
  "default-signal": "flag",
  "ignore-signal": "flag",
  "list-signal-handling": "flag",
  unset: "operand",
  chdir: "operand",
  argv0: "operand",
};

/** GNU getopt_long accepts any unambiguous prefix of a long option name. */
const envLong = (name: string): "flag" | "operand" | undefined => {
  if (Object.hasOwn(ENV_LONG, name)) return ENV_LONG[name];
  const matches = Object.keys(ENV_LONG).filter((option) => name !== "" && option.startsWith(name));
  return matches.length === 1 ? ENV_LONG[matches[0]!] : undefined;
};

/**
 * The index where `env [OPTION]... [-] [NAME=VALUE]... COMMAND` starts COMMAND, or undefined when an option is not one
 * of the GNU/BSD options that only change the environment or directory. `-S`/`--split-string` re-parses a string with
 * its own quoting, escapes and comments, so it is not decoded here.
 */
function envCommandAt(argv: readonly string[], at: number): number | undefined {
  for (;;) {
    const word = argv[at];
    if (word === undefined || word === "-" || !word.startsWith("-")) break;
    at++;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const kind = envLong(word.slice(2, equals < 0 ? undefined : equals));
      if (kind === undefined) return undefined;
      if (kind === "operand" && equals < 0) at++;
      continue;
    }
    for (let i = 1; i < word.length; i++) {
      const flag = word[i];
      if (flag === "i" || flag === "0" || flag === "v") continue;
      if (flag !== "u" && flag !== "C" && flag !== "P" && flag !== "a") return undefined;
      if (i + 1 === word.length) at++;
      break;
    }
  }
  if (argv[at] === "-") at++;
  // env takes every word with a `=` as an assignment, not only shell-style names.
  while (argv[at]?.includes("=")) at++;
  return at < argv.length ? at : undefined;
}

// Launchers that run their command unchanged: the options that take a separate value and the operands before the
// command (timeout's duration). Their other options are flags. Others (sudo, xargs, any script) are external commands.
type Launcher = { readonly values: readonly string[]; readonly operands: number };
const LAUNCHERS: Record<string, Launcher> = {
  nohup: { values: [], operands: 0 },
  nice: { values: ["-n", "--adjustment"], operands: 0 },
  timeout: { values: ["-k", "--kill-after", "-s", "--signal"], operands: 1 },
  setsid: { values: [], operands: 0 },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], operands: 0 },
  caffeinate: { values: ["-t", "-w"], operands: 0 },
};
// Package runners: options with a separate value, and those whose value is a command string Dori does not decode.
const RUNNER_VALUES = new Set(["-p", "--package"]);
const RUNNER_STRINGS = new Set(["-c", "--call"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

/** The index of a launcher's command after its options and operands, or undefined when there is none. */
function launcherCommandAt(argv: readonly string[], at: number, launcher: Launcher): number | undefined {
  while (argv[at]?.startsWith("-") && argv[at] !== "-") {
    const word = argv[at++]!;
    if (word === "--") break;
    // getopt_long accepts an unambiguous prefix of a long option (`--kill` for `--kill-after`).
    if (launcher.values.some((value) => value === word || (word.startsWith("--") && value.startsWith(word)))) at++;
  }
  at += launcher.operands;
  return at < argv.length ? at : undefined;
}

/** The index of the bin a package runner (`npx`, `bunx`, `bun x`) executes, or undefined when it cannot be read. */
function runnerCommandAt(argv: readonly string[], at: number): number | undefined {
  while (argv[at]?.startsWith("-")) {
    const word = argv[at++]!;
    if (word === "--") break;
    if (RUNNER_STRINGS.has(word.split("=")[0]!)) return undefined;
    if (RUNNER_VALUES.has(word)) at++;
  }
  return at < argv.length ? at : undefined;
}

// A word naming OMP's executable, published entry or source launcher (the change-before detector's words).
const OMP_WORD =
  /(?:^|[/\\])omp(?:\s|$)|pi-coding-agent[/\\]dist[/\\]cli\.js|\/packages\/coding-agent\/scripts\/omp\.ts(?:\s|$)/;
// A command string (`sh -c`, `env -S`, `npx -c`) also names OMP after a separator: `cd /d && exec omp "$@"`.
const OMP_IN_SCRIPT = /(?:^|[\s;&|(])omp(?:[\s;&|)]|$)/;
const SCRIPT_OPTION = /^(?:-[A-Za-z]*c|-S|--split-string|--call)$/;
const names = (words: readonly string[]): boolean =>
  words.some(
    (word, at) => OMP_WORD.test(word) || (SCRIPT_OPTION.test(words[at - 1] ?? "") && OMP_IN_SCRIPT.test(word)),
  );

/**
 * What an exact argv runs, after leading `NAME=value` assignments and the `env` utility with its options: the command
 * itself (that prefix removed), as `omp` when it starts OMP and `other` otherwise, or `unparsed` when a command prefix
 * cannot be read unambiguously, which must not be taken for either.
 */
export type OmpArgv =
  | { readonly kind: "omp" | "other"; readonly command: readonly string[] }
  | { readonly kind: "unparsed" };

export function classifyOmpArgv(argv: readonly string[]): OmpArgv {
  let at = 0;
  let launched = false;
  // Each readable prefix is removed in turn, so `env -i env -u X nice timeout 600 omp` reads like `omp`.
  for (;;) {
    while (ASSIGNMENT.test(argv[at] ?? "")) at++;
    const word = argv[at]?.split("/").at(-1) ?? "";
    let next: number | undefined;
    if (word === "env") next = envCommandAt(argv, at + 1);
    else if (Object.hasOwn(LAUNCHERS, word)) next = launcherCommandAt(argv, at + 1, LAUNCHERS[word]!);
    else if (word === "bunx" || word === "npx") next = runnerCommandAt(argv, at + 1);
    else if (word === "bun" && argv[at + 1] === "x") next = runnerCommandAt(argv, at + 2);
    // The side wrapper's `omp` subcommand runs this home's OMP with the arguments that follow.
    else if (word === "omp-dori" && argv[at + 1] === "omp") next = at + 1;
    else break;
    if (next === undefined) {
      // An unreadable launcher prefix matters only when it may run OMP; any other command keeps its own contract.
      return word === "env" || names(argv.slice(at))
        ? { kind: "unparsed" }
        : { kind: "other", command: argv.slice(at) };
    }
    at = next;
    launched ||= word !== "env";
    if (word === "omp-dori") break;
  }
  const command = argv.slice(at);
  const classified = classifyCommand(command);
  // A launcher option Dori misread (`timeout --unknown 5 600 omp`) leaves a command that only names OMP: refuse it
  // rather than drop the guard. An external wrapper behind a launcher must declare its engine the same way.
  return launched && classified.kind === "other" && names(command) ? { kind: "unparsed" } : classified;
}

/** What a command without assignment, env or launcher prefixes runs. */
function classifyCommand(command: readonly string[]): OmpArgv {
  if (sourceOmpArgv(command)) return { kind: "omp", command };
  const name = command[0]?.split("/").at(-1) ?? "";
  if (OMP_EXECUTABLE.test(command[0] ?? "")) return { kind: "omp", command };
  // A shell runs a script Dori cannot read: one that names OMP must declare its engine.
  if (SHELLS.has(name)) return names(command.slice(1)) ? { kind: "unparsed" } : { kind: "other", command };
  if (name !== "bun" && name !== "node") return { kind: "other", command };
  let script = 1;
  while (command[script]?.startsWith("-")) script++;
  const prefix = name === "bun" && command[script] === "run" ? 2 : 1;
  if (prefix === 2) {
    script++;
    while (command[script]?.startsWith("-")) script++;
  }
  if (OMP_EXECUTABLE.test(command[script] ?? "")) return { kind: "omp", command };
  if (script > prefix && command.slice(script + 1).some((arg) => OMP_EXECUTABLE.test(arg))) return { kind: "unparsed" };
  return { kind: "other", command };
}

/** An exact argv that starts OMP (see classifyOmpArgv); an unparsed command prefix is not one. */
export const isOmpArgv = (argv: readonly string[]): boolean => classifyOmpArgv(argv).kind === "omp";

/**
 * Whether an argv may run OMP: it starts OMP, or a word names OMP (an external wrapper's argument, a shell or `env -S`
 * string); an unreadable prefix of another agent does not. Lane startup and pause use it: they prove an OMP goal
 * only from OMP's trusted session record, so a wrapped OMP is never vouched for by quoted screen text. Role flags and
 * update guards need the exact start instead (isOmpArgv, classifyOmpArgv).
 */
export const mayRunOmpArgv = (argv: readonly string[]): boolean => isOmpArgv(argv) || names(argv);

const ompProcess = (p: ForegroundProcess): boolean =>
  p.name.split("/").at(-1) === "omp" ||
  p.argv.slice(0, 2).some((arg) => OMP_EXECUTABLE.test(arg)) ||
  sourceOmpArgv(p.argv);

function readState(stateDir: string, id: string): PaneState | undefined {
  try {
    const state = JSON.parse(
      readFileSync(join(stateDir, "sessions", `${encodeURIComponent(id)}.json`), "utf8"),
    ) as PaneState;
    if (
      state.paneId !== id ||
      (state.role !== "dori" && state.role !== "lane") ||
      typeof state.sessionId !== "string" ||
      state.sessionId === "" ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 0 ||
      typeof state.approvalPending !== "boolean" ||
      typeof state.startedAt !== "string" ||
      typeof state.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(state.startedAt)) ||
      !Number.isFinite(Date.parse(state.updatedAt)) ||
      Date.parse(state.updatedAt) < Date.parse(state.startedAt) ||
      (state.sessionFile !== undefined && typeof state.sessionFile !== "string")
    ) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

function under(table: readonly Proc[], pid: number, root: number): boolean {
  const seen = new Set<number>();
  for (
    let at: number | undefined = pid;
    at !== undefined && !seen.has(at);
    at = table.find((p) => p.pid === at)?.ppid
  ) {
    if (at === root) return true;
    seen.add(at);
  }
  return false;
}

/** A live OMP writer attests to identity; only its own non-shell foreground can receive delivery. */
export async function withOmpState(exec: Exec, stateDir: string, id: string, probe: Probe): Promise<Probe> {
  if (probe.status === "gone") return probe;
  const state = readState(stateDir, id);
  const omp = probe.agent === "omp" || probe.foreground?.some(ompProcess) === true;
  const unknown = (): Probe => ({ ...probe, status: "unknown" });
  if (state === undefined) return omp && !probe.shellInFront ? unknown() : probe;
  if (probe.rootPid === undefined || !Number.isSafeInteger(probe.rootPid) || probe.rootPid <= 0) return unknown();
  try {
    const result = await exec("ps", ["-A", "-o", "pid=,ppid=,command="]);
    if (result.code !== 0) return unknown();
    const table = result.stdout.split("\n").flatMap((line): Proc[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }] : [];
    });
    const writer = table.find((p) => p.pid === state.pid);
    if (
      writer === undefined ||
      !isOmpProcessCommand(writer.command) ||
      !under(table, writer.pid, probe.rootPid) ||
      (!probe.shellInFront && !probe.foreground?.some((p) => p.pid !== undefined && under(table, p.pid, writer.pid)))
    ) {
      return unknown();
    }
    // PIDs can be reused under the same shell: a newer process cannot have written an older session record.
    const start = await exec("ps", ["-o", "lstart=", "-p", String(writer.pid)]);
    const started = Date.parse(start.stdout.trim());
    if (start.code !== 0 || !Number.isFinite(started) || started > Date.parse(state.startedAt)) return unknown();
    const current = readState(stateDir, id);
    if (
      current === undefined ||
      current.pid !== state.pid ||
      current.sessionId !== state.sessionId ||
      current.startedAt !== state.startedAt
    ) {
      return unknown();
    }
    const status =
      (probe.status === "idle" || probe.status === "working") &&
      (current.agentStatus === "idle" || current.agentStatus === "working")
        ? current.agentStatus
        : probe.status;
    return {
      ...probe,
      status: current.approvalPending ? "blocked" : status,
      pid: current.pid,
      sessionId: current.sessionId,
      ...(current.sessionFile === undefined ? {} : { sessionFile: current.sessionFile }),
      approvalPending: current.approvalPending,
    };
  } catch {
    return unknown();
  }
}
