import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportNativeCache } from "../src/release/native-cache.ts";
import { processCwds } from "../src/release/process-cwd.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a Linux process table whose working directories cannot be read is unavailable, not empty", () => {
  expect(processCwds(["999999999"], "linux")).toBeNull();
});

test("when no working directory can be read, the report says so for every identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-cwd-")));
  roots.push(root);
  const home = join(root, "home");
  const f = overlayFixture(join(root, "source"), join(root, "upstream"), true, "unused");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  rmSync(f.source, { recursive: true });

  const entries = reportNativeCache(home, [], [], () => null);

  expect(entries.map((entry) => [entry.directory, entry.protectedBy])).toEqual([
    [receipt.directory, ["process working directories unavailable"]],
  ]);
  expect(existsSync(receipt.directory)).toBe(true);
});
