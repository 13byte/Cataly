import { readFileSync } from "node:fs";
import { type Command, die } from "./cli-context.ts";
import { allowPolicyOnce } from "./lane-policy-actions.ts";
import { currentLanePolicy, policyBinding } from "./lane-policy-store.ts";
import { PolicyError } from "./lane-policy.ts";

const protectedCaller = (env: NodeJS.ProcessEnv): boolean => {
  if (env["DORI_LANE_POLICY"]) return true;
  const file = env["PI_SESSION_FILE"];
  if (!file) return false;
  try {
    let header = false;
    // Approval must originate outside the protected transcript, including branches that precede the binding.
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { type?: unknown; id?: unknown; customType?: unknown } | null;
      if (typeof entry !== "object" || entry === null) throw new PolicyError("invalid session record");
      if (entry.type === "session" && typeof entry.id === "string" && entry.id) header = true;
      if (entry.type === "custom" && entry.customType === "omp-dori:lane-policy") return true;
    }
    if (!header) throw new PolicyError("missing native session header");
    return false;
  } catch (error) {
    throw new PolicyError(`cannot inspect caller session: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const policyCommand: Command = async ({ positionals, strings, lane, deps }) => {
  if (protectedCaller(process.env))
    return die("policy grants must be issued from the owner or lead session, not a policy-bound lane");
  const [action, key, rule, ...extra] = positionals;
  if (action !== "allow-once" || !key || !rule || extra.length)
    return die("usage: dori policy allow-once <key> <denyBash[index]> --reason <owner approval>");
  const [reason, ...otherReasons] = strings("reason");
  if (!reason?.trim() || otherReasons.length) return die("allow-once requires exactly one nonempty --reason");
  const target = await lane(key);
  const policy = currentLanePolicy(deps.config.stateDir, target.key);
  const grant = allowPolicyOnce(policyBinding(policy), rule, reason, deps.clock.now());
  console.log(
    `POLICY_ALLOW_ONCE ${target.key} rule=${grant.rule} command-sha256=${grant.hash}; retry explicitly; native approvals still apply`,
  );
};
