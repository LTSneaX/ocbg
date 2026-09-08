// G2 — idle reaper two-signal (sweepIdleJobs + heartbeat/output/child silence).
// Fake timers capture the 60s sweep interval at boot; advancing the clock fires
// ticks. BG_IDLE_CLOSE_MS=120000 so tick@60s is fresh and tick@120s+ is stale.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
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
  projectDir,
  completedMessages,
  staleActivity,
  freshActivityDynamic,
  type MockClient,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const IDLE_ENV = { BG_IDLE_CLOSE_MS: "120000" };

function heartbeatFile(home: string, dir: string, id: string): string {
  return join(projectDir(home, dir), `${id}.heartbeat`);
}

function writeHeartbeat(home: string, dir: string, id: string, iso: string, step: string): void {
  writeFileSync(heartbeatFile(home, dir, id), `${iso} | ${step}\n`, { mode: 0o600 });
}

describe("G2 reaper two-signal", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    restoreEnv();
  });

  async function startTask(opts?: { messages?: unknown; lookup?: unknown }): Promise<{
    plugin: any;
    client: MockClient;
    dir: string;
    owner: any;
    id: string;
  }> {
    const dir = makeWorkdir();
    const client = makeClient({ messages: opts?.messages, lookup: opts?.lookup });
    // messages mock doubles as the child-activity lookup when lookup is unset:
    // point listMessages/get/info at the same payload via lookup passthrough.
    if (opts?.messages !== undefined && opts?.lookup === undefined) {
      const payload = opts.messages;
      client.session.get.mockImplementation(async () => null);
      client.session.info.mockImplementation(async () => null);
      client.session.listMessages.mockImplementation(async () => null);
      client.session.messages.mockImplementation(async () => payload);
    }
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "long job" }, owner));
    return { plugin, client, dir, owner, id };
  }

  it("fresh heartbeat => skip (children never polled, still running)", async () => {
    const t = await startTask();
    await vi.advanceTimersByTimeAsync(61_000); // first sweep tick: heartbeat 61s < 120s
    expect(readState(home, t.dir, t.id).state).toBe("running");
    // child lookup APIs never touched while the heartbeat is fresh
    expect(t.client.session.messages).not.toHaveBeenCalled();
    expect(t.client.session.get).not.toHaveBeenCalled();
  });

  it("stale heartbeat + silent child => reap with auto-idle-close label", async () => {
    const t = await startTask({ messages: staleActivity(10) });
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
    // reaped jobs still notify (wake road fires once)
    expect(t.client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it("stale heartbeat + FRESH child => skip (still running)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    client.session.messages.mockImplementation(async () => freshActivityDynamic());
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "busy job" }, owner));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, dir, id).state).toBe("running");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("missing heartbeat => skip (cannot prove stillness)", async () => {
    const t = await startTask({ messages: staleActivity(10) });
    unlinkSync(heartbeatFile(home, t.dir, t.id));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner); // cleanup
  });

  it("unparseable heartbeat => skip", async () => {
    const t = await startTask({ messages: staleActivity(10) });
    writeFileSync(heartbeatFile(home, t.dir, t.id), "garbage with no separator\n", { mode: 0o600 });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner); // cleanup
  });

  it("future heartbeat (clock skew) => treated fresh, skip", async () => {
    const t = await startTask({ messages: staleActivity(10) });
    writeHeartbeat(home, t.dir, t.id, new Date(Date.now() + 600_000).toISOString(), "skewed future");
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner); // cleanup
  });

  it("completion-wins: done child finalizes completed, never auto-idle-close", async () => {
    const t = await startTask({ messages: completedMessages("finished work") });
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("completed");
    expect(st.summary).not.toContain("auto-idle-close");
    expect(t.client.session.abort).not.toHaveBeenCalled();
  });

  it("dispatch-mid-flight (no childSessionID) + stale heartbeat => skip", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.create.mockImplementation(() => new Promise(() => {})); // hangs forever
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    // do not await: create never resolves; jobs.set already ran so the job is
    // in-memory running WITHOUT childSessionID and WITHOUT any saved files.
    const runP = plugin.tool.background_run.execute({ kind: "task", prompt: "hang" }, owner);
    await vi.advanceTimersByTimeAsync(10);
    const list1 = String(await plugin.tool.background_list.execute({}, owner));
    const m = /^- (\S+) \[task\/running\]/m.exec(list1);
    expect(m).toBeTruthy();
    const id = (m as RegExpExecArray)[1];
    const status1 = String(await plugin.tool.background_status.execute({ id }, owner));
    expect(status1).toContain("child=-"); // no child session yet (dispatch mid-flight)
    writeHeartbeat(home, dir, id, new Date(Date.now() - 600_000).toISOString(), "stale");
    await vi.advanceTimersByTimeAsync(200_000);
    const list2 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list2).toContain(`${id} [task/running]`);
    expect(client.session.create).toHaveBeenCalledTimes(1); // no retry storm, still first attempt
    void runP;
  });

  it("bash stale output => reap and SIGTERM the child", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 30" }, owner));
    // NOTE: a silent `sleep` never emits a chunk, so no .md exists yet and the
    // reaper fail-closes (unresolvable stat => skip). Simulate an emitted-then-
    // idle child by writing the output file directly with a real (now-stale) mtime.
    writeFileSync(join(projectDir(home, dir), `${id}.md`), "$ sleep 30\n[started]\n", { mode: 0o600 });
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, dir, id);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
  });

  it("bash fresh heartbeat => skip (output never consulted)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 30" }, owner));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(readState(home, dir, id).state).toBe("running");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup kills sleep
  });

  it("numeric-ms activity stamps count as activity (stale number => reap)", async () => {
    const staleMs = Date.now() - 600_000;
    const t = await startTask({ messages: { data: { timeUpdated: staleMs, messages: [] } } });
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
  });

  it("lookup via session.get success also proves silence (first-shape win)", async () => {
    // makeClient(lookup) serves the SAME stale payload on get/info/messages:
    // taskChildLooksSilent takes the first working shape (get).
    const t = await startTask({ lookup: staleActivity(10) });
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
  });

  it("lookup falls through get-fail to info-success", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => staleActivity(10));
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "fallthrough" }, owner));
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, dir, id);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
  });

  it("heartbeat file keeps its 50-line cap across many polls", async () => {
    const t = await startTask();
    // force many poll heartbeats via list refreshes (real calls, fake clock static)
    for (let i = 0; i < 60; i++) {
      await t.plugin.tool.background_list.execute({}, t.owner);
    }
    const lines = readFileSync(heartbeatFile(home, t.dir, t.id), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(existsSync(heartbeatFile(home, t.dir, t.id))).toBe(true);
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner); // cleanup
  });
});
