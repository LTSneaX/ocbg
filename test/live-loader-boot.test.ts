// LIVE loader boot proof — opt-in via LIVE_LOADER=1.
//
// Default `npm test` SKIPS this file (describe.skipIf) so the suite stays
// fast; CI runs it explicitly with LIVE_LOADER=1. It proves BOTH directions
// against a REAL `opencode serve` headless server — the actual loader path,
// not the in-process factory:
//
//   GOOD: repo dist bytes (copied to a TMP fixture, NEVER the live plugin
//         dir) boot a healthy server that wires the 7-tool surface.
//   ASIDE: --pure (no plugins) boots healthy — proves the harness is sound,
//         so a GOOD failure is attributable to the fixture, not the rig.
//   BAD:  a broken-surface fixture (non-function export) is REJECTED by the
//         loader ("failed to load plugin ... Plugin export is not a
//         function") while the host still boots — proves the loader
//         validates instead of silently ignoring.
//
// Isolation doctrine (no live touch):
//   - TMP HOME per server (config + data + state all under TMP; the live
//     ~/.config/opencode and ~/.local/share/opencode are never read/written
//     by the spawned servers).
//   - TMP plugin fixture: byte-copy of <repo>/dist/src/plugin/background.js
//     (+ node_modules symlink for the "@opencode-ai/plugin" bare import).
//   - Spare ports only (4123/4124/4125) — NEVER 4096 (live server).
//   - No TUI launches (serve only), no commits/pushes/deploys.
//   - Auth reuses OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD env
//     (basic auth, same as `opencode attach`).
//
// Proof points per direction:
//   healthy  = authed GET /session -> 200 within POLL_TIMEOUT_MS (~15s).
//   wired    = server log contains the factory "factory wired" line WITH the
//              exact 7-tool list (emitted only when the factory ran to
//              completion on the live path) + TMP-fixture import manifest
//              keys + factory tool surface.
//   rejected = server log contains "failed to load plugin" + fixture path +
//              "Plugin export is not a function", and NO "factory wired".

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE = process.env.LIVE_LOADER === "1";

// Spare-port assignments (NEVER 4096 = live). Verified free before writing;
// each spawn pre-checks its port and fails loudly instead of stealing it.
const PORT_GOOD = 4123;
const PORT_BROKEN = 4124;
const PORT_ASIDE = 4125;
const POLL_TIMEOUT_MS = 15_000;
const POLL_STEP_MS = 500;

const SEVEN = [
  "background_run",
  "background_list",
  "background_status",
  "background_read",
  "background_steer",
  "background_stop",
  "background_config",
] as const;
const SEVEN_LIST = `tools=[${SEVEN.join(",")}]`;

// Exact dist manifest (mirrors test/boot-contract.test.ts FULL_ALLOWLIST —
// r8 strip: exactly BackgroundOps+default, zero helper exports. The loader
// tripwire "Plugin export is not a function" fires on anything else, so the
// TMP fixture copy must match byte-for-byte semantics).
const PLUGIN_ENTRIES = ["BackgroundOps", "default"];
const FULL_ALLOWLIST = [...PLUGIN_ENTRIES].sort();

const REPO_ROOT = process.cwd();
const DIST_PLUGIN = join(REPO_ROOT, "dist", "src", "plugin", "background.js");

interface LiveServer {
  name: string;
  port: number;
  proc: ChildProcess;
  log: string;
  healthy: boolean;
}

function basicAuth(user: string, pw: string): string {
  return "Basic " + Buffer.from(`${user}:${pw}`).toString("base64");
}

async function portServes(port: number, user: string, pw: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      headers: { Authorization: basicAuth(user, pw) },
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitHealthy(port: number, user: string, pw: string): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portServes(port, user, pw)) return true;
    await new Promise((r) => setTimeout(r, POLL_STEP_MS));
  }
  return false;
}

