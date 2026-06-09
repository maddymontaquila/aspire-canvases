import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

// Per-instance state: server, url, SSE clients, polling interval, cached data
const instances = new Map();
const traceInstances = new Map();

// ─── Aspire CLI helpers ─────────────────────────────────────────────────────

async function listRunningAppHosts(cwd) {
    const result = await runAspireCommand(["ps", "--format", "Json", "--non-interactive", "--nologo"], cwd, 10000);
    if (!result.ok) {
        return [];
    }
    try {
        const parsed = JSON.parse(result.stdout || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizeRunningAppHosts(hosts, cwd) {
    const normalizedCwd = String(cwd || "");
    const seen = new Set();
    return (Array.isArray(hosts) ? hosts : [])
        .map((h) => {
            const apphostPath = String(h?.appHostPath || "").trim();
            if (!apphostPath || seen.has(apphostPath)) return null;
            seen.add(apphostPath);
            const fromWorkspace = normalizedCwd ? apphostPath.startsWith(normalizedCwd + "/") : false;
            const defaultName = basename(dirname(apphostPath));
            const label = String(h?.appName || h?.displayName || h?.name || defaultName).trim() || defaultName;
            const dashboardUrl = String(h?.dashboardUrl || "").trim();
            return { apphostPath, label, fromWorkspace, dashboardUrl };
        })
        .filter(Boolean);
}

async function listAppHostCandidates(cwd) {
    const hosts = await listRunningAppHosts(cwd);
    return normalizeRunningAppHosts(hosts, cwd);
}

async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function canStartWorkspaceAppHost(cwd) {
    const root = String(cwd || process.cwd());
    const rootCandidates = [
        "apphost.ts",
        "apphost.csproj",
        "AppHost.csproj",
    ];
    for (const name of rootCandidates) {
        if (await fileExists(pathJoin(root, name))) return true;
    }

    const ignoredDirs = new Set([".git", "node_modules", "bin", "obj", "dist", "build", ".next", ".turbo"]);
    const queue = [{ dir: root, depth: 0 }];
    const maxDepth = 3;

    while (queue.length) {
        const { dir, depth } = queue.shift();
        let entries = [];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const entryName = entry.name || "";
            if (entry.isFile()) {
                const lower = entryName.toLowerCase();
                if (lower === "apphost.ts" || lower === "apphost.csproj") return true;
                if (lower.endsWith(".csproj") && lower.includes("apphost")) return true;
                continue;
            }
            if (!entry.isDirectory()) continue;
            if (depth >= maxDepth) continue;
            if (ignoredDirs.has(entryName)) continue;
            if (entryName.startsWith(".")) continue;
            queue.push({ dir: pathJoin(dir, entryName), depth: depth + 1 });
        }
    }

    return false;
}

async function resolveEffectiveAppHost(apphost, cwd) {
    if (apphost) return { apphostPath: apphost, source: "input" };

    const candidates = await listAppHostCandidates(cwd);
    if (!candidates.length) return null;
    const local = candidates.find((h) => h.fromWorkspace);
    if (local?.apphostPath) {
        return { apphostPath: local.apphostPath, source: "workspace" };
    }
    return null;
}

let _cachedAspireBinary = null;

async function runBinaryCommand(binary, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(binary, args, { cwd: cwd || process.cwd() });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let spawnError = null;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGTERM"); } catch { }
        }, timeoutMs);

        child.stdout?.on("data", (d) => { stdout += String(d); });
        child.stderr?.on("data", (d) => { stderr += String(d); });
        child.on("close", (code) => {
            clearTimeout(timer);
            const out = stdout.trim();
            const err = stderr.trim();
            if (code === 0) {
                resolve({ ok: true, stdout: out, stderr: err });
                return;
            }
            if (spawnError?.code === "ENOENT") {
                resolve({ ok: false, code: "cli_not_found", stdout: out, stderr: err, message: `${binary} not found` });
                return;
            }
            const fallback = timedOut ? `Command timed out (${timeoutMs}ms)` : `Command failed (${code})`;
            resolve({ ok: false, code: "error", stdout: out, stderr: err, message: (err || out || fallback).slice(0, 400) });
        });
        child.on("error", (e) => {
            spawnError = e || null;
            clearTimeout(timer);
            if (e?.code === "ENOENT") {
                resolve({ ok: false, code: "cli_not_found", stdout: "", stderr: "", message: `${binary} not found` });
            } else {
                resolve({ ok: false, code: "error", stdout: "", stderr: "", message: (e?.message || String(e)).slice(0, 400) });
            }
        });
    });
}

async function discoverAspireBinary(cwd) {
    if (_cachedAspireBinary) return _cachedAspireBinary;
    const shell = process.env.SHELL || "/bin/zsh";
    const probe = await runBinaryCommand(shell, ["-ilc", "command -v aspire || true"], cwd, 8000);
    if (!probe.ok) return null;
    const found = String(probe.stdout || "").split(/\r?\n/).map((v) => v.trim()).find(Boolean);
    if (!found) return null;
    _cachedAspireBinary = found;
    return found;
}

async function runAspireCommand(args, cwd, timeoutMs = 15000) {
    const direct = await runBinaryCommand("aspire", args, cwd, timeoutMs);
    if (direct.ok || direct.code !== "cli_not_found") {
        return direct;
    }

    const discovered = await discoverAspireBinary(cwd);
    if (discovered) {
        const viaShellPath = await runBinaryCommand(discovered, args, cwd, timeoutMs);
        if (viaShellPath.ok || viaShellPath.code !== "cli_not_found") {
            return viaShellPath;
        }
    }

    return {
        ok: false,
        code: "cli_not_found",
        stdout: "",
        stderr: "",
        message: "Aspire CLI was not found. Install Aspire CLI or add it to PATH.",
    };
}

async function ensureAspireCliAvailable(cwd) {
    const result = await runAspireCommand(["--version"], cwd, 5000);
    if (result.ok) return { ok: true };
    if (result.code === "cli_not_found") {
        return {
            ok: false,
            code: "cli_not_found",
            message: "Aspire CLI was not found for this extension process. Add Aspire to PATH (or install it) and reload extensions.",
        };
    }
    return {
        ok: false,
        code: "error",
        message: result.message || "Unable to run Aspire CLI.",
    };
}

async function startAppHost(cwd) {
    const result = await runAspireCommand(["start", "--nologo", "--non-interactive"], cwd, 60000);
    if (result.ok) {
        return { ok: true };
    }
    return {
        ok: false,
        code: result.code || "error",
        message: (result.message || "Failed to start AppHost.").slice(0, 500),
    };
}

async function runNamedResourceCommand(name, command, commandArgs, apphost, cwd) {
    const args = ["resource", name, command];
    const selected = await resolveEffectiveAppHost(apphost, cwd);
    if (selected?.apphostPath) args.push("--apphost", selected.apphostPath);
    args.push("--non-interactive", "--nologo");

    for (const [key, value] of Object.entries(commandArgs || {})) {
        const flag = toCliFlag(key);
        if (typeof value === "boolean") {
            if (value) args.push(flag);
            continue;
        }
        if (value === undefined || value === null || String(value).trim() === "") {
            continue;
        }
        args.push(flag, String(value));
    }

    const result = await runAspireCommand(args, cwd, 45000);
    if (result.ok) {
        return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
    }
    return {
        ok: false,
        message: (result.message || "Command failed").slice(0, 2000),
        stdout: result.stdout || "",
        stderr: result.stderr || "",
    };
}

async function fetchResources(apphost, cwd) {
    const selected = await resolveEffectiveAppHost(apphost, cwd);
    if (!selected?.apphostPath) {
        const cli = await ensureAspireCliAvailable(cwd);
        if (!cli.ok) {
            return { ok: false, code: cli.code, message: cli.message };
        }
        return { ok: false, code: "no_apphost", message: "No running AppHost found in this workspace." };
    }

    const args = ["describe", "--format", "Json", "--non-interactive", "--nologo", "--apphost", selected.apphostPath];
    const result = await runAspireCommand(args, cwd, 15000);
    if (!result.ok) {
        return { ok: false, code: result.code || "error", message: result.message };
    }
    try {
        const text = result.stdout.trim();
        if (!text) return { ok: false, code: "no_apphost", message: "No running AppHost found in this workspace." };
        const data = JSON.parse(text);
        const resources = Array.isArray(data) ? data : (data.resources ?? data.items ?? []);
        return { ok: true, resources, apphostPath: selected.apphostPath, apphostSource: selected.source };
    } catch (e) {
        const msg = (e.message || String(e));
        return { ok: false, code: "error", message: msg.slice(0, 300) };
    }
}

function deriveDashboardUrls(items) {
    const urls = (Array.isArray(items) ? items : [])
        .map((x) => String(x?.dashboardUrl || "").trim())
        .filter(Boolean);

    if (!urls.length) {
        return { dashboardBaseUrl: "", tracesUrl: "", logsUrl: "" };
    }

    let base = "";
    try {
        base = new URL(urls[0]).origin;
    } catch {
        base = urls[0].replace(/\/+$/, "");
    }
    return {
        dashboardBaseUrl: base,
        tracesUrl: `${base}/traces`,
        logsUrl: `${base}/structuredlogs`,
    };
}

async function fetchOtelTraces({ apphost, cwd, resource, limit = 50, hasError, search, traceId } = {}) {
    const selected = await resolveEffectiveAppHost(apphost, cwd);
    if (!selected?.apphostPath) {
        const cli = await ensureAspireCliAvailable(cwd);
        if (!cli.ok) return { ok: false, code: cli.code, message: cli.message };
        return { ok: false, code: "no_apphost", message: "No running AppHost found in this workspace." };
    }

    const args = ["otel", "traces"];
    if (resource) args.push(String(resource));
    args.push("--apphost", selected.apphostPath, "--format", "Json", "--non-interactive", "--nologo");
    if (Number.isFinite(limit) && Number(limit) > 0) args.push("-n", String(Math.floor(Number(limit))));
    if (typeof hasError === "boolean") args.push("--has-error", String(hasError));
    if (search) args.push("--search", String(search));
    if (traceId) args.push("--trace-id", String(traceId));

    const result = await runAspireCommand(args, cwd, 20000);
    if (!result.ok) {
        return { ok: false, code: result.code || "error", message: result.message || "Failed to query traces." };
    }

    try {
        const traces = JSON.parse(result.stdout || "[]");
        const links = deriveDashboardUrls(traces);
        return {
            ok: true,
            traces: Array.isArray(traces) ? traces : [],
            ...links,
            apphostPath: selected.apphostPath,
            apphostSource: selected.source,
        };
    } catch (e) {
        return { ok: false, code: "parse_error", message: (e?.message || String(e)).slice(0, 300) };
    }
}

