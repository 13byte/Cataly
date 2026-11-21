import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { installLegacyAliases } from "./aliases.ts";
import { prepareConsumerDiscovery } from "./discovery.ts";
import { nativeOmp } from "./provision.ts";
import {
  type ConsumerPaths,
  isPrimaryConsumer,
  owned,
  readJson,
  realDirectory,
  regularFile,
  saveJson,
  syncDirectory,
} from "./files.ts";

const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
type Reference = { readonly bytes: string; readonly executable: boolean };
const commandName = (paths: ConsumerPaths): string => (paths.layout === "cataly" ? "cataly" : "dori");
const referenceFiles = (paths: ConsumerPaths): readonly string[] => {
  const command = commandName(paths);
  return [`bin/${command}`, `bin/${command}-harness`, "bin/omp", `bin/omp-${command}`, "omp.yml"];
};
type PendingReferences = {
  readonly before: Readonly<Record<string, string>>;
  readonly references: Readonly<Record<string, Reference>>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function pendingReferences(paths: ConsumerPaths): PendingReferences | undefined {
  const files = referenceFiles(paths);
  const path = join(paths.root, "consumer-references-pending.json");
  if (!regularFile(path)) return undefined;
  const raw = readJson(path);
  if (
    !object(raw) ||
    Object.keys(raw).sort().join() !== "before,references" ||
    !object(raw["before"]) ||
    !object(raw["references"])
  )
    throw new Error("Invalid pending consumer references");
  const before: Record<string, string> = {};
  const references: Record<string, Reference> = {};
  for (const [name, digest] of Object.entries(raw["before"])) {
    if (!files.includes(name) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid pending reference identity");
    before[name] = digest;
  }
  for (const [name, ref] of Object.entries(raw["references"])) {
    if (
      !files.includes(name) ||
      !object(ref) ||
      Object.keys(ref).sort().join() !== "bytes,executable" ||
      typeof ref["bytes"] !== "string" ||
      ref["executable"] !== name.startsWith("bin/")
    )
      throw new Error("Invalid pending reference content");
    references[name] = { bytes: ref["bytes"], executable: name.startsWith("bin/") };
  }
  if ([...new Set([...Object.keys(before), ...Object.keys(references)])].sort().join() !== [...files].sort().join())
    throw new Error("Incomplete pending consumer references");
  return { before, references };
}

/** Generated references belong to the consumer, never to an existing source installer or its wrappers. */
export function preflightReferences(paths: ConsumerPaths): void {
  if (isPrimaryConsumer(paths)) return;
  const files = referenceFiles(paths);
  const receipt = join(paths.root, "consumer-references.json");
  const pending = pendingReferences(paths);
  if (!regularFile(receipt) && !pending) {
    for (const path of files) {
      if (lstatSync(join(paths.cataly, path), { throwIfNoEntry: false }))
        throw new Error(`Unmanaged installation reference: ${join(paths.cataly, path)}`);
    }
  } else {
    const recorded = regularFile(receipt) ? readJson(receipt) : {};
    const expected = {
      ...pending?.before,
      ...Object.fromEntries(Object.entries(pending?.references ?? {}).map(([path, ref]) => [path, hash(ref.bytes)])),
    };
    if (
      !object(recorded) ||
      (!pending && Object.keys(recorded).sort().join() !== [...files].sort().join()) ||
      (pending &&
        JSON.stringify(recorded) !== JSON.stringify(pending.before) &&
        JSON.stringify(recorded) !== JSON.stringify(expected))
    )
      throw new Error("Invalid consumer reference receipt");
    for (const path of files) {
      const destination = join(paths.cataly, path);
      const present = regularFile(destination);
      const allowed = pending ? [pending.before[path], expected[path]] : [recorded[path]];
      if (
        (!present && !allowed.includes(undefined)) ||
        (present &&
          (!allowed.includes(hash(readFileSync(destination, "utf8"))) ||
            (lstatSync(destination).mode & 0o111) !== (path.startsWith("bin/") ? 0o111 : 0)))
      )
        throw new Error(`Consumer reference changed: ${path}; preserve it before reinstalling`);
    }
  }
  for (const path of files) realDirectory(dirname(join(paths.cataly, path)));
}

function finishReferences(paths: ConsumerPaths, pending: PendingReferences): void {
  const digests = { ...pending.before };
  for (const [path, ref] of Object.entries(pending.references)) {
    const destination = join(paths.cataly, path);
    realDirectory(dirname(destination), true);
    owned(dirname(destination));
    const temporary = `${destination}.consumer-${randomUUID()}`;
    writeFileSync(temporary, ref.bytes, { flag: "wx", mode: ref.executable ? 0o755 : 0o600 });
    chmodSync(temporary, ref.executable ? 0o755 : 0o600);
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
    digests[path] = hash(ref.bytes);
  }
  saveJson(join(paths.root, "consumer-references.json"), digests);
  unlinkSync(join(paths.root, "consumer-references-pending.json"));
  syncDirectory(paths.root);
}

type LegacyPaths = Omit<ConsumerPaths, "cataly" | "layout">;
export function installIsolatedReferences(received: ConsumerPaths | LegacyPaths, source: string): void {
  // v0.1.3 calls the authenticated target renderer with its original paths record.
  const paths: ConsumerPaths =
    "cataly" in received ? received : { ...received, cataly: received.dori, layout: "legacy" };
  if (isPrimaryConsumer(paths)) return;
  preflightReferences(paths);
  const command = commandName(paths);
  const current = regularFile(join(source, "release-headless.json"));
  if (current) installLegacyAliases(paths, false);
  prepareConsumerDiscovery(paths, source);
  const interrupted = pendingReferences(paths);
  if (interrupted) finishReferences(paths, interrupted);
  const receipt = join(paths.root, "consumer-references.json");
  const references: Record<string, Reference> = {};
  const omp = nativeOmp();
  if (!omp && !regularFile(join(source, "native-omp.lock")))
    throw new Error("The native omp command is unavailable outside Dori wrappers");
  const protocol =
    'const {readFileSync}=require("node:fs"); const {requirements,source}=JSON.parse(readFileSync(process.argv[1],"utf8")); const bound=source.files.some(({path})=>["native-omp.lock","native-omp.patch","omp-ulw.overlay.lock","omp-ulw.patch"].includes(path)); if(requirements.omp!==(bound?"18.20.0":"18.18.8")) throw new Error("Unsupported or inconsistent consumer native protocol"); console.log(requirements.omp);';
  const legacy = omp
    ? `omp=${quote(omp)}`
    : 'echo "An independent native OMP is required for this retained release; reinstall with its toolchain" >&2; exit 1';
  const prefix = current ? "CATALY" : "DORI";
  const namespace = quote(`omp-${command}-${hash(paths.cataly).slice(0, 12)}`);
  const env = [
    ...(current ? ["unset DORI_HOME DORI_CONFIG DORI_CMD DORI_AGENT_CMD"] : []),
    ...[...new Set([prefix, "DORI"])].map(
      (name) =>
        `unset ${["STATE_DIR", "LEAD_PANE", "HC_SPACE", "PROMPTS_DIR", "AGENT_ARGV", "OMP_ULW_PATH", "MANAGED_STARTUP", ...(current ? [] : ["RUNTIME"])].map((key) => `${name}_${key}`).join(" ")}`,
    ),
    `export ${prefix}_HOME=${quote(paths.cataly)}`,
    `export ${prefix}_CONFIG=${quote(paths.config)}`,
    `export ${prefix}_AGENT_CMD=${quote(join(paths.cataly, "bin/omp"))}`,
    `export ${prefix}_CMD=${quote(quote(join(paths.cataly, "bin", `${command}-harness`)))}`,
    `if [ "\${HC_SESSION:-}" != ${namespace} ]; then unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SOCKET; fi`,
    `export HC_SESSION=${namespace}`,
    `if [ "\${${prefix}_HERDR_SESSION:-\${DORI_HERDR_SESSION:-}}" != ${namespace} ]; then unset HERDR_PANE_ID HERDR_WORKSPACE_ID; fi`,
    `export ${prefix}_HERDR_SESSION=${namespace}`,
    `export PATH=${quote(join(paths.cataly, "bin"))}:"$PATH"`,
  ].join("\n");
  const wrapper = (body: string): Reference => ({
    bytes: `#!/usr/bin/env bash\n# ${current ? "Cataly" : "OMP-Dori"} consumer wrapper\n${env}\n${body}\n`,
    executable: true,
  });
  references[`bin/${command}`] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "skills", `${command}-mode`, "scripts/src/cli.ts"))} "$@"`,
  );
  references[`bin/${command}-harness`] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "src/cli.ts"))} "$@"`,
  );
  references["bin/omp"] = wrapper(
    `source=$(cd ${quote(paths.live)} && pwd -P) || exit\nif [ -f "$source/src/release/automatic.ts" ]; then\n  source=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} "$source/src/release/automatic.ts" "$source" "$HOME" "$$" "$@") || exit\nfi\nprotocol=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} -e ${quote(protocol)} ${quote(paths.manifests)}/"\${source##*/}".json) || exit\ncase "$protocol" in\n  18.20.0) omp="$source/scripts/consumer/omp" ;;\n  18.18.8) ${legacy} ;;\nesac\nexec "$omp" --no-extensions -e "$source/extension" --config ${quote(join(paths.cataly, "omp.yml"))} --config ${quote(join(paths.root, "consumer-discovery"))}/"\${source##*/}"/omp.yml "$@"`,
  );
  references[`bin/omp-${command}`] = wrapper(
    `case "\${1:-}" in\n  omp) shift; exec ${quote(join(paths.cataly, "bin/omp"))} "$@" ;;\n  hc) shift; exec hc "$@" ;;\n  *) exec ${quote(join(paths.cataly, "bin", command))} "$@" ;;\nesac`,
  );
  // OMP self-update replaces the first omp on PATH, which is bin/omp above; the replaced wrapper would drop the
  // extension and the live source selection. The managed deployment keeps the same per-process fence.
  references["omp.yml"] = {
    bytes: `skills:\n  ignoredSkills:\n    - ${current ? "cataly" : "dori"}-mode\nupdate:\n  auto: false\n`,
    executable: false,
  };
  const recorded = regularFile(receipt) ? readJson(receipt) : {};
  if (!object(recorded)) throw new Error("Invalid consumer reference receipt");
  const before: Record<string, string> = {};
  for (const [path, digest] of Object.entries(recorded)) {
    if (typeof digest !== "string") throw new Error("Invalid consumer reference digest");
    before[path] = digest;
  }
  const pending = { before, references };
  saveJson(join(paths.root, "consumer-references-pending.json"), pending);
  finishReferences(paths, pending);
  if (current) installLegacyAliases(paths);
}
