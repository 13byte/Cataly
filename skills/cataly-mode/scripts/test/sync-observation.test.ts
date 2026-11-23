import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { makeCli } from "../src/cli-context.ts";
import { opsCommands } from "../src/cli-ops.ts";
import { runtimesOf } from "../src/run.ts";
import { sendVerified } from "../src/sessions.ts";
import { syncRegistry } from "../src/sync.ts";
import { getStatus } from "../src/voice/status.ts";
import {
  depsFor,
  fakeClock,
  href,
  nativeLane,
  newWorld,
  sent,
  sid,
  type TestState,
  withState,
  type World,
} from "./fakes.ts";

const AT = "2026-01-01T12:00:00.000Z";
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const setup = async () => {
  const deps = depsFor(world, fakeClock(Date.parse(AT)), state.dir);
  const lane = {
    key: "observed",
    title: "Observed",
    thread: "none",
    ...nativeLane(world, 1),
    brief: "/b.md",
    done: "closed acme/app#1",
    openedAt: AT,
  };
  await deps.registry.write(lane);
  return { deps, lane };
};

test("JSON rows carry the native supervisor's attested session and keep drift and unbound meanings", async () => {
  const { deps, lane } = await setup();
  const snapshot = await syncRegistry(deps, false);
  const json = JSON.parse(JSON.stringify(snapshot));
  expect(json.observedAt).toBe(AT);
  expect(json.rows).toEqual([
    {
      key: lane.key,
      thread: "none",
      pane: sid(1),
      session: "session-1 (rpc-ui)",
      status: "working",
      source: "rpc-ui",
      relationship: "matched",
      unknownReason: null,
    },
  ]);
  expect(json.drift).toEqual([]);
  expect(json.unregistered).toEqual([]);
  await deps.registry.update(lane.key, (current) => current && { ...current, session: "session-other" });
  const changed = await syncRegistry(deps, false);
  expect(changed.rows[0]?.relationship).toBe("changed");
  expect(changed.drift).toEqual([`${lane.key}: pane now runs session session-1 (registry has session-other)`]);
  const { session: _session, ...unbound } = lane;
  await deps.registry.write({ ...unbound, key: "unbound" });
  expect((await syncRegistry(deps, false)).rows.find((row) => row.key === "unbound")?.relationship).toBe("unbound");
});

test("an unattested native session stays unknown and leaves the registry unchanged", async () => {
  const { deps, lane } = await setup();
  const session = world.sessions[sid(1)];
  if (!session) throw new Error("missing fixture session");
  session.status = "unknown";
  const before = readFileSync(deps.registry.path(lane.key), "utf8");
  const snapshot = await syncRegistry(deps, false);
  expect(snapshot.rows[0]).toMatchObject({
    session: "session-1",
    source: "registry",
    relationship: "unknown",
    unknownReason: "headless session observation unconfirmed",
  });
  expect(snapshot.drift).toEqual([]);
  expect(readFileSync(deps.registry.path(lane.key), "utf8")).toBe(before);
});

test("CLI and voice show observation provenance and unknown reasons without performing a delivery", async () => {
  const { deps } = await setup();
  const session = world.sessions[sid(1)];
  if (!session) throw new Error("missing fixture session");
  session.status = "unknown";
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await opsCommands["sync"]!(makeCli("sync", [], { values: {}, positionals: [] }, deps.config, deps));
  } finally {
    log.mockRestore();
  }
  const shown = lines.join("\n");
  expect(shown).toContain(`OBSERVED ${AT}`);
  expect(shown).toContain("source | relationship | unknownReason");
  expect(shown).toContain("session-1 | working | registry | unknown | headless session observation unconfirmed");
  expect(shown).toContain("READ_ONLY");
  const voice = await getStatus(deps, ["lanes"]);
  expect(voice.result).toContain(`read at ${AT}`);
  expect(voice.result).toContain(
    "source=registry relationship=unknown unknown=headless session observation unconfirmed",
  );
  expect(
    await sendVerified(
      runtimesOf(deps),
      deps.clock,
      href(sid(1)),
      "Do not send to an unattested session",
      undefined,
      "session-1",
    ),
  ).toBe("failed");
  expect(sent(world)).toEqual([]);
});
