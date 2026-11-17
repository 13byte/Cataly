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

// Launchers that run their command unchanged: the options that take a value, the flag options, and the operands
// before the command (timeout's duration). Any other option makes the prefix unreadable: a value Dori misread could
// otherwise be taken for the command. Other programs (sudo, xargs, any script) are external commands.
type Launcher = { readonly values: readonly string[]; readonly flags: readonly string[]; readonly operands: number };
const LAUNCHERS: Record<string, Launcher> = {
  nohup: { values: [], flags: [], operands: 0 },
  nice: { values: ["-n", "--adjustment"], flags: [], operands: 0 },
  timeout: {
    values: ["-k", "--kill-after", "-s", "--signal"],
    flags: ["-v", "--verbose", "-p", "--preserve-status", "-f", "--foreground"],
    operands: 1,
  },
  setsid: { values: [], flags: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"], operands: 0 },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], flags: [], operands: 0 },
  caffeinate: { values: ["-t", "-w"], flags: ["-d", "-i", "-m", "-s", "-u"], operands: 0 },
};
// Package runners (`npx`, `bunx`, `bun x`), read the same way; `-c`/`--call` take a command string, which is unread.
const RUNNER: Launcher = {
  values: ["-p", "--package", "--cache", "--userconfig", "--registry", "--prefix", "-w", "--workspace", "--cwd"],
  flags: [
    ...["-y", "--yes", "--no", "--no-install", "-q", "--quiet", "--offline", "--prefer-offline", "--prefer-online"],
    ...["--ignore-existing", "--bun", "--verbose", "--silent"],
  ],
  operands: 0,
};
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

/** The long option `word` names, exactly or by an unambiguous getopt_long prefix. */
const longOption = (word: string, options: readonly string[]): boolean =>
  options.includes(word) || options.filter((name) => name.startsWith("--") && name.startsWith(word)).length === 1;

/** The index of a launcher's command after its options and operands, or undefined when it cannot be read. */
function launcherCommandAt(argv: readonly string[], at: number, launcher: Launcher): number | undefined {
  const { flags } = launcher;
  while (argv[at]?.startsWith("-") && argv[at] !== "-") {
    const word = argv[at++]!;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      if (equals >= 0 ? !longOption(word.slice(0, equals), launcher.values) : !longOption(word, flags)) {
        if (equals >= 0 || !longOption(word, launcher.values)) return undefined;
        at++;
      }
      continue;
    }
    if (launcher === LAUNCHERS["nice"] && /^-\d+$/.test(word)) continue;
    // A short cluster (`-vk 5`, `-it600`): flags, then at most one option whose value is attached or the next word.
    for (let i = 1; i < word.length; i++) {
      const short = `-${word[i]}`;
      if (flags.includes(short)) continue;
      if (!launcher.values.includes(short)) return undefined;
      if (i + 1 === word.length) at++;
      break;
    }
  }
  at += launcher.operands;
  return at < argv.length ? at : undefined;
}

// A word naming OMP's executable or published entry (the change-before detector's words), or the source launcher's
// preload as a whole word: prose that mentions the path is not one.
const OMP_WORD =
  /(?:^|[/\\])omp(?:\s|$)|pi-coding-agent[/\\]dist[/\\]cli\.js|^\S*\/packages\/coding-agent\/scripts\/omp\.ts$/;
// The command string of a shell (`sh -c`), `env -S` or a package runner (`npx -c`, `--call=`) is not parsed: shell
// quoting, expansion and redirection can run OMP in too many ways. One that mentions an omp token anywhere is
// unreadable, so an update agent must declare `engine` for it; a false match only asks for that declaration. Only those
// programs' (or a launcher's) script options are read so; another agent's `-c` is its own setting.
const OMP_TOKEN = /(?:^|[^\w.-])omp(?:[^\w.-]|$)|pi-coding-agent[/\\]dist[/\\]cli\.js|coding-agent\/scripts\/omp\.ts/;
// For lanes, which must not take another agent's prose for OMP, a script runs OMP when an omp executable stands where a
// command starts: after the start, a separator, or `exec`/`then`/`do`/`else`/`time`/`command`/`nohup`, possibly quoted
// or as a path (`exec "$HOME/bin/omp"`); a value or comment that only mentions it (`x="omp"`, `# was omp`) does not.
const OMP_RUN =
  /(?:^|[;&|(\n]|\b(?:exec|then|do|else|time|command|nohup)\s)\s*["']?(?:[^\s"';&|()=]*\/)?omp["']?(?=\s|$|[;&|)])|coding-agent\/scripts\/omp\.ts|pi-coding-agent[/\\]dist[/\\]cli\.js/;
const SCRIPT_OPTION = /^(?:-[A-Za-z]*c[A-Za-z]*|-S|--split-string|--call)$/;
const SCRIPT_PROGRAMS = new Set([...SHELLS, ...Object.keys(LAUNCHERS), "env", "npx", "bunx", "bun"]);
// `words` start at a program (assignments aside): only that program's script option is read as a script, for `token`.
const names = (words: readonly string[], token = OMP_TOKEN): boolean => {
  const program = words.find((word) => !ASSIGNMENT.test(word)) ?? "";
  const scripted = SCRIPT_PROGRAMS.has(program.split("/").at(-1)!);
  return words.some((word, at) => {
    if (OMP_WORD.test(word)) return true;
    if (!scripted) return false;
    const attached = /^(?:--call|--split-string|-[cS])=(.*)$/s.exec(word)?.[1];
    return token.test(attached ?? (SCRIPT_OPTION.test(words[at - 1] ?? "") ? word : ""));
  });
};

