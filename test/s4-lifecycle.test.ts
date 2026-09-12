// S4 lifecycle — real-timer behavioral burn-down of S4-COV tickets.
// Through the public tool surface + exported hooks (runBoundedPool,
// pruneOldJobs) only. No fake timers here (see s4-reaper.test.ts).
// Covers: pool misuse (S4-COV-03), prune matrix (S4-COV-05), heartbeat
// malformed/format (S4-COV-01), deadline/timeout matrix (S4-COV-02),
// tool-surface fallbacks (S4-COV-14), event/compact hooks (S4-COV-15),
// notify guards (S4-COV-09), dispatch combos (S4-COV-07), poll/bashes
// envelopes (S4-COV-10/11).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
  waitFanin,
  type MockClient,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const BG_SPEC = "../src/plugin/background.ts";

async function bgMod(): Promise<any> {
  return (await import(/* @vite-ignore */ BG_SPEC)) as any;
}

function pd(home: string, dir: string): string {
  return projectDir(home, dir);
}

/** Plant a job triple directly on disk with full field control. */
function plant(
  home: string,
  dir: string,
  id: string,
  opts: {
    state: string;
    kind?: string;
    child?: string;
    timeoutMinutes?: number;
    startedAt?: number;
    endedAt?: number;
    deadlineAt?: number;
    hb?: string | null; // null = no heartbeat file; undefined = fresh default
    output?: string;
  },
): void {
  const base = pd(home, dir);
  const now = Date.now();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const job: Record<string, unknown> = {
    id,
    kind: opts.kind ?? "bash",
    state: opts.state,
    prompt: `planted ${id}`,
    rootSessionID: OWNER,
    ownerSessionID: OWNER,
    startedAt: opts.startedAt ?? now - 60_000,
    timeoutMinutes: opts.timeoutMinutes ?? 15,
    title: `planted: ${id}`,
    summary: `planted ${id}`,
    outputPath: join(base, `${id}.md`),
    statePath: join(base, `${id}.json`),
    unread: false,
    notified: true,
  };
  if (opts.child !== undefined) (job as any).childSessionID = opts.child;
  if (opts.endedAt !== undefined) (job as any).endedAt = opts.endedAt;
  if (opts.deadlineAt !== undefined) (job as any).deadlineAt = opts.deadlineAt;
  writeFileSync(join(base, `${id}.json`), JSON.stringify(job, null, 2), { mode: 0o600 });
  writeFileSync(join(base, `${id}.md`), opts.output ?? `# ${id}\n\nplanted\n`, { mode: 0o600 });
  if (opts.hb === null) return;
  writeFileSync(
    join(base, `${id}.heartbeat`),
    opts.hb ?? `${new Date().toISOString()} | planted\n`,
    { mode: 0o600 },
  );
}

function tripleExists(home: string, dir: string, id: string): boolean {
  const base = pd(home, dir);
  return (
    existsSync(join(base, `${id}.json`)) ||
    existsSync(join(base, `${id}.md`)) ||
    existsSync(join(base, `${id}.heartbeat`))
  );
}

describe("S4 pool misuse (S4-COV-03)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    void home;
  });
  afterEach(() => {
    restoreEnv();
  });

  it("non-array items resolve to a no-op zero result", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    expect(await bg.runBoundedPool({ client: 1 } as any, 3, 1000, async () => {})).toEqual({
      completed: 0,
      skipped: 0,
    });
  });

  it("non-function fn is a safe no-op that still drains", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    expect(await bg.runBoundedPool([1, 2, 3], 3, 5000, "nope" as any)).toEqual({
      completed: 3,
      skipped: 0,
    });
  });

  it("garbage limit still drains via a single worker", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const seen: number[] = [];
    const res = await bg.runBoundedPool([1, 2], 0, 5000, async (n: number) => {
      seen.push(n);
    });
    expect(res).toEqual({ completed: 2, skipped: 0 });
    expect(seen.sort()).toEqual([1, 2]);
  });

  it("zero budget defers everything to the next tick (never a reap)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const res = await bg.runBoundedPool([1, 2, 3], 3, 0, async () => {});
    expect(res).toEqual({ completed: 0, skipped: 3 });
  });

  it("one throwing item never stops the pool", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const done: number[] = [];
    const res = await bg.runBoundedPool([1, 2, 3], 2, 5000, async (n: number) => {
      if (n === 2) throw new Error("bad item");
      done.push(n);
    });
    expect(res).toEqual({ completed: 3, skipped: 0 });
    expect(done.sort()).toEqual([1, 3]);
  });
});

