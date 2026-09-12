// Phase 2 Slice 4 FINAL — F5 sweep budget + F6 polish guards.
//
// r8 strip: the runBoundedPool unit describes are gone (helper is
// module-private — pool semantics are proven behaviorally by the sweep
// integration below through the public tool surface). Kept: sweep
// integration (pool preserves reap semantics; overlapping ticks skip via
// the reentrancy guard, never double) + F6 polish guards: heartbeat
// coalesce (F6.1), refresh no-refetch backstop (F6.2), read-without-rewrite
// (F6.3), single-timer double-boot (F6.5).
// F6.4/F6.6 are comment-only (accepted-noise / certified-minimal) — covered by
// the unchanged existing suites staying green.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
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
  waitTerminal,
  completedMessages,
  staleActivity,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const IDLE_ENV = { BG_IDLE_CLOSE_MS: "120000" };

function heartbeatFile(home: string, dir: string, id: string): string {
  return join(projectDir(home, dir), `${id}.heartbeat`);
}

function writeStaleHeartbeat(home: string, dir: string, id: string): void {
  writeFileSync(
    heartbeatFile(home, dir, id),
    `${new Date(Date.now() - 600_000).toISOString()} | stale\n`,
    { mode: 0o600 },
  );
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("F5 sweep integration (fake timers)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    restoreEnv();
  });

  it("pool preserves reap semantics: N stale jobs all reap exactly once", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    client.session.messages.mockImplementation(async () => staleActivity(10));
    const plugin = await boot({ dir, client, env: IDLE_ENV });
    const owner = makeCtx(OWNER, dir);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(runId(await plugin.tool.background_run.execute({ kind: "task", prompt: `pool job ${i}` }, owner)));
    }
    for (const id of ids) writeStaleHeartbeat(home, dir, id);
    await vi.advanceTimersByTimeAsync(200_000);
    for (const id of ids) {
      const st = readState(home, dir, id);
      expect(st.state).toBe("stopped");
      expect(st.summary).toContain("auto-idle-close");
    }
    // exactly one abort per reap: the pool neither drops nor doubles jobs
    expect(client.session.abort).toHaveBeenCalledTimes(6);
    expect(client.tui.showToast).toHaveBeenCalledTimes(6);
  });

  it("reentrancy: overlapping tick skips with a log line, never double-polls", async () => {
    // 44 jobs x 5s hung-probe timeouts / 3 workers ~= 75s of sweep with the
    // budget raised out of the way: the tick at +120s MUST find the +60s
    // sweep still in flight and skip it (log line, zero work). Concurrency
    // cap raised so all 44 actually run (default cap 10 would queue 34).
    const dir = makeWorkdir();
    const client = makeClient();
    const hang = (): Promise<unknown> => new Promise(() => {});
    client.session.get.mockImplementation(hang);
    client.session.info.mockImplementation(hang);
    client.session.listMessages.mockImplementation(hang);
    client.session.messages.mockImplementation(hang);
    const plugin = await boot({
      dir,
      client,
      env: { ...IDLE_ENV, BG_SWEEP_BUDGET_MS: "300000", BG_MAX_CONCURRENT_JOBS: "50" },
    });
    const owner = makeCtx(OWNER, dir);
    const ids: string[] = [];
    for (let i = 0; i < 44; i++) {
      ids.push(runId(await plugin.tool.background_run.execute({ kind: "task", prompt: `reentrancy ${i}` }, owner)));
    }
    for (const id of ids) writeStaleHeartbeat(home, dir, id);
    expect(client.session.messages).not.toHaveBeenCalled();
    // Ticks fire at +60s (sweep starts; every probe hangs till its 5s
    // timeout, which resolves to SKIP) and +120s (must skip: first sweep runs
    // till ~+135s). No budget expiry on this path (300s raised budget).
    await vi.advanceTimersByTimeAsync(130_000);
    // The overlapping tick left its best-effort skip line and did zero work:
    // every messages call belongs to the single in-flight sweep.
    const idleLog = join(projectDir(home, dir), "last-idle.log");
    expect(existsSync(idleLog)).toBe(true);
    expect(readFileSync(idleLog, "utf8")).toContain("already in flight");
    expect(readFileSync(idleLog, "utf8")).not.toContain("budget exhausted");
    expect(client.session.messages.mock.calls.length).toBeLessThanOrEqual(44);
    expect(client.session.messages.mock.calls.length).toBeGreaterThan(0);
    // Timeout-pressure resolves to SKIP, never to a reap: nothing reaped.
    for (const id of ids) {
      expect(readState(home, dir, id).state).toBe("running");
    }
    expect(client.session.abort).not.toHaveBeenCalled();
    // Cleanup: stop everything (abort mock is immediate).
    for (const id of ids) {
      await plugin.tool.background_stop.execute({ id }, owner);
    }
  });

  it("budget-expiry: remaining jobs defer to the next tick, never reaped", async () => {
    // Default 20s budget, same 44 hung-probe jobs (cap raised so all run):
    // the sweep must stop taking new jobs at ~+80s, log the deferral, and
    // reap nothing.
    const dir = makeWorkdir();
    const client = makeClient();
    const hang = (): Promise<unknown> => new Promise(() => {});
    client.session.get.mockImplementation(hang);
    client.session.info.mockImplementation(hang);
    client.session.listMessages.mockImplementation(hang);
    client.session.messages.mockImplementation(hang);
    const plugin = await boot({ dir, client, env: { ...IDLE_ENV, BG_MAX_CONCURRENT_JOBS: "50" } });
    const owner = makeCtx(OWNER, dir);
    const ids: string[] = [];
    for (let i = 0; i < 44; i++) {
      ids.push(runId(await plugin.tool.background_run.execute({ kind: "task", prompt: `budget ${i}` }, owner)));
    }
    for (const id of ids) writeStaleHeartbeat(home, dir, id);
    await vi.advanceTimersByTimeAsync(130_000);
    const idleLog = join(projectDir(home, dir), "last-idle.log");
    expect(existsSync(idleLog)).toBe(true);
    expect(readFileSync(idleLog, "utf8")).toContain("budget exhausted");
    expect(readFileSync(idleLog, "utf8")).toContain("deferred to next tick");
    // Only the pre-expiry waves polled; the rest were deferred untouched.
    expect(client.session.messages.mock.calls.length).toBeGreaterThan(0);
    expect(client.session.messages.mock.calls.length).toBeLessThan(44);
    for (const id of ids) {
      expect(readState(home, dir, id).state).toBe("running");
    }
    expect(client.session.abort).not.toHaveBeenCalled();
    for (const id of ids) {
      await plugin.tool.background_stop.execute({ id }, owner);
    }
  });

  it("F6.5: double factory invocation in one module arms a single reaper timer", async () => {
    const dir1 = makeWorkdir();
    const dir2 = makeWorkdir();
    const client = makeClient();
    vi.resetModules();
    // Variable indirection (helpers.ts pattern): a literal ".ts" import path
    // fails tsc TS5097 without allowImportingTsExtensions.
    const spec = "../src/plugin/background.ts";
    const mod = (await import(/* @vite-ignore */ spec)) as any;
    const factory = mod.default ?? mod.BackgroundOps;
    const before = vi.getTimerCount();
    await factory({ client, directory: dir1 } as any);
    await factory({ client, directory: dir2 } as any);
    expect(vi.getTimerCount() - before).toBe(1);
  });
});

