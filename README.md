# GitHub Vault Sync for Obsidian

Desktop-only Obsidian plugin that uses the locally installed Git executable. It never stores a GitHub token; authenticate through Git Credential Manager when Git asks for credentials.

## Development

```powershell
npm install
npm run build
```

Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/github-vault-sync/`, enable Community Plugins, then enable **GitHub Vault Sync**.

## First use

1. Create an empty private repository on GitHub.
2. In plugin settings, paste its HTTPS URL and choose the branch (normally `main`).
3. Run **Initialize vault repository** from the command palette. It creates a local Git repository, writes a conservative `.gitignore`, makes the initial commit, and pushes it.
4. On another device, clone the repository into an empty vault directory or use normal Git clone before opening it as a vault.

`Sync now` always fetches and fast-forwards before creating a commit and pushing. If Git finds divergent histories or merge conflicts, the plugin stops; it never attempts an automatic conflict resolution.

## Scope and safety

- Requires Git available on PATH and works only in Obsidian Desktop.
- Default exclusions protect workspace/layout state, trash, caches and this plugin's private data. Other `.obsidian` settings can be synced when enabled explicitly.
- Do not put passwords, API keys, or unencrypted private data in a repository.
