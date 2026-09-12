// Shared helpers for ocbg Phase-1 behavior suites (G1-G6 + surface).
//
// Strategy: background.ts keeps ALL logic in closures inside the BackgroundOps
// factory (zero src/ behavior changes allowed), so every suite drives the
// PUBLIC tool surface only: boot a fresh module instance per test
// (vi.resetModules + dynamic import => fresh jobs map, fresh CONFIG from env),
// inject a mocked client {session, app, tui}, isolate ALL disk state under a
// per-test HOME (homedir() honors $HOME on linux) + unique work dir.

import { createHash, randomUUID } from "crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

const BG_SPEC = "../src/plugin/background.ts";

export const BG_KEYS = [
  "BG_DEBUG",
  "BG_WAKE_NOTE",
  "BG_NOTIFY_DEFAULT",
  "BG_MAX_TIMEOUT_MINUTES",
  "BG_MAX_CONCURRENT_JOBS",
  "BG_MAX_BASH_BYTES",
  "BG_LIST_CACHE_TTL_MS",
  "BG_IDLE_CLOSE_MS",
  "BG_RETENTION_DAYS",
  "BG_SWEEP_BUDGET_MS",
  "BG_JOB_ID_TYPE",
  "BG_U2_TIMEOUT_MS",
  "BG_U4_FANIN",
  "BG_U4_DEBOUNCE_MS",
];

let savedEnv: Record<string, string | undefined> = {};

export function saveEnv(): void {
  savedEnv = {};
  for (const k of [...BG_KEYS, "HOME"]) savedEnv[k] = process.env[k];
}

export function restoreEnv(): void {
  for (const k of [...BG_KEYS, "HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
}

export function makeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "ocbg-home-"));
  process.env.HOME = h;
  return h;
}

export function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "ocbg-work-"));
}

export interface MockClient {
  session: {
    create: any;
    promptAsync: any;
    messages: any;
    abort: any;
    get: any;
    info: any;
    listMessages: any;
  };
  app: { log: any };
  tui: { showToast: any };
  __childId: string;
}

/** Assistant message shape refreshTaskJob treats as completed. */
export function completedMessages(text: string, when?: string): unknown {
  return {
    data: [
      {
        info: {
          role: "assistant",
          time: { completed: when ?? new Date().toISOString() },
          parts: [{ type: "text", text }],
        },
      },
    ],
  };
}

/** Lookup shape extractSessionActivityMs reads as stale (fixed ISO, minutesAgo old). */
export function staleActivity(minutesAgo: number): unknown {
  const iso = new Date(Date.now() - minutesAgo * 60000).toISOString();
  return { data: { timeUpdated: iso, messages: [{ timeCreated: iso }] } };
}

/** Lookup shape that is fresh AT CALL TIME (dynamic ISO — safe under fake timers). */
export function freshActivityDynamic(): unknown {
  const iso = new Date().toISOString();
  return { data: { timeUpdated: iso, messages: [] } };
}

export function makeClient(opts?: {
  childId?: string;
  messages?: unknown;
  lookup?: unknown;
}): MockClient {
  const childId = opts?.childId ?? `child-${randomUUID().slice(0, 8)}`;
  const lookupVal = opts?.lookup !== undefined ? opts.lookup : null;
  return {
    session: {
      create: vi.fn(async () => ({ data: { id: childId } })),
      promptAsync: vi.fn(async () => ({})),
      messages: vi.fn(async () => opts?.messages ?? { data: [] }),
      abort: vi.fn(async () => ({})),
      get: vi.fn(async () => lookupVal),
      info: vi.fn(async () => lookupVal),
      listMessages: vi.fn(async () => lookupVal),
    },
    app: { log: vi.fn(async () => ({})) },
    tui: { showToast: vi.fn(async () => ({})) },
    __childId: childId,
  };
}

export function makeCtx(sessionID: string, directory: string): any {
  return {
    sessionID,
    messageID: "msg-test",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  };
}

/** Boot a FRESH plugin instance: deterministic env baseline + reset modules. */
export async function boot(opts: {
  dir: string;
  client: MockClient;
  env?: Record<string, string>;
}): Promise<any> {
  for (const k of BG_KEYS) delete process.env[k];
  process.env.BG_WAKE_NOTE = "true";
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) process.env[k] = v;
  }
  vi.resetModules();
  const mod = (await import(/* @vite-ignore */ BG_SPEC)) as any;
  const factory = mod.default ?? mod.BackgroundOps;
  return factory({ client: opts.client, directory: opts.dir } as any);
}

export function runId(res: any): string {
  const id = res?.metadata?.backgroundId;
  if (typeof id !== "string" || !id) {
    throw new Error(`no backgroundId in result: ${JSON.stringify(res)?.slice(0, 200)}`);
  }
  return id;
}

export function projectDir(home: string, cwd: string): string {
  return join(
    home,
    ".local",
    "share",
    "opencode",
    "background-ops",
    createHash("sha1").update(cwd).digest("hex").slice(0, 12),
  );
}

export function statePath(home: string, cwd: string, id: string): string {
  return join(projectDir(home, cwd), `${id}.json`);
}

export function readState(home: string, cwd: string, id: string): any {
  return JSON.parse(readFileSync(statePath(home, cwd, id), "utf8"));
}

export function writeState(home: string, cwd: string, id: string, obj: unknown): void {
  writeFileSync(statePath(home, cwd, id), JSON.stringify(obj, null, 2));
}

export function readOutput(home: string, cwd: string, id: string): string {
  return readFileSync(join(projectDir(home, cwd), `${id}.md`), "utf8");
}

export function readNotifications(home: string, cwd: string): any[] {
  const p = join(projectDir(home, cwd), ".notifications.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Poll background_read until the job leaves running/queued. Returns final text. */
export async function waitTerminal(
  plugin: any,
  ctx: any,
  id: string,
  timeoutMs = 8000,
): Promise<string> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    last = String(await plugin.tool.background_read.execute({ id }, ctx));
    if (!last.startsWith("[running]")) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} still running after ${timeoutMs}ms; last=${last.slice(0, 120)}`);
}

/** promptAsync calls aimed at the parent (wake-note road), excluding child dispatch. */
export function wakeCalls(client: MockClient, rootSessionID: string): any[] {
  return client.session.promptAsync.mock.calls.filter(
    (c: any) => c?.[0]?.path?.id === rootSessionID,
  );
}

/** Wait out the U4 fan-in debounce window (default 100ms, max 200ms) plus
 *  margin, so debounced parent wakes (and their U2 queue settlements) have
 *  landed before wake-count assertions. Call after waitTerminal / list-driven
 *  completion and before asserting wakeCalls / hook delivery. */
export async function waitFanin(ms = 350): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
