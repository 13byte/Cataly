import { platform } from "../platform/index.ts";
import { readSetupFile, type SetupSnapshot } from "../setup-files.ts";
import { object } from "../update/config.ts";
import { headlessReleaseProfiles, nativeMetadata } from "./capabilities.ts";
import { controllerReads } from "./controller.ts";
import type { ConsumerPaths } from "./files.ts";
import { assertNoLegacyConfig } from "./legacy-runtime.ts";
import type { ReleaseManifest } from "./types.ts";

type ReleaseProfileBytes = (path: string) => Uint8Array | undefined;

/**
 * Verify against the target payload, not the update command's loaded release: it must run headless on this host, and
 * the preserved config must not still select herdr/hc (Tern stays). Historical terminal-only releases are refused.
 */
export function assertReleaseTarget(
  paths: ConsumerPaths,
  target: { readonly manifest: ReleaseManifest; readonly bytes: ReleaseProfileBytes },
  snapshot: SetupSnapshot,
): void {
  const { manifest, bytes } = target;
  const host = { platform: platform.os, arch: process.arch };
  const saved = readSetupFile(snapshot);
  const config: unknown = saved === undefined ? {} : JSON.parse(saved.toString("utf8"));
  if (!object(config)) throw new Error("Preserved config must be an object");
  assertNoLegacyConfig(config, paths.config);
  if (config["runtime"] !== undefined && config["runtime"] !== "tern")
    throw new Error("Preserved config runtime must be tern when present");
  const session = config["sessionRuntime"];
  if (session !== undefined && session !== "headless" && session !== "tern")
    throw new Error("Preserved config sessionRuntime must be headless or tern when present");
  const profiles = headlessReleaseProfiles(manifest, bytes(nativeMetadata));
  if (!profiles.some((profile) => profile.platform === host.platform && profile.arch === host.arch))
    throw new Error(`Release ${manifest.tag} does not support ${host.platform}/${host.arch}/headless`);
}

/** A headless installation never returns to a release without the bound native protocol. */
export function assertUpdateProtocol(current: ReleaseManifest | undefined, target: ReleaseManifest): void {
  if (current && !controllerReads(target, current))
    throw new Error(
      `Install cannot downgrade the bound runtime protocol: release ${target.tag} cannot read the OMP 19 receipt of installed ${current.tag}; use "cataly update rollback" to restore a retained pre-19 release`,
    );
  if (
    (current?.requirements.omp === "18.20.0" && target.requirements.omp === "18.18.8") ||
    (current?.source.files.some((entry) => entry.path === nativeMetadata) &&
      !target.source.files.some((entry) => entry.path === nativeMetadata))
  )
    throw new Error("Install cannot downgrade the bound runtime protocol");
}
