import { readFile } from "node:fs/promises";
import { basename, join as pathJoin } from "node:path";
import { homedir } from "node:os";

const COPILOT_HOME = process.env.COPILOT_HOME || pathJoin(homedir(), ".copilot");
const BRANDING_CONFIG_PATH = pathJoin(COPILOT_HOME, "extensions", "aspire-resources", "artifacts", "branding.json");

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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
    const repoCfg = (cfg.repos && cfg.repos[repoKey]) || {};

    const appName = String(input?.appName || repoCfg.appName || cfg.defaultAppName || "App").trim() || "App";
    const emoji = String(input?.emoji || repoCfg.emoji || cfg.defaultEmoji || "💫").trim() || "💫";
    const title = `${appName} Resources`;
    return { appName, emoji, title, repoKey };
}

export { escapeHtml, resolveBranding };
