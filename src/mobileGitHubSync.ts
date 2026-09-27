import { normalizePath, Notice, TFile, Vault, requestUrl } from "obsidian";

export interface MobileFileState { remoteSha: string; localHash: string; }
export interface MobileSyncSettings { remoteUrl: string; branch: string; githubToken: string; mobileState: Record<string, MobileFileState>; }

type RemoteFile = { sha: string; type: "blob"; path: string };
type Repository = { owner: string; name: string };

/** Mobile-only sync through GitHub's REST API. No Node.js or local Git is used. */
export default class MobileGitHubSync {
  constructor(
    private vault: Vault,
    private getSettings: () => MobileSyncSettings,
    private saveState: (state: Record<string, MobileFileState>) => Promise<void>
  ) {}

  async sync(): Promise<void> {
    try {
      new Notice("Синхронизация с GitHub...");
      await this.pull(true);
      await this.push();
      new Notice("Заметки синхронизированы с GitHub.");
    } catch (error) { this.showError(error); }
  }

  async pull(silent = false): Promise<void> {
    try {
      const repo = this.repository();
      const remote = await this.remoteFiles(repo);
      const settings = this.getSettings();
      const state = { ...settings.mobileState };
      const remotePaths = new Set(remote.keys());

      for (const [path, file] of remote) {
        const local = this.vault.getAbstractFileByPath(path);
        const known = state[path];
        if (local instanceof TFile && !known) {
          const content = await this.download(repo, path);
          if (await this.hash(await this.vault.read(local)) !== await this.hash(content)) throw new Error(`Заметка «${path}» уже есть на iPhone и не имеет общей истории. Создайте чистое хранилище или разберите конфликт на компьютере.`);
          state[path] = { remoteSha: file.sha, localHash: await this.hash(content) };
          continue;
        }
        if (local instanceof TFile && known) {
          const localHash = await this.hash(await this.vault.read(local));
          if (localHash !== known.localHash && file.sha !== known.remoteSha) throw new Error(`Конфликт в заметке «${path}». Изменения есть и на iPhone, и в GitHub.`);
          if (localHash !== known.localHash) continue;
        }
        const content = await this.download(repo, path);
        await this.ensureParentFolders(path);
        await this.vault.adapter.write(normalizePath(path), content);
        state[path] = { remoteSha: file.sha, localHash: await this.hash(content) };
      }

      for (const [path, known] of Object.entries(state)) {
        if (remotePaths.has(path)) continue;
        const local = this.vault.getAbstractFileByPath(path);
        if (local instanceof TFile && await this.hash(await this.vault.read(local)) !== known.localHash) throw new Error(`Удаление «${path}» конфликтует с локальной правкой на iPhone.`);
        if (local instanceof TFile) await this.vault.delete(local);
        delete state[path];
      }
      await this.saveState(state);
      if (!silent) new Notice("Изменения из GitHub получены.");
    } catch (error) {
      if (!silent) this.showError(error);
      else console.error("GitHub mobile pull", error);
      throw error;
    }
  }

  private async push(): Promise<void> {
    const repo = this.repository();
    const remote = await this.remoteFiles(repo);
    const settings = this.getSettings();
    const state = { ...settings.mobileState };
    const files = this.vault.getFiles().filter(file => file.extension === "md" || file.extension === "canvas");

    for (const file of files) {
      const path = file.path;
      const content = await this.vault.read(file);
      const localHash = await this.hash(content);
      const known = state[path];
      const remoteFile = remote.get(path);
      if (known && remoteFile && remoteFile.sha !== known.remoteSha && localHash !== known.localHash) throw new Error(`Конфликт в заметке «${path}». Сначала получите изменения из GitHub.`);
      if (known && localHash === known.localHash) continue;
      if (!known && remoteFile) throw new Error(`Заметка «${path}» уже есть в GitHub без общей истории. Сначала получите изменения.`);
      const result = await this.api<{ content: { sha: string } }>(repo, "PUT", `contents/${this.encodePath(path)}`, {
        message: `Обновление заметки с iPhone: ${path}`,
        content: this.base64(content),
        branch: settings.branch,
        ...(remoteFile ? { sha: remoteFile.sha } : {})
      });
      state[path] = { remoteSha: result.content.sha, localHash };
    }
    await this.saveState(state);
  }

  private repository(): Repository {
    const { remoteUrl, githubToken } = this.getSettings();
    const match = remoteUrl.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
    if (!match) throw new Error("Для iPhone укажите HTTPS URL репозитория GitHub, например https://github.com/user/notes.git.");
    if (!githubToken.trim()) throw new Error("Для iPhone добавьте fine-grained GitHub token в настройках плагина.");
    return { owner: match[1], name: match[2] };
  }

  private async remoteFiles(repo: Repository): Promise<Map<string, RemoteFile>> {
    const settings = this.getSettings();
    const ref = await this.api<{ object: { sha: string } }>(repo, "GET", `git/ref/heads/${encodeURIComponent(settings.branch)}`);
    const commit = await this.api<{ tree: { sha: string } }>(repo, "GET", `git/commits/${ref.object.sha}`);
    const tree = await this.api<{ tree: RemoteFile[] }>(repo, "GET", `git/trees/${commit.tree.sha}?recursive=1`);
    return new Map(tree.tree.filter(file => file.type === "blob" && this.supported(file.path)).map(file => [file.path, file]));
  }

  private async download(repo: Repository, path: string): Promise<string> {
    const file = await this.api<{ content: string; encoding: string }>(repo, "GET", `contents/${this.encodePath(path)}?ref=${encodeURIComponent(this.getSettings().branch)}`);
    if (file.encoding !== "base64") throw new Error(`GitHub вернул неизвестный формат заметки «${path}».`);
    return this.fromBase64(file.content.replace(/\n/g, ""));
  }

  private async api<T>(repo: Repository, method: string, endpoint: string, body?: unknown): Promise<T> {
    const token = this.getSettings().githubToken.trim();
    const response = await requestUrl({
      url: `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${endpoint}`,
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return response.json as T;
  }

  private supported(path: string): boolean { return path.endsWith(".md") || path.endsWith(".canvas"); }
  private async ensureParentFolders(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    parts.pop();
    let parent = "";
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(parent)) await this.vault.createFolder(parent);
    }
  }
  private encodePath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
  private base64(text: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(text))); }
  private fromBase64(value: string): string { return new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))); }
  private async hash(text: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, "0")).join(""); }
  private showError(error: unknown): void { new Notice(`Синхронизация остановлена: ${error instanceof Error ? error.message : String(error)}`, 12_000); console.error("GitHub mobile sync", error); }
}
