import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { ConfigError, RuntimeChoiceError, readRuntimeChoice } from "../src/runtime/select.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "cataly-select-"));

const config = (text: string): string => {
  const path = join(scratch(), "config.json");
  writeFileSync(path, text);
  return path;
};
const NO_CONFIG = "/nonexistent/cataly/config.json";
const posix = test.skipIf(process.platform === "win32");

const pathWith = (...bins: string[]): string => {
  const dirs = bins.map((bin) => {
    const dir = join(scratch(), "bin");
    mkdirSync(dir);
    const file = join(dir, bin);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return dir;
  });
  return [join(scratch(), "empty"), ...dirs].join(delimiter);
};

describe("default native execution", () => {
  posix("nothing set, a tern preference, a Tern block and an installed tern all choose headless by default", () => {
    for (const saved of ["{}", '{"runtime":"tern"}'])
      expect(
        readRuntimeChoice({
          env: { TERN_PANE: "42", PATH: pathWith("tern"), CATALY_RUNTIME: "" },
          configPath: config(saved),
          exists: () => {
            throw new Error("native selection should not scan PATH");
          },
        }),
      ).toEqual({ kind: "headless", source: "default" });
    expect(readRuntimeChoice({ env: {}, configPath: NO_CONFIG })).toEqual({ kind: "headless", source: "default" });
  });

  posix("CATALY_RUNTIME and sessionRuntime may name headless explicitly", () => {
    expect(readRuntimeChoice({ env: { CATALY_RUNTIME: "headless" }, configPath: NO_CONFIG })).toEqual({
      kind: "headless",
      source: "env",
    });
    expect(readRuntimeChoice({ env: {}, configPath: config('{"sessionRuntime":"headless"}') })).toEqual({
      kind: "headless",
      source: "config",
    });
  });

  test("CATALY_RUNTIME and sessionRuntime may name tern explicitly", () => {
    expect(readRuntimeChoice({ env: { CATALY_RUNTIME: "tern" }, configPath: NO_CONFIG })).toEqual({
      kind: "tern",
      source: "env",
    });
    expect(readRuntimeChoice({ env: {}, configPath: config('{"sessionRuntime":"tern"}') })).toEqual({
      kind: "tern",
      source: "config",
    });
  });

  test.skipIf(process.platform !== "win32")("Windows looks for Tern instead of the native socket host", () => {
    expect(() => readRuntimeChoice({ env: { PATH: pathWith() }, configPath: NO_CONFIG })).toThrow(RuntimeChoiceError);
    expect(readRuntimeChoice({ env: { TERN_PANE: "42" }, configPath: NO_CONFIG })).toEqual({
      kind: "tern",
      source: "detect:TERN_PANE",
    });
  });
});

describe("explicit terminal selection precedence", () => {
  test.each([
    [
      "CATALY_RUNTIME beats config and every detection",
      { CATALY_RUNTIME: "tern", PATH: pathWith() },
      "{}",
      "tern",
      "env",
    ],
    [
      "sessionRuntime beats the caller's block",
      { TERN_PANE: "42", PATH: pathWith("tern") },
      '{"sessionRuntime":"tern"}',
      "tern",
      "config",
    ],
    ["config runtime with tern not installed", { PATH: pathWith() }, '{"runtime":"tern","other":1}', "tern", "config"],
    ["TERN_PANE with tern not on PATH", { TERN_PANE: "42", PATH: pathWith() }, undefined, "tern", "detect:TERN_PANE"],
    ["TERN_PANE beats tern on PATH", { TERN_PANE: "42", PATH: pathWith("tern") }, "{}", "tern", "detect:TERN_PANE"],
    ["only tern on PATH", { PATH: pathWith("tern") }, undefined, "tern", "detect:path"],
    [
      "empty variables count as unset",
      { CATALY_RUNTIME: "", TERN_PANE: "", PATH: pathWith("tern") },
      undefined,
      "tern",
      "detect:path",
    ],
    [
      "a headless CATALY_RUNTIME or sessionRuntime does not stop terminal detection",
      { CATALY_RUNTIME: "headless", PATH: pathWith("tern") },
      '{"sessionRuntime":"headless"}',
      "tern",
      "detect:path",
    ],
  ] as const)("%s", (_, env, configText, kind, source) => {
    const configPath = configText === undefined ? NO_CONFIG : config(configText);
    expect(readRuntimeChoice({ env, configPath, terminalOnly: true })).toEqual({ kind, source });
  });
});

