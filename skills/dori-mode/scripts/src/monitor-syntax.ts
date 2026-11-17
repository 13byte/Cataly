// The shell and launcher syntax a watch's command is read with (monitor-command.ts). The launcher rules are those of
// runtime/omp-argv.ts.

/** One word of a command string: its text with quotes, where it is, and whether a new command starts at it. */
export type ShellWord = { readonly text: string; readonly from: number; readonly to: number; readonly starts: boolean };

// Outside quotes these end a word and start a new command; the longer one first.
const OPERATORS = ["&&", "||", "$(", ";", "|", "&", "(", ")", "`"];

/**
 * The words of `line`: split at whitespace and operators outside quotes, with or without spaces around them
 * (`true&&dori`, `a;b`); a line break starts a new command too. A quoted or backslash-escaped part stays in its word
 * (`rg -F \;`), and a backslash before a line break continues the line.
 */
export const shellWords = (line: string): ShellWord[] => {
  const words: ShellWord[] = [];
  let start = -1;
  let starts = true;
  let quote: string | undefined;
  const end = (at: number): void => {
    if (start >= 0) words.push({ text: line.slice(start, at), from: start, to: at, starts });
    if (start >= 0) starts = false;
    start = -1;
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\") {
      if (start < 0 && line[at + 1] === "\n") at++;
      else {
        if (start < 0) start = at;
        at++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    const operator = OPERATORS.find((op) => line.startsWith(op, at));
    if (/\s/.test(char) || operator !== undefined) {
      end(at);
      if (char === "\n" || operator !== undefined) starts = true;
      at += (operator?.length ?? 1) - 1;
      continue;
    }
    if (start < 0) start = at;
    if (char === "'" || char === '"') quote = char;
  }
  end(line.length);
  return words;
};

/**
 * A word as the shell passes it on: quotes removed, escapes resolved (only `\"`, `\\`, `\$`, `` \` `` inside double
 * quotes), line continuations dropped; `at` maps each character back to its index in the word.
 */
export const unquote = (word: string): { readonly text: string; readonly at: readonly number[] } => {
  let text = "";
  const at: number[] = [];
  let quote: string | undefined;
  for (let i = 0; i < word.length; i++) {
    const char = word[i] ?? "";
    const next = word[i + 1] ?? "";
    if (quote !== "'" && char === "\\" && next === "\n") i++;
    else if (quote !== "'" && char === "\\" && next && (quote === undefined || '"\\$`'.includes(next))) {
      text += next;
      at.push(++i);
    } else if (char === quote || (quote === undefined && (char === "'" || char === '"')))
      quote = quote === undefined ? char : undefined;
    else {
      text += char;
      at.push(i);
    }
  }
  return { text, at };
};

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
  return matches.length === 1 ? ENV_LONG[matches[0] ?? ""] : undefined;
};

/** Where `env [OPTION]... [-] [NAME=VALUE]... COMMAND` starts COMMAND; undefined for an option it cannot read. */
export const envCommandAt = (words: readonly string[], at: number): number | undefined => {
  for (;;) {
    const word = words[at];
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
  if (words[at] === "-") at++;
  while (words[at]?.includes("=")) at++;
  return at < words.length ? at : undefined;
};

// Launchers that run their command unchanged: the options that take a value and the operands before the command
// (timeout's duration). Their other options are flags.
type Launcher = { readonly values: readonly string[]; readonly operands: number };
export const LAUNCHERS: Record<string, Launcher> = {
  nohup: { values: [], operands: 0 },
  nice: { values: ["-n", "--adjustment"], operands: 0 },
  timeout: { values: ["-k", "--kill-after", "-s", "--signal"], operands: 1 },
  setsid: { values: [], operands: 0 },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], operands: 0 },
  caffeinate: { values: ["-t", "-w"], operands: 0 },
  // flock's operand is its lock file or descriptor; `flock LOCK -c CMD` runs a shell string (monitor-command.ts).
  flock: { values: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], operands: 1 },
  sudo: {
    values: [
      "-u",
      "-g",
      "-C",
      "-D",
      "-h",
      "-p",
      "-r",
      "-t",
      "-U",
      "-T",
      "--user",
      "--group",
      "--close-from",
      "--chdir",
      "--host",
      "--prompt",
      "--role",
      "--type",
      "--other-user",
      "--command-timeout",
    ],
    operands: 0,
  },
  ionice: { values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"], operands: 0 },
  time: { values: ["-o", "-f", "--output", "--format"], operands: 0 },
};

/** Where a launcher's command starts after its options and operands, or undefined when there is none. */
export const launcherCommandAt = (words: readonly string[], at: number, launcher: Launcher): number | undefined => {
  while (words[at]?.startsWith("-") && words[at] !== "-") {
    const word = words[at++] ?? "";
    if (word === "--") break;
    if (word.startsWith("--")) {
      // getopt_long accepts an unambiguous prefix of a long option (`--kill` for `--kill-after`).
      if (!word.includes("=") && launcher.values.some((value) => value.startsWith("--") && value.startsWith(word)))
        at++;
      continue;
    }
    // A bundle (`-vk 5`, `-oL`): a value option takes the rest of the word, or the next word when it ends the bundle.
    for (let i = 1; i < word.length; i++) {
      if (!launcher.values.includes(`-${word[i]}`)) continue;
      if (i + 1 === word.length) at++;
      break;
    }
  }
  at += launcher.operands;
  return at < words.length ? at : undefined;
};

// Bun's options that take a separate value; the others are flags.
const BUN_VALUES = ["--cwd", "--preload", "-r", "--require", "--import", "--config", "-c", "--env-file", "--define"];

/** `bun [OPTION]... [run] [OPTION]... ENTRY`: where ENTRY is and the directory `--cwd` runs it in. */
export const bunEntryAt = (words: readonly string[], at: number): { at: number; cwd?: string } | undefined => {
  let cwd: string | undefined;
  for (let run = false; at < words.length; at++) {
    const word = words[at] ?? "";
    if (word === "run" && !run) run = true;
    else if (word.startsWith("--cwd=")) cwd = word.slice("--cwd=".length);
    else if (BUN_VALUES.includes(word)) {
      if (word === "--cwd") cwd = words[at + 1];
      at++;
    } else if (!word.startsWith("-")) return { at, ...(cwd === undefined ? {} : { cwd }) };
  }
  return undefined;
};
