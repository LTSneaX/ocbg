// Slice 3 — F3 list cache (TTL + dir-mtime) + F4 retention (prune + log caps).
// F3: second list within TTL skips the disk scan (scan counter proves hit);
//     TTL expiry re-scans; dir-mtime change invalidates within TTL;
//     content-only writes (heartbeat/save/log appends) do NOT invalidate.
// F4: pruneOldJobs + the list miss-path prune remove old terminal triples
//     (.json/.heartbeat/.md), keep recent/running/queued, evict memory, and
//     cap both append-only logs at the log cap (most-recent kept).
// All through the public tool surface + the exported F3/F4 hooks (same module
// instance as the booted plugin — re-imported AFTER boot, no reset between).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
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
  projectDir,
  waitTerminal,
} from "./helpers.js";

saveEnv();

const OWNER = "owner-A";
const BG_SPEC = "../src/plugin/background.ts";

/** Same module instance the last boot() created (no reset between). */
async function bgMod(): Promise<any> {
  return (await import(/* @vite-ignore */ BG_SPEC)) as any;
}

function dirOf(home: string, dir: string): string {
  return projectDir(home, dir);
}

/** Plant a job triple directly on disk (simulates another host / aged history). */
function plantJob(
  home: string,
  dir: string,
  id: string,
  opts: { state: string; endedAt?: number; startedAt?: number; heartbeat?: boolean },
): void {
  const pd = dirOf(home, dir);
  const now = Date.now();
  const job = {
    id,
    kind: "bash",
    state: opts.state,
    prompt: `planted ${id}`,
    rootSessionID: "sess",
    ownerSessionID: "sess",
    startedAt: opts.startedAt ?? now - 60_000,
    ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}),
    timeoutMinutes: 15,
    title: `bash: ${id}`,
    summary: `planted ${id}`,
    outputPath: join(pd, `${id}.md`),
    statePath: join(pd, `${id}.json`),
    unread: false,
    notified: true,
  };
  writeFileSync(join(pd, `${id}.json`), JSON.stringify(job, null, 2), { mode: 0o600 });
  writeFileSync(join(pd, `${id}.md`), `# ${id}\n\nplanted\n`, { mode: 0o600 });
  if (opts.heartbeat ?? true) {
    writeFileSync(join(pd, `${id}.heartbeat`), `${new Date().toISOString()} | planted\n`, { mode: 0o600 });
  }
}

function tripleExists(home: string, dir: string, id: string): { json: boolean; md: boolean; hb: boolean } {
  const pd = dirOf(home, dir);
  return {
    json: existsSync(join(pd, `${id}.json`)),
    md: existsSync(join(pd, `${id}.md`)),
    hb: existsSync(join(pd, `${id}.heartbeat`)),
  };
}

function logLines(home: string, dir: string, name: string): string[] {
  const p = join(dirOf(home, dir), name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("F3 list cache", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("cache hit: first list scans once, second list within TTL avoids the disk scan", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo live" }, owner));
    await waitTerminal(plugin, owner, id);
    plantJob(home, dir, "ext-1", { state: "completed", endedAt: Date.now() });
    const list1 = String(await plugin.tool.background_list.execute({}, owner));
    expect(bg.__getDiskScanCount()).toBe(1);
    expect(list1).toContain(id);
    expect(list1).toContain("ext-1"); // scan reads externally-planted jobs
    const list2 = String(await plugin.tool.background_list.execute({}, owner));
    expect(bg.__getDiskScanCount()).toBe(1); // hit: no re-scan
    expect(list2).toContain(id);
    expect(list2).toContain("ext-1"); // served from cache
  });

  it("TTL expiry re-scans (BG_LIST_CACHE_TTL_MS honored, dead config now live)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_LIST_CACHE_TTL_MS: "150" } });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo ttl" }, owner));
    await waitTerminal(plugin, owner, id);
    await plugin.tool.background_list.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1);
    await plugin.tool.background_list.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1); // still within 150ms TTL
    await sleep(250); // expire the TTL
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(bg.__getDiskScanCount()).toBe(2); // expiry re-scans
    expect(list).toContain(id); // render intact after re-scan
  });

  it("dir-mtime change invalidates within TTL (new external job file forces re-scan)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() }); // default 5000ms TTL
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo m" }, owner));
    await waitTerminal(plugin, owner, id);
    await plugin.tool.background_list.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1);
    await sleep(15); // separate dir-mtime ticks
    plantJob(home, dir, "ext-new", { state: "completed", endedAt: Date.now() });
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(bg.__getDiskScanCount()).toBe(2); // mtime bump overrode the fresh TTL
    expect(list).toContain("ext-new");
    expect(list).toContain(id);
  });

  it("content-only writes do NOT invalidate (notify traffic never busts the cache)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo c" }, owner));
    await waitTerminal(plugin, owner, id);
    await plugin.tool.background_list.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1);
    const pd = dirOf(home, dir);
    const mBefore = statSync(pd).mtimeMs;
    // Content-only append to an EXISTING file (heartbeat/save/log pattern).
    appendFileSync(join(pd, `${id}.md`), "\ncontent-only touch\n");
    expect(statSync(pd).mtimeMs).toBe(mBefore); // premise: dir mtime untouched
    await plugin.tool.background_list.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1); // still a hit
  });

  it("status shares the same cache (no double scan across list+status)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo s" }, owner));
    await waitTerminal(plugin, owner, id);
    await plugin.tool.background_list.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1);
    await plugin.tool.background_status.execute({}, owner);
    expect(bg.__getDiskScanCount()).toBe(1); // status hit the list-built cache
    expect(readState(home, dir, id).state).toBe("completed");
  });
});

