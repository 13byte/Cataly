import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { leaseNativeIdentity } from "../src/release/native-cache-lease.ts";
import type { processCwds } from "../src/release/process-cwd.ts";
import { keptFor, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { ownProcessCwds } from "./source-bundle-setup.ts";

// What happens between a prune's looks: writers, other prunes, errors and copies an earlier prune left behind.

afterEach(removePruneFixtures);

/** The fixture's reader, with `hook(n)` run at the n-th process scan: 1 is the first look, 2 the look after detaching. */
const scans = (hook: (scan: number) => void): typeof processCwds => {
  let scan = 0;
  return (pids) => {
    hook(++scan);
    return ownProcessCwds(pids);
  };
};
/** A writer from this release: it leases, sees the prune holding the lock (no wait here) and publishes only after. */
const leaseDuringPrune = (home: string, identity: string) => {
  expect(() => leaseNativeIdentity(home, identity, process.pid, 0)).toThrow("A native cache prune");
};

test("a prune removes only what nothing uses and says why each other identity is kept", () => {
  const c = pruneFixture();
  const free = c.native("free");
  const used = c.native("used");
  writeFileSync(join(c.refs, "omp"), c.wrapper(used.omp));
  const result = c.prune();
  expect(result.removed).toEqual([
    expect.objectContaining({ directory: free.directory, identity: free.identity, why: "nothing uses it" }),
  ]);
  expect(result.removed[0]!.bytes).toBeGreaterThan(0);
  expect(keptFor(result, used.directory)).toEqual([`reference ${join(c.refs, "omp")}`]);
  expect(existsSync(free.directory)).toBe(false);
  expect(existsSync(`${free.directory}.pruning`) || existsSync(`${free.directory}.deleting`)).toBe(false);
  expect(existsSync(used.omp)).toBe(true);
});

test.each([1, 2])(
  "A9/B7 a writer that leases during look %i keeps its identity for the reference it publishes",
  (at) => {
    const c = pruneFixture();
    const x = c.native("x");
    const result = c.prune({ readCwds: scans((scan) => scan === at && leaseDuringPrune(c.home, x.identity)) });
    // The writer waited for the lock and publishes now; the identity it leased is still there.
    writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
    expect(result.removed).toEqual([]);
    expect(keptFor(result, x.directory)).toContain(`lease of process ${process.pid}`);
    expect(existsSync(x.omp)).toBe(true);
  },
);

test("B8/P3 a second prune while one runs is refused and cannot take the first one's detached copy", () => {
  const c = pruneFixture();
  const x = c.native("x");
  let inner: unknown;
  const result = c.prune({
    readCwds: scans((scan) => {
      // A reference lands after the first look; another prune starts during the second.
      if (scan === 1) writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
      if (scan === 2)
        try {
          c.prune();
        } catch (error) {
          inner = error;
        }
    }),
  });
  expect(String(inner)).toContain("Another native cache prune holds");
  expect(keptFor(result, x.directory)).toEqual([`reference ${join(c.refs, "omp")}`]);
  expect(existsSync(x.omp)).toBe(true);
  expect(existsSync(`${x.directory}.pruning`)).toBe(false);
});

test("B8 a prune in another process while one runs is refused", () => {
  const c = pruneFixture();
  const x = c.native("x");
  const module = resolve(import.meta.dir, "../src/release/native-cache-prune.ts");
  const code = `const { pruneNativeCache } = await import(${JSON.stringify(module)}); pruneNativeCache(process.argv[1], [], [process.argv[2]], { table: () => "" });`;
  let child: { exitCode: number | null; stderr: string } | undefined;
  c.prune({
    readCwds: scans((scan) => {
      if (scan !== 2) return;
      leaseDuringPrune(c.home, x.identity);
      writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
      const run = Bun.spawnSync([process.execPath, "-e", code, c.home, c.refs], { stdout: "pipe", stderr: "pipe" });
      child = { exitCode: run.exitCode, stderr: run.stderr.toString() };
    }),
  });
  expect(child?.exitCode).not.toBe(0);
  expect(child?.stderr).toContain("Another native cache prune holds");
  expect(existsSync(x.omp)).toBe(true);
});

test("B9 an error after detaching puts every identity back and leaves no copy for a later prune", () => {
  const c = pruneFixture();
  const x = c.native("x");
  const failing = scans((scan) => {
    if (scan === 2) throw new Error("process scan unavailable");
  });
  expect(() => c.prune({ readCwds: failing })).toThrow("process scan unavailable");
  expect(existsSync(x.omp)).toBe(true);
  expect(existsSync(`${x.directory}.pruning`)).toBe(false);
});

test("B9 a reference unreadable at the second look holds; once readable it keeps the identity", () => {
  if (process.getuid?.() === 0) return;
  const c = pruneFixture();
  const x = c.native("x");
  const reference = join(c.refs, "private");
  const arrange = scans((scan) => {
    if (scan !== 1) return;
    writeFileSync(reference, x.omp);
    chmodSync(reference, 0);
  });
  try {
    expect(() => c.prune({ readCwds: arrange })).toThrow("EACCES");
  } finally {
    chmodSync(reference, 0o600);
  }
  expect(existsSync(`${x.directory}.pruning`)).toBe(false);
  expect(keptFor(c.prune(), x.directory)).toEqual([`reference ${reference}`]);
  expect(existsSync(x.omp)).toBe(true);
});

test("P4 a copy an earlier prune left detached is never removed while its live name exists", () => {
  const c = pruneFixture();
  const x = c.native("x");
  cpSync(x.directory, `${x.directory}.pruning`, { recursive: true });
  const note = scans((scan) => scan === 1 && writeFileSync(join(c.refs, "note"), `${x.directory}.pruning/bin/omp\n`));
  const result = c.prune({ readCwds: note });
  expect(keptFor(result, `${x.directory}.pruning`)?.[0]).toContain("its live name exists again");
  expect(existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
  expect(existsSync(x.omp)).toBe(true);
});

test("a copy an interrupted prune left detached goes back and is judged like any identity", () => {
  const c = pruneFixture();
  const x = c.native("x");
  renameSync(x.directory, `${x.directory}.pruning`);
  writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
  const result = c.prune();
  expect(keptFor(result, x.directory)).toEqual([`reference ${join(c.refs, "omp")}`]);
  expect(existsSync(x.omp)).toBe(true);
  expect(existsSync(`${x.directory}.pruning`)).toBe(false);
});

test.each([1, 2])(
  "P6 a live name made again while detached keeps the copy, then and later (writer at look %i)",
  (at) => {
    const c = pruneFixture();
    const x = c.native("x");
    const arrange = scans((scan) => {
      // Before the last look a reference alone is seen; at it, only a writer's lease can be.
      if (scan === 2 && at === 2) leaseDuringPrune(c.home, x.identity);
      if (scan === at) writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
      // An older launcher prepares the live name again while the copy is detached.
      if (scan === 2) mkdirSync(x.directory);
    });
    const first = c.prune({ readCwds: arrange });
    expect(keptFor(first, `${x.directory}.pruning`)).toContain(
      at === 1 ? `reference ${join(c.refs, "omp")}` : `lease of process ${process.pid}`,
    );
    const second = c.prune();
    expect(keptFor(second, `${x.directory}.pruning`)?.[0]).toContain("its live name exists again");
    expect(existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
  },
);

test("a removal an interrupted prune had decided (.deleting) is finished", () => {
  const c = pruneFixture();
  const x = c.native("x");
  renameSync(x.directory, `${x.directory}.deleting`);
  const result = c.prune();
  expect(result.removed).toEqual([
    expect.objectContaining({ directory: x.directory, why: "an interrupted prune had decided to remove it" }),
  ]);
  expect(existsSync(`${x.directory}.deleting`)).toBe(false);
});

test("a running Dori writer for this cache or an older writer's preparation keeps every identity", () => {
  const c = pruneFixture();
  const x = c.native("x");
  const uid = process.getuid?.() ?? 0;
  // An older checkout's launcher for this home; one for another home works on another cache.
  const writer = `bun /old/scripts/source-dependencies.ts assert-native /old ${c.home}`;
  const other = `bun /old/scripts/source-dependencies.ts native /old ${c.refs}`;
  const held = c.prune({ table: () => `4242 ${uid} ${writer}\n4343 ${uid} ${other}\n` });
  expect(keptFor(held, x.directory)).toEqual([`Dori cache writer process 4242 (${writer})`]);
  const stage = join(c.home, ".cache/omp-dori/native-stage-abc123");
  mkdirSync(stage);
  expect(keptFor(c.prune(), x.directory)).toEqual([`native preparation of an older writer ${stage}`]);
  expect(existsSync(x.omp)).toBe(true);
});
