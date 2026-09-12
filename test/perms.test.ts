// G6 — permission modes (L3): 0o700 dirs, 0o600 files, hardenPerms never-throws
// and repairs pre-patch world-readable modes. All on isolated tmp HOME.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { statSync, chmodSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
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
  projectDir,
  waitTerminal,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const mode = (p: string): number => statSync(p).mode & 0o777;

describe("G6 permissions", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("fresh job dirs are 0o700 and state/output/heartbeat files are 0o600", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const taskId = runId(await plugin.tool.background_run.execute({ kind: "task", prompt: "secret task" }, owner));
    const bashId = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo hi" }, owner));
    await waitTerminal(plugin, owner, bashId);
    const base = projectDir(home, dir);
    expect(mode(base)).toBe(0o700);
    for (const id of [taskId, bashId]) {
      expect(mode(join(base, `${id}.json`))).toBe(0o600);
      expect(mode(join(base, `${id}.md`))).toBe(0o600);
      expect(mode(join(base, `${id}.heartbeat`))).toBe(0o600);
    }
    expect(mode(join(base, ".notifications.log"))).toBe(0o600);
    await plugin.tool.background_stop.execute({ id: taskId }, owner); // cleanup
  });

  it("hardenPerms repairs pre-patch world-readable modes on next boot (deferred, S2)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo x" }, owner));
    await waitTerminal(plugin, owner, id);
    const base = projectDir(home, dir);
    // simulate pre-patch umask-inherited files: world-readable modes + NO
    // .perms-hardened marker (pre-patch installs never wrote one, so the
    // deferred S2 pass must not skip this dir as already-hardened).
    chmodSync(join(base, `${id}.json`), 0o644);
    chmodSync(join(base, `${id}.md`), 0o644);
    expect(mode(join(base, `${id}.json`))).toBe(0o644);
    try { unlinkSync(join(base, ".perms-hardened")); } catch { /* marker may not exist yet */ }
    // next boot schedules the repair OFF the boot thread (S2/P1): boot must
    // resolve first, then the deferred pass repairs. Poll for the repair.
    await boot({ dir, client: makeClient() });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if (mode(join(base, `${id}.json`)) === 0o600 && mode(join(base, `${id}.md`)) === 0o600) break;
      } catch { /* dir may be mid-repair */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(mode(base)).toBe(0o700);
    expect(mode(join(base, `${id}.json`))).toBe(0o600);
    expect(mode(join(base, `${id}.md`))).toBe(0o600);
    // once-per-install marker was written by the deferred pass
    expect(existsSync(join(base, ".perms-hardened"))).toBe(true);
  });

  it("hardenPerms never throws on unreadable dirs (failure injection)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const base = projectDir(home, dir);
    // failure injection 1: directory that cannot be listed
    const locked = join(base, "locked-sub");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "x.json"), "{}");
    chmodSync(locked, 0o000);
    // failure injection 2: pre-existing files hardenPerms must survive
    writeFileSync(join(base, "stray.txt"), "stray");
    let plugin2: any = null;
    expect(() => {}).not.toThrow();
    try {
      plugin2 = await boot({ dir, client: makeClient() });
    } finally {
      chmodSync(locked, 0o700); // restore so tmp cleanup can run
    }
    expect(plugin2).toBeTruthy();
    expect(typeof (plugin2 as any).tool.background_list).toBe("object");
  });
});
