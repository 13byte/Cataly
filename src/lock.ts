import { constants } from "node:os";
import { alive } from "../skills/dori-mode/scripts/src/checkpoint-lock.ts";
import { checkName, type LockEnv, RETRY_MS, release, take } from "./lock-queue.ts";
import { Refusal } from "./refusal.ts";

type Signal = "SIGTERM" | "SIGINT";
/** A running command: its exit code (128 + the signal when a signal ended it) and a way to signal it. */
export type Child = { exited: Promise<number>; kill: (signal: Signal) => void };
export type RunEnv = LockEnv & {
  spawn: (cmd: readonly string[]) => Child;
  /** Calls `handler` on SIGTERM and SIGINT until the returned function is called. */
  onSignal: (handler: (signal: Signal) => void) => () => void;
};

export function lockEnv(root: string): RunEnv {
  return {
    root,
    pid: process.pid,
    now: Date.now,
    alive,
    sleep: () => Bun.sleep(RETRY_MS),
    spawn: (cmd) => {
      const p = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
      return { exited: p.exited, kill: (s) => p.kill(s) };
    },
    onSignal: (handler) => {
      const term = () => handler("SIGTERM");
      const int = () => handler("SIGINT");
      process.on("SIGTERM", term).on("SIGINT", int);
      return () => process.off("SIGTERM", term).off("SIGINT", int);
    },
  };
}

/**
 * Waits in line for the lock `name`, runs `cmd` while holding it and returns the command's exit code. A signal while
 * waiting withdraws the ticket and returns 128 + the signal without running anything; a signal while the command runs
 * is passed to it, and the lock is released once it exits.
 */
export async function runLocked(
  env: RunEnv,
  name: string,
  lane: string,
  priority: number,
  cmd: readonly string[],
  log: (line: string) => void,
): Promise<number> {
  checkName(name);
  if (cmd.length === 0) throw new Refusal("lock needs a command after --");
  const stop = new AbortController();
  let child: Child | undefined;
  let signal: Signal | undefined;
  const off = env.onSignal((s) => {
    signal ??= s;
    if (child) child.kill(s);
    else stop.abort();
  });
  try {
    const owner = await take(env, name, lane, priority, stop.signal, log);
    if (owner === undefined) return 128 + constants.signals[signal ?? "SIGTERM"];
    try {
      child = env.spawn(cmd);
      return await child.exited;
    } finally {
      release(env.root, name, owner);
    }
  } finally {
    off();
  }
}
