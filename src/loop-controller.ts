import type { Deps } from "./harness.ts";
import { acquire, release } from "./loop-lock.ts";
import { Refusal } from "./refusal.ts";

type ControllerRole = "duty-loop" | "hourly-loop";
export type LoopLifecycle = { readonly signal: AbortSignal; readonly ready: () => void };

const controllerLock = (d: Deps, role: ControllerRole): string =>
  role === "duty-loop" ? d.store.lockPath("duty") : d.store.loopPath("runner.lock");

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type ControllerOptions = {
  readonly role: ControllerRole;
  readonly once: boolean;
  readonly lifecycle: LoopLifecycle | undefined;
};

/** One controller per role and home holds the lifetime lock; a native controller reports ready once it holds it. */
export function controllerLease(d: Deps, { role, once, lifecycle }: ControllerOptions) {
  const path = controllerLock(d, role);
  const signal = lifecycle?.signal;
  let held: string | undefined;

  return {
    async beforePass(): Promise<boolean> {
      if (signal?.aborted) return false;
      if (once && role === "hourly-loop") return true;
      if (!held) {
        const claim = acquire(d, path);
        if ("holder" in claim) {
          const which = role === "duty-loop" ? "duty" : "hourly";
          throw new Refusal(`another ${which} loop runs in this home (${claim.holder})`);
        }
        held = claim.nonce;
        lifecycle?.ready();
      }
      return true;
    },
    waitForPass(ms: number): Promise<void> {
      return wait(ms, signal);
    },
    close(): void {
      if (held) release(d, held, path);
      held = undefined;
    },
  };
}
