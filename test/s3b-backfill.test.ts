// S3b backfill — surface-driven error/host-scream path coverage.
//
// Closes uncovered lines via the PUBLIC tool surface only (no src changes):
// human-id exhaustion (96), BG_PROJECT_ID pin (126), throwing factory input
// (162), marker-as-dir harden (195), pool garbage budget (453), reaper
// stat-unresolvable skip (465), evil lookup payload skip (492), queued TASK
// drain (743), DONE-marker read fallback (908), no-summary finalize error
// (912 + refreshBashJob funnel 993-1000), null-messages poll (958),
// sync-throw poll (961-963), slow-abort reap (1106).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
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
  projectDir,
  staleActivity,
  waitTerminal,
  type MockClient,
} from "./helpers.js";

saveEnv();

const BG_SPEC = "../src/plugin/background.ts";
const OWNER = "owner-A";
const IDLE_ENV = { BG_IDLE_CLOSE_MS: "120000" };

function heartbeatFile(home: string, dir: string, id: string): string {
  return join(projectDir(home, dir), `${id}.heartbeat`);
}

function backdateHeartbeat(home: string, dir: string, id: string, minutesAgo: number): void {
  const iso = new Date(Date.now() - minutesAgo * 60000).toISOString();
  writeFileSync(heartbeatFile(home, dir, id), `${iso} | stale-step\n`, { mode: 0o600 });
}

