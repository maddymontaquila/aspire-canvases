import { spawn } from "node:child_process";

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

function broadcast(clients, payload) {
    const msg = "data: " + JSON.stringify(payload) + "\n\n";
    for (const res of [...clients]) {
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

function openExternalUrl(rawUrl) {
    const url = String(rawUrl || "").trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
    const opener = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", url] : [url];
    spawn(opener, args, { detached: true, stdio: "ignore" });
    return true;
}

// Defense-in-depth: only accept requests whose Host header targets loopback.
// The iframe's own requests carry Host: 127.0.0.1:<port>, so this never blocks
// legitimate traffic — it just rejects cross-origin / DNS-rebinding attempts.
function isLoopbackRequest(req) {
    const host = String(req.headers?.host || "").trim().toLowerCase();
    if (!host) return false;
    const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export { readJsonBody, broadcast, openExternalUrl, isLoopbackRequest };
