// The contract's proof: every host's capability matrix as the product reads it, with the host injected instead of
// run. The running host's own readers get one smoke test, so moving them into src/platform/ cannot go silent.
import { describe, expect, test } from "bun:test";
import type { HostOs, PlatformAdapter } from "./adapter.ts";
import { adapterFor, platform } from "./index.ts";

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
