# Shared locks and lane priority

Some work can run only one at a time on a host: a rate-limited account, a slow build, a single device. `dori harness lock` runs one command at a time per lock name, in the order the lanes' priorities set.

```
dori harness lock <name> --lane K [--priority 1-9] -- CMD [ARG ...]
dori harness lock <name> --list
dori harness start <key> --brief FILE [--priority 1-9]
dori harness priority <key> <1-9>
```

## Turn order

Each waiter writes a ticket `state/locks/<name>/<id>.json` under `DORI_HOME` with its lane, pid, arrival time and priority. The head of the line is the lowest priority number (1 first, 9 last), then the earliest arrival, so a p1 that arrives after two p5 waiters goes next, and the two p5 waiters follow in arrival order. Only the head tries to take the lock; every waiter checks again every 2 seconds.

The priority of a turn is `--priority`, else the lane's recorded priority (`start --priority`, `priority <key> N`, or the backlog item's priority when the hourly loop opened the lane), else 5. A value outside 1-9 is refused.

## The lock itself

The lock is the directory `state/<name>.lock`, created with `mkdir`, with an `owner` line `<lane> <YYYY-MM-DD HH:MM:SS> pid=<pid>` in local time. This is the same directory and owner line a shell `mkdir` lock uses, so a shell waiter of the same name and `dori harness lock` exclude each other. A shell waiter does not take a ticket: it may win a free lock between two queued turns, and it is never turned away.

A lock whose owner pid is dead, or a lock directory older than 60 seconds with no owner line, is cleared and the clearing is logged. The holder's command runs with the terminal's stdin, stdout and stderr; `lock` exits with its exit code and prints its own `LOCK` lines to stderr. SIGTERM or SIGINT while waiting withdraws the ticket and exits 128 + the signal without running the command; while the command runs, the signal goes to the command and the lock is released when it exits.

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
