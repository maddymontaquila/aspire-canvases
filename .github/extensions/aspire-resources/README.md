# aspire-resources

Aspire resources canvas extension.

## Files

- `extension.mjs` — canvas extension entrypoint.
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
  "repositories": {
    "aspire-canvases": {
      "appName": "Aspire Canvases",
      "emoji": "🌱"
    }
  }
}
```
