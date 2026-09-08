// Factory directory-undefined guard — boot-crash regression (loader incident).
//
// The host may invoke the BackgroundOps factory with directory===undefined.
// Before the guard this threw a bare TypeError from createHash.update(undefined)
// (via projectId<-baseDir) and killed the whole boot. These tests boot a fresh
// module instance per case with directory:undefined / "" / valid and require:
//   1. the factory resolves (never throws),
//   2. all 7 tools are present,
//   3. a bash job runs end-to-end to terminal (degraded dir is fully usable).
// When directory is valid, behavior is unchanged (job lands under that cwd).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
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

async function bootFactory(directory: string | undefined): Promise<any> {
  vi.resetModules();
  const mod = (await import(/* @vite-ignore */ BG_SPEC)) as any;
  const factory = mod.default ?? mod.BackgroundOps;
  // Must resolve — the pre-guard code threw TypeError here via
  // createHash.update(undefined) and killed the boot.
  return factory({ client: makeClient(), directory } as any);
}

function expectSevenTools(plugin: any): void {
  for (const name of SEVEN) {
    expect(
      typeof plugin?.tool?.[name]?.execute,
      `tool ${name} must expose execute()`,
    ).toBe("function");
  }
}

describe("factory directory-undefined guard", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("directory:undefined boots, exposes 7 tools, runs a bash job to terminal", async () => {
    const plugin = await bootFactory(undefined);
    expectSevenTools(plugin);
    // Degraded cwd: homedir() fallback. ctx.directory is undefined here too.
    // NOTE: homedir() honors $HOME on linux and makeHome() points $HOME at the
    // per-test home, so the degraded dir lives under the per-test home too —
    // the point is the factory resolves and the job runs instead of throwing.
    const expectedHome = homedir();
    const expectedDir = join(
      expectedHome,
      ".local",
      "share",
      "opencode",
      "background-ops",
      createHash("sha1").update(expectedHome).digest("hex").slice(0, 12),
    );
    const owner = makeCtx("owner-guard", undefined as any);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo guard-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("guard-ok");
    // Proof the job actually persisted under the degraded dir, not the test HOME.
    const { readFileSync, existsSync } = await import("fs");
    expect(existsSync(join(expectedDir, `${id}.json`))).toBe(true);
    expect(readFileSync(join(expectedDir, `${id}.md`), "utf8")).toContain("guard-ok");
  });

  it('directory:"" boots and runs (empty string was always hashable)', async () => {
    const plugin = await bootFactory("");
    expectSevenTools(plugin);
    const owner = makeCtx("owner-guard", "");
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo empty-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("empty-ok");
  });

  it("valid directory boots with unchanged behavior (job lands under that cwd)", async () => {
    const dir = makeWorkdir();
    const plugin = await bootFactory(dir);
    expectSevenTools(plugin);
    const owner = makeCtx("owner-guard", dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo valid-ok" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("valid-ok");
    const { readFileSync } = await import("fs");
    const projectDir = join(
      home,
      ".local",
      "share",
      "opencode",
      "background-ops",
      createHash("sha1").update(dir).digest("hex").slice(0, 12),
    );
    expect(readFileSync(join(projectDir, `${id}.md`), "utf8")).toContain("valid-ok");
  });
});
