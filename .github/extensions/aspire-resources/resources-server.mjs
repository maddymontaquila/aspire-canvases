import { createServer } from "node:http";
import {
    fetchResources,
    listAppHostCandidates,
    canStartWorkspaceAppHost,
    startAppHost,
    runResourceCommand,
    runNamedResourceCommand,
} from "./aspire-cli.mjs";
import { readJsonBody, broadcast, openExternalUrl, isLoopbackRequest } from "./http-util.mjs";
import { renderHtml, APP_JS } from "./resources-ui.mjs";

async function startServer(instanceId, apphost, cwd, branding) {
    const sseClients = new Set();
    let cachedResult = null;
    let selectedApphost = apphost || null;
    let pollTimer = null;
    let closed = false;
    const POLL_INTERVAL_MS = 2500;

    async function pollOnce() {
        const result = await fetchResources(selectedApphost, cwd);
        cachedResult = result;
        if (result.ok) {
            broadcast(sseClients, { type: "resources", resources: result.resources });
        } else {
            broadcast(sseClients, { type: "error", code: result.code, message: result.message });
        }
        return result.ok;
    }

    function stopPolling() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    // Live polling that backs off to idle when no AppHost is reachable, so we
    // don't hammer the CLI when nothing is running. A successful poll schedules
    // the next tick; a failure stops the loop until an explicit refresh or
    // AppHost selection resumes it.
    function resumePolling() {
        if (closed) return;
        stopPolling();
        const tick = async () => {
            if (closed) return;
            let ok = false;
            try { ok = await pollOnce(); } catch { ok = false; }
            pollTimer = (ok && !closed) ? setTimeout(tick, POLL_INTERVAL_MS) : null;
        };
        tick();
    }

    function ensurePolling() {
        if (!pollTimer && !closed) resumePolling();
    }

    resumePolling();

    const server = createServer(async (req, res) => {
        if (!isLoopbackRequest(req)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            return res.end("Forbidden");
        }
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

        if (req.method === "POST" && path === "/api/open-url") {
            const body = await readJsonBody(req);
            openExternalUrl(body?.url);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true }));
        }

        if (req.method === "GET" && path === "/api/resources") {
            const result = await fetchResources(selectedApphost, cwd);
            cachedResult = result;
            // A successful manual refresh resumes the live loop if it had idled.
            if (result.ok) ensurePolling();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(result));
        }

        if (req.method === "GET" && path === "/api/apphosts") {
            const apphosts = await listAppHostCandidates(cwd);
            const canStartWorkspace = await canStartWorkspaceAppHost(cwd);
            // When nothing is explicitly selected, resources come from the
            // effective workspace AppHost, so surface its dashboard URL too.
            const effectivePath = selectedApphost || (apphosts.find((h) => h.fromWorkspace) || {}).apphostPath || "";
            const selectedDashboardUrl = (apphosts.find((h) => h.apphostPath === effectivePath) || {}).dashboardUrl || "";
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, apphosts, selectedApphost: selectedApphost || "", selectedDashboardUrl, canStartWorkspace }));
        }

        if (req.method === "POST" && path === "/api/select-apphost") {
            const body = await readJsonBody(req);
            const requested = String(body?.apphost || "").trim();
            if (!requested) {
                selectedApphost = null;
                resumePolling();
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
            resumePolling();
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
    return {
        server,
        url: `http://127.0.0.1:${port}/`,
        sseClients,
        title: branding?.title || "App Resources",
        getSelectedApphost: () => selectedApphost,
        dispose: () => { closed = true; stopPolling(); },
    };
}

export { startServer };
