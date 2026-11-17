import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NativeCachePrune, pruneNativeCache } from "../src/release/native-cache.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// What a prune cannot confirm unused it keeps: a reference of any size, a source lock it cannot read, and a reference
// published while it runs.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cache() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-hold-")));
  roots.push(root);
  const home = join(root, "home");
  const refs = join(root, "refs");
  mkdirSync(refs);
  // Each identity's own source is gone, so only the reference under test can keep it.
  const native = (name: string) => {
    const f = overlayFixture(join(root, `source-${name}`), join(root, `upstream-${name}`), true, name);
    const receipt = nativeCacheFixture(f.source, home, f.checkout);
    rmSync(f.source, { recursive: true });
    return receipt;
  };
  const reasons = (result: NativeCachePrune) =>
    Object.fromEntries(result.entries.map((entry) => [entry.directory, entry.protectedBy]));
  return { root, home, refs, native, reasons };
}

test("a reference file larger than any limit is read whole, directly or behind a link", () => {
  const c = cache();
  const direct = c.native("direct");
  const linked = c.native("linked");
  const free = c.native("free");
  // The name sits past the first MiB, so a reader that stops early misses it.
  const big = (omp: string) => `${" ".repeat(1024 * 1024 + 17)}${JSON.stringify({ omp })}\n`;
  writeFileSync(join(c.refs, "release.json"), big(direct.omp));
  const outside = join(c.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "release.json"), big(linked.omp));
  symlinkSync(join(outside, "release.json"), join(c.refs, "linked.json"));
  const result = pruneNativeCache(c.home, [], [c.refs], true);
  expect(c.reasons(result)[direct.directory]).toEqual([`reference ${join(c.refs, "release.json")}`]);
  expect(c.reasons(result)[linked.directory]).toEqual([`reference ${join(c.refs, "linked.json")}`]);
  expect(result.removed).toEqual([free.directory]);
  expect(existsSync(direct.omp) && existsSync(linked.omp)).toBe(true);
});

test("a linked directory whose source lock cannot be read keeps every identity", () => {
  const c = cache();
  const wrapped = c.native("wrapped");
  const outside = join(c.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "omp"), `#!/bin/sh\nexec ${wrapped.omp} "$@"\n`);
  writeFileSync(join(outside, "native-omp.lock"), "{}");
  symlinkSync(outside, join(c.refs, "wrappers"));
  const result = pruneNativeCache(c.home, [], [c.refs], true);
  expect(c.reasons(result)[wrapped.directory]).toEqual([`unreadable source lock ${join(c.refs, "wrappers")}`]);
  expect(result.removed).toEqual([]);
  expect(existsSync(wrapped.omp)).toBe(true);
});

test("a reference published after the scan is seen before anything is removed, and the identity is restored", () => {
  const c = cache();
  const late = c.native("late");
  const free = c.native("free");
  let scans = 0;
  // The wrapper appears once the first scan has read the roots, while it reads the process table.
  const readCwds = () => {
    if (++scans === 1) writeFileSync(join(c.refs, "omp"), `#!/bin/sh\nexec ${late.omp} "$@"\n`);
    return new Map([["1", "/"]]);
  };
  const result = pruneNativeCache(c.home, [], [c.refs], true, readCwds);
  expect(c.reasons(result)[late.directory]).toEqual([]);
  expect(result.removed).toEqual([free.directory]);
  expect(existsSync(late.omp)).toBe(true);
  expect(existsSync(`${late.directory}.pruning`)).toBe(false);
  expect(existsSync(free.directory) || existsSync(`${free.directory}.pruning`)).toBe(false);
});