describe("F6 polish guards (real timers)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("F6.1: rapid polls keep heartbeat <=50 lines with the last step correct", async () => {
    const dir = makeWorkdir();
    const client = makeClient(); // {data:[]} => never completes
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "hb coalesce" }, owner));
    await plugin.tool.background_list.execute({}, owner); // dispatch step => polls
    await plugin.tool.background_list.execute({}, owner); // fresh => skip
    await plugin.tool.background_list.execute({}, owner); // fresh => skip
    const lines = readFileSync(heartbeatFile(home, dir, id), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(lines[lines.length - 1]).toContain("refreshing task");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("F6.2: fresh-heartbeat running task skips the network fetch", async () => {
    const dir = makeWorkdir();
    const client = makeClient(); // {data:[]} => never completes
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "steady" }, owner));
    await plugin.tool.background_list.execute({}, owner); // dispatch step => polls
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    client.session.messages.mockClear();
    await plugin.tool.background_list.execute({}, owner); // fresh poll hb => no refetch
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(readState(home, dir, id).state).toBe("running");
    // Age the heartbeat past the 60s skip window => the fetch happens again.
    writeFileSync(
      heartbeatFile(home, dir, id),
      `${new Date(Date.now() - 120_000).toISOString()} | refreshing task (0 assistant messages)\n`,
      { mode: 0o600 },
    );
    await plugin.tool.background_list.execute({}, owner);
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("F6.2: a genuinely-done child still finalizes (dispatch step never skipped)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("f62 done") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "finishing" }, owner));
    await plugin.tool.background_list.execute({}, owner); // first poll owed => finalizes
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.summary).toContain("[DONE COMPLETED]");
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("F6.3: read-twice is identical, unread cleared, second read performs no rewrite", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo read-twice-probe" }, owner));
    const body1 = await waitTerminal(plugin, owner, id); // terminal read clears unread
    expect(readState(home, dir, id).unread).toBe(false);
    const mtime1 = statSync(join(projectDir(home, dir), `${id}.json`)).mtimeMs;
    await delay(20);
    const body2 = String(await plugin.tool.background_read.execute({ id }, owner));
    const mtime2 = statSync(join(projectDir(home, dir), `${id}.json`)).mtimeMs;
    expect(body2).toBe(body1); // identical bytes, no throw
    expect(mtime2).toBe(mtime1); // no state rewrite on the repeat read
    expect(readState(home, dir, id).unread).toBe(false);
  });
});