async function fetchOtelLogs({ apphost, cwd, resource, limit = 50, severity, search, traceId } = {}) {
    const selected = await resolveEffectiveAppHost(apphost, cwd);
    if (!selected?.apphostPath) {
        const cli = await ensureAspireCliAvailable(cwd);
        if (!cli.ok) return { ok: false, code: cli.code, message: cli.message };
        return { ok: false, code: "no_apphost", message: "No running AppHost found in this workspace." };
    }

    const args = ["otel", "logs"];
    if (resource) args.push(String(resource));
    args.push("--apphost", selected.apphostPath, "--format", "Json", "--non-interactive", "--nologo");
    if (Number.isFinite(limit) && Number(limit) > 0) args.push("-n", String(Math.floor(Number(limit))));
    if (severity) args.push("--severity", String(severity));
    if (search) args.push("--search", String(search));
    if (traceId) args.push("--trace-id", String(traceId));

    const result = await runAspireCommand(args, cwd, 20000);
    if (!result.ok) {
        return { ok: false, code: result.code || "error", message: result.message || "Failed to query logs." };
    }

    try {
        const logs = JSON.parse(result.stdout || "[]");
        const links = deriveDashboardUrls(logs);
        return {
            ok: true,
            logs: Array.isArray(logs) ? logs : [],
            ...links,
            apphostPath: selected.apphostPath,
            apphostSource: selected.source,
        };
    } catch (e) {
        return { ok: false, code: "parse_error", message: (e?.message || String(e)).slice(0, 300) };
    }
}

async function runResourceCommand(name, command, apphost, cwd) {
    return runNamedResourceCommand(name, command, {}, apphost, cwd);
}

function toCliFlag(inputName) {
    return "--" + String(inputName)
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[_\s]+/g, "-")
        .toLowerCase();
}

async function readJsonBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => {
            body += String(chunk);
            if (body.length > 1024 * 1024) req.destroy();
        });
        req.on("end", () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                resolve({});
            }
        });
        req.on("error", () => resolve({}));
    });
}

const COPILOT_HOME = process.env.COPILOT_HOME || pathJoin(homedir(), ".copilot");
const BRANDING_CONFIG_PATH = pathJoin(COPILOT_HOME, "extensions", "aspire-resources", "artifacts", "branding.json");

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function humanizeAppName(value) {
    const normalized = String(value || "")
        .replace(/\.[^/.]+$/, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized) return "App";
    return normalized.replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferAppName(cwd, apphost) {
    if (apphost) {
        const apphostBase = basename(apphost);
        if (/^apphost\.[a-z0-9]+$/i.test(apphostBase)) {
            const repoDir = basename(cwd || dirname(apphost));
            return humanizeAppName(repoDir);
        }
        return humanizeAppName(apphostBase.replace(extname(apphostBase), ""));
    }
    return humanizeAppName(basename(cwd || "app"));
}

async function readJsonFile(filePath) {
    try {
        const text = await readFile(filePath, "utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
    } catch { }
    return {};
}

function mergeBranding(baseCfg, overrideCfg) {
    const base = baseCfg || {};
    const over = overrideCfg || {};
    return {
        ...base,
        ...over,
        repositories: { ...(base.repositories || {}), ...(over.repositories || {}) },
        repos: { ...(base.repos || {}), ...(over.repos || {}) },
    };
}

async function loadBrandingConfig(cwd) {
    const globalCfg = await readJsonFile(BRANDING_CONFIG_PATH);
    if (!cwd) return globalCfg;

    const repoCfgA = await readJsonFile(pathJoin(cwd, ".github", "extensions", "aspire-resources", "branding.json"));
    return mergeBranding(globalCfg, repoCfgA);
}

async function resolveBranding({ cwd, apphost, input }) {
    const repoKey = basename(cwd || "workspace");
    const cfg = await loadBrandingConfig(cwd);
    const repoCfg = (cfg.repositories && cfg.repositories[repoKey]) || (cfg.repos && cfg.repos[repoKey]) || {};

    const appName = String(input?.appName || repoCfg.appName || cfg.defaultAppName || "App").trim() || "App";
    const emoji = String(input?.emoji || repoCfg.emoji || cfg.defaultEmoji || "💫").trim() || "💫";
    const title = `${appName} Resources`;
    return { appName, emoji, title, repoKey };
}

// ─── SSE broadcasting ────────────────────────────────────────────────────────

function broadcast(clients, payload) {
    const msg = "data: " + JSON.stringify(payload) + "\n\n";
    for (const res of [...clients]) {
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

// ─── HTML / JS assets ────────────────────────────────────────────────────────

const HTML_TEMPLATE = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__APP_TITLE__</title>
  <style>
    :root {
      --kg-bg: var(--background-color-default, #fff);
      --kg-fg: var(--text-color-default, #1f2328);
      --kg-muted: var(--text-color-muted, #656d76);
      --kg-border: var(--border-color-default, #d0d7de);
      --kg-border-muted: color-mix(in srgb, var(--kg-border) 65%, transparent);
      --kg-panel: color-mix(in srgb, var(--kg-fg) 6%, var(--kg-bg));
      --kg-hover: var(--background-color-hover, color-mix(in srgb, var(--kg-fg) 9%, var(--kg-bg)));
      --kg-accent: var(--color-accent-emphasis, var(--kg-fg));
      --kg-accent-soft: color-mix(in srgb, var(--kg-accent) 14%, var(--kg-bg));
      --kg-success-fg: var(--color-success-fg, var(--kg-accent));
      --kg-success-bg: var(--color-success-subtle, color-mix(in srgb, var(--kg-success-fg) 16%, var(--kg-bg)));
      --kg-success-border: var(--color-success-muted, color-mix(in srgb, var(--kg-success-fg) 38%, var(--kg-bg)));
      --kg-warning-fg: var(--color-attention-fg, var(--kg-accent));
      --kg-warning-bg: var(--color-attention-subtle, color-mix(in srgb, var(--kg-warning-fg) 16%, var(--kg-bg)));
      --kg-warning-border: var(--color-attention-muted, color-mix(in srgb, var(--kg-warning-fg) 38%, var(--kg-bg)));
      --kg-danger-fg: var(--color-danger-fg, var(--true-color-red, #d1242f));
      --kg-danger-bg: var(--color-danger-subtle, color-mix(in srgb, var(--kg-danger-fg) 14%, var(--kg-bg)));
      --kg-danger-border: var(--color-danger-muted, color-mix(in srgb, var(--kg-danger-fg) 36%, var(--kg-bg)));
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--kg-bg);
      color: var(--kg-fg);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
      height: 100vh; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--kg-border);
      flex-shrink: 0;
    }
    .header-logo { font-size: 18px; }
    .header-title {
      font-size: 15px; font-weight: var(--font-weight-semibold, 600);
      flex: 1; letter-spacing: -0.01em;
    }
    .header-actions { display: flex; gap: 6px; align-items: center; }
    .live-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--kg-success-fg);
      transition: background 0.3s;
    }
    .live-dot.stale { background: var(--kg-warning-fg); }
    .live-dot.dead { background: var(--kg-danger-fg); }
    .btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 10px; border-radius: 6px;
      font-size: 12px; font-family: inherit; cursor: pointer;
      border: 1px solid var(--kg-border);
      background: var(--kg-bg);
      color: var(--kg-fg);
      text-decoration: none;
      transition: background 0.1s;
      white-space: nowrap;
    }
    .btn:hover { background: var(--kg-hover); }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-sm { padding: 2px 7px; font-size: 11px; }
    .toolbar {
      padding: 7px 14px;
      border-bottom: 1px solid var(--kg-border);
      flex-shrink: 0; display: flex; align-items: center; gap: 8px;
    }
    .search {
      flex: 1; max-width: 280px;
      padding: 4px 10px; border-radius: 6px;
      border: 1px solid var(--kg-border);
      background: var(--kg-bg);
      color: var(--kg-fg);
      font-family: inherit; font-size: 12px;
    }
    .search:focus {
      outline: none;
      border-color: var(--kg-accent);
      box-shadow: 0 0 0 3px var(--color-focus-outline, rgba(9,105,218,0.25));
    }
    .status-text { font-size: 11px; color: var(--kg-muted); margin-left: auto; }
    .status-text.error { color: var(--kg-danger-fg); }
    .content { flex: 1; overflow: auto; }
    .empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: flex-start;
      min-height: 100%;
      gap: 10px;
      color: var(--kg-muted);
      padding: 28px 16px 24px;
    }
    .apphost-picker {
      width: min(680px, calc(100vw - 72px));
      border: 1px solid var(--kg-border);
      border-radius: 8px;
      background: var(--background-color-subtle, var(--kg-panel));
      padding: 8px 10px 7px;
      margin-top: 0;
    }
    .apphost-picker-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .apphost-picker-row .btn {
      padding-inline: 12px;
      min-height: 32px;
    }
    .picker-select {
      flex: 1;
      min-width: 280px;
      max-width: 100%;
      min-height: 32px;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--kg-border);
      background: var(--kg-bg);
      color: var(--kg-fg);
      font-family: inherit;
      font-size: 12px;
    }
    .picker-select:focus {
      outline: none;
      border-color: var(--kg-accent);
      box-shadow: 0 0 0 3px var(--color-focus-outline, rgba(9,105,218,0.25));
    }
    .picker-meta {
      margin-top: 5px;
      padding-inline: 1px;
      color: var(--kg-muted);
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
    }
    .empty-icon { font-size: 28px; }
    .spinner {
      display: inline-block; width: 16px; height: 16px;
      border: 2px solid var(--kg-border);
      border-top-color: var(--kg-accent);
      border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .section { margin-top: 2px; }
    .section-title {
      padding: 6px 12px;
      font-size: 11px;
      font-weight: var(--font-weight-semibold, 600);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--kg-muted);
      border-bottom: 1px solid var(--kg-border);
      background: var(--background-color-subtle, var(--kg-panel));
    }
    table { width: 100%; border-collapse: collapse; }
    thead { position: sticky; top: 0; z-index: 1; }
    th {
      padding: 6px 12px; text-align: left;
      font-size: 11px; font-weight: var(--font-weight-semibold, 600);
      text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--kg-muted);
      background: var(--background-color-subtle, var(--kg-panel));
      border-bottom: 1px solid var(--kg-border);
      white-space: nowrap; user-select: none;
    }
    tr { border-bottom: 1px solid var(--kg-border-muted); cursor: pointer; }
    tr:last-child { border-bottom: none; }
    tr:hover td { background: var(--kg-hover); }
    tr.selected td { background: var(--kg-accent-soft); }
    td { padding: 7px 12px; vertical-align: middle; }
    .tree-cell {
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }
    .tree-indent {
      display: inline-block;
      width: calc(var(--level, 0) * 14px);
      flex: 0 0 calc(var(--level, 0) * 14px);
    }
    .tree-toggle {
      border: none;
      background: transparent;
      color: var(--kg-fg);
      cursor: pointer;
      width: 20px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      margin-right: 2px;
      font-size: 14px;
      font-weight: var(--font-weight-semibold, 600);
      line-height: 1;
      padding: 0;
      opacity: 0.92;
    }
    .tree-toggle:hover { background: var(--kg-hover); color: var(--kg-fg); opacity: 1; }
    .tree-toggle.placeholder { visibility: hidden; pointer-events: none; }
    .res-name { font-weight: var(--font-weight-semibold, 600); font-size: 13px; }
    .res-name a { color: var(--kg-accent); text-decoration: none; }
    .res-name a:hover { text-decoration: underline; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 20px; font-size: 11px; font-weight: 500;
      border: 1px solid transparent;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; }
    .s-running  { background: var(--kg-success-bg); color: var(--kg-success-fg); border-color: var(--kg-success-border); }
    .s-running  .badge-dot { background: var(--kg-success-fg); }
    .s-starting { background: var(--kg-warning-bg); color: var(--kg-warning-fg); border-color: var(--kg-warning-border); }
    .s-starting .badge-dot { background: var(--kg-warning-fg); animation: pulse 1.5s ease-in-out infinite; }
    .s-error    { background: var(--kg-danger-bg); color: var(--kg-danger-fg); border-color: var(--kg-danger-border); }
    .s-error    .badge-dot { background: var(--kg-danger-fg); }
    .s-stopped  { background: var(--background-color-subtle, var(--kg-panel)); color: var(--kg-muted); border-color: var(--kg-border-muted); }
    .s-stopped  .badge-dot { background: var(--kg-muted); }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    .type-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 1px 6px; border-radius: 4px; font-size: 11px;
      background: var(--background-color-subtle, var(--kg-panel));
      color: var(--kg-muted);
      border: 1px solid var(--kg-border-muted);
    }
    .endpoints-cell { max-width: 200px; }
    .ep-link {
      display: inline-block;
      color: var(--kg-accent);
      font-family: var(--font-mono, monospace);
      font-size: 11px; text-decoration: none;
      margin-right: 6px; white-space: nowrap;
    }
    .ep-link:hover { text-decoration: underline; }
    .actions-col { white-space: nowrap; }
    .act-btn {
      padding: 2px 8px; border-radius: 4px; font-size: 11px;
      font-family: inherit; cursor: pointer; border: 1px solid var(--kg-border);
      background: var(--kg-bg);
      color: var(--kg-fg);
      margin-right: 3px; transition: background 0.1s;
    }
    .act-btn:hover { background: var(--kg-hover); }
    .act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .act-btn.danger:hover { background: var(--kg-danger-bg); color: var(--kg-danger-fg); border-color: var(--kg-danger-border); }
    /* Detail panel */
    #detail {
      border-top: 2px solid var(--kg-border);
      background: var(--background-color-subtle, var(--kg-panel));
      flex-shrink: 0; min-height: 120px; height: 220px; max-height: 70vh; overflow: auto;
      display: none;
    }
    #detail.open { display: block; }
    .detail-resize-handle {
      height: 8px;
      cursor: ns-resize;
      border-bottom: 1px solid var(--kg-border-muted);
      background: color-mix(in srgb, var(--kg-bg) 75%, transparent);
    }
    .detail-hdr {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--kg-border);
      background: var(--kg-bg); position: sticky; top: 0;
    }
    .detail-hdr-name { font-weight: var(--font-weight-semibold,600); flex: 1; font-size: 13px; }
    .detail-cmds { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 14px 0; }
    .detail-cmd-btn {
      padding: 2px 8px; border-radius: 999px; font-size: 11px;
      border: 1px solid var(--kg-border); background: var(--kg-bg); color: var(--kg-fg);
      cursor: pointer;
    }
    .detail-cmd-btn:hover { background: var(--kg-hover); }
    .close-btn {
      background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px;
      color: var(--kg-muted); font-size: 15px;
    }
    .close-btn:hover { background: var(--kg-hover); }
    .detail-body { padding: 12px 14px; display: grid; grid-template-columns: 1fr; gap: 12px; }
    .detail-section h3 {
      font-size: 10px; font-weight: var(--font-weight-semibold,600);
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--kg-muted); margin-bottom: 6px;
    }
    .ep-list { max-height: 72px; overflow: auto; padding-right: 4px; }
    .env-list { font-size: 11px; max-height: 170px; overflow: auto; padding-right: 4px; }
    .env-row { display: flex; gap: 6px; padding: 1px 0; flex-wrap: wrap; }
    .env-key { font-family: var(--font-mono,monospace); color: var(--kg-fg); font-weight: 500; white-space: nowrap; }
    .env-val { font-family: var(--font-mono,monospace); color: var(--kg-muted); word-break: break-all; }
    .ep-full { font-size: 11px; margin-bottom: 4px; }
    .ep-full .ep-label { color: var(--kg-muted); font-size: 10px; }
    .muted { color: var(--kg-muted); font-size: 11px; font-style: italic; }
    .param-value {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--kg-muted);
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
      vertical-align: bottom;
    }
    .param-value.unset { font-style: italic; }
    #commandModal {
      position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--kg-bg) 35%, transparent);
      z-index: 30;
    }
    #commandModal.open { display: flex; }
    .cmd-modal-card {
      width: min(760px, calc(100vw - 24px));
      max-height: min(78vh, 720px);
      overflow: auto;
      background: var(--kg-bg);
      border: 1px solid var(--kg-border);
      border-radius: 10px;
      box-shadow: 0 10px 28px color-mix(in srgb, var(--kg-fg) 18%, transparent);
      padding: 12px;
    }
    .cmd-modal-hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .cmd-modal-title { flex: 1; font-weight: var(--font-weight-semibold, 600); }
    .cmd-form-grid { display: grid; gap: 10px; margin: 8px 0; }
    .cmd-field label { display: block; font-size: 11px; color: var(--kg-muted); margin-bottom: 4px; }
    .cmd-field input, .cmd-field select {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--kg-border);
      border-radius: 6px;
      background: var(--kg-bg);
      color: var(--kg-fg);
      font-size: 12px;
      font-family: inherit;
    }
    .cmd-field-hint { font-size: 10px; color: var(--kg-muted); margin-top: 4px; }
    .cmd-modal-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
    .cmd-output {
      margin-top: 10px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--kg-border);
      background: var(--background-color-subtle, var(--kg-panel));
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 220px;
      overflow: auto;
    }
    #apphostModal {
      position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--kg-bg) 35%, transparent);
      z-index: 31;
    }
    #apphostModal.open { display: flex; }
    .apphost-modal-card {
      width: min(480px, calc(100vw - 24px));
      background: var(--kg-bg);
      border: 1px solid var(--kg-border);
      border-radius: 10px;
      box-shadow: 0 10px 28px color-mix(in srgb, var(--kg-fg) 18%, transparent);
      padding: 16px;
    }
    .apphost-modal-hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .apphost-modal-title { flex: 1; font-weight: var(--font-weight-semibold, 600); }
  </style>
