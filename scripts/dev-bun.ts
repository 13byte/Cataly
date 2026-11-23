/**
 * Shared by `dev:setup` and `test:local`: the Bun pinned by package.json `packageManager`, installed under
 * target/ when the running Bun differs, and the private /tmp directory CI's trusted sticky /tmp provides.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REEXEC = "CATALY_DEV_PINNED_BUN";

export const requirePosix = (command: string): void => {
  if (process.platform === "win32")
    throw new Error(`${command} mirrors the Linux CI job and needs a POSIX shell, umask and /tmp`);
};

/** The `bun@X.Y.Z` pin from package.json `packageManager`, the single source CI's setup-bun version must match. */
export const pinnedBunVersion = (root: string): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manager = pkg && typeof pkg === "object" && "packageManager" in pkg ? pkg.packageManager : undefined;
  const version = typeof manager === "string" ? /^bun@(\d+\.\d+\.\d+)$/.exec(manager)?.[1] : undefined;
  if (!version) throw new Error(`package.json packageManager must be bun@X.Y.Z, found ${JSON.stringify(manager)}`);
  return version;
};

const reportedVersion = (bun: string): string | undefined => {
  if (!existsSync(bun)) return undefined;
  const result = Bun.spawnSync([bun, "--version"], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
};

// Release asset names follow Bun's own install.sh, including its AVX2 probe for the x64 baseline build.
const releaseAsset = (): string => {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x64" : undefined;
  if (!arch || (process.platform !== "linux" && process.platform !== "darwin"))
    throw new Error(`no pinned Bun release asset for ${process.platform}-${process.arch}`);
  const baseline =
    process.platform === "linux" && arch === "x64" && !/\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8"));
  return `bun-${process.platform}-${arch}${baseline ? "-baseline" : ""}`;
};

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${url} (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
};

/** Download the pinned release, verify it against the release's SHASUMS256.txt and install it at `dir/bin/bun`. */
const installBun = async (root: string, version: string, dir: string): Promise<void> => {
  const asset = releaseAsset();
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
  console.log(`dev:setup: downloading Bun ${version} (${asset}) into ${dir}`);
  const [zip, sums] = await Promise.all([download(`${base}/${asset}.zip`), download(`${base}/SHASUMS256.txt`)]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === `${asset}.zip`)?.[0];
  const actual = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
  if (!expected || expected !== actual) throw new Error(`${asset}.zip sha256 ${actual} does not match SHASUMS256.txt`);
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  const stage = mkdtempSync(join(target, `bun-${version}.download-`));
  try {
    writeFileSync(join(stage, "bun.zip"), zip);
    const unzip = Bun.spawnSync(["unzip", "-q", join(stage, "bun.zip"), "-d", stage], { stdout: "inherit" });
    if (unzip.exitCode !== 0) throw new Error(`unzip failed for ${asset}.zip (exit ${unzip.exitCode})`);
    mkdirSync(join(stage, "dist", "bin"), { recursive: true });
    renameSync(join(stage, asset, "bun"), join(stage, "dist", "bin", "bun"));
    chmodSync(join(stage, "dist", "bin", "bun"), 0o755);
    const installed = reportedVersion(join(stage, "dist", "bin", "bun"));
    if (installed !== version) throw new Error(`downloaded Bun reports ${installed ?? "nothing"}, not ${version}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(join(stage, "dist"), dir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

/** The running Bun when it is the pinned version, else target/bun-<version>/bin/bun, installed when absent or wrong. */
export const ensurePinnedBun = async (root: string, version: string): Promise<string> => {
  if (Bun.version === version) return process.execPath;
  const dir = join(root, "target", `bun-${version}`);
  const bun = join(dir, "bin", "bun");
  if (reportedVersion(bun) !== version) await installBun(root, version, dir);
  return bun;
};

/** Continue only under the pinned Bun: re-execute this script with `bun` and `env`, then exit with its status. */
export const runUnderPinnedBun = (
  version: string,
  bun: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  if (Bun.version === version) {
    delete process.env[REEXEC];
    return;
  }
  if (process.env[REEXEC])
    throw new Error(`${process.execPath} reports Bun ${Bun.version}, not ${version}; rerun \`bun run dev:setup\``);
  const script = process.argv[1];
  if (!script) throw new Error("cannot re-execute: the running script path is unknown");
  const child = Bun.spawnSync([bun, script, ...process.argv.slice(2)], {
    env: { ...env, [REEXEC]: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(child.exitCode ?? 1);
};

/** Run `use` with a fresh `mktemp -d /tmp/<prefix>-XXXXXX` equivalent (mode 0700), removed afterwards. */
export const withPrivateTmp = async <T>(prefix: string, use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(`/tmp/${prefix}-`);
  try {
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
