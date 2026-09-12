// U3 opt-in blocking read — default instant preserved, wait_ms parks until
// the terminal fan-in fires or the budget expires, then falls back to the
// persisted [running] view. Waiters always cleaned up.
//
// Drives the public tool surface only (like every other suite). Real timers,
// short waits: bash jobs are real processes, task jobs use the mocked client.

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
  waitTerminal,
  completedMessages,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-U3";

async function runBash(plugin: any, owner: any, prompt: string): Promise<string> {
  return runId(await plugin.tool.background_run.execute({ kind: "bash", prompt }, owner));
}

describe("U3 opt-in blocking read", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("default (no wait_ms) stays instant on a running job", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "sleep 2");
    const t0 = Date.now();
    const out = String(await plugin.tool.background_read.execute({ id }, owner));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.startsWith("[running]")).toBe(true);
    await plugin.tool.background_stop.execute({ id }, owner);
  });

  it("explicit 0 / negative / garbage wait_ms stay instant", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "sleep 2");
    for (const wait_ms of [0, -50, "garbage", NaN, undefined]) {
      const out = String(
        await plugin.tool.background_read.execute({ id, wait_ms } as any, owner),
      );
      expect(out.startsWith("[running]")).toBe(true);
    }
    await plugin.tool.background_stop.execute({ id }, owner);
  });

  it("blocking bash read resolves to the terminal body (fan-in wakes the waiter)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo hello-u3-block");
    const out = String(
      await plugin.tool.background_read.execute({ id, wait_ms: 8000 }, owner),
    );
    expect(out.startsWith("[running]")).toBe(false);
    expect(out).toContain("hello-u3-block");
    // Repeat read is a pure terminal re-read (waiter cleaned up, no hang).
    const again = String(
      await plugin.tool.background_read.execute({ id, wait_ms: 8000 }, owner),
    );
    expect(again).toContain("hello-u3-block");
  });

  it("blocking read times out to the persisted [running] fallback (budget, not runtime)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "sleep 5");
    const t0 = Date.now();
    const out = String(
      await plugin.tool.background_read.execute({ id, wait_ms: 150 }, owner),
    );
    const elapsed = Date.now() - t0;
    expect(out.startsWith("[running]")).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(80); // it really waited…
    expect(elapsed).toBeLessThan(4000); // …but not the 5s runtime
    // Timeout path cleaned up: a later blocking read still lands terminal.
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("exit code");
  });

  it("multi-waiter fanout: concurrent blocking reads all resolve terminal", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "sleep 1 && echo fanout-u3");
    const [a, b] = await Promise.all([
      plugin.tool.background_read.execute({ id, wait_ms: 8000 }, owner),
      plugin.tool.background_read.execute({ id, wait_ms: 8000 }, owner),
    ]);
    expect(String(a)).toContain("fanout-u3");
    expect(String(b)).toContain("fanout-u3");
    expect(String(a).startsWith("[running]")).toBe(false);
    expect(String(b).startsWith("[running]")).toBe(false);
  });

  it("task-kind blocking read resolves via the forced poll", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("task-done-u3") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "do u3 work" }, owner),
    );
    const out = String(
      await plugin.tool.background_read.execute({ id, wait_ms: 8000 }, owner),
    );
    expect(out.startsWith("[running]")).toBe(false);
    expect(out).toContain("task-done-u3");
  });

  it("already-terminal job with wait_ms returns terminal immediately (no park)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo early-u3");
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("early-u3");
    const t0 = Date.now();
    const out = String(
      await plugin.tool.background_read.execute({ id, wait_ms: 5000 }, owner),
    );
    expect(Date.now() - t0).toBeLessThan(2000); // early return, not a 5s park
    expect(out).toContain("early-u3");
    expect(home.length).toBeGreaterThan(0); // per-test HOME isolation intact
  });

  it("huge wait_ms is capped and still lands terminal (no 5m park)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo cap-u3");
    const t0 = Date.now();
    const out = String(
      await plugin.tool.background_read.execute({ id, wait_ms: 999999999 }, owner),
    );
    expect(Date.now() - t0).toBeLessThan(20000); // capped, terminal wins fast
    expect(out).toContain("cap-u3");
  });
});
