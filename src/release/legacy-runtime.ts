import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LegacyRuntimeError } from "../runtime/registry.ts";
import { parseRef } from "../runtime/types.ts";
import { object as record } from "../update/config.ts";

export { LegacyRuntimeError };

const legacyKind = (value: unknown): boolean => value === "herdr" || value === "hc";

/** Parsed JSON, or undefined when the file is absent. Unreadable lane files are no evidence of a live lane. */
function readOptional(path: string): { readonly value: unknown } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
      return undefined;
    throw error;
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: undefined };
  }
}

/** Stop on a configuration that still selects herdr/hc in `runtime` or `sessionRuntime`; Tern stays selectable. */
export function assertNoLegacyConfig(config: unknown, configPath: string): void {
  if (record(config) && (legacyKind(config["runtime"]) || legacyKind(config["sessionRuntime"])))
    throw new LegacyRuntimeError(configPath);
}

/**
 * A lane file from either store: the root store (`status` "done" closes it) or the skill registry (`closedAt` or
 * status "closed"). A record from before runtimes existed names only its herdr-shaped (`w1:p3`) `paneId` (root) or
 * `pane` (skill); an open Tern lane is current.
 */
function openLegacyLane(lane: unknown): boolean {
  if (!record(lane)) return false;
  if (lane["status"] === "done" || lane["status"] === "closed" || lane["closedAt"]) return false;
  const ref = lane["sessionRef"];
  if (record(ref)) return legacyKind(ref["runtime"]);
  return [lane["paneId"], lane["pane"]].some((id) => typeof id === "string" && legacyKind(parseRef(id)?.runtime));
}

function laneFiles(directory: string): string[] {
  try {
    return readdirSync(join(directory, "lanes"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(directory, "lanes", name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Stop before a home that still depends on herdr/hc starts or activates a release. Reads only; never rewrites or
 * deletes state. Scans `stateDir`, the configuration's own directory (the Cataly home) and a configured `stateDir`,
 * whose `~/` names `home` (the user's home unless a consumer layout selects one).
 */
export function assertNoLegacyRuntime(input: {
  readonly stateDir: string;
  readonly configPath: string;
  readonly home?: string;
}): void {
  const { configPath } = input;
  const config = readOptional(configPath)?.value;
  assertNoLegacyConfig(config, configPath);
  const directories = new Set([resolve(input.stateDir), resolve(dirname(configPath))]);
  const configured = record(config) ? config["stateDir"] : undefined;
  if (typeof configured === "string" && configured) {
    const expanded = configured.startsWith("~/") ? join(input.home ?? homedir(), configured.slice(2)) : configured;
    if (isAbsolute(expanded)) directories.add(resolve(expanded));
  }
  for (const directory of directories) {
    for (const path of laneFiles(directory))
      if (openLegacyLane(readOptional(path)?.value)) throw new LegacyRuntimeError(configPath);
  }
  // A running harness also registers its `headless:` or `tern:` refs here; only other refs are historical.
  const current = (ref: unknown): boolean => {
    const runtime = typeof ref === "string" ? parseRef(ref)?.runtime : undefined;
    return runtime === "headless" || runtime === "tern";
  };
  for (const directory of directories) {
    const roles = readOptional(join(directory, "roles.json"));
    if (roles !== undefined && (!record(roles.value) || !Object.values(roles.value).every(current)))
      throw new LegacyRuntimeError(configPath, { rolesJson: true });
  }
}
