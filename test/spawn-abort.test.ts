// G5 — child spawn/abort contract + completion-wins races.
// abort() must target ONLY childSessionID (never rootSessionID); a concurrent
// legitimate completion always beats stop/timeout.

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
  waitTerminal,
  completedMessages,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";

describe("G5 spawn/abort + completion-wins", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("manual stop aborts ONLY the child session, never the root session", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "work" }, owner));
    const childId = readState(home, dir, id).childSessionID as string;
    expect(childId).not.toBe(OWNER);
    await plugin.tool.background_stop.execute({ id }, owner);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: childId } });
    for (const call of client.session.abort.mock.calls) {
      expect(call?.[0]?.path?.id).not.toBe(OWNER);
    }
  });

  it("timeout path aborts ONLY the child session", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "slow", timeout_minutes: 0.001 }, owner),
    );
    const childId = readState(home, dir, id).childSessionID as string;
    await new Promise((r) => setTimeout(r, 250));
    await plugin.tool.background_list.execute({}, owner);
    expect(readState(home, dir, id).timedOut).toBe(true);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: childId } });
  });

  it("completion-wins (task): done child + stop => already completed, output intact", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("final answer body") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "work" }, owner));
    await plugin.tool.background_list.execute({}, owner); // refresh finalizes completed
    expect(readState(home, dir, id).state).toBe("completed");
    const stopRes = String(await plugin.tool.background_stop.execute({ id }, owner));
    expect(stopRes).toBe(`Job ${id} already completed.`);
    const st = readState(home, dir, id);
    expect(st.state).toBe("completed");
    expect(st.summary).not.toContain("STOPPED BY USER");
    expect(readOutput(home, dir, id)).toContain("final answer body");
  });

  it("completion-wins (bash): natural close + stop => already completed", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo race-done" }, owner));
    await waitTerminal(plugin, owner, id);
    const stopRes = String(await plugin.tool.background_stop.execute({ id }, owner));
    expect(stopRes).toBe(`Job ${id} already completed.`);
    expect(readOutput(home, dir, id)).toContain("race-done");
  });

  it("dispatch retry: two transient failures then success still starts the job", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    let attempts = 0;
    client.session.create.mockImplementation(async () => {
      attempts++;
      if (attempts <= 2) throw new Error("transient UnknownError at SessionPrompt.createUserMessage");
      return { data: { id: client.__childId } };
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "flaky" }, owner));
    expect(attempts).toBe(3);
    expect(readState(home, dir, id).state).toBe("running");
    expect(readState(home, dir, id).childSessionID).toBe(client.__childId);
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("dispatch total failure: failed after 3 tries with backoff note + terminal notify", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.create.mockImplementation(async () => {
      throw new Error("model unavailable");
    });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "doomed" }, owner));
    expect(client.session.create).toHaveBeenCalledTimes(3);
    const st = readState(home, dir, id);
    expect(st.state).toBe("failed");
    expect(st.summary).toContain("failed after 3 tries");
    // dispatch-fail is terminal => notified once via the funnel
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });
});
