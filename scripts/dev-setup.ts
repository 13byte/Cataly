/**
 * `bun run dev:setup`: prepare this checkout the way CI's `.github/actions/setup` does with `fixtures: all`, including
 * its `cargo build --locked --release --bin cataly` of the native headless host, then write target/dev-env.sh (pinned
 * Bun first on PATH, CATALY_TEST_OMP_ROOT, CATALY_TEST_COMPAT_ULW_ENTRY, CATALY_DISCORD_NATIVE_BIN).
 *
 * The action's own `run:` scripts execute verbatim under the pinned Bun, umask 022 and a private /tmp TMPDIR, so the
 * installs, the native host version check and every fixture pin stay defined only in the action. Its `uses:` steps are
 * replaced by the Bun that package.json `packageManager` pins. A compatibility checkout already at the step's pin is
 * reused; every other step is idempotent and runs again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { ensurePinnedBun, pinnedBunVersion, requirePosix, runUnderPinnedBun, withPrivateTmp } from "./dev-bun.ts";

const ACTION = ".github/actions/setup/action.yml";
const COMPAT_ENV = "CATALY_TEST_COMPAT_ULW_ENTRY";
const REQUIRED_ENV = ["CATALY_TEST_OMP_ROOT", COMPAT_ENV, "CATALY_DISCORD_NATIVE_BIN"] as const;

interface Step {
  readonly name: string;
  readonly run: string;
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;

/** The action's shell steps for `fixtures: all`, in CI order. Unknown conditions or expressions fail closed. */
const actionSteps = (root: string, bunVersion: string): Step[] => {
  const steps = field(field(Bun.YAML.parse(readFileSync(join(root, ACTION), "utf8")), "runs"), "steps");
  if (!Array.isArray(steps)) throw new Error(`${ACTION} has no runs.steps`);
  const selected: Step[] = [];
  for (const step of steps) {
    const uses = field(step, "uses");
    if (typeof uses === "string") {
      const pinned = field(field(step, "with"), "bun-version");
      if (uses.startsWith("oven-sh/setup-bun@") && pinned !== bunVersion)
        throw new Error(`${ACTION} installs Bun ${String(pinned)} but package.json pins ${bunVersion}`);
      continue;
    }
    const name = field(step, "name");
    const run = field(step, "run");
    const condition = field(step, "if");
    if (typeof name !== "string" || typeof run !== "string" || field(step, "shell") !== "bash")
      throw new Error(`${ACTION}: unsupported step ${JSON.stringify(name)}`);
    if (condition !== undefined && !(typeof condition === "string" && condition.includes("inputs.fixtures == 'all'")))
      throw new Error(`${ACTION}: step ${JSON.stringify(name)} has an unsupported condition`);
    if (run.includes("${{")) throw new Error(`${ACTION}: step ${JSON.stringify(name)} uses an unsupported expression`);
    selected.push({ name, run });
  }
  return selected;
};

/** Plain `NAME=value` lines, the only GITHUB_ENV form the action writes. */
const readEnvFile = (file: string): Map<string, string> => {
  const env = new Map<string, string>();
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const at = line.indexOf("=");
    if (at <= 0 || line.slice(0, at).includes("<<")) throw new Error(`unsupported GITHUB_ENV line in ${file}`);
    env.set(line.slice(0, at), line.slice(at + 1));
  }
  return env;
};

const gitOutput = (dir: string, args: readonly string[]): string | undefined => {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
};

/** An earlier checkout is reused only at the step's exact pin with a clean worktree. */
const compatReady = (entry: string | undefined, pin: string): entry is string => {
  if (!entry || !existsSync(entry)) return false;
  const dir = dirname(entry);
  return gitOutput(dir, ["rev-parse", "HEAD"])?.trim() === pin && gitOutput(dir, ["status", "--porcelain"]) === "";
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const runSteps = async (root: string, bunVersion: string, fixtures: string): Promise<Map<string, string>> => {
  const runner = join(fixtures, "runner");
  const compatRunner = join(fixtures, "compat-runner");
  mkdirSync(runner, { recursive: true, mode: 0o700 });
  const recorded = join(fixtures, "github-env");
  const previous = readEnvFile(recorded);
  const githubEnv = `${recorded}.next`;
  writeFileSync(githubEnv, "");
  await withPrivateTmp("cataly-setup", async (tmp) => {
    for (const step of actionSteps(root, bunVersion)) {
      let runnerTemp = runner;
      if (step.run.includes(COMPAT_ENV)) {
        const pin = /^\s*pin=([0-9a-f]{40})\s*$/m.exec(step.run)?.[1];
        if (!pin) throw new Error(`${ACTION}: step ${JSON.stringify(step.name)} has no pin=<commit> line`);
        const entry = previous.get(COMPAT_ENV);
        if (compatReady(entry, pin)) {
          console.log(`dev:setup: ${step.name}: reusing ${dirname(entry)} at ${pin}`);
          appendFileSync(githubEnv, `${COMPAT_ENV}=${entry}\n`);
          continue;
        }
        // The step clones into a fixed $RUNNER_TEMP path; give it a fresh owned directory as on a new runner.
        rmSync(compatRunner, { recursive: true, force: true });
        mkdirSync(compatRunner, { mode: 0o700 });
        runnerTemp = compatRunner;
      }
      console.log(`dev:setup: ${step.name}`);
      // GitHub runs `shell: bash` steps as `bash --noprofile --norc -eo pipefail`, with earlier GITHUB_ENV exports.
      const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
        cwd: root,
        env: {
          ...process.env,
          ...Object.fromEntries(readEnvFile(githubEnv)),
          PATH: `${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`,
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: githubEnv,
          TMPDIR: tmp,
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (result.exitCode !== 0) throw new Error(`step failed: ${step.name} (exit ${result.exitCode})`);
    }
  });
  const env = readEnvFile(githubEnv);
  for (const name of REQUIRED_ENV)
    if (!env.get(name)) throw new Error(`${ACTION} did not export ${name} for fixtures: all`);
  renameSync(githubEnv, recorded);
  return env;
};

const writeDevEnv = (root: string, env: ReadonlyMap<string, string>): string => {
  const file = join(root, "target", "dev-env.sh");
  const content = [
    "# Generated by `bun run dev:setup`; do not edit. Source it to use CI's pinned Bun and test fixtures.",
    `export PATH=${shellQuote(dirname(process.execPath))}:"$PATH"`,
    ...[...env].map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    "",
  ].join("\n");
  if (existsSync(file) && readFileSync(file, "utf8") === content) return `${file} (unchanged)`;
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
  return `${file} (written)`;
};

if (import.meta.main) {
  requirePosix("dev:setup");
  // CI runners use umask 022; this applies to this process and its children only.
  process.umask(0o022);
  const started = performance.now();
  const root = resolve(import.meta.dir, "..");
  const bunVersion = pinnedBunVersion(root);
  runUnderPinnedBun(bunVersion, await ensurePinnedBun(root, bunVersion));
  const env = await runSteps(root, bunVersion, join(root, "target", "dev-fixtures"));
  const written = writeDevEnv(root, env);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`DEV_SETUP_OK bun=${Bun.version} (${process.execPath}) env=${written} in ${seconds}s`);
}
