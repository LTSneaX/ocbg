import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Kind = "task" | "bash";
type State = "running" | "completed" | "failed" | "stopped";

interface Job {
  id: string;
  kind: Kind;
  state: State;
  prompt: string; // task prompt or bash command
  agent?: string;
  model?: string;
  rootSessionID: string;
  childSessionID?: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  timeoutMinutes: number;
  title: string;
  summary: string;
  outputPath: string;
  statePath: string;
  unread: boolean;
  notified: boolean;
  error?: string;
}

const ADJ = ["swift", "quiet", "bright", "calm", "bold", "keen", "warm", "cool"];
const COLOR = ["amber", "jade", "cobalt", "crimson", "slate", "violet", "emerald", "onyx"];
const ANIMAL = ["falcon", "otter", "wolf", "heron", "fox", "badger", "lynx", "wren"];

function genId(): string {
  const p = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${p(ADJ)}-${p(COLOR)}-${p(ANIMAL)}`;
}

function toParts(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function toModelRef(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
function projectId(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function baseDir(cwd: string): string {
  const dir = join(homedir(), ".local", "share", "opencode", "background-ops", projectId(cwd));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadJob(statePath: string): Job | null {
  try {
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, "utf8")) as Job;
  } catch {
    return null;
  }
}

function saveJob(job: Job) {
  mkdirSync(join(job.outputPath, ".."), { recursive: true });
  writeFileSync(job.statePath, JSON.stringify(job, null, 2));
}

function persistOutput(job: Job, body: string) {
  const header = `# ${job.title}\n\n- id: ${job.id}\n- kind: ${job.kind}\n- state: ${job.state}\n- started: ${new Date(job.startedAt).toISOString()}\n${job.endedAt ? `- ended: ${new Date(job.endedAt).toISOString()}\n` : ""}- summary: ${job.summary}\n\n---\n\n`;
  writeFileSync(job.outputPath, header + body);
}

// In-memory registry (reconciled with disk on list/status/read)
const jobs = new Map<string, Job>();
const procs = new Map<string, ChildProcess>();

function allKnownJobs(cwd: string): Job[] {
  const dir = baseDir(cwd);
  const out: Job[] = [];
  const seen = new Set<string>();
  for (const j of jobs.values()) {
    out.push(j);
    seen.add(j.id);
  }
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const j = loadJob(join(dir, f));
      if (j && !seen.has(j.id)) {
        jobs.set(j.id, j);
        out.push(j);
      }
    }
  } catch {
    // empty
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// Extract text from opencode message parts (tolerant across versions)
function partsText(parts: any[]): string {
  const chunks: string[] = [];
  for (const p of parts ?? []) {
    if (typeof p === "string") chunks.push(p);
    else if (p?.text) chunks.push(p.text);
    else if (p?.part?.text) chunks.push(p.part.text);
    else if (p?.type === "text" && p?.text) chunks.push((p as any).text);
  }
  return chunks.join("\n");
}

async function refreshTaskJob(client: any, job: Job): Promise<Job> {
  if (job.kind !== "task" || job.state !== "running" || !job.childSessionID) return job;
  try {
    const msgs: any = await client.session.messages({ path: { id: job.childSessionID } }).catch(() => null);
    const data = (msgs as any)?.data ?? msgs;
    const arr: any[] = Array.isArray(data) ? data : (data as any)?.messages ?? [];
    const assistants = arr.filter((m) => m?.info?.role === "assistant" || m?.role === "assistant");
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
      job.state = "completed";
      job.endedAt = Date.now();
      job.unread = true;
      job.summary = full.slice(0, 280).replace(/\n+/g, " ");
      job.title = `task: ${job.prompt.slice(0, 60)}`;
      persistOutput(job, full);
      saveJob(job);
      return job;
    }
  } catch (e: any) {
    job.error = String(e?.message ?? e);
  }
  // timeout enforcement
  if (job.state === "running" && job.timeoutMinutes > 0) {
    const elapsedMin = (Date.now() - job.startedAt) / 60000;
    if (elapsedMin > job.timeoutMinutes) {
      try {
        await client.session.abort({ path: { id: job.childSessionID } }).catch(() => null);
      } catch { /* noop */ }
      job.state = "stopped";
      job.endedAt = Date.now();
      job.summary = `[TIMEOUT after ${job.timeoutMinutes}m] ` + job.summary;
      persistOutput(job, `[TIMEOUT after ${job.timeoutMinutes}m]\n\nPartial output preserved. Use background_steer to continue in a new run.`);
      saveJob(job);
    }
  }
  return job;
}

