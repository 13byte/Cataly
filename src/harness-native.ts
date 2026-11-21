import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { retireLegacyRoles } from "./harness-legacy.ts";
import { harnessLaunchEnv, nativeHarnessCommand, rolePrompt, type Deps } from "./harness.ts";
import { acquire, release } from "./loop-lock.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { type HeadlessObservation, HeadlessRuntime } from "./runtime/headless.ts";
import { readPrivate, writePrivate } from "./runtime/headless-record.ts";
import { HEADLESS_ADDRESS, type SessionRef } from "./runtime/types.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

type Binding = { readonly ref: SessionRef; readonly sessionId?: string };
type Inventory = { readonly version: 1; readonly stateDir: string; readonly roles: Partial<Record<Role, Binding>> };

const inventoryPath = (d: Deps) => join(d.store.root, "harness-native.json");
const agent = (role: Role): role is "lead" | "duty" => role === "lead" || role === "duty";
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const exclusivePath = (d: Deps) => join(d.store.root, "harness.lock");

export async function withHarnessLock<T>(d: Deps, run: () => Promise<T> | T): Promise<T> {
  const path = exclusivePath(d);
  const held = acquire(d, path);
  if ("holder" in held) throw new Refusal(`another harness operation owns this home (${held.holder})`);
  try {
    return await run();
  } finally {
    release(d, held.nonce, path);
  }
}

export function nativeInventory(d: Deps): Inventory | undefined {
  const saved = readPrivate<Inventory>(inventoryPath(d));
  if (!saved) return undefined;
  if (
    saved.version !== 1 ||
    typeof saved.stateDir !== "string" ||
    !isAbsolute(saved.stateDir) ||
    !saved.roles ||
    typeof saved.roles !== "object" ||
    Array.isArray(saved.roles)
  )
    throw new Refusal("native harness inventory is invalid; no process can be assumed owned");
  const ids = new Set<string>();
  const sessions = new Set<string>();
  for (const [role, record] of Object.entries(saved.roles)) {
    if (
      !RESERVED_KEYS.some((key) => key === role) ||
      !record ||
      record.ref?.runtime !== "headless" ||
      !HEADLESS_ADDRESS.test(record.ref.id) ||
      ids.has(record.ref.id) ||
      (record.sessionId !== undefined &&
        (!agent(role as Role) ||
          !record.sessionId ||
          typeof record.sessionId !== "string" ||
          sessions.has(record.sessionId)))
    )
      throw new Refusal("native harness inventory has an ambiguous role or session identity");
    ids.add(record.ref.id);
    if (record.sessionId) sessions.add(record.sessionId);
  }
  return saved;
}