describe("S4 prune matrix (S4-COV-05)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("non-string cwd is a safe no-op", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    expect(bg.pruneOldJobs(undefined as any)).toEqual([]);
    expect(bg.pruneOldJobs({} as any)).toEqual([]);
  });

  it("evil inner id refuses the triple delete (path stays inside the project dir)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const bg = await bgMod();
    const base = pd(home, dir);
    // File name is benign; the crafted inner id carries separators.
    const evil = {
      id: "../../evil-escape",
      kind: "bash",
      state: "completed",
      prompt: "evil",
      rootSessionID: OWNER,
      ownerSessionID: OWNER,
      startedAt: Date.now() - 30 * 86_400_000,
      endedAt: Date.now() - 30 * 86_400_000,
      timeoutMinutes: 15,
      title: "evil",
      summary: "evil",
      outputPath: join(base, "evil.json.md"),
      statePath: join(base, "evil.json"),
      unread: false,
      notified: true,
    };
    writeFileSync(join(base, "evil.json"), JSON.stringify(evil), { mode: 0o600 });
    writeFileSync(join(base, "evil.json.heartbeat"), `${new Date().toISOString()} | evil\n`);
    writeFileSync(join(base, "evil.json.md"), "evil\n");
    bg.pruneOldJobs(dir);
    // Refused: nothing outside the dir was touched and the files remain.
    expect(existsSync(join(base, "evil.json"))).toBe(true);
  });

  it("live running memory entry is never evicted even when its disk record looks prunable", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 60" }, owner),
    );
    // Overwrite the DISK record to look like an old terminal job; memory stays running.
    const st = readState(home, dir, id);
    st.state = "completed";
    st.endedAt = Date.now() - 5 * 86_400_000;
    writeFileSync(join(pd(home, dir), `${id}.json`), JSON.stringify(st));
    bg.pruneOldJobs(dir);
    // Disk triple reaped (prunable on disk)…
    expect(existsSync(join(pd(home, dir), `${id}.json`))).toBe(false);
    // …but the live running entry survives in memory and still renders.
    const status = String(await plugin.tool.background_status.execute({}, owner));
    expect(status).toContain(id);
    expect(status).toContain("running");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });
});