function refreshBashJob(job: Job): Job {
  if (job.kind !== "bash" || job.state !== "running") return job;
  const child = procs.get(job.id);
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    // process ended; output file already streamed — finalize state
    if (job.state === "running") {
      const code = child?.exitCode ?? 0;
      job.state = code === 0 ? "completed" : "failed";
      job.endedAt = Date.now();
      job.unread = true;
      try {
        const log = readFileSync(job.outputPath, "utf8");
        job.summary = log.slice(-280).replace(/\n+/g, " ");
        job.title = `bash: ${job.prompt.slice(0, 60)}`;
        // re-wrap with header
        persistOutput(job, log.replace(/^# .*\n\n(- .*\n)+\n---\n\n/, ""));
      } catch { /* noop */ }
      saveJob(job);
    }
  }
  if (job.state === "running" && job.timeoutMinutes > 0) {
    if ((Date.now() - job.startedAt) / 60000 > job.timeoutMinutes) {
      try { child?.kill("SIGTERM"); } catch { /* noop */ }
      job.state = "stopped";
      job.endedAt = Date.now();
      job.summary = `[TIMEOUT after ${job.timeoutMinutes}m]`;
      saveJob(job);
    }
  }
  return job;
}

// Push completion into the parent session so the parent agent wakes up on
// its own (true push — no polling needed in TUI/serve). Once-only per job.
// Falls back gracefully when the parent is gone (one-shot `run` invocations):
// the persisted .md/.json on disk is always the source of truth.
async function notifyParent(client: any, job: Job): Promise<void> {
  if (job.notified || job.state === "running") return;
  job.notified = true;
  saveJob(job);
  const note =
    `[BACKGROUND DONE] ${job.id} [${job.kind}/${job.state}] ${job.summary.slice(0, 200)}\n` +
    `Full result: background_read("${job.id}")`;
  try {
    await client.session.promptAsync({
      path: { id: job.rootSessionID },
      body: { parts: toParts(note) },
    });
  } catch { /* parent gone (one-shot run) — disk persists */ }
  try {
    await client.tui.showToast({
      body: { message: `Background ${job.kind} done: ${job.id}`, variant: job.state === "completed" ? "success" : "warning" },
    });
  } catch { /* headless — no TUI to toast */ }
}

// sessionIDs that belong to background children (recursion guard + event routing)
const childSessions = new Set<string>();
function rememberChild(job: Job) {
  if (job.childSessionID) {
    childSessions.add(job.childSessionID);
    jobs.set(job.id, job);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const BackgroundOps: Plugin = async ({ client, directory }) => {
  const c: any = client;

  // Re-adopt orphans from disk (crash/restart recovery): repopulate routing.
  try {
    for (const j of allKnownJobs(directory)) rememberChild(j);
  } catch { /* noop */ }

  const background_run = tool({
    description: "Run a task subagent OR bash command in background. Returns readable id immediately. Use background_read to get results.",
    args: {
      kind: tool.schema.enum(["task", "bash"]).describe("task=subagent, bash=shell command"),
      prompt: tool.schema.string().describe("Task prompt OR shell command"),
      agent: tool.schema.string().optional().describe("Subagent name for kind=task (e.g. explore, general)"),
      timeout_minutes: tool.schema.number().optional().describe("Max runtime minutes, 0=infinite, default 15"),
      model: tool.schema.string().optional().describe("Model override for kind=task (provider/model-id)"),
    },
    async execute(args, ctx) {
      const kind = args.kind as Kind;
      const timeout = args.timeout_minutes ?? 15;
      const id = genId();
      const dir = baseDir(ctx.directory || directory);
      const job: Job = {
        id, kind,
        state: "running",
        prompt: args.prompt,
        agent: (args as any).agent,
        model: (args as any).model,
        rootSessionID: ctx.sessionID,
        startedAt: Date.now(),
        timeoutMinutes: timeout,
        title: `${kind}: ${args.prompt.slice(0, 60)}`,
        summary: "running…",
        outputPath: join(dir, `${id}.md`),
        statePath: join(dir, `${id}.json`),
        unread: true,
        notified: false,
      };

      if (kind === "task") {
        // Isolated child session, fire-and-forget via promptAsync
        const created: any = await c.session.create({ body: { title: `bg:${id}` } }).catch((e: any) => ({ error: e }));
        const childID = (created as any)?.data?.id ?? (created as any)?.id;
        if (!childID) throw new Error(`background task: session.create failed: ${JSON.stringify(created)?.slice(0, 300)}`);
        job.childSessionID = childID;
        persistOutput(job, "running…");
        saveJob(job);
        rememberChild(job);
        const body: any = { parts: toParts(args.prompt) };
        if ((args as any).agent) body.agent = (args as any).agent;
        const modelRef = toModelRef((args as any).model);
        if (modelRef) body.model = modelRef;
        const promptResult: any = await c.session.promptAsync({ path: { id: childID }, body }).catch((e: any) => ({ __bgError: e }));
        if (promptResult?.__bgError) {
          const errMsg = String(promptResult.__bgError?.message ?? promptResult.__bgError).slice(0, 500);
          job.state = "failed";
          job.endedAt = Date.now();
          job.error = `promptAsync failed: ${errMsg}`;
          persistOutput(job, `FAILED to dispatch: ${job.error}`);
          saveJob(job);
          throw new Error(job.error);
        }
      } else {
        // Bash: spawn detached, stream to output file
        persistOutput(job, `$ ${args.prompt}\n\n(running…)\n`);
        saveJob(job);
        jobs.set(id, job);
        const child = spawn(args.prompt, {
          shell: "/bin/bash",
          cwd: ctx.directory || directory,
          detached: false,
        });
        job.pid = child.pid;
        procs.set(id, child);
        saveJob(job);
        const chunks: string[] = [`$ ${args.prompt}\n`];
        child.stdout?.on("data", (d) => {
          chunks.push(String(d));
          writeFileSync(job.outputPath, `# ${job.title}\n\n- id: ${job.id}\n- kind: bash\n- state: running\n\n---\n\n` + chunks.join(""));
        });
        child.stderr?.on("data", (d) => {
          chunks.push(`[stderr] ${String(d)}`);
          writeFileSync(job.outputPath, `# ${job.title}\n\n- id: ${job.id}\n- kind: bash\n- state: running\n\n---\n\n` + chunks.join(""));
        });
        child.on("close", (code) => {
          chunks.push(`\n[exit code ${code}]`);
          const done = jobs.get(id) ?? job;
          if (done.state === "running") {
            done.state = code === 0 ? "completed" : "failed";
            done.endedAt = Date.now();
            done.unread = true;
            done.summary = chunks.join("").slice(-280).replace(/\n+/g, " ");
            persistOutput(done, chunks.join(""));
            saveJob(done);
            notifyParent(c, done).catch(() => null);
          } else {
            writeFileSync(job.outputPath, chunks.join(""));
          }
        });
      }

      return {
        title: `background started: ${id}`,
        output: `Background ${kind} started: ${id}\nIn TUI/serve the parent session gets an automatic [BACKGROUND DONE] message + toast on completion. In one-shot runs, call background_read("${id}") to retrieve the result.`,
        metadata: { backgroundId: id, kind },
      };
    },
  });

  const background_list = tool({
    description: "List all background jobs with titles, summaries, states",
    args: {},
    async execute(_args, ctx) {
      const cwd = ctx.directory || directory;
      const all = allKnownJobs(cwd);
      for (const j of all) {
        if (j.kind === "task") await refreshTaskJob(c, j);
        else refreshBashJob(j);
      }
      if (!all.length) return "No background jobs yet.";
      return all.map((j) => `- ${j.id} [${j.kind}/${j.state}] ${j.title} :: ${j.summary.slice(0, 120)}${j.unread ? " (unread)" : ""}`).join("\n");
    },
  });

  const background_status = tool({
    description: "Live status of background jobs (instant, never blocks)",
    args: {
      id: tool.schema.string().optional().describe("Job id, omit for all running"),
    },
    async execute(args, ctx) {
      const cwd = ctx.directory || directory;
      const all = allKnownJobs(cwd);
      const list = args.id ? all.filter((j) => j.id === args.id) : all.filter((j) => j.state === "running");
      if (!list.length) return args.id ? `No job ${args.id}` : "No running jobs.";
      const out: string[] = [];
      for (const j of list) {
        if (j.kind === "task") await refreshTaskJob(c, j);
        else refreshBashJob(j);
        const elapsed = ((j.endedAt ?? Date.now()) - j.startedAt) / 1000;
        out.push(`${j.id} [${j.kind}/${j.state}] elapsed ${Math.round(elapsed)}s timeout=${j.timeoutMinutes === 0 ? "none" : j.timeoutMinutes + "m"} pid=${j.pid ?? "-"} child=${j.childSessionID ?? "-"}\n  ${j.summary.slice(0, 200)}`);
      }
      return out.join("\n");
    },
  });

  const background_read = tool({
    description: "Retrieve full persisted result of a background job. Blocks briefly until terminal/timeout.",
    args: {
      id: tool.schema.string().describe("Job id"),
      wait_seconds: tool.schema.number().optional().describe("Max wait for completion, default 60"),
    },
    async execute(args, ctx) {
      const cwd = ctx.directory || directory;
      let job = jobs.get(args.id) ?? loadJob(join(baseDir(cwd), `${args.id}.json`));
      if (!job) return `No job ${args.id}. Use background_list to see all.`;
      jobs.set(job.id, job);
      const deadline = Date.now() + (args.wait_seconds ?? 60) * 1000;
      while (job.state === "running" && Date.now() < deadline) {
        if (job.kind === "task") await refreshTaskJob(c, job);
        else refreshBashJob(job);
        if (job.state !== "running") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      job.unread = false;
      saveJob(job);
      try {
        return readFileSync(job.outputPath, "utf8").slice(0, 30000);
      } catch {
        return `[${job.state}] ${job.summary}`;
      }
    },
  });

  const background_steer = tool({
    description: "Inject follow-up instruction into a running background task (extends timeout window)",
    args: {
      id: tool.schema.string().describe("Job id"),
      instruction: tool.schema.string().describe("Follow-up instruction"),
    },
    async execute(args, ctx) {
      const cwd = ctx.directory || directory;
      const job = jobs.get(args.id) ?? loadJob(join(baseDir(cwd), `${args.id}.json`));
      if (!job) return `No job ${args.id}`;
      if (job.state !== "running") return `Job ${args.id} is ${job.state}, cannot steer.`;
      if (job.kind === "bash") return "Steer is task-only. Use background_stop + new background_run for bash.";
      if (!job.childSessionID) return "No child session.";
      await c.session.promptAsync({ path: { id: job.childSessionID }, body: { parts: toParts(args.instruction) } }).catch((e: any) => {
        throw new Error(`steer failed: ${String(e?.message ?? e).slice(0, 300)}`);
      });
      job.startedAt = Date.now(); // fresh timeout window
      job.summary = `steered: ${args.instruction.slice(0, 120)}`;
      saveJob(job);
      return `Steered ${args.id}. Timeout window reset.`;
    },
  });

  const background_stop = tool({
    description: "Abort a running background job. Partial output is preserved.",
    args: {
      id: tool.schema.string().describe("Job id"),
    },
    async execute(args, ctx) {
      const cwd = ctx.directory || directory;
      const job = jobs.get(args.id) ?? loadJob(join(baseDir(cwd), `${args.id}.json`));
      if (!job) return `No job ${args.id}`;
      if (job.state !== "running") return `Job ${args.id} already ${job.state}.`;
      if (job.kind === "task" && job.childSessionID) {
        await c.session.abort({ path: { id: job.childSessionID } }).catch(() => null);
      } else {
        try { procs.get(job.id)?.kill("SIGTERM"); } catch { /* noop */ }
      }
      job.state = "stopped";
      job.endedAt = Date.now();
      job.unread = true;
      job.summary = "[STOPPED BY USER] " + job.summary;
      try {
        const cur = readFileSync(job.outputPath, "utf8");
        persistOutput(job, cur.replace(/^# .*\n\n(- .*\n)+\n---\n\n/, "") + "\n\n[STOPPED BY USER]");
      } catch {
        persistOutput(job, "[STOPPED BY USER] partial output preserved.");
      }
      saveJob(job);
      return `Stopped ${args.id}. Partial output preserved — use background_read.`;
    },
  });

  return {
    tool: {
      background_run,
      background_list,
      background_status,
      background_read,
      background_steer,
      background_stop,
    },
    // No nested background managers: children use direct tools.
    "tool.execute.before": async (input) => {
      if (input.tool === "background_run" && childSessions.has(input.sessionID)) {
        throw new Error("background_run is disabled inside background children — do the work directly with read/edit/bash.");
      }
    },
    // True push: child went idle → finalize → wake the parent automatically.
    event: async ({ event }: any) => {
      try {
        if (event?.type !== "session.idle") return;
        const sid: string | undefined = event?.properties?.sessionID;
        if (!sid || !childSessions.has(sid)) return;
        for (const j of jobs.values()) {
          if (j.childSessionID === sid && j.state === "running") {
            await refreshTaskJob(c, j);
            await notifyParent(c, j);
          }
        }
      } catch { /* never break the host session on notify failure */ }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        `BACKGROUND OPS: use background_run(kind="task"|"bash") to launch async work, continue immediately, then background_read(id) when ready. Never poll in a loop — status is instant. Results persist under ~/.local/share/opencode/background-ops/.`
      );
    },
    "experimental.session.compacting": async (_input, output) => {
      try {
        const running = [...jobs.values()].filter((j) => j.state === "running");
        const unread = [...jobs.values()].filter((j) => j.state !== "running" && j.unread);
        if (running.length || unread.length) {
          output.context.push(
            `Background jobs: running=[${running.map((j) => j.id).join(",")}] unread=[${unread.map((j) => j.id).join(",")}]. Retrieve via background_read(id).`
          );
        }
      } catch { /* noop */ }
    },
  };
};

export default BackgroundOps;
