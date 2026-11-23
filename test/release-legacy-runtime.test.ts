import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoLegacyRuntime, LegacyRuntimeError } from "../src/release/legacy-runtime.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const HEADLESS_ID = "0123abcd-0123-4567-89ab-0123456789ab";

/** A Cataly home with its config, its state directory and the files the guard reads. */
function home(files: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cataly-legacy-guard-"));
  homes.push(root);
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "lanes"), { recursive: true });
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  }
  const input = { stateDir, configPath: join(root, "config.json") };
  return { root, input, guard: () => assertNoLegacyRuntime(input) };
}

const message = (configPath: string) =>
  [
    "This Cataly home still uses the herdr/hc terminal runtime, which this version removed.",
    "1. Close every herdr/hc lane (`cataly status` lists them) with your previous Cataly version.",
    `2. Remove "runtime" (if it names herdr or hc) and "sessionRuntime" from ${configPath}.`,
    "3. Run this command again. Cataly state and OMP sessions are kept; lanes reopen on headless.",
  ].join("\n");

test.each([{ runtime: "herdr" }, { runtime: "hc" }, { sessionRuntime: "hc" }, { sessionRuntime: "herdr" }])(
  "a legacy config %j stops with the upgrade instructions and is not rewritten",
  (config) => {
    const h = home({ "config.json": config });
    expect(h.guard).toThrow(LegacyRuntimeError);
    expect(h.guard).toThrow(message(h.input.configPath));
    expect(JSON.parse(readFileSync(h.input.configPath, "utf8"))).toEqual(config);
  },
);

test("an open herdr lane stops the upgrade", () => {
  const lane = { key: "fix", status: "running", sessionRef: { runtime: "herdr", id: "w1:p3" } };
  const h = home({ "state/lanes/fix.json": lane });
  expect(h.guard).toThrow(message(h.input.configPath));
  expect(JSON.parse(readFileSync(join(h.input.stateDir, "lanes/fix.json"), "utf8"))).toEqual(lane);
});

test("an open lane from before runtimes existed, naming only its herdr paneId, stops the upgrade", () => {
  const h = home({ "state/lanes/old.json": { key: "old", status: "running", paneId: "w1:p3", tabId: "w1:t1" } });
  expect(h.guard).toThrow(LegacyRuntimeError);
});

test("an open hc lane in the configured state directory stops the upgrade", () => {
  const h = home();
  const custom = join(h.root, "custom-state");
  writeFileSync(h.input.configPath, JSON.stringify({ stateDir: custom }));
  mkdirSync(join(custom, "lanes"), { recursive: true });
  writeFileSync(
    join(custom, "lanes/x.json"),
    JSON.stringify({ status: "idle", sessionRef: { runtime: "hc", id: "t7" } }),
  );
  expect(h.guard).toThrow(LegacyRuntimeError);
});

test("a configured ~/ state directory names the consumer home, not the process home", () => {
  const h = home({ "elsewhere/lanes/x.json": { status: "idle", sessionRef: { runtime: "hc", id: "t7" } } });
  writeFileSync(h.input.configPath, JSON.stringify({ stateDir: "~/elsewhere" }));
  expect(() => assertNoLegacyRuntime({ ...h.input, home: h.root })).toThrow(LegacyRuntimeError);
});

test.each([
  { key: "done", status: "done", sessionRef: { runtime: "herdr", id: "w1:p3" } },
  { key: "closed", status: "running", closedAt: "2026-01-01T00:00:00Z", paneId: "w1:p4" },
])("a closed legacy lane is allowed: $key", (lane) => {
  const h = home({ [`state/lanes/${lane.key}.json`]: lane });
  expect(h.guard).not.toThrow();
});

test("historical roles.json stops the upgrade with the retirement step", () => {
  const roles = { lead: "w1:p1" };
  const h = home({ "roles.json": roles });
  expect(h.guard).toThrow(
    `${message(h.input.configPath)}\nRetire the historical roles with your previous Cataly version (cataly update --retire-legacy-roles).`,
  );
  expect(JSON.parse(readFileSync(join(h.root, "roles.json"), "utf8"))).toEqual(roles);
});

test("a clean headless home is allowed, including native harness roles and open headless lanes", () => {
  const h = home({
    "config.json": { sessionRuntime: "headless", defaultModel: "owner/model" },
    "roles.json": { lead: `headless:${HEADLESS_ID}` },
    "state/lanes/fix.json": { key: "fix", status: "running", sessionRef: { runtime: "headless", id: HEADLESS_ID } },
  });
  expect(h.guard).not.toThrow();
});

test("a Tern home is allowed: config, harness roles, open lanes and pane-only Tern rows", () => {
  const h = home({
    "config.json": { runtime: "tern", sessionRuntime: "tern", laneRuntime: "terminal" },
    "roles.json": { lead: "tern:7", duty: `headless:${HEADLESS_ID}` },
    "state/lanes/fix.json": { key: "fix", status: "running", sessionRef: { runtime: "tern", id: "42" } },
    "state/lanes/pane.json": { key: "pane", status: "running", pane: "43" },
  });
  expect(h.guard).not.toThrow();
});

test("an open pane-only skill row with a herdr-shaped pane stops the upgrade", () => {
  const h = home({ "state/lanes/old.json": { key: "old", status: "running", pane: "w2:p5" } });
  expect(h.guard).toThrow(LegacyRuntimeError);
});

test("an absent config and state directory are allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-legacy-guard-"));
  homes.push(root);
  expect(() =>
    assertNoLegacyRuntime({ stateDir: join(root, "missing-state"), configPath: join(root, "config.json") }),
  ).not.toThrow();
});
