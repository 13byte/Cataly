# Lane done protocol

Give this file to every lane you launch.

Claiming Done can cause the watcher to close your tab and remove your worktrees. Claim only when the owner has authorized that cleanup, your `Done =` signals read back live, and your worktrees contain no uncommitted or unpushed work. The signals might be a PR merged, an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). If cleanup is not authorized or work must be kept, report the result without claiming Done; authorized parking retains worktrees and does not produce a Done receipt.

```sh
dori claim-done <your-lane-key> --evidence "<merge SHA, closed issue, version, links>"
```

The key is in your brief's lane footer. If you leave it out, the lane registered for your pane is used.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted tracked changes, or commits that are on no remote.
4. Closing marks your thread done (when a thread hook is configured), closes your tab, and removes your worktrees.

Before using the separate manual `dori close` path, check each lane worktree for uncommitted changes and commits not on a remote. Manual close still checks Done signals, but does not run the watcher's unpushed-work preflight.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.
