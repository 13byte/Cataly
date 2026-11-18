import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const TREES = ["src", "skills/dori-mode/scripts/src"];
// The skill CLI runs its command at import; it is an entry point, never imported.
const ENTRY_ONLY = new Set(["skills/dori-mode/scripts/src/cli.ts"]);

const modules = (): string[] =>
  TREES.flatMap((tree) =>
    [...new Glob("**/*.ts").scanSync({ cwd: join(ROOT, tree) })].map((file) => join(tree, file)),
  ).sort();

test("every module loads on its own in a fresh process", async () => {
  const files = modules().filter((file) => !ENTRY_ONLY.has(file));
  expect(files.length).toBeGreaterThan(50);
  const failures: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(join(ROOT, file))})`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0 || err.trim()) failures.push(`${file}: exit ${code} ${err.trim().split("\n")[0] ?? ""}`);
    }),
  );
  expect(failures).toEqual([]);
}, 60_000);
