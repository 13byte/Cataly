import { object } from "../update/config.ts";
import { digest } from "../update/source.ts";
import type { ReleaseManifest } from "./types.ts";

/**
 * The historical terminal profile file. Nothing in this version reads its profiles, but every release still ships it
 * unchanged: updaters installed before the headless-only cutover refuse a headless manifest without it.
 */
export const terminalMetadata = "release-capabilities.json";
export const nativeMetadata = "release-headless.json";

type Profile = { readonly platform: string; readonly arch: string; readonly runtime: "headless" };

const HEADLESS_PROFILES = [
  { platform: "linux", arch: "x64", runtime: "headless" },
  { platform: "darwin", arch: "arm64", runtime: "headless" },
] as const satisfies readonly Profile[];

/** A release without the source-bound headless marker is a historical terminal release; it has no profiles here. */
export function headlessReleaseProfiles(manifest: ReleaseManifest, metadata?: Uint8Array): readonly Profile[] {
  const source = manifest.source.files.find((entry) => entry.path === nativeMetadata);
  if (!source) {
    if (metadata !== undefined) throw new Error(`Unexpected release capabilities metadata: ${nativeMetadata}`);
    return [];
  }
  if (manifest.requirements.omp === "18.18.8")
    throw new Error("Headless capability requires a bound native OMP payload");
  if (metadata === undefined || digest(metadata) !== source.sha256)
    throw new Error(`Release capabilities metadata missing or SHA256 differs: ${nativeMetadata}`);
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  if (
    !object(input) ||
    Object.keys(input).sort().join() !== "profiles,version" ||
    input["version"] !== 1 ||
    !Array.isArray(input["profiles"]) ||
    !input["profiles"].length
  )
    throw new Error("Invalid release capabilities");
  const profiles: Profile[] = [];
  for (const entry of input["profiles"]) {
    if (!object(entry) || Object.keys(entry).sort().join() !== "arch,platform,runtime")
      throw new Error("Invalid release capability");
    const candidate = HEADLESS_PROFILES.find(
      (item) => item.platform === entry["platform"] && item.arch === entry["arch"] && item.runtime === entry["runtime"],
    );
    if (!candidate || profiles.includes(candidate)) throw new Error("Invalid or duplicate release capability");
    profiles.push(candidate);
  }
  return profiles;
}
