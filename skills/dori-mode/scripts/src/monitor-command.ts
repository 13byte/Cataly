import { basename, join } from "node:path";

// Which words of a watch's own command may name a lane. A command string is cut into commands at shell separators
// (`;`, `&&`, `||`, `|`, `&`), after `do`, `then`, `else`, `elif` and `!`, at an opening `(`, `$(`, `{` or backtick,
// and at a shell's `-c` script. Each command's program is its first word after assignments and `exec`, `command`,
// `builtin`, `if`, `while`, `until`; it is never a lane (`tail -F` is not lane `tail`). Behind a launcher (`env`,
// `timeout`, `nice`, `sudo`, ...) the program is the command's first dori program word. A dori program's own words are
// its dori command and, after a messenger command, the platform, skipping options and their values: `dori inbound
// --loop 1 slack` is not lane "slack". Every other word may name a lane, as before: an argument (`dori checkpoints
// --cwd X dori`, `dori send slack --text dori`), a path (`ls /x/dori freshness`) or another program's word
// (`rg -c dori freshness`). A legacy record's non-string argv word is never a program.
/** Every `dori` command: cli.ts's own and its command tables (test/boot-monitor-words.test.ts keeps them in step). */
export const DORI_COMMANDS: Record<string, true> = {
  adopt: true,
  boot: true,
  "can-launch": true,
  checkpoint: true,
  checkpoints: true,
  "claim-done": true,
  close: true,
  "dead-panes": true,
  freshness: true,
  guard: true,
  harness: true,
  heavy: true,
  inbound: true,
  "inbound-lag": true,
  launch: true,
  lesson: true,
  "object-done": true,
  pause: true,
  presence: true,
  react: true,
  report: true,
  resume: true,
  send: true,
  sync: true,
  thread: true,
  transcribe: true,
  update: true,
  upstream: true,
  "verify-pr": true,
  watch: true,
  worklog: true,
};
const MESSENGER_COMMANDS: Record<string, true> = {
  send: true,
  presence: true,
  inbound: true,
  thread: true,
  react: true,
};
const PLATFORMS: Record<string, true> = { slack: true, telegram: true, discord: true };
const DORI_NAMES: Record<string, true> = { dori: true, "omp-dori": true };
// The skill CLI's source entry, never another project's or the harness's `cli.ts`; a relative one is read from the
// watch's cwd or a `cd`, `-C` or `--chdir` directory in the same command.
const SKILL_SOURCE = /(?:^|\/)dori-mode\/scripts\/src\/cli\.ts$/;
const SEPARATORS: Record<string, true> = { ";": true, "&&": true, "||": true, "|": true, "&": true };
// A Set: a `then` key on an object literal reads as a thenable.
const KEYWORDS = new Set(["do", "then", "else", "elif", "!"]);
const PREFIXES: Record<string, true> = { exec: true, command: true, builtin: true, if: true, while: true, until: true };
const LAUNCHERS: Record<string, true> = {
  env: true,
  timeout: true,
  nice: true,
  nohup: true,
  stdbuf: true,
  setsid: true,
  caffeinate: true,
  time: true,
  sudo: true,
  ionice: true,
  flock: true,
};
const SHELLS: Record<string, true> = { sh: true, bash: true, dash: true, zsh: true, ksh: true, fish: true };
const SCRIPT_OPTION = /^-[A-Za-z]*c$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const OPENS = /^['"]*(?:\$\(|[({`])/;

/**
 * The words of a watch's argv (exact) or command string (split at whitespace, quotes trimmed) that may name a lane:
 * every word except its own command words. Anything else gives no words.
 */
export const laneWords = (command: unknown, cwd: unknown): readonly unknown[] => {
  const shell = typeof command === "string";
  const raw: readonly unknown[] = shell ? command.split(/\s+/).filter(Boolean) : Array.isArray(command) ? command : [];
  const text = raw.map((word) => (typeof word === "string" ? word : ""));
  // Each word as the program it may be: without quotes, brackets, `$(`, backticks and a trailing `;`.
  const words = text.map((word) => word.replace(/^(?:\$\(|[({`'"])+/, "").replace(/[)}`'";]+$/, ""));
  const dirs = typeof cwd === "string" ? [cwd] : [];
  words.forEach((word, at) => {
    if (word.startsWith("--chdir=")) dirs.push(word.slice("--chdir=".length));
    else if (["cd", "-C", "--chdir"].includes(word) && words[at + 1]) dirs.push(words[at + 1] ?? "");
  });
  const isDori = (word: string): boolean =>
    DORI_NAMES[basename(word)] === true ||
    SKILL_SOURCE.test(word) ||
    (word.endsWith("cli.ts") && !word.startsWith("/") && dirs.some((dir) => SKILL_SOURCE.test(join(dir, word))));
  const own = new Set<number>();

  // A dori program's command and its platform, past options and their values.
  const doriWords = (program: number, to: number): void => {
    own.add(program);
    let name: string | undefined;
    for (let at = program + 1; at < to; at++) {
      const word = words[at] ?? "";
      const known = (next: string) => (name === undefined ? DORI_COMMANDS[next] : PLATFORMS[next]) === true;
      if (word === "") continue;
      if (word.startsWith("-")) {
        const next = words[at + 1] ?? "";
        if (word.startsWith("--") && !word.includes("=") && next && !next.startsWith("-") && !known(next)) at++;
        continue;
      }
      if (!known(word)) return;
      own.add(at);
      if (name !== undefined || MESSENGER_COMMANDS[word] !== true) return;
      name = word;
    }
  };

  // One command, from its first word up to the next command.
  const segment = (from: number, to: number): void => {
    let at = from;
    for (; at < to; at++) {
      const word = words[at] ?? "";
      if (word === "") continue;
      if (ASSIGNMENT.test(word)) {
        // `FOO="a b"` was split at its space: its value goes on to the word that closes the quote.
        const quote = shell ? ['"', "'"].find((q) => (text[at] ?? "").split(q).length % 2 === 0) : undefined;
        while (quote !== undefined && at + 1 < to && !(text[at + 1] ?? "").includes(quote)) at++;
        if (quote !== undefined) at++;
        continue;
      }
      if (PREFIXES[word] !== true) break;
      own.add(at);
      // exec's own options: `-a NAME` names the process, `-c` and `-l` are flags.
      while (words[at + 1]?.startsWith("-")) at += words[at + 1] === "-a" ? 2 : 1;
    }
    if (at >= to) return;
    own.add(at);
    const name = basename(words[at] ?? "");
    let program: number | undefined;
    if (isDori(words[at] ?? "")) program = at;
    else if (name === "bun") {
      const script = words[at + 1] === "run" ? at + 2 : at + 1;
      if (isDori(words[script] ?? "")) {
        for (let i = at; i < script; i++) own.add(i);
        program = script;
      }
    } else if (LAUNCHERS[name] === true) {
      for (let i = at + 1; i < to && program === undefined; i++) if (isDori(words[i] ?? "")) program = i;
    } else if (shell && SHELLS[name] === true) {
      const script = words.findIndex((word, i) => i > at && i < to && SCRIPT_OPTION.test(word));
      if (script >= 0) segment(script + 1, to);
    }
    if (program !== undefined) doriWords(program, to);
  };

  let from = 0;
  for (let at = 1; at <= words.length; at++) {
    const before = text[at - 1] ?? "";
    const starts =
      at === words.length ||
      (shell &&
        (SEPARATORS[before] === true ||
          before.endsWith(";") ||
          KEYWORDS.has(words[at - 1] ?? "") ||
          OPENS.test(text[at] ?? "")));
    if (!starts) continue;
    segment(from, at);
    from = at;
  }
  return shell
    ? text.map((word) => word.replace(/^['"]+|['"]+$/g, "")).filter((word, at) => word && !own.has(at))
    : raw.filter((_, at) => !own.has(at));
};
