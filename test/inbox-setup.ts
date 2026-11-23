import { World, sid, tref } from "./fake.ts";

/** The lead is a hand-registered Tern role (see harness-setup.ts); PANE is a headless session. */
export const LEAD = "1";
export const LEAD_REF = tref(LEAD);
export const PANE = sid(2);

export function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addTerminal(LEAD, "idle");
  d.store.setRole("lead", LEAD_REF);
  const pane = w.addPane(PANE, "idle");
  const deliveries = (id: string) => w.calls.filter((c) => c.cmd === "deliver" && c.argv[0] === id).length;
  const notices = () => lead.received.filter((m) => m.startsWith(`[DELIVERY-AMBIGUOUS headless:${PANE}]`));
  return { w, d, lead, pane, deliveries, notices };
}

export async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  try {
    return { code: await run(), out: out.join("\n") };
  } finally {
    console.log = log;
  }
}
