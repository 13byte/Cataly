import { type HeadlessObservation, HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { HeadlessBeginOutcome } from "../../../../src/runtime/headless-launch-model.ts";
import type {
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  SessionInfo,
  SessionRef,
} from "../../../../src/runtime/types.ts";

import { href, sid, type World } from "./fake-session.ts";

/**
 * The native runtime of a test world: every session lives in `World.sessions`, nothing is spawned. It is a
 * HeadlessRuntime, so lane starts and native paths take their production branch.
 */
export class FakeHeadless extends HeadlessRuntime {
  constructor(
    private readonly w: World,
    stateDir: string,
  ) {
    super(stateDir, {});
  }

  override self(): SessionRef | undefined {
    return undefined;
  }

  override async create(spec: CreateSpec): Promise<SessionRef> {
    await this.w.onCreate?.(spec);
    const id = sid(++this.w.next);
    this.w.sessions[id] = { status: "idle", cwd: spec.cwd, role: spec.role === "lane" ? "lane" : "cataly" };
    this.w.calls.push(["headless", "create", id, spec.name]);
    return { runtime: "headless", id, ...(spec.group === undefined ? {} : { group: spec.group }) };
  }

  override async list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    this.w.calls.push(["headless", "list", filter?.group ?? ""]);
    return Object.entries(this.w.sessions).map(([id, s]) => ({
      ref: href(id),
      status: s.status,
      ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
    }));
  }

  override async observe(ref: SessionRef): Promise<HeadlessObservation> {
    const s = this.w.sessions[ref.id];
    const at = new Date(0).toISOString();
    if (!s) return { ref, cwd: "", startedAt: at, updatedAt: at, status: "gone", held: false, dialogs: [], recent: [] };
    return {
      ref,
      cwd: s.cwd ?? "/repo",
      startedAt: at,
      updatedAt: at,
      status: s.status,
      held: s.held ?? false,
      dialogs: s.dialogs ?? [],
      recent: (s.recent ?? []).map((text) => ({ kind: "assistant" as const, text })),
      ...(s.role === undefined ? {} : { role: s.role }),
      ...(s.harnessRole === undefined ? {} : { harnessRole: s.harnessRole }),
      ...(s.sessionId === undefined ? {} : { sessionId: s.sessionId }),
      ...(s.sessionFile === undefined ? {} : { sessionFile: s.sessionFile }),
      ...(s.pid === undefined ? {} : { pid: s.pid }),
      ...(s.goal === undefined ? {} : { goal: s.goal }),
      ...(s.model === undefined ? {} : { model: s.model }),
      ...(s.activeSince === undefined ? {} : { activeSince: s.activeSince }),
    };
  }

  override async startNative(
    ref: SessionRef,
    argv: readonly string[],
    overrides: Readonly<Record<string, string | undefined>>,
    resume?: { readonly file: string; readonly sessionId: string },
  ): Promise<HeadlessObservation> {
    const s = this.w.sessions[ref.id];
    if (!s) throw new Error(`no fake session ${ref.id}`);
    this.w.calls.push(["headless", "start", ref.id, ...argv]);
    this.w.onStart?.(ref.id);
    const n = Number.parseInt(ref.id.slice(-12), 10);
    s.ran = [...(s.ran ?? []), argv.join(" ")];
    s.env = overrides;
    s.sessionId = resume?.sessionId ?? `session-${n}`;
    s.sessionFile = resume?.file ?? `/sessions/session-${n}.jsonl`;
    s.pid = 4000 + n;
    s.role ??= "lane";
    s.goal ??= { status: "none" };
    s.held ??= false;
    return this.observe(ref);
  }

  override async begin(ref: SessionRef, expectedSessionId: string, objective: string): Promise<HeadlessBeginOutcome> {
    const s = this.w.sessions[ref.id];
    if (!s || s.sessionId !== expectedSessionId) throw new Error(`no fake session ${ref.id}`);
    this.w.calls.push(["headless", "begin", ref.id, objective]);
    s.goal = { status: "active", objective };
    return {
      ...(await this.observe(ref)),
      modelReadback: {
        requested: null,
        observed: null,
        status: "matched",
        billing: "unknown",
        checkedAt: new Date(0).toISOString(),
        source: "native-extension",
      },
    };
  }

  override async setGoal(
    ref: SessionRef,
    expectedSessionId: string,
    target: "paused" | "active",
  ): Promise<HeadlessObservation> {
    const s = this.w.sessions[ref.id];
    if (!s || s.sessionId !== expectedSessionId) throw new Error(`no fake session ${ref.id}`);
    this.w.calls.push(["headless", "goal", ref.id, target]);
    s.goal = { ...s.goal, status: target };
    return this.observe(ref);
  }

  override async deliver(ref: SessionRef, text: string, options: DeliverOptions = {}): Promise<DeliverOutcome> {
    this.w.calls.push(["headless", "deliver", ref.id, text]);
    const s = this.w.sessions[ref.id];
    if (!s || s.status === "gone") return { kind: "no-agent" };
    const forced = this.w.deliverOutcome?.(ref.id, text);
    if (forced) return forced;
    if (s.held || !s.sessionId) return { kind: "not-ready", status: s.status };
    if (options.expectedSessionId !== undefined && options.expectedSessionId !== s.sessionId)
      return { kind: "not-ready", status: "unknown" };
    const when = options.strictIdle ? "idle" : (options.when ?? "idle");
    if (when !== "any" && s.status !== when) return { kind: "not-ready", status: s.status };
    this.w.onDeliver?.(ref.id, text);
    if (this.w.onDeliverStatus) s.status = this.w.onDeliverStatus;
    return { kind: "delivered" };
  }

  override async close(ref: SessionRef): Promise<void> {
    this.w.calls.push(["headless", "close", ref.id]);
    delete this.w.sessions[ref.id];
  }
}
