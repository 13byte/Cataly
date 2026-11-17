import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportNativeCache } from "../src/release/native-cache.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// What the report cannot confirm unused it reports as a use: a reference of any size and a source lock it cannot read.

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
  // Each identity's own source is gone, so only the reference under test can name it.
  const native = (name: string) => {
    const f = overlayFixture(join(root, `source-${name}`), join(root, `upstream-${name}`), true, name);
    const receipt = nativeCacheFixture(f.source, home, f.checkout);
    rmSync(f.source, { recursive: true });
    return receipt;
  };
  const reasons = () =>
    Object.fromEntries(reportNativeCache(home, [], [refs]).map((entry) => [entry.directory, entry.protectedBy]));
  return { root, refs, native, reasons };
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
  const reasons = c.reasons();
  expect(reasons[direct.directory]).toEqual([`reference ${join(c.refs, "release.json")}`]);
  expect(reasons[linked.directory]).toEqual([`reference ${join(c.refs, "linked.json")}`]);
  expect(reasons[free.directory]).toEqual([]);
});

test("a linked directory whose source lock cannot be read is reported against every identity", () => {
  const c = cache();
  const wrapped = c.native("wrapped");
  const outside = join(c.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "omp"), `#!/bin/sh\nexec ${wrapped.omp} "$@"\n`);
  writeFileSync(join(outside, "native-omp.lock"), "{}");
  symlinkSync(outside, join(c.refs, "wrappers"));
  expect(c.reasons()[wrapped.directory]).toEqual([`unreadable source lock ${join(c.refs, "wrappers")}`]);
});