</head><body>
  <div class="header">
    <span class="header-logo">__APP_EMOJI__</span>
    <span class="header-title">__APP_TITLE__</span>
    <div class="header-actions">
      <span id="liveDot" class="live-dot stale" title="SSE connection status"></span>
      <a class="btn" id="dashboardBtn" href="#" target="_blank" rel="noopener" style="display:none">⎋ Open dashboard</a>
      <button class="btn" id="refreshBtn" onclick="doRefresh()">↻ Refresh</button>
    </div>
  </div>
  <div class="toolbar">
    <input id="search" class="search" type="text" placeholder="Filter by name, state, endpoint, or kind…" oninput="applyFilter()" />
    <span id="statusText" class="status-text"></span>
  </div>
  <div id="content" class="content">
    <div class="empty"><span class="spinner"></span><span>Connecting…</span></div>
  </div>
  <div id="detail"></div>
  <div id="commandModal"></div>
  <div id="apphostModal"></div>
  <script src="/app.js"></script>
</body></html>`;

function renderHtml(branding) {
    const safeTitle = escapeHtml(branding?.title || "App Resources");
    const safeEmoji = escapeHtml(branding?.emoji || "🌱");
    return HTML_TEMPLATE
        .replaceAll("__APP_TITLE__", safeTitle)
        .replaceAll("__APP_EMOJI__", safeEmoji);
}

// ─── Client-side JavaScript (served as /app.js) ─────────────────────────────

const APP_JS = `
(function() {
  var allResources = [];
  var selected = null;
  var noAppHostVisible = false;
  var showingError = false; // prevents SSE from clobbering an explicit error state
  var startWaitInterval = null;
  var collapsedByName = Object.create(null);
  var activeCommandContext = null;

  function clearStartWaitInterval() {
    if (!startWaitInterval) return;
    clearInterval(startWaitInterval);
    startWaitInterval = null;
  }

  function stateClass(s) {
    s = (s || '').toLowerCase();
    if (s === 'running' || s === 'healthy') return 's-running';
    if (s.includes('start') || s.includes('wait') || s.includes('pending')) return 's-starting';
    if (s.includes('fail') || s.includes('error') || s.includes('unhealthy') || s === 'exited') return 's-error';
    return 's-stopped';
  }

  function attr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }

  function lc(s) { return String(s || '').toLowerCase(); }

  function resourceKey(r) {
    return r.name || r.displayName || '';
  }

  function resourceLabel(r) {
    return r.displayName || r.name || '';
  }

  function resourceType(r) {
    return r.resourceType || r.type || '';
  }

  function commandEntries(r) {
    var commands = r.commands || {};
    return Object.keys(commands).map(function(key) {
      var meta = commands[key] || {};
      return { name: key, meta: meta };
    });
  }

  function customCommandEntries(r) {
    return commandEntries(r).filter(function(c) {
      var n = lc(c.name);
      return n !== 'start' && n !== 'stop' && n !== 'restart';
    });
  }

  function isParameter(r) {
    return /parameter/i.test(resourceType(r));
  }

  function getParentName(r) {
    var rels = r.relationships || [];
    for (var i = 0; i < rels.length; i++) {
      var rel = rels[i] || {};
      if ((rel.type || '').toLowerCase() === 'parent' && rel.resourceName) return rel.resourceName;
    }
    return '';
  }

  function renderEndpoints(r) {
    var eps = r.endpoints || r.urls || [];
    return eps.map(function(e) {
      var url = typeof e === 'string' ? e : (e.url || e.href || '');
      var label = url.replace(/^https?:\\/\\/[^/]+/, '').replace(/^tcp:\\/\\/[^/]+/, '') || url;
      return '<a class="ep-link" href="' + attr(url) + '" target="_blank" title="' + attr(url) + '">' + attr(label || url) + '</a>';
    }).join('');
  }

  function splitGroups(resources) {
    var parameters = [];
    var normal = [];
    resources.forEach(function(r) {
      if (isParameter(r)) parameters.push(r);
      else normal.push(r);
    });
    return { resources: normal, parameters: parameters };
  }

  function buildTree(resources) {
    var nodeByName = Object.create(null);
    var order = [];
    resources.forEach(function(r) {
      var key = resourceKey(r);
      if (!key) return;
      order.push(key);
      nodeByName[key] = { name: key, resource: r, parentName: getParentName(r), children: [] };
    });
    order.forEach(function(name) {
      var node = nodeByName[name];
      if (!node) return;
      if (node.parentName && node.parentName !== name && nodeByName[node.parentName]) {
        nodeByName[node.parentName].children.push(node);
      }
    });
    var roots = [];
    order.forEach(function(name) {
      var node = nodeByName[name];
      if (!node) return;
      if (!node.parentName || node.parentName === name || !nodeByName[node.parentName]) roots.push(node);
    });
    return roots;
  }

  function ensureCollapseDefaults(nodes) {
    nodes.forEach(function(node) {
      if (node.children && node.children.length > 0 && collapsedByName[node.name] === undefined) {
        collapsedByName[node.name] = true; // collapsed by default
      }
      if (node.children && node.children.length) ensureCollapseDefaults(node.children);
    });
  }

  function flattenVisible(nodes, depth, out) {
    nodes.forEach(function(node) {
      var hasChildren = node.children && node.children.length > 0;
      var collapsed = hasChildren ? !!collapsedByName[node.name] : false;
      out.push({ node: node, depth: depth, hasChildren: hasChildren, collapsed: collapsed });
      if (hasChildren && !collapsed) flattenVisible(node.children, depth + 1, out);
    });
  }

  function renderState(state, health) {
    var sc = stateClass(state);
    return '<span class="badge ' + sc + '"><span class="badge-dot"></span>' + attr(state) +
      (health && health !== state ? ' · ' + attr(health) : '') + '</span>';
  }

  function hasCommand(r, cmd) {
    return !!(r.commands && r.commands[cmd]);
  }

  function isRunningLikeState(state) {
    var s = String(state || '').toLowerCase();
    return s === 'running' || s.includes('healthy') || s.includes('unhealthy') || s.includes('degraded');
  }

  function renderActions(r, name, state) {
    var canStart = hasCommand(r, 'start');
    var canStop = hasCommand(r, 'stop');
    var canRestart = hasCommand(r, 'restart');
    var runningLike = isRunningLikeState(state);

    var primary = '';
    if (canStart && canStop) {
      primary = runningLike ? 'stop' : 'start';
    } else if (canStop) {
      primary = 'stop';
    } else if (canStart) {
      primary = 'start';
    }

    var buttons = [];
    if (primary === 'start') buttons.push('<button class="act-btn" data-name="' + attr(name) + '" data-cmd="start">▶ Start</button>');
    if (primary === 'stop') buttons.push('<button class="act-btn danger" data-name="' + attr(name) + '" data-cmd="stop">■ Stop</button>');
    if (canRestart && primary !== 'restart') buttons.push('<button class="act-btn" data-name="' + attr(name) + '" data-cmd="restart">↻ Restart</button>');

    return buttons.length ? buttons.join('') : '<span class="muted">—</span>';
  }

  function renderResourcesSection(resources) {
    if (!resources.length) return '';
    var roots = buildTree(resources);
    ensureCollapseDefaults(roots);
    var rowsData = [];
    flattenVisible(roots, 0, rowsData);
    var rows = rowsData.map(function(rd) {
      var r = rd.node.resource;
      var name = rd.node.name;
      var label = resourceLabel(r);
      var state = r.state || r.status || r.stateText || 'Unknown';
      var health = r.health || r.healthStatus || '';
      var endpoints = renderEndpoints(r);
      var isSelected = name === selected;
      var toggle = rd.hasChildren
        ? '<button class="tree-toggle" data-toggle="' + attr(name) + '">' + (rd.collapsed ? '▸' : '▾') + '</button>'
        : '<button class="tree-toggle placeholder">▸</button>';
      return '<tr class="' + (isSelected ? 'selected' : '') + '" data-name="' + attr(name) + '">' +
        '<td class="res-name"><span class="tree-cell"><span class="tree-indent" style="--level:' + rd.depth + '"></span>' + toggle + '<span>' + attr(label) + '</span></span></td>' +
        '<td>' + renderState(state, health) + '</td>' +
        '<td class="endpoints-cell">' + (endpoints || '<span style="color:var(--kg-muted)">—</span>') + '</td>' +
        '<td class="actions-col">' +
          renderActions(r, name, state) +
        '</td>' +
      '</tr>';
    }).join('');
    return '<div class="section">' +
      '<div class="section-title">Resources (' + resources.length + ')</div>' +
      '<table><thead><tr><th>Name</th><th>State</th><th>Endpoints</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>';
  }

  function parameterValueInfo(r) {
    var value = null;
    if (r.value != null) value = String(r.value);
    else if (r.properties && r.properties.Value != null) value = String(r.properties.Value);
    else if (r.properties && r.properties.value != null) value = String(r.properties.value);

    var state = String(r.state || r.status || r.stateText || '');
    var isRunning = state.toLowerCase() === 'running';
    var hasValue = value !== null;
    var unresolved = !isRunning;

    return { value: value, hasValue: hasValue, unresolved: unresolved };
  }

  function renderParametersSection(parameters) {
    if (!parameters.length) return '';
    var rows = parameters.map(function(r) {
      var name = resourceKey(r);
      var label = resourceLabel(r);
      var state = r.state || r.status || r.stateText || 'Unknown';
      var health = r.health || r.healthStatus || '';
      var info = parameterValueInfo(r);
      var isSelected = name === selected;
      var valueText = info.unresolved ? 'Value not set' : (info.hasValue ? info.value : 'Masked or unavailable');
      return '<tr class="' + (isSelected ? 'selected' : '') + '" data-name="' + attr(name) + '">' +
        '<td class="res-name">' + attr(label) + '</td>' +
        '<td><span class="param-value ' + (info.unresolved ? 'unset' : '') + '">' + attr(valueText) + '</span></td>' +
        '<td>' + renderState(state, health) + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="section">' +
      '<div class="section-title">Parameters (' + parameters.length + ')</div>' +
      '<table><thead><tr><th>Name</th><th>Value</th><th>State</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>';
  }

  function renderTables(resources, parameters) {
    if (!resources.length && !parameters.length) {
      return '<div class="empty"><span class="empty-icon">🔎</span><span>No matching resources.</span></div>';
    }
    return renderResourcesSection(resources) + renderParametersSection(parameters);
  }

  function inputTypeToControl(input) {
    var t = lc(input.inputType);
    if (t === 'boolean') return 'checkbox';
    if (t === 'choice') return 'choice';
    if (t === 'secrettext') return 'password';
    if (t === 'number') return 'number';
    return 'text';
  }

  function renderCommandModal(resource, commandName) {
    var modal = document.getElementById('commandModal');
    if (!modal) return;
    var commands = resource.commands || {};
    var command = commands[commandName];
    if (!command) return;
    activeCommandContext = { resourceName: resourceKey(resource), commandName: commandName };

    var inputs = command.argumentInputs || [];
    var fieldsHtml = inputs.map(function(input, idx) {
      var fieldId = 'cmdField_' + idx;
      var control = inputTypeToControl(input);
      var label = input.label || input.name || ('Input ' + (idx + 1));
      var required = input.required ? ' required' : '';
      var hint = input.description ? '<div class="cmd-field-hint">' + attr(input.description) + '</div>' : '';
      if (control === 'checkbox') {
        var checked = input.value ? ' checked' : '';
        return '<div class="cmd-field">' +
          '<label><input type="checkbox" id="' + attr(fieldId) + '" data-arg-name="' + attr(input.name || '') + '"' + checked + '> ' + attr(label) + '</label>' +
          hint +
        '</div>';
      }
      if (control === 'choice') {
        var opts = input.options || {};
        var options = Object.keys(opts).map(function(key) {
          var sel = (input.value != null && String(input.value) === key) ? ' selected' : '';
          return '<option value="' + attr(key) + '"' + sel + '>' + attr(opts[key]) + '</option>';
        }).join('');
        if (input.allowCustomChoice) {
          var listId = fieldId + '_list';
          return '<div class="cmd-field"><label for="' + attr(fieldId) + '">' + attr(label) + '</label>' +
            '<input id="' + attr(fieldId) + '" data-arg-name="' + attr(input.name || '') + '" list="' + attr(listId) + '" value="' + attr(input.value || '') + '"' + required + '>' +
            '<datalist id="' + attr(listId) + '">' + options.replace(/<option value=/g, '<option value=') + '</datalist>' +
            hint +
          '</div>';
        }
        return '<div class="cmd-field"><label for="' + attr(fieldId) + '">' + attr(label) + '</label>' +
          '<select id="' + attr(fieldId) + '" data-arg-name="' + attr(input.name || '') + '"' + required + '>' + options + '</select>' +
          hint +
        '</div>';
      }
      var value = input.value != null ? String(input.value) : '';
      var placeholder = input.placeholder ? ' placeholder="' + attr(input.placeholder) + '"' : '';
      return '<div class="cmd-field"><label for="' + attr(fieldId) + '">' + attr(label) + '</label>' +
        '<input id="' + attr(fieldId) + '" data-arg-name="' + attr(input.name || '') + '" type="' + control + '" value="' + attr(value) + '"' + placeholder + required + '>' +
        hint +
      '</div>';
    }).join('');

    modal.className = 'open';
    modal.innerHTML =
      '<div class="cmd-modal-card">' +
        '<div class="cmd-modal-hdr">' +
          '<div class="cmd-modal-title">' + attr(command.displayName || commandName) + '</div>' +
          '<button class="btn btn-sm" id="cmdCloseBtn">Close</button>' +
        '</div>' +
        (command.description ? '<div class="muted">' + attr(command.description) + '</div>' : '') +
        '<form id="cmdForm">' +
          '<div class="cmd-form-grid">' + fieldsHtml + '</div>' +
          '<div class="cmd-modal-actions">' +
            '<button class="btn" type="submit" id="cmdRunBtn">Run command</button>' +
            '<span id="cmdStatus" class="status-text"></span>' +
          '</div>' +
        '</form>' +
        '<div id="cmdOutput" class="cmd-output" style="display:none"></div>' +
      '</div>';

    var closeBtn = document.getElementById('cmdCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', function() { window.closeCommandModal(); });
    var form = document.getElementById('cmdForm');
    if (form) form.addEventListener('submit', function(e) { e.preventDefault(); window.runActiveCommand(); });
  }

  window.closeCommandModal = function() {
    var modal = document.getElementById('commandModal');
    if (!modal) return;
    modal.className = '';
    modal.innerHTML = '';
    activeCommandContext = null;
  };

  window.runActiveCommand = function() {
    if (!activeCommandContext) return;
    var modal = document.getElementById('commandModal');
    if (!modal) return;
    var inputs = modal.querySelectorAll('[data-arg-name]');
    var args = {};
    inputs.forEach(function(el) {
      var name = el.getAttribute('data-arg-name');
      if (!name) return;
      if (el.type === 'checkbox') {
        args[name] = !!el.checked;
      } else {
        args[name] = el.value;
      }
    });
    var statusEl = document.getElementById('cmdStatus');
    var outputEl = document.getElementById('cmdOutput');
    var runBtn = document.getElementById('cmdRunBtn');
    if (statusEl) statusEl.textContent = 'Running…';
    if (runBtn) runBtn.disabled = true;
    fetch('/resource/' + encodeURIComponent(activeCommandContext.resourceName) + '/command/' + encodeURIComponent(activeCommandContext.commandName), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: args }),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (statusEl) statusEl.textContent = data.ok ? 'Completed' : 'Failed';
        if (outputEl) {
          var text = data.ok
            ? (data.stdout || data.message || 'Command completed.')
            : (data.message || data.stderr || data.stdout || 'Command failed.');
          outputEl.style.display = 'block';
          outputEl.textContent = text;
        }
        window.doRefresh();
      })
      .catch(function() {
        if (statusEl) statusEl.textContent = 'Failed';
        if (outputEl) {
          outputEl.style.display = 'block';
          outputEl.textContent = 'Failed to execute command.';
        }
      })
      .finally(function() {
        if (runBtn) runBtn.disabled = false;
      });
  };

  // Event delegation — no inline onclick needed
  document.getElementById('content').addEventListener('click', function(evt) {
    var toggle = evt.target.closest('[data-toggle]');
    if (toggle) {
      evt.stopPropagation();
      var nameToToggle = toggle.dataset.toggle;
      if (!nameToToggle) return;
      collapsedByName[nameToToggle] = !collapsedByName[nameToToggle];
      applyFilter();
      return;
    }
    var btn = evt.target.closest('.act-btn');
    if (btn) {
      evt.stopPropagation();
      var n = btn.dataset.name, c = btn.dataset.cmd;
      if (n && c) window.doCmd(n, c);
      return;
    }
    var tr = evt.target.closest('tr[data-name]');
    if (tr) window._selectResource(tr.dataset.name);
  });

  document.getElementById('commandModal').addEventListener('click', function(evt) {
    if (evt.target && evt.target.id === 'commandModal') window.closeCommandModal();
  });
  document.getElementById('apphostModal').addEventListener('click', function(evt) {
    if (evt.target && evt.target.id === 'apphostModal') window.closeApphostModal();
  });
  document.addEventListener('keydown', function(evt) {
    if (evt.key === 'Escape') { window.closeCommandModal(); window.closeApphostModal(); }
  });

  function applyFilter() {
    var q = document.getElementById('search').value.toLowerCase();
    var grouped = splitGroups(allResources);
    var filterFn = function(r) {
      var endpoints = (r.endpoints || r.urls || []).map(function(e) {
        return typeof e === 'string' ? e : (e.url || e.href || '');
      }).join(' ');
      return resourceKey(r).toLowerCase().includes(q) ||
             resourceLabel(r).toLowerCase().includes(q) ||
             resourceType(r).toLowerCase().includes(q) ||
             (r.state || r.status || '').toLowerCase().includes(q) ||
             endpoints.toLowerCase().includes(q);
    };
    var filteredResources = q ? grouped.resources.filter(filterFn) : grouped.resources;
    var filteredParameters = q ? grouped.parameters.filter(filterFn) : grouped.parameters;
    document.getElementById('content').innerHTML = renderTables(filteredResources, filteredParameters);
  }
  window.applyFilter = applyFilter;

  function setStatus(msg, isError) {
    var el = document.getElementById('statusText');
    el.textContent = msg;
    el.className = 'status-text' + (isError ? ' error' : '');
  }

  function updateDashboardBtn(url) {
    var btn = document.getElementById('dashboardBtn');
    if (!btn) return;
    if (url) {
      btn.href = url;
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
    }
  }

  window.showApphostSwitcher = function() {
    var modal = document.getElementById('apphostModal');
    if (!modal) return;
    modal.innerHTML =
      '<div class="apphost-modal-card">' +
        '<div class="apphost-modal-hdr">' +
          '<span class="apphost-modal-title">Switch AppHost</span>' +
          '<button class="btn" onclick="window.closeApphostModal()">✕</button>' +
        '</div>' +
        '<div id="apphostModalPicker"><span class="muted" style="font-size:12px">Checking for running AppHosts…</span></div>' +
        '<div id="apphostModalStart"></div>' +
      '</div>';
    modal.className = 'open';
    fetch('/api/apphosts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var pickerEl = document.getElementById('apphostModalPicker');
        var startEl = document.getElementById('apphostModalStart');
        if (!data || !data.ok || !pickerEl) return;
        pickerEl.innerHTML = renderAppHostPicker(data.apphosts || [], data.selectedApphost || '');
        updateDashboardBtn(data.selectedDashboardUrl || '');
        if (startEl) {
          startEl.innerHTML = renderStartAction(!!data.canStartWorkspace);
          var startBtn = document.getElementById('startBtn');
          if (startBtn) startBtn.addEventListener('click', function() { window.closeApphostModal(); window.doStart(); });
        }
        var useBtn = document.getElementById('useAppHostBtn');
        var select = document.getElementById('apphostSelect');
        if (select) {
          select.addEventListener('change', updateApphostPathPreview);
          updateApphostPathPreview();
        }
        if (useBtn) {
          useBtn.addEventListener('click', function() {
            var apphost = select && select.value ? select.value : '';
            if (!apphost) return;
            useBtn.disabled = true;
            fetch('/api/select-apphost', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apphost: apphost }),
            })
              .then(function(r) { return r.json(); })
              .then(function(d) {
                if (d.ok) {
                  updateDashboardBtn(d.dashboardUrl || '');
                  window.closeApphostModal();
                  setStatus('Using selected AppHost');
                  window.doRefresh();
                } else {
                  setStatus(d.message || 'Failed to select AppHost', true);
                  useBtn.disabled = false;
                }
              })
              .catch(function() {
                setStatus('Failed to select AppHost', true);
                useBtn.disabled = false;
              });
          });
        }
      })
      .catch(function() {
        var pickerEl = document.getElementById('apphostModalPicker');
        if (pickerEl) pickerEl.innerHTML = '<span class="muted" style="font-size:12px">Unable to list running AppHosts.</span>';
      });
  };

  window.closeApphostModal = function() {
    var modal = document.getElementById('apphostModal');
    if (modal) modal.className = '';
  };

  function setResources(resources) {
    allResources = resources;
    noAppHostVisible = false;
    clearStartWaitInterval();
    applyFilter();
    var grouped = splitGroups(resources);
    setStatus(grouped.resources.length + ' resources · ' + grouped.parameters.length + ' parameters · ' + new Date().toLocaleTimeString());
    if (selected) showDetail(selected);
  }

  window._selectResource = function(name) {
    selected = selected === name ? null : name;
    applyFilter();
    if (selected) showDetail(selected); else closeDetail();
  };

  function showDetail(name) {
    var r = allResources.find(function(x) { return resourceKey(x) === name; });
    if (!r) return;
    var eps = r.endpoints || r.urls || [];
    var envRaw = r.environment || r.environmentVariables || r.env || [];
    var env = [];
    if (Array.isArray(envRaw)) {
      env = envRaw.map(function(e) {
        return { name: e.name || e.key || '', value: e.value };
      });
    } else if (envRaw && typeof envRaw === 'object') {
      env = Object.keys(envRaw).map(function(k) {
        return { name: k, value: envRaw[k] };
      });
    }

    var epsHtml = eps.length ? '<div class="ep-list">' + eps.map(function(e) {
      var url = typeof e === 'string' ? e : (e.url || e.href || '');
      var n   = typeof e === 'string' ? '' : (e.name || e.endpointName || '');
      return '<div class="ep-full">' +
        (n ? '<span class="ep-label">' + attr(n) + ': </span>' : '') +
        '<a href="' + attr(url) + '" target="_blank" style="font-family:var(--font-mono);font-size:11px;color:var(--kg-accent)">' + attr(url) + '</a>' +
        '</div>';
    }).join('') + '</div>' : '<p class="muted">No endpoints</p>';

    var envHtml = env.length
      ? '<div class="env-list">' +
          env.slice(0, 14).map(function(e) {
            var k = e.name || e.key || '';
            var v = e.value != null ? String(e.value) : '';
            return '<div class="env-row"><span class="env-key">' + attr(k) + '</span><span class="env-val">= ' + attr(v) + '</span></div>';
          }).join('') +
          (env.length > 14 ? '<p class="muted">…and ' + (env.length - 14) + ' more</p>' : '') +
        '</div>'
      : '<p class="muted">No environment variables</p>';

    var cmds = customCommandEntries(r);
    var cmdsHtml = cmds.length
      ? '<div class="detail-cmds">' + cmds.map(function(c) {
          return '<button class="detail-cmd-btn" data-open-cmd="' + attr(c.name) + '">' + attr(c.meta.displayName || c.name) + '</button>';
        }).join('') + '</div>'
      : '';

    var el = document.getElementById('detail');
    el.className = 'open';
    el.innerHTML =
      '<div class="detail-resize-handle" id="detailResizeHandle" title="Drag to resize"></div>' +
      '<div class="detail-hdr">' +
        '<span class="detail-hdr-name">' + attr(resourceLabel(r)) + '</span>' +
        '<button class="close-btn" id="detailClose">✕</button>' +
      '</div>' +
      cmdsHtml +
      '<div class="detail-body">' +
        '<div class="detail-section endpoints-section"><h3>Endpoints (' + eps.length + ')</h3>' + epsHtml + '</div>' +
        '<div class="detail-section env-section"><h3>Environment (' + env.length + ')</h3>' + envHtml + '</div>' +
      '</div>';
    document.getElementById('detailClose').addEventListener('click', window._closeDetail);
    var resizeHandle = document.getElementById('detailResizeHandle');
    if (resizeHandle) resizeHandle.addEventListener('mousedown', window._startDetailResize);
    var cmdButtons = el.querySelectorAll('[data-open-cmd]');
    cmdButtons.forEach(function(btn) {
      btn.addEventListener('click', function(evt) {
        evt.stopPropagation();
        var cmdName = btn.getAttribute('data-open-cmd');
        if (cmdName) renderCommandModal(r, cmdName);
      });
    });
  }

  window._startDetailResize = function(evt) {
    evt.preventDefault();
    var detail = document.getElementById('detail');
    if (!detail) return;
    var startY = evt.clientY;
    var startHeight = detail.getBoundingClientRect().height;
    var minHeight = 120;
    var maxHeight = Math.floor(window.innerHeight * 0.75);

    function onMove(moveEvt) {
      var next = startHeight + (startY - moveEvt.clientY);
      if (next < minHeight) next = minHeight;
      if (next > maxHeight) next = maxHeight;
      detail.style.height = next + 'px';
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  window._closeDetail = function() {
    selected = null;
    document.getElementById('detail').className = '';
    applyFilter();
  };
  function closeDetail() { window._closeDetail(); }

  // ─── Actions ───────────────────────────────────────────────────────────────

  function renderAppHostPicker(apphosts, selectedApphost) {
    if (!Array.isArray(apphosts) || !apphosts.length) {
      return '<div class="muted" style="margin-top:8px">No running AppHost instances were found.</div>';
    }
    var options = apphosts.map(function(host) {
      var path = host.apphostPath || '';
      var label = host.label || path;
      var scope = host.fromWorkspace ? ' (workspace)' : ' (other workspace)';
      var isSelected = selectedApphost && selectedApphost === path ? ' selected' : '';
      return '<option value="' + attr(path) + '"' + isSelected + '>' + attr(label + scope) + '</option>';
    }).join('');
    return '<div class="apphost-picker">' +
      '<div class="apphost-picker-row">' +
        '<select id="apphostSelect" class="picker-select">' + options + '</select>' +
        '<button class="btn" id="useAppHostBtn">Use selected</button>' +
      '</div>' +
      '<div id="apphostPathPreview" class="picker-meta"></div>' +
    '</div>';
  }

  function renderStartAction(canStartWorkspace) {
    if (canStartWorkspace) {
      return '<button class="btn" id="startBtn" style="margin-top:4px">▶ aspire start</button>';
    }
    return '<span class="muted" style="font-size:12px;margin-top:6px">No workspace AppHost found to start.</span>';
  }

  function updateApphostPathPreview() {
    var select = document.getElementById('apphostSelect');
    var preview = document.getElementById('apphostPathPreview');
    if (!select || !preview) return;
    preview.textContent = select.value || '';
  }

  function wireAppHostPicker() {
    var useBtn = document.getElementById('useAppHostBtn');
    var select = document.getElementById('apphostSelect');
    if (select) {
      select.addEventListener('change', updateApphostPathPreview);
      updateApphostPathPreview();
    }
    if (!useBtn) return;
    useBtn.addEventListener('click', function() {
      var apphost = select && select.value ? select.value : '';
      if (!apphost) return;
      useBtn.disabled = true;
      fetch('/api/select-apphost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apphost: apphost }),
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            setStatus('Using selected AppHost');
            updateDashboardBtn(data.dashboardUrl || '');
            window.doRefresh();
          } else {
            setStatus(data.message || 'Failed to select AppHost', true);
          }
        })
        .catch(function() {
          setStatus('Failed to select AppHost', true);
        })
        .finally(function() {
          useBtn.disabled = false;
        });
    });
  }

  function loadAppHostCandidates() {
    var picker = document.getElementById('apphostPicker');
    var startAction = document.getElementById('startAction');
    if (!picker) return;
    picker.innerHTML = '<span class="muted" style="font-size:12px">Checking for running AppHosts…</span>';
    fetch('/api/apphosts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.ok) {
          picker.innerHTML = '<span class="muted" style="font-size:12px">Unable to list running AppHosts.</span>';
          if (startAction) startAction.innerHTML = renderStartAction(false);
          return;
        }
        picker.innerHTML = renderAppHostPicker(data.apphosts || [], data.selectedApphost || '');
        updateDashboardBtn(data.selectedDashboardUrl || '');
        if (startAction) {
          startAction.innerHTML = renderStartAction(!!data.canStartWorkspace);
          var startBtn = document.getElementById('startBtn');
          if (startBtn) startBtn.addEventListener('click', window.doStart);
        }
        wireAppHostPicker();
      })
      .catch(function() {
        picker.innerHTML = '<span class="muted" style="font-size:12px">Unable to list running AppHosts.</span>';
        if (startAction) startAction.innerHTML = renderStartAction(false);
      });
  }

  function showNoAppHost() {
    clearStartWaitInterval();
    if (noAppHostVisible) return;
    noAppHostVisible = true;
    document.getElementById('content').innerHTML =
      '<div class="empty">' +
        '<span class="empty-icon">💤</span>' +
        '<span style="font-weight:600">No workspace AppHost running</span>' +
        '<span style="font-size:12px;color:var(--text-color-muted)">Start this workspace, or pick another running AppHost.</span>' +
        '<div id="apphostPicker" style="width:100%;display:flex;justify-content:center"></div>' +
        '<div id="startAction"></div>' +
      '</div>';
    loadAppHostCandidates();
  }

  function showStartError(message) {
    showingError = true;
    document.getElementById('content').innerHTML =
      '<div class="empty" style="padding:20px;text-align:left;align-items:flex-start;height:auto">' +
        '<span class="empty-icon">🔴</span>' +
        '<span style="font-weight:600">AppHost failed to start</span>' +
        '<pre style="font-family:var(--font-mono);font-size:11px;color:var(--kg-danger-fg);' +
          'background:var(--kg-danger-bg);border:1px solid var(--kg-danger-border);' +
          'border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-word;max-width:100%;margin:0">' +
          attr(message) +
        '</pre>' +
        '<button class="btn" id="startBtn" style="margin-top:4px">↺ Try again</button>' +
      '</div>';
    var startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.addEventListener('click', window.doStart);
  }

  window.doStart = function() {
    clearStartWaitInterval();
    var btn = document.getElementById('startBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    noAppHostVisible = false;
    showingError = false;
    document.getElementById('content').innerHTML =
      '<div class="empty"><span class="spinner"></span><span>Starting AppHost…</span></div>';
    setStatus('Starting AppHost…');
    fetch('/start', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          setStatus('AppHost started — waiting for resources…');
          document.getElementById('content').innerHTML =
            '<div class="empty"><span class="spinner"></span><span>Waiting for resources…</span></div>';
          var attempts = 0;
          startWaitInterval = setInterval(function() {
            attempts++;
            window.doRefresh();
            if (attempts >= 20) {
              clearStartWaitInterval();
              if (!Array.isArray(allResources) || allResources.length === 0) showNoAppHost();
            }
          }, 2000);
        } else {
          clearStartWaitInterval();
          if (data.code === 'no_workspace_apphost') {
            showNoAppHost();
            setStatus(data.message || 'No workspace AppHost found to start', true);
          } else {
            showStartError(data.message || 'Unknown error');
            setStatus('Start failed', true);
          }
        }
      }).catch(function() {
        clearStartWaitInterval();
        showStartError('Could not reach the canvas server.');
        setStatus('Start failed', true);
      });
  };

  window.doRefresh = function() {
    var btn = document.getElementById('refreshBtn');
    if (btn) btn.disabled = true;
    fetch('/api/resources')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) { setResources(data.resources); }
        else if (data.code === 'no_apphost') {
          if (!startWaitInterval) showNoAppHost();
          setStatus(startWaitInterval ? 'Waiting for resources…' : 'No workspace AppHost running');
        }
        else {
          document.getElementById('content').innerHTML =
            '<div class="empty"><span class="empty-icon">🔴</span><span>' + attr(data.message || 'Error') + '</span></div>';
          setStatus('Error', true);
        }
      })
      .catch(function() { setStatus('Fetch error', true); })
      .finally(function() { if (btn) btn.disabled = false; });
  };

  window.doCmd = function(name, cmd) {
    setStatus(cmd + ' ' + name + '…');
    fetch('/resource/' + encodeURIComponent(name) + '/' + cmd, { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) { setStatus(name + ' ' + cmd + ' OK'); setTimeout(window.doRefresh, 2000); }
        else { setStatus('Error: ' + (data.message || 'unknown'), true); }
      }).catch(function() { setStatus('Action failed', true); });
  };

  // ─── SSE live updates ──────────────────────────────────────────────────────

  var retryDelay = 2000;

  function connectSSE() {
    var dot = document.getElementById('liveDot');
    var es = new EventSource('/events');
    es.onopen = function() { dot.className = 'live-dot'; retryDelay = 2000; };
    es.onmessage = function(evt) {
      if (showingError) return; // don't overwrite a user-visible start error
      try {
        var d = JSON.parse(evt.data);
        if (d.type === 'resources') { setResources(d.resources); }
        if (d.type === 'error') {
          if (d.code === 'no_apphost') { showNoAppHost(); setStatus('No workspace AppHost running'); }
          else {
            document.getElementById('content').innerHTML =
              '<div class="empty"><span class="empty-icon">🔴</span><span>' + attr(d.message || 'Error') + '</span></div>';
            setStatus('Error', true);
          }
        }
      } catch(ex) {}
    };
    es.onerror = function() {
      dot.className = 'live-dot stale';
      es.close();
      retryDelay = Math.min(retryDelay * 1.5, 15000);
      setTimeout(connectSSE, retryDelay);
    };
  }

  // Script loads at end of body — DOM is ready
  connectSSE();
  window.doRefresh();
})();
`;

const TRACES_HTML_TEMPLATE = `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>__APP_TITLE__ Traces</title>
  <style>
    :root {
      --kg-bg: var(--background-color-default, #fff);
      --kg-fg: var(--text-color-default, #1f2328);
      --kg-muted: var(--text-color-muted, #656d76);
      --kg-border: var(--border-color-default, #d0d7de);
      --kg-border-muted: color-mix(in srgb, var(--kg-border) 65%, transparent);
      --kg-panel: color-mix(in srgb, var(--kg-fg) 6%, var(--kg-bg));
      --kg-hover: var(--background-color-hover, color-mix(in srgb, var(--kg-fg) 9%, var(--kg-bg)));
      --kg-accent: var(--color-accent-emphasis, var(--kg-fg));
      --kg-danger-fg: var(--color-danger-fg, var(--true-color-red, #d1242f));
      --kg-focus: var(--color-focus-outline, #0969da);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--kg-bg); color: var(--kg-fg); font: var(--text-body-medium, 14px)/var(--leading-body-medium, 20px) var(--font-sans, sans-serif); }
    .header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-bottom: 1px solid var(--kg-border);
      position: sticky; top: 0; background: var(--kg-bg); z-index: 10;
    }
    .header-title { font-weight: var(--font-weight-semibold, 600); }
    .grow { flex: 1; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .btn, .select {
      border: 1px solid var(--kg-border); border-radius: 6px;
      padding: 6px 10px; background: var(--kg-bg); color: var(--kg-fg);
      font: inherit;
    }
    .btn { text-decoration: none; cursor: pointer; }
    .btn:hover { background: var(--kg-hover); }
    .btn:focus-visible, .select:focus-visible {
      outline: 2px solid var(--kg-focus); outline-offset: 1px;
    }
    .btn[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
    .toolbar {
      display: grid; gap: 10px; padding: 10px 12px;
      border-bottom: 1px solid var(--kg-border); background: var(--background-color-subtle, var(--kg-panel));
    }
    .muted { color: var(--kg-muted); font-size: 12px; }
    #statusText.err { color: var(--kg-danger-fg); }
    #contentWrap { height: calc(100vh - 186px); min-height: 360px; overflow: auto; }
    #empty {
      display: grid; place-items: center; min-height: 200px;
      color: var(--kg-muted); text-align: center; padding: 20px;
    }
    .table-wrap { padding: 8px 12px 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--kg-border-muted); vertical-align: top; }
    th { color: var(--kg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; background: var(--kg-bg); }
    tr:hover td { background: var(--kg-hover); }
    .trace-title { font-weight: var(--font-weight-semibold, 600); }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--kg-border); border-radius: 999px;
      padding: 2px 8px; font-size: 11px;
    }
    .badge.ok { color: var(--kg-muted); }
    .badge.err {
      color: var(--kg-danger-fg);
      border-color: color-mix(in srgb, var(--kg-danger-fg) 40%, var(--kg-border));
      background: color-mix(in srgb, var(--kg-danger-fg) 12%, transparent);
    }
    .log-snapshot { margin: 0 12px 12px; border: 1px solid var(--kg-border); border-radius: 8px; }
    .log-snapshot summary { cursor: pointer; padding: 8px 10px; color: var(--kg-muted); font-size: 12px; }
    .log-snapshot pre {
      margin: 0; border-top: 1px solid var(--kg-border-muted); padding: 10px;
      font-size: 11px; max-height: 220px; overflow: auto; white-space: pre-wrap;
      font-family: var(--font-mono, monospace);
      background: var(--background-color-subtle, var(--kg-panel));
    }
  </style>
</head><body>
  <div class="header">
    <span>__APP_EMOJI__</span>
    <span class="header-title">__APP_TITLE__ Traces</span>
    <span class="grow"></span>
    <button class="btn" id="refreshBtn">↻ Refresh</button>
  </div>
  <div class="toolbar">
    <div class="row">
      <label for="apphostSelect" class="muted">AppHost:</label>
      <select class="select" id="apphostSelect"></select>
      <button class="btn" id="useApphostBtn">Use selected</button>
      <span class="muted" id="statusText">Loading…</span>
    </div>
    <div class="row">
      <label class="muted" for="resourceFilter">Resource:</label>
      <input class="select" id="resourceFilter" placeholder="all resources" />
      <label class="muted" for="searchFilter">Search:</label>
      <input class="select" id="searchFilter" placeholder="http.method:GET, error, trace id..." />
      <label class="muted" for="limitSelect">Limit:</label>
      <select class="select" id="limitSelect">
        <option value="20">20</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
      </select>
      <label class="muted"><input type="checkbox" id="errOnly" /> Errors only</label>
      <button class="btn" id="fetchLogsBtn">Get logs snapshot</button>
      <a class="btn" id="openTracesBtn" target="_blank" rel="noopener noreferrer" aria-disabled="true">Open traces in dashboard</a>
      <a class="btn" id="openLogsBtn" target="_blank" rel="noopener noreferrer" aria-disabled="true">Open logs in dashboard</a>
    </div>
  </div>
  <div id="contentWrap">
    <div id="empty">No traces yet. Click refresh after your app receives traffic.</div>
    <div class="table-wrap" id="tableWrap" style="display:none">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Trace ID</th>
            <th>Duration</th>
            <th>Time</th>
            <th>Status</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody id="tracesBody"></tbody>
      </table>
    </div>
    <details class="log-snapshot" id="logSnapshotWrap" style="display:none">
      <summary>Latest logs snapshot</summary>
      <pre id="logSnapshot"></pre>
    </details>
  </div>
  <script src="/traces.js"></script>
</body></html>`;

function renderTracesHtml(branding) {
    const safeTitle = escapeHtml(branding?.appName || "App");
    const safeEmoji = escapeHtml(branding?.emoji || "🌱");
    return TRACES_HTML_TEMPLATE
        .replaceAll("__APP_TITLE__", safeTitle)
        .replaceAll("__APP_EMOJI__", safeEmoji);
}

const TRACES_APP_JS = `
(function() {
  var current = null;
  var currentLogs = [];

  function setStatus(msg, isError) {
    var el = document.getElementById('statusText');
    if (!el) return;
    el.textContent = msg || '';
    el.className = isError ? 'err' : '';
  }

  function renderApphosts(items, selected) {
    var select = document.getElementById('apphostSelect');
    if (!select) return;
    var hosts = Array.isArray(items) ? items : [];
    if (!hosts.length) {
      select.innerHTML = '<option value="">No running AppHosts</option>';
      return;
    }
    select.innerHTML = hosts.map(function(host) {
      var path = host.apphostPath || '';
      var label = host.label || path || 'AppHost';
      var scope = host.fromWorkspace ? ' (workspace)' : ' (other)';
      var isSelected = selected && selected === path ? ' selected' : '';
      return '<option value="' + attr(path) + '"' + isSelected + '>' + attr(label + scope) + '</option>';
    }).join('');
  }

  function attr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function text(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setButtonLink(id, href) {
    var el = document.getElementById(id);
    if (!el) return;
    if (href) {
      el.href = href;
      el.setAttribute('aria-disabled', 'false');
    } else {
      el.removeAttribute('href');
      el.setAttribute('aria-disabled', 'true');
    }
  }

  function setEmpty(message) {
    var tableWrap = document.getElementById('tableWrap');
    var body = document.getElementById('tracesBody');
    var empty = document.getElementById('empty');
    if (body) body.innerHTML = '';
    if (tableWrap) tableWrap.style.display = 'none';
    if (empty) { empty.textContent = message || 'No traces found.'; empty.style.display = 'grid'; }
  }

  function fmtDuration(ms) {
    var n = Number(ms || 0);
    if (!isFinite(n)) return '—';
    if (n >= 1000) return (n / 1000).toFixed(2) + 's';
    return n.toFixed(0) + 'ms';
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (!isFinite(d.getTime())) return String(ts);
    return d.toLocaleTimeString();
  }

  function firstSource(trace) {
    var spans = Array.isArray(trace && trace.spans) ? trace.spans : [];
    var s = spans.find(function(x) { return x && x.source; });
    return (s && s.source) ? String(s.source) : '';
  }

  function renderTraces(traces) {
    var rows = Array.isArray(traces) ? traces : [];
    var body = document.getElementById('tracesBody');
    var tableWrap = document.getElementById('tableWrap');
    var empty = document.getElementById('empty');
    if (!body || !tableWrap || !empty) return;
    if (!rows.length) {
      setEmpty('No traces found for the current filters.');
      return;
    }
    body.innerHTML = rows.map(function(t) {
      var traceId = t && t.traceId ? String(t.traceId) : '';
      var title = t && t.title ? String(t.title) : '(untitled trace)';
      var status = t && t.hasError ? '<span class="badge err">Error</span>' : '<span class="badge ok">OK</span>';
      var source = firstSource(t);
      var detailUrl = t && t.dashboardUrl ? String(t.dashboardUrl) : '';
      var detailLink = detailUrl
        ? '<a class="btn" href="' + attr(detailUrl) + '" target="_blank" rel="noopener noreferrer">Open</a>'
        : '<span class="muted">—</span>';
      return '<tr>' +
        '<td><div class="trace-title">' + text(title) + '</div><div class="muted mono">' + text(source) + '</div></td>' +
        '<td class="mono">' + text(traceId) + '</td>' +
        '<td>' + text(fmtDuration(t && t.durationMs)) + '</td>' +
        '<td>' + text(fmtTime(t && t.timestamp)) + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + detailLink + '</td>' +
      '</tr>';
    }).join('');
    empty.style.display = 'none';
    tableWrap.style.display = 'block';
  }

  function renderLinks(data) {
    current = data || null;
    setButtonLink('openTracesBtn', data && data.tracesUrl ? data.tracesUrl : '');
    setButtonLink('openLogsBtn', data && data.logsUrl ? data.logsUrl : '');
  }

  function tracesQuery() {
    var params = new URLSearchParams();
    var resource = document.getElementById('resourceFilter');
    var search = document.getElementById('searchFilter');
    var limit = document.getElementById('limitSelect');
    var errOnly = document.getElementById('errOnly');
    if (resource && resource.value.trim()) params.set('resource', resource.value.trim());
    if (search && search.value.trim()) params.set('search', search.value.trim());
    if (limit && limit.value) params.set('limit', limit.value);
    if (errOnly && errOnly.checked) params.set('hasError', 'true');
    return params.toString();
  }

  function refresh() {
    setStatus('Refreshing traces…');
    var qs = tracesQuery();
    fetch('/api/traces' + (qs ? ('?' + qs) : ''))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.ok) {
          renderLinks(data);
          renderTraces(data.traces || []);
          setStatus('Loaded ' + ((data.traces && data.traces.length) || 0) + ' traces from ' + (data.apphostPath || 'AppHost'));
        } else if (data && data.code === 'no_apphost') {
          renderLinks(null);
          setEmpty('No running AppHost found.');
          setStatus('No running AppHost found', true);
        } else {
          renderLinks(null);
          setEmpty((data && data.message) || 'Failed to refresh traces.');
          setStatus((data && data.message) || 'Failed to refresh traces', true);
        }
      })
      .catch(function() {
        renderLinks(null);
        setEmpty('Failed to refresh traces.');
        setStatus('Failed to refresh traces', true);
      });
  }

  function fetchLogsSnapshot() {
    setStatus('Fetching logs snapshot…');
    var params = new URLSearchParams();
    var resource = document.getElementById('resourceFilter');
    var search = document.getElementById('searchFilter');
    if (resource && resource.value.trim()) params.set('resource', resource.value.trim());
    if (search && search.value.trim()) params.set('search', search.value.trim());
    params.set('limit', '50');
    fetch('/api/logs?' + params.toString())
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var wrap = document.getElementById('logSnapshotWrap');
        var pre = document.getElementById('logSnapshot');
        if (!wrap || !pre) return;
        if (data && data.ok) {
          currentLogs = Array.isArray(data.logs) ? data.logs : [];
          pre.textContent = currentLogs.map(function(log) {
            var sev = log && log.severity ? '[' + log.severity + '] ' : '';
            var res = log && log.resourceName ? log.resourceName + ': ' : '';
            var msg = log && (log.message || (log.attributes && log.attributes['log.message'])) ? (log.message || log.attributes['log.message']) : '(empty)';
            return sev + res + msg;
          }).join('\\n');
          wrap.style.display = 'block';
          wrap.open = true;
          if (!current || !current.logsUrl) setButtonLink('openLogsBtn', data.logsUrl || '');
          setStatus('Fetched ' + currentLogs.length + ' logs');
        } else {
          setStatus((data && data.message) || 'Failed to fetch logs snapshot', true);
        }
      })
      .catch(function() {
        setStatus('Failed to fetch logs snapshot', true);
      });
  }

  function loadApphosts() {
    fetch('/api/apphosts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.ok) {
          renderApphosts([], '');
          return;
        }
        renderApphosts(data.apphosts || [], data.selectedApphost || '');
      })
      .catch(function() {
        renderApphosts([], '');
      });
  }

  function useSelectedApphost() {
    var select = document.getElementById('apphostSelect');
    var apphost = select && select.value ? select.value : '';
    setStatus('Updating AppHost…');
    fetch('/api/select-apphost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apphost: apphost })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.ok) {
          loadApphosts();
          refresh();
        } else {
          setStatus((data && data.message) || 'Failed to set AppHost', true);
        }
      })
      .catch(function() {
        setStatus('Failed to set AppHost', true);
      });
  }

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('useApphostBtn').addEventListener('click', useSelectedApphost);
  document.getElementById('fetchLogsBtn').addEventListener('click', fetchLogsSnapshot);
  document.getElementById('resourceFilter').addEventListener('keydown', function(evt) { if (evt.key === 'Enter') refresh(); });
  document.getElementById('searchFilter').addEventListener('keydown', function(evt) { if (evt.key === 'Enter') refresh(); });
  document.getElementById('limitSelect').addEventListener('change', refresh);
  document.getElementById('errOnly').addEventListener('change', refresh);

  loadApphosts();
  refresh();
})();
`;

// ─── Per-instance HTTP server ─────────────────────────────────────────────────

async function startServer(instanceId, apphost, cwd, branding) {
    const sseClients = new Set();
    let cachedResult = null;
    let selectedApphost = apphost || null;

    async function poll() {
        const result = await fetchResources(selectedApphost, cwd);
        cachedResult = result;
        if (result.ok) {
            broadcast(sseClients, { type: "resources", resources: result.resources });
        } else {
            broadcast(sseClients, { type: "error", code: result.code, message: result.message });
        }
    }

    // Initial poll (non-blocking). Further refreshes are explicit (manual refresh/actions).
    poll().catch(() => {});

    const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const path = url.pathname;

        if (req.method === "GET" && path === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(renderHtml(branding));
        }

        if (req.method === "GET" && path === "/app.js") {
            res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
            return res.end(APP_JS);
        }

        if (req.method === "GET" && path === "/api/resources") {
            const result = await fetchResources(selectedApphost, cwd);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(result));
        }

        if (req.method === "GET" && path === "/api/apphosts") {
            const apphosts = await listAppHostCandidates(cwd);
            const canStartWorkspace = await canStartWorkspaceAppHost(cwd);
            const selectedDashboardUrl = (apphosts.find((h) => h.apphostPath === selectedApphost) || {}).dashboardUrl || "";
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, apphosts, selectedApphost: selectedApphost || "", selectedDashboardUrl, canStartWorkspace }));
        }

        if (req.method === "POST" && path === "/api/select-apphost") {
            const body = await readJsonBody(req);
            const requested = String(body?.apphost || "").trim();
            if (!requested) {
                selectedApphost = null;
                const result = await fetchResources(selectedApphost, cwd);
                cachedResult = result;
                if (result.ok) {
                    broadcast(sseClients, { type: "resources", resources: result.resources });
                } else {
                    broadcast(sseClients, { type: "error", code: result.code, message: result.message });
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true, selectedApphost: "" }));
            }

            const candidates = await listAppHostCandidates(cwd);
            const found = candidates.find((h) => h.apphostPath === requested);
            if (!found) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, message: "Selected AppHost is no longer running." }));
            }
            selectedApphost = found.apphostPath;
            const result = await fetchResources(selectedApphost, cwd);
            cachedResult = result;
            if (result.ok) {
                broadcast(sseClients, { type: "resources", resources: result.resources });
            } else {
                broadcast(sseClients, { type: "error", code: result.code, message: result.message });
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, selectedApphost, dashboardUrl: found.dashboardUrl || "" }));
        }

        if (req.method === "GET" && path === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.write(": connected\n\n");
            sseClients.add(res);
            // Send cached data immediately if available
            if (cachedResult) {
                if (cachedResult.ok) {
                    res.write("data: " + JSON.stringify({ type: "resources", resources: cachedResult.resources }) + "\n\n");
                } else {
                    res.write("data: " + JSON.stringify({ type: "error", code: cachedResult.code, message: cachedResult.message }) + "\n\n");
                }
            }
            req.on("close", () => sseClients.delete(res));
            return; // keep open
        }

        // POST /start — launch the AppHost
        if (req.method === "POST" && path === "/start") {
            const canStartWorkspace = await canStartWorkspaceAppHost(cwd);
            if (!canStartWorkspace) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    ok: false,
                    code: "no_workspace_apphost",
                    message: "No workspace AppHost found to start.",
                }));
            }
            const result = await startAppHost(cwd);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(result));
        }

        // POST /resource/:name/start|stop|restart
        const cmdMatch = path.match(/^\/resource\/([^/]+)\/(start|stop|restart)$/);
        if (req.method === "POST" && cmdMatch) {
            const name = decodeURIComponent(cmdMatch[1]);
            const cmd = cmdMatch[2];
            const result = await runResourceCommand(name, cmd, selectedApphost, cwd);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(result));
        }

        // POST /resource/:name/command/:commandName with optional JSON args
        const namedCmdMatch = path.match(/^\/resource\/([^/]+)\/command\/([^/]+)$/);
        if (req.method === "POST" && namedCmdMatch) {
            const name = decodeURIComponent(namedCmdMatch[1]);
            const commandName = decodeURIComponent(namedCmdMatch[2]);
            const body = await readJsonBody(req);
            const result = await runNamedResourceCommand(name, commandName, body?.args || {}, selectedApphost, cwd);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(result));
        }

        res.writeHead(404);
        res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, sseClients, title: branding?.title || "App Resources" };
}

async function startTracesServer(instanceId, apphost, cwd, branding) {
    let selectedApphost = apphost || null;

    const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const path = url.pathname;

        if (req.method === "GET" && path === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(renderTracesHtml(branding));
        }

        if (req.method === "GET" && path === "/traces.js") {
            res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
            return res.end(TRACES_APP_JS);
        }

        if (req.method === "GET" && path === "/api/traces") {
            const limitRaw = Number.parseInt(url.searchParams.get("limit") || "", 10);
            const hasErrorRaw = url.searchParams.get("hasError");
            const hasError = hasErrorRaw === "true" ? true : hasErrorRaw === "false" ? false : undefined;
            const links = await fetchOtelTraces({
                apphost: selectedApphost,
                cwd,
                resource: url.searchParams.get("resource") || undefined,
                limit: Number.isFinite(limitRaw) ? limitRaw : 50,
                hasError,
                search: url.searchParams.get("search") || undefined,
                traceId: url.searchParams.get("traceId") || undefined,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(links));
        }

        if (req.method === "GET" && path === "/api/logs") {
            const limitRaw = Number.parseInt(url.searchParams.get("limit") || "", 10);
            const logs = await fetchOtelLogs({
                apphost: selectedApphost,
                cwd,
                resource: url.searchParams.get("resource") || undefined,
                limit: Number.isFinite(limitRaw) ? limitRaw : 50,
                severity: url.searchParams.get("severity") || undefined,
                search: url.searchParams.get("search") || undefined,
                traceId: url.searchParams.get("traceId") || undefined,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(logs));
        }

        if (req.method === "GET" && path === "/api/apphosts") {
            const apphosts = await listAppHostCandidates(cwd);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, apphosts, selectedApphost: selectedApphost || "" }));
        }

        if (req.method === "POST" && path === "/api/select-apphost") {
            const body = await readJsonBody(req);
            const requested = String(body?.apphost || "").trim();
            if (!requested) {
                selectedApphost = null;
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true, selectedApphost: "" }));
            }
            const candidates = await listAppHostCandidates(cwd);
            const found = candidates.find((h) => h.apphostPath === requested);
            if (!found) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, message: "Selected AppHost is no longer running." }));
            }
            selectedApphost = found.apphostPath;
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, selectedApphost }));
        }

        res.writeHead(404);
        res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, title: `${branding?.appName || "App"} Traces` };
}

// ─── Canvas definition ────────────────────────────────────────────────────────

// session is set after joinSession resolves; used by getProjectCwd()
let _session = null;
let _cachedCwd = null;
let _sessionResolve;
const _sessionPromise = new Promise((resolve) => { _sessionResolve = resolve; });

async function getProjectCwd() {
    if (_cachedCwd) return _cachedCwd;
    // Wait up to 3s for session to be available (handles open() called before joinSession resolves)
    const sess = await Promise.race([
        _sessionPromise,
        new Promise((r) => setTimeout(r, 3000, null)),
    ]);
    if (!sess) return undefined;
    try {
        const result = await sess.rpc.workspaces.getWorkspace();
        const cwd = result?.workspace?.git_root || result?.workspace?.cwd;
        if (cwd) _cachedCwd = cwd;
        return cwd;
    } catch {
        return undefined;
    }
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "aspire-resources",
            displayName: "Aspire Resources",
            description: "Live dashboard showing all Aspire AppHost resources with their state, health, and endpoints. Supports start/stop/restart per resource. Use when the user wants to inspect or manage running Aspire resources.",
            inputSchema: {
                type: "object",
                properties: {
                    apphost: {
                        type: "string",
                        description: "Optional path to the AppHost project file. Auto-detected when omitted.",
                    },
                    appName: {
                        type: "string",
                        description: "Optional display name override for the header/title (for example: Kayla's Garden).",
                    },
                    emoji: {
                        type: "string",
                        description: "Optional emoji override for the header icon (for example: 🌿).",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh",
                    description: "Refresh resource data from the running AppHost and return the current resource list.",
                    handler: async (ctx) => {
                        const entry = instances.get(ctx.instanceId);
                        const apphost = ctx.input?.apphost;
                        const cwd = await getProjectCwd();
                        const result = await fetchResources(apphost, cwd);
                        // Also broadcast to canvas SSE clients if open
                        if (entry && result.ok) {
                            broadcast(entry.sseClients, { type: "resources", resources: result.resources });
                        }
                        return result;
                    },
                },
                {
                    name: "start_resource",
                    description: "Start a specific Aspire resource by name.",
                    inputSchema: {
                        type: "object",
                        required: ["name"],
                        properties: { name: { type: "string", description: "Resource name" } },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        return runResourceCommand(ctx.input.name, "start", ctx.input?.apphost, await getProjectCwd());
                    },
                },
                {
                    name: "stop_resource",
                    description: "Stop a specific Aspire resource by name.",
                    inputSchema: {
                        type: "object",
                        required: ["name"],
                        properties: { name: { type: "string", description: "Resource name" } },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        return runResourceCommand(ctx.input.name, "stop", ctx.input?.apphost, await getProjectCwd());
                    },
                },
                {
                    name: "restart_resource",
                    description: "Restart a specific Aspire resource by name.",
                    inputSchema: {
                        type: "object",
                        required: ["name"],
                        properties: { name: { type: "string", description: "Resource name" } },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        return runResourceCommand(ctx.input.name, "restart", ctx.input?.apphost, await getProjectCwd());
                    },
                },
            ],
            open: async (ctx) => {
                let entry = instances.get(ctx.instanceId);
                if (!entry) {
                    const apphost = ctx.input?.apphost;
                    const cwd = await getProjectCwd();
                    const branding = await resolveBranding({ cwd, apphost, input: ctx.input });
                    entry = await startServer(ctx.instanceId, apphost, cwd, branding);
                    instances.set(ctx.instanceId, entry);
                }
                return { title: entry.title, url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (entry) {
                    instances.delete(ctx.instanceId);
                    // Close all SSE clients
                    for (const res of entry.sseClients) {
                        try { res.end(); } catch {}
                    }
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
        createCanvas({
            id: "aspire-traces",
            displayName: "Aspire Traces",
            description: "Trace-focused Aspire canvas powered by Aspire CLI otel commands. Shows live trace results in-canvas and offers quick trace/log links.",
            inputSchema: {
                type: "object",
                properties: {
                    apphost: {
                        type: "string",
                        description: "Optional path to the AppHost project file. Auto-detected when omitted.",
                    },
                    appName: {
                        type: "string",
                        description: "Optional app name used in the traces canvas title.",
                    },
                    emoji: {
                        type: "string",
                        description: "Optional emoji used in the traces canvas title.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh",
                    description: "Query latest traces via Aspire CLI otel and return trace records plus dashboard links.",
                    handler: async (ctx) => {
                        const apphost = ctx.input?.apphost;
                        const cwd = await getProjectCwd();
                        return fetchOtelTraces({ apphost, cwd, limit: 50 });
                    },
                },
            ],
            open: async (ctx) => {
                let entry = traceInstances.get(ctx.instanceId);
                if (!entry) {
                    const apphost = ctx.input?.apphost;
                    const cwd = await getProjectCwd();
                    const branding = await resolveBranding({ cwd, apphost, input: ctx.input });
                    entry = await startTracesServer(ctx.instanceId, apphost, cwd, branding);
                    traceInstances.set(ctx.instanceId, entry);
                }
                return { title: entry.title, url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = traceInstances.get(ctx.instanceId);
                if (entry) {
                    traceInstances.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

_session = session;
_sessionResolve(session);
