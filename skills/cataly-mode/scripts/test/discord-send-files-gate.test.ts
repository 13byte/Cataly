import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ids } from "./discord-fakes.ts";
import { withFilesCli } from "./discord-files-fixture.ts";

const thread = ["send", "discord", "--thread", ids.thread];
const posix = test.skipIf(process.platform === "win32");
const refusal = (path: string, why: string) => `discord send: file ${JSON.stringify(path)}: ${why}`;
const NO_ROOT = "artifact requires an explicitly configured containing root";
const PROTECTED = "artifact has a hidden, sensitive or dependency path";
const TYPE = "artifact file type is not allowed";
const MIB = 1024 * 1024;
/**
 * A native sender is configured, so the gate is what refuses. The binary does not exist: a file the gate wrongly
 * admitted would fail to start it instead of printing the expected refusal.
 */
const gated = (stateDir: string) => ({ CATALY_DISCORD_NATIVE_BIN: join(stateDir, "never-started-native") });

test("without a configured artifact root every file is refused before any request", async () => {
  await withFilesCli(async (f) => {
    const chart = f.file("chart.png");
    for (const roots of [null, []]) {
      const r = await f.invoke([...thread, "--file", chart], { roots, environment: gated(f.stateDir) });
      expect([r.code, r.out, r.err, r.keys]).toEqual([1, "", refusal(chart, NO_ROOT), []]);
    }
  });
}, 60_000);

test.each([
  [".ssh/id_rsa", PROTECTED],
  ["ssh/id_rsa", TYPE],
  ["ssh/id_ed25519.pub", TYPE],
  ["ssh/id_rsa.txt.key", TYPE],
  [".dori/discord-token", PROTECTED],
  ["discord-token", PROTECTED],
  ["discord-token.txt", PROTECTED],
  ["notes/My-Secret-plan.md", PROTECTED],
  ["credentials.json", PROTECTED],
  ["private-key.txt", PROTECTED],
  [".env", PROTECTED],
  ["node_modules/pkg/index.js", PROTECTED],
  ["run.sh", TYPE],
])(
  "a credential, key, hidden or unlisted file is never attached, even inside a root: %s",
  async (name, why) => {
    await withFilesCli(async (f) => {
      const environment = gated(f.stateDir);
      const path = f.file(name);
      const alone = await f.invoke([...thread, "--file", path], { environment });
      expect([alone.code, alone.out, alone.err, alone.keys]).toEqual([1, "", refusal(path, why), []]);
      // One refused file stops the whole message: an allowed file beside it is not sent either.
      const mixed = await f.invoke([...thread, "--text", "report", "--file", f.file("chart.png"), "--file", path], {
        environment,
      });
      expect([mixed.code, mixed.out, mixed.err, mixed.keys]).toEqual([1, "", refusal(path, why), []]);
    });
  },
  60_000,
);

test("the bot token and SSH keys of the home directory cannot be attached, whatever the root", async () => {
  await withFilesCli(async (f) => {
    const environment = gated(f.stateDir);
    // The fixture's HOME is its state directory: these are ~/.dori/discord-token and ~/.ssh/id_rsa.
    const token = join(f.stateDir, ".dori", "discord-token");
    const key = join(f.stateDir, ".ssh", "id_rsa");
    for (const path of [token, key]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "synthetic credential\n");
    }
    const outside = join(f.stateDir, "outside.txt");
    writeFileSync(outside, "outside\n");
    const sibling = `${f.root}-sibling`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "report.txt"), "sibling\n");
    for (const path of [token, key, outside, join(f.root, "..", "outside.txt"), join(sibling, "report.txt")]) {
      const r = await f.invoke([...thread, "--file", path], { environment });
      expect([r.code, r.out, r.err, r.keys]).toEqual([1, "", refusal(path, NO_ROOT), []]);
    }
    // Even a root as wide as the home directory does not admit them.
    for (const path of [token, key]) {
      const r = await f.invoke([...thread, "--file", path], { environment, roots: [f.stateDir] });
      expect([r.code, r.out, r.err, r.keys]).toEqual([1, "", refusal(path, PROTECTED), []]);
    }
  });
}, 60_000);

// POSIX-only: symlinks and FIFOs.
posix(
  "a symlink cannot carry a file out of its root, and only regular files are admitted",
  async () => {
    await withFilesCli(async (f) => {
      const outside = join(f.stateDir, "outside.txt");
      writeFileSync(outside, "not for upload\n");
      const escape = join(f.root, "escape.txt");
      symlinkSync(outside, escape);
      const hidden = join(f.root, "hidden.txt");
      symlinkSync(f.file(".cache/report.txt"), hidden);
      const directory = join(f.root, "folder.txt");
      mkdirSync(directory);
      const fifo = join(f.root, "pipe.txt");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const missing = join(f.root, "missing.png");
      for (const [path, why] of [
        [escape, "artifact is outside its configured root"],
        [hidden, PROTECTED],
        [directory, "artifact must be a regular file"],
        [fifo, "artifact must be a regular file"],
        [missing, "artifact cannot be read or changed during inspection"],
      ] as const) {
        const r = await f.invoke([...thread, "--file", path], { environment: gated(f.stateDir) });
        expect([r.code, r.out, r.err, r.keys]).toEqual([1, "", refusal(path, why), []]);
      }
    });
  },
  60_000,
);

test("count and size limits are refused before any request", async () => {
  await withFilesCli(async (f) => {
    const environment = gated(f.stateDir);
    const sized = (name: string, bytes: number): string => {
      const path = f.file(name, "");
      truncateSync(path, bytes);
      return path;
    };
    const flags = (paths: readonly string[]): string[] => paths.flatMap((path) => ["--file", path]);
    const small = Array.from({ length: 11 }, (_, index) => f.file(`part-${index}.txt`, `part ${index}\n`));
    const many = await f.invoke([...thread, ...flags(small)], { environment });
    expect([many.code, many.out, many.err, many.keys]).toEqual([
      1,
      "",
      "discord send: one message carries at most 10 files, not 11",
      [],
    ]);
    const empty = sized("empty.txt", 0);
    // One byte over Discord's 20 MiB per file, and one byte over the 24 MiB that files may have together.
    const large = sized("large.mp4", 20 * MIB + 1);
    const full = sized("full.mp4", 20 * MIB);
    const beyond = sized("beyond.mp4", 4 * MIB + 1);
    for (const [paths, path, why] of [
      [[empty], empty, "the file is empty"],
      [[large], large, `${20 * MIB + 1} bytes exceed the ${20 * MIB}-byte limit per file`],
      [[small[0]!, large], large, `${20 * MIB + 1} bytes exceed the ${20 * MIB}-byte limit per file`],
      [[full, beyond], beyond, `the files exceed the ${24 * MIB}-byte limit per message`],
    ] as const) {
      const r = await f.invoke([...thread, ...flags(paths)], { environment });
      expect([r.code, r.out, r.err, r.keys]).toEqual([1, "", refusal(path, why), []]);
    }
  });
}, 120_000);
