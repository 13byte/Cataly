import { classifyOmpArgv, isOmpArgv, mayRunOmpArgv, nonPidPreservingPrefix } from "../runtime/omp-argv.ts";
import { UpdateError } from "./config.ts";
import { checkNativeArgv } from "./native-argv.ts";
import type { UpdateCommand } from "./types.ts";

/** Validate native update prefixes at load and again before launching their model process. */
export const nativeAgent = (command: UpdateCommand, label = command.name): boolean => {
  if (command.engine === "external") return false;
  const native = command.engine === "omp" || isOmpArgv(command.argv);
  const prefix = nonPidPreservingPrefix(command.argv);
  if (prefix !== undefined && (native || mayRunOmpArgv(command.argv)))
    throw new UpdateError(
      `${label}.argv requires a PID-preserving native launch; ${prefix} may fork; use a direct/exec-preserving command or set ${label}.engine to "external"`,
    );
  return native;
};

/** The part of a native agent's argv that its CLI parses, after assignments and readable launch prefixes. */
export const ompPart = (argv: readonly string[]): readonly string[] => {
  const classified = classifyOmpArgv(argv);
  return classified.kind === "unparsed" ? argv : classified.command;
};

export const checkAgent = (agent: UpdateCommand, label: string): void => {
  if (!agent.argv.some((arg) => arg.includes("{prompt}") || arg.includes("{brief}"))) {
    throw new UpdateError(`${label}.argv must consume {prompt} or {brief}`);
  }
  if (agent.cwd !== undefined) throw new UpdateError(`${label}.cwd is fixed to the candidate`);
  const native = nativeAgent(agent, label);
  // An unreadable command prefix hides which arguments OMP gets, so native checks cannot cover it:
  // only an explicitly external wrapper, which owns its own contract, may use one.
  if (agent.engine !== "external" && classifyOmpArgv(agent.argv).kind === "unparsed") {
    throw new UpdateError(
      `${label}.argv has a command prefix Cataly cannot read; attach bun/node option values with = (such as --preload=FILE), drop -S and unknown env options, or set ${label}.engine to "external"; a shell script or package runner string that names OMP is not read either`,
    );
  }
  if (!native) return; // an explicit external wrapper owns its own fresh-context and capability contract
  checkNativeArgv(ompPart(agent.argv), label);
};
