// S4 reaper burn-down (fake timers ONLY — isolated from real-timer suites).
// Drives the 60s sweep via advanceTimersByTimeAsync to close S4-COV tickets:
// lookup-shape matrix (S4-COV-12), sweep skip/reap arms (S4-COV-13),
// no-timeout reap (S4-COV-09/B-066), NaN-heartbeat skip (S4-COV-01/B-012).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "fs";
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
  type MockClient,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const IDLE_ENV = { BG_IDLE_CLOSE_MS: "120000" };

function hbPath(home: string, dir: string, id: string): string {
  return join(projectDir(home, dir), `${id}.heartbeat`);
}

function staleHeartbeat(home: string, dir: string, id: string): void {
  writeFileSync(
    hbPath(home, dir, id),
    `${new Date(Date.now() - 10 * 60_000).toISOString()} | test stale\n`,
    { mode: 0o600 },
  );
}

function staleIso(): string {
  return new Date(Date.now() - 10 * 60_000).toISOString();
}

/** Live running task job with a stale heartbeat, ready for the next sweep. */
async function staleTask(
  home: string,
  client: MockClient,
  opts?: { lookup?: unknown; messages?: unknown },
): Promise<{ plugin: any; dir: string; owner: any; id: string; client: MockClient }> {
  const dir = makeWorkdir();
  const plugin = await boot({ dir, client, env: IDLE_ENV });
  const owner = makeCtx(OWNER, dir);
  const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "job" }, owner));
  void home;
  staleHeartbeat(home, dir, id);
  return { plugin, dir, owner, id, client };
}

