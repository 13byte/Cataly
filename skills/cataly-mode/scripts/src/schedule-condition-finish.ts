import { rmSync } from "node:fs";
import { conditionResult, stdoutDigest } from "./schedule-condition.ts";
import { scheduleOutput, type ScheduleStore } from "./schedule-store.ts";
import { ScheduleError, type ScheduledJob, type ScheduleRun } from "./schedule-types.ts";

/** Save the edge/digest and consumption receipt together before attempting any delivery. */
export async function finishCondition(
  store: ScheduleStore,
  job: ScheduledJob,
  completed: ScheduleRun,
  emit: (line: string) => unknown,
): Promise<boolean> {
  const output = scheduleOutput(store.stateDir, completed.id);
  const digest = await stdoutDigest(output);
  const decision = await store.update((document) => {
    const current = document.jobs.find((entry) => entry.id === job.id);
    if (!current || current.last?.id !== completed.id) throw new ScheduleError("condition claim changed");
    const result = conditionResult(current.condition!, current.watch!, completed, digest);
    current.watch = result.watch;
    current.nextAt = Math.max(completed.finishedAt!, current.nextAt) + current.condition!.everySeconds * 1000;
    current.last = { ...completed, conditionFired: result.fire, delivery: result.fire ? "pending" : "logged" };
    return result;
  });
  if (decision.warn)
    await emit(
      "SCHEDULE_ERROR " +
        JSON.stringify({ name: job.name, reason: "condition probe error", run: completed.id, retried: false }),
    );
  if (!decision.fire) {
    rmSync(output, { force: true });
    rmSync(output + ".stderr", { force: true });
  }
  return decision.fire;
}