describe("S4 heartbeat malformed/format (S4-COV-01)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  async function runningTask(): Promise<{ plugin: any; owner: any; dir: string; id: string }> {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "job" }, owner));
    return { plugin, owner, dir, id };
  }

  function hbPath(dir: string, id: string): string {
    return join(pd(home, dir), `${id}.heartbeat`);
  }

  it("heartbeat without a separator never breaks list/status", async () => {
    const t = await runningTask();
    writeFileSync(hbPath(t.dir, t.id), "garbage-with-no-separator\n");
    const list = String(await t.plugin.tool.background_list.execute({}, t.owner));
    expect(list).toContain(t.id);
    const status = String(await t.plugin.tool.background_status.execute({}, t.owner));
    expect(status).toContain(t.id);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("NaN-timestamp heartbeat never breaks list/status", async () => {
    const t = await runningTask();
    writeFileSync(hbPath(t.dir, t.id), "not-a-date | some step\n");
    const list = String(await t.plugin.tool.background_list.execute({}, t.owner));
    expect(list).toContain(t.id);
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("empty heartbeat file reads as missing (poll still owed, job survives)", async () => {
    const t = await runningTask();
    writeFileSync(hbPath(t.dir, t.id), "");
    const list = String(await t.plugin.tool.background_list.execute({}, t.owner));
    expect(list).toContain(t.id);
    expect(readState(home, t.dir, t.id).state).toBe("running");
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
  });

  it("queued job with a garbage heartbeat still renders (no-separator arm)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    plant(home, dir, "q-garbage", { state: "queued", hb: "garbage-with-no-separator\n" });
    const status = String(await plugin.tool.background_status.execute({}, owner));
    expect(status).toContain("q-garbage");
    expect(status).not.toContain("hb=");
  });

  it("no-timeout planted task never times out and exercises the timeout-0 arms", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    plant(home, dir, "nt-never", {
      state: "running",
      kind: "task",
      child: "child-nt2",
      timeoutMinutes: 0,
      hb: `${new Date(Date.now() - 600_000).toISOString()} | planted stale\n`,
    });
    await plugin.tool.background_list.execute({}, owner); // loads into memory
    await plugin.tool.background_list.execute({}, owner); // refresh: timeout-0 arms, stays running
    const st = readState(home, dir, "nt-never");
    expect(st.state).toBe("running");
    await plugin.tool.background_stop.execute({ id: "nt-never" }, owner);
  });

  it("prune evicts a terminal memory entry when its disk record ages out", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo age" }, owner));
    await waitTerminal(plugin, owner, id);
    // Age the disk record past retention; memory still holds the terminal entry.
    const st = readState(home, dir, id);
    st.endedAt = Date.now() - 5 * 86_400_000;
    writeFileSync(join(pd(home, dir), `${id}.json`), JSON.stringify(st));
    expect(bg.pruneOldJobs(dir)).toEqual([id]);
    expect(tripleExists(home, dir, id)).toBe(false);
    expect(String(await plugin.tool.background_list.execute({}, owner))).not.toContain(id);
  });

  it("minute-old heartbeat renders the minute arm on a queued job", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const fiveMin = new Date(Date.now() - 5 * 60_000).toISOString();
    plant(home, dir, "q-min", { state: "queued", hb: `${fiveMin} | queued wait\n` });
    const status = String(await plugin.tool.background_status.execute({}, owner));
    expect(status).toContain("q-min");
    expect(status).toMatch(/5m/);
  });

  it("hour-old heartbeat renders the hour arm on a queued job", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const ninetyMin = new Date(Date.now() - 90 * 60_000).toISOString();
    plant(home, dir, "q-hour", { state: "queued", hb: `${ninetyMin} | queued wait\n` });
    const status = String(await plugin.tool.background_status.execute({}, owner));
    expect(status).toContain("q-hour");
    expect(status).toMatch(/\d+h /);
  });
});

describe("S4 deadline/timeout matrix (S4-COV-02/10)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("legacy job without deadlineAt enforces via startedAt fallback (TIMEOUT stop)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    // Started 2h ago with a 60m timeout, no deadlineAt (pre-deadline record).
    plant(home, dir, "legacy-to", {
      state: "running",
      kind: "task",
      child: "child-legacy",
      timeoutMinutes: 60,
      startedAt: Date.now() - 2 * 3_600_000,
      hb: `${new Date().toISOString()} | refreshing task (0 assistant messages)\n`,
    });
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).toContain("legacy-to");
    // First list loads the planted record into memory; the second enforces.
    await plugin.tool.background_list.execute({}, owner);
    const st = readState(home, dir, "legacy-to");
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("TIMEOUT");
    expect(st.timedOut).toBe(true);
  });

  it("past-deadline job with a fresh heartbeat still polls (deadline defeats the skip)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    plant(home, dir, "past-dl", {
      state: "running",
      kind: "task",
      child: "child-past",
      timeoutMinutes: 60,
      startedAt: Date.now() - 2 * 3_600_000,
      deadlineAt: Date.now() - 60_000,
      hb: `${new Date().toISOString()} | refreshing task (0 assistant messages)\n`,
    });
    await plugin.tool.background_list.execute({}, owner);
    // First list loads the planted record; the second polls past-deadline.
    await plugin.tool.background_list.execute({}, owner);
    const st = readState(home, dir, "past-dl");
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("TIMEOUT");
  });
});

