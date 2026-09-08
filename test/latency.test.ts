// Slice 2 — F1 bash persistence debounce + F2/A3 parallel list/status refresh.
// F1: trailing-edge coalescing (unit: deterministic fake timers) + flush-on-close
//     with zero data loss under chunk storms and multi-window drips (integration).
// F2/A3: pre-render refresh is concurrent (Promise.allSettled) + per-job timeout +
//     fresh-heartbeat skip; suites lock ordering, staleness behavior, and failure
//     isolation. All via the public tool surface (+ pure helper imports for F1).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync } from "fs";
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
  waitTerminal,
  completedMessages,
} from "./helpers.js";
import { BASH_PERSIST_DEBOUNCE_MS, createTrailingDebouncer } from "../src/plugin/background.js";

saveEnv();

const OWNER = "owner-A";

function heartbeatFile(home: string, dir: string, id: string): string {
  return join(projectDir(home, dir), `${id}.heartbeat`);
}

describe("F1 trailing debouncer (unit)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounce window sits inside the 250-500ms review band", () => {
    expect(BASH_PERSIST_DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
    expect(BASH_PERSIST_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });

  it("rapid schedules coalesce into a single trailing write", () => {
    let writes = 0;
    const d = createTrailingDebouncer(300, () => {
      writes++;
    });
    for (let i = 0; i < 100; i++) d.schedule();
    expect(writes).toBe(0); // nothing fires synchronously
    vi.advanceTimersByTime(299);
    expect(writes).toBe(0); // still inside the window
    vi.advanceTimersByTime(1);
    expect(writes).toBe(1); // exactly one trailing write
  });

  it("a second burst after the window fires a second write", () => {
    let writes = 0;
    const d = createTrailingDebouncer(300, () => {
      writes++;
    });
    d.schedule();
    vi.advanceTimersByTime(300);
    expect(writes).toBe(1);
    d.schedule();
    d.schedule();
    vi.advanceTimersByTime(300);
    expect(writes).toBe(2);
  });

  it("flush runs the pending write immediately", () => {
    let writes = 0;
    const d = createTrailingDebouncer(300, () => {
      writes++;
    });
    d.schedule();
    d.flush();
    expect(writes).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(writes).toBe(1); // no double-fire from the cancelled timer
  });

  it("cancel drops the pending write", () => {
    let writes = 0;
    const d = createTrailingDebouncer(300, () => {
      writes++;
    });
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(writes).toBe(0);
  });

  it("10k-chunk storm: every byte lands, ordered, in one trailing write", () => {
    const chunks: string[] = ["$ seq-storm\n"];
    const bodies: string[] = [];
    const d = createTrailingDebouncer(300, () => {
      bodies.push(chunks.join(""));
    });
    for (let i = 1; i <= 10000; i++) {
      chunks.push(`line-${i}\n`);
      d.schedule();
    }
    vi.advanceTimersByTime(300);
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body).toContain("line-1\n");
    expect(body).toContain("line-10000\n");
    expect(body.indexOf("line-1\n")).toBeLessThan(body.indexOf("line-5000\n"));
    expect(body.indexOf("line-5000\n")).toBeLessThan(body.indexOf("line-10000\n"));
    expect(body.split("\n").filter(Boolean)).toHaveLength(10001); // header + 10k lines
  });
});

describe("F1 bash debounce (integration)", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("chunk storm (seq 1 5000): zero loss, exit code, completed", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "seq 1 5000" }, owner));
    const body = await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).state).toBe("completed");
    expect(body).toContain("\n5000\n");
    expect(body).toContain("\n1\n");
    expect(body).toContain("[exit code 0]");
    expect(body).not.toContain("[stderr]");
    const numbered = body.split("\n").filter((l: string) => /^\d+$/.test(l.trim()));
    expect(numbered).toHaveLength(5000);
    expect(numbered[0].trim()).toBe("1");
    expect(numbered[4999].trim()).toBe("5000");
  });

  it("multi-window drip (echo/sleep/echo): all windows flushed on close", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo DRIP-A; sleep 0.8; echo DRIP-B" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(readState(home, dir, id).state).toBe("completed");
    expect(body).toContain("DRIP-A");
    expect(body).toContain("DRIP-B");
    expect(body.indexOf("DRIP-A")).toBeLessThan(body.indexOf("DRIP-B"));
    expect(body).toContain("[exit code 0]");
    expect(readOutput(home, dir, id)).toContain("DRIP-B");
  });
});

