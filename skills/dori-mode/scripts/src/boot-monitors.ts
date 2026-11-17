import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { formatRef } from "../../../../src/runtime/types.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import type { ProgressState } from "./reports.ts";

export type Monitor = {
  /** OMP's desired monitor spec; argv stays structured so a quoted argument is never split into lane keys. */
  readonly name?: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly filter?: string;
  readonly monitorId?: string;
  readonly sessionId?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  /** Epoch ms after which the runtime ends the watch on its own. */
  readonly expiresAt?: number;
  readonly deliveryPaused?: boolean;
  readonly description?: string;
  readonly command?: string;
  readonly path?: string;
  readonly target?: string;
};
export type Manifest = {
  readonly path: string;
  readonly kind?: "omp";
  readonly data: { readonly version: number; readonly sessionId: string; readonly monitors: readonly Monitor[] };
};
export type BootLane = Lane & { readonly reportState?: ProgressState | undefined };
export type Cleanup = {
  readonly monitorId: string;
  readonly sessionId: string;
  readonly metadata: string;
  readonly lanes: readonly string[];
  readonly match: readonly string[];
  readonly suspended: boolean;
  readonly deliveryPaused: boolean;
  readonly expiresAt?: number;
  readonly stop: string;
};
// The one definition of a finished lane, shared by the VANISHED filter and the cleanup check.
export const finished = (lane: BootLane): boolean =>
  ["closed", "verified-done"].includes(statusOf(lane)) || lane.reportState === "done";

