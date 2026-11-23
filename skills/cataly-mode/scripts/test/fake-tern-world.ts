import type { SessionRef } from "../../../../src/runtime/types.ts";
import { block, FakeTern, OMP } from "../../../../test/fake-tern.ts";

import type { CatalyConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { type PaneState, writePaneState } from "../src/lane-state.ts";
import type { Clock } from "../src/run.ts";

import { depsFor, type World } from "./fakes.ts";

/** The native session `laneState` records unless a test patches it. */
export const TERN_SESSION = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";

export const ternRef = (id: string): SessionRef => ({ runtime: "tern", id });

/** The world's Tern, made on first use; the world's runner answers every `tern` call from it. */
export const ternOf = (w: World): FakeTern => (w.tern ??= new FakeTern());

/**
 * A live OMP agent in Tern block `id` (a decimal block id): a login shell (`pid - 1`) is the block's child and OMP
 * (`pid`) its foreground, as `tern process` and `ps` report them. `working` is Tern's busy flag, `body` the rows above
 * OMP's empty input.
 */
export const agentIn = (
  w: World,
  id: string,
  opts: { readonly pid?: number; readonly cwd?: string; readonly working?: boolean; readonly body?: string } = {},
): SessionRef => {
  const pid = opts.pid ?? 4242;
  const shell = { pid: pid - 1, name: "zsh", argv: ["/bin/zsh", "-l"] };
  ternOf(w).blocks.set(
    id,
    block({
      cwd: opts.cwd ?? "/repo",
      child: shell,
      group: pid,
      foreground: { ...OMP, pid },
      working: opts.working ?? false,
      ...(opts.body === undefined ? {} : { body: opts.body }),
    }),
  );
  w.procs = [
    ...(w.procs ?? []).filter((p) => p.pid !== pid && p.pid !== shell.pid),
    { pid: shell.pid, ppid: 1, cmd: "zsh" },
    { pid, ppid: shell.pid, cmd: "bun /opt/bin/omp --cataly-role lane" },
  ];
  return ternRef(id);
};

/** The exact per-block record the OMP extension writes under `TERN_PANE`. */
export const laneState = (stateDir: string, paneId: string, patch: Partial<PaneState> = {}): void =>
  writePaneState(stateDir, {
    paneId,
    role: "lane",
    sessionId: TERN_SESSION,
    cwd: "/repo",
    pid: 4242,
    startedAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
    goal: { status: "active", objective: "ship it" },
    approvalPending: false,
    ...patch,
  });

/**
 * Flow deps whose new sessions open in Tern. Runtimes are built from the deps' own runner as in production, so a test
 * that wraps `run` sees every `tern` and `ps` call the runtime makes.
 */
export const ternDeps = (w: World, clock: Clock, stateDir: string, patch: Partial<CatalyConfig> = {}): FlowDeps => {
  ternOf(w);
  const { rts: _headless, ...deps } = depsFor(w, clock, stateDir, {
    runtime: "tern",
    sessionRuntime: "tern",
    ...patch,
  });
  return deps;
};

/** Texts pasted into Tern blocks, in delivery order. */
export const ternSent = (w: World): string[] => (w.tern?.pasted ?? []).map((p) => p.text);