describe("F4 retention prune", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("prune removes old terminal triples, keeps recent/running/queued, evicts memory", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const now = Date.now();
    const DAY = 86_400_000;
    plantJob(home, dir, "old-done", { state: "completed", endedAt: now - 2 * DAY });
    plantJob(home, dir, "old-failed", { state: "failed", endedAt: now - 3 * DAY });
    plantJob(home, dir, "recent-done", { state: "completed", endedAt: now - 3_600_000 });
    plantJob(home, dir, "old-running", { state: "running", startedAt: now - 30 * DAY });
    plantJob(home, dir, "old-queued", { state: "queued", startedAt: now - 30 * DAY });
    const pruned = bg.pruneOldJobs(dir) as string[];
    expect([...pruned].sort()).toEqual(["old-done", "old-failed"]);
    // Full triple gone for pruned…
    for (const pid of ["old-done", "old-failed"]) {
      expect(tripleExists(home, dir, pid)).toEqual({ json: false, md: false, hb: false });
    }
    // …everything else intact on disk…
    for (const kid of ["recent-done", "old-running", "old-queued"]) {
      const t = tripleExists(home, dir, kid);
      expect(t.json).toBe(true);
      expect(t.md).toBe(true);
    }
    // …and the list no longer serves the pruned, still serves the kept.
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).not.toContain("old-done");
    expect(list).not.toContain("old-failed");
    expect(list).toContain("recent-done");
    expect(list).toContain("old-running");
    expect(list).toContain("old-queued");
  });

  it("list miss-path prunes inline (no direct prune call needed)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const owner = makeCtx(OWNER, dir);
    const now = Date.now();
    plantJob(home, dir, "stale-inline", { state: "stopped", endedAt: now - 5 * 86_400_000 });
    plantJob(home, dir, "fresh-inline", { state: "completed", endedAt: now });
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).not.toContain("stale-inline");
    expect(list).toContain("fresh-inline");
    expect(tripleExists(home, dir, "stale-inline")).toEqual({ json: false, md: false, hb: false });
    expect(tripleExists(home, dir, "fresh-inline").json).toBe(true);
  });

  it("retention window is env-configurable (30d keeps a 10-day-old terminal)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "30" } });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    plantJob(home, dir, "ten-day", { state: "completed", endedAt: Date.now() - 10 * 86_400_000 });
    expect(bg.pruneOldJobs(dir)).toEqual([]);
    expect(tripleExists(home, dir, "ten-day").json).toBe(true);
    expect(String(await plugin.tool.background_list.execute({}, owner))).toContain("ten-day");
  });

  it("default retention is 7 days (tight boundary bracket, no env override)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const DAY = 86_400_000;
    const now = Date.now();
    plantJob(home, dir, "eight-day", { state: "completed", endedAt: now - 8 * DAY });
    plantJob(home, dir, "six-day", { state: "completed", endedAt: now - 6 * DAY });
    // Tight bracket around the 7-day default: just inside is kept, just
    // outside is pruned (±60s tolerance, far above any ms-level clock skew).
    plantJob(home, dir, "almost-seven-day", { state: "completed", endedAt: now - (7 * DAY - 60_000) });
    plantJob(home, dir, "just-past-seven-day", { state: "completed", endedAt: now - (7 * DAY + 60_000) });
    expect([...(bg.pruneOldJobs(dir) as string[])].sort()).toEqual(["eight-day", "just-past-seven-day"]);
    expect(tripleExists(home, dir, "eight-day").json).toBe(false);
    expect(tripleExists(home, dir, "just-past-seven-day").json).toBe(false);
    expect(tripleExists(home, dir, "six-day").json).toBe(true);
    expect(tripleExists(home, dir, "almost-seven-day").json).toBe(true);
  });

  it("terminal job without endedAt falls back to startedAt (legacy records prunable)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const bg = await bgMod();
    const pd = dirOf(home, dir);
    // Hand-write a legacy record with NO endedAt field at all.
    const legacy = {
      id: "legacy-old",
      kind: "bash",
      state: "completed",
      prompt: "legacy",
      rootSessionID: "s",
      ownerSessionID: "s",
      startedAt: Date.now() - 4 * 86_400_000,
      timeoutMinutes: 15,
      title: "bash: legacy",
      summary: "legacy",
      outputPath: join(pd, "legacy-old.md"),
      statePath: join(pd, "legacy-old.json"),
      unread: false,
      notified: true,
    };
    writeFileSync(join(pd, "legacy-old.json"), JSON.stringify(legacy, null, 2), { mode: 0o600 });
    writeFileSync(join(pd, "legacy-old.md"), "# legacy\n", { mode: 0o600 });
    expect(bg.pruneOldJobs(dir)).toEqual(["legacy-old"]);
    expect(tripleExists(home, dir, "legacy-old").json).toBe(false);
  });
});

