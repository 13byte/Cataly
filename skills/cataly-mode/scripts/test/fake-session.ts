import type { HeadlessObservation } from "../../../../src/runtime/headless.ts";
import type { AgentStatus, CreateSpec, DeliverOutcome, SessionRef } from "../../../../src/runtime/types.ts";
import type { FakeTern } from "../../../../test/fake-tern.ts";

/** The n-th fake headless session id: a valid UUID, so `headless:<id>` parses like a real native lane. */
export const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A headless ref, the form every test world addresses sessions by. */
export const href = (id: string): SessionRef => ({ runtime: "headless", id });

/** One native session as the fake supervisor reports it. Absent fields are absent from its observation too. */
export type FakeSession = {
  status: AgentStatus;
  role?: "lane" | "cataly";
  harnessRole?: HeadlessObservation["harnessRole"];
  sessionId?: string;
  sessionFile?: string;
  pid?: number;
  cwd?: string;
  goal?: HeadlessObservation["goal"];
  held?: boolean;
  dialogs?: HeadlessObservation["dialogs"];
  /** Recent assistant output, newest last: what `read` returns. */
  recent?: readonly string[];
  activeSince?: number;
  model?: string;
  /** argv of each native start, joined by spaces. */
  ran?: string[];
  env?: Readonly<Record<string, string | undefined>>;
};

export type World = {
  prState: string;
  issueState: string;
  aheadCount: string | Record<string, string>;
  dirty: string | Record<string, string>;
  /** `git worktree list --porcelain` output; defaults to a cwd plus one lane-owned worktree. */
  worktreeList?: string;
  /** `git rev-parse --is-inside-work-tree` answer; a lane whose cwd is not a checkout gets "false". */
  isGitRepo?: string;
  /** Native sessions by headless id. */
  sessions: Record<string, FakeSession>;
  /** Status a session moves to once it accepts text (models a lane picking up the message). */
  onDeliverStatus?: AgentStatus;
  /** Called with each accepted text; it may change the world, as the agent reacting to it would. */
  onDeliver?: (id: string, text: string) => void;
  /** Answers a delivery in place of the session, e.g. an ambiguous submission. */
  deliverOutcome?: (id: string, text: string) => DeliverOutcome | undefined;
  /** Runs before each reservation; a throw is the supervisor refusing it, a promise holds it. */
  onCreate?: (spec: CreateSpec) => void | Promise<void>;
  /** Throws from `startNative`: the native agent failing to start. */
  onStart?: (id: string) => void;
  procs?: { pid: number; ppid: number; cmd: string }[];
  procStartTicks?: Record<number, string>;
  bootId?: string;
  /** Tern blocks, for lanes and leads on the Tern runtime: the runner answers every `tern` call from it. */
  tern?: FakeTern;
  /** Last session number handed out by `create`. */
  next: number;
  /** Runner argv, and every fake runtime operation as `["headless", op, id, ...]`. */
  calls: string[][];
};