describe("S4 tool-surface fallbacks (S4-COV-14)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("timeout_minutes 0 clamps to the max instead of bricking the queue", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo hi", timeout_minutes: 0 }, owner),
    );
    await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).timeoutMinutes).toBe(48 * 60);
  });

  it("read serves an evicted job from disk (fresh boot, empty memory)", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "evicted-read", {
      state: "completed",
      output: "# evicted-read\n\n- id: evicted-read\n\n---\n\nevicted body\n",
    });
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const out = String(await plugin.tool.background_read.execute({ id: "evicted-read" }, owner));
    expect(out).toContain("evicted body");
  });

  it("steer serves an evicted job from disk and surfaces prompt failure honestly", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "evicted-steer", {
      state: "running",
      kind: "task",
      child: "child-evict",
    });
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async () => {
      throw new Error("parent gone");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    await expect(
      plugin.tool.background_steer.execute({ id: "evicted-steer", instruction: "go on" }, owner),
    ).rejects.toThrow("steer failed");
  });

  it("stop serves an evicted queued job from disk", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "evicted-q", { state: "queued" });
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const out = String(await plugin.tool.background_stop.execute({ id: "evicted-q" }, owner));
    expect(out).toContain("Stopped queued");
    expect(readState(home, dir, "evicted-q").state).toBe("stopped");
  });

  it("stop on a terminal job reports already-state (no double terminal path)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo done" }, owner));
    await waitTerminal(plugin, owner, id);
    expect(String(await plugin.tool.background_stop.execute({ id }, owner))).toContain("already completed");
  });

  it("steer on a terminal job is refused with state context", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo done" }, owner));
    await waitTerminal(plugin, owner, id);
    expect(String(await plugin.tool.background_steer.execute({ id, instruction: "more" }, owner))).toContain(
      "Cannot steer",
    );
  });
});

describe("S4 events + compact hooks (S4-COV-15)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    void home;
  });
  afterEach(() => {
    restoreEnv();
  });

  it("non-idle events are a silent no-op", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    await plugin.event({ event: { type: "session.create", properties: { sessionID: "x" } } });
    await plugin.event({ event: null });
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it("idle for an unknown session is a silent no-op", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "nope" } } });
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it("idle for one child refreshes it and skips the non-matching job", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const idA = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "A" }, owner));
    const idB = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "B" }, owner));
    const childA = readState(home, dir, idA).childSessionID;
    expect(childA).toBeTruthy();
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: childA } } });
    expect(readState(home, dir, idA).state).toBe("running");
    expect(readState(home, dir, idB).state).toBe("running");
    expect(client.tui.showToast).not.toHaveBeenCalled(); // nothing finalized => fully silent
    await plugin.tool.background_stop.execute({ id: idA }, owner);
    await plugin.tool.background_stop.execute({ id: idB }, owner);
  });

  it("steer surfaces non-Error rejections via the fallback arm", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "evicted-str", {
      state: "running",
      kind: "task",
      child: "child-str",
    });
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async () => {
      throw "plain-string-failure";
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    await expect(
      plugin.tool.background_steer.execute({ id: "evicted-str", instruction: "go on" }, owner),
    ).rejects.toThrow("steer failed");
  });

  it("idle skips the same-child job that is no longer running", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const idA = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "A2" }, owner));
    const childA = readState(home, dir, idA).childSessionID;
    // Completed record sharing the same child id (stale alias): loads into
    // memory, then the idle event must skip it via the non-running arm.
    plant(home, dir, "alias-done", {
      state: "completed",
      kind: "task",
      child: childA,
      endedAt: Date.now(),
    });
    await plugin.tool.background_list.execute({}, owner); // loads the alias
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: childA } } });
    expect(readState(home, dir, idA).state).toBe("running");
    expect(readState(home, dir, "alias-done").state).toBe("completed");
    await plugin.tool.background_stop.execute({ id: idA }, owner);
  });

  it("compact hook surfaces unread terminal jobs", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo unread" }, owner));
    for (let n = 0; n < 100 && readState(home, dir, id).state === "running"; n++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readState(home, dir, id).state).toBe("completed");
    const out = { context: [] as string[] };
    await plugin["experimental.session.compacting"]({}, out);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain(id);
  });

  it("compact hook carries running jobs and stays quiet when empty", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const emptyOut = { context: [] as string[] };
    await plugin["experimental.session.compacting"]({}, emptyOut);
    expect(emptyOut.context).toHaveLength(0);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "live" }, owner));
    const fullOut = { context: [] as string[] };
    await plugin["experimental.session.compacting"]({}, fullOut);
    expect(fullOut.context).toHaveLength(1);
    expect(fullOut.context[0]).toContain(id);
    await plugin.tool.background_stop.execute({ id }, owner);
  });
});