function spawnServe(opts: {
  name: string;
  port: number;
  home: string;
  work: string;
  pure: boolean;
  extraEnv?: Record<string, string>;
}): LiveServer {
  const args = ["serve", "--port", String(opts.port), "--hostname", "127.0.0.1", "--print-logs"];
  if (opts.pure) args.push("--pure");
  const proc = spawn("opencode", args, {
    env: { ...process.env, HOME: opts.home, BG_DEBUG: "1", ...opts.extraEnv },
    cwd: opts.work,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const srv: LiveServer = { name: opts.name, port: opts.port, proc, log: "", healthy: false };
  const onData = (d: Buffer): void => {
    srv.log += d.toString("utf8");
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  return srv;
}

async function stopServe(srv: LiveServer): Promise<void> {
  try {
    srv.proc.kill("SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (srv.proc.exitCode !== null || srv.proc.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    srv.proc.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}

describe.skipIf(!LIVE)("live-loader boot proof (LIVE_LOADER=1, real opencode serve)", () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(tmpdir(), `ocbg-loader-${stamp}`);
  const fixtureJs = join(root, "fixture", "plugin", "background.js");
  const brokenJs = join(root, "fixture-broken", "plugin", "background.js");

  let good: LiveServer | null = null;
  let broken: LiveServer | null = null;
  let aside: LiveServer | null = null;

  beforeAll(async () => {
    const pw = process.env.OPENCODE_SERVER_PASSWORD;
    expect(
      pw,
      "LIVE_LOADER=1 requires OPENCODE_SERVER_PASSWORD in env (basic-auth health probe)",
    ).toBeTruthy();
    const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    expect(
      existsSync(DIST_PLUGIN),
      `dist bytes missing at ${DIST_PLUGIN} — refresh with \`npx tsc\` (emit) first; the loader executes dist, never src`,
    ).toBe(true);

    // --- Fixtures (TMP only; live ~/.config/opencode/plugins/ untouched) ---
    mkdirSync(join(root, "fixture", "plugin"), { recursive: true });
    mkdirSync(join(root, "fixture-broken", "plugin"), { recursive: true });
    copyFileSync(DIST_PLUGIN, fixtureJs);
    try {
      symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "fixture", "node_modules"));
    } catch {
      /* symlink exists on re-run inside the same stamp — impossible; ignore */
    }
    writeFileSync(
      brokenJs,
      "export const BackgroundOps = { nope: true };\nexport default BackgroundOps;\n",
    );

    const mkHome = (name: string, pluginAbsPath: string | null): { home: string; work: string } => {
      const home = join(root, name, "home");
      const work = join(root, name, "work");
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      mkdirSync(work, { recursive: true });
      const plugin = pluginAbsPath ? `{"plugin": ${JSON.stringify([pluginAbsPath])}}` : "{}";
      const cfg = JSON.parse(plugin);
      cfg["$schema"] = "https://opencode.ai/config.json";
      writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify(cfg, null, 2));
      return { home, work };
    };

    const goodPaths = mkHome("good", fixtureJs);
    const brokenPaths = mkHome("broken", brokenJs);
    const asidePaths = mkHome("aside", null);

    // --- Port pre-check: fail loudly instead of stealing a live port ---
    for (const port of [PORT_GOOD, PORT_BROKEN, PORT_ASIDE]) {
      expect(await portServes(port, user, pw as string), `spare port ${port} already serves — refusing to steal it`).toBe(
        false,
      );
    }

    // --- Spawn all three concurrently; poll each to healthy (~15s budget) ---
    good = spawnServe({ name: "good", port: PORT_GOOD, ...goodPaths, pure: false });
    broken = spawnServe({ name: "broken", port: PORT_BROKEN, ...brokenPaths, pure: false });
    aside = spawnServe({ name: "aside", port: PORT_ASIDE, ...asidePaths, pure: true });

    [good, broken, aside] = await Promise.all(
      [good, broken, aside].map(async (srv) => {
        srv.healthy = await waitHealthy(srv.port, user, pw as string);
        return srv;
      }),
    );
    // Settle: let the plugin-config phase flush into the piped log.
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    await Promise.all([good, broken, aside].filter(Boolean).map((srv) => stopServe(srv as LiveServer)));
  });

  it("good fixture boots healthy and serves (TMP bytes, spare port, isolated HOME)", () => {
    expect(good?.healthy, `good server log tail:\n${good?.log.slice(-2000)}`).toBe(true);
    expect(good?.log).toContain(`opencode server listening on http://127.0.0.1:${PORT_GOOD}`);
  });

  it("good fixture wires the 7-tool surface (live log + manifest keys + factory)", async () => {
    // (a) Live-path proof: the factory ran to completion INSIDE the server —
    // this line is emitted only at the end of the BackgroundOps factory.
    expect(good?.log).toContain("factory wired");
    expect(good?.log).toContain(SEVEN_LIST);
    // (b) Loader accepted the fixture: no tripwire against OUR fixture path.
    // (The host-global "plugin config hook failed ... N.config" line is
    // known pre-existing host noise — present on the live 4096 boot too —
    // so the gate is scoped to OUR path, not to all ERROR lines.)
    expect(good?.log ?? "").not.toContain("failed to load plugin");
    // (c) Manifest keys on the EXACT TMP bytes the server loaded: import the
    // fixture copy (read-only) under an isolated HOME so the in-test factory
    // call stamps its state marker in TMP, never in the live data dir.
    const savedHome = process.env.HOME;
    const savedBgDebug = process.env.BG_DEBUG;
    const fakeHome = join(root, "import-home");
    mkdirSync(fakeHome, { recursive: true });
    try {
      process.env.HOME = fakeHome;
      delete process.env.BG_DEBUG; // keep the in-test boot quiet
      const mod = (await import(/* @vite-ignore */ pathToFileURL(fixtureJs).href)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(mod).sort()).toEqual(FULL_ALLOWLIST);
      for (const k of FULL_ALLOWLIST) {
        expect(typeof mod[k], `export ${k} must be a function (loader tripwire)`).toBe("function");
      }
      const factory = (mod["default"] ?? mod["BackgroundOps"]) as (input: unknown) => Promise<{
        tool: Record<string, { execute: unknown }>;
      }>;
      const noop = async (): Promise<Record<string, never>> => ({});
      const plugin = await factory({
        client: {
          session: { create: noop, promptAsync: noop, messages: noop, abort: noop, get: noop, info: noop, listMessages: noop },
          app: { log: noop },
          tui: { showToast: noop },
        },
        directory: join(root, "import-work"),
      });
      for (const name of SEVEN) {
        expect(
          typeof plugin?.tool?.[name]?.execute,
          `TMP-fixture tool ${name} must expose execute()`,
        ).toBe("function");
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedBgDebug === undefined) delete process.env.BG_DEBUG;
      else process.env.BG_DEBUG = savedBgDebug;
    }
  });

  it("plugin-aside (--pure) boots healthy — harness sound, failures attributable", () => {
    expect(aside?.healthy, `aside server log tail:\n${aside?.log.slice(-2000)}`).toBe(true);
    expect(aside?.log).toContain(`opencode server listening on http://127.0.0.1:${PORT_ASIDE}`);
  });

  it("broken surface rejected by the loader while the host still boots", () => {
    // Host survives a bad plugin (continues to serve) ...
    expect(broken?.healthy, `broken server log tail:\n${broken?.log.slice(-2000)}`).toBe(true);
    // ... but the loader REJECTS the surface with the tripwire marker ...
    expect(broken?.log).toContain("failed to load plugin");
    expect(broken?.log).toContain("fixture-broken");
    expect(broken?.log).toContain("Plugin export is not a function");
    // ... and the factory never ran (no wiring from the bad bytes).
    expect(broken?.log ?? "").not.toContain("factory wired");
  });
});