/**
 * What an exact argv runs, after leading `NAME=value` assignments and the `env` utility with its options: the command
 * itself (that prefix removed), as `omp` when it starts OMP and `other` otherwise, or `unparsed` when a command prefix
 * cannot be read unambiguously, which must not be taken for either.
 */
export type OmpArgv =
  | { readonly kind: "omp" | "other"; readonly command: readonly string[] }
  | { readonly kind: "unparsed" };

/**
 * Where the command starts once each readable prefix is removed in turn (`env -i env -u X nice timeout 600 omp` reads
 * like `omp`): `stuck` names the prefix word whose options could not be read, which then starts the command.
 */
function prefixEnd(argv: readonly string[]): { at: number; launched: boolean; runner?: true; stuck?: string } {
  let at = 0;
  let launched = false;
  for (;;) {
    while (ASSIGNMENT.test(argv[at] ?? "")) at++;
    const word = argv[at]?.split("/").at(-1) ?? "";
    const subcommand = argv[at + 1];
    let next: number | undefined;
    let runner = false;
    if (word === "env") next = envCommandAt(argv, at + 1);
    else if (Object.hasOwn(LAUNCHERS, word)) next = launcherCommandAt(argv, at + 1, LAUNCHERS[word]!);
    else if (word === "bunx" || word === "npx") [next, runner] = [launcherCommandAt(argv, at + 1, RUNNER), true];
    else if (
      (word === "bun" && subcommand === "x") ||
      (word === "npm" && (subcommand === "exec" || subcommand === "x"))
    )
      [next, runner] = [launcherCommandAt(argv, at + 2, RUNNER), true];
    // The side wrapper's `omp` subcommand runs this home's OMP with the arguments that follow.
    else if (word === "omp-dori" && subcommand === "omp") next = at + 1;
    else return { at, launched };
    if (next === undefined) return { at, launched, stuck: word };
    at = next;
    launched ||= word !== "env";
    if (word === "omp-dori") return { at, launched };
    // A runner's package spec names the package whose bin it runs: OMP's package runs OMP (its only bin).
    if (runner && OMP_PACKAGE.test(argv[at] ?? "")) return { at, launched, runner: true };
  }
}
const OMP_PACKAGE = /^@oh-my-pi\/pi-coding-agent(?:@\S+)?$/;

export function classifyOmpArgv(argv: readonly string[]): OmpArgv {
  const { at, launched, runner, stuck } = prefixEnd(argv);
  if (runner) return { kind: "omp", command: argv.slice(at) };
  // An unreadable launcher prefix matters only when it may run OMP; any other command keeps its own contract.
  if (stuck !== undefined) {
    return stuck === "env" || names(argv.slice(at)) || assignsOmp(argv, at)
      ? { kind: "unparsed" }
      : { kind: "other", command: argv.slice(at) };
  }
  const command = argv.slice(at);
  const classified = classifyCommand(command);
  // A launcher option Dori misread (`timeout --unknown 5 600 omp`) leaves a command that only names OMP: refuse it
  // rather than drop the guard. An external wrapper behind a launcher must declare its engine the same way, as must a
  // command handed OMP's path in a removed assignment (`env OMP_BIN=/x/omp sh -c 'exec "$OMP_BIN"'`).
  if (classified.kind !== "other") return classified;
  return (launched && names(command)) || assignsOmp(argv, at) ? { kind: "unparsed" } : classified;
}

/** Whether a `NAME=VALUE` word before `at` (a shell or `env` assignment) gives OMP's path, as the old detector read it. */
const assignsOmp = (argv: readonly string[], at: number): boolean =>
  argv
    .slice(0, at)
    .some((word) => /^[^-][^=]*=.*(?:[/\\]omp(?:\s|$)|pi-coding-agent[/\\]dist[/\\]cli\.js)/s.test(word));

/** What a command without assignment, env or launcher prefixes runs. */
function classifyCommand(command: readonly string[]): OmpArgv {
  if (sourceOmpArgv(command)) return { kind: "omp", command };
  const name = command[0]?.split("/").at(-1) ?? "";
  if (OMP_EXECUTABLE.test(command[0] ?? "")) return { kind: "omp", command };
  // A shell runs a script Dori cannot read: one that names OMP must declare its engine.
  if (SHELLS.has(name)) return names(command) ? { kind: "unparsed" } : { kind: "other", command };
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
 * Whether an argv may run OMP: it starts OMP, a word after its readable prefixes names OMP the way the detector
 * before exact classification read it (`/x/omp`, `omp …`, the published CLI), a shell or runner script runs an omp
 * executable as a command (OMP_RUN), or a removed assignment gives OMP's path. Lane startup and pause use it: they prove
 * an OMP goal only from OMP's trusted session record, so a wrapped OMP is never vouched for by quoted screen text,
 * while another agent's prose or `-c` value stays a custom agent. Role flags and update guards need the exact start
 * (isOmpArgv, classifyOmpArgv); update refuses a script that mentions omp at all.
 */
export const mayRunOmpArgv = (argv: readonly string[]): boolean => {
  const { at } = prefixEnd(argv);
  // Readable prefixes are removed first: `env TERM=x codex -c '…omp…'` is codex's own option.
  return isOmpArgv(argv) || assignsOmp(argv, at) || names(argv.slice(at), OMP_RUN);
};
