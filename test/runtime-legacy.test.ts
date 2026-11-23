import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refFromText } from "../src/refs.ts";
import { LegacyRuntimeError, Runtimes } from "../src/runtime/registry.ts";
import { ConfigError, readRuntimeChoice } from "../src/runtime/select.ts";
import { parseRef, type SessionRuntime } from "../src/runtime/types.ts";

const GUIDE = [
  "This Cataly home still uses the herdr/hc terminal runtime, which this version removed.",
  "1. Close every herdr/hc lane (`cataly status` lists them) with your previous Cataly version.",
  '2. Remove "runtime" (if it names herdr or hc) and "sessionRuntime" from /home/me/.cataly/config.json.',
  "3. Run this command again. Cataly state and OMP sessions are kept; lanes reopen on headless.",
].join("\n");

const config = (settings: object): string => {
  const path = join(mkdtempSync(join(tmpdir(), "cataly-legacy-")), "config.json");
  writeFileSync(path, JSON.stringify(settings));
  return path;
};

describe("a home that still names herdr/hc", () => {
  test.each([
    ["herdr:w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["w1:p3", { runtime: "herdr", id: "w1:p3" }],
    ["hc:t7", { runtime: "hc", id: "t7" }],
  ] as const)("the stored ref %s still parses", (text, ref) => {
    expect(parseRef(text)).toEqual(ref);
    expect(refFromText(text)).toEqual(ref);
  });

  test("Runtimes.for on a legacy ref throws LegacyRuntimeError with the upgrade steps and builds nothing", () => {
    let built = 0;
    const runtimes = new Runtimes(
      "headless",
      () => {
        built += 1;
        return { kind: "headless" } as SessionRuntime;
      },
      "/home/me/.cataly/config.json",
    );
    for (const text of ["w1:p3", "herdr:w2:p1", "hc:t7"]) {
      const ref = parseRef(text)!;
      expect(() => runtimes.for(ref)).toThrow(LegacyRuntimeError);
      expect(() => runtimes.for(ref)).toThrow(GUIDE);
    }
    expect(built).toBe(0);
  });

  test("Runtimes.terminal on a legacy kind throws LegacyRuntimeError and builds nothing", () => {
    let built = 0;
    const runtimes = new Runtimes("headless", () => {
      built += 1;
      return { kind: "headless" } as SessionRuntime;
    });
    for (const kind of ["herdr", "hc"] as const) expect(() => runtimes.terminal(kind)).toThrow(LegacyRuntimeError);
    expect(built).toBe(0);
  });

  test.each([
    ["runtime herdr", { runtime: "herdr" }],
    ["runtime hc", { runtime: "hc" }],
    ["sessionRuntime herdr", { sessionRuntime: "herdr" }],
    ["sessionRuntime hc", { sessionRuntime: "hc" }],
  ] as const)("readRuntimeChoice rejects config %s with LegacyRuntimeError", (_, settings) => {
    const configPath = config(settings);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(LegacyRuntimeError);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(`from ${configPath}.`);
    expect(() => readRuntimeChoice({ env: { CATALY_RUNTIME: "headless" }, configPath })).toThrow(LegacyRuntimeError);
  });

  test.each(["herdr", "hc"])("readRuntimeChoice rejects CATALY_RUNTIME=%s", (name) => {
    expect(() => readRuntimeChoice({ env: { CATALY_RUNTIME: name }, configPath: config({}) })).toThrow(
      LegacyRuntimeError,
    );
  });

  test("Tern settings and laneRuntime terminal are not legacy", () => {
    for (const settings of [{ runtime: "tern" }, { sessionRuntime: "tern" }, { laneRuntime: "terminal" }])
      expect(
        readRuntimeChoice({ env: { TERN_PANE: "42" }, configPath: config(settings), terminalOnly: true }).kind,
      ).toBe("tern");
    expect(() => readRuntimeChoice({ env: {}, configPath: config({ sessionRuntime: "terminal" }) })).toThrow(
      ConfigError,
    );
  });
});
