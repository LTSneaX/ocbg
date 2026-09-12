// U567 fast-follow: U5 retrieval-hint bytes, U6 child tools:false + pattern-aware
// deny parser, U7 stable projectId flag-default safety.
//
// Net: additive only — S0-U4 behavior unchanged. Every new/changed production
// line is executed below (LINES 100% law).

import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  boot,
  makeClient,
  makeCtx,
  makeHome,
  makeWorkdir,
  projectDir,
  readState,
  runId,
  restoreEnv,
  saveEnv,
  waitTerminal,
} from "./helpers.js";

const OWNER = "owner-u567";

/** Poll the state file until the job leaves running/queued. Never touches
 *  background_read, so the unread flag survives for compact-hook assertions. */
async function waitDiskTerminal(home: string, dir: string, id: string): Promise<void> {
  for (let n = 0; n < 200; n++) {
    const st = readState(home, dir, id).state;
    if (st !== "running" && st !== "queued") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} still running after 10s`);
}

describe("U567 fast-follow", () => {
  let home: string;
  beforeEach(() => {
    saveEnv();
    home = makeHome();
  });
  afterEach(() => {
    delete process.env.BG_PROJECT_ID;
    restoreEnv();
  });

  it("U5: compacting hint carries BOTH retrieval verbs (read + status)", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const doneId = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo hint" }, owner),
    );
    await waitDiskTerminal(home, dir, doneId);
    const out = { context: [] as string[] };
    await (plugin as any)["experimental.session.compacting"]({}, out);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain("background_read("); // pre-U567 verb kept
    expect(out.context[0]).toContain("background_status"); // U567 added verb
  });

  it("U6: child dispatch prompt carries tools:{background_run:false}", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "u6 tools flag" }, owner),
    );
    const dispatch = client.session.promptAsync.mock.calls.find(
      (c: any) => c?.[0]?.path?.id === client.__childId,
    );
    expect(dispatch).toBeDefined();
    expect(dispatch?.[0]?.body?.tools).toEqual({ background_run: false });
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("U6: pattern-aware deny blocks namespaced variants, passes other tools + loader shapes", async () => {
    const dir = makeWorkdir();
    const client = makeClient();
    const plugin = await boot({ dir, client });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "task", prompt: "u6 deny" }, owner),
    );
    const hook = (plugin as any)["tool.execute.before"] as (input: any) => Promise<void>;
    const childSessionID = readState(home, dir, id).childSessionID as string;
    expect(typeof childSessionID).toBe("string");
    // exact + namespaced variants denied inside children
    await expect(hook({ tool: "background_run", sessionID: childSessionID })).rejects.toThrow(
      /disabled inside background children/,
    );
    await expect(
      hook({ tool: "BackgroundOps_background_run", sessionID: childSessionID }),
    ).rejects.toThrow(/disabled inside background children/);
    // every sibling tool still passes inside children (write-capable stays)
    for (const t of [
      "background_read",
      "background_list",
      "background_status",
      "background_steer",
      "background_stop",
      "background_config",
    ]) {
      await expect(hook({ tool: t, sessionID: childSessionID })).resolves.toBeUndefined();
    }
    // owner may call background_run; non-string tools pass (fail-open)
    await expect(hook({ tool: "background_run", sessionID: OWNER })).resolves.toBeUndefined();
    await expect(hook({ tool: 42, sessionID: childSessionID })).resolves.toBeUndefined();
    await expect(hook({ tool: "", sessionID: childSessionID })).resolves.toBeUndefined();
    // loader shapes never throw (optional-chaining totality)
    await expect(hook({})).resolves.toBeUndefined();
    await expect(hook(undefined)).resolves.toBeUndefined();
    await plugin.tool.background_stop.execute({ id }, owner); // cleanup
  });

  it("U7: BG_PROJECT_ID unset/empty/git/auto all resolve to ONE dir (flag-default safe)", async () => {
    const dir = makeWorkdir();
    const ids: string[] = [];
    const cases: Array<{ label: string; value: string | undefined }> = [
      { label: "unset", value: undefined },
      { label: "empty", value: "" },
      { label: "git", value: "git" },
      { label: "auto", value: "auto" },
    ];
    for (const c of cases) {
      if (c.value === undefined) delete process.env.BG_PROJECT_ID;
      else process.env.BG_PROJECT_ID = c.value;
      const plugin = await boot({ dir, client: makeClient() });
      const owner = makeCtx(OWNER, dir);
      const id = runId(
        await plugin.tool.background_run.execute({ kind: "bash", prompt: `echo u7-${c.label}` }, owner),
      );
      await waitTerminal(plugin, owner, id);
      ids.push(id);
    }
    delete process.env.BG_PROJECT_ID;
    // every job file landed under a single project dir, whatever the flag said
    const base = join(home, ".local", "share", "opencode", "background-ops");
    const landed = new Map<string, string>();
    for (const e of readdirSync(base)) {
      for (const id of ids) {
        if (existsSync(join(base, e, `${id}.json`))) landed.set(id, e);
      }
    }
    expect(landed.size).toBe(4);
    expect(new Set(landed.values()).size).toBe(1);
    // and the shared dir is the live project dir for this cwd (not a pinned id)
    expect(join(base, [...landed.values()][0])).toBe(projectDir(home, dir));
  });

  it("U7: non-default BG_PROJECT_ID still pins deterministically", async () => {
    process.env.BG_PROJECT_ID = "u567-pin-456";
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(
      await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo pinned" }, owner),
    );
    const body = await waitTerminal(plugin, owner, id);
    expect(body).toContain("pinned");
    const pinned = createHash("sha1").update("u567-pin-456").digest("hex").slice(0, 12);
    expect(
      existsSync(join(home, ".local", "share", "opencode", "background-ops", pinned, `${id}.json`)),
    ).toBe(true);
  });
});
