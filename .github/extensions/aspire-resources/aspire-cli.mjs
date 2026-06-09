import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { basename, dirname, join as pathJoin } from "node:path";

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

export {
    listAppHostCandidates,
    canStartWorkspaceAppHost,
    startAppHost,
    fetchResources,
    fetchOtelTraces,
    fetchOtelLogs,
    runResourceCommand,
    runNamedResourceCommand,
};
