import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStart } from "../src/release/process-cwd.ts";
import { bootId } from "../src/update/proc.ts";
import { keptFor, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";

afterEach(removePruneFixtures);

// A thread group whose leader exited still runs: what its other threads hold open or mapped keeps the entry (Astra,
// 35e104e). The program opens or maps a file whose path comes through the environment, from a working directory
// outside the cache, then its main thread leaves.
const THREAD = `import ctypes, mmap, os, sys, threading
fd = os.open(os.environ["TARGET"], os.O_RDONLY)
if os.environ["HOLD"] == "map":
  kept = mmap.mmap(fd, 0, prot=mmap.PROT_READ)
  os.close(fd)
def work():
  print("worker", flush=True)
  sys.stdin.readline()
threading.Thread(target=work).start()
ctypes.CDLL(None).pthread_exit(None)
`;
const threadHolder = async (cwd: string, target: string, hold: "open" | "map") => {
  const child = Bun.spawn(["python3", "-c", THREAD], {
    cwd,
    env: { PATH: process.env["PATH"], TARGET: target, HOLD: hold },
    stdin: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toBe("worker\n");
  // The leader is a zombie once it has left (a state in /proc, so polled for).
  while (readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z") await Bun.sleep(10);
  return child;
};

test.each(["open", "map"] as const)(
  "Astra (35e104e): a file an exited leader's thread keeps %s keeps the identity",
  async (hold) => {
    if (process.platform !== "linux") return;
    const c = pruneFixture();
    const x = c.native(hold);
    const child = await threadHolder(c.root, join(x.directory, "receipt.json"), hold);
    try {
      const result = c.prune();
      expect(result.quarantined).toEqual([]);
      expect(existsSync(x.omp)).toBe(true);
    } finally {
      child.stdin.end();
      await child.exited;
    }
  },
);

test("Astra (35e104e): a dead owner's stage stays while an exited leader's thread keeps a file in it open", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x");
  const ended = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
  const stage = join(c.home, ".cache/omp-dori", `native-stage-${x.identity}-${ended}-1-${bootId()}-AbC123`);
  mkdirSync(stage);
  writeFileSync(join(stage, "still-needed"), "payload");
  const child = await threadHolder(c.root, join(stage, "still-needed"), "open");
  try {
    c.prune();
    expect(existsSync(join(stage, "still-needed"))).toBe(true);
  } finally {
    child.stdin.end();
    await child.exited;
  }
});

test("a live process whose open files cannot be read keeps every identity, even when its working directory is read", () => {
  const c = pruneFixture();
  const x = c.native("x");
  const files = () => ({ files: new Map<string, string[]>(), unread: [String(process.pid)] });
  // This test process's own working directory is readable; only its files are reported unreadable here.
  const held = c.prune({ files });
  expect(keptFor(held, x.directory)?.[0]).toStartWith(`unreadable open files of process ${process.pid}@`);
  expect(c.prune({ files, trust: [`${process.pid}@${processStart(String(process.pid))}`] }).quarantined).toHaveLength(
    1,
  );
});
