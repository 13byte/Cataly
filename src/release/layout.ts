import { lstatSync } from "node:fs";
import { join } from "node:path";
import { contains } from "../update/config.ts";

export const isPrimaryConsumer = ({ home, cataly }: { readonly home: string; readonly cataly: string }): boolean =>
  cataly === join(home, ".cataly") || cataly === join(home, ".dori");

export function consumerLayout(home: string, location: string): "legacy" | "cataly" {
  for (const primary of [join(home, ".cataly"), join(home, ".dori")])
    if (location !== primary && (contains(primary, location) || contains(location, primary)))
      throw new Error(`A consumer home must not contain or be inside the primary home ${primary}`);
  if (location === join(home, ".dori") || location === join(home, ".omp-dori")) return "legacy";
  // A v1 isolated home could be anywhere. Its existing receipt and wrapper names fix which renderer ABI to use.
  return lstatSync(join(location, "releases/consumer-owner.json"), { throwIfNoEntry: false }) &&
    lstatSync(join(location, "bin/dori"), { throwIfNoEntry: false })
    ? "legacy"
    : "cataly";
}
