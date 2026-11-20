import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import type { DoriConfig } from "./config.ts";
import { runContext } from "./lane-run.ts";
import type { Registry } from "./registry.ts";
import { ReportError } from "./report-events.ts";
import { Reports, reportScope } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";
import { type ActivitySample, laneActivity } from "./supervision-activity.ts";
import { SupervisionCost } from "./supervision-cost.ts";
import { IncompleteGitObservation } from "./supervision-git.ts";
import {
  isHungTimer,
  type Observation,
  observeBudget,
  readObservation,
  resampleActivity,
  retainObservationAlerts,
  saveObservation,
  type SupervisedLane,
  type SupervisionOptions,
  type UsageSnapshot,
  withCurrentSupervision,
  withSupervisionWriter,
  workingTimer,
} from "./supervision-observe.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly config?: Pick<DoriConfig, "stateDir" | "sessionsDir" | "defaultCwd">;
  readonly run: Runner;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
} & (
  | { readonly registry: Registry; readonly clock: Clock }
  | { readonly registry?: undefined; readonly clock: Pick<Clock, "now"> }
);

type SupervisionAlert = { readonly kind: "blocked" | "stalled" | "warning"; readonly detail: string };

export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly alertEvents: readonly SupervisionAlert[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
  readonly observationError?: string;
  readonly observationIncomplete?: true;
  readonly busy?: true;
};
const NOT_OBSERVED: SupervisionResult = {
  enabled: false,
  state: null,
  alerts: [],
  alertEvents: [],
  usage: null,
  hung: false,
};
const BUSY: SupervisionResult = { ...NOT_OBSERVED, busy: true };

type SweepInput = {
  readonly screen: string | null;
  readonly nativeActiveSince: number | undefined;
  readonly now: number;
  readonly path: string;
};

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  private readonly cost: SupervisionCost;
  constructor(
    readonly deps: SupervisionDeps,
    readonly options: SupervisionOptions = {},
  ) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
    this.cost = new SupervisionCost({ ...deps, reports: this.reports }, options);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  // null means no trustworthy runtime sample: observe ceilings without replacing the activity baseline.
  async sweep(lane: SupervisedLane, screen: string | null, nativeActiveSince?: number): Promise<SupervisionResult> {
    if (!this.enabled(lane)) return NOT_OBSERVED;
    const now = this.deps.clock.now();
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const observe = () => this.observe(lane, { screen, nativeActiveSince, now, path });
    return (await withSupervisionWriter(this.deps.stateDir, lane, now, observe)) ?? BUSY;
  }
  private async observe(lane: SupervisedLane, observation: SweepInput): Promise<SupervisionResult> {
    const probe =
      observation.screen === null
        ? null
        : await laneActivity(this.deps, this.options, lane).catch((error: unknown) => {
            if (error instanceof IncompleteGitObservation) return error;
            throw error;
          });
    const sample = probe instanceof IncompleteGitObservation ? null : probe;
    const usage = await this.cost.usage(lane, observation.now);
    const apply = () => this.applySweep(lane, observation, { usage, sample });
    const applied = await withCurrentSupervision(this.deps, lane, apply);
    if (!applied) return NOT_OBSERVED;
    const { result, refresh, deliveryError } = applied;
    if (sample === null) {
      const observationError =
        probe instanceof IncompleteGitObservation
          ? deliveryError
            ? `${deliveryError}; ${probe.message}`
            : probe.message
          : deliveryError;
      return {
        ...result,
        observationIncomplete: true,
        ...(observationError === undefined ? {} : { observationError }),
      };
    }
    const observationError = refresh && (await resampleActivity(this.deps, this.options, lane, refresh));
    if (deliveryError) throw new Error(observationError ? `${deliveryError}; ${observationError}` : deliveryError);
    return observationError === undefined ? result : { ...result, observationError };
  }

  private async applySweep(
    lane: SupervisedLane,
    { screen, nativeActiveSince, now, path }: SweepInput,
    { usage, sample }: { readonly usage: UsageSnapshot; readonly sample: ActivitySample | null },
  ) {
    const scope = reportScope(lane);
    const context = runContext(this.reports, lane, lane.runId);
    if (!context || context.generation !== scope.generation)
      throw new ReportError(`supervision: execution identity unavailable for ${lane.key}`);
    const { generation, provenance } = context;
    const tag = { ...(generation === undefined ? {} : { generation }), ...(provenance ? { provenance } : {}) };
    const previous = readObservation(path, lane);
    const progress = this.reports.read(lane.key, scope);
    // Without a usage hook each sweep would append the same unknown reading; close still records its final one.
    const usageEnabled = this.options.usage === "omp" || Boolean(this.options.usageArgv?.length);
    if (usageEnabled) this.cost.record(usage);
    const checkpoint = sample ? this.checkpoints.latest(lane) : null;
    const activity = sample?.signature(progress, checkpoint) ?? null;
    const timer =
      sample &&
      (nativeActiveSince === undefined
        ? workingTimer(screen ?? "")
        : Number.isFinite(nativeActiveSince) && nativeActiveSince >= 0 && nativeActiveSince <= now
          ? { kind: "native working", seconds: Math.floor((now - nativeActiveSince) / 1_000), step: 1 }
          : null);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const { violations, unavailable } = observeBudget(this.options, lane, now, usage);
    const hung = isHungTimer(this.options, previous, timer, now, activeAt);
    const terminal = progress?.state === "done" || progress?.state === "halted";
    const hungMessage = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
    const keepHungAlert = !sample && previous?.alerts.includes(hungMessage);
    const alerts: SupervisionAlert[] = [];
    if (!terminal) {
      if (violations.length) {
        for (const detail of violations) alerts.push({ kind: "blocked", detail });
      }
      // An incomplete sample retains a prior stall receipt even when a new ceiling alert takes priority.
      if ((hung && !violations.length) || keepHungAlert) alerts.push({ kind: "stalled", detail: hungMessage });
      for (const detail of unavailable) alerts.push({ kind: "warning", detail });
    }
    const freshAlerts = alerts.filter(({ detail }) => !previous?.alerts.includes(detail));
    // A question also reads as blocked; only this same ceiling blocker as the latest report makes a new one a repeat.
    const blocker = violations.join("; ");
    const reported = progress?.lastReport?.kind === "blocker" && progress.lastReport.text === blocker;
    let appended = true;
    if (!terminal && violations.length && !reported) {
      this.reports.report(lane.key, "blocker", blocker, now, generation, undefined, provenance);
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
    for (const { detail: message } of freshAlerts) {
      try {
        await this.deps.alert?.(lane, message);
      } catch (error) {
        undelivered.set(message, error instanceof Error ? error.message : String(error));
      }
    }
    const changed = appended || usageEnabled || (freshAlerts.length && this.deps.alert);
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
      alerts: alerts.map(({ detail }) => detail).filter((message) => !undelivered.has(message)),
    };
    if (sample) saveObservation(path, observation);
    else retainObservationAlerts(path, previous, observation);
    return {
      result: {
        enabled: true,
        state: latest?.state ?? "running",
        alerts: freshAlerts.map(({ detail }) => detail),
        alertEvents: freshAlerts,
        usage,
        hung,
      },
      refresh: sample && changed ? { path, observation, progress: latest, checkpoint, before: sample } : undefined,
      deliveryError: undelivered.size
        ? `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`
        : undefined,
    };
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    return this.enabled(lane) ? this.cost.close(lane) : null;
  }
}