describe("S4 sweep lookup shapes (S4-COV-12)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    restoreEnv();
  });

  it("info-only lookup proves silence (get/messages/listMessages absent)", async () => {
    const client = makeClient({ messages: { data: [] } });
    client.session.get.mockImplementation(async () => null);
    client.session.messages.mockImplementation(async () => ({ data: [] }));
    client.session.listMessages.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => ({ data: { timeUpdated: staleIso() } }));
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
  });

  it("listMessages-only lookup proves silence (first three shapes absent)", async () => {
    const client = makeClient({ messages: { data: [] } });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    // The poll-shape must also be unresolvable, or its truthy-but-staleless
    // payload wins the lookup race and correctly doubts the reap.
    client.session.messages.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => ({
      data: { timeUpdated: staleIso() },
    }));
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("root envelope without .data proves silence (no-wrapper shape)", async () => {
    const lookup = { timeUpdated: staleIso() };
    const client = makeClient({ messages: { data: [] }, lookup });
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("bag.data message envelope proves silence", async () => {
    const lookup = { data: { messages: { data: [{ timeCreated: staleIso() }] } } };
    const client = makeClient({ messages: { data: [] }, lookup });
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("info.messages envelope proves silence", async () => {
    const lookup = { data: { info: { messages: [{ timeCreated: staleIso() }] } } };
    const client = makeClient({ messages: { data: [] }, lookup });
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("numeric-seconds stamp scales to ms and proves silence", async () => {
    const secs = Math.floor((Date.now() - 10 * 60_000) / 1000);
    const lookup = { data: { messages: [{ timeCreated: secs }] } };
    const client = makeClient({ messages: { data: [] }, lookup });
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("session without any lookup shape skips (doubt wins, still running)", async () => {
    const bareClient = {
      session: {},
      app: { log: vi.fn(async () => ({})) },
      tui: { showToast: vi.fn(async () => ({})) },
    } as any;
    const dir = makeWorkdir();
    // create must exist for dispatch; lookups stay absent afterwards.
    bareClient.session.create = vi.fn(async () => ({ data: { id: "child-x" } }));
    bareClient.session.promptAsync = vi.fn(async () => ({}));
    bareClient.session.abort = vi.fn(async () => ({}));
    const plugin = await boot({ dir, client: bareClient });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "job" }, owner));
    staleHeartbeat(home, dir, id);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, dir, id).state).toBe("running");
    expect(bareClient.tui.showToast).not.toHaveBeenCalled();
  });
});

describe("S4 sweep skip/reap arms (S4-COV-13/09/01)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    restoreEnv();
  });

  it("sweep never touches non-running jobs", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    // Planted terminal record (no live child, no memory entry): the sweep
    // iterates memory only, and sweepOneJob guards non-running anyway.
    const base = projectDir(home, dir);
    const now = Date.now();
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const job = {
      id: "old-done",
      kind: "bash",
      state: "completed",
      prompt: "planted",
      rootSessionID: OWNER,
      ownerSessionID: OWNER,
      startedAt: now - 60_000,
      endedAt: now - 30_000,
      timeoutMinutes: 15,
      title: "planted",
      summary: "planted done",
      outputPath: join(base, "old-done.md"),
      statePath: join(base, "old-done.json"),
      unread: false,
      notified: true,
    };
    writeFileSync(join(base, "old-done.json"), JSON.stringify(job, null, 2));
    writeFileSync(join(base, "old-done.md"), "# planted\n");
    writeFileSync(
      join(base, "old-done.heartbeat"),
      `${new Date(now - 600_000).toISOString()} | planted stale\n`,
    );
    await plugin.tool.background_list.execute({}, owner); // loads into memory as completed
    await vi.advanceTimersByTimeAsync(300_000);
    const st = readState(home, dir, "old-done");
    expect(st.state).toBe("completed");
    expect(st.summary).not.toContain("auto-idle-close");
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("no-timeout job (timeoutMinutes 0) still reaps on proven silence", async () => {
    const dir = makeWorkdir();
    const lookup = { data: { timeUpdated: staleIso() } };
    const client = makeClient({ messages: { data: [] }, lookup });
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    // Planted: timeoutMinutes 0 (uncreatable via the clamped surface) + stale
    // silence. Loaded into memory via list, heartbeat re-staled after the poll.
    const base = projectDir(home, dir);
    const now = Date.now();
    const job = {
      id: "no-timeout",
      kind: "task",
      state: "running",
      prompt: "planted",
      rootSessionID: OWNER,
      ownerSessionID: OWNER,
      childSessionID: "child-nt",
      startedAt: now - 60_000,
      timeoutMinutes: 0,
      title: "planted: no-timeout",
      summary: "planted",
      outputPath: join(base, "no-timeout.md"),
      statePath: join(base, "no-timeout.json"),
      unread: true,
      notified: false,
    };
    writeFileSync(join(base, "no-timeout.json"), JSON.stringify(job, null, 2));
    writeFileSync(join(base, "no-timeout.md"), "# planted\n");
    writeFileSync(join(base, "no-timeout.heartbeat"), `${new Date(now - 600_000).toISOString()} | planted\n`);
    await plugin.tool.background_list.execute({}, owner); // loads into memory (poll refreshes hb)
    staleHeartbeat(home, dir, "no-timeout"); // re-stale after the load poll
    await plugin.tool.background_list.execute({}, owner); // refresh on timeout-0: skip arms, stays running
    expect(readState(home, dir, "no-timeout").state).toBe("running");
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, dir, "no-timeout");
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("auto-idle-close");
  });

  it("completion-wins the sweep race: done child finalizes, never auto-idle-close", async () => {
    const doneAt = new Date().toISOString();
    const doneMsgs = {
      data: [{ info: { role: "assistant", time: { completed: doneAt }, parts: [{ type: "text", text: "won" }] } }],
    };
    const client = makeClient({ messages: doneMsgs, lookup: { data: { timeUpdated: staleIso() } } });
    // Poll-shape doubles as the silence lookup except messages (pending-shaped
    // here would shadow); completion lands on the forced refresh first.
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "racer" }, owner));
    staleHeartbeat(home, dir, id);
    await vi.advanceTimersByTimeAsync(200_000);
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.summary).not.toContain("auto-idle-close");
  });

  it("future output mtime counts as fresh (bash clock-skew arm, never reaped)", async () => {
    const dir = makeWorkdir();
    const lookup = { data: { timeUpdated: staleIso() } };
    const client = makeClient({ messages: { data: [] }, lookup });
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const base = projectDir(home, dir);
    const now = Date.now();
    const job = {
      id: "skew-bash",
      kind: "bash",
      state: "running",
      prompt: "planted",
      rootSessionID: OWNER,
      ownerSessionID: OWNER,
      startedAt: now - 60_000,
      timeoutMinutes: 0,
      title: "planted",
      summary: "planted",
      outputPath: join(base, "skew-bash.md"),
      statePath: join(base, "skew-bash.json"),
      unread: true,
      notified: false,
    };
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeFileSync(join(base, "skew-bash.json"), JSON.stringify(job, null, 2));
    writeFileSync(join(base, "skew-bash.md"), "# planted\n");
    // Output written "in the future": provably NOT silent even with a stale hb.
    const future = new Date(now + 3_600_000);
    utimesSync(join(base, "skew-bash.md"), future, future);
    writeFileSync(join(base, "skew-bash.heartbeat"), `${new Date(now - 600_000).toISOString()} | planted\n`);
    await plugin.tool.background_list.execute({}, owner); // loads into memory
    staleHeartbeat(home, dir, "skew-bash"); // re-stale after the load poll
    await vi.advanceTimersByTimeAsync(200_000);
    // Still running: skew mtime defeats the silence proof (and timeout-0
    // defeats the timeout path, so nothing else could have stopped it either).
    expect(readState(home, dir, "skew-bash").state).toBe("running");
    await plugin.tool.background_stop.execute({ id: "skew-bash" }, owner);
  });

  it("garbage-string lookup payload doubts the reap (non-object envelope)", async () => {
    const client = makeClient({ messages: null as any });
    client.session.messages.mockImplementation(async () => null);
    client.session.get.mockImplementation(async () => "just-a-string");
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    expect(client.session.get).toHaveBeenCalled();
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("malformed-string stamp doubts the reap (unparseable activity)", async () => {
    const lookup = { data: { timeUpdated: "not-a-date!!", messages: [] } };
    const client = makeClient({ messages: null as any, lookup });
    client.session.messages.mockImplementation(async () => null);
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("sub-second numeric stamp doubts the reap (no scale matches)", async () => {
    const lookup = { data: { timeUpdated: 123 } };
    const client = makeClient({ messages: null as any, lookup });
    client.session.messages.mockImplementation(async () => null);
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("hanging silence probe times out to SKIP (sweep never wedges)", async () => {
    const client = makeClient({ messages: null as any });
    client.session.messages.mockImplementation(async () => null);
    client.session.get.mockImplementation(() => new Promise(() => {})); // hangs forever
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("reap survives a rejecting sweep log sink (best-effort observability)", async () => {
    const lookup = { data: { timeUpdated: staleIso() } };
    const client = makeClient({ messages: { data: [] }, lookup });
    client.app.log.mockImplementation(async () => {
      throw new Error("log-down");
    });
    const t = await staleTask(home, client);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("NaN-timestamp heartbeat skips the sweep (unprovable, child never polled)", async () => {
    const lookup = { data: { timeUpdated: staleIso() } };
    const client = makeClient({ messages: { data: [] }, lookup });
    const t = await staleTask(home, client);
    writeFileSync(hbPath(home, t.dir, t.id), "not-a-date | bogus step\n");
    const pollsBefore = client.session.messages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    expect(client.session.get).not.toHaveBeenCalled();
    expect(client.session.messages.mock.calls.length).toBe(pollsBefore);
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });
});
