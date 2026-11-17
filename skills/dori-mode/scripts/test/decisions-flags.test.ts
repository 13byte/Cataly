import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Decisions } from "../src/decisions.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { type TestState, withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

const cliIn = (dir: string) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  return (...args: string[]) =>
    run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, process.execPath, cli, ...args]);
};

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("an explicit --thread none stores no thread, even for a lane that has one", async () => {
  // Given a lane with a thread.
  await new Registry(state.dir).write({
    key: "store-lane",
    title: "store",
    thread: "discord:c9/1",
    brief: "/b.md",
    done: "file /done.md",
    openedAt: new Date().toISOString(),
  });
  const invoke = cliIn(state.dir);
  // When asking with --thread none, with and without the lane.
  const withLane = await invoke("decision", "ask", "Q1", "--source", "s:1", "--lane", "store-lane", "--thread", "none");
  const alone = await invoke("decision", "ask", "Q2", "--source", "s:1", "--thread", "none");
  // Then neither decision has a thread.
  for (const result of [withLane, alone]) {
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(JSON.parse(result.out)).not.toHaveProperty("thread");
  }
});

test("match names the ledger's damage and race warnings on stderr and still binds the reply", async () => {
  // Given a decision posted as m:1, a garbage line, and a late answer after a first one on another decision.
  const ledger = new Decisions(state.dir);
  const d = ledger.ask({ question: "Q?", source: "s:1", message: "m:1" }, Date.now());
  const done = ledger.ask({ question: "Done?", source: "s:1" }, Date.now());
  ledger.answer(done.id, "yes", "s:2", Date.now());
  const late = { op: "answer", id: done.id, at: new Date().toISOString(), n: "0000000a", answer: "no", source: "s:3" };
  appendFileSync(ledger.path, `garbage\n${JSON.stringify(late)}\n`);
  // When the reply to m:1 is matched.
  const result = await cliIn(state.dir)("decision", "match", "m:1");
  // Then the decision prints, and both the problem and the warning are named.
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ id: d.id, message: "m:1" });
  const lines = result.err.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith(`DECISION_WARNING ${ledger.path}:4: JSON Parse error`);
  expect(lines[1]).toBe(`DECISION_WARNING ${ledger.path}:5: decision ${done.id} was already answered; answer ignored`);
});

test("a value flag with no value, at the end or before another flag, is refused and records nothing", async () => {
  // Given an empty ledger.
  const invoke = cliIn(state.dir);
  const ask = ["decision", "ask", "Which?", "--source", "s:1"];
  // When a value flag ends the line, or is followed by another flag that loose parsing would take as its value.
  for (const [args, flag] of [
    [[...ask, "--option", "A", "--option"], "--option"],
    [[...ask, "--option", "A", "--option", "--recommend", "1"], "--option"],
    [[...ask, "--option", "A", "--recommend"], "--recommend"],
    [[...ask, "--lane"], "--lane"],
    [[...ask, "--worklog"], "--worklog"],
    [[...ask, "--message", "--thread", "t:1"], "--message"],
    [[...ask, "--thread"], "--thread"],
    [["decision", "ask", "Which?", "--source"], "--source"],
    // Another command's value option takes `--` as its value, so the `--` ends nothing and --lane still has no value.
    [[...ask, "--text", "--", "--lane"], "--lane"],
  ] as const) {
    const result = await invoke(...args);
    // Then it is one line of refusal and nothing was written.
    expect([result.code, result.out, result.err.trim()]).toEqual([1, "", `${flag} needs a value`]);
  }
  expect(new Decisions(state.dir).read().items).toEqual([]);
  // A withdraw whose second --reason has no value is refused too, and a value starting with -- goes after `=`.
  const asked = JSON.parse((await invoke(...ask, "--option=--verbose", "--option", "quiet")).out);
  expect(asked.options).toEqual(["--verbose", "quiet"]);
  const withdraw = await invoke("decision", "withdraw", asked.id, "--reason", "moot", "--reason");
  expect([withdraw.code, withdraw.err.trim()]).toEqual([1, "--reason needs a value"]);
  expect(new Decisions(state.dir).read().items[0]?.withdrawnAt).toBeUndefined();
});