describe("readRuntimeChoice refusals", () => {
  test("no tern and nothing set: RuntimeChoiceError whose message names the config path and the fix", () => {
    const configPath = config("{}");
    let caught: unknown;
    try {
      readRuntimeChoice({ env: { PATH: pathWith() }, configPath, terminalOnly: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeChoiceError);
    const message = (caught as Error).message;
    expect(message).toContain("tern is not on PATH");
    expect(message).toContain(configPath);
    expect(message).toContain('"runtime": "tern"');
    expect(message).toContain("CATALY_RUNTIME");
    expect(() => readRuntimeChoice({ env: {}, configPath: NO_CONFIG, terminalOnly: true })).toThrow(RuntimeChoiceError);
  });

  // POSIX-only: the executable bit decides install here, and Windows has no mode bits.
  posix("a non-executable file named tern is not an install", () => {
    const dir = scratch();
    writeFileSync(join(dir, "tern"), "");
    chmodSync(join(dir, "tern"), 0o644);
    expect(() => readRuntimeChoice({ env: { PATH: dir }, configPath: NO_CONFIG, terminalOnly: true })).toThrow(
      RuntimeChoiceError,
    );
  });

  test("an unknown runtime name is a ConfigError", () => {
    expect(() => readRuntimeChoice({ env: { CATALY_RUNTIME: "tmux" }, configPath: NO_CONFIG })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env: { CATALY_RUNTIME: "tmux" }, configPath: NO_CONFIG })).toThrow(
      /CATALY_RUNTIME.*"tmux"/,
    );
    expect(() => readRuntimeChoice({ env: {}, configPath: config('{"sessionRuntime":"tmux"}') })).toThrow(ConfigError);
  });

  test('config runtime "tmux" or a non-string: ConfigError naming the file and the value', () => {
    const configPath = config('{"runtime":"tmux"}');
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(ConfigError);
    expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(
      new RegExp(`${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*"tmux"`),
    );
    expect(() => readRuntimeChoice({ env: {}, configPath: config('{"runtime":7}') })).toThrow(ConfigError);
  });

  test("an unreadable or non-object config is a ConfigError naming its path", () => {
    for (const text of ["not json", "[]", "7"]) {
      const configPath = config(text);
      expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(ConfigError);
      expect(() => readRuntimeChoice({ env: {}, configPath })).toThrow(configPath);
    }
  });
});

describe("readRuntimeChoice PATH detection is injectable", () => {
  test("exists is asked for tern in each PATH directory", () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return path === join("/b", "tern");
    };
    expect(
      readRuntimeChoice({
        env: { PATH: [join("/a"), join("/b")].join(delimiter) },
        configPath: NO_CONFIG,
        exists,
        terminalOnly: true,
      }),
    ).toEqual({ kind: "tern", source: "detect:path" });
    expect(asked).toContain(join("/a", "tern"));
  });

  test("an empty PATH entry is skipped, never read as the working directory", () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return false;
    };
    const a = join("/a");
    expect(() =>
      readRuntimeChoice({
        env: { PATH: ["", a, ""].join(delimiter) },
        configPath: NO_CONFIG,
        exists,
        terminalOnly: true,
      }),
    ).toThrow(RuntimeChoiceError);
    expect(asked.every((p) => p.startsWith(`${a}${sep}`))).toBe(true);
  });
});
