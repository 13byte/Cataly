import { basename, isAbsolute, resolve } from "node:path";

// Which words of a watch's own command may name a lane. A command's own words say what it runs, never which lane: the
// program at each command start, the launchers before it, and for dori its command and, for a messenger command, the
// platform. `dori inbound slack` is not lane "dori", "inbound" or "slack", nor is it behind `env -u NODE_OPTIONS`,
// `timeout 60`, `nice -n 10`, `FOO="a b"` or `bash -lc 'exec -a name ...'`. The same names in an argument position
// (`dori checkpoints dori`, `rg -c dori api-fix`) are arguments and may name the lane. A prefix that cannot be read
// leaves its words to the lane match, as before this rule. The launcher rules are those of runtime/omp-argv.ts.
const DORI_PROGRAMS: Record<string, true> = { dori: true, "omp-dori": true };
// The skill CLI, never the harness's repo `src/cli.ts`; a relative path is read from the watch's cwd.
const DORI_SOURCE = /(?:^|\/)skills\/dori-mode\/scripts\/src\/cli\.ts$/;
const PLATFORM_COMMANDS: Record<string, true> = {
  send: true,
  presence: true,
  inbound: true,
  thread: true,
  react: true,
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SEPARATORS: Record<string, true> = { "&&": true, "||": true, ";": true, "|": true, "&": true };
const SHELLS: Record<string, true> = { sh: true, bash: true, dash: true, zsh: true, ksh: true, fish: true };
const SCRIPT_OPTION = /^-[A-Za-z]*c$/;
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
// Launchers that run their command unchanged: the options that take a separate value and the operands before the
// command (timeout's duration). Their other options are flags.
type Launcher = { readonly values: readonly string[]; readonly operands: number };
const LAUNCHERS: Record<string, Launcher> = {
  nohup: { values: [], operands: 0 },
  nice: { values: ["-n", "--adjustment"], operands: 0 },
  timeout: { values: ["-k", "--kill-after", "-s", "--signal"], operands: 1 },
  setsid: { values: [], operands: 0 },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], operands: 0 },
  caffeinate: { values: ["-t", "-w"], operands: 0 },
  exec: { values: ["-a"], operands: 0 },
  command: { values: [], operands: 0 },
};

/** GNU getopt_long accepts any unambiguous prefix of a long option name. */
const envLong = (name: string): "flag" | "operand" | undefined => {
  if (Object.hasOwn(ENV_LONG, name)) return ENV_LONG[name];
  const matches = Object.keys(ENV_LONG).filter((option) => name !== "" && option.startsWith(name));
  return matches.length === 1 ? ENV_LONG[matches[0] ?? ""] : undefined;
};

/** Where `env [OPTION]... [-] [NAME=VALUE]... COMMAND` starts COMMAND; undefined for an option it cannot read. */
const envCommandAt = (words: readonly string[], at: number): number | undefined => {
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

const launcherCommandAt = (words: readonly string[], at: number, launcher: Launcher): number | undefined => {
  while (words[at]?.startsWith("-") && words[at] !== "-") {
    const word = words[at++] ?? "";
    if (word === "--") break;
    if (launcher.values.some((value) => value === word || (word.startsWith("--") && value.startsWith(word)))) at++;
  }
  at += launcher.operands;
  return at < words.length ? at : undefined;
};

/**
 * The words of a watch's argv (exact) or command string (split at whitespace, shell-quoted) that may name a lane:
 * every word except its own command words. Anything else gives no words.
 */
export const laneWords = (command: unknown, cwd: unknown): readonly unknown[] => {
  const shell = typeof command === "string";
  const raw: readonly unknown[] = shell ? command.split(/\s+/).filter(Boolean) : Array.isArray(command) ? command : [];
  const words = raw.map((word) => (typeof word !== "string" ? "" : shell ? word.replace(/^['"]+|['"]+$/g, "") : word));
  const own = new Set<number>();
  const commandAt = (from: number): void => {
    let at = from;
    for (;;) {
      while (ASSIGNMENT.test(words[at] ?? "")) {
        // `FOO="a b"` was split at its space: its value goes on to the word that closes the quote.
        const quote = shell ? ['"', "'"].find((q) => String(raw[at]).split(q).length % 2 === 0) : undefined;
        at++;
        if (quote === undefined) continue;
        while (at < words.length) if (String(raw[at++]).includes(quote)) break;
      }
      const name = basename(words[at] ?? "");
      if (at >= words.length) return;
      own.add(at);
      let next: number | undefined;
      if (name === "env") next = envCommandAt(words, at + 1);
      else if (Object.hasOwn(LAUNCHERS, name)) next = launcherCommandAt(words, at + 1, LAUNCHERS[name] as Launcher);
      else if (shell && SHELLS[name] === true) {
        // A shell's `-c` script starts a command; `rg -c` and a shell running a file do not.
        for (let i = at + 1; next === undefined && words[i]?.startsWith("-"); i++)
          if (SCRIPT_OPTION.test(words[i] ?? "")) next = i + 1;
      } else break;
      if (next === undefined || next >= words.length) return;
      at = next;
    }
    const name = basename(words[at] ?? "");
    let program = -1;
    if (DORI_PROGRAMS[name] === true) program = at;
    else if (name === "bun") {
      const script = words[at + 1] === "run" ? at + 2 : at + 1;
      const path = words[script] ?? "";
      const full = isAbsolute(path) ? path : typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd, path) : "";
      if (DORI_SOURCE.test(full)) {
        for (let i = at; i <= script; i++) own.add(i);
        program = script;
      }
    }
    if (program < 0) return;
    own.add(program + 1);
    if (PLATFORM_COMMANDS[words[program + 1] ?? ""] === true) own.add(program + 2);
  };
  commandAt(0);
  // A shell command string starts another command after a separator (`cd /srv && exec dori ...`, `cd /srv; dori`).
  if (shell)
    for (let at = 0; at < words.length; at++)
      if (SEPARATORS[words[at] ?? ""] === true || /.;$/.test(words[at] ?? "")) commandAt(at + 1);
  return shell ? words.filter((word, at) => word && !own.has(at)) : raw.filter((_, at) => !own.has(at));
};
