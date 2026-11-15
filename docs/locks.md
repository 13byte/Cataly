# Shared locks and lane priority

Some work can run only one at a time on a host: a rate-limited account, a slow build, a single device. `dori harness lock` runs one command at a time per lock name, in the order the lanes' priorities set.

```
dori harness lock <name> --lane K [--priority 1-9] -- CMD [ARG ...]
dori harness lock <name> --list
dori harness start <key> --brief FILE [--priority 1-9]
dori harness priority <key> <1-9>
```

## Turn order

Each waiter writes a ticket `state/locks/<name>/<id>.json` under `DORI_HOME` with its lane, pid, arrival time, priority and place in line. The head of the line is the lowest priority number (1 first, 9 last), then the earliest place in line, so a p1 that arrives after two p5 waiters goes next, and the two p5 waiters follow in arrival order, even when they arrive in the same millisecond. Only the head tries to take the lock; every waiter checks again every 2 seconds.

Getting in line and taking the lock happen under the queue's guard file `state/locks/<name>/.guard`, one waiter at a time. A waiter's place is one past the highest place in line when it gets the guard. The head checks that it is still the head and takes the lock without letting the guard go, so a p1 that gets in line just as a p5 takes the lock is either in line before the p5 checks (and goes first) or comes after the p5 has the lock. A waiter that finds the guard held tries again on its next check.

The priority of a turn is `--priority`, else the lane's recorded priority (`start --priority`, `priority <key> N`, or the backlog item's priority when the hourly loop opened the lane), else 5. A value outside 1-9 is refused.

## The lock itself

The lock is the directory `state/<name>.lock`, created with `mkdir`, with an `owner` line `<lane> <YYYY-MM-DD HH:MM:SS> pid=<pid> cmd=<pid>` in local time: `pid` is the waiting `dori harness lock` process and `cmd` is its command. This is the same directory and owner line a shell `mkdir` lock uses (a shell lock has only `pid=`), so a shell waiter of the same name and `dori harness lock` exclude each other. A shell waiter does not take a ticket: it may win a free lock between two queued turns, and it is never turned away.

The command is started held, its pid is added to the owner line, and only then does it run. The lock stays held while any pid on the owner line is alive, so a `dori harness lock` killed with SIGKILL does not free the lock while its command still runs.

A lock whose every owner pid is dead, or a lock directory older than 60 seconds with no owner line, is cleared and the clearing is logged. The directory is removed in place, never moved: a waiter that judged it left behind first takes the claim file `state/<name>.lock.claim-<digest of the owner line>`, then removes the directory only if it still holds that same owner line. Waiters that judged the same dead owner need the same claim, so only one of them clears it, and a waiter that paused after reading the dead owner never removes a lock someone took meanwhile. The guard and claim files hold the pid of the process that made them; one whose pid is dead (or that has no pid and is older than 60 seconds) is taken over under its own claim, so a waiter killed while holding one does not block the line.

The holder's command runs with the terminal's stdin, stdout and stderr; `lock` exits with its exit code and prints its own `LOCK` lines to stderr. SIGTERM or SIGINT while waiting withdraws the ticket and exits 128 + the signal without running the command; while the command runs, the signal goes to the command and the lock is released when it exits.

## Seeing the line

`dori harness lock <name> --list` and the end of `dori harness status` print one line per lock that is held or has waiters, within 120 columns:

```
lock build: held by lane-a 12m (pid 4242) | queue: 1) lane-c p1 3m 2) lane-b p5 9m +2 more
```

Waiters that do not fit are counted in `+N more`. Tickets of dead waiters are removed when the line is read.

## Limits

- Locks are local to one host and one `DORI_HOME`.
- A ticket written by a waiter killed with SIGKILL stays until its pid is seen dead; a reused pid can keep it in line longer.
- Owner times are local wall-clock seconds, as a shell `date` writes them, so a clock change shifts the holder age that `--list` shows.
