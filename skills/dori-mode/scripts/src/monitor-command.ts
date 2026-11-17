import { basename } from "node:path";

// Which words of a watch's own command may name a lane, read by vocabulary, never by shell syntax. Wherever a dori
// program word stands (`dori`, `omp-dori`, any `cli.ts` entry), it, its dori command and, after a messenger command,
// the platform are dori's own words, whatever wraps them (`env -C DIR`, `timeout -vk 5 60`, `while ...; do ...; done`).
// The first other word after the program and every word elsewhere may name a lane, as before: `dori checkpoints dori`,
// `rg -c dori api-fix`, `bun /repo/src/cli.ts send api-fix`. The command's first word is its program, never a lane
// (`tail -F` is not lane `tail`). A legacy record's non-string argv word is never a program.
const PROGRAMS: Record<string, true> = { dori: true, "omp-dori": true, "cli.ts": true };
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

/**
 * The words of a watch's argv (exact) or command string (split at whitespace, quotes trimmed) that may name a lane:
 * every word except its own command words. Anything else gives no words.
 */
export const laneWords = (command: unknown): readonly unknown[] => {
  const shell = typeof command === "string";
  const raw: readonly unknown[] = shell ? command.split(/\s+/).filter(Boolean) : Array.isArray(command) ? command : [];
  const words = raw.map((word) => (typeof word !== "string" ? "" : shell ? word.replace(/^['"]+|['"]+$/g, "") : word));
  const own = new Set([0]);
  // The first word at or after `at` that is not an option.
  const operand = (at: number): number => {
    while (words[at]?.startsWith("-")) at++;
    return at;
  };
  for (let at = 0; at < words.length; at++) {
    if (PROGRAMS[basename(words[at] ?? "")] !== true) continue;
    own.add(at);
    at = operand(at + 1);
    const name = words[at] ?? "";
    if (DORI_COMMANDS[name] !== true) continue;
    own.add(at);
    // The command's first operand is read here, never again as a program: a platform, or an argument such as a lane.
    at = operand(at + 1);
    if (MESSENGER_COMMANDS[name] === true && PLATFORMS[words[at] ?? ""] === true) own.add(at);
  }
  return shell ? words.filter((word, at) => word && !own.has(at)) : raw.filter((_, at) => !own.has(at));
};
