import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { sid, withState } from "./fakes.ts";
import { queueFixture, type QueueFixture, unspawnableTern } from "./launch-queue-fixture.ts";

let f: QueueFixture;
let brief: string;
beforeEach(async () => {
  f = await queueFixture();
  const templates = join(f.state.dir, "templates");
  mkdirSync(templates);
  writeFileSync(join(templates, "task.md"), "Preserve the rendered instructions.\n");
  brief = join(f.state.dir, "briefs", `${f.input.key}.md`);
});
afterEach(() => f.state.done());

/** Runs `during` inside the fake supervisor's reservation, after the creation is counted. */
const duringCreate = (during: () => void): void => {
  const count = f.world.onCreate;
  f.world.onCreate = async (spec) => {
    await count?.(spec);
    during();
  };
};

const retainedBrief = (): string => {
  const attempts = `${brief}.attempts`;
  const [attempt, ...others] = readdirSync(attempts);
  if (!attempt || others.length) throw new Error(`expected one retained attempt in ${attempts}`);
  return join(attempts, attempt, "brief.md");
};

const rlimit = test.skipIf(process.platform === "win32" || !existsSync("/bin/sh"));
rlimit.each([0, 1])("a staging write over a %i-block file limit does not hold a same-key launch", async (blocks) => {
  const module = new URL("../src/launch-generated.ts", import.meta.url).href;
  const script = `import { stageGeneratedBrief } from ${JSON.stringify(module)};
try {
  stageGeneratedBrief(${JSON.stringify(brief)}, "oversized brief".repeat(2048));
  process.exit(2);
} catch (error) {
  console.log(error.code);
}`;
  // RLIMIT_FSIZE applies only to this child; ignoring SIGXFSZ makes the real write report EFBIG.
  const child = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'trap "" XFSZ && ulimit -f "$1" && shift && exec "$@"',
      "cataly-brief-fixture",
      String(blocks),
      process.execPath,
      "-e",
      script,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ out, err, code }).toEqual({ out: "EFBIG\n", err: "", code: 0 });
  expect(existsSync(brief)).toBe(false);
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  const launched = await launchLane(f.deps, { ...f.input, brief, template: "task" });
  expect(launched.startup).toContain("STARTUP_OK");
  expect(f.creates()).toBe(1);
});

test("an unavailable session runtime releases the generated brief and permits a same-key retry", async () => {
  const input = { ...f.input, brief, template: "task" };
  await expect(launchLane(unspawnableTern(f), input)).rejects.toThrow("session create failed");
  expect(existsSync(brief)).toBe(false);
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  expect(await f.deps.registry.read(input.key)).toBeNull();

  expect((await launchLane(f.deps, input)).startup).toContain("STARTUP_OK");
  expect(readFileSync(brief, "utf8")).toContain("Preserve the rendered instructions.");
  expect(f.creates()).toBe(1);
});

test.each(["socket closed", "reservation unreadable"])(
  "%s during native reservation retains the generated brief and blocks retry",
  async (detail) => {
    const input = { ...f.input, brief, template: "task" };
    duringCreate(() => {
      throw new Error(detail);
    });

    await expect(launchLane(f.deps, input)).rejects.toThrow("generated brief retained at");
    const path = retainedBrief();
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("Preserve the rendered instructions.");
    expect(await f.deps.registry.read(input.key)).toBeNull();
    await expect(launchLane(f.deps, input)).rejects.toThrow("generated brief not writable");
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(f.creates()).toBe(1);
  },
);

test("an unavailable session runtime leaves an independently created public brief untouched", async () => {
  const input = { ...f.input, brief, template: "task" };
  const deps = unspawnableTern(f, () => {
    writeFileSync(brief, "Independent output", { flag: "wx" });
  });

  await expect(launchLane(deps, input)).rejects.toThrow("session create failed");
  expect(readFileSync(brief, "utf8")).toBe("Independent output");
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  expect(await deps.registry.read(input.key)).toBeNull();
});

const fileSymlinksAvailable = (() => {
  if (process.platform !== "win32") return true;
  const state = withState();
  try {
    const target = join(state.dir, "target");
    writeFileSync(target, "");
    symlinkSync(target, join(state.dir, "link"), "file");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  } finally {
    state.done();
  }
})();

test.skipIf(!fileSymlinksAvailable)(
  "a link inserted during native reservation is not overwritten or removed",
  async () => {
    const original = readFileSync(f.input.brief, "utf8");
    const input = { ...f.input, brief, template: "task" };
    duringCreate(() => symlinkSync(f.input.brief, brief));

    await expect(launchLane(f.deps, input)).rejects.toThrow("generated brief not published");
    expect(lstatSync(brief).isSymbolicLink()).toBe(true);
    expect(readFileSync(f.input.brief, "utf8")).toBe(original);
    expect(readFileSync(retainedBrief(), "utf8")).toContain("Preserve the rendered instructions.");
    expect(await f.deps.registry.read(input.key)).toBeNull();
    expect(f.world.calls).toContainEqual(["headless", "close", sid(1)]);
  },
);
