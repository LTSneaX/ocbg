// G4 — deadline immutability + steer cap (L2) + timeout labeling.
// Steer storm: 10 steers => 5 succeed, 5 capped, deadlineAt byte-identical.
// Timeout label: timedOut flag vs stopped-at-deadline vs substring fallback.

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
  type MockClient,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";

describe("G4 deadline + steer", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  async function pendingTask(): Promise<{
    plugin: any;
    client: MockClient;
    dir: string;
    owner: any;
    id: string;
  }> {
    const dir = makeWorkdir();
    const client = makeClient(); // {data:[]} => never completes on its own
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "long haul" }, owner));
    return { plugin, client, dir, owner, id };
  }

  it("10x steer storm: first 5 succeed, rest capped, deadlineAt never moves", async () => {
    const t = await pendingTask();
    const before = readState(home, t.dir, t.id);
    const deadlineAt0 = before.deadlineAt as number;
    expect(typeof deadlineAt0).toBe("number");
    const startedAt0 = before.startedAt as number;
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(
        String(
          await t.plugin.tool.background_steer.execute(
            { id: t.id, instruction: `follow-up ${i}` },
            t.owner,
          ),
        ),
      );
    }
    for (let i = 0; i < 5; i++) expect(results[i]).toContain(`Steered ${t.id}`);
    for (let i = 5; i < 10; i++) expect(results[i]).toContain("steer limit reached (5)");
    const after = readState(home, t.dir, t.id);
    expect(after.steerCount).toBe(5);
    expect(after.deadlineAt).toBe(deadlineAt0);
    expect(after.startedAt).toBe(startedAt0);
    // dispatch (1) + 5 steers = 6 child promptAsync calls, deadline untouched
    const childCalls = t.client.session.promptAsync.mock.calls.filter(
      (c: any) => c?.[0]?.path?.id === t.client.__childId,
    );
    expect(childCalls).toHaveLength(6);
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner); // cleanup
  });

  it("bash jobs reject steer with kind reason", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 20" }, owner));
    const res = String(await plugin.tool.background_steer.execute({ id, instruction: "go faster" }, owner));
    expect(res).toContain("Cannot steer");
    expect(res).toContain("kind=bash");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup kills sleep
  });

  it("terminal jobs reject steer with state reason", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo done" }, owner));
    await waitTerminal(plugin, owner, id);
    const res = String(await plugin.tool.background_steer.execute({ id, instruction: "more" }, owner));
    expect(res).toContain("Cannot steer");
    expect(res).toContain("state=completed");
  });

  it("real timeout: timedOut flag set, notifications event is timeout", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "slow", timeout_minutes: 0.001 }, owner),
    );
    await new Promise((r) => setTimeout(r, 250));
    await plugin.tool.background_list.execute({}, owner);
    const st = readState(home, dir, id);
    expect(st.state).toBe("stopped");
    expect(st.timedOut).toBe(true);
    expect(readNotifications(home, dir).find((n: any) => n.id === id)?.event).toBe("timeout");
  });

  it("substring fallback: stopped job with 'timeout' in summary labels timeout (flag undefined)", async () => {
    const t = await pendingTask();
    await t.plugin.tool.background_steer.execute(
      { id: t.id, instruction: "investigate the timeout path" },
      t.owner,
    );
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(st.timedOut).toBeUndefined();
    expect(st.summary).toContain("timeout");
    // tertiary fallback: summary substring wins for legacy/flagless records
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)?.event).toBe("timeout");
  });

  it("plain manual stop labels stopped, never timeout", async () => {
    const t = await pendingTask();
    await t.plugin.tool.background_stop.execute({ id: t.id }, t.owner);
    const st = readState(home, t.dir, t.id);
    expect(st.state).toBe("stopped");
    expect(readNotifications(home, t.dir).find((n: any) => n.id === t.id)?.event).toBe("stopped");
  });
});
