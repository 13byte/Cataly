// Linux: every process fact comes from /proc, SIGTERM goes through a pidfd so a reused pid cannot be retargeted, and
// the filesystem is POSIX. The /proc root is a parameter so a fixture can stand in for the kernel in tests.
import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join } from "node:path";
import { dlopen } from "bun:ffi";
import type { ProcStat } from "../update/proc.ts";
import type { PlatformAdapter, TerminateIdentity } from "./adapter.ts";
import { liveOwnerStart, memoryFreePct, syncDirectory } from "./shared.ts";

const PROC = "/proc";

const bootId = (root: string): string => readFileSync(join(root, "sys/kernel/random/boot_id"), "utf8").trim();

const statFields = (root: string, pid: number): string[] => {
  const stat = readFileSync(join(root, String(pid), "stat"), "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
};

/** Whether this pid is still the incarnation the caller checked: same start time within the same boot. */
const sameIncarnation = (root: string, pid: number, expected: TerminateIdentity): boolean => {
  try {
    return statFields(root, pid)[19] === expected.startTicks && bootId(root) === expected.bootId;
  } catch {
    return false;
  }
};

/** A failure of the binding itself, kept apart from a missing libc so the two keep their distinct messages. */
class SignalFailed extends Error {}

/** Open a pidfd, prove it is the expected incarnation, signal through it and close it. */
function signalThroughPidfd(root: string, pid: number, expected: TerminateIdentity | undefined): void {
  // A pid that already differs is not ours to signal, which is how the caller settles it before binding.
  if (expected && !sameIncarnation(root, pid, expected)) throw new SignalFailed("native pidfd identity binding failed");
  try {
    const native = dlopen("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
    } as const);
    const fd = native.symbols.pidfd_open(pid, 0);
    try {
      if (fd < 0) throw new SignalFailed("native pidfd identity binding failed");
      // The fd binds one process; a pid reused between the check above and this open is refused here.
      if (expected && !sameIncarnation(root, pid, expected))
        throw new SignalFailed("native pidfd identity binding failed");
      if (native.symbols.pidfd_send_signal(fd, constants.signals.SIGTERM, null, 0) !== 0)
        throw new SignalFailed("bound native termination failed");
    } finally {
      if (fd >= 0) native.symbols.close(fd);
      native.close();
    }
  } catch (error) {
    if (error instanceof SignalFailed) throw error;
    throw new Error("Linux libc pidfd_open and pidfd_send_signal are required for native replacement");
  }
}

/** The Linux adapter over one /proc root: tests point the root at a fixture instead of the kernel's. */
export function linuxAdapter(root = PROC): PlatformAdapter {
  return {
    os: "linux",

    memFreePct: memoryFreePct,

    procStat(pid: number): ProcStat {
      const fields = statFields(root, pid);
      return {
        zombie: fields[0] === "Z",
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        tpgid: Number(fields[5]),
        startTicks: fields[19] ?? "",
      };
    },

    cmdline: (pid) => readFileSync(join(root, String(pid), "cmdline"), "utf8"),
    exePath: (pid) => join(root, String(pid), "exe"),
    cwdPath: (pid) => join(root, String(pid), "cwd"),

    children(pid: number, everyThread = false): number[] {
      const tasks = everyThread ? readdirSync(join(root, String(pid), "task")) : [String(pid)];
      return tasks.flatMap((task) =>
        readFileSync(join(root, String(pid), "task", task, "children"), "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      );
    },

    bootId: () => bootId(root),
    liveOwnerStart,
    terminate: (pid, expected) => signalThroughPidfd(root, pid, expected),

    supportsProcessReaders: true,
    posixOwnership: true,
    directoryFsync: true,
    supportsHerdrNativeUi: true,
    syncDirectory,

    defaultRuntime: () => "herdr",

    supportsReleaseProfile: (platform, arch, runtime) => platform === "linux" && arch === "x64" && runtime === "herdr",

    nativeCacheLabel: () => `native-linux-${process.arch}`,
    programName: (word) => word.split("/").at(-1) ?? "",
    isAbsolutePath: isAbsolute,
    pathSeparators: /\//,
  };
}

export const linux: PlatformAdapter = linuxAdapter();
