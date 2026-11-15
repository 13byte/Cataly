import { describe, expect, test } from "bun:test";
import { ompWorld } from "./omp-setup.ts";

const packageRoot = "/private/native/source/packages/coding-agent/";
const preload = `${packageRoot}scripts/omp.ts`;
const cli = `${packageRoot}scripts/../src/cli.ts`;
const argv = ["bun", "--preload", preload, cli, "--dori-role", "lane"];

for (const kind of ["herdr", "hc"] as const) {
  describe(`${kind}: source-native process identity`, () => {
    test("source foreground without an extension record stays unknown", async () => {
      const s = ompWorld(kind, false, false);
      s.pane.agent = "other";
      s.pane.foreground = [{ name: "bun", argv }];
      s.w.hc.terminals.get("t1")!.status = { state: "idle", app: "other" };
      s.w.hc.terminals.get("t1")!.foreground = { name: "bun", argv, pid: 101 };
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message", { force: true })).kind).toBe("not-ready");
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test.each([cli, `${packageRoot}src/cli.ts`])("attests %s and holds approvals", async (entry) => {
      const s = ompWorld(kind);
      const command = ["/private/bin/bun", "--preload", preload, entry, "--dori-role", "lane"];
      s.pane.foreground = [{ name: "bun", argv: command }];
      s.w.hc.terminals.get("t1")!.foreground = { name: "bun", argv: command, pid: 101 };
      s.control.table = `100 1 /bin/bash\n101 100 ${command.join(" ")}\n`;
      expect(await s.rt.probe(s.ref)).toMatchObject({
        status: "idle",
        pid: 101,
        sessionId: s.record.sessionId,
        sessionFile: s.record.sessionFile,
      });
      s.record.approvalPending = true;
      s.save();
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "blocked",
      });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
      s.record.approvalPending = false;
      s.save();
      expect((await s.rt.deliver(s.ref, "message")).kind).toBe("delivered");
    });

    test.each([
      ["another CLI", `bun --preload ${preload} /unrelated/src/cli.ts`],
      ["another preload", `bun --preload /unrelated/scripts/omp.ts ${cli}`],
      ["another interpreter", `node --preload ${preload} ${cli}`],
      ["shell mentioning the source command", `bash -c ${argv.join(" ")}`],
      ["CLI suffix", `bun --preload ${preload} ${cli}.other`],
    ])("holds %s without delivering input", async (_, command) => {
      const s = ompWorld(kind);
      s.control.table = `100 1 /bin/bash\n101 100 ${command}\n`;
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "unknown",
      });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test("source identity still requires terminal ancestry and the original process incarnation", async () => {
      const s = ompWorld(kind);
      s.control.table = `100 1 /bin/bash\n101 200 ${argv.join(" ")}\n`;
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      s.control.table = `100 1 /bin/bash\n101 100 ${argv.join(" ")}\n`;
      s.control.started = "2026-11-11T00:01:00Z";
      expect((await s.rt.deliver(s.ref, "message", { force: true })).kind).toBe("not-ready");
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });
  });
}
