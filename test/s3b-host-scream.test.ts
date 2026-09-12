// S3b host-scream paths — homedir/createHash sabotage via module mocks.
//
// Covers the fallbacks that only trigger when the HOST screams:
// projectId homedir fallback (136), baseDir fallback triple (146-150),
// and the dir-mtime unresolvable guard (517). Mocks are passthrough by
// default (toggled per-test via globalThis) so normal boots are unaffected.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "fs";
import { rmSync } from "fs";
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
  waitTerminal,
} from "./helpers.js";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => (globalThis as unknown as { __s3bHomedir: () => string }).__s3bHomedir(),
  };
});

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    createHash: (...args: unknown[]) => {
      if ((globalThis as unknown as { __s3bCreateHashThrow: boolean }).__s3bCreateHashThrow) {
        throw new Error("s3b sabotage: createHash");
      }
      return (actual.createHash as (...a: unknown[]) => unknown)(...args);
    },
  };
});

saveEnv();

const OWNER = "owner-A";

function setHomedir(fn: () => string): void {
  (globalThis as unknown as { __s3bHomedir: () => string }).__s3bHomedir = fn;
}

function setHashThrow(v: boolean): void {
  (globalThis as unknown as { __s3bCreateHashThrow: boolean }).__s3bCreateHashThrow = v;
}

describe("S3b host-scream fallbacks", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    setHomedir(() => process.env.HOME as string);
    setHashThrow(false);
  });
  afterEach(() => {
    setHashThrow(false);
    restoreEnv();
  });

  it("homedir dead + no fallback dir: list degrades to empty (baseDir + dirMtime guards)", async () => {
    setHomedir(() => {
      throw new Error("no home");
    });
    rmSync("/tmp/ocbg-fallback", { recursive: true, force: true });
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const out = String(
      await plugin.tool.background_list.execute({}, makeCtx(OWNER, dir)),
    );
    expect(out).toBe("No background jobs yet.");
  });

  it("homedir throws once: baseDir uses the 000000000000 fallback dir", async () => {
    let calls = 0;
    setHomedir(() => {
      calls += 1;
      if (calls === 1) throw new Error("first homedir call dies");
      return process.env.HOME as string;
    });
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo fb-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("fb-ok");
    // Only the factory-entry baseDir call saw the dead homedir (later calls
    // recover to the real home) — proof is the created fallback dir itself.
    expect(
      existsSync(join(home, ".local", "share", "opencode", "background-ops", "000000000000")),
    ).toBe(true);
  });

  it("createHash dead: projectId falls back without killing boot", async () => {
    setHashThrow(true);
    try {
      const dir = makeWorkdir();
      const plugin = await boot({ dir, client: makeClient() });
      const out = String(
        await plugin.tool.background_config.execute({}, makeCtx(OWNER, dir)),
      );
      expect(out).toContain("background-ops v");
    } finally {
      setHashThrow(false);
    }
  });
});
