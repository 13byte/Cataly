import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { takeLock } from "./checkpoint-lock.ts";
import type { Checkpoint } from "./checkpoints.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type Lane, sameLaneGeneration } from "./registry.ts";
import type { Progress } from "./reports.ts";
import { type ActivitySample, laneActivity, writerDir } from "./supervision-activity.ts";
import type { SupervisionDeps } from "./supervision.ts";

export type BudgetLimits = {
  readonly wallMinutes?: number | null | undefined;
  readonly tokens?: number | null | undefined;
  readonly costUsd?: number | null | undefined;
};
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
export type UsageSnapshot = Usage & {
  readonly key: string;
  readonly at: string;
  readonly openedAt?: string;
  readonly final?: true;
};
export type SupervisedLane = Lane & { readonly activityPaths?: readonly string[]; readonly budget?: BudgetLimits };
export type SupervisionOptions = {
  readonly hungAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  readonly defaults?: BudgetLimits;
  readonly lanes?: Readonly<Record<string, BudgetLimits>>;
  readonly usageArgv?: readonly string[];
  readonly recordCostArgv?: readonly string[];
  readonly activityPaths?: readonly string[];
  readonly gitActivity?: boolean;
};

export type Observation = {
  readonly openedAt: string;
  readonly generation?: string;
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string | null;
  readonly activeAt: number;
  readonly alerts: readonly string[];
};

type Resample = {
  readonly path: string;
  readonly observation: Observation;
  readonly progress: Progress | null;
  readonly checkpoint: Checkpoint | null;
  readonly before: ActivitySample;
};

export const readObservation = (path: string): Observation | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Observation) : null;

export const saveObservation = (path: string, observation: Observation): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
  renameSync(temporary, path);
};

// A failed initial activity sample can still settle budget alerts without advancing the last verified baseline.
export const retainObservationAlerts = (path: string, previous: Observation | null, current: Observation): void => {
  const { alerts } = current;
  if (alerts.length === (previous?.alerts.length ?? 0) && alerts.every((alert, i) => alert === previous?.alerts[i])) {
    return;
  }
  saveObservation(path, previous ? { ...previous, alerts } : current);
};

/** Serialize the provisional and final baselines without blocking lane delivery or pause. */
export const withSupervisionWriter = async <T>(
  stateDir: string,
  lane: SupervisedLane,
  now: number,
  action: () => Promise<T>,
): Promise<T | undefined> => {
  const directory = writerDir(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A reopened generation can proceed while the old sweep winds down. Its writes still use the delivery lock.
  const identity = createHash("sha256")
    .update(JSON.stringify([lane.openedAt, lane.lifecycleEpoch]))
    .digest("hex");
  const fail = (message: string) => new Error(`supervision writer lock ${message}`);
  const release = takeLock(resolve(directory, `${lane.key}.${identity}.lock`), now, fail, { keepLiveOwner: true });
  if (typeof release === "string") return;
  try {
    return await action();
  } finally {
    release();
  }
};

export const withCurrentSupervision = async <T>(
  deps: SupervisionDeps,
  lane: SupervisedLane,
  action: () => T | Promise<T>,
): Promise<T | undefined> => {
  if (deps.registry === undefined) return action();
  const held = await withDeliveryLock(deps, lane.key, async () => {
    const current = await deps.registry.read(lane.key);
    if (!current || current.nativeCloseIntent || !sameLaneGeneration(lane, current)) return;
    return action();
  });
  return held.ok ? held.value : undefined;
};

/** Refresh only the observation written by the current serialized sweep, and only if its lane is still current. */
export const resampleActivity = async (
  deps: SupervisionDeps,
  options: SupervisionOptions,
  lane: SupervisedLane,
  refresh: Resample,
): Promise<string | undefined> => {
  try {
    const sample = await laneActivity(deps, options, lane, refresh.before);
    await withCurrentSupervision(deps, lane, () => {
      const activity = sample.signature(refresh.progress, refresh.checkpoint);
      saveObservation(refresh.path, { ...refresh.observation, activity });
    });
  } catch (error) {
    return `post-effect activity sample failed: ${error instanceof Error ? error.message : String(error)}`;
  }
};

type WorkingTimer = { kind: string; seconds: number; step: number };

// Match only an explicit duration on a visible Working/Running line. step is the smallest unit shown, in seconds:
// "25m" is rounded to the minute, so two readings can place the same call's start up to a minute apart.
export const workingTimer = (screen: string): WorkingTimer | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds =
        clock[3] === undefined
          ? Number(clock[1]) * 60 + Number(clock[2])
          : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds, step: 1 };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    const unit = (name = ""): number => (/^h/i.test(name) ? 3600 : /^m/i.test(name) ? 60 : 1);
    if (parts.length)
      return {
        kind,
        seconds: parts.reduce((sum, match) => sum + Number(match[1]) * unit(match[2]), 0),
        step: Math.min(...parts.map((match) => unit(match[2]))),
      };
  }
  return null;
};

export const isHungTimer = (
  options: SupervisionOptions,
  previous: Observation | null,
  timer: WorkingTimer | null,
  now: number,
  activeAt: number,
): boolean =>
  previous !== null &&
  timer !== null &&
  previous.timer !== null &&
  timer.kind === previous.timerKind &&
  timer.seconds > previous.timer &&
  // The rounded timer origin distinguishes a continuing call from a new Working/Running call.
  Math.abs(now - timer.seconds * 1000 - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
  timer.seconds >= (options.hungAfterMinutes ?? 20) * 60 &&
  now - activeAt >= (options.staleAfterMinutes ?? 20) * 60_000;

export const parseUsage = (output: string): Usage => {
  try {
    const value: unknown = JSON.parse(output);
    const metric = (name: keyof Usage): number | null => {
      const n =
        typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : null;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    };
    return { tokens: metric("tokens"), costUsd: metric("costUsd") };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Malformed external JSON remains unknown, never zero.
    return { tokens: null, costUsd: null };
  }
};

export const observeBudget = (options: SupervisionOptions, lane: SupervisedLane, now: number, usage: Usage) => {
  const limits = {
    wallMinutes: null,
    tokens: null,
    costUsd: null,
    ...options.defaults,
    ...options.lanes?.[lane.key],
    ...lane.budget,
  };
  const violations: string[] = [];
  const exceeds = (name: keyof BudgetLimits, actual: number | null): void => {
    const ceiling = limits[name];
    if (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 && actual !== null && actual >= ceiling)
      violations.push(`${name} ceiling reached (${ceiling})`);
  };
  exceeds("wallMinutes", (now - Date.parse(lane.openedAt)) / 60_000);
  exceeds("tokens", usage.tokens);
  exceeds("costUsd", usage.costUsd);
  const unavailable = (["tokens", "costUsd"] as const)
    .filter((name) => typeof limits[name] === "number" && usage[name] === null)
    .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
  return { violations, unavailable };
};
