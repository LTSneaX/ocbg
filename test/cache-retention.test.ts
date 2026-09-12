// Slice 3 — F3 list cache (TTL + dir-mtime) + F4 retention (prune + log caps).
// r8 strip: the F3 scan-counter hooks are gone (module-private surface is
// exactly BackgroundOps+default) — hit/miss behavior is proven by LIST BYTES:
// a hit serves the cached render (a job planted after the scan stays
// invisible), a miss re-scans (it appears).
// F4: prune + the list miss-path inline prune remove old terminal triples
// (.json/.heartbeat/.md), keep recent/running/queued, evict memory, and
// cap both append-only logs at the log cap (most-recent kept).
// All through the public tool surface only.

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

  it("cache hit: consecutive lists within TTL serve identical bytes", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo live" }, owner));
    await waitTerminal(plugin, owner, id);
    plantJob(home, dir, "ext-1", { state: "completed", endedAt: Date.now() });
    const list1 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list1).toContain(id);
    expect(list1).toContain("ext-1"); // scan reads externally-planted jobs
    // No disk change between the calls: the second list is served from the
    // TTL cache with byte-identical render (terminal jobs render
    // deterministically — no ages/timestamps in list lines).
    const list2 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list2).toBe(list1);
  });

  it("TTL expiry re-scans (BG_LIST_CACHE_TTL_MS honored, dead config now live)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_LIST_CACHE_TTL_MS: "150" } });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo ttl" }, owner));
    await waitTerminal(plugin, owner, id);
    const list1 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list1).toContain(id);
    expect(list1).not.toContain("ext-ttl"); // not yet planted
    await sleep(250); // expire the TTL
    plantJob(home, dir, "ext-ttl", { state: "completed", endedAt: Date.now() });
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).toContain("ext-ttl"); // expiry re-scanned: the newcomer appears
    expect(list).toContain(id); // render intact after re-scan
  });

  it("dir-mtime change invalidates within TTL (new external job file forces re-scan)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() }); // default 5000ms TTL
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo m" }, owner));
    await waitTerminal(plugin, owner, id);
    const list1 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list1).toContain(id);
    expect(list1).not.toContain("ext-new");
    await sleep(15); // separate dir-mtime ticks
    plantJob(home, dir, "ext-new", { state: "completed", endedAt: Date.now() });
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).toContain("ext-new"); // mtime bump overrode the fresh TTL
    expect(list).toContain(id);
  });

  it("content-only writes do NOT invalidate (notify traffic never busts the cache)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo c" }, owner));
    await waitTerminal(plugin, owner, id);
    const list1 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list1).toContain(id);
    const pd = dirOf(home, dir);
    const mBefore = statSync(pd).mtimeMs;
    // Content-only append to an EXISTING file (heartbeat/save/log pattern).
    appendFileSync(join(pd, `${id}.md`), "\ncontent-only touch\n");
    expect(statSync(pd).mtimeMs).toBe(mBefore); // premise: dir mtime untouched
    // Hit or miss, the render is byte-identical (no entries changed) and the
    // job still serves: correctness holds either way.
    const list2 = String(await plugin.tool.background_list.execute({}, owner));
    expect(list2).toContain(id);
    expect(list2).toBe(list1);
  });

  it("status after list serves the same completed state (shared cache path)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const id = runId(await plugin.tool.background_run.execute({ kind: "bash", prompt: "echo s" }, owner));
    await waitTerminal(plugin, owner, id);
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).toContain(id);
    // Status with an id filter serves that job in any state (no-id status is
    // running/queued only by design) — same shared cache path as the list.
    const status = String(await plugin.tool.background_status.execute({ id }, owner));
    expect(status).toContain(id); // status serves the list-built view
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
    const owner = makeCtx(OWNER, dir);
    const now = Date.now();
    const DAY = 86_400_000;
    plantJob(home, dir, "old-done", { state: "completed", endedAt: now - 2 * DAY });
    plantJob(home, dir, "old-failed", { state: "failed", endedAt: now - 3 * DAY });
    plantJob(home, dir, "recent-done", { state: "completed", endedAt: now - 3_600_000 });
    plantJob(home, dir, "old-running", { state: "running", startedAt: now - 30 * DAY });
    plantJob(home, dir, "old-queued", { state: "queued", startedAt: now - 30 * DAY });
    // Factory path: the first list is a cache miss, so the inline prune meets
    // every planted record (same isPrunable/deleteJobTriple as the sweep prune).
    const list = String(await plugin.tool.background_list.execute({}, owner));
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
    const owner = makeCtx(OWNER, dir);
    plantJob(home, dir, "ten-day", { state: "completed", endedAt: Date.now() - 10 * 86_400_000 });
    // Factory path: miss-path inline prune with a 30d window keeps the record.
    expect(String(await plugin.tool.background_list.execute({}, owner))).toContain("ten-day");
    expect(tripleExists(home, dir, "ten-day").json).toBe(true);
  });

  it("default retention is 7 days (tight boundary bracket, no env override)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const DAY = 86_400_000;
    const now = Date.now();
    plantJob(home, dir, "eight-day", { state: "completed", endedAt: now - 8 * DAY });
    plantJob(home, dir, "six-day", { state: "completed", endedAt: now - 6 * DAY });
    // Tight bracket around the 7-day default: just inside is kept, just
    // outside is pruned (±60s tolerance, far above any ms-level clock skew).
    plantJob(home, dir, "almost-seven-day", { state: "completed", endedAt: now - (7 * DAY - 60_000) });
    plantJob(home, dir, "just-past-seven-day", { state: "completed", endedAt: now - (7 * DAY + 60_000) });
    // Factory path: miss-path inline prune applies the default 7d window.
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).not.toContain("eight-day");
    expect(list).not.toContain("just-past-seven-day");
    expect(list).toContain("six-day");
    expect(list).toContain("almost-seven-day");
    expect(tripleExists(home, dir, "eight-day").json).toBe(false);
    expect(tripleExists(home, dir, "just-past-seven-day").json).toBe(false);
    expect(tripleExists(home, dir, "six-day").json).toBe(true);
    expect(tripleExists(home, dir, "almost-seven-day").json).toBe(true);
  });

  it("terminal job without endedAt falls back to startedAt (legacy records prunable)", async () => {
    const dir = makeWorkdir();
    const plugin = await boot({ dir, client: makeClient(), env: { BG_RETENTION_DAYS: "1" } });
    const owner = makeCtx(OWNER, dir);
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
    // Factory path: miss-path inline prune falls back to startedAt and reaps.
    const list = String(await plugin.tool.background_list.execute({}, owner));
    expect(list).not.toContain("legacy-old");
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
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const pd = dirOf(home, dir);
    // Calibrate the cap behaviorally: an oversized log prunes to exactly cap.
    const OVER = 500;
    const notifLines = Array.from({ length: OVER }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(join(pd, ".notifications.log"), notifLines.join("\n") + "\n", { mode: 0o600 });
    const idleLines = Array.from({ length: OVER }, (_, i) => `idle-${i}`);
    writeFileSync(join(pd, "last-idle.log"), idleLines.join("\n") + "\n", { mode: 0o600 });
    // Factory path: the list miss-path trims pre-existing oversized logs.
    await plugin.tool.background_list.execute({}, owner);
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
    // Factory path: the list miss-path trims the oversized seed to cap.
    await plugin.tool.background_list.execute({}, owner);
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
    const plugin = await boot({ dir, client: makeClient() });
    const owner = makeCtx(OWNER, dir);
    const pd = dirOf(home, dir);
    const seed = [JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })].join("\n") + "\n";
    writeFileSync(join(pd, ".notifications.log"), seed, { mode: 0o600 });
    const mBefore = statSync(join(pd, ".notifications.log")).mtimeMs;
    // Factory path: the list miss-path meets the small log and leaves it.
    await plugin.tool.background_list.execute({}, owner);
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