describe("S4 notify guards (S4-COV-09)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    void home;
  });
  afterEach(() => {
    restoreEnv();
  });

  it("idle event on a non-finalized child never notifies mid-run", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "mid" }, owner));
    const child = readState(home, dir, id).childSessionID;
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: child } } });
    expect(readState(home, dir, id).state).toBe("running");
    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(client.app.log).not.toHaveBeenCalled();
    await plugin.tool.background_stop.execute({ id }, owner);
  });
});

describe("S4 dispatch combos + error funnel (S4-COV-07)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    void home;
  });
  afterEach(() => {
    restoreEnv();
  });

  it("agent + model route into the child prompt (provider/model split)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute(
        { kind: "task", prompt: "do it", agent: "agent-x", model: "prov/mod" },
        owner,
      ),
    );
    const promptCall = client.session.promptAsync.mock.calls.find(
      (c: any) => c?.[0]?.path?.id !== OWNER,
    );
    expect(promptCall?.[0]?.body?.agent).toBe("agent-x");
    expect(promptCall?.[0]?.body?.model).toEqual({ providerID: "prov", modelID: "mod" });
    await plugin.tool.background_stop.execute({ id }, owner);
  });

  it("promptAsync down on all 3 tries fails the job with the backoff story", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async () => {
      throw new Error("boom-down");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "doomed" }, owner));
    const out = await waitTerminal(plugin, owner, id, 20000);
    expect(out).toContain("FAILED");
    const st = readState(home, dir, id);
    expect(st.state).toBe("failed");
    expect(st.summary).toContain("3 tries");
    await waitFanin(); // U4: terminal wake is debounced (≤200ms), not instant
    // 3 dispatch tries + 1 terminal wake-note (same mock, parent road).
    const dispatchCalls = client.session.promptAsync.mock.calls.filter(
      (c: any) => c?.[0]?.path?.id !== OWNER,
    );
    expect(dispatchCalls).toHaveLength(3);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(4);
  }, 20000);
});

