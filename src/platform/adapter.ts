// The platform contract: every OS-dependent decision the product makes is named here and implemented once per OS.
// darwin.ts, linux.ts and windows.ts each carry today's behaviour; index.ts selects one adapter for the running host.
import type { ProcStat } from "../update/proc.ts";

export type HostOs = "darwin" | "linux" | "win32";

/**
 * The incarnation a bound signal may still belong to: the start time and boot id the caller checked. A pidfd binds a
 * process, and only these two facts say whether that process is still the one this caller meant.
 */
export type TerminateIdentity = { readonly startTicks: string; readonly bootId: string };

export interface PlatformAdapter {
  /** The host this implementation speaks for; it never answers for another OS. */
  readonly os: HostOs;

  /**
   * Percent of memory available to start new work, as src/host.ts reports it: macOS returns the kernel's own
   * available-memory level (kern.memorystatus_level, the figure behind Activity Monitor) and falls back to
   * freemem/totalmem when sysctl fails; every other host rounds os.freemem()/os.totalmem().
   */
  memFreePct(): number;

  /** One process's kernel facts; throws `process <pid> status is unavailable` when the process is gone. */
  procStat(pid: number): ProcStat;

  /** The argument vector with each argument NUL-terminated, as the OS cmdline holds it; throws when unreadable. */
  cmdline(pid: number): string;

  /** A path that opens, stats and resolves to the process's executable image; throws when the process is gone. */
  exePath(pid: number): string;

  /** A path that resolves to the process's working directory; throws when the process is gone. */
  cwdPath(pid: number): string;

  /**
   * Direct children of the process. Linux reads /proc/<pid>/task: with everyThread it concatenates every task's child
   * list (threads can spawn), without it only the main task's. macOS has one list per process and ignores the flag.
   */
  children(pid: number, everyThread?: boolean): number[];

  /** One identifier per boot: a PID and start time are only comparable within it; throws when unavailable. */
  bootId(): string;

  /**
   * The lock owner's start time exactly as `ps -o lstart=` prints it, in the reader's zone, or "" when ps cannot
   * report one (today's "not a live owner" answer). src/update/state.ts parses it with Date.parse and compares.
   */
  liveOwnerStart(pid: number): string;

  /**
   * SIGTERM one pid through this OS's binding primitive. Linux opens a pidfd and signals through it, refusing with
   * `native pidfd identity binding failed` when the supplied `expected` incarnation no longer matches; macOS has no
   * pidfd and sends kill(2), where ESRCH means the process is already gone and is not an error. Failures carry the
   * messages src/update/deployment-signal.ts printed; process-identity comparison stays with the caller, which
   * re-checks it after a failure.
   */
  terminate(pid: number, expected?: TerminateIdentity): void;

  /** True when procStat, cmdline, exePath, cwdPath, children and bootId read real kernel facts (Windows: false). */
  readonly supportsProcessReaders: boolean;

  /** True when file ownership is compared by uid, as src/release/files.ts owned() does (Windows: false). */
  readonly posixOwnership: boolean;

  /** True when a directory can be opened and fsynced, as src/update/deployment-files.ts does (Windows: false). */
  readonly directoryFsync: boolean;

  /** Flush a directory's own entries after a rename or link; a no-op where directoryFsync is false. */
  syncDirectory(path: string): void;

  /** The runtime a fresh installation selects with none configured: hc on macOS, herdr elsewhere. */
  defaultRuntime(): "herdr" | "hc";

  /**
   * Whether this host admits a release built for `platform`, `arch` and `runtime`, exactly as
   * src/release/provision.ts prerequisites do: linux/x64/herdr or darwin/arm64/hc, never another host's profile.
   */
  supportsReleaseProfile(platform: string, arch: string, runtime: string): boolean;

  /** The native build cache name, `native-<platform>-<arch>`, as src/release/native.ts builds it. */
  nativeCacheLabel(): string;

  /** A program word's name: its part after the last separator, on Windows without the `.exe` it runs as. */
  programName(word: string): string;

  /** node:path.isAbsolute for this OS, as src/release/cli.ts tests --home and DORI_HOME. */
  isAbsolutePath(path: string): boolean;

  /** The characters this OS splits a path on: /[\\/]/ on Windows, / elsewhere. */
  readonly pathSeparators: RegExp;
}
