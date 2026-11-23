import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";

export function deploymentConfig(root: string) {
  return parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "home/.cataly/src",
      home: "home",
      catalyHome: "home/.cataly",
      catalyConfig: "home/.cataly/config.json",
      stateDir: "home/.cataly/state",
      bun: "home/private-bun/bun",
      omp: "home/private-omp/omp",
      restartLock: "home/.cataly/restart.lock",
      launcherPath: "home/.cataly/bin/restart",
      healthTimeoutMs: 100,
    },
    root,
  );
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cataly-deploy-files-"));
  directories.push(root);
  const config = parseDeploymentConfig(
    {
      releaseRoot: "releases",
      liveSource: "home/.cataly/src",
      home: "home",
      catalyHome: "home/.cataly",
      catalyConfig: "home/.cataly/config.json",
      stateDir: "home/.cataly/state",
      bun: process.execPath,
      omp: process.execPath,
      restartLock: "home/.cataly/restart.lock",
      launcherPath: "home/.cataly/bin/managed-restart",
      healthTimeoutMs: 100,
      stopTimeoutMs: 100,
    },
    root,
  );
  mkdirSync(config.liveSource, { recursive: true });
  writeFileSync(join(config.liveSource, "owner.ts"), "export const owner = 'original';\n");
  return { root, config };
}
