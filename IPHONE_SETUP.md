# iPhone: first setup

The iPhone mode uses the same private GitHub repository and branch as Windows and macOS. It syncs Markdown (`.md`) and Canvas (`.canvas`) while Obsidian is open. Attachments and background synchronization are intentionally not part of this first mobile release.

1. Copy `main.js` and `manifest.json` to the iPhone vault at `.obsidian/plugins/github-vault-sync/` using the Files app or iCloud Drive.
2. Restart Obsidian and enable **Синхронизация заметок с GitHub** in Community plugins.
3. Enter the same repository HTTPS URL and branch in plugin settings.
4. Create a GitHub fine-grained personal access token restricted to this one repository, with **Contents: Read and write** permission. Paste it into **GitHub token для iPhone**.
5. In a new empty vault, run **Получить заметки из GitHub** once. After that use **Синхронизировать заметки с GitHub**.

The plugin stores the token only in its own local Obsidian plugin data. Never place tokens in notes or commit them to the repository.

If a note was edited both on iPhone and elsewhere since the last sync, the plugin stops and reports a conflict rather than overwriting either version. Resolve it on Windows or macOS first.
