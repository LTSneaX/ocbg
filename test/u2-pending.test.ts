// U2 pending-notification chat.message fallback — queue on throw/timeout,
// prepend on the next chat.message hook entry, never double-fire.
//
// Drives the public tool surface only (like every other suite). Enrichment
// stays OFF (default) so session.create traffic never interferes; the
// promptAsync mock splits the parent wake-note road (path.id === OWNER)
// from everything else. The "chat.message" hook is invoked directly, the
// way the host would on the next user turn.

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
  waitTerminal,
  waitFanin,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-U2";

function busyParent(client: any): void {
  client.session.promptAsync.mockImplementation(async (arg: any) => {
    if (arg?.path?.id === OWNER) throw new Error("parent busy");
    return {};
  });
}

function hangingParent(client: any): void {
  client.session.promptAsync.mockImplementation(async (arg: any) => {
    if (arg?.path?.id === OWNER) return new Promise(() => {}); // wake hangs → race must fire
    return {};
  });
}

async function runBash(plugin: any, owner: any, prompt: string): Promise<string> {
  return runId(await plugin.tool.background_run.execute({ kind: "bash", prompt }, owner));
}

describe("U2 pending-notification fallback", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    delete process.env.BG_U2_TIMEOUT_MS;
    restoreEnv();
  });

  it("throw on wake queues pending; hook prepends into message.parts once, second entry is a no-op", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    busyParent(client);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo throw-u2");
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("throw-u2"); // terminal lands despite the wake throw
    await waitFanin(); // U4: debounced fan-in settles (and queues) before the hook
    const st = readState(home, dir, id);
    expect(st.summary).toContain("[DONE COMPLETED]"); // DONE marker still carried it
    // Next chat.message turn: pending drains into the message parts (turn-firing).
    const out1: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out1);
    expect(out1.message.parts).toHaveLength(1);
    expect(out1.message.parts[0].type).toBe("text");
    expect(out1.message.parts[0].text).toContain("pending notifications (1)");
    expect(out1.message.parts[0].text).toContain(id);
    // Single-writer: the queue is drained — a second entry fires nothing.
    const out2: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out2);
    expect(out2.message.parts).toHaveLength(0);
  });

  it("timeout on wake queues pending (80ms race); terminal stays fast; hook delivers", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    hangingParent(client);
    const plugin = await boot({ dir, client, env: { BG_U2_TIMEOUT_MS: "80" } });
    const owner = makeCtx(OWNER, dir);
    const t0 = Date.now();
    const id = await runBash(plugin, owner, "echo timeout-u2");
    const body = await waitTerminal(plugin, owner, id);
    const elapsed = Date.now() - t0;
    expect(body).toContain("timeout-u2");
    expect(elapsed).toBeLessThan(5000); // 80ms race, not the 30s default, not a hang
    await waitFanin(); // U4: debounced fan-in settles (and queues) before the hook
    expect(client.session.promptAsync.mock.calls.length).toBeGreaterThanOrEqual(1); // wake was attempted
    const out: any = { message: { parts: [{ type: "text", text: "user says hi" }] } };
    await (plugin as any)["chat.message"]({}, out);
    expect(out.message.parts).toHaveLength(2); // prepended BEFORE the user turn text
    expect(out.message.parts[0].text).toContain("pending notifications (1)");
    expect(out.message.parts[0].text).toContain(id);
    expect(out.message.parts[1].text).toBe("user says hi");
  });

  it("successful wake dequeues: hook entry is a no-op (no double-fire)", async () => {
    const dir = makeWorkdir();
    const client = makeClient(); // wake road succeeds ({})
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo ok-u2");
    await waitTerminal(plugin, owner, id);
    await waitFanin(); // U4: debounced fan-in settles (and dequeues) before the hook
    expect(client.session.promptAsync.mock.calls.length).toBeGreaterThanOrEqual(1);
    const out: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out);
    expect(out.message.parts).toHaveLength(0); // delivered already → nothing to refire
  });

  it("output.parts fallback road carries the prepend when message.parts is absent", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    busyParent(client);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo partroad-u2");
    await waitTerminal(plugin, owner, id);
    await waitFanin(); // U4: debounced fan-in settles (and queues) before the hook
    const out: any = { parts: [] };
    await (plugin as any)["chat.message"]({}, out);
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0].text).toContain(id);
  });

  it("no injectable surface re-queues (bounded); the next turn with a surface delivers", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    busyParent(client);
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = await runBash(plugin, owner, "echo requeue-u2");
    await waitTerminal(plugin, owner, id);
    await waitFanin(); // U4: debounced fan-in settles (and queues) before the hook
    await (plugin as any)["chat.message"]({}, {}); // no parts anywhere → kept, not lost
    const out: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out); // following turn delivers
    expect(out.message.parts).toHaveLength(1);
    expect(out.message.parts[0].text).toContain("pending notifications (1)");
    expect(out.message.parts[0].text).toContain(id);
  });

  it("bounded queue: 21 wake failures keep the freshest 20, oldest dropped", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    busyParent(client); // every wake throws → every job queues
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const ids: string[] = [];
    for (let n = 0; n < 21; n++) {
      const id = await runBash(plugin, owner, `echo cap-u2-${n}`);
      await waitTerminal(plugin, owner, id);
      await waitFanin(); // U4: serialize — each fan-in queues before the next job lands
      ids.push(id);
    }
    const out: any = { message: { parts: [] } };
    await (plugin as any)["chat.message"]({}, out);
    expect(out.message.parts).toHaveLength(1);
    const block = out.message.parts[0].text as string;
    expect(block).toContain("pending notifications (20)");
    expect(block).not.toContain(ids[0]); // oldest dropped at the cap
    expect(block).toContain(ids[20]); // freshest kept
  });

  it("hook never throws on loader shapes (empty/undefined carriers)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    await expect((plugin as any)["chat.message"]({}, { message: { parts: [] } })).resolves.toBeUndefined();
    await expect((plugin as any)["chat.message"]({}, {})).resolves.toBeUndefined();
    await expect((plugin as any)["chat.message"]({})).resolves.toBeUndefined();
  });
});
