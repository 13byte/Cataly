import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneNativeCache } from "../src/release/native-cache.ts";
import { processCwds } from "../src/release/process-cwd.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a Linux process table whose working directories cannot be read is unavailable, not empty", () => {
  expect(processCwds(["999999999"], "linux")).toBeNull();
});

test("when no working directory can be read, prune keeps every identity, live and detached", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-cwd-")));
  roots.push(root);
  const home = join(root, "home");
  const f = overlayFixture(join(root, "source"), join(root, "upstream"), true, "unused");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  rmSync(f.source, { recursive: true });
  const detached = `${receipt.directory}.pruning`;
  mkdirSync(detached, { mode: 0o700 });

  const applied = pruneNativeCache(home, [], [], true, () => null);

  const held = "process working directories unavailable";
  expect(applied.entries.map((entry) => [entry.directory, entry.protectedBy])).toEqual(
    expect.arrayContaining([
      [receipt.directory, [held]],
      [detached, [held]],
    ]),
  );
  expect(applied.removed).toEqual([]);
  expect(existsSync(receipt.directory) && existsSync(detached)).toBe(true);
});
