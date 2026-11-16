import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const DONE = "closed acme/app#1";
let state: TestState;
let world: World;
let briefs: string;
beforeEach(() => {
  state = withState();
  world = newWorld();
  briefs = join(state.dir, "briefs");
  mkdirSync(briefs);
});
afterEach(() => {
  chmodSync(briefs, 0o700);
  state.done();
});

// The lane's tab, as herdr answers a create.
const withTab = (base: FlowDeps): FlowDeps => ({
  ...base,
  run: async (argv, opts) =>
    argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
      : base.run(argv, opts),
});

test("a brief that cannot be written stops the launch before a tab or a lane record exists", async () => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  chmodSync(briefs, 0o500);
  const deps = depsFor(world, fakeClock(T0), state.dir);

  await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: DONE })).rejects.toThrow(
    "brief not writable",
  );

  expect(world.calls.filter((c) => c[0] === "herdr" && c[1] === "tab")).toEqual([]);
  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(readFileSync(brief, "utf8")).toBe("brief");
  expect(readdirSync(briefs)).toEqual(["lane.md"]);
});

test("a brief that cannot be put in place after registration undoes the record, the tab and the staged brief", async () => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
  const original = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === brief) throw new Error("EACCES: permission changed");
    original(from, to);
  }) as typeof fs.renameSync);
  try {
    await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: DONE })).rejects.toThrow(
      "brief not written: EACCES: permission changed",
    );
  } finally {
    spy.mockRestore();
  }

  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "close")).toEqual([["herdr", "tab", "close", "w:t9"]]);
  expect(readFileSync(brief, "utf8")).toBe("brief");
  expect(readdirSync(briefs)).toEqual(["lane.md"]);
});

test("a staged brief that cannot be removed does not stop the record and tab rollback", async () => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
  const rename = fs.renameSync;
  const remove = fs.rmSync;
  const spies = [
    spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === brief) throw new Error("EACCES: directory locked");
      rename(from, to);
    }) as typeof fs.renameSync),
    spyOn(fs, "rmSync").mockImplementation(((path: fs.PathLike, options?: fs.RmOptions) => {
      if (String(path).endsWith(".launch")) throw new Error("EACCES: directory locked");
      remove(path, options);
    }) as typeof fs.rmSync),
  ];
  try {
    await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: DONE })).rejects.toThrow(
      "brief not written",
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "close")).toEqual([["herdr", "tab", "close", "w:t9"]]);
  expect(readFileSync(brief, "utf8")).toBe("brief");
});

test("a brief that links to a template is written through the link", async () => {
  const template = join(briefs, "template.md");
  writeFileSync(template, "template");
  const brief = join(briefs, "lane.md");
  symlinkSync(template, brief);
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));

  await launchLane(deps, { key: "linked-lane", title: "t", brief, done: DONE });

  expect(lstatSync(brief).isSymbolicLink()).toBe(true);
  expect(readFileSync(template, "utf8")).toContain("template");
  expect(readdirSync(briefs).sort()).toEqual(["lane.md", "template.md"]);
});

test.each([0o600, 0o640])("staging preserves an existing brief's %s permissions under either umask", async (mode) => {
  const brief = join(briefs, "private.md");
  writeFileSync(brief, "owner instructions");
  chmodSync(brief, mode);
  const before = process.umask(0);
  try {
    const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
    await launchLane(deps, { key: "private-lane", title: "t", brief, done: DONE });
    expect(statSync(brief).mode & 0o777).toBe(mode);
    process.umask(0o077);
    await launchLane(deps, { key: "second-lane", title: "t", brief, done: DONE });
    expect(statSync(brief).mode & 0o777).toBe(mode);
  } finally {
    process.umask(before);
  }
});

test.each([false, true])("a read-only brief or linked template refuses replacement (%s)", async (linked) => {
  const target = join(briefs, linked ? "template.md" : "lane.md");
  const brief = join(briefs, "lane.md");
  writeFileSync(target, "protected instructions");
  chmodSync(target, 0o444);
  if (linked) symlinkSync(target, brief);
  try {
    const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
    await expect(launchLane(deps, { key: "readonly-lane", title: "t", brief, done: DONE })).rejects.toThrow(
      "brief not writable",
    );
    expect(await deps.registry.read("readonly-lane")).toBeNull();
    expect(world.calls.some((argv) => argv[0] === "herdr" && argv[1] === "tab")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("protected instructions");
    expect(statSync(target).mode & 0o777).toBe(0o444);
    expect(lstatSync(brief).isSymbolicLink()).toBe(linked);
    expect(readdirSync(briefs).sort()).toEqual(linked ? ["lane.md", "template.md"] : ["lane.md"]);
  } finally {
    chmodSync(target, 0o600);
  }
});