describe("S3b backfill surface paths", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    delete process.env.BG_PROJECT_ID;
    restoreEnv();
  });

  it("human-id exhaustion throws a shaped error (factory throw shape)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_JOB_ID_TYPE: "human" } });
    const owner = makeCtx(OWNER, dir);
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const first = runId(
        await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo one" }, owner),
      );
      expect(first).toBe("swift-amber-falcon");
      await expect(
        plugin.tool.background_run.execute({ kind: "bash", prompt: "echo two" }, owner),
      ).rejects.toThrow(/exhausted human-readable id space/);
      const body = await waitTerminal(plugin, owner, first);
      expect(body).toContain("one");
    } finally {
      randSpy.mockRestore();
    }
  });

  it("BG_PROJECT_ID pins the project dir (override branch)", async () => {
    process.env.BG_PROJECT_ID = "s3b-pin-123";
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo pinned" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("pinned");
    const pinned = createHash("sha1").update("s3b-pin-123").digest("hex").slice(0, 12);
    expect(existsSync(join(home, ".local", "share", "opencode", "background-ops", pinned, `${id}.json`))).toBe(
      true,
    );
  });

  it("factory input with a throwing session getter boots clientless (isClientLike guard)", async () => {
    vi.resetModules();
    const mod = (await import(/* @vite-ignore */ BG_SPEC)) as any;
    const evilInput: any = { directory: makeWorkdir(), extra: 1 };
    Object.defineProperty(evilInput, "session", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("evil session getter");
      },
    });
    const plugin: any = await mod.default(evilInput);
    const out = String(await plugin.tool.background_config.execute({}, makeCtx(OWNER, evilInput.directory)));
    expect(out).toContain("background-ops v");
    // Clientless boot still runs bash jobs end to end.
    const owner = makeCtx(OWNER, evilInput.directory);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo clientless-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("clientless-ok");
  });

  it("perms marker as a directory degrades current=false without breaking boot", async () => {
    const dir = makeWorkdir();
    const pdir = projectDir(home, dir);
    mkdirSync(pdir, { recursive: true });
    mkdirSync(join(pdir, ".perms-hardened")); // existsSync true, readFileSync EISDIR
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo harden-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("harden-ok");
  });

  it("runBoundedPool throwing budget resolves the safe no-op (outer guard)", async () => {
    vi.resetModules();
    const mod = (await import(/* @vite-ignore */ BG_SPEC)) as any;
    const evilBudget = { valueOf() { throw new Error("evil budget"); } };
    await expect(
      mod.runBoundedPool([], 1, evilBudget as any, async () => {}),
    ).resolves.toEqual({ completed: 0, skipped: 0 });
  });

  it("reaper skips bash with unresolvable output stat (missing .md)", async () => {
    vi.useFakeTimers();
    try {
      const dir = makeWorkdir();
      const plugin = await boot({ dir, client: makeClient(), env: IDLE_ENV });
      const owner = makeCtx(OWNER, dir);
      const id = runId(
        await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 30" }, owner),
      );
      backdateHeartbeat(home, dir, id, 10); // stale heartbeat, but no .md was ever written
      await vi.advanceTimersByTimeAsync(200_000);
      expect(readState(home, dir, id).state).toBe("running");
      await plugin.tool.background_stop.execute({ id }, owner); // cleanup kills sleep
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaper skips task whose lookup payload throws inside extraction", async () => {
    vi.useFakeTimers();
    try {
      const evil: any = {};
      Object.defineProperty(evil, "data", {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("evil data getter");
        },
      });
      const dir = makeWorkdir();
      const client = makeClient({ lookup: evil });
      const plugin = await boot({ dir, client, env: IDLE_ENV });
      const owner = makeCtx(OWNER, dir);
      const id = runId(
        await plugin.tool.background_run.execute({ kind: "task", prompt: "evil lookup" }, owner),
      );
      backdateHeartbeat(home, dir, id, 10);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(readState(home, dir, id).state).toBe("running");
      await plugin.tool.background_stop.execute({ id }, owner); // cleanup
    } finally {
      vi.useRealTimers();
    }
  });

  it("queued TASK drains when the slot frees (pumpQueue task branch)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: { BG_MAX_CONCURRENT_JOBS: "1" } });
    const owner = makeCtx(OWNER, dir);
    const first = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 20" }, owner),
    );
    const queuedRes: any = await plugin.tool.background_run.execute(
      { kind: "task", prompt: "queued task work" },
      owner,
    );
    expect(queuedRes?.metadata?.queued).toBe(true);
    const second = runId(queuedRes);
    await plugin.tool.background_stop.execute({ id: first }, owner);
    const start = Date.now();
    let st: any = null;
    while (Date.now() - start < 8000) {
      st = readState(home, dir, second);
      if (st.state === "running" && st.childSessionID) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(st.state).toBe("running");
    expect(st.childSessionID).toBe(client.__childId);
    await plugin.tool.background_stop.execute({ id: second }, owner); // cleanup
  });

  it("DONE-marker read failure falls back to summary persist (app.log sabotage)", async () => {
    const dir = makeWorkdir();
    const pdir = projectDir(home, dir);
    const client = makeClient();
    client.app.log.mockImplementation(async () => {
      for (const f of readdirSync(pdir)) {
        if (f.endsWith(".md")) unlinkSync(join(pdir, f));
      }
      return {};
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo s3b-fallback" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("[DONE COMPLETED]");
    expect(body).toContain("s3b-fallback");
    expect(readOutput(home, dir, id)).toContain("[DONE COMPLETED]");
  });

  it("hand-written running bash without summary finalizes then errors loudly (funnel + notify guard)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const dir = makeWorkdir();
      const plugin = await boot({ dir, client: makeClient() });
      const owner = makeCtx(OWNER, dir);
      const id = "hand-made-job-1";
      const pdir = projectDir(home, dir);
      writeFileSync(
        join(pdir, `${id}.json`),
        JSON.stringify({
          id,
          kind: "bash",
          state: "running",
          prompt: "hand",
          rootSessionID: OWNER,
          ownerSessionID: OWNER,
          startedAt: Date.now(),
          timeoutMinutes: 1440,
          title: "hand",
          outputPath: join(pdir, `${id}.md`),
          statePath: join(pdir, `${id}.json`),
          unread: true,
          notified: false,
          // NOTE: no summary field on purpose — notifyJob must hit its guard.
        }),
      );
      writeFileSync(join(pdir, `${id}.md`), "");
      // background_read jobs.set()s into memory BEFORE its own render throws
      // on the missing summary — this primes memory without a render path.
      await expect(
        plugin.tool.background_read.execute({ id }, owner),
      ).rejects.toThrow();
      await expect(plugin.tool.background_list.execute({}, owner)).rejects.toThrow();
      expect(readState(home, dir, id).state).toBe("completed");
      const blob = errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
      expect(blob).toContain("notifyJob error");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("null messages shape polls to the busy heartbeat (no-shape branch)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.messages.mockImplementation(async () => null);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "busy" }, owner));
    const status = String(await plugin.tool.background_status.execute({ id }, owner));
    expect(status).toContain("poll: no messages shape (child busy?)");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("sync-throwing messages fails the poll with a shaped summary (poll guard)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.messages.mockImplementation(() => {
      throw new Error("sync boom");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "sync fail" }, owner),
    );
    await plugin.tool.background_status.execute({ id }, owner); // refresh hits the guard
    const st = readState(home, dir, id);
    expect(st.state).toBe("failed");
    expect(st.summary).toContain("Exception polling child");
  });

  it("slow abort resolves the reap to slow-path heartbeat (reapSlow branch)", async () => {
    vi.useFakeTimers();
    try {
      const dir = makeWorkdir();
      const client: MockClient = makeClient({ lookup: staleActivity(10) });
      client.session.abort.mockImplementation(() => new Promise(() => {})); // hangs forever
      const plugin = await boot({ dir, client, env: IDLE_ENV });
      void plugin;
      const owner = makeCtx(OWNER, dir);
      const id = runId(
        await plugin.tool.background_run.execute({ kind: "task", prompt: "slow abort" }, owner),
      );
      backdateHeartbeat(home, dir, id, 10);
      await vi.advanceTimersByTimeAsync(200_000);
      // stopJobInternal never lands (abort hangs) — the sweep records slow-path and moves on.
      const hb = readFileSync(heartbeatFile(home, dir, id), "utf8");
      expect(hb).toContain("slow abort continues in background");
      expect(readState(home, dir, id).state).toBe("running");
      // NOTE: no stop cleanup — abort hangs by design; pending promise holds no handles.
    } finally {
      vi.useRealTimers();
    }
  });
});
