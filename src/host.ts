import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import type { HostOs } from "./platform/adapter.ts";
import { platform } from "./platform/index.ts";

const sysctlMemoryLevel = (): string =>
  execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/** The one adapter that reads the kernel's available-memory level: src/platform/darwin.ts. Every other host rounds freemem. */
const KERNEL_LEVEL_OS: HostOs = "darwin";

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 *
 * The host decides which figure counts: src/platform/darwin.ts implements the same policy, and this reading of the
 * host is the same one the adapter selected. The reader and the fallback stay parameters so a test can force either
 * policy without a real sysctl.
 */
export function memFreePct(
  os: string = platform.os,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (os === KERNEL_LEVEL_OS) {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}
