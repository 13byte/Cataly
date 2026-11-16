import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pruneNativeCache } from "../src/release/native-cache.ts";
import { processCwds } from "../src/release/process-cwd.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cache() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-cache-")));
  roots.push(root);
  const home = join(root, "home");
  const native = (name: string, source = join(root, `source-${name}`)) => {
    const f = overlayFixture(source, join(root, `upstream-${name}`), true, name);
    return { source: f.source, receipt: nativeCacheFixture(f.source, home, f.checkout) };
  };
  return { root, home, native };
}

test("only an identity no source, reference or process names is pruned, and only when applied", async () => {
  const c = cache();
  const live = c.native("live");
  const releases = join(c.root, "dori/releases");
  const discovered = c.native("discovered", join(releases, "retained-release"));
  const wrapped = c.native("wrapped");
  const running = c.native("running");
  const superseded = c.native("superseded");
  for (const source of [wrapped.source, running.source, superseded.source]) rmSync(source, { recursive: true });
  mkdirSync(join(c.root, "dori/bin"), { recursive: true });
  writeFileSync(join(c.root, "dori/bin/omp"), `#!/bin/sh\nexec ${wrapped.receipt.omp} "$@"\n`);
  const unknown = join(c.home, ".cache/omp-dori", `native-${process.platform}-${process.arch}-${"e".repeat(64)}`);
  mkdirSync(unknown, { mode: 0o700 });
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line", "dori-native-holder", running.receipt.omp], {
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    // The holder has exec'd once it speaks, so its argv is the one the process table shows.
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    const sources = [live.source];
    const scanned = [join(c.root, "dori")];
    const dry = pruneNativeCache(c.home, sources, scanned, false);
    const reasons = Object.fromEntries(dry.entries.map((entry) => [entry.directory, entry.protectedBy]));
    expect(reasons[live.receipt.directory]).toEqual(
      expect.arrayContaining([`source ${live.source}`, "receipt source"]),
    );
    expect(reasons[discovered.receipt.directory]).toContain(`source ${discovered.source}`);
    expect(reasons[wrapped.receipt.directory]).toEqual([`reference ${join(c.root, "dori/bin/omp")}`]);
    // Only processes keep it, the holder among them (another process may work in that directory too).
    expect(reasons[running.receipt.directory]).toContain(`process ${holder.pid}`);
    expect(reasons[running.receipt.directory]?.every((reason) => reason.startsWith("process "))).toBe(true);
    expect(reasons[superseded.receipt.directory]).toEqual([]);
    expect(reasons[unknown]).toEqual(["unrecognized receipt"]);
    expect(dry.entries.find((entry) => entry.directory === superseded.receipt.directory)!.bytes).toBeGreaterThan(0);
    expect(dry.removed).toEqual([]);
    expect(existsSync(superseded.receipt.directory)).toBe(true);

    // An interrupted earlier prune left a detached copy that nothing can resolve.
    const leftover = `${live.receipt.directory}.pruning`;
    mkdirSync(leftover, { mode: 0o700 });
    const applied = pruneNativeCache(c.home, sources, scanned, true);
    expect(applied.removed.sort()).toEqual([superseded.receipt.directory, leftover].sort());
    for (const kept of [live, discovered, wrapped, running]) expect(existsSync(kept.receipt.omp)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(superseded.receipt.directory)).toBe(false);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(`${superseded.receipt.directory}.pruning`)).toBe(false);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

test("a link into the cache, a used detached copy and a partial receipt keep their identities", async () => {
  const c = cache();
  const linked = c.native("linked");
  const chained = c.native("chained");
  const partial = c.native("partial");
  const superseded = c.native("superseded");
  for (const f of [linked, chained, partial, superseded]) rmSync(f.source, { recursive: true });
  const bin = join(c.root, "dori/bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(linked.receipt.omp, join(bin, "omp"));
  // A chain whose first link names nothing in the cache still resolves into it.
  symlinkSync(chained.receipt.omp, join(c.root, "hop"));
  symlinkSync(join(c.root, "hop"), join(bin, "omp-side"));
  const { identity, source } = partial.receipt;
  writeFileSync(join(partial.receipt.directory, "receipt.json"), JSON.stringify({ identity, source }));
  // A process still runs from the copy an interrupted prune detached; the live entry beside it is unused.
  const detached = `${superseded.receipt.directory}.pruning`;
  mkdirSync(detached, { mode: 0o700 });
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line"], {
    cwd: detached,
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const applied = pruneNativeCache(c.home, [], [join(c.root, "dori")], true);
    const reasons = Object.fromEntries(applied.entries.map((entry) => [entry.directory, entry.protectedBy]));
    expect(reasons[linked.receipt.directory]).toEqual([`link ${join(bin, "omp")}`]);
    expect(reasons[chained.receipt.directory]).toEqual([`link ${join(bin, "omp-side")}`]);
    expect(reasons[partial.receipt.directory]).toEqual(["unrecognized receipt"]);
    expect(reasons[detached]).toContain(`process ${holder.pid}`);
    expect(reasons[superseded.receipt.directory]).toEqual([]);
    expect(applied.removed).toEqual([]);
    for (const kept of [linked, chained, partial, superseded]) expect(existsSync(kept.receipt.directory)).toBe(true);
    expect(existsSync(detached)).toBe(true);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

test("a link to a wrapper outside the roots keeps what it names; a link to an unscanned directory keeps everything", () => {
  const c = cache();
  const wrapped = c.native("wrapped");
  const free = c.native("free");
  for (const f of [wrapped, free]) rmSync(f.source, { recursive: true });
  const outside = join(c.root, "opt/wrappers");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "omp"), `#!/bin/sh\nexec ${wrapped.receipt.omp} "$@"\n`);
  const refs = join(c.root, "refs");
  mkdirSync(refs);
  symlinkSync(join(outside, "omp"), join(refs, "omp"));
  const report = (roots: string[]) =>
    Object.fromEntries(
      pruneNativeCache(c.home, [], roots, false).entries.map((entry) => [entry.directory, entry.protectedBy]),
    );
  const linked = report([refs]);
  expect(linked[wrapped.receipt.directory]).toEqual([`reference ${join(refs, "omp")}`]);
  expect(linked[free.receipt.directory]).toEqual([]);
  symlinkSync(outside, join(refs, "wrappers"));
  const held = `link to an unscanned directory ${join(refs, "wrappers")}`;
  expect(report([refs])[free.receipt.directory]).toEqual([held]);
  // Once that directory is scanned too, its link no longer holds anything.
  expect(report([refs, join(c.root, "opt")])[free.receipt.directory]).toEqual([]);
  // A reference root given as a link is read at its real path.
  symlinkSync(outside, join(c.root, "wrappers-alias"));
  expect(report([join(c.root, "wrappers-alias")])[wrapped.receipt.directory]).toEqual([
    `reference ${join(outside, "omp")}`,
  ]);
  expect(pruneNativeCache(c.home, [], [refs], true).removed).toEqual([]);
  expect(existsSync(free.receipt.directory)).toBe(true);
});

test.each(["linux", "darwin"] as const)("a process's working directory is read the %s way", async (platform) => {
  if (platform === "linux" && process.platform !== "linux") return;
  const c = cache();
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line"], { cwd: c.root, stdin: "pipe", stdout: "pipe" });
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    expect(processCwds([String(holder.pid)], platform)?.get(String(holder.pid))).toBe(realpathSync(c.root));
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

test("dori update cache reports by default and removes unreferenced identities only with --prune", () => {
  const c = cache();
  const superseded = c.native("superseded");
  renameSync(superseded.source, join(c.root, "moved-away"));
  const cli = resolve(import.meta.dir, "../src/release/cli.ts");
  const run = (...argv: string[]) =>
    Bun.spawnSync([process.execPath, cli, "cache", ...argv], {
      env: { HOME: c.home, PATH: process.env["PATH"], OMP_DORI_HOME: join(c.root, "side") },
    });
  const listed = run();
  expect(listed.exitCode).toBe(0);
  const report = JSON.parse(listed.stdout.toString());
  expect(report.pruned).toBe(false);
  expect(report.entries).toEqual([
    expect.objectContaining({ directory: superseded.receipt.directory, protectedBy: [] }),
  ]);
  expect(existsSync(superseded.receipt.directory)).toBe(true);
  expect(run("--from", c.root).exitCode).toBe(2);
  const pruned = run("--prune");
  expect(pruned.exitCode).toBe(0);
  expect(JSON.parse(pruned.stdout.toString()).removed).toEqual([superseded.receipt.directory]);
  expect(existsSync(superseded.receipt.directory)).toBe(false);
});
