# Platform behaviour: one adapter per host

**Every OS-dependent decision the product makes is named in `src/platform/adapter.ts` and implemented once per OS.** `src/platform/darwin.ts`, `src/platform/linux.ts` and `src/platform/windows.ts` carry today's behaviour without changing it; `src/platform/shared.ts` holds the readers whose code does not vary between hosts. Callers import `platform` from `src/platform/index.ts` instead of testing `process.platform`.

## The contract

`PlatformAdapter` in `src/platform/adapter.ts` is the whole surface. One row per member, with what it decides and what each host answers.

| Member | What it decides | darwin | linux | win32 |
| --- | --- | --- | --- | --- |
| `os` | The host this implementation speaks for; it never answers for another OS | `"darwin"` | `"linux"` | `"win32"` |
| `memFreePct()` | Percent of memory available to start new work, as `src/host.ts` reports it | The kernel's `kern.memorystatus_level` from `sysctl`, rounded; `freemem()/totalmem()` when sysctl fails | `os.freemem()/os.totalmem()`, rounded | Same as Linux |
| `procStat(pid)` | One process's kernel facts (zombie, parent, group, foreground group, start time); throws `process <pid> status is unavailable` when the process is gone | `libproc` `proc_pidinfo(PROC_PIDTBSDINFO)`; the start time is seconds and microseconds | `/proc/<pid>/stat` | Throws `no process reader for win32` |
| `cmdline(pid)` | The argument vector with every argument NUL-terminated, as the OS cmdline holds it | `libproc` `KERN_PROCARGS2` through `sysctl`, rebuilt from `argc` | `/proc/<pid>/cmdline` | Throws `no process reader for win32` |
| `exePath(pid)` | A path that resolves to the executable image; throws when the process is gone | `libproc` `proc_pidpath` | `/proc/<pid>/exe` | Throws `no process reader for win32` |
| `cwdPath(pid)` | A path that resolves to the working directory; throws when the process is gone | `libproc` `proc_pidinfo(PROC_PIDVNODEPATHINFO)` | `/proc/<pid>/cwd` | Throws `no process reader for win32` |
| `children(pid, everyThread?)` | The process's direct children; `everyThread` widens the list where threads can spawn | `proc_listchildpids`; one list per process, so `everyThread` is ignored | Every task's `children` file with `everyThread`, otherwise only the main task's | Throws `no process reader for win32` |
| `bootId()` | One identifier per boot: a pid and start time are comparable only within it | `kern.bootsessionuuid` | `/proc/sys/kernel/random/boot_id` | Throws `no process reader for win32` |
| `liveOwnerStart(pid)` | The lock owner's start time exactly as `ps -o lstart=` prints it, or `""` when `ps` cannot report one | `ps -o lstart=` | `ps -o lstart=` | `""`, so a lock owner never counts as live |
| `terminate(pid, expected?)` | SIGTERM one pid through this OS's binding primitive; process-identity comparison stays with the caller | `kill(2)`; `ESRCH` reaches the caller, any other failure reads `checked native termination failed` | `pidfd_open` and `pidfd_send_signal`, re-checking the `expected` start time and boot id; a mismatch reads `native pidfd identity binding failed` | Throws `Linux libc pidfd_open and pidfd_send_signal are required for native replacement` |
| `supportsProcessReaders` | Whether `procStat`, `cmdline`, `exePath`, `cwdPath`, `children` and `bootId` read real kernel facts | `true` | `true` | `false` |
| `posixOwnership` | Whether file ownership is compared by uid, as `src/release/files.ts` `owned()` does | `true` | `true` | `false` |
| `directoryFsync` | Whether a directory can be opened and fsynced, as `src/update/deployment-files.ts` does | `true` | `true` | `false` |
| `supportsHerdrNativeUi` | Whether herdr's native UI path, reading a pane's screen and sending it keys, is open on this host | `false` | `true` | `false` |
| `syncDirectory(path)` | Flush a directory's own entries after a rename or link; a no-op where `directoryFsync` is false | Opens and fsyncs | Opens and fsyncs | No-op |
| `defaultRuntime()` | The runtime a fresh installation selects with none configured | `"hc"` | `"herdr"` | `"herdr"` |
| `supportsReleaseProfile(platform, arch, runtime)` | Whether a release built for that profile is admitted, as `src/release/provision.ts` prerequisites do | `darwin`/`arm64`/`hc` only | `linux`/`x64`/`herdr` only | Never |
| `nativeCacheLabel()` | The native build cache name, `native-<platform>-<arch>` | `native-darwin-<arch>` | `native-linux-<arch>` | `native-win32-<arch>` |
| `programName(word)` | A program word's name: its part after the last separator, on Windows without the `.exe` it runs as | Splits on `/` | Splits on `/` | Splits on `/[\\/]/` and strips a trailing `.exe` |
| `isAbsolutePath(path)` | `node:path.isAbsolute` for this host, as `src/release/cli.ts` tests `--home` and `DORI_HOME` | POSIX rules | POSIX rules | Windows rules |
| `pathSeparators` | The characters this OS splits a path on | `/\//` | `/\//` | `/[\\/]/` |

## Selecting the adapter

`src/platform/index.ts` chooses once, at import: `const platform` is the running host's adapter, chosen from `process.platform` at module load. Nothing re-reads the host afterwards, so a run cannot switch implementations, and a caller receives the same answers everywhere.

An unrecognised host still imports. It gets a fallback adapter whose process readers throw `no process reader for <platform>` at use, which is where `src/update/proc.ts` threw before, and whose remaining answers are the ones today's code gave an unrecognised POSIX host; Windows is the only host that answers otherwise.

Tests never run on another OS. `adapterFor(os)` returns the implementation for any of the three hosts, and `linuxAdapter(root)` points the `/proc` reads at a fixture instead of the kernel.

## What each OS may and may not assume

- **POSIX ownership is a darwin and linux assumption.** Comparing ownership by uid (`posixOwnership`) and the permission-bit checks built on it run only where the property is true; Windows code must not assume a uid or POSIX modes.
- **Directory fsync is conditional.** Open and fsync a directory only where `directoryFsync` is true, and call `syncDirectory` rather than the syscall; on Windows the flush is a no-op.
- **The herdr native UI is Linux-only.** `herdrDeploymentCli` in `src/update/deployment-cli.ts` attaches its `nativeUi` read and exit operations only where `supportsHerdrNativeUi` is true, so darwin and win32 deployments have no `nativeUi` key.
- **The default runtime differs.** A fresh installation on darwin selects `hc`; linux and win32 select `herdr`.
- **Only two release profiles are admitted.** `supportsReleaseProfile` accepts `linux`/`x64`/`herdr` and `darwin`/`arm64`/`hc`, and nothing on Windows. A host never admits another host's release.
- **Program names and paths follow the host.** `programName` strips a Windows `.exe` and splits on either separator, `isAbsolutePath` uses the host's `node:path` rules, and `pathSeparators` differs, so callers must take these from the adapter instead of assuming `/`.

## Not yet behind the adapter

`skills/dori-mode/scripts/src/**` is a separate package with its own `process.platform` checks, and `extension/index.ts` (the native OMP extension) still tests the host directly. Moving both behind this contract is a follow-up.
