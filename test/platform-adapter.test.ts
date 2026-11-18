// The contract's proof: every host's capability matrix as the product reads it, with the host injected instead of
// run. The running host's own readers get one smoke test, so moving them into src/platform/ cannot go silent.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import type { HostOs, PlatformAdapter } from "../src/platform/adapter.ts";
import { adapterFor, platform } from "../src/platform/index.ts";
import { linuxAdapter } from "../src/platform/linux.ts";

/** A /proc fixture: one pid with its stat and two task child lists, plus the boot id a signal identity names. */
function fixtureProc(startTicks: string): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "platform-proc-"));
  mkdirSync(join(root, "4242", "task", "4242"), { recursive: true });
  mkdirSync(join(root, "4242", "task", "4243"), { recursive: true });
  mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
  // state, ppid, pgid, then padding up to the start time at index 19; further fields trail it as a real stat does.
  const fields = [
    "S",
    "1",
    "4242",
    ...Array.from({ length: 16 }, () => "0"),
    startTicks,
    ...Array.from({ length: 32 }, () => "0"),
  ];
  writeFileSync(join(root, "4242", "stat"), `4242 (bun) ${fields.join(" ")}\n`);
  writeFileSync(join(root, "4242", "task", "4242", "children"), "7 8\n");
  writeFileSync(join(root, "4242", "task", "4243", "children"), "9\n");
  writeFileSync(join(root, "sys/kernel/random/boot_id"), "boot-1\n");
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const fake: PlatformAdapter = {
  os: "linux",
  memFreePct: () => 100,
  procStat: () => ({ zombie: false, ppid: 1, pgid: 1, tpgid: -1, startTicks: "1" }),
  cmdline: () => "bun\0",
  exePath: () => "/bin/bun",
  cwdPath: () => "/",
  children: () => [],
  bootId: () => "boot",
  liveOwnerStart: () => "",
  terminate: () => {},
  supportsProcessReaders: true,
  posixOwnership: true,
  directoryFsync: true,
  supportsHerdrNativeUi: true,
  syncDirectory: () => {},
  defaultRuntime: () => "herdr",
  supportsReleaseProfile: () => false,
  nativeCacheLabel: () => "native-linux-x64",
  programName: (word) => word,
  isAbsolutePath: () => false,
  pathSeparators: /\//,
};

describe("platform adapter contract", () => {
  test("a hand-written adapter satisfies every member", () => {
    expect(fake.os).toBe("linux");
    expect(fake.procStat(1).startTicks).toBe("1");
    expect(fake.children(1)).toEqual([]);
  });

  test("the adapter is the one chosen for this process's platform", () => {
    expect<HostOs>(platform.os).toBe(process.platform as HostOs);
    expect(adapterFor(platform.os)).toBe(platform);
  });

  test("the adapter is created once instead of re-reading the platform", () => {
    expect(platform === platform).toBe(true);
    expect(platform).toBe(platform);
  });
});

