// Invoke-robustness + BG_DEBUG mode — loader-style invocation hardening.
//
// The loader may invoke every export as a factory with boot-like shapes
// ({}/undefined). Every function export must be total over those shapes:
// sync or async resolve, never throw. BG_DEBUG=1 gates verbose boot
// diagnostics (factory entry, guard decisions, hook wiring); default OFF
// keeps boot silent (zero-red doctrine).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveEnv,
  restoreEnv,
  makeHome,
  makeWorkdir,
  makeClient,
} from "./helpers.js";

saveEnv();

const BG_SPEC = "../src/plugin/background.ts";
const SEVEN = [
  "background_run",
  "background_list",
  "background_status",
  "background_read",
  "background_steer",
  "background_stop",
  "background_config",
] as const;

async function freshModule(): Promise<any> {
  vi.resetModules();
  return import(/* @vite-ignore */ BG_SPEC);
}

describe("invoke-robustness: every export unthrowable on {} / undefined", () => {
  beforeEach(() => {
    makeHome();
    delete process.env.BG_DEBUG;
  });
  afterEach(() => {
    restoreEnv();
  });

  it("all function exports resolve (never throw) on {} and undefined", async () => {
    const mod = await freshModule();
    const fns: Array<[string, (s: unknown) => unknown]> = Object.entries(
      mod,
    ).filter(
      (e): e is [string, (s: unknown) => unknown] => typeof e[1] === "function",
    );
    expect(fns.length).toBeGreaterThan(0);
    for (const [k, fn] of fns) {
      for (const shape of [{}, undefined]) {
        let threw: unknown = null;
        try {
          await (fn as (s: unknown) => unknown)(shape);
        } catch (e) {
          threw = e;
        }
        expect(threw, `export ${k} threw on ${shape === undefined ? "undefined" : "{}"}`).toBeNull();
      }
    }
  });

  it("runBoundedPool garbage resolves to the safe no-op; well-formed unchanged", async () => {
    const mod = await freshModule();
    await expect(mod.runBoundedPool({} as any)).resolves.toEqual({
      completed: 0,
      skipped: 0,
    });
    await expect(mod.runBoundedPool(undefined as any)).resolves.toEqual({
      completed: 0,
      skipped: 0,
    });
    const res = await mod.runBoundedPool(["a", "b"], 3, 60_000, async () => {});
    expect(res).toEqual({ completed: 2, skipped: 0 });
  });

  it("debouncer garbage never throws: schedule/cancel/flush + armed timer fires clean", async () => {
    const mod = await freshModule();
    for (const shape of [{}, undefined]) {
      const d = mod.createTrailingDebouncer(shape as any, undefined as any);
      expect(typeof d.schedule).toBe("function");
      expect(typeof d.cancel).toBe("function");
      expect(typeof d.flush).toBe("function");
      d.schedule();
      await new Promise((r) => setTimeout(r, 50));
      d.flush();
      d.schedule();
      d.cancel();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("pruneOldJobs garbage returns [] without touching disk", async () => {
    const mod = await freshModule();
    expect(mod.pruneOldJobs({} as any)).toEqual([]);
    expect(mod.pruneOldJobs(undefined as any)).toEqual([]);
  });

  it("BackgroundOps + default resolve on undefined/{} with 7 tools present", async () => {
    const mod = await freshModule();
    for (const factory of [mod.BackgroundOps, mod.default]) {
      for (const shape of [undefined, {}]) {
        const plugin: any = await factory(shape);
        for (const name of SEVEN) {
          expect(
            typeof plugin?.tool?.[name]?.execute,
            `tool ${name} must expose execute()`,
          ).toBe("function");
        }
      }
    }
  });
});

describe("BG_DEBUG env-gated boot diagnostics", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    makeHome();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    restoreEnv();
  });

  it("OFF (unset) boot is silent: zero console output", async () => {
    delete process.env.BG_DEBUG;
    const mod = await freshModule();
    await mod.BackgroundOps({ client: makeClient(), directory: makeWorkdir() });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("ON (BG_DEBUG=1) emits factory-entry/guard/wiring diagnostics", async () => {
    process.env.BG_DEBUG = "1";
    const mod = await freshModule();
    await mod.BackgroundOps({ client: makeClient(), directory: makeWorkdir() });
    expect(errSpy).toHaveBeenCalled();
    const blob = errSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .join("\n");
    expect(blob).toContain("[background-ops:debug]");
    for (const needle of [
      "factory entry",
      "guard decision",
      "hook wiring",
      "reaper",
      "factory wired",
    ]) {
      expect(blob, `missing diagnostic: ${needle}`).toContain(needle);
    }
  });
});