describe("S4 poll envelopes + bash terminal (S4-COV-10/11)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  function assistantMsg(text: string, parts?: any[]): any {
    return {
      info: {
        role: "assistant",
        time: { completed: new Date().toISOString() },
        parts: parts ?? [{ type: "text", text }],
      },
    };
  }

  it("bare-array messages envelope (no .data wrapper) finalizes", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: [assistantMsg("bare win")] });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "bare" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll finalizes the done child
    await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).state).toBe("completed");
    expect(readState(home, dir, id).summary).toContain("bare win");
  });

  it("data.messages envelope finalizes", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: { messages: [assistantMsg("nested win")] } } });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "nested" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll finalizes the done child
    await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).summary).toContain("nested win");
  });

  it("info.parts-only message finalizes (parts fallback arm)", async () => {
    const dir = makeWorkdir();
    const msg = {
      info: {
        role: "assistant",
        time: { completed: new Date().toISOString() },
        parts: [{ type: "text", text: "deep parts" }],
      },
    };
    const client = makeClient({ messages: { data: [msg] } });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "deep" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll finalizes the done child
    await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).summary).toContain("deep parts");
  });

  it("non-text / blank parts fall back to the no-text-output body", async () => {
    const dir = makeWorkdir();
    const msg = assistantMsg("ignored", [{ type: "image", src: "x" }, { type: "text", text: "   " }]);
    const client = makeClient({ messages: { data: [msg] } });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "mute" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll finalizes the done child
    const out = await waitTerminal(plugin, owner, id);
    expect(out).toContain("(no text output)");
  });

  it("messageless data envelope stays pending (no assistants, no crash)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: { foo: 1 } } });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "shapezz" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll: no assistants => pending
    expect(readState(home, dir, id).state).toBe("running");
    await plugin.tool.background_stop.execute({ id }, owner);
  });

  it("parts-less completed message falls back to the no-text-output body", async () => {
    const dir = makeWorkdir();
    const msg = { info: { role: "assistant", time: { completed: new Date().toISOString() } } };
    const client = makeClient({ messages: { data: [msg] } });
    client.session.get.mockImplementation(async () => null);
    client.session.info.mockImplementation(async () => null);
    client.session.listMessages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "bare2" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll finalizes the done child
    const out = await waitTerminal(plugin, owner, id);
    expect(out).toContain("(no text output)");
  });

  it("sync-throwing messages fail the job honestly (API-down path)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.messages.mockImplementation(() => {
      throw "sync-down-string";
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "unlucky" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll throws synchronously
    const out = await waitTerminal(plugin, owner, id);
    expect(out).toContain("sync-down-string");
    expect(readState(home, dir, id).state).toBe("failed");
  });

  it("non-Error dispatch rejection funnels through the string fallback", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.create.mockImplementation(() => {
      throw "string-down";
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "strdoom" }, owner));
    const out = await waitTerminal(plugin, owner, id, 20000);
    expect(out).toContain("FAILED");
    expect(readState(home, dir, id).summary).toContain("string-down");
  }, 20000);

  it("future heartbeat counts as fresh (clock-skew arm, child never polled)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    plant(home, dir, "skew-task", {
      state: "running",
      kind: "task",
      child: "child-skew",
      timeoutMinutes: 60,
      hb: `${future} | refreshing task (0 assistant messages)\n`,
    });
    await plugin.tool.background_list.execute({}, owner); // loads into memory
    const pollsBefore = client.session.messages.mock.calls.length;
    await plugin.tool.background_list.execute({}, owner); // skew => skip, no poll
    expect(client.session.messages.mock.calls.length).toBe(pollsBefore);
    expect(readState(home, dir, "skew-task").state).toBe("running");
    await plugin.tool.background_stop.execute({ id: "skew-task" }, owner);
  });

  it("async-rejecting messages doubt the poll (stays running, never fails)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.messages.mockImplementation(async () => {
      throw new Error("async-down");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "flaky" }, owner));
    await plugin.tool.background_list.execute({}, owner); // poll rejects => null shape => pending
    expect(readState(home, dir, id).state).toBe("running");
    await plugin.tool.background_stop.execute({ id }, owner);
  });

  it("legacy timeout survives a rejecting abort (best-effort abort arm)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: { data: [] } });
    client.session.abort.mockImplementation(async () => {
      throw new Error("abort-down");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    plant(home, dir, "legacy-abort", {
      state: "running",
      kind: "task",
      child: "child-abort",
      timeoutMinutes: 60,
      startedAt: Date.now() - 2 * 3_600_000,
      hb: `${new Date().toISOString()} | refreshing task (0 assistant messages)\n`,
    });
    await plugin.tool.background_list.execute({}, owner); // loads into memory
    await plugin.tool.background_list.execute({}, owner); // timeout fires despite abort failure
    const st = readState(home, dir, "legacy-abort");
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("TIMEOUT");
  });

  it("manual stop survives a rejecting abort (best-effort abort arm)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.abort.mockImplementation(async () => {
      throw new Error("abort-down");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "stopme" }, owner));
    expect(String(await plugin.tool.background_stop.execute({ id }, owner))).toContain("Stopped");
    expect(readState(home, dir, id).state).toBe("stopped");
  });

  it("terminal transition survives rejecting observability sinks", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.app.log.mockImplementation(async () => {
      throw new Error("log-down");
    });
    client.tui.showToast.mockImplementation(async () => {
      throw new Error("toast-down");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo sink" }, owner));
    await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).state).toBe("completed");
  });

  it("malformed-shape state warns once across rescans (dedupe arm)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const base = pd(home, dir);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeFileSync(join(base, "bad-shape.json"), JSON.stringify({ nope: true }), { mode: 0o600 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await plugin.tool.background_list.execute({}, owner); // first scan warns
      expect(err).toHaveBeenCalled();
      const calls = err.mock.calls.length;
      plant(home, dir, "bump", { state: "completed", endedAt: Date.now() }); // mtime bump => rescan
      await plugin.tool.background_list.execute({}, owner); // dedupe: no second warn
      expect(err.mock.calls.length).toBe(calls);
    } finally {
      err.mockRestore();
    }
  });

  it("read falls back to summary when the output file is gone", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "no-output", { state: "completed", endedAt: Date.now(), output: "gone soon\n" });
    const base = pd(home, dir);
    const { unlinkSync } = await import("fs");
    unlinkSync(join(base, "no-output.md"));
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const out = String(await plugin.tool.background_read.execute({ id: "no-output" }, owner));
    expect(out).toContain("completed");
  });

  it("orphaned running bash record (no live child) finalizes via the refresh path", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "orphan-bash", {
      state: "running",
      kind: "bash",
      output: "# orphan\n\n- id: orphan\n\n---\n\norphan body\n",
    });
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    await plugin.tool.background_list.execute({}, owner); // loads the orphan into memory
    await plugin.tool.background_list.execute({}, owner); // refresh sees no child => completes
    expect(readState(home, dir, "orphan-bash").state).toBe("completed");
  });

  it("orphan refresh falls back to the exit-code body when output is gone", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "orphan-noout", { state: "running", kind: "bash" });
    const base = pd(home, dir);
    const { unlinkSync } = await import("fs");
    unlinkSync(join(base, "orphan-noout.md"));
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    await plugin.tool.background_list.execute({}, owner); // loads into memory
    await plugin.tool.background_list.execute({}, owner); // refresh: fallback body
    expect(readState(home, dir, "orphan-noout").state).toBe("completed");
  });

  it("unknown ids fail closed with No-job on read/steer/stop", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    expect(String(await plugin.tool.background_read.execute({ id: "nope" }, owner))).toContain("No job");
    expect(String(await plugin.tool.background_steer.execute({ id: "nope", instruction: "x" }, owner))).toContain(
      "No job",
    );
    expect(String(await plugin.tool.background_stop.execute({ id: "nope" }, owner))).toContain("No job");
  });

  it("stop serves an evicted RUNNING job from disk (restart-durable stop)", async () => {
    const dir = makeWorkdir();
    plant(home, dir, "evicted-run", {
      state: "running",
      kind: "bash",
      output: "# evicted\n\n---\n\npartial\n",
    });
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const out = String(await plugin.tool.background_stop.execute({ id: "evicted-run" }, owner));
    expect(out).toContain("Stopped evicted-run");
    expect(readState(home, dir, "evicted-run").state).toBe("stopped");
  });

  it("null-returning promptAsync dispatches fine (optional-chain arm)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockResolvedValueOnce(null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "null-ok" }, owner));
    expect(readState(home, dir, id).state).toBe("running");
    await plugin.tool.background_stop.execute({ id }, owner);
  });
  it("bash non-zero exit lands failed with the code in the body", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "exit 3" }, owner));
    await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).state).toBe("failed");
  });

  it("bash past-deadline is SIGTERMed and stopped as TIMEOUT", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute(
        { kind: "bash", prompt: "sleep 30", timeout_minutes: 0.02 },
        owner,
      ),
    );
    await new Promise((r) => setTimeout(r, 1800)); // pass the ~1.2s deadline
    await plugin.tool.background_list.execute({}, owner); // refresh enforces timeout => SIGTERM
    const out = await waitTerminal(plugin, owner, id, 15000);
    expect(out).toContain("TIMEOUT");
    expect(readState(home, dir, id).state).toBe("stopped");
    expect(readState(home, dir, id).timedOut).toBe(true);
  }, 15000);
});
