// U4 all-complete debounced fan-in — per-parent cycle token + unref'd
// 50-200ms timer + fresh remainingCount at ALL notify sites.
//
// Drives the public tool surface only (like every other suite). Real timers:
// the debounce window is wall-clock (default 100ms, max 200ms); waitFanin
// (350ms) settles every window deterministically. Bash jobs are real
// processes clustered with sleep so burst completions land inside one window.

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
  readNotifications,
  waitTerminal,
  wakeCalls,
  waitFanin,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-U4";

async function runBash(plugin: any, owner: any, prompt: string): Promise<string> {
  return runId(await plugin.tool.background_run.execute({ kind: "bash", prompt }, owner));
}

function wakeText(client: any, owner: string, index = 0): string {
  return String(wakeCalls(client, owner)[index]?.[0]?.body?.parts?.[0]?.text ?? "");
}

describe("U4 all-complete debounced fan-in", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("burst coalesces 3 rapid completions into ONE parent wake (all ids, remaining 0)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    // Same sleep clusters all three completions inside one debounce window.
    const ids = [
      await runBash(plugin, owner, "sleep 0.5 && echo burst-u4-a"),
      await runBash(plugin, owner, "sleep 0.5 && echo burst-u4-b"),
      await runBash(plugin, owner, "sleep 0.5 && echo burst-u4-c"),
    ];
    for (const id of ids) await waitTerminal(plugin, owner, id);
    // Persisted-first: every DONE marker is already durable while the wake
    // may still be in flight.
    for (const id of ids) {
      expect(readState(home, dir, id).summary).toContain("[DONE COMPLETED]");
    }
    await waitFanin();
    const wakes = wakeCalls(client, OWNER);
    expect(wakes).toHaveLength(1); // N-turn spam killed: one turn, not three
    const text = wakeText(client, OWNER);
    expect(text.startsWith("OCBG |")).toBe(true);
    for (const id of ids) expect(text).toContain(id);
    expect(text).toContain("3 jobs finished");
    expect(text).toContain("0 remaining");
    expect(text).toContain("Untrusted child output");
  });

  it("token isolation: two parents get one wake each, carrying only their own ids", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const ownerA = makeCtx("owner-U4-A", dir);
    const ownerB = makeCtx("owner-U4-B", dir);
    const a1 = await runBash(plugin, ownerA, "sleep 0.5 && echo iso-a1");
    const a2 = await runBash(plugin, ownerA, "sleep 0.5 && echo iso-a2");
    const b1 = await runBash(plugin, ownerB, "sleep 0.5 && echo iso-b1");
    await waitTerminal(plugin, ownerA, a1);
    await waitTerminal(plugin, ownerA, a2);
    await waitTerminal(plugin, ownerB, b1);
    await waitFanin();
    const wakesA = wakeCalls(client, "owner-U4-A");
    const wakesB = wakeCalls(client, "owner-U4-B");
    expect(wakesA).toHaveLength(1);
    expect(wakesB).toHaveLength(1);
    const textA = wakeText(client, "owner-U4-A");
    expect(textA).toContain(a1);
    expect(textA).toContain(a2);
    expect(textA).not.toContain(b1);
    const textB = wakeText(client, "owner-U4-B");
    expect(textB).toContain(b1);
    expect(textB).not.toContain(a1);
    expect(textB).not.toContain(a2);
  });

  it("remainingCount accuracy: stop-fanin sees the pumped queued job as remaining, then 0", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: { BG_MAX_CONCURRENT_JOBS: "1" } });
    const owner = makeCtx(OWNER, dir);
    const slow = await runBash(plugin, owner, "sleep 20");
    const q1 = await runBash(plugin, owner, "sleep 1 && echo q1-u4");
    const q2 = await runBash(plugin, owner, "echo q2-u4");
    expect(readState(home, dir, q1).state).toBe("queued");
    expect(readState(home, dir, q2).state).toBe("queued");
    await plugin.tool.background_stop.execute({ id: slow }, owner); // q1 pumps to running, q2 stays queued
    await waitFanin();
    // Stop-fanin fired while q1 runs and q2 waits: 1 running + 1 queued.
    let wakes = wakeCalls(client, OWNER);
    expect(wakes).toHaveLength(1);
    let text = wakeText(client, OWNER);
    expect(text).toContain(slow);
    expect(text).toContain("2 remaining");
    expect(text).toContain("1 running + 1 queued");
    // Drain the rest: q1 completes naturally, q2 runs, stop it for cleanup.
    await waitTerminal(plugin, owner, q1);
    await waitTerminal(plugin, owner, q2);
    await plugin.tool.background_stop.execute({ id: q2 }, owner).catch(() => null);
    await waitFanin();
    wakes = wakeCalls(client, OWNER);
    expect(wakes.length).toBeGreaterThanOrEqual(2);
    const last = wakeText(client, OWNER, wakes.length - 1);
    expect(last).toContain("0 remaining");
  });

  it("persisted-first: DONE + state + notifications.log durable before the wake lands", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: { BG_U4_DEBOUNCE_MS: "200" } });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "sleep 0.2 && echo persist-u4");
    await waitTerminal(plugin, owner, id);
    // Max window still in flight: nothing woke yet, everything durable.
    expect(wakeCalls(client, OWNER)).toHaveLength(0);
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.notified).toBe(true);
    expect(st.summary).toContain("[DONE COMPLETED]");
    expect(readNotifications(home, dir).find((n: any) => n.id === id)?.event).toBe("done");
    await waitFanin();
    expect(wakeCalls(client, OWNER)).toHaveLength(1);
    expect(wakeText(client, OWNER)).toContain(id);
  });

  it("kill-switch BG_U4_FANIN=0 restores immediate per-job wakes (legacy road)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: { BG_U4_FANIN: "0" } });
    const owner = makeCtx(OWNER, dir);
    const id1 = await runBash(plugin, owner, "sleep 0.3 && echo legacy-u4-a");
    const id2 = await runBash(plugin, owner, "sleep 0.3 && echo legacy-u4-b");
    await waitTerminal(plugin, owner, id1);
    await waitTerminal(plugin, owner, id2);
    await waitFanin();
    const wakes = wakeCalls(client, OWNER);
    expect(wakes).toHaveLength(2); // no coalescing on the legacy road
    expect(wakeText(client, OWNER, 0)).toContain(id1);
    expect(wakeText(client, OWNER, 1)).toContain(id2);
  });

  it("garbage BG_U4_DEBOUNCE_MS falls back to the default window (still one wake)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: { BG_U4_DEBOUNCE_MS: "garbage!!" } });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo clamp-u4");
    await waitTerminal(plugin, owner, id);
    await waitFanin();
    expect(wakeCalls(client, OWNER)).toHaveLength(1);
    expect(wakeText(client, OWNER)).toContain(id);
  });

  it("busy parent: combined failure queues ONE bundle; hook delivers both ids once", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) => {
      if (arg?.path?.id === OWNER) throw new Error("parent busy");
      return {};
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id1 = await runBash(plugin, owner, "sleep 0.3 && echo busy-u4-a");
    const id2 = await runBash(plugin, owner, "sleep 0.3 && echo busy-u4-b");
    await waitTerminal(plugin, owner, id1);
    await waitTerminal(plugin, owner, id2);
    await waitFanin();
    // One combined attempt (stale cycles never send), still queued.
    expect(wakeCalls(client, OWNER)).toHaveLength(1);
    const out1: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out1);
    expect(out1.message.parts).toHaveLength(1);
    expect(out1.message.parts[0].text).toContain("pending notifications (1)");
    expect(out1.message.parts[0].text).toContain(id1);
    expect(out1.message.parts[0].text).toContain(id2);
    const out2: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out2);
    expect(out2.message.parts).toHaveLength(0);
  });

  it("cross-site coalescing: manual stop + natural completion share one wake", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const sleeper = await runBash(plugin, owner, "sleep 20");
    const quick = await runBash(plugin, owner, "sleep 0.3 && echo quick-u4");
    await waitTerminal(plugin, owner, quick); // natural terminal schedules first
    await plugin.tool.background_stop.execute({ id: sleeper }, owner); // manual stop joins the same window
    await waitFanin();
    const wakes = wakeCalls(client, OWNER);
    expect(wakes).toHaveLength(1);
    const text = wakeText(client, OWNER);
    expect(text).toContain(quick);
    expect(text).toContain(sleeper);
    expect(readState(home, dir, sleeper).state).toBe("stopped");
  });
});
