import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shq } from "../src/delivery.ts";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
const path = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = path;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Each hash-object process records its slice and output. The first two meet at a FIFO, so a single serial
// batch can never pass; the watchdog only bounds that failure instead of hanging the synchronous check.
const recorder = (record: string, git: string): string => {
  const [dir, real] = [shq(record), shq(git)];
  return `#!/bin/sh
case " $* " in *" hash-object "*) ;; *) exec ${real} "$@" ;; esac
job=$(mktemp -d ${dir}/job.XXXXXX)
cat >"$job/in"
if mkdir ${dir}/first 2>/dev/null; then
  ( sleep 20 & s=$!; trap 'kill $s; exit 0' TERM; wait $s; kill $$ ) >/dev/null 2>&1 &
  watchdog=$!
  read go <${dir}/fifo
  kill "$watchdog"
elif mkdir ${dir}/second 2>/dev/null; then
  echo go >${dir}/fifo
fi
${real} "$@" <"$job/in" >"$job/out" || exit 1
cat "$job/out"
`;
};

test("tracked content hashes run as concurrent slices that reproduce the serial batch byte for byte", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-source-hash-test-")));
  roots.push(root);
  const upstream = join(root, "upstream");
  const f = overlayFixture(join(root, "bundle"), upstream, false, "reviewed-overlay", (put) => {
    for (let at = 0; at < 1100; at++)
      put(`src/d${at % 9}/f${at}.${at % 50 ? "ts" : "cmd"}`, `export const v${at} = ${at};\n`, at % 101 === 0);
    symlinkSync("d1", join(upstream, "src/linked"));
  });
  const target = join(root, "installed");
  await provisionSourceOverlay(f.source, root, target, f.checkout);
  const regular = fixtureGit(target, "ls-files", "--stage")
    .split("\n")
    .filter((line) => !line.startsWith("120000"))
    .map((line) => line.slice(line.indexOf("\t") + 1));
  expect(regular.length).toBeGreaterThan(1100);
  const input = `${regular.join("\n")}\n`;
  const serial = Bun.spawnSync(["git", "hash-object", "--stdin-paths"], {
    cwd: target,
    env: { PATH: path, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdin: Buffer.from(input),
  }).stdout.toString();
  expect(serial.split("\n").filter(Boolean)).toHaveLength(regular.length);

  const record = join(root, "record");
  const fake = join(root, "fake-bin");
  mkdirSync(record);
  mkdirSync(fake);
  Bun.spawnSync(["mkfifo", join(record, "fifo")]);
  writeFileSync(join(fake, "git"), recorder(record, Bun.which("git")!));
  chmodSync(join(fake, "git"), 0o755);
  process.env["PATH"] = `${fake}:${path}`;
  assertSourceBundle(target, readSourceBundle(f.source), root);
  process.env["PATH"] = path;

  const jobs = readdirSync(record)
    .filter((name) => name.startsWith("job."))
    .map((name) => ({
      input: readFileSync(join(record, name, "in"), "utf8"),
      output: readFileSync(join(record, name, "out"), "utf8"),
    }))
    .sort((a, b) => regular.indexOf(a.input.split("\n")[0]!) - regular.indexOf(b.input.split("\n")[0]!));
  expect(jobs.length).toBeGreaterThan(1);
  expect(jobs.map((job) => job.input).join("")).toBe(input);
  expect(jobs.map((job) => job.output).join("")).toBe(serial);

  // Content drift hidden from Git's stat view is still found in the last slice.
  const last = regular.at(-1)!;
  fixtureGit(target, "update-index", "--assume-unchanged", last);
  writeFileSync(join(target, last), "owner edit\n");
  expect(() => assertSourceBundle(target, readSourceBundle(f.source), root)).toThrow("tracked content differs");
}, 30_000);