// Loose: any mention of a name, prose and paths included. Used only to keep a watch that might belong to an open lane.
// A colon or a period next to the name is punctuation ("lane:api-release", "api-release.") unless the period joins
// another name ("api.v2" is not "v2").
const mentions = (text: string, value: string | undefined): boolean => {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_-])(?<![a-zA-Z0-9_-]\\.)${escaped}(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`).test(
    text,
  );
};

// Strict: the evidence that ties a watch to a lane is the lane's pane id or its key as a whole argv token of the
// command or target. A description is prose and a path segment is not the lane ("build/docs/out.log" is not "docs").
const TIED_FIELDS = ["command", "target"] as const;
const tokens = (value: unknown): string[] =>
  typeof value === "string"
    ? value
        .split(/\s+/)
        .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
        .filter(Boolean)
    : [];
// A command's own words say what it runs, never which lane: the program, and for dori its command and, for a messenger
// command, the platform. `dori inbound slack` is not lane "dori", "inbound" or "slack".
// The dori program may run behind a wrapper (`bash -c "... exec dori inbound discord"`) or from source
// (`bun .../scripts/src/cli.ts inbound slack`), so it is found wherever a command starts: first, or after a shell
// separator, a launcher word or an environment assignment. The same name in an argument position is an argument
// (`dori checkpoints dori`, `rg -n /src/omp-dori api-fix`) and may name the lane. A legacy record's argv may hold
// non-strings; they are never a program.
const DORI_PROGRAMS: Record<string, true> = { dori: true, "omp-dori": true };
const DORI_SOURCE = /(?:^|\/)scripts\/src\/cli\.ts$/;
const LAUNCHERS: Record<string, true> = {
  "&&": true,
  "||": true,
  ";": true,
  "|": true,
  exec: true,
  nohup: true,
  env: true,
  command: true,
  "-c": true,
  "-lc": true,
};
const PLATFORM_COMMANDS: Record<string, true> = {
  send: true,
  presence: true,
  inbound: true,
  thread: true,
  react: true,
};
const startsCommand = (argv: readonly unknown[], at: number): boolean => {
  if (at === 0) return true;
  const before = argv[at - 1];
  return (
    typeof before === "string" &&
    (LAUNCHERS[before] === true || before.endsWith(";") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(before))
  );
};
const doriAt = (argv: readonly unknown[], at: number): boolean => {
  const word = argv[at];
  if (typeof word !== "string") return false;
  if (DORI_PROGRAMS[basename(word)] === true) return startsCommand(argv, at);
  const before = argv[at - 1];
  return (
    DORI_SOURCE.test(word) && typeof before === "string" && basename(before) === "bun" && startsCommand(argv, at - 1)
  );
};
const argumentWords = (argv: readonly unknown[]): readonly unknown[] => {
  const own = new Set([0]);
  argv.forEach((_, at) => {
    if (!doriAt(argv, at)) return;
    own.add(at).add(at + 1);
    const command = argv[at + 1];
    if (typeof command === "string" && PLATFORM_COMMANDS[command] === true) own.add(at + 2);
  });
  return argv.filter((_, at) => !own.has(at));
};
const tiedBy = (monitor: Monitor, lane: Lane): string | null => {
  const ref = sessionOf(lane);
  const panes = [lane.pane, ref?.id, ref ? formatRef(ref) : undefined].filter((id): id is string => !!id);
  if (Array.isArray(monitor.argv)) {
    if (panes.some((id) => monitor.argv?.includes(id))) return `${lane.key}:argv:pane`;
    if (argumentWords(monitor.argv).includes(lane.key)) return `${lane.key}:argv:key`;
  }
  for (const field of TIED_FIELDS) {
    const words = tokens(monitor[field]);
    if (panes.some((id) => words.includes(id))) return `${lane.key}:${field}:pane`;
    if ((field === "command" ? argumentWords(words) : words).includes(lane.key)) return `${lane.key}:${field}:key`;
  }
  return null;
};

export const monitorCleanup = (lanes: readonly BootLane[], manifests: readonly Manifest[]): Cleanup[] => {
  const cleanup: Cleanup[] = [];
  for (const { path, data, kind } of manifests) {
    for (const monitor of data.monitors) {
      if (kind === "omp" ? !monitor.name : !monitor.persistent || !/^mon_[A-Za-z0-9]+$/.test(monitor.monitorId ?? ""))
        continue;
      if (kind !== "omp" && monitor.sessionId !== data.sessionId) continue;
      const tied = lanes.flatMap((lane) => {
        const match = tiedBy(monitor, lane);
        return match ? [{ lane, match }] : [];
      });
      if (!tied.length || tied.some(({ lane }) => !finished(lane))) continue;
      // Any mention of an open lane anywhere in the watch keeps it.
      const text = [
        monitor.name,
        ...(Array.isArray(monitor.argv) ? monitor.argv : []),
        monitor.cwd,
        monitor.filter,
        monitor.description,
        monitor.command,
        monitor.path,
        monitor.target,
      ]
        .filter((v) => typeof v === "string")
        .join("\n");
      if (lanes.some((lane) => !finished(lane) && (mentions(text, lane.key) || mentions(text, lane.pane)))) continue;
      const monitorId = kind === "omp" ? (monitor.name ?? "") : (monitor.monitorId ?? "");
      cleanup.push({
        monitorId,
        sessionId: data.sessionId,
        metadata: path,
        lanes: tied.map(({ lane }) => lane.key),
        match: tied.map(({ match }) => match),
        suspended: Boolean(monitor.suspended),
        deliveryPaused: monitor.deliveryPaused === true,
        ...(typeof monitor.expiresAt === "number" ? { expiresAt: monitor.expiresAt } : {}),
        stop:
          kind === "omp"
            ? `monitor(${JSON.stringify({ op: "stop", name: monitorId })})`
            : `kill_bash(${JSON.stringify({ bash_id: monitorId })})`,
      });
    }
  }
  return cleanup;
};

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
};

// One unreadable file is named in errors and skipped; the other sessions' metadata is still read.
export const readMonitorManifests = (
  sessionsDir: string,
  extraDirs: readonly string[] = [],
  ompDir?: string,
): { manifests: Manifest[]; errors: string[] } => {
  const dirs = new Set(extraDirs);
  if (ompDir !== undefined) dirs.add(ompDir);
  const manifests: Manifest[] = [];
  const errors: string[] = [];
  try {
    for (const entry of entries(sessionsDir))
      if (entry.isDirectory()) dirs.add(join(sessionsDir, entry.name, "extensions", "terminal"));
  } catch {
    errors.push(sessionsDir);
  }
  for (const dir of [...dirs].sort()) {
    let files: ReturnType<typeof entries>;
    try {
      files = entries(dir);
    } catch {
      errors.push(dir);
      continue;
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name);
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Manifest["data"];
        if (data.version !== 1 || !Array.isArray(data.monitors) || typeof data.sessionId !== "string")
          throw new Error("invalid monitor metadata");
        // A null or non-object entry makes the whole file unreadable here, never a crash in the cleanup pass.
        if (!data.monitors.every((m: unknown) => typeof m === "object" && m !== null && !Array.isArray(m)))
          throw new Error("invalid monitor entry");
        const omp = dir === ompDir;
        if (
          omp &&
          !data.monitors.every(
            (monitor) =>
              typeof monitor.name === "string" &&
              monitor.name.length > 0 &&
              Array.isArray(monitor.argv) &&
              monitor.argv.length > 0 &&
              monitor.argv.every((arg: unknown) => typeof arg === "string") &&
              typeof monitor.cwd === "string" &&
              (monitor.filter === undefined || typeof monitor.filter === "string"),
          )
        )
          throw new Error("invalid OMP monitor spec");
        manifests.push({ path, data, ...(omp ? { kind: "omp" as const } : {}) });
      } catch {
        errors.push(path);
      }
    }
  }
  return { manifests, errors };
};