describe("capability matrix", () => {
  test("Windows has no POSIX ownership", () => {
    expect(adapterFor("win32").posixOwnership).toBe(false);
  });

  test("macOS defaults to the hc runtime", () => {
    expect(adapterFor("darwin").defaultRuntime()).toBe("hc");
  });

  test("Linux defaults to the herdr runtime", () => {
    expect(adapterFor("linux").defaultRuntime()).toBe("herdr");
  });

  test("Windows strips .exe from a program word", () => {
    expect(adapterFor("win32").programName("C:\\a\\bun.exe")).toBe("bun");
  });

  test("Linux does not split a program word on backslashes", () => {
    expect(adapterFor("linux").programName("C:\\a\\bun.exe")).toBe("C:\\a\\bun.exe");
  });

  test("only Windows lacks process readers, and its readers say so", () => {
    expect(adapterFor("darwin").supportsProcessReaders).toBe(true);
    expect(adapterFor("linux").supportsProcessReaders).toBe(true);
    expect(adapterFor("win32").supportsProcessReaders).toBe(false);
    expect(() => adapterFor("win32").procStat(1)).toThrow("no process reader for win32");
    expect(() => adapterFor("win32").bootId()).toThrow("no process reader for win32");
  });

  test("only Windows skips the directory flush", () => {
    expect(adapterFor("win32").directoryFsync).toBe(false);
    expect(() => adapterFor("win32").syncDirectory("/tmp")).not.toThrow();
    expect(adapterFor("darwin").directoryFsync).toBe(true);
    expect(adapterFor("linux").directoryFsync).toBe(true);
  });

  test("release profiles are the ones provision.ts admitted", () => {
    expect(adapterFor("darwin").supportsReleaseProfile("darwin", "arm64", "hc")).toBe(true);
    expect(adapterFor("darwin").supportsReleaseProfile("linux", "x64", "herdr")).toBe(false);
    expect(adapterFor("linux").supportsReleaseProfile("linux", "x64", "herdr")).toBe(true);
    expect(adapterFor("linux").supportsReleaseProfile("linux", "arm64", "herdr")).toBe(false);
    expect(adapterFor("win32").supportsReleaseProfile("linux", "x64", "herdr")).toBe(false);
  });

  test("the native cache label keeps the native-<platform>-<arch> shape", () => {
    for (const os of ["darwin", "linux", "win32"] as const)
      expect(adapterFor(os).nativeCacheLabel()).toBe(`native-${os}-${process.arch}`);
  });

  test("only Linux opens the herdr native UI", () => {
    expect(adapterFor("linux").supportsHerdrNativeUi).toBe(true);
    expect(adapterFor("darwin").supportsHerdrNativeUi).toBe(false);
    expect(adapterFor("win32").supportsHerdrNativeUi).toBe(false);
  });

  test("the herdr deployment CLI carries nativeUi exactly where this host's adapter does", () => {
    const cli = herdrDeploymentCli(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect("nativeUi" in cli).toBe(platform.supportsHerdrNativeUi);
  });

  test("the every-thread flag reaches the Linux task walk", () => {
    const proc = fixtureProc("777");
    try {
      const adapter = linuxAdapter(proc.root);
      expect(adapter.children(4242).sort()).toEqual([7, 8]);
      expect(adapter.children(4242, true).sort()).toEqual([7, 8, 9]);
    } finally {
      proc.done();
    }
  });

  test("a Linux signal refuses an incarnation that no longer matches", () => {
    const proc = fixtureProc("777");
    try {
      const adapter = linuxAdapter(proc.root);
      expect(() => adapter.terminate(4242, { startTicks: "111", bootId: "boot-1" })).toThrow(
        "native pidfd identity binding failed",
      );
      expect(() => adapter.terminate(4242, { startTicks: "777", bootId: "other-boot" })).toThrow(
        "native pidfd identity binding failed",
      );
    } finally {
      proc.done();
    }
  });

  test("path separators follow the host", () => {
    expect(adapterFor("win32").pathSeparators.test("C:\\a")).toBe(true);
    expect(adapterFor("linux").pathSeparators.test("C:\\a")).toBe(false);
    expect(adapterFor("linux").isAbsolutePath("/a")).toBe(true);
  });
});

test.skipIf(!platform.supportsProcessReaders)("this host's process readers answer for a live process", () => {
  expect(platform.procStat(process.pid).ppid).toBeGreaterThan(0);
  expect(platform.bootId()).not.toBe("");
  expect(platform.cmdline(process.pid)).toContain("\0");
  expect(platform.exePath(process.pid)).not.toBe("");
  expect(platform.cwdPath(process.pid)).not.toBe("");
  expect(platform.liveOwnerStart(process.pid)).not.toBe("");
  expect(platform.memFreePct()).toBeGreaterThanOrEqual(0);
});
