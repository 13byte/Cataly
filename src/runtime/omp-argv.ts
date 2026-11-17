// What a configured argv runs: OMP's launch forms behind the prefixes Dori reads. Process lines are omp.ts's.
import { OMP_EXECUTABLE, sourceOmpArgv } from "./omp.ts";

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
