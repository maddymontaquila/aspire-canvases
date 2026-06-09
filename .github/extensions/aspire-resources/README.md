# aspire-resources

Aspire canvas extension with two canvases:

- `aspire-resources` — resource state/health/endpoints management.
- `aspire-traces` — trace-focused view powered by `aspire otel traces`, with quick dashboard links and log snapshot buttons.

## Files

- `extension.mjs` — canvas wiring (declares both canvases, action handlers, lifecycle).
- `resources-server.mjs` / `traces-server.mjs` — per-instance loopback HTTP servers.
- `resources-ui.mjs` / `traces-ui.mjs` — HTML/CSS/client-JS for each canvas.
- `aspire-cli.mjs` — Aspire CLI discovery and command helpers.
- `branding.mjs` — branding/title resolution.
- `http-util.mjs` — shared HTTP helpers (body parsing, SSE broadcast, loopback guard).
- `branding.json` — placeholder branding config for project-scoped installs.

## Branding config (per repo)

For repo-level customization, edit:

- `.github/extensions/aspire-resources/branding.json`

Use this simple shape:

```json
{
  "defaultAppName": "Aspire Canvases",
  "defaultEmoji": "🌱"
}
```

These values set the canvas title and emoji for this repository.

### Advanced (shared/global config)

If you're using a shared/global branding file across many repos, you can also use a repo map keyed by repository folder name:

```json
{
  "repos": {
    "aspire-canvases": {
      "appName": "Aspire Canvases",
      "emoji": "🌱"
    }
  }
}
```
