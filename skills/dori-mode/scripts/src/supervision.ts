import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import type { Registry } from "./registry.ts";
import { Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";
import { type ActivitySample, laneActivity } from "./supervision-activity.ts";
import { IncompleteGitObservation } from "./supervision-git.ts";
import {
  isHungTimer,
  type Observation,
  observeBudget,
  parseUsage,
  readObservation,
  resampleActivity,
  retainObservationAlerts,
  saveObservation,
  type SupervisedLane,
  type SupervisionOptions,
  type Usage,
  type UsageSnapshot,
  withCurrentSupervision,
  withSupervisionWriter,
  workingTimer,
} from "./supervision-observe.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
} & (
  | { readonly registry: Registry; readonly clock: Clock }
  | { readonly registry?: undefined; readonly clock: Pick<Clock, "now"> }
);
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
  readonly observationError?: string;
  readonly observationIncomplete?: true;
  readonly busy?: true;
};
const NOT_OBSERVED: SupervisionResult = { enabled: false, state: null, alerts: [], usage: null, hung: false };
const BUSY: SupervisionResult = { ...NOT_OBSERVED, busy: true };

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  constructor(
    readonly deps: SupervisionDeps,
    readonly options: SupervisionOptions = {},
  ) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  private async usage(lane: SupervisedLane, now: number): Promise<UsageSnapshot> {
    let usage: Usage = { tokens: null, costUsd: null };
    if (this.options.usageArgv?.length) {
      const result = await this.deps.run(
        fill(this.options.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code === 0) usage = parseUsage(result.out);
    }
    return { key: lane.key, openedAt: lane.openedAt, at: new Date(now).toISOString(), ...usage };
  }

  private costPath(key: string): string {
    return join(dirname(this.reports.path(key)), "cost.jsonl");
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  async sweep(lane: SupervisedLane, screen: string): Promise<SupervisionResult> {
    if (!this.enabled(lane)) return NOT_OBSERVED;
    const now = this.deps.clock.now();
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const observe = () => this.observe(lane, screen, now, path);
    return (await withSupervisionWriter(this.deps.stateDir, lane, now, observe)) ?? BUSY;
  }
  private async observe(lane: SupervisedLane, screen: string, now: number, path: string): Promise<SupervisionResult> {
    const probe = await laneActivity(this.deps, this.options, lane).catch((error: unknown) => {
      if (error instanceof IncompleteGitObservation) return error;
      throw error;
    });
    const incomplete = probe instanceof IncompleteGitObservation;
    const usage = await this.usage(lane, now);
    const apply = () => this.applySweep(lane, screen, now, usage, incomplete ? null : probe, path);
    const applied = await withCurrentSupervision(this.deps, lane, apply);
    if (!applied) return NOT_OBSERVED;
    const { result, refresh, deliveryError } = applied;
    if (incomplete) {
      return {
        ...result,
        observationIncomplete: true,
        observationError: deliveryError ? `${deliveryError}; ${probe.message}` : probe.message,
      };
    }
    const observationError = refresh && (await resampleActivity(this.deps, this.options, lane, refresh));
    if (deliveryError) throw new Error(observationError ? `${deliveryError}; ${observationError}` : deliveryError);
    return observationError === undefined ? result : { ...result, observationError };
  }

  private async applySweep(
    lane: SupervisedLane,
    screen: string,
    now: number,
    usage: UsageSnapshot,
    sample: ActivitySample | null,
    path: string,
  ) {
    const scope = { generation: lane.lifecycleEpoch };
    const tag = scope.generation === undefined ? {} : { generation: scope.generation };
    const saved = readObservation(path);
    const previous = saved?.openedAt === lane.openedAt && saved.generation === scope.generation ? saved : null;
    const progress = this.reports.read(lane.key, scope);
    // Without a usage hook each sweep would append the same unknown reading; close still records its final one.
    if (this.options.usageArgv?.length) this.record(usage);
    const checkpoint = sample ? (this.checkpoints.read(lane.key).at(-1) ?? null) : null;
    const activity = sample?.signature(progress, checkpoint) ?? null;
    const timer = sample && workingTimer(screen);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const { violations, unavailable } = observeBudget(this.options, lane, now, usage);
    const hung = isHungTimer(this.options, previous, timer, now, activeAt);
    const terminal = progress?.state === "done" || progress?.state === "halted";
    const hungMessage = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
    const keepHungAlert = !sample && previous?.alerts.includes(hungMessage);
    const alerts = terminal
      ? []
      : [...(violations.length ? violations : hung || keepHungAlert ? [hungMessage] : []), ...unavailable];
    const freshAlerts = alerts.filter((message) => !previous?.alerts.includes(message));
    // A question also reads as blocked; only this same ceiling blocker as the latest report makes a new one a repeat.
    const blocker = violations.join("; ");
    const reported = progress?.lastReport?.kind === "blocker" && progress.lastReport.text === blocker;
    let appended = true;
    if (!terminal && violations.length && !reported) {
      this.reports.report(lane.key, "blocker", blocker, now, scope.generation);
    } else if (!terminal && hung && (!progress || progress.state === "running")) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        ...tag,
        at: new Date(now).toISOString(),
        state: "stalled",
        text: hungMessage,
      });
    } else if (sample && !alerts.length && progress?.state === "stalled" && activity !== previous?.activity) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        ...tag,
        at: new Date(now).toISOString(),
        state: "running",
        text: "Fresh report, checkpoint, or file activity observed",
      });
    } else appended = false;
    // Deliver before saving, so only alerts that reached the callback count as sent; a failed one is sent again next sweep.
    const undelivered = new Map<string, string>();
    for (const message of freshAlerts) {
      try {
        await this.deps.alert?.(lane, message);
      } catch (error) {
        undelivered.set(message, error instanceof Error ? error.message : String(error));
      }
    }
    const changed = appended || this.options.usageArgv?.length || (freshAlerts.length && this.deps.alert);
    const latest = changed ? this.reports.read(lane.key, scope) : progress;
    // Commit the decision before resampling so an advisory probe cannot undo a stall or alert receipt.
    const observation: Observation = {
      openedAt: lane.openedAt,
      ...tag,
      at: now,
      timer: timer?.seconds ?? null,
      timerKind: timer?.kind ?? null,
      activity: sample && changed ? sample.signature(latest, checkpoint) : activity,
      activeAt,
      alerts: alerts.filter((message) => !undelivered.has(message)),
    };
    if (sample) saveObservation(path, observation);
    else retainObservationAlerts(path, previous, observation);
    return {
      result: { enabled: true, state: latest?.state ?? "running", alerts: freshAlerts, usage, hung },
      refresh: sample && changed ? { path, observation, progress: latest, checkpoint, before: sample } : undefined,
      deliveryError: undelivered.size
        ? `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`
        : undefined,
    };
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    if (!this.enabled(lane)) return null;
    // Record each openedAt generation once; retries reuse the final reading and stable {closeKey}.
    const path = this.costPath(lane.key);
    const recorded = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as UsageSnapshot)
          .findLast(
            (entry) =>
              entry.final === true &&
              (entry.openedAt === lane.openedAt ||
                (entry.openedAt === undefined && Date.parse(entry.at) >= Date.parse(lane.openedAt))),
          )
      : undefined;
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now());
    if (this.options.recordCostArgv?.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(
        fill(this.options.recordCostArgv, {
          key: lane.key,
          session: lane.session ?? "",
          tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
          costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd),
          at: snapshot.at,
          closeKey: `${lane.key}@${lane.openedAt}`,
        }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}
