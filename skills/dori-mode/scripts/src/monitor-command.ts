import { basename, join } from "node:path";
import { bunEntryAt, envCommandAt, LAUNCHERS, launcherCommandAt, shellWords, unquote } from "./monitor-syntax.ts";

// Which words of a watch's own command may name a lane. A command string is cut into commands at operators and line
// breaks outside quotes (monitor-syntax.ts) and at a shell's `-c` script. Each command's program is its first word
// after reserved words (`do`, `then`, `if`, `!`, ... only where the command starts), assignments, `exec`, `command`
// and `builtin`, and after a known launcher's own options and operands (`env -u NAME`, `timeout -vk 5 60`, `sudo -u
// USER`, `flock LOCK`; `flock LOCK -c CMD` runs CMD as a script): it is never a lane (`env tail -F` is not lane
// `tail`). A dori program is `dori`, `omp-dori` or the skill's `dori-mode/scripts/src/cli.ts`, also behind bun's options
// (`bun --cwd DIR src/cli.ts`); its dori command and, after a messenger command, the platform are its own words, past
// options and their values. Every other word may name a lane, as before: an argument (`dori checkpoints --cwd X
// dori`), a path (`ls /x/dori freshness`) or another program's word (`env rg -c dori freshness`). A legacy record's
// non-string argv word holds a program's place and is never dori.
// Known limits: a relative `cli.ts` is read against every `cd`, `-C` or `--chdir` directory in the command, not only
// the one it runs in (`git -C DIR ... && bun src/cli.ts`); an option value that is a platform word is taken for the
// platform (`dori send --text slack`); a `$(...)` inside double quotes and a `#` comment are not read as shell
// syntax; behind an `env` option this does not read (`-S`), the first dori word is taken for the program.
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
const SKILL_SOURCE = /(?:^|\/)dori-mode\/scripts\/src\/cli\.ts$/;
// A Set: a `then` key on an object literal reads as a thenable.
const RESERVED = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
const PREFIXES: Record<string, true> = { exec: true, command: true, builtin: true };
const SHELLS: Record<string, true> = { sh: true, bash: true, dash: true, zsh: true, ksh: true, fish: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word as passed on, the whitespace-split word it is in, and, in a command string, its own words as a script. */
type Word = {
  readonly word: string;
  readonly base: number;
  readonly starts?: boolean;
  readonly script?: () => readonly Word[];
};

/** Where a shell's `-c` script is, past its other options (`-O extglob`, `-o pipefail`); undefined without one. */
const scriptAt = (words: readonly string[], at: number): number | undefined => {
  let script = false;
  for (; at < words.length; at++) {
    const word = words[at] ?? "";
    if (/^[-+][oO]$/.test(word)) at++;
    else if (/^-[A-Za-z]+$/.test(word)) script ||= word.includes("c");
    else if (!/^\+[A-Za-z]+$/.test(word)) return script ? at : undefined;
  }
  return undefined;
};

/**
 * The words of a watch's argv (exact) or command string (split at whitespace, quotes trimmed) that may name a lane:
 * every word except its own command words. Anything else gives no words.
 */
export const laneWords = (command: unknown, cwd: unknown): readonly unknown[] => {
  const line = typeof command === "string" ? command : undefined;
  const raw: readonly unknown[] = line?.split(/\s+/).filter(Boolean) ?? (Array.isArray(command) ? command : []);
  // The whitespace-split word each character of the line is in.
  const baseOf: number[] = [];
  for (let at = 0, base = -1; at < (line?.length ?? 0); at++) {
    if (!/\s/.test(line?.[at] ?? "") && (at === 0 || /\s/.test(line?.[at - 1] ?? ""))) base++;
    baseOf.push(base);
  }
  // A string's words; `bases` maps each of its characters to the whitespace-split word of the line it came from.
  const read = (text: string, bases: readonly number[]): Word[] =>
    shellWords(text).map(({ text: word, from, starts }) => {
      const passed = unquote(word);
      const script = () =>
        read(
          passed.text,
          passed.at.map((i) => bases[from + i] ?? -1),
        );
      return { word: passed.text, base: bases[from] ?? -1, starts, script };
    });
  const all: readonly Word[] =
    line === undefined
      ? raw.map((word, base) => ({ word: typeof word === "string" ? word : "", base }))
      : read(line, baseOf);
  const dirs = typeof cwd === "string" ? [cwd] : [];
  all.forEach(({ word }, at) => {
    if (word.startsWith("--chdir=")) dirs.push(word.slice("--chdir=".length));
    else if (["cd", "-C", "--chdir"].includes(word) && all[at + 1]) dirs.push(all[at + 1]?.word ?? "");
  });
  const isDori = (word: string, chdir?: string): boolean => {
    if (DORI_NAMES[basename(word)] === true || SKILL_SOURCE.test(word)) return true;
    if (!word.endsWith("cli.ts") || word.startsWith("/")) return false;
    const from = chdir === undefined ? dirs : [chdir, ...dirs.map((dir) => join(dir, chdir))];
    return from.some((dir) => SKILL_SOURCE.test(join(dir, word)));
  };
  const own = new Set<number>();

  // A dori program's command and its platform, past options and their values.
  const doriWords = (ws: readonly Word[], program: number): void => {
    own.add(ws[program]?.base ?? -1);
    let name: string | undefined;
    for (let at = program + 1; at < ws.length; at++) {
      const word = ws[at]?.word ?? "";
      const known = (next: string) => (name === undefined ? DORI_COMMANDS[next] : PLATFORMS[next]) === true;
      if (word.startsWith("-")) {
        const next = ws[at + 1]?.word ?? "";
        if (word.startsWith("--") && !word.includes("=") && next && !next.startsWith("-") && !known(next)) at++;
        continue;
      }
      if (!known(word)) return;
      own.add(ws[at]?.base ?? -1);
      if (name !== undefined || MESSENGER_COMMANDS[word] !== true) return;
      name = word;
    }
  };

  // One command: its program, past reserved words, assignments, prefixes and launchers.
  const commandOf = (ws: readonly Word[]): void => {
    const words = ws.map((w) => w.word);
    const firstDori = (from: number): number | undefined => {
      const found = words.findIndex((word, at) => at >= from && isDori(word));
      return found < 0 ? undefined : found;
    };
    let at = 0;
    while (RESERVED.has(words[at] ?? "")) own.add(ws[at++]?.base ?? -1);
    while (ASSIGNMENT.test(words[at] ?? "")) at++;
    while (PREFIXES[words[at] ?? ""] === true) {
      own.add(ws[at++]?.base ?? -1);
      // exec's own options: `-a NAME` names the process, `-c` and `-l` are flags.
      while (words[at]?.startsWith("-")) at += words[at] === "-a" ? 2 : 1;
    }
    let program: number | undefined;
    for (let next: number | undefined = at; next !== undefined; ) {
      at = next;
      next = undefined;
      while (ASSIGNMENT.test(words[at] ?? "")) at++;
      if (at >= words.length) break;
      own.add(ws[at]?.base ?? -1);
      const name = basename(words[at] ?? "");
      const launcher = LAUNCHERS[name];
      if (isDori(words[at] ?? "")) program = at;
      else if (name === "env") {
        next = envCommandAt(words, at + 1);
        if (next === undefined) program = firstDori(at + 1);
      } else if (launcher !== undefined && Object.hasOwn(LAUNCHERS, name)) {
        next = launcherCommandAt(words, at + 1, launcher);
        // `flock LOCK -c CMD` runs CMD as a shell string.
        if (name === "flock" && next !== undefined && ["-c", "--command"].includes(words[next] ?? "")) {
          const script = ws[next + 1]?.script;
          if (script) run(script());
          next = undefined;
        }
      } else if (name === "bun") {
        const entry = bunEntryAt(words, at + 1);
        if (entry === undefined || !isDori(words[entry.at] ?? "", entry.cwd)) break;
        for (let i = at; i < entry.at; i++) own.add(ws[i]?.base ?? -1);
        program = entry.at;
      } else if (line !== undefined && SHELLS[name] === true) {
        const script = ws[scriptAt(words, at + 1) ?? -1]?.script;
        if (script) run(script());
      }
    }
    if (program !== undefined) doriWords(ws, program);
  };

  // Each command of a run of words, cut where a new command starts.
  const run = (ws: readonly Word[]): void => {
    let from = 0;
    for (let at = 1; at <= ws.length; at++) {
      if (at < ws.length && !ws[at]?.starts) continue;
      commandOf(ws.slice(from, at));
      from = at;
    }
  };
  run(all);
  return line === undefined
    ? raw.filter((_, at) => !own.has(at))
    : raw.map((word) => String(word).replace(/^['"]+|['"]+$/g, "")).filter((word, at) => word && !own.has(at));
};