describe("F4 log rotation", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("oversized logs trim to the cap, most-recent kept (both logs)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const pd = dirOf(home, dir);
    // Calibrate the cap behaviorally: an oversized log prunes to exactly cap.
    const OVER = 500;
    const notifLines = Array.from({ length: OVER }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(join(pd, ".notifications.log"), notifLines.join("\n") + "\n", { mode: 0o600 });
    const idleLines = Array.from({ length: OVER }, (_, i) => `idle-${i}`);
    writeFileSync(join(pd, "last-idle.log"), idleLines.join("\n") + "\n", { mode: 0o600 });
    bg.pruneOldJobs(dir); // trim path for pre-existing oversized logs
    const notif = logLines(home, dir, ".notifications.log");
    const cap = notif.length;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(OVER); // the trim actually fired
    const idle = logLines(home, dir, "last-idle.log");
    expect(idle).toHaveLength(cap);
    expect(JSON.parse(notif[0]).n).toBe(OVER - cap); // oldest dropped…
    expect(JSON.parse(notif[cap - 1]).n).toBe(OVER - 1); // …newest kept
    expect(idle[0]).toBe(`idle-${OVER - cap}`);
    expect(idle[cap - 1]).toBe(`idle-${OVER - 1}`);
  });

  it("notify append-path trims (one completion caps an oversized notifications log)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const owner = makeCtx(OWNER, dir);
    const pd = dirOf(home, dir);
    // Calibrate the cap in-test (no cross-test order dep): oversized seed
    // prunes to exactly cap, then re-seed past it for the append probe.
    const OVER = 500;
    writeFileSync(
      join(pd, ".notifications.log"),
      Array.from({ length: OVER }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n",
      { mode: 0o600 },
    );
    bg.pruneOldJobs(dir);
    const cap = logLines(home, dir, ".notifications.log").length;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(OVER);
    const seed = Array.from({ length: cap + 10 }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(join(pd, ".notifications.log"), seed.join("\n") + "\n", { mode: 0o600 });
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo rot" }, owner));
    await waitTerminal(plugin, owner, id);
    const notif = logLines(home, dir, ".notifications.log");
    expect(notif).toHaveLength(cap); // appended + trimmed back to cap
    expect(JSON.parse(notif[cap - 1]).id).toBe(id); // the new entry survived
  });

  it("small logs are untouched (no rewrite churn)", async () => {
    const dir = makeWorkdir();
    await boot({ dir, client: makeClient() });
    const bg = await bgMod();
    const pd = dirOf(home, dir);
    const seed = [JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })].join("\n") + "\n";
    writeFileSync(join(pd, ".notifications.log"), seed, { mode: 0o600 });
    const mBefore = statSync(join(pd, ".notifications.log")).mtimeMs;
    bg.pruneOldJobs(dir);
    expect(logLines(home, dir, ".notifications.log")).toHaveLength(2);
    expect(statSync(join(pd, ".notifications.log")).mtimeMs).toBe(mBefore); // no rewrite
  });

  it("background_config advertises the retention knob", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "14" } });
    const out = String(await plugin.tool.background_config.execute({}, makeCtx(OWNER, dir)));
    expect(out).toContain("retentionDays");
    expect(out).toContain("BG_RETENTION_DAYS");
    expect(out).toContain("14");
  });
});