function scopeCommand(d: Deps, role: "lead" | "duty", argv: readonly string[]): string[] {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${role}.md`);
  const prompt = rolePrompt(d, `${role}.md`);
  const scope =
    role === "duty"
      ? prompt +
        "\nThe harness owns duty-loop and hourly-loop. Do not open terminal panes, start duplicate controllers, or take over lead intake.\n"
      : prompt +
        "\nYou are the native headless lead; use the harness commands to observe and reach registered sessions, not terminal emulation.\n";
  // Atomic, owner-only file: the native CLI consumes an explicit prompt file, never shell interpolation.
  const promptPath = `${path}.${crypto.randomUUID()}.md`;
  writeFileSync(promptPath, scope, { flag: "wx", mode: 0o600 });
  return [...argv, "--append-system-prompt", promptPath];
}

/** Runs under the harness lock. Publish a reservation before its process starts, then publish only proven roles. */
export async function startNativeHarness(d: Deps, rt: HeadlessRuntime, cwd: string): Promise<void> {
  const commands = {
    lead: scopeCommand(d, "lead", (await nativeHarnessCommand(d, "lead")).argv),
    duty: scopeCommand(d, "duty", (await nativeHarnessCommand(d, "duty")).argv),
  };
  const env = {
    ...harnessLaunchEnv(d),
    CATALY_STATE_DIR: rt.stateDir,
    CATALY_LANE: "",
    CATALY_LANE_POLICY: "",
    CATALY_RUNTIME: "headless",
  };
  const state: Inventory = { version: 1, stateDir: rt.stateDir, roles: {} };
  const files = new Set<string>();
  const save = () => writePrivate(inventoryPath(d), state);
  for (const role of RESERVED_KEYS) {
    try {
      const ref = await rt.create({
        name: role,
        role,
        container: role === "lead" ? "workspace-root" : "tab",
        cwd,
        env,
        group: groupId(d.store.root),
      });
      state.roles[role] = { ref };
      save();
      const scoped = role === "lead" ? env : { ...env, CATALY_DISCORD_TOKEN: "", CATALY_TELEGRAM_TOKEN: "" };
      const seen = agent(role) ? await rt.startNative(ref, commands[role], scoped) : await rt.startLoop(ref, scoped);
      if (agent(role)) {
        if (
          !seen.sessionId ||
          !seen.sessionFile ||
          files.has(seen.sessionFile) ||
          Object.values(state.roles).some((binding) => seen.sessionId === binding.sessionId)
        )
          throw new Refusal("native role did not prove a distinct OMP session");
        files.add(seen.sessionFile);
        state.roles[role] = { ref, sessionId: seen.sessionId };
        save();
      }
      if (d.store.roles()[role]) throw new Refusal(`${role} was registered independently during startup`);
      d.store.setRole(role, ref);
    } catch (error) {
      throw new Refusal(
        `Cannot start ${role}: ${reason(error)}. Existing sessions were not replaced; inspect cataly harness status, then use cataly harness stop.`,
      );
    }
  }
  const show = (role: Role) => refText(state.roles[role]!.ref);
  console.log(
    `UP runtime=headless lead=${show("lead")} duty=${show("duty")} loop=${show("duty-loop")} hourly=${show("hourly-loop")} home=${d.store.root}`,
  );
}

const runtimeAt = (d: Deps, state: Inventory): HeadlessRuntime =>
  new HeadlessRuntime(state.stateDir, { ...process.env, CATALY_HOME: resolve(d.store.root) });

function checkRegistration(d: Deps, role: Role, expected: SessionRef): void {
  const current = d.store.roles()[role];
  if (current && !sameSession(current, expected))
    throw new Refusal(`${role} registration does not match the owned ref`);
}

export async function stopNativeHarness(d: Deps): Promise<void> {
  await withHarnessLock(d, async () => {
    const state = nativeInventory(d);
    if (!state) {
      const retired = await retireLegacyRoles(d);
      console.log(
        retired
          ? `STOPPED retired ${retired} already-gone legacy role registration(s)`
          : "STOPPED no owned native harness",
      );
      return;
    }
    const rt = runtimeAt(d, state);
    const stop = async (roles: readonly Role[]) => {
      const problems: string[] = [];
      for (const role of roles) {
        const binding = state.roles[role];
        if (!binding) continue;
        try {
          checkRegistration(d, role, binding.ref);
          await rt.stopHarnessRole(binding.ref, role, binding.sessionId);
          d.store.clearRoles([[role, binding.ref]]);
          delete state.roles[role];
          writePrivate(inventoryPath(d), state);
        } catch (error) {
          problems.push(`${role}: ${reason(error)}`);
        }
      }
      if (problems.length) throw new Refusal(`HARNESS STOP HELD\n${problems.join("\n")}`);
    };
    // Drain existing loop passes before inspecting settled agents. Never stop lanes or a terminal registered by hand.
    await stop(["hourly-loop", "duty-loop"]);
    if (state.roles.lead && state.roles.duty) {
      const [lead, duty] = await Promise.all([rt.observe(state.roles.lead.ref), rt.observe(state.roles.duty.ref)]);
      if (
        (lead.sessionId && lead.sessionId === duty.sessionId) ||
        (lead.sessionFile && lead.sessionFile === duty.sessionFile)
      )
        throw new Refusal("HARNESS STOP HELD: lead and duty have ambiguous native identity");
    }
    await stop(["lead", "duty"]);
    rmSync(inventoryPath(d));
    console.log("STOPPED native harness");
  });
}

export async function nativeHarnessStatus(d: Deps): Promise<string[]> {
  const state = nativeInventory(d);
  if (!state) return [];
  const rt = runtimeAt(d, state);
  return Promise.all(
    RESERVED_KEYS.flatMap((role) => {
      const binding = state.roles[role];
      if (!binding) return [];
      return [
        (async () => {
          const prefix = `NATIVE ${role} ${refText(binding.ref)}`;
          let seen: HeadlessObservation;
          try {
            checkRegistration(d, role, binding.ref);
            seen = await rt.observe(binding.ref);
          } catch (error) {
            return `${prefix} unknown (${reason(error)})`;
          }
          if (seen.harnessRole !== role || (binding.sessionId && seen.sessionId !== binding.sessionId))
            return `${prefix} ${seen.status === "gone" ? "gone" : "unknown"}${seen.detail ? ` (${seen.detail})` : ""}`;
          const log = agent(role) ? "" : ` log=${rt.loopLog(binding.ref)}`;
          return `${prefix} ${agent(role) ? seen.status : seen.status === "working" ? "running" : seen.status}${seen.pid ? ` pid=${seen.pid}` : ""}${seen.sessionId ? ` session=${seen.sessionId}` : ""}${log}`;
        })(),
      ];
    }),
  );
}
