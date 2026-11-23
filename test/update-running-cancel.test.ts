import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { inspectActiveDeployment, saveActiveDeployment } from "../src/update/deployment-active.ts";
import { captureRuntime } from "../src/update/deployment-harness.ts";
import { leadRuntimeHealth } from "../src/update/deployment-monitor-receipts.ts";
import { processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";
import { waitFor } from "./update-detection-setup.ts";

test.skipIf(process.platform !== "linux")(
  "abort stops the active Git verification group, not the native runtime",
  async () => {
    const f = await headlessDeployment();
    try {
      const overlay = overlayFixture(f.oldSource, join(f.root, "ulw"));
      const marker = join(f.root, "filter-pid");
      const filter = join(f.root, "filter.ts");
      // A real Git filter holds its OS pipe; fake timers cannot expose a blocked synchronous parent.
      writeFileSync(
        filter,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
await Bun.sleep(1_000);
process.stdout.write(await Bun.stdin.text());
`,
      );
      fixtureGit(
        overlay.checkout,
        "config",
        "filter.hold.clean",
        `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`,
      );
      fixtureGit(overlay.checkout, "config", "filter.hold.required", "true");
      writeFileSync(join(overlay.checkout, ".git/info/attributes"), "presets.ts filter=hold\n");
      const runtime = await captureRuntime(f.config, true);
      await waitFor(() => leadRuntimeHealth(f.config.stateDir, runtime) !== undefined);
      saveActiveDeployment(f.config, {
        ...f.record,
        runtime,
        sourceHash: sourceManifest(f.oldSource).hash,
        toolchain: {
          ...f.toolchain,
          ompUlw: {
            source: f.oldSource,
            directory: overlay.checkout,
            identity: readSourceBundle(f.oldSource).identity,
          },
        },
      });
      const active = join(f.config.releaseRoot, "active.json");
      const before = readFileSync(active, "utf8");
      const abort = new AbortController();
      const previousTemp = process.env["TMPDIR"];
      process.env["TMPDIR"] = f.root;
      const pending = inspectActiveDeployment(f.config, abort.signal);
      try {
        await waitFor(() => existsSync(marker));
        expect(readdirSync(f.root).filter((name) => name.startsWith("cataly-status-"))).toHaveLength(1);
        const pid = Number(readFileSync(marker, "utf8"));
        abort.abort();
        const result = await pending;
        expect(result.status).toBe("unknown");
        expect(result).not.toHaveProperty("sourceHash");
        expect(processIdentity(pid)).toBeUndefined();
        expect(readdirSync(f.root).filter((name) => name.startsWith("cataly-status-"))).toHaveLength(0);
        expect(readFileSync(active, "utf8")).toBe(before);
        expect(sameProcess(runtime)).toBe(true);
        expect((await f.lead())?.pid).toBe(runtime.pid);
      } finally {
        abort.abort();
        await pending;
        if (previousTemp === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = previousTemp;
      }
    } finally {
      await f.teardown();
    }
  },
  30_000,
);
