// G3 — owner gates (L1): read/steer/stop enforce caller === owner (fail-closed
// not-found), legacy jobs fall back to rootSessionID, child-nesting fence.

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
  writeState,
  waitTerminal,
  type MockClient,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const FOREIGN = "intruder-B";
const UNKNOWN = "ghost-session-zzz";

describe("G3 owner gates", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  async function runningTask(): Promise<{
    plugin: any;
    client: MockClient;
    dir: string;
    id: string;
  }> {
    const dir = makeWorkdir();
    const client = makeClient(); // messages {data:[]} => never completes
    const plugin = await boot({ dir, client });
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "secret work" }, makeCtx(OWNER, dir)),
    );
    return { plugin, client, dir, id };
  }

  it("read matrix: owner sees output, foreign + unknown get fail-closed not-found", async () => {
    const t = await runningTask();
    const asOwner = String(
      await t.plugin.tool.background_read.execute({ id: t.id }, makeCtx(OWNER, t.dir)),
    );
    expect(asOwner.startsWith("[running]")).toBe(true);
    expect(asOwner).toContain(t.id);
    for (const s of [FOREIGN, UNKNOWN]) {
      const denied = String(
        await t.plugin.tool.background_read.execute({ id: t.id }, makeCtx(s, t.dir)),
      );
      expect(denied).toBe(`No job ${t.id}. Use background_list to see all.`);
    }
    await t.plugin.tool.background_stop.execute({ id: t.id }, makeCtx(OWNER, t.dir)); // cleanup
  });

  it("steer matrix: owner steers, foreign + unknown get not-found, job untouched", async () => {
    const t = await runningTask();
    for (const s of [FOREIGN, UNKNOWN]) {
      const denied = String(
        await t.plugin.tool.background_steer.execute(
          { id: t.id, instruction: "pwn" },
          makeCtx(s, t.dir),
        ),
      );
      expect(denied).toBe(`No job ${t.id}`);
    }
    expect(readState(home, t.dir, t.id).steerCount ?? 0).toBe(0);
    const ok = String(
      await t.plugin.tool.background_steer.execute(
        { id: t.id, instruction: "continue please" },
        makeCtx(OWNER, t.dir),
      ),
    );
    expect(ok).toContain(`Steered ${t.id}`);
    await t.plugin.tool.background_stop.execute({ id: t.id }, makeCtx(OWNER, t.dir)); // cleanup
  });

  it("stop matrix: foreign + unknown denied AND job keeps running; owner stops", async () => {
    const t = await runningTask();
    for (const s of [FOREIGN, UNKNOWN]) {
      const denied = String(
        await t.plugin.tool.background_stop.execute({ id: t.id }, makeCtx(s, t.dir)),
      );
      expect(denied).toBe(`No job ${t.id}`);
      expect(readState(home, t.dir, t.id).state).toBe("running");
    }
    const ok = String(
      await t.plugin.tool.background_stop.execute({ id: t.id }, makeCtx(OWNER, t.dir)),
    );
    expect(ok).toBe(`Stopped ${t.id}. Partial output preserved — use background_read.`);
    expect(readState(home, t.dir, t.id).state).toBe("stopped");
  });

  it("legacy job (no ownerSessionID) falls back to rootSessionID", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const root = makeCtx("root-1", dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo legacy-ok" }, root));
    await waitTerminal(plugin, root, id);
    // strip ownerSessionID => pre-L1 record
    const st = readState(home, dir, id);
    expect(st.ownerSessionID).toBe("root-1");
    delete st.ownerSessionID;
    writeState(home, dir, id, st);
    // fresh module => empty memory map => loadJob path exercises the fallback
    const client2 = makeClient();
    const plugin2 = await boot({ dir, client: client2 });
    const asRoot = String(await plugin2.tool.background_read.execute({ id }, makeCtx("root-1", dir)));
    expect(asRoot).toContain("legacy-ok");
    const asForeign = String(
      await plugin2.tool.background_read.execute({ id }, makeCtx(FOREIGN, dir)),
    );
    expect(asForeign).toBe(`No job ${id}. Use background_list to see all.`);
  });

  it("child-nesting fence: background_run inside a child session throws", async () => {
    const t = await runningTask();
    const childSessionID = readState(home, t.dir, t.id).childSessionID as string;
    expect(typeof childSessionID).toBe("string");
    const hook = (t.plugin as any)["tool.execute.before"] as (input: any) => Promise<void>;
    await expect(hook({ tool: "background_run", sessionID: childSessionID })).rejects.toThrow(
      /disabled inside background children/,
    );
    // owner session passes the fence cleanly
    await expect(hook({ tool: "background_run", sessionID: OWNER })).resolves.toBeUndefined();
    // other tools are unaffected inside children
    await expect(hook({ tool: "background_read", sessionID: childSessionID })).resolves.toBeUndefined();
    await t.plugin.tool.background_stop.execute({ id: t.id }, makeCtx(OWNER, t.dir)); // cleanup
  });

  it("unknown job ids fail closed on all three gates", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const ctx = makeCtx(OWNER, dir);
    const fake = "no-such-job";
    expect(String(await plugin.tool.background_read.execute({ id: fake }, ctx))).toContain(`No job ${fake}`);
    expect(String(await plugin.tool.background_steer.execute({ id: fake, instruction: "x" }, ctx))).toBe(
      `No job ${fake}`,
    );
    expect(String(await plugin.tool.background_stop.execute({ id: fake }, ctx))).toBe(`No job ${fake}`);
  });
});
