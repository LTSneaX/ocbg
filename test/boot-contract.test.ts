// S0 boot-contract — the loader-safe foundation every later slice gates on.
//
// Unlike every other suite (which drives ../src/... via vi.resetModules),
// this suite drives the EMITTED bytes the loader actually executes:
// ../dist/src/plugin/background.js — the same path scripts/loader-guard.sh
// probes. If dist/ is stale, refresh it first with `npx tsc` (emit); the
// import below fails loudly on missing/stale dist instead of passing on src.
//
// Contract (5 clauses):
//  1. dist import resolves (plain dynamic import; no mocks in the import path)
//  2. exact manifest: plugin entries are EXACTLY {BackgroundOps, default}
//     (both functions); helper exports are an exact allowlist — every export
//     a function, so the loader tripwire "Plugin export is not a function"
//     can never fire on these bytes
//  3. minimal realistic client resolves to the 7-tool surface AND runs a real
//     bash job to terminal (REAL child process through dist code, not mock-only)
//  4. hook smoke: tool.execute.before / event / transform / compacting never
//     throw on loader shapes ({}, minimal events, empty output carriers)
//  5. double-boot WITHOUT resetModules (host hot-reload): both instances serve
//     all 7 tools and the 60s sweep arms at most once (no double timers)
//
// NOTE: this file deliberately never calls vi.resetModules — clause 5
// requires the SAME module instance across boots.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveEnv,
  restoreEnv,
  makeHome,
  makeWorkdir,
  makeClient,
  makeCtx,
  runId,
  waitTerminal,
} from "./helpers.js";

saveEnv();

// Non-literal on purpose: keeps tsc --noEmit happy without allowJs (no
// static .js resolution) and keeps vite from pre-bundling — the test reads
// the real emitted file, the way the loader does.
const DIST_SPEC = "../dist/src/plugin/background.js";

const PLUGIN_ENTRIES = ["BackgroundOps", "default"];
const HELPER_ALLOWLIST = [
  "__clearListCache",
  "__getDiskScanCount",
  "createTrailingDebouncer",
  "pruneOldJobs",
  "runBoundedPool",
];
const FULL_ALLOWLIST = [...PLUGIN_ENTRIES, ...HELPER_ALLOWLIST].sort();

const SEVEN = [
  "background_run",
  "background_list",
  "background_status",
  "background_read",
  "background_steer",
  "background_stop",
  "background_config",
] as const;

function expectSevenTools(plugin: any, where: string): void {
  for (const name of SEVEN) {
    expect(typeof plugin?.tool?.[name]?.execute, `${where}: tool ${name} must expose execute()`).toBe(
      "function",
    );
  }
}

describe("S0 boot-contract (dist bytes, loader path)", () => {
  beforeEach(() => {
    makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("clause 1: dist module imports (loader path resolves)", async () => {
    const mod: any = await import(/* @vite-ignore */ DIST_SPEC);
    expect(mod, "dist import must resolve to a module namespace").toBeTruthy();
    expect(typeof mod, "dist import must be an object namespace").toBe("object");
  });

  it("clause 2: exact manifest — {BackgroundOps, default} + helper allowlist, all functions", async () => {
    const mod: any = await import(/* @vite-ignore */ DIST_SPEC);
    const keys = Object.keys(mod).sort();
    expect(keys, `export surface must be exactly [${FULL_ALLOWLIST.join(", ")}]`).toEqual(FULL_ALLOWLIST);
    for (const k of keys) {
      expect(typeof mod[k], `export ${k} must be a function (loader tripwire)`).toBe("function");
    }
    // The two plugin entries are the loader's manifest: both callable factories.
    expect(typeof mod.BackgroundOps, "BackgroundOps must be a function").toBe("function");
    expect(typeof mod.default, "default must be a function").toBe("function");
    expect(mod.default, "default must BE the BackgroundOps factory (1+default identity)").toBe(
      mod.BackgroundOps,
    );
  });

  it("clause 3: minimal realistic client resolves to 7 tools + real bash job to terminal", async () => {
    const mod: any = await import(/* @vite-ignore */ DIST_SPEC);
    const dir = makeWorkdir();
    const plugin: any = await mod.default({ client: makeClient(), directory: dir });
    expectSevenTools(plugin, "dist factory");
    // REAL execution through dist bytes: a live /bin/bash child, not a mock.
    const owner = makeCtx("owner-boot-contract", dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo boot-contract-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("boot-contract-ok");
  });

  it("clause 4: hook smoke — before/event/transform/compacting never throw on loader shapes", async () => {
    const mod: any = await import(/* @vite-ignore */ DIST_SPEC);
    const plugin: any = await mod.BackgroundOps({ client: makeClient(), directory: makeWorkdir() });

    // tool.execute.before: non-child session passes through silently.
    await expect(
      plugin["tool.execute.before"]({ tool: "background_run", sessionID: "owner-boot-contract" }),
    ).resolves.toBeUndefined();
    await expect(plugin["tool.execute.before"]({})).resolves.toBeUndefined();

    // event: unrelated/empty shapes are no-ops, never throws, never breaks host.
    await expect(
      plugin.event({ event: { type: "session.idle", properties: { sessionID: "someone-else" } } }),
    ).resolves.toBeUndefined();
    await expect(plugin.event({})).resolves.toBeUndefined();
    await expect(plugin.event({ event: { type: "other" } })).resolves.toBeUndefined();

    // experimental.chat.system.transform: injects the operator line.
    const sys: any = { system: [] };
    await expect(
      plugin["experimental.chat.system.transform"]({}, sys),
    ).resolves.toBeUndefined();
    expect(sys.system.join("")).toContain("BACKGROUND OPS");

    // experimental.session.compacting: surfaces context without throwing.
    const out: any = { context: [] };
    await expect(
      plugin["experimental.session.compacting"]({}, out),
    ).resolves.toBeUndefined();
    expect(Array.isArray(out.context)).toBe(true);
  });

  it("clause 5: double-boot without resetModules — both serve, 60s sweep arms at most once", async () => {
    const mod: any = await import(/* @vite-ignore */ DIST_SPEC);
    const factory = mod.default ?? mod.BackgroundOps;

    // Count NEW 60s sweep arms across both boots (the idle-reaper cadence).
    // First-ever boot in this module instance arms it once; the hot-reload
    // second boot must reuse the running sweep (F6.5) — never a second timer.
    let sweepArms = 0;
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: any[]) => {
      if (args[1] === 60_000) sweepArms += 1;
      return (realSetInterval as any)(...args);
    }) as any);
    try {
      const first: any = await factory({ client: makeClient(), directory: makeWorkdir() });
      const second: any = await factory({ client: makeClient(), directory: makeWorkdir() });
      expectSevenTools(first, "first boot");
      expectSevenTools(second, "hot-reload boot");
      // Both instances serve: config resolves the same version on each.
      const v1 = String(await first.tool.background_config.execute({}, makeCtx("o", makeWorkdir())));
      const v2 = String(await second.tool.background_config.execute({}, makeCtx("o", makeWorkdir())));
      expect(v1).toContain("background-ops v");
      expect(v2).toContain("background-ops v");
      expect(sweepArms, `hot-reload must not double-arm the sweep (saw ${sweepArms} new 60s arms)`).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});