describe("F2/A3 parallel list/status refresh", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("first list after dispatch always polls (dispatch heartbeat never skipped)", async () => {
    const dir = makeWorkdir();
    const client = makeClient({ messages: completedMessages("slice2 first-poll") });
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "fresh work" }, owner));
    await plugin.tool.background_list.execute({}, owner);
    expect(client.session.messages.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).state).toBe("completed");
  });

  it("fresh poll heartbeat skips the re-poll; stale heartbeat re-polls", async () => {
    const dir = makeWorkdir();
    const client = makeClient(); // {data:[]} => never completes
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "steady" }, owner));
    await plugin.tool.background_list.execute({}, owner); // dispatch step => polls
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    const list2 = String(await plugin.tool.background_list.execute({}, owner)); // fresh poll hb => skip
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(readState(home, dir, id).state).toBe("running");
    expect(list2).toContain(id); // render intact while skipping
    // age the heartbeat past the 60s skip window (poll step, so it stays skippable-by-shape)
    writeFileSync(
      heartbeatFile(home, dir, id),
      `${new Date(Date.now() - 120_000).toISOString()} | refreshing task (0 assistant messages)\n`,
      { mode: 0o600 },
    );
    await plugin.tool.background_list.execute({}, owner); // stale => re-polls
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(readState(home, dir, id).state).toBe("running");
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("past-deadline jobs are never skipped (list still enforces the timeout)", async () => {
    const dir = makeWorkdir();
    const client = makeClient(); // {data:[]} => never completes on its own
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "slow", timeout_minutes: 0.02 }, owner),
    );
    await plugin.tool.background_list.execute({}, owner); // ~10ms: dispatch => polls, deadline not past
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(readState(home, dir, id).state).toBe("running");
    await new Promise((r) => setTimeout(r, 1500)); // deadline (~1.2s) passes; poll hb still <60s fresh
    await plugin.tool.background_list.execute({}, owner); // deadline exemption => polls again
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    const st = readState(home, dir, id);
    expect(st.state).toBe("stopped");
    expect(st.timedOut).toBe(true);
  });

  it("bash refresh is never skipped (status still enforces bash timeout across fresh heartbeats)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 30", timeout_minutes: 0.001 }, owner),
    );
    await plugin.tool.background_status.execute({ id }, owner);
    await plugin.tool.background_status.execute({ id }, owner); // immediate: heartbeat fresh
    await new Promise((r) => setTimeout(r, 300)); // ~60ms deadline passes
    await plugin.tool.background_status.execute({ id }, owner);
    const st = readState(home, dir, id);
    expect(st.state).toBe("stopped");
    expect(st.timedOut).toBe(true);
  });

  it("parallel: two hung children resolve via per-job timeout; order kept; others finalize", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    // NOTE: the default mock reuses ONE child id for every create; deal unique
    // child ids so the per-child poll behavior below can tell jobs apart.
    let seq = 0;
    client.session.create.mockImplementation(async () => ({ data: { id: `child-n${++seq}` } }));
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const idA = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "job A" }, owner));
    await new Promise((r) => setTimeout(r, 15));
    const idB = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "job B" }, owner));
    await new Promise((r) => setTimeout(r, 15));
    const idC = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "job C" }, owner));
    const childA = readState(home, dir, idA).childSessionID as string;
    const childB = readState(home, dir, idB).childSessionID as string;
    const childC = readState(home, dir, idC).childSessionID as string;
    client.session.messages.mockImplementation(async (args: unknown) => {
      const cid = (args as { path?: { id?: string } })?.path?.id;
      if (cid === childA || cid === childB) return new Promise(() => {}); // hang forever
      return completedMessages(`done-${cid === childC ? "C" : "?"}`) as never;
    });
    const t0 = Date.now();
    const list = String(await plugin.tool.background_list.execute({}, owner));
    const dt = Date.now() - t0;
    // parallel: two 5s per-job timeouts overlap (~5s total, not ~10s serial)
    expect(dt).toBeGreaterThan(4000); // the hung polls really waited out their timeout
    expect(dt).toBeLessThan(9000); // ...but concurrently, not one-after-another
    // order preserved (startedAt desc: C, B, A) despite mixed outcomes
    expect(list.indexOf(idC)).toBeLessThan(list.indexOf(idB));
    expect(list.indexOf(idB)).toBeLessThan(list.indexOf(idA));
    // failure isolation: C finalized, hung jobs untouched and still running
    expect(readState(home, dir, idC).state).toBe("completed");
    expect(readState(home, dir, idA).state).toBe("running");
    expect(readState(home, dir, idB).state).toBe("running");
    // one poll per hung child: no retry storm inside the render
    const callsFor = (cid: string): number =>
      client.session.messages.mock.calls.filter((c: unknown[]) => (c[0] as { path?: { id?: string } })?.path?.id === cid)
        .length;
    expect(callsFor(childA)).toBe(1);
    expect(callsFor(childB)).toBe(1);
    expect(callsFor(childC)).toBe(1);
    expect(readFileSync(heartbeatFile(home, dir, idC), "utf8")).toContain("child done");
    await plugin.tool.background_stop.execute({ id: idA }, owner); // cleanup
    await plugin.tool.background_stop.execute({ id: idB }, owner); // cleanup
  });
});
