// S5 wake-voice — turn-firing reply-mode contract + U5 rich compaction.
//
// Covers the S5 matrix the G1 notify-matrix suite does not: wake promptAsync
// throw/rejection/missing-surface fallback (DONE/toast/logs still land, never
// throws), reply-mode shape (WITHOUT noReply, trusted prefix, untrusted fence,
// read-hint), DONE-marker persist fallback on an unreadable output path
// (EISDIR), and the S5/U5 rich compacting hook (running[] + unread[10] +
// read-hint, overflow note). All via the public tool surface.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  saveEnv,
  restoreEnv,
  makeHome,
  makeWorkdir,
  makeClient,
  makeCtx,
  boot,
  runId,
  readState,
  readOutput,
  readNotifications,
  wakeCalls,
  completedMessages,
  projectDir,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";

/** Poll the state file until the job leaves running/queued. Never touches
 *  background_read, so the unread flag survives for compact-hook assertions. */
async function waitDiskTerminal(home: string, dir: string, id: string): Promise<void> {
  for (let n = 0; n < 200; n++) {
    const st = readState(home, dir, id).state;
    if (st !== "running" && st !== "queued") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} still running after 10s`);
}

describe("S5 wake-voice", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("reply-mode contract: wake fires WITHOUT noReply, trusted prefix, fence, read-hint", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("voice contract") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "voice me" }, owner),
    );
    await plugin.tool.background_list.execute({}, owner);
    expect(readState(home, dir, id).state).toBe("completed");
    const calls = wakeCalls(client, OWNER);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.[0]?.body ?? {};
    expect("noReply" in body).toBe(false); // reply-mode: arrival triggers parent action
    const text = body?.parts?.[0]?.text ?? "";
    expect(text.startsWith("[background-ops]")).toBe(true); // trusted prefix
    expect(text).toContain("Untrusted child output"); // untrusted fence
    expect(text).toContain(`background_read("${id}")`); // read-hint
  });

  it("wake promptAsync sync-throw falls back to DONE/toast/logs, terminal still lands", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("throw fallback") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "throw me" }, owner),
    );
    client.session.promptAsync.mockImplementationOnce(() => {
      throw new Error("parent gone");
    });
    await plugin.tool.background_list.execute({}, owner); // must not throw
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.notified).toBe(true);
    expect(st.summary.startsWith("[DONE COMPLETED]")).toBe(true);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(client.app.log).toHaveBeenCalledTimes(1);
    expect(readNotifications(home, dir).find((n: any) => n.id === id)?.event).toBe("done");
    expect(readOutput(home, dir, id)).toContain("[DONE COMPLETED]");
  });

  it("wake promptAsync rejection falls back to DONE/toast/logs, terminal still lands", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("reject fallback") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "reject me" }, owner),
    );
    client.session.promptAsync.mockRejectedValueOnce(new Error("noisy parent"));
    await plugin.tool.background_list.execute({}, owner); // must not throw
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.notified).toBe(true);
    expect(st.summary.startsWith("[DONE COMPLETED]")).toBe(true);
    expect(wakeCalls(client, OWNER)).toHaveLength(1); // attempted, swallowed
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it("wake surface missing (no promptAsync) stays silent, DONE/toast/logs carry it", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("headless parent") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "headless me" }, owner),
    );
    (client.session as any).promptAsync = undefined; // headless parent: no wake surface
    await plugin.tool.background_list.execute({}, owner); // must not throw
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.notified).toBe(true);
    expect(st.summary.startsWith("[DONE COMPLETED]")).toBe(true);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(client.app.log).toHaveBeenCalledTimes(1);
  });

  it("toast rejection still lands DONE + notified (headless-TUI fallback)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("toastless") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "toast me" }, owner),
    );
    client.tui.showToast.mockRejectedValueOnce(new Error("headless"));
    await plugin.tool.background_list.execute({}, owner); // must not throw
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.notified).toBe(true);
    expect(st.summary.startsWith("[DONE COMPLETED]")).toBe(true);
    expect(wakeCalls(client, OWNER)).toHaveLength(1);
  });

  it("DONE marker survives an unreadable output path via the persist fallback", async () => {
    // Plant a RUNNING bash job whose outputPath is a directory (EISDIR): both
    // the stop-path read and the notify-path read throw, so both persist
    // fallbacks run. Funnel must stay total: stopped + notified + DONE.
    const dir = makeWorkdir();
    const base = projectDir(home, dir);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const job = {
      id: "eisdir-job",
      kind: "bash",
      state: "running",
      prompt: "planted eisdir",
      rootSessionID: OWNER,
      ownerSessionID: OWNER,
      startedAt: now - 1000,
      timeoutMinutes: 15,
      title: "planted: eisdir-job",
      summary: "planted eisdir",
      outputPath: base, // directory, not a file: readFileSync throws EISDIR
      statePath: join(base, "eisdir-job.json"),
      unread: false,
      notified: false,
    };
    writeFileSync(join(base, "eisdir-job.json"), JSON.stringify(job, null, 2), { mode: 0o600 });
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    await plugin.tool.background_stop.execute({ id: "eisdir-job" }, owner); // must not throw
    const st = readState(home, dir, "eisdir-job");
    expect(st.state).toBe("stopped");
    expect(st.notified).toBe(true);
    expect(st.summary.startsWith("[DONE STOPPED]")).toBe(true);
    expect(wakeCalls(client, OWNER)).toHaveLength(1);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it("compacting rich shape: running[] + unread[state] + read-hint", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const runId1 = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "live one" }, owner),
    );
    const doneId = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo rich" }, owner),
    );
    await waitDiskTerminal(home, dir, doneId);
    const out = { context: [] as string[] };
    await (plugin as any)["experimental.session.compacting"]({}, out);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain(`running=[${runId1}]`);
    expect(out.context[0]).toContain(`${doneId} [completed]`);
    expect(out.context[0]).toContain("background_read(");
    await plugin.tool.background_stop.execute({ id: runId1 }, owner);
  });

  it("compacting caps unread at 10 oldest with an overflow note", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const ids: string[] = [];
    for (let n = 0; n < 11; n++) {
      const id = runId(
        await plugin.tool.background_run.execute({ kind: "bash", prompt: `echo cap-${n}` }, owner),
      );
      ids.push(id);
      await waitDiskTerminal(home, dir, id);
    }
    const out = { context: [] as string[] };
    await (plugin as any)["experimental.session.compacting"]({}, out);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain("running=[]");
    expect(out.context[0]).toContain("(+1 more)");
    const shown = (out.context[0].match(/\[completed\]/g) ?? []).length;
    expect(shown).toBe(10); // the 10 oldest; the 11th lives behind the overflow note
    expect(out.context[0]).toContain(ids[0]); // oldest shown
    expect(out.context[0]).not.toContain(ids[10]); // newest held back
  });
});
