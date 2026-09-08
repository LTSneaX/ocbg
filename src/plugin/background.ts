import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
const VERSION = "2.2.0-r6-quiet-wake"; // R6 delta on v2.2.0-r5-silent bytes: QUIET-WAKE restore — terminal states (completed/failed/stopped/timeout) send a quiet noReply promptAsync wake (r4 quiet-path bytes, adapted: context-only, 204 void, NO chat message, NO model turn, NEVER aborts parent) so the parent auto-turns/auto-reads the finished result. Zero-red kept (R3 terminal stderr still deleted; true-error catches only). Toast + DONE marker + .notifications.log + app.log + single-writer guard + kill-switch all kept. wake:true = quiet wake; wake:false = fully silent (no injection at all).
// Default idle window before the reaper may close a silent job: 180000ms = 3m (SneaX's number).
// SneaX can override in ~/.config/opencode/.env via BG_IDLE_CLOSE_MS=<ms> (garbage/NaN/<=0 falls back to default).
const IDLE_CLOSE_DEFAULT_MS = 180_000;
// Reaper sweep cadence (~60s). Sweep only *evaluates*; actual close still requires full idle window.
const IDLE_SWEEP_INTERVAL_MS = 60_000;
function parsePositiveMs(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const CONFIG = {
  maxTimeoutMinutes: Number(process.env.BG_MAX_TIMEOUT_MINUTES) || 48 * 60, maxConcurrentJobs: Number(process.env.BG_MAX_CONCURRENT_JOBS) || 10,
  jobIdType: (process.env.BG_JOB_ID_TYPE as "uuid" | "counter" | "human") || "uuid", maxBashCommandBytes: Number(process.env.BG_MAX_BASH_BYTES) || 4096,
  listCacheTtlMs: Number(process.env.BG_LIST_CACHE_TTL_MS) || 5000, notifyDefault: (process.env.BG_NOTIFY_DEFAULT ?? "true") === "true",
  idleCloseMs: parsePositiveMs(process.env.BG_IDLE_CLOSE_MS, IDLE_CLOSE_DEFAULT_MS),
};
type Kind = "task" | "bash"; type State = "running" | "completed" | "failed" | "stopped" | "queued";
interface Job { id: string; kind: Kind; state: State; prompt: string; agent?: string; model?: string; rootSessionID: string; childSessionID?: string; pid?: number; startedAt: number; endedAt?: number; timeoutMinutes: number; title: string; summary: string; outputPath: string; statePath: string; unread: boolean; notified: boolean; error?: string; notifyOnComplete?: boolean; _cwd?: string; }
const ADJ = ["swift", "quiet", "bright", "calm", "bold", "keen", "warm", "cool"];
const COLOR = ["amber", "jade", "cobalt", "crimson", "slate", "violet", "emerald", "onyx"];
const ANIMAL = ["falcon", "otter", "wolf", "heron", "fox", "badger", "lynx", "wren"];
const usedHumanIds = new Set<string>();
let jobCounter = 0;
function genHumanId(): string {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  for (let n = 0; n < 1000; n++) {
    const id = `${pick(ADJ)}-${pick(COLOR)}-${pick(ANIMAL)}`;
    if (!usedHumanIds.has(id)) { usedHumanIds.add(id); return id; }
  }
  throw new Error("background: exhausted human-readable id space");
}
function genId(): string {
  if (CONFIG.jobIdType === "counter") return `job-${++jobCounter}`;
  if (CONFIG.jobIdType === "human") return genHumanId();
  return randomUUID();
}
function toParts(text: string): Array<{ type: "text"; text: string }> { return [{ type: "text", text }]; }
function toModelRef(model?: string): { providerID: string; modelID: string } | undefined {
  const slash = model?.indexOf("/") ?? -1;
  if (model === undefined || slash <= 0) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
function projectId(cwd: string): string { return createHash("sha1").update(cwd).digest("hex").slice(0, 12); }
function baseDir(cwd: string): string {
  const dir = join(homedir(), ".local", "share", "opencode", "background-ops", projectId(cwd));
  mkdirSync(dir, { recursive: true });
  return dir;
}
const malformedWarned = new Set<string>();
function warnMalformed(statePath: string, reason: string) {
  const key = `${statePath}::${reason}`;
  if (malformedWarned.has(key)) return;
  malformedWarned.add(key);
  console.error(`[background-ops] WARNING: malformed job state at ${statePath}: ${reason}`);
}
function loadJob(statePath: string): Job | null {
  try {
    if (!existsSync(statePath)) return null;
    const obj = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || typeof obj.id !== "string" || !["task", "bash"].includes(obj.kind as string)) { warnMalformed(statePath, "bad job"); return null; }
    return obj as unknown as Job;
  } catch { return null; }
}
function saveJob(job: Job) {
  mkdirSync(join(job.outputPath, ".."), { recursive: true });
  writeFileSync(job.statePath, JSON.stringify(job, null, 2));
}
function persistOutput(job: Job, body: string) {
  writeFileSync(job.outputPath, `# ${job.title}\n\n- id: ${job.id}\n- kind: ${job.kind}\n- state: ${job.state}\n- started: ${new Date(job.startedAt).toISOString()}\n${job.endedAt ? `- ended: ${new Date(job.endedAt).toISOString()}\n` : ""}- summary: ${job.summary}\n\n---\n\n${body}`);
}
const jobs = new Map<string, Job>();
const procs = new Map<string, ChildProcess>();
const childSessions = new Set<string>();
const queue: Job[] = [];
const runningCount = () => [...jobs.values()].filter((j) => j.state === "running").length;
function validateBashCommand(prompt: string) {
  if (!prompt || !prompt.trim()) throw new Error("background: empty bash command rejected");
  if (Buffer.byteLength(prompt, "utf8") > CONFIG.maxBashCommandBytes) throw new Error(`background: bash command exceeds ${CONFIG.maxBashCommandBytes} bytes. Split the command or use a task subagent.`);
}
const MAX_HEARTBEAT_LINES = 50;
const heartbeatPath = (job: Job) => job.statePath.replace(/\.json$/, ".heartbeat");
function writeHeartbeat(job: Job, step: string) {
  try {
    const lines: string[] = [];
    try { lines.push(...readFileSync(heartbeatPath(job), "utf8").split("\n").filter(Boolean)); } catch { /* first */ }
    lines.push(`${new Date().toISOString()} | ${step}`);
    writeFileSync(heartbeatPath(job), lines.slice(-MAX_HEARTBEAT_LINES).join("\n") + "\n");
  } catch { /* never break the host */ }
}
function readLastHeartbeat(job: Job): { age: string; step: string } | null {
  try {
    const lines = readFileSync(heartbeatPath(job), "utf8").split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    const i = last.indexOf(" | ");
    if (!lines.length || i < 0) return null;
    const ageMs = Date.now() - new Date(last.slice(0, i)).getTime();
    const age = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s` : ageMs < 3_600_000 ? `${Math.round(ageMs / 60000)}m` : `${Math.round(ageMs / 3600000)}h`;
    return { age, step: last.slice(i + 3) };
  } catch { return null; }
}
// Numeric heartbeat age for the idle reaper. Returns null when the heartbeat is
// missing/unparseable (caller must treat as UNKNOWN → do NOT reap). May return a
// NEGATIVE value on clock skew (heartbeat timestamp in the future); callers treat
// negative as fresh (never reap). Never throws.
function readHeartbeatAgeMs(job: Job): number | null {
  try {
    const lines = readFileSync(heartbeatPath(job), "utf8").split("\n").filter(Boolean);
    if (!lines.length) return null;
    const last = lines[lines.length - 1];
    const i = last.indexOf(" | ");
    if (i < 0) return null;
    const t = new Date(last.slice(0, i)).getTime();
    if (Number.isNaN(t)) return null;
    return Date.now() - t;
  } catch { return null; }
}
// Bash activity signal: .md output-file mtime. Returns true ONLY when the output
// provably shows no writes within idleCloseMs. Fresh mtime, clock skew (negative
// age), or unresolvable stat → false (do NOT reap). Never throws.
function bashOutputLooksSilent(job: Job, idleCloseMs: number): boolean {
  try {
    const mtime = statSync(job.outputPath).mtimeMs;
    if (!Number.isFinite(mtime)) return false;
    const age = Date.now() - mtime;
    if (age < 0) return false;
    return age >= idleCloseMs;
  } catch { return false; }
}
// Best-effort recency extraction from an unknown child-session payload shape.
// Only trusts *activity* timestamps (never root createdAt — creation is not
// activity). Returns epoch ms, or null when unresolvable. Never throws.
function extractSessionActivityMs(raw: any): number | null {
  try {
    if (!raw || typeof raw !== "object") return null;
    const root: any = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    const stamps: unknown[] = [
      root?.timeUpdated, root?.updatedAt, root?.updated_at,
      root?.lastActivityAt, root?.lastActivity, root?.lastMessageAt,
    ];
    const bag: any = root?.messages ?? root?.info?.messages ?? null;
    const msgs: any[] = Array.isArray(bag) ? bag : Array.isArray(bag?.data) ? bag.data : [];
    if (msgs.length) {
      const last = msgs[msgs.length - 1] ?? {};
      stamps.push(last?.timeCreated, last?.createdAt, last?.timestamp, last?.time, last?.updatedAt);
    }
    let best: number | null = null;
    for (const s of stamps) {
      let t: number | null = null;
      if (typeof s === "number" && Number.isFinite(s)) t = s > 1e12 ? s : s > 1e9 ? s * 1000 : null;
      else if (typeof s === "string" && s) { const p = Date.parse(s); t = Number.isNaN(p) ? null : p; }
      if (t !== null && (best === null || t > best)) best = t;
    }
    return best;
  } catch { return null; }
}
function allKnownJobsFresh(cwd: string): Job[] {
  const out: Job[] = []; const seen = new Set<string>();
  for (const j of jobs.values()) { out.push(j); seen.add(j.id); }
  try {
    for (const f of readdirSync(baseDir(cwd))) {
      if (!f.endsWith(".json")) continue;
      const j = loadJob(join(baseDir(cwd), f));
      if (j && !seen.has(j.id)) { jobs.set(j.id, j); out.push(j); }
    }
  } catch { /* empty */ }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
export const BackgroundOps: Plugin = async ({ client, directory }) => {
  const c: any = client;
  async function startTask(job: Job) {
    const MAX_TRIES = 3;
    const RETRY_DELAYS_MS = [1000, 2000, 4000];
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const created: any = await c.session.create({ body: { title: `bg:${job.id}` } }).catch((e: any) => ({ error: e }));
        const childID = (created as any)?.data?.id ?? (created as any)?.id;
        if (!childID) throw new Error(`session.create failed: ${JSON.stringify(created)?.slice(0, 300)}`);
        job.childSessionID = childID; childSessions.add(childID);
        persistOutput(job, "running…");
        saveJob(job);
        writeHeartbeat(job, `task dispatched, session ${childID.slice(0, 8)} (try ${attempt}/${MAX_TRIES})`);
        const modelRef = toModelRef(job.model);
        const promptResult: any = await c.session.promptAsync({ path: { id: childID }, body: { parts: toParts(job.prompt), ...(job.agent ? { agent: job.agent } : {}), ...(modelRef ? { model: modelRef } : {}) } }).catch((e: any) => ({ __bgError: e }));
        if (promptResult?.__bgError) throw new Error(`promptAsync failed: ${String(promptResult.__bgError?.message ?? promptResult.__bgError)}`);
        return;
      } catch (e: any) {
        lastError = String(e?.message ?? e);
        if (attempt < MAX_TRIES) {
          writeHeartbeat(job, `try ${attempt} failed, retry in ${RETRY_DELAYS_MS[attempt - 1]}ms`);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        }
      }
    }
    job.state = "failed"; job.endedAt = Date.now(); job.unread = true; job.error = lastError;
    job.summary = `failed after ${MAX_TRIES} tries: ${lastError.slice(0, 200)}`;
    persistOutput(job, `[FAILED after ${MAX_TRIES} tries]\n\n${lastError}\n\nRetry backoff used: ${RETRY_DELAYS_MS.join("s, ")}s. What this means: transient dispatch faults (UnknownError at SessionPrompt.createUserMessage via SessionHttpApi.promptAsync) were retried 3× before giving up. If this persists, check model/API availability before re-running.`);
    saveJob(job);
    writeHeartbeat(job, `[FAILED after ${MAX_TRIES} tries] ${lastError.slice(0, 120)}`);
    // r6-quiet-wake: dispatch-fail is a terminal failure — toast + app.log +
    // file + quiet noReply wake carry it; no chat message, no red stderr.
    await notifyJob(c, job, { wake: true });
  }
  function startBash(job: Job) {
    const child = spawn(job.prompt, { shell: "/bin/bash", cwd: job._cwd || directory, detached: false });
    job.pid = child.pid; procs.set(job.id, child); saveJob(job);
    writeHeartbeat(job, `bash spawned (pid=${child.pid})`);
    const chunks: string[] = [`$ ${job.prompt}\n`];
    const writeOut = () => persistOutput(job, chunks.join(""));
    child.stdout?.on("data", (d) => { chunks.push(String(d)); writeOut(); });
    child.stderr?.on("data", (d) => { chunks.push(`[stderr] ${String(d)}`); writeOut(); });
    child.on("close", (code) => {
      chunks.push(`\n[exit code ${code}]`);
      const done = jobs.get(job.id) ?? job;
      if (done.state === "running") {
        const body = chunks.join("");
        const summary = body.slice(-280).replace(/\n+/g, " ");
        // v2.2.0: natural bash completion → uniform terminal path (R5 funnel, notifies).
        void completeJobInternal(done, code === 0 ? "completed" : "failed", summary, body);
      } else writeFileSync(job.outputPath, chunks.join(""));
    });
  }
  async function pumpQueue() {
    while (queue.length > 0 && runningCount() < CONFIG.maxConcurrentJobs) {
      const next = queue.shift()!; next.state = "running"; next.startedAt = Date.now();
      jobs.set(next.id, next); saveJob(next);
      if (next.kind === "bash") startBash(next);
      else await startTask(next);
    }
  }
  // Single code path for running → stopped transitions, shared by the manual
  // background_stop tool and the idle reaper. Preserves partial output exactly
  // as background_stop always has (strip persisted header, append reason label),
  // releases the slot via pumpQueue(), and NEVER deletes data files.
  // Race-safe: re-checks state === "running" immediately before mutating (and
  // again after the async abort), so a concurrent legitimate completion wins.
  async function stopJobInternal(job: Job, reasonLabel: string) {
    const live = jobs.get(job.id) ?? job;
    if (live.state !== "running") return;
    if (live.kind === "task" && live.childSessionID) await c.session.abort({ path: { id: live.childSessionID } }).catch(() => null);
    else { try { procs.get(live.id)?.kill("SIGTERM"); } catch { /* noop */ } }
    if ((jobs.get(live.id) ?? live).state !== "running") return; // completion landed during abort → it wins
    live.state = "stopped"; live.endedAt = Date.now(); live.unread = true;
    live.summary = `[${reasonLabel}] ` + live.summary;
    try { persistOutput(live, readFileSync(live.outputPath, "utf8").replace(/^# .*\n\n(- .*\n)+\n---\n\n/, "") + `\n\n[${reasonLabel}]`); } catch { persistOutput(live, `[${reasonLabel}] partial output preserved.`); }
    saveJob(live);
    procs.delete(live.id);
    pumpQueue();
    // r6-quiet-wake: stops quiet-wake the parent (context-only noReply, no chat
    // message). Placed after pumpQueue to avoid delaying slot release.
    await notifyJob(c, live, { wake: true });
  }
  // ---------------------------------------------------------------------------
  // v2.2.0: terminal-state funnel (R6). completeJobInternal is the uniform
  // template for NATURAL completions (task doneAt, bash close/poll, timeout),
  // mirroring stopJobInternal's persist/save/pumpQueue tail. stopJobInternal
  // keeps owning the "stopped" path (manual + reaper); completeJobInternal owns
  // "completed"/"failed" (+ timeout-"stopped"). BOTH converge on notifyJob.
  // r6-quiet-wake RULE: every terminal state quiet-wakes the parent (wake:true
  // → context-only noReply injection: no chat message, no red stderr). Never
  // throws (body wrapped in try/catch): a notifier fault must never break a
  // terminal transition.
  // ---------------------------------------------------------------------------
  async function completeJobInternal(job: Job, state: "completed" | "failed" | "stopped", summary: string, fullBody?: string) {
    try {
      const live = jobs.get(job.id) ?? job;
      if (live.state !== "running") return; // compare-and-set: concurrent stop/completion wins
      live.state = state; live.endedAt = Date.now(); live.unread = true;
      if (summary) live.summary = summary;
      persistOutput(live, fullBody ?? summary);
      saveJob(live);
      procs.delete(live.id);
      pumpQueue();
      // r6-quiet-wake: ALL terminal states (completed/failed/stopped incl.
      // timeout) quiet-wake — parent auto-turns/auto-reads, no chat message.
      await notifyJob(c, live, { wake: true });
    } catch (e: any) {
      console.error(`[background-ops] completeJobInternal error on ${job?.id ?? "?"}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // v2.2.0: R6 UNIFORM EMIT POINT — called by completeJobInternal AND
  // stopJobInternal AND queued-removal so natural + manual + reaper ALL notify
  // uniformly. Single-writer via notified flag. Never throws, never breaks
  // finalize/stop. Fallback ordering: infallible sinks (file + app.log,
  // ALWAYS emitted) first, then gated quiet-wake + toast + DONE marker (only
  // when shouldNotify). No stderr on terminal states, no chat message ever.
  // Feature-flag discipline (development/feature-flags): notify_on_complete /
  // BG_NOTIFY_DEFAULT is an Operational long-lived flag (owner: eng).
  // Kill-switch = notify_on_complete:false / BG_NOTIFY_DEFAULT=false. No
  // removal trigger — the flag is permanent runtime configuration.
  // GAP-6: the notifier does NOT depend on transform delivery — file +
  // app.log are independent sinks; quiet-wake + toast + DONE are best-effort.
  // GAP-7: no stderr on terminal states — notify-send NOT added
  // (unavailable in headless/server contexts, out of scope).
  // v2.2.0-r6-quiet-wake LAYER (zero-red, chat-silent): the r4 QUIET path
  // (r4 L345-360, noReply:true promptAsync) is restored, adapted to this
  // funnel — the r4 LOUD reply-triggering path is NOT restored (out of scope,
  // forbidden). wake:true → quiet wake: context-only noReply injection (204
  // void, no model turn, no chat message, NEVER aborts the parent) so the
  // parent auto-turns/auto-reads the finished result next chance. wake:false
  // → fully silent: no promptAsync call at all. Kept: single-writer guard,
  // shouldNotify gate, .notifications file, app.log, toast, DONE marker.
  // True-error catch below kept (rare red).
  async function notifyJob(client: any, job: Job, opts?: { wake: boolean }) {
    const wake = opts?.wake === true;
    try {
      const live = jobs.get(job.id) ?? job;
      if (live.state === "running" || live.state === "queued") return; // terminal only: never notify (or burn the single-writer flag) mid-run
      if (live.notified) return; // single-writer guard
      live.notified = true; live.unread = true;
      // Gate: per-job opt-out stored at creation from BG_NOTIFY_DEFAULT.
      const shouldNotify = live.notifyOnComplete ?? true;
      // --- OPT-4 always-on foundation (emitted even when gated off) ---
      // (i) R4 notification file: JSON-lines append, O_APPEND.
      try {
        const base = baseDir(live._cwd ?? directory);
        appendFileSync(join(base, ".notifications.log"), JSON.stringify({ ts: new Date().toISOString(), id: live.id, kind: live.kind, state: live.state, summary: live.summary.slice(0, 120), rootSessionID: live.rootSessionID }) + "\n", { flag: "a" });
      } catch { /* never break the host */ }
      // (ii) R3 stderr block DELETED in r5-silent, KEPT deleted in r6 (zero-red):
      // no terminal-state console.error on ANY state
      // (completed/failed/stopped/timeout). Signal path is file + app.log +
      // quiet-wake + toast + DONE. True-error catches elsewhere kept.
      // (iii) R12 app.log structured event (defensive optional chaining).
      try {
        await client?.app?.log?.({ body: { service: "background-ops", level: live.state === "failed" ? "error" : "info", message: `bg ${live.id} → ${live.state}: ${live.summary.slice(0, 120)}`, extra: { jobId: live.id, state: live.state } } })?.catch(() => null);
      } catch { /* headless / no app.log → skip */ }
      if (!shouldNotify) { saveJob(live); return; } // gated off: still marked notified (no retry storm)
      // --- r6-quiet-wake: parent road is QUIET ONLY (r4 quiet-path bytes) ---
      // wake:true → context-only noReply injection. noReply:true → 204 void,
      // no model turn, no chat message, NEVER a default prompt, NEVER aborts
      // the parent. Parent auto-turns/auto-reads the finished result next
      // chance; full output via background_read. Best-effort: parent gone →
      // skip, never throw, never abort. Single message per job (guard above).
      // wake:false → fully silent: no promptAsync call at all.
      // NO loud reply-triggering wake exists anywhere in this file (forbidden).
      if (wake) {
        const note120 = live.summary.slice(0, 120);
        const noteText = `[background-ops] bg ${live.id} [${live.kind}] → ${live.state}: ${note120}. Full output: background_read("${live.id}")`;
        try {
          await client?.session?.promptAsync?.({ path: { id: live.rootSessionID }, body: { parts: [{ type: "text", text: noteText }], noReply: true } })?.catch(() => null);
        } catch { /* parent gone → skip */ }
      }
      // GAP-2: toast is TUI-only and headless-no-op; wrapped in try/catch +
      // optional chaining so a missing TUI surface can never throw.
      try {
        await client?.tui?.showToast?.({ body: { message: `bg ${live.id} → ${live.state}: ${live.summary.slice(0, 80)}`, variant: live.state === "failed" ? "error" : "success" } })?.catch(() => null);
      } catch { /* headless → silent no-op */ }
      // DONE marker (v1.2.0 notifyParent L412-415 pattern): prefix summary +
      // prepend marker to persisted output so background_list shows [DONE …].
      try {
        const marker = `[DONE ${live.state.toUpperCase()}]`;
        live.summary = `${marker} ${live.summary}`;
        try {
          const raw = readFileSync(live.outputPath, "utf8").replace(/^# .*\n\n(- .*\n)+\n---\n\n/, "");
          persistOutput(live, `${marker}\n\n${raw}`);
        } catch { persistOutput(live, `${marker}\n\n${live.summary}`); }
      } catch { /* marker best-effort */ }
      saveJob(live);
    } catch (e: any) {
      console.error(`[background-ops] notifyJob error on ${job?.id ?? "?"}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // v2.2.0: task-completion detection rebuilt from v1.2.0 refreshTaskJob
  // (L331), adapted: jobs map + writeHeartbeat, no deferreds/list-cache.
  // Polls child messages, checks assistant doneAt, joins text parts, enforces
  // timeout. Routes ALL terminal transitions through completeJobInternal.
  // Never throws.
  async function refreshTaskJob(client: any, job: Job) {
    try {
      const live = jobs.get(job.id) ?? job;
      if (live.kind !== "task" || live.state !== "running" || !live.childSessionID) return;
      writeHeartbeat(live, "polling child session…");
      try {
        const msgs: any = await client?.session?.messages?.({ path: { id: live.childSessionID } })?.catch(() => null);
        if (msgs) {
          const data = (msgs as any)?.data ?? msgs;
          const arr: any[] = Array.isArray(data) ? data : (data as any)?.messages ?? [];
          const assistants = arr.filter((m: any) => m?.info?.role === "assistant" || m?.role === "assistant");
          writeHeartbeat(live, `refreshing task (${assistants.length} assistant messages)`);
          const latest = assistants[assistants.length - 1];
          const doneAt = latest?.info?.time?.completed ?? latest?.info?.completed ?? null;
          if (latest && doneAt) {
            const texts: string[] = [];
            for (const m of assistants) {
              const parts = m?.parts ?? m?.info?.parts ?? [];
              for (const p of parts) {
                if (p?.type === "text" && p?.text?.trim()) texts.push(p.text);
              }
            }
            const full = texts.join("\n\n") || "(no text output)";
            writeHeartbeat(live, `child done, finalizing (${full.length} chars)`);
            await completeJobInternal(live, "completed", full.slice(0, 280).replace(/\n+/g, " "), full);
            return;
          }
        } else {
          writeHeartbeat(live, "poll: no messages shape (child busy?)");
        }
      } catch (e: any) {
        writeHeartbeat(live, `poll exception → failed: ${String(e?.message ?? e).slice(0, 100)}`);
        await completeJobInternal(live, "failed", `Exception polling child: ${String(e?.message ?? e).slice(0, 200)}`);
        return;
      }
      // Timeout enforcement: running + elapsed > timeout → abort + stopped.
      if ((jobs.get(live.id) ?? live).state === "running" && live.timeoutMinutes > 0) {
        const elapsedMin = (Date.now() - live.startedAt) / 60000;
        if (elapsedMin > live.timeoutMinutes) {
          try { await client?.session?.abort?.({ path: { id: live.childSessionID } }).catch(() => null); } catch { /* noop */ }
          writeHeartbeat(live, `timeout after ${live.timeoutMinutes}m — aborting child`);
          await completeJobInternal(live, "stopped", `[TIMEOUT after ${live.timeoutMinutes}m] Partial output preserved. Use background_steer to continue in a new run.`);
        }
      }
    } catch (e: any) {
      console.error(`[background-ops] refreshTaskJob error on ${job?.id ?? "?"}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // v2.2.0: poll-side bash check mirroring v1.2.0 refreshBashJob (L376-402)
  // WITHOUT finalizeJob/deferreds — routes through completeJobInternal. The
  // close-handler stays the primary completion path; this covers races where
  // the close event fired while the record was momentarily non-running, plus
  // timeout enforcement via .md mtime. Never throws.
  function refreshBashJob(job: Job) {
    try {
      const live = jobs.get(job.id) ?? job;
      if (live.kind !== "bash" || live.state !== "running") return;
      const child = procs.get(live.id);
      writeHeartbeat(live, `bash running (exitCode=${child?.exitCode ?? "pending"})`);
      if (!child || child.exitCode !== null || (child as any)?.signalCode !== null) {
        if ((jobs.get(live.id) ?? live).state === "running") {
          const code = child?.exitCode ?? 0;
          const state = code === 0 ? "completed" : "failed";
          let body = "";
          try { body = readFileSync(live.outputPath, "utf8").replace(/^# .*\n\n(- .*\n)+\n---\n\n/, ""); } catch { body = `(exit code ${code})`; }
          const summary = body.slice(-280).replace(/\n+/g, " ");
          void completeJobInternal(live, state, summary, body);
          return;
        }
      }
      if ((jobs.get(live.id) ?? live).state === "running" && live.timeoutMinutes > 0) {
        if ((Date.now() - live.startedAt) / 60000 > live.timeoutMinutes) {
          try { child?.kill("SIGTERM"); } catch { /* noop */ }
          writeHeartbeat(live, `timeout after ${live.timeoutMinutes}m — SIGTERM`);
          void completeJobInternal(live, "stopped", `[TIMEOUT after ${live.timeoutMinutes}m] Partial output preserved.`);
        }
      }
    } catch (e: any) {
      console.error(`[background-ops] refreshBashJob error on ${job?.id ?? "?"}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // Conservative child-activity gate for task jobs. Returns true ONLY when the
  // child session provably shows no new activity within CONFIG.idleCloseMs.
  // ANY doubt (no lookup API, failed fetch, unrecognized shape, clock skew)
  // → false (do NOT reap; retry next sweep). Only ever called for jobs whose
  // heartbeat is ALREADY stale — children of fresh jobs are never polled.
  // Never throws (a failed lookup must never break the sweep loop).
  async function taskChildLooksSilent(job: Job): Promise<boolean> {
    try {
      if (!job.childSessionID) return false;
      const api: any = (c as any)?.session;
      if (!api) return false;
      const lookups: Array<() => Promise<any>> = [];
      if (typeof api.get === "function") lookups.push(() => api.get({ path: { id: job.childSessionID } }));
      if (typeof api.info === "function") lookups.push(() => api.info({ path: { id: job.childSessionID } }));
      if (typeof api.messages === "function") lookups.push(() => api.messages({ path: { id: job.childSessionID } }));
      if (typeof api.listMessages === "function") lookups.push(() => api.listMessages({ path: { id: job.childSessionID } }));
      if (!lookups.length) return false; // no known lookup shape → unresolvable → do NOT reap
      let raw: any = null;
      for (const fn of lookups) {
        try {
          const r = await fn();
          if (r && !(r as any)?.error && !(r as any)?.__bgError) { raw = r; break; }
        } catch { /* try next shape */ }
      }
      if (!raw) return false;
      const ts = extractSessionActivityMs(raw);
      if (ts === null) return false; // shape mismatch / no activity stamp → unresolvable → do NOT reap
      const age = Date.now() - ts;
      if (age < 0) return false; // clock skew → treat as fresh
      return age >= CONFIG.idleCloseMs;
    } catch { return false; }
  }
  // Idle-reaper sweep: closes running jobs silent for >= CONFIG.idleCloseMs on
  // BOTH signals (stale heartbeat AND stale child/output activity). Per-job
  // try/catch + outer try/catch so one bad record can never kill the loop.
  async function sweepIdleJobs() {
    try {
      for (const job of [...jobs.values()]) {
        try {
          if (job.state !== "running") continue; // never queued/completed/failed/stopped
          const ageMs = readHeartbeatAgeMs(job);
          if (ageMs === null) continue; // no/unparseable heartbeat → cannot prove stillness → skip
          if (ageMs < 0) continue; // clock skew (heartbeat in the future) → treat as fresh
          if (ageMs < CONFIG.idleCloseMs) continue; // fresh heartbeat → skip (children never polled)
          // v2.2.0 completion sweep: finalize genuinely-done task children
          // before evaluating silence. Deliberately placed AFTER the
          // heartbeat-staleness gate, NOT at loop top: refreshTaskJob writes
          // poll heartbeats, so polling every sweep would keep heartbeats
          // forever fresh and neuter the reaper. Best-effort; completion-wins
          // (a finalized job skips reaping via the state re-check below).
          if (job.kind === "task" && job.childSessionID) {
            try { await refreshTaskJob(c, job); } catch { /* best-effort */ }
            if ((jobs.get(job.id) ?? job).state !== "running") continue; // completion won
          }
          if (job.kind === "task") {
            if (!job.childSessionID) continue; // dispatch failed mid-flight → existing failure/timeout paths own it
            if (!(await taskChildLooksSilent(job))) continue; // fresh OR unresolvable → skip, retry next sweep
          } else {
            if (!bashOutputLooksSilent(job, CONFIG.idleCloseMs)) continue; // emitting OR stat unresolvable → skip
          }
          const live = jobs.get(job.id) ?? job;
          if (live.state !== "running") continue; // completion landed during probes → completion wins
          const mins = Math.max(1, Math.round(ageMs / 60_000));
          const label = `auto-idle-close (silent ${mins}m)`;
          await stopJobInternal(live, label);
          // r5-silent: reaper-reaped is a routine silent close, NOT red. Demoted
          // from console.error to app.log info (best-effort) + heartbeat trail.
          try {
            writeHeartbeat(live, `idle-reaper: reaped after ~${mins}m idle (${label})`);
            await c?.app?.log?.({ body: { service: "background-ops", level: "info", message: `idle-reaper: reaped ${live.id} [${live.kind}] after ~${mins}m idle (${label})`, extra: { jobId: live.id, state: live.state } } })?.catch(() => null);
          } catch { /* observability best-effort only */ }
        } catch (e: any) {
          console.error(`[background-ops] idle-reaper: per-job error on ${(job as Job)?.id ?? "?"}: ${String(e?.message ?? e).slice(0, 200)}`);
        }
      }
    } catch (e: any) {
      console.error(`[background-ops] idle-reaper: sweep error: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // NOTE: the plugin API surface used here exposes no teardown hook, so this
  // timer lives for the host process lifetime; unref() guarantees it never
  // holds the process open on its own.
  const idleReaperTimer = setInterval(() => { sweepIdleJobs().catch(() => { /* per-job logging already handled */ }); }, IDLE_SWEEP_INTERVAL_MS);
  (idleReaperTimer as any)?.unref?.();
  const background_run = tool({
    description: "Run a task subagent OR bash command in background. Returns readable id immediately. Noisy by default (DONE markers in background_list when notify_on_complete, default true). Use background_read to get full results.",
    args: {
      kind: tool.schema.enum(["task", "bash"]).describe("task=subagent, bash=shell"), prompt: tool.schema.string().describe("Task prompt OR shell command"),
      agent: tool.schema.string().optional().describe("Subagent name"), timeout_minutes: tool.schema.number().optional().describe("Max runtime minutes, default 15"),
      model: tool.schema.string().optional().describe("Model override"), notify_on_complete: tool.schema.boolean().optional().describe("Default true (BG_NOTIFY_DEFAULT env)"),
    },
    async execute(args, ctx) {
      const kind = args.kind as Kind;
      let timeout = args.timeout_minutes ?? 15;
      if (timeout <= 0 || timeout > CONFIG.maxTimeoutMinutes) timeout = CONFIG.maxTimeoutMinutes;
      if (kind === "bash") validateBashCommand(args.prompt);
      const cwd = ctx.directory || directory, id = genId(), dir = baseDir(cwd);
      const makeJob = (state: State, summary: string): Job => ({
        id, kind, state, prompt: args.prompt, agent: (args as any).agent, model: (args as any).model, rootSessionID: ctx.sessionID, startedAt: Date.now(), timeoutMinutes: timeout,
        title: `${kind}: ${args.prompt.slice(0, 60)}`, summary, outputPath: join(dir, `${id}.md`), statePath: join(dir, `${id}.json`), unread: true, notified: false, notifyOnComplete: (args as any).notify_on_complete ?? CONFIG.notifyDefault, _cwd: cwd,
      });
      if (runningCount() >= CONFIG.maxConcurrentJobs) {
        const job = makeJob("queued", "queued…");
        saveJob(job); jobs.set(job.id, job); queue.push(job);
        return { title: `background queued: ${id}`, output: `Background ${kind} queued: ${id} (queue position: ${queue.length}). It will start when a slot frees (${runningCount()}/${CONFIG.maxConcurrentJobs} running). Use background_read("${id}") to wait for the result.`, metadata: { backgroundId: id, kind, queued: true } };
      }
      const job = makeJob("running", "running…");
      jobs.set(job.id, job);
      if (kind === "task") await startTask(job);
      else startBash(job);
      return { title: `background started: ${id}`, output: `Background ${kind} started: ${id}\nParent receives a quiet wake on finish (context-only, no chat message) + toast: background_list shows [DONE state], background_read("${id}") returns full output. Toast + app.log + .notifications.log carry the signal. YOU (the agent) own the report: use background_read("${id}") when the result is needed and relay it to the human in your own words.`, metadata: { backgroundId: id, kind } };
    },
  });
  const background_list = tool({
    description: "List all background jobs with titles, summaries, states",
    args: {},
    async execute(_args, ctx) {
      // v2.2.0: refresh running jobs before render so genuinely-done children
      // surface as completed/failed without waiting for a sweep. Per-job
      // try/catch: one bad job never breaks the list.
      for (const j of [...jobs.values()]) {
        if (j.state !== "running") continue;
        try {
          if (j.kind === "task") await refreshTaskJob(c, j);
          else refreshBashJob(j);
        } catch { /* per-job best-effort */ }
      }
      const all = allKnownJobsFresh(ctx.directory || directory);
      return all.length ? all.map((j) => `- ${j.id} [${j.kind}/${j.state}] ${j.title} :: ${j.summary.slice(0, 120)}${j.unread ? " (unread)" : ""}`).join("\n") : "No background jobs yet.";
    },
  });
  const background_status = tool({
    description: "Live status of background jobs with heartbeat age + current step (instant, never blocks)",
    args: { id: tool.schema.string().optional().describe("Job id, omit for all running") },
    async execute(args, ctx) {
      // v2.2.0: same pre-render refresh as background_list (per-job try/catch).
      for (const j of [...jobs.values()]) {
        if (j.state !== "running") continue;
        try {
          if (j.kind === "task") await refreshTaskJob(c, j);
          else refreshBashJob(j);
        } catch { /* per-job best-effort */ }
      }
      const all = allKnownJobsFresh(ctx.directory || directory);
      const list = args.id ? all.filter((j) => j.id === args.id) : all.filter((j) => j.state === "running" || j.state === "queued");
      if (!list.length) return args.id ? `No job ${args.id}` : "No running jobs.";
      const out: string[] = [`Concurrency: ${runningCount()}/${CONFIG.maxConcurrentJobs} running, ${queue.length} queued`];
      for (const j of list) {
        const hb = (j.state === "running" || j.state === "queued") ? readLastHeartbeat(j) : null;
        out.push(`${j.id} [${j.kind}/${j.state}] elapsed ${Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000)}s timeout=${j.timeoutMinutes === 0 ? "none" : j.timeoutMinutes + "m"} pid=${j.pid ?? "-"} child=${j.childSessionID ?? "-"}${hb ? ` | hb=${hb.age} "${hb.step}"` : ""}\n  ${j.summary.slice(0, 200)}`);
      }
      return out.join("\n");
    },
  });
  const background_read = tool({
    description: "Retrieve full persisted result of a background job. Returns immediately — [running] while active (core background_read blocks for the actual wait).",
    args: { id: tool.schema.string().describe("Job id") },
    async execute(args, ctx) {
      const job = jobs.get(args.id) ?? loadJob(join(baseDir(ctx.directory || directory), `${args.id}.json`));
      if (!job) return `No job ${args.id}. Use background_list to see all.`;
      jobs.set(job.id, job);
      if (job.state === "running" || job.state === "queued") return `[running] ${job.id} [${job.kind}] — ${job.summary.slice(0, 200)}. Use background_status for live state; core background_read blocks until completion.`;
      job.unread = false; saveJob(job);
      try { return readFileSync(job.outputPath, "utf8").slice(0, 30000); } catch { return `[${job.state}] ${job.summary}`; }
    },
  });
  const background_steer = tool({
    description: "Inject follow-up instruction into a running background task (extends timeout window)",
    args: { id: tool.schema.string().describe("Job id"), instruction: tool.schema.string().describe("Follow-up instruction") },
    async execute(args, ctx) {
      const job = jobs.get(args.id) ?? loadJob(join(baseDir(ctx.directory || directory), `${args.id}.json`));
      if (!job) return `No job ${args.id}`;
      if (job.state !== "running" || job.kind === "bash" || !job.childSessionID) return `Cannot steer ${args.id}: state=${job.state} kind=${job.kind} child=${job.childSessionID ?? "none"}.`;
      await c.session.promptAsync({ path: { id: job.childSessionID }, body: { parts: toParts(args.instruction) } }).catch((e: any) => { throw new Error(`steer failed: ${String(e?.message ?? e).slice(0, 300)}`); });
      job.startedAt = Date.now(); job.summary = `steered: ${args.instruction.slice(0, 120)}`; saveJob(job);
      return `Steered ${args.id}. Timeout window reset.`;
    },
  });
  const background_stop = tool({
    description: "Abort a running background job. Partial output is preserved.",
    args: { id: tool.schema.string().describe("Job id") },
    async execute(args, ctx) {
      const job = jobs.get(args.id) ?? loadJob(join(baseDir(ctx.directory || directory), `${args.id}.json`));
      if (!job) return `No job ${args.id}`;
      if (job.state === "queued") {
        const idx = queue.findIndex((j) => j.id === job.id);
        if (idx >= 0) queue.splice(idx, 1);
        job.state = "stopped"; job.endedAt = Date.now(); job.unread = true;
        job.summary = "[STOPPED BY USER] removed from queue.";
        persistOutput(job, job.summary);
        saveJob(job);
        // r6-quiet-wake: queued-removal is a stop-equivalent → quiet wake.
        await notifyJob(c, job, { wake: true });
        return `Stopped queued ${args.id}.`;
      }
      if (job.state !== "running") return `Job ${args.id} already ${job.state}.`;
      await stopJobInternal(job, "STOPPED BY USER");
      return `Stopped ${args.id}. Partial output preserved — use background_read.`;
    },
  });
  const background_config = tool({
    description: "Print current CONFIG (timeout cap, concurrency, jobIdType, limits) and env override names. Read-only.",
    args: {},
    async execute() {
      return [
        `background-ops v${VERSION}`, "", "--- CONFIG ---",
        `maxTimeoutMinutes:   ${CONFIG.maxTimeoutMinutes}  (env: BG_MAX_TIMEOUT_MINUTES)`, `maxConcurrentJobs:   ${CONFIG.maxConcurrentJobs}  (env: BG_MAX_CONCURRENT_JOBS)`,
        `jobIdType:           ${CONFIG.jobIdType}  (env: BG_JOB_ID_TYPE)`, `maxBashCommandBytes: ${CONFIG.maxBashCommandBytes}  (env: BG_MAX_BASH_BYTES)`,
        `listCacheTtlMs:      ${CONFIG.listCacheTtlMs}  (env: BG_LIST_CACHE_TTL_MS)`, `notifyDefault:       ${CONFIG.notifyDefault}  (env: BG_NOTIFY_DEFAULT)`,
        `idleCloseMs:        ${CONFIG.idleCloseMs}  (env: BG_IDLE_CLOSE_MS, default 180000 = 3m; override in ~/.config/opencode/.env)`,
        "", "--- Runtime ---",
        `running: ${runningCount()}/${CONFIG.maxConcurrentJobs}`, `queued:  ${queue.length}`, `known:   ${jobs.size}`,
      ].join("\n");
    },
  });
  return {
    tool: { background_run, background_list, background_status, background_read, background_steer, background_stop, background_config },
    "tool.execute.before": async (input) => {
      if (input.tool === "background_run" && childSessions.has(input.sessionID)) throw new Error("background_run is disabled inside background children — do the work directly with read/edit/bash.");
    },
    event: async ({ event }: any) => {
      try {
        const sid = event?.type === "session.idle" ? event?.properties?.sessionID : null;
        if (!sid || !childSessions.has(sid)) return;
        writeFileSync(join(baseDir(directory), "last-idle.log"), `${new Date().toISOString()} | child idle ${sid}\n`, { flag: "a" });
        // v2.2.0: child went idle → refresh matching running jobs (finalize
        // genuinely-done children) then uniform-notify (v1.2.0 L909-913
        // pattern, routed through notifyJob). Best-effort per job.
        for (const j of [...jobs.values()]) {
          if (j.childSessionID !== sid || j.state !== "running") continue;
          try {
            await refreshTaskJob(c, j);
            await notifyJob(c, j, { wake: false }); // idle-event path: fully silent (no injection); no-op unless refresh just finalized it AND the funnel hasn't (notified guard usually wins)
          } catch { /* never break the host session */ }
        }
      } catch { /* never break the host session */ }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(`BACKGROUND OPS v${VERSION}: use background_run(kind="task"|"bash") to launch async work, continue immediately, then background_read(id) when ready. Terminal jobs quiet-wake the parent (context-only noReply, no chat message) + emit [DONE state] markers in background_list/summary when notify_on_complete (default true); always-on .notifications.log + app.log + toast; zero red stderr on terminal paths — poll via background_list/background_read. Live heartbeats visible in background_status. YOU own reporting: relay results to the human in your own words. Results persist under ~/.local/share/opencode/background-ops/.`);
    },
    "experimental.session.compacting": async (_input, output) => {
      try {
        const active = [...jobs.values()].filter((j) => j.state === "running" || j.unread);
        if (active.length) output.context.push(`Background jobs: running=[${active.filter((j) => j.state === "running").map((j) => j.id).join(",")}] unread=[${active.filter((j) => j.unread && j.state !== "running").map((j) => j.id).join(",")}]. Retrieve via background_read(id).`);
      } catch { /* noop */ }
    },
  };
};
export default BackgroundOps;