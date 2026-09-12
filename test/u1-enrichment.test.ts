// U1 LLM title/description enrichment — post-terminal fire-and-forget.
//
// Drives the public tool surface only (like every other suite). Enrichment is
// default-OFF (BG_U1_ENRICH=1 opts in), so each test boots with the flag on
// except the disabled-by-default pin. The promptAsync mock distinguishes the
// parent wake-note road (path.id === OWNER → {}) from the enrichment
// temp-session road (any other id → scripted enrichment payload): without
// this split a hanging enrichment mock would also hang the awaited wake-note
// and the terminal path with it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
} from "./helpers.js";

saveEnv();

const OWNER = "owner-U1";
const ON = { BG_U1_ENRICH: "1" };

const HOSTILE_JSON = JSON.stringify({
  title: 'Deploy "quoted" `ticked` fix',
  summary: "first line\nsecond line done ok",
});
const CLEAN_TITLE = "Deploy quoted ticked fix";
const CLEAN_SUMMARY = "first line second line done ok";

function enrichRoad(client: any, payload: unknown): void {
  client.session.promptAsync.mockImplementation(async (arg: any) =>
    arg?.path?.id === OWNER ? {} : payload,
  );
}

async function waitTitle(home: string, dir: string, id: string, want: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const st = readState(home, dir, id);
    if (st.title === want) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`title never became ${JSON.stringify(want)}; last=${JSON.stringify(st.title)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("U1 enrichment", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    delete process.env.BG_U1_ENRICH;
    delete process.env.BG_U1_TIMEOUT_MS;
    restoreEnv();
  });

  it("success: temp-session JSON enriches title+summary, fences hostile bytes, keeps DONE marker", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, HOSTILE_JSON);
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo hello-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.title).not.toContain('"');
    expect(st.title).not.toContain("`");
    expect(st.title).not.toContain("\n");
    expect(st.title.length).toBeLessThanOrEqual(120);
    expect(st.summary).toContain("[DONE COMPLETED]");
    expect(st.summary).toContain(CLEAN_SUMMARY);
    expect(st.summary.split("\n")).toHaveLength(1);
    expect(st.summary).not.toContain("`");
    expect(st.summary).not.toContain('"');
  });

  it("success via parts array", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, { data: { parts: [{ type: "text", text: HOSTILE_JSON }] } });
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo parts-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("success via data-string envelope", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, { data: HOSTILE_JSON });
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo datastr-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("success via messages fallback (direct text)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) =>
      arg?.path?.id === OWNER ? {} : {},
    );
    client.session.messages.mockImplementation(async () => ({ data: { text: HOSTILE_JSON } }));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo msgfb-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("success via messages listing (messages array)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) =>
      arg?.path?.id === OWNER ? {} : {},
    );
    client.session.messages.mockImplementation(async () => ({
      data: { messages: [{ parts: [{ type: "text", text: HOSTILE_JSON }] }] },
    }));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo msglist-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("create failure keeps truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.create = vi.fn(async () => ({ error: "nope" }));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo createfail-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800)); // enrich attempted and fell back
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    const st = readState(home, dir, id);
    expect(st.title).toBe("bash: echo createfail-u1");
  });

  it("unparseable JSON keeps truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, "not json {{{");
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo parsefail-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo parsefail-u1");
  });

  it("empty shapes keep truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient(); // promptAsync {} + messages {data:[]} → no text
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo empty-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo empty-u1");
  });

  it("throwing shape keeps truncation, never throws", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const evil = {};
    Object.defineProperty(evil, "data", {
      get() {
        throw new Error("getter boom");
      },
      enumerable: true,
    });
    enrichRoad(client, evil);
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo evil-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo evil-u1");
  });

  it("timeout keeps truncation (80ms race)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) => {
      if (arg?.path?.id === OWNER) return {};
      return new Promise(() => {}); // enrichment hangs → race must fire
    });
    const plugin = await boot({ dir, client, env: { ...ON, BG_U1_TIMEOUT_MS: "80" } });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo timeout-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 700)); // race (80ms) fired and fell back
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo timeout-u1");
  });

  it("never blocks the terminal path (hanging enrich, fast terminal)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) => {
      if (arg?.path?.id === OWNER) return {};
      return new Promise(() => {}); // enrichment hangs for the full 5s race
    });
    const plugin = await boot({ dir, client, env: { ...ON, BG_U1_TIMEOUT_MS: "5000" } });
    const owner = makeCtx(OWNER, dir);
    const t0 = Date.now();
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo nonblock-u1" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    const elapsed = Date.now() - t0;
    expect(body).toContain("nonblock-u1");
    expect(elapsed).toBeLessThan(3000); // terminal lands long before the 5s race
  });

  it("blank title / blank summary rejected, truncation kept", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    let n = 0;
    client.session.promptAsync.mockImplementation(async (arg: any) => {
      if (arg?.path?.id === OWNER) return {};
      n += 1;
      return n === 1
        ? '{"title":"","summary":"ok"}'
        : '{"title":"Fine title","summary":"  "}';
    });
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id1 = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo blanktitle-u1" }, owner),
    );
    const id2 = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo blanksummary-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id1);
    await waitTerminal(plugin, owner, id2);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readState(home, dir, id1).title).toBe("bash: echo blanktitle-u1");
    expect(readState(home, dir, id2).title).toBe("bash: echo blanksummary-u1");
  });

  it("disabled by default: no session traffic, truncation kept", async () => {    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client }); // no BG_U1_ENRICH
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo offbydefault-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 400));
    expect(client.session.create.mock.calls.length).toBe(0); // bash never creates; enrich gated off
    expect(readState(home, dir, id).title).toBe("bash: echo offbydefault-u1");
  });

  it("stop path enriches too", async () => {    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, HOSTILE_JSON);
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "sleep 10" }, owner),
    );
    await new Promise((r) => setTimeout(r, 200)); // let the child spawn
    await plugin.tool.background_stop.execute({ id }, owner);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.state).toBe("stopped");
    expect(st.summary).toContain("[DONE STOPPED]");
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("quiet job (no DONE marker) enriches summary without marker", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, HOSTILE_JSON);
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute(
        { kind: "bash", prompt: "echo quiet-u1", notify_on_complete: false },
        owner,
      ),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toBe(CLEAN_SUMMARY); // no marker to preserve → bare enrichment
  });

  it("blank parts text falls through to truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    enrichRoad(client, { data: { parts: [{ type: "text", text: "   " }] } });
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo blankparts-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo blankparts-u1");
  });

  it("success via info.parts shape", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) =>
      arg?.path?.id === OWNER ? {} : {},
    );
    client.session.messages.mockImplementation(async () => ({
      data: { messages: [{ info: { parts: [{ type: "text", text: HOSTILE_JSON }] } }] },
    }));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo infoparts-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("non-text parts and missing parts keep truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    let n = 0;
    client.session.promptAsync.mockImplementation(async (arg: any) => {
      if (arg?.path?.id === OWNER) return {};
      return {};
    });
    client.session.messages.mockImplementation(async () => {
      n += 1;
      return n === 1
        ? { data: { messages: [{ parts: [{ type: "image", text: "zzz" }] }] } }
        : { data: { messages: [{ nparts: true }] } };
    });
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id1 = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo nontext-u1" }, owner),
    );
    const id2 = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo nparts-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id1);
    await waitTerminal(plugin, owner, id2);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readState(home, dir, id1).title).toBe("bash: echo nontext-u1");
    expect(readState(home, dir, id2).title).toBe("bash: echo nparts-u1");
  });

  it("session.create rejection keeps truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.create.mockRejectedValueOnce(new Error("create boom"));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo createrej-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo createrej-u1");
  });

  it("promptAsync rejection falls back to messages and still enriches", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) => {
      if (arg?.path?.id === OWNER) return {};
      throw new Error("prompt boom");
    });
    client.session.messages.mockImplementation(async () => ({ data: { text: HOSTILE_JSON } }));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo promptrej-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    const st = await waitTitle(home, dir, id, CLEAN_TITLE);
    expect(st.summary).toContain(CLEAN_SUMMARY);
  });

  it("messages rejection keeps truncation", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    client.session.promptAsync.mockImplementation(async (arg: any) =>
      arg?.path?.id === OWNER ? {} : {},
    );
    client.session.messages.mockRejectedValueOnce(new Error("messages boom"));
    const plugin = await boot({ dir, client, env: ON });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo msgsrej-u1" }, owner),
    );
    await waitTerminal(plugin, owner, id);
    await new Promise((r) => setTimeout(r, 800));
    expect(client.session.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readState(home, dir, id).title).toBe("bash: echo msgsrej-u1");
  });
});
