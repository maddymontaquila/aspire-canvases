import { createServer } from "node:http";
import { fetchOtelTraces, fetchOtelLogs, listAppHostCandidates } from "./aspire-cli.mjs";
import { readJsonBody, openExternalUrl, isLoopbackRequest } from "./http-util.mjs";
import { renderTracesHtml, TRACES_APP_JS } from "./traces-ui.mjs";

async function startTracesServer(instanceId, apphost, cwd, branding) {
    let selectedApphost = apphost || null;

    const server = createServer(async (req, res) => {
        if (!isLoopbackRequest(req)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            return res.end("Forbidden");
        }
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

        if (req.method === "POST" && path === "/api/open-url") {
            const body = await readJsonBody(req);
            openExternalUrl(body?.url);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true }));
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
    return {
        server,
        url: `http://127.0.0.1:${port}/`,
        title: `${branding?.appName || "App"} Traces`,
        getSelectedApphost: () => selectedApphost,
    };
}

export { startTracesServer };
