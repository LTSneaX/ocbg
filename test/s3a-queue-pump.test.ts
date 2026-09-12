// S3a run/queue/steer — pumpQueue on EVERY terminal path.
//
// Surface + spawn-abort suites prove stop→pump and queued-removal notify.
// This suite closes the remaining S3a terminal-path gaps:
//   1. task dispatch-failure (failed after 3 tries) releases the slot — a
//      queued job must drain instead of parking forever at cap;
//   2. NATURAL bash completion (close-handler funnel) pumps the queue — no
//      manual stop required;
//   3. FAILED bash (nonzero exit) pumps the queue via the same funnel;
//   4. queue position metadata + status queued count stay honest at cap.

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
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const CAP1 = { BG_MAX_CONCURRENT_JOBS: "1" };

describe("S3a queue-pump on every terminal path", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("dispatch-failure at cap releases the slot: queued bash drains after 3-try fail", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.create.mockImplementation(async () => {
      throw new Error("model unavailable");
    });
    const plugin = await boot({ dir, client, env: CAP1 });
    const owner = makeCtx(OWNER, dir);
    // Do NOT await: the 3-try backoff (~3s) holds the only slot while we queue.
    const doomed = plugin.tool.background_run.execute({ kind: "task", prompt: "doomed" }, owner);
    const queuedRes: any = await plugin.tool.background_run.execute(
      { kind: "bash", prompt: "echo drained-after-fail" },
      owner,
    );
    expect(queuedRes?.metadata?.queued).toBe(true);
    const second = runId(queuedRes);
    await doomed; // resolves after the 3rd failed try
    const body = await waitTerminal(plugin, owner, second);
    expect(body).toContain("drained-after-fail");
    expect(readState(home, dir, second).state).toBe("completed");
  }, 30000);

  it("natural bash completion pumps the queue (no manual stop)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: CAP1 });
    const owner = makeCtx(OWNER, dir);
    const first = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 0.3; echo first-done" }, owner),
    );
    const secondRes: any = await plugin.tool.background_run.execute(
      { kind: "bash", prompt: "echo second-done" },
      owner,
    );
    expect(secondRes?.metadata?.queued).toBe(true);
    const second = runId(secondRes);
    const body = await waitTerminal(plugin, owner, second);
    expect(body).toContain("second-done");
    expect(readState(home, dir, first).state).toBe("completed");
    expect(readState(home, dir, second).state).toBe("completed");
    expect(readOutput(home, dir, first)).toContain("first-done");
  });

  it("failed bash (nonzero exit) pumps the queue via the same funnel", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: CAP1 });
    const owner = makeCtx(OWNER, dir);
    const first = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 0.3; exit 3" }, owner),
    );
    const second = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo after-fail" }, owner),
    );
    const body = await waitTerminal(plugin, owner, second);
    expect(body).toContain("after-fail");
    expect(readState(home, dir, first).state).toBe("failed");
    expect(readState(home, dir, second).state).toBe("completed");
  });

  it("queue positions + status queued count stay honest at cap", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client, env: CAP1 });
    const owner = makeCtx(OWNER, dir);
    const first = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 20" }, owner));
    const q2: any = await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo q2" }, owner);
    const q3: any = await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo q3" }, owner);
    expect(q2?.metadata?.queued).toBe(true);
    expect(q3?.metadata?.queued).toBe(true);
    expect(String(q2?.output)).toContain("queue position: 1");
    expect(String(q3?.output)).toContain("queue position: 2");
    const status = String(await plugin.tool.background_status.execute({}, owner));
    expect(status).toContain("2 queued");
    // Cleanup: drain the queue without running anything.
    await plugin.tool.background_stop.execute({ id: runId(q2) }, owner);
    await plugin.tool.background_stop.execute({ id: runId(q3) }, owner);
    await plugin.tool.background_stop.execute({ id: first }, owner);
  });
});
