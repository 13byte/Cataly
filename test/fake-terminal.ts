import type {
  AgentIdentity,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  SessionInfo,
  SessionRef,
  SubmitResult,
  TerminalRuntime,
} from "../src/runtime/types.ts";
import type { World } from "./fake.ts";

/** One fake delivery, shared by both runtimes: a scripted failure is ambiguous, else `when` gates on the status. */
export function deliverTo(w: World, ref: SessionRef, text: string, options: DeliverOptions): DeliverOutcome {
  w.calls.push({ cmd: "deliver", argv: [ref.id, text] });
  const pane = w.panes.get(ref.id);
  if (!pane) return { kind: "no-agent" };
  const fail = w.deliverFails.get(ref.id);
  if (fail !== undefined) return { kind: "ambiguous", detail: fail, failure: new Error(fail) };
  const when = options.strictIdle ? "idle" : (options.when ?? "idle");
  const ready = when === "any" || pane.status === when || (when === "idle" && pane.status === "done");
  if (!ready) return { kind: "not-ready", status: pane.status };
  pane.received.push(text);
  return { kind: "delivered" };
}

/**
 * The Tern runtime of a test world: a hand-registered terminal role (`cataly harness role`) lives in `World.panes` under
 * an id listed in `World.terminals`. Nothing is spawned; started commands land in `ran`, shell typing in `received`.
 */
export class FakeTerminal implements TerminalRuntime {
  readonly kind = "tern" as const;

  constructor(private readonly w: World) {}

  self(): SessionRef | undefined {
    return undefined;
  }

  async createGroup(label: string): Promise<string> {
    return label;
  }

  async create(spec: CreateSpec): Promise<SessionRef> {
    this.w.onCreate?.(spec);
    const id = String(++this.w.next);
    this.w.addTerminal(id, "shell").cwd = spec.cwd;
    this.w.created.push(spec);
    return { runtime: "tern", id, ...(spec.group === undefined ? {} : { group: spec.group }) };
  }

  async start(ref: SessionRef, command: string): Promise<void> {
    const pane = this.w.panes.get(ref.id);
    if (!pane) throw new Error(`no fake block ${ref.id}`);
    pane.ran.push(command);
    pane.status = "idle";
  }

  async list(): Promise<readonly SessionInfo[]> {
    return [...this.w.terminals].flatMap((id) => {
      const pane = this.w.panes.get(id);
      return pane ? [{ ref: { runtime: "tern", id }, status: pane.status }] : [];
    });
  }

  async probe(ref: SessionRef): Promise<Probe> {
    this.w.calls.push({ cmd: "probe", argv: [ref.id] });
    this.w.probeHook.get(ref.id)?.(this.w.calls.filter((c) => c.cmd === "probe" && c.argv[0] === ref.id).length);
    const pane = this.w.panes.get(ref.id);
    if (!pane) return { status: "gone", shellInFront: false };
    return pane.status === "shell"
      ? { status: "shell", shellInFront: true }
      : { status: pane.status, shellInFront: false, agent: "omp", sessionId: pane.sessionId };
  }

  async read(ref: SessionRef): Promise<string> {
    const screen = this.w.panes.get(ref.id)?.screen;
    if (screen === undefined) throw new Error("read failed");
    return screen;
  }

  async deliver(ref: SessionRef, text: string, options: DeliverOptions = {}): Promise<DeliverOutcome> {
    return deliverTo(this.w, ref, text, options);
  }

  async submitTyped(ref: SessionRef, _into: AgentIdentity): Promise<SubmitResult> {
    this.w.calls.push({ cmd: "submit", argv: [ref.id] });
    return "submitted";
  }

  async typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    const pane = this.w.panes.get(ref.id);
    if (pane?.status !== "shell") return false;
    pane.received.push(text);
    return true;
  }

  async keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    this.w.calls.push({ cmd: "keys", argv: [ref.id, ...names] });
  }

  async close(ref: SessionRef): Promise<void> {
    this.w.calls.push({ cmd: "close", argv: [ref.id] });
    this.w.panes.delete(ref.id);
    this.w.terminals.delete(ref.id);
  }
}
