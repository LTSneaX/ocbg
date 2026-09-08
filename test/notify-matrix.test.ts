// G1 — wake/notify funnel (notifyJob L364-447).
// Matrix: wake{on,off} x notify{on,off} x {completed, failed, stopped, timeout}
// + mid-run no-op + double-notify idempotence. All via public tool surface.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  waitTerminal,
  wakeCalls,
  completedMessages,
  type MockClient,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";

interface JobCtx {
  plugin: any;
  client: MockClient;
  dir: string;
  owner: any;
  id: string;
}

describe("G1 notify matrix", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  async function startTask(opts?: {
    notify?: boolean;
    messages?: unknown;
    timeout?: number;
    wakeOff?: boolean;
    prompt?: string;
  }): Promise<JobCtx> {
    const dir = makeWorkdir();
    const client = makeClient({ messages: opts?.messages });
    const plugin = await boot({
      dir,
      client,
      env: opts?.wakeOff ? { BG_WAKE_NOTE: "false" } : undefined,
    });
    const owner = makeCtx(OWNER, dir);
    const args: any = { kind: "task", prompt: opts?.prompt ?? "do the thing" };
    if (opts?.notify !== undefined) args.notify_on_complete = opts.notify;
    if (opts?.timeout !== undefined) args.timeout_minutes = opts.timeout;
    const id = runId(await plugin.tool.background_run.execute(args, owner));
    return { plugin, client, dir, owner, id };
  }

  async function startBash(opts?: {
    notify?: boolean;
    wakeOff?: boolean;
    cmd?: string;
  }): Promise<JobCtx> {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({
      dir,
      client,
      env: opts?.wakeOff ? { BG_WAKE_NOTE: "false" } : undefined,
    });
    const owner = makeCtx(OWNER, dir);
    const args: any = { kind: "bash", prompt: opts?.cmd ?? "echo hello" };
    if (opts?.notify !== undefined) args.notify_on_complete = opts.notify;
    const id = runId(await plugin.tool.background_run.execute(args, owner));
    return { plugin, client, dir, owner, id };
  }

  // --- completed (task refresh path) x 4 wake/notify combos ---

  it("completed + notify-on + wake-on: full signal (wake, toast, app.log, file, DONE)", async () => {
    const t = await startTask({ messages: completedMessages("the answer is 42") });
    await t.plugin.tool.background_list.execute({}, t.owner);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("completed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(1);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
    const notes = readNotifications(home, t.dir);
    expect(notes.find((n: any) => n.id === t.id)?.event).toBe("done");
    expect(st.summary.startsWith("[DONE COMPLETED]")).toBe(true);
    expect(readOutput(home, t.dir, t.id)).toContain("[DONE COMPLETED]");
  });

  it("completed + notify-off: gated (no wake/toast/DONE) but file + app.log still written", async () => {
    const t = await startTask({ notify: false, messages: completedMessages("done quietly") });
    await t.plugin.tool.background_list.execute({}, t.owner);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("completed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1); // always-on sink
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)).toBeTruthy();
    expect(st.summary.startsWith("[DONE")).toBe(false); // no DONE marker when gated
    expect(st.notified).toBe(true); // marked: no retry storm
  });

  it("completed + wake-off: transcript silent, toast + DONE + logs carry the signal", async () => {
    const t = await startTask({ wakeOff: true, messages: completedMessages("silent wake") });
    await t.plugin.tool.background_list.execute({}, t.owner);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("completed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(st.summary.startsWith("[DONE COMPLETED]")).toBe(true);
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)?.event).toBe("done");
  });

  it("completed + notify-off + wake-off: fully quiet except always-on sinks", async () => {
    const t = await startTask({
      notify: false,
      wakeOff: true,
      messages: completedMessages("fully quiet"),
    });
    await t.plugin.tool.background_list.execute({}, t.owner);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("completed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
    expect(st.summary.startsWith("[DONE")).toBe(false);
  });

  // --- failed (bash close path) x 4 combos ---

  it("failed + notify-on + wake-on: error toast + error log level + failed event", async () => {
    const t = await startBash({ cmd: "exit 3" });
    await waitTerminal(t.plugin, t.owner, t.id);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("failed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(1);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    const toastArg = t.client.tui.showToast.mock.calls[0][0];
    expect(toastArg?.body?.variant).toBe("error");
    const logArg = t.client.app.log.mock.calls[0][0];
    expect(logArg?.body?.level).toBe("error");
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)?.event).toBe("failed");
    expect(st.summary).toContain("[DONE FAILED]");
  });

  it("failed + notify-off: gated, always-on sinks only", async () => {
    const t = await startBash({ notify: false, cmd: "exit 3" });
    await waitTerminal(t.plugin, t.owner, t.id);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("failed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
    expect(st.summary.startsWith("[DONE")).toBe(false);
  });

  it("failed + wake-off: no transcript, toast + DONE still fire", async () => {
    const t = await startBash({ wakeOff: true, cmd: "exit 3" });
    await waitTerminal(t.plugin, t.owner, t.id);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("failed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(st.summary).toContain("[DONE FAILED]");
  });

  it("failed + notify-off + wake-off: always-on sinks only", async () => {
    const t = await startBash({ notify: false, wakeOff: true, cmd: "exit 3" });
    await waitTerminal(t.plugin, t.owner, t.id);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("failed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
  });

  // --- stopped (manual stop path) x 4 combos ---

  async function stoppedJob(opts?: { notify?: boolean; wakeOff?: boolean }): Promise<JobCtx> {
    const t = await startTask({ notify: opts?.notify, wakeOff: opts?.wakeOff });
    await t.plugin.tool.background_list.execute({}, t.owner); // confirm still running
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
    return t;
  }

  it("stopped + notify-on + wake-on: full signal with stopped event", async () => {
    const t = await stoppedJob();
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(1);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)?.event).toBe("stopped");
    expect(st.summary).toContain("[DONE STOPPED]");
  });

  it("stopped + notify-off: gated, always-on sinks only", async () => {
    const t = await stoppedJob({ notify: false });
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
    expect(st.summary.startsWith("[DONE")).toBe(false);
  });

  it("stopped + wake-off: no transcript, toast + DONE still fire", async () => {
    const t = await stoppedJob({ wakeOff: true });
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(st.summary).toContain("[DONE STOPPED]");
  });

  it("stopped + notify-off + wake-off: always-on sinks only", async () => {
    const t = await stoppedJob({ notify: false, wakeOff: true });
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
  });

  // --- timeout (deadline path) x 4 combos ---

  async function timeoutJob(opts?: { notify?: boolean; wakeOff?: boolean }): Promise<JobCtx> {
    const t = await startTask({
      notify: opts?.notify,
      wakeOff: opts?.wakeOff,
      timeout: 0.001, // ~60ms deadline
    });
    await new Promise((r) => setTimeout(r, 250)); // let the deadline pass (real time)
    await t.plugin.tool.background_list.execute({}, t.owner); // refresh enforces timeout
    return t;
  }

  it("timeout + notify-on + wake-on: timeout event + timedOut flag + timeout toast", async () => {
    const t = await timeoutJob();
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.timedOut).toBe(true);
    expect(wakeCalls(t.client, OWNER)).toHaveLength(1);
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)?.event).toBe("timeout");
    const toastMsg: string = t.client.tui.showToast.mock.calls[0][0]?.body?.message ?? "";
    expect(toastMsg).toContain("timed out");
    expect(st.summary).toContain("[DONE STOPPED]");
  });

  it("timeout + notify-off: gated, always-on sinks only", async () => {
    const t = await timeoutJob({ notify: false });
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.timedOut).toBe(true);
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
    expect(st.summary.startsWith("[DONE")).toBe(false);
  });

  it("timeout + wake-off: no transcript, toast + DONE still fire", async () => {
    const t = await timeoutJob({ wakeOff: true });
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(st.summary).toContain("[DONE STOPPED]");
  });

  it("timeout + notify-off + wake-off: always-on sinks only", async () => {
    const t = await timeoutJob({ notify: false, wakeOff: true });
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    expect(t.client.app.log).toHaveBeenCalledTimes(1);
  });

  // --- guards: mid-run no-op + idempotence ---

  it("mid-run job never notifies and never burns the single-writer flag", async () => {
    const t = await startTask(); // messages {data:[]} => never completes
    await t.plugin.tool.background_list.execute({}, t.owner);
    await t.plugin.tool.background_status.execute({}, t.owner);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(0);
    expect(t.client.tui.showToast).not.toHaveBeenCalled();
    const st = readState(home, t.dir, t.id);
    expect(st.notified).toBe(false);
    expect(st.summary.startsWith("[DONE")).toBe(false);
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner); // cleanup
  });

  it("double-notify is impossible: repeated list/status/read fire exactly one wake", async () => {
    const t = await startTask({ messages: completedMessages("once only") });
    await t.plugin.tool.background_list.execute({}, t.owner);
    expect(readState(home, t.dir, t.id).state).toBe("completed");
    expect(wakeCalls(t.client, OWNER)).toHaveLength(1);
    await t.plugin.tool.background_list.execute({}, t.owner);
    await t.plugin.tool.background_status.execute({}, t.owner);
    await t.plugin.tool.background_read.execute({ id: t.id }, t.owner);
    await t.plugin.tool.background_list.execute({}, t.owner);
    expect(wakeCalls(t.client, OWNER)).toHaveLength(1);
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
  });
});
