import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type * as NativeFlags from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/cli/flag-tables.d.ts";
import { NATIVE_VALUE_FLAGS } from "../../src/runtime/omp-options.ts";
import { NATIVE_BOOLEAN_FLAGS } from "../../src/update/native-argv.ts";
import { modelLaunchProblem } from "../../skills/cataly-mode/scripts/src/launch-model.ts";

// CI has no extension peer: exercise the frozen host module boundary instead of an ambient package import.
const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const { STRING_VALUE_FLAGS, VALUELESS_FLAGS }: typeof NativeFlags = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli/flag-tables", host)
);

const source = "/fixture/packages/coding-agent/";
const prefixes = [
  ["omp"],
  ["omp-cataly", "omp"],
  ["env", "-i", "--", "omp"],
  ["npm", "exec", "--", "omp"],
  ["npx", "--yes", "@oh-my-pi/pi-coding-agent@19.0.1"],
  ["bun", "run", "--preload=/fixture/hook.ts", "/fixture/omp"],
  ["node", "--no-warnings", "/fixture/omp"],
  ["bun", "--preload", `${source}scripts/omp.ts`, `${source}src/cli.ts`],
  [
    "bun",
    "--preload",
    `${source}scripts/omp.ts`,
    "--preload",
    `${source}scripts/../../utils/src/module-timer.ts`,
    `${source}scripts/../src/cli.ts`,
  ],
];

test("the shared native value table matches the pinned parser", () => {
  expect(Object.keys(NATIVE_VALUE_FLAGS).sort()).toEqual([...STRING_VALUE_FLAGS].sort());
  expect(Object.keys(NATIVE_BOOLEAN_FLAGS).sort()).toEqual([...VALUELESS_FLAGS, "-h", "-v", "-c", "-p"].sort());
});

test.each(prefixes.map((prefix) => [prefix.join(" "), prefix] as const))(
  "the launch preflight accepts the native %s entry with idle options",
  (_name, prefix) => {
    for (const delimiter of [[], ["--"]]) {
      const template = [
        ...prefix,
        "--cataly-role",
        "lane",
        "--model",
        "{model}",
        "--plan",
        "subscription/plan",
        "--append-system-prompt",
        "--flag-looking value",
        "--owner-option=--literal",
        ...delimiter,
        "{prompt}",
      ];
      expect(modelLaunchProblem(template, "subscription/exact", true)).toBeNull();
    }
  },
);

test.each(
  [
    ["early text"],
    ["@/fixture/brief.md"],
    ["--goal", "start now"],
    ["--restore"],
    ["--resume", "/fixture/session.jsonl"],
    ["--owner-option", "ambiguous value"],
    ["--owner-boolean"],
    ["--append-system-prompt"],
  ].map((input) => [input]),
)("initial work or an ambiguous template is refused: %j", (input) => {
  const template = ["omp", "--model", "{model}", ...input, "{prompt}"];
  expect(modelLaunchProblem(template, "subscription/exact")).toContain("\nFix:");
});

test("non-interactive native modes are refused only in strict mode", () => {
  for (const flags of [
    ["-p"],
    ["--print"],
    ["--print=false"],
    ["--mode=json"],
    ["--mode=rpc"],
    ["--mode=rpc-ui"],
    ["--mode=acp"],
  ]) {
    const template = ["omp", ...flags, "--model", "{model}", "{prompt}"];
    expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
    expect(modelLaunchProblem(template, "subscription/exact", true)).toContain("\nFix:");
  }
});

test("opaque shell launchers remain compatible unless strict readback is requested", () => {
  const template = ["sh", "-c", 'exec omp "$@"', "agent", "{prompt}"];
  expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
  expect(modelLaunchProblem(template, "subscription/exact", true)).toContain("Fix:");
});

test("managed split empty extension values pass the strict launch preflight", () => {
  const template = [
    "/home/user/.cataly/bin/omp",
    "--no-extensions",
    "-e",
    "/fixture/extension",
    "--config",
    "/fixture/omp.yml",
    "--owner-option",
    "",
    "--model",
    "{model}",
    "--",
    "{prompt}",
  ];
  expect(modelLaunchProblem(template, "subscription/exact", true)).toBeNull();
  expect(modelLaunchProblem(template.with(7, "ambiguous value"), "subscription/exact", true)).toContain("\nFix:");
});

test("native planning, role, thinking and boolean options pass the strict launch preflight", () => {
  const template = [
    "omp",
    "--model",
    "{model}",
    "--prewalk",
    "--prewalk-into",
    "subscription/walk",
    "--plan-yolo",
    "--plan-yolo-into",
    "subscription/fast",
    "--smol",
    "subscription/small",
    "--thinking",
    "high",
    "--no-lsp",
    "--no-pty",
    "{prompt}",
  ];
  expect(modelLaunchProblem(template, "subscription/exact", true)).toBeNull();
  expect(
    modelLaunchProblem([...template.slice(0, -1), "early text", "{prompt}"], "subscription/exact", true),
  ).toContain("\nFix:");
});
