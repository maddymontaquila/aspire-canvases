import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { startServer } from "./resources-server.mjs";
import { startTracesServer } from "./traces-server.mjs";
import { fetchResources, fetchOtelTraces, runResourceCommand } from "./aspire-cli.mjs";
import { broadcast } from "./http-util.mjs";
import { resolveBranding } from "./branding.mjs";

// Per-instance state: server, url, SSE clients, selected apphost
const instances = new Map();
const traceInstances = new Map();

// session is resolved after joinSession; used by getProjectCwd()
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
                        // Respect the AppHost the user selected in the open canvas
                        // so agent-driven refreshes match what's on screen.
                        const apphost = entry?.getSelectedApphost?.() ?? ctx.input?.apphost;
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
                        const apphost = instances.get(ctx.instanceId)?.getSelectedApphost?.();
                        return runResourceCommand(ctx.input.name, "start", apphost, await getProjectCwd());
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
                        const apphost = instances.get(ctx.instanceId)?.getSelectedApphost?.();
                        return runResourceCommand(ctx.input.name, "stop", apphost, await getProjectCwd());
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
                        const apphost = instances.get(ctx.instanceId)?.getSelectedApphost?.();
                        return runResourceCommand(ctx.input.name, "restart", apphost, await getProjectCwd());
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
                    entry.dispose?.();
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
                        // Respect the AppHost selected in the open traces canvas.
                        const apphost = traceInstances.get(ctx.instanceId)?.getSelectedApphost?.() ?? ctx.input?.apphost;
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

_sessionResolve(session);
