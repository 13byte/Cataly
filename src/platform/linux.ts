// Linux: every process fact comes from /proc, SIGTERM goes through a pidfd so a reused pid cannot be retargeted, and
// the filesystem is POSIX. Nothing here runs on another host.
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { dlopen } from "bun:ffi";
import type { ProcStat } from "../update/proc.ts";
import type { PlatformAdapter } from "./adapter.ts";
import { liveOwnerStart, memoryFreePct, syncDirectory } from "./shared.ts";

const statFields = (pid: number): string[] => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
};

/** A failure of the binding itself, kept apart from a missing libc so the two keep their distinct messages. */
class SignalFailed extends Error {}

/** Open a pidfd for this pid, signal through it and close it; the binding is what keeps a reused pid out of reach. */
function signalThroughPidfd(pid: number): void {
  try {
    const native = dlopen("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
    } as const);
    const fd = native.symbols.pidfd_open(pid, 0);
    try {
      if (fd < 0) throw new SignalFailed("native pidfd identity binding failed");
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

export const linux: PlatformAdapter = {
  os: "linux",

  memFreePct: memoryFreePct,

  procStat(pid: number): ProcStat {
    const fields = statFields(pid);
    return {
      zombie: fields[0] === "Z",
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      tpgid: Number(fields[5]),
      startTicks: fields[19] ?? "",
    };
  },

  cmdline(pid: number): string {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  },

  exePath(pid: number): string {
    return `/proc/${pid}/exe`;
  },

  cwdPath(pid: number): string {
    return `/proc/${pid}/cwd`;
  },

  children(pid: number): number[] {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  },

  bootId(): string {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  },

  liveOwnerStart,

  terminate(pid: number): void {
    signalThroughPidfd(pid);
  },

  supportsProcessReaders: true,
  posixOwnership: true,
  directoryFsync: true,
  syncDirectory,

  defaultRuntime: () => "herdr",

  supportsReleaseProfile: (platform, arch, runtime) => platform === "linux" && arch === "x64" && runtime === "herdr",

  nativeCacheLabel: () => `native-linux-${process.arch}`,
  programName: (word) => word.split("/").at(-1) ?? "",
  isAbsolutePath: isAbsolute,
  pathSeparators: /\//,
};
