import { App, Notice, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import MobileGitHubSync, { MobileFileState, MobileSyncSettings } from "./mobileGitHubSync";

interface SyncSettings extends MobileSyncSettings { autoSyncMinutes: number; pullOnStartup: boolean; syncObsidianSettings: boolean; githubToken: string; mobileState: Record<string, MobileFileState>; }
const DEFAULT_SETTINGS: SyncSettings = { remoteUrl: "", branch: "main", autoSyncMinutes: 0, pullOnStartup: true, syncObsidianSettings: false, githubToken: "", mobileState: {} };

class GitError extends Error { constructor(message: string, readonly details: string) { super(message); } }

export default class GitHubVaultSyncPlugin extends Plugin {
  settings: SyncSettings = DEFAULT_SETTINGS;
  private syncing = false;
  private autoSyncId: number | null = null;
  private mobileSync: MobileGitHubSync | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new GitHubVaultSyncSettingTab(this.app, this));
    if (!Platform.isDesktopApp) {
      this.mobileSync = new MobileGitHubSync(this.app.vault, () => this.settings, async (state) => { this.settings.mobileState = state; await this.saveData(this.settings); });
      this.addCommand({ id: "mobile-sync", name: "Синхронизировать заметки с GitHub", callback: () => this.mobileSync?.sync() });
      this.addCommand({ id: "mobile-pull", name: "Получить заметки из GitHub", callback: () => this.mobileSync?.pull() });
      this.addRibbonIcon("smartphone", "Синхронизировать заметки с GitHub", () => void this.mobileSync?.sync());
      if (this.settings.pullOnStartup) window.setTimeout(() => void this.mobileSync?.pull(true), 1_500);
      return;
    }
    this.addCommand({ id: "sync-now", name: "Синхронизировать сейчас (получить, сохранить, отправить)", callback: () => this.syncNow() });
    this.addCommand({ id: "pull", name: "Получить изменения из GitHub", callback: () => this.pull() });
    this.addCommand({ id: "initialize", name: "Создать репозиторий для этого хранилища", callback: () => this.initializeRepository() });
    this.addCommand({ id: "connect-device", name: "Подключить пустое хранилище к GitHub", callback: () => this.connectDevice() });
    this.addRibbonIcon("refresh-cw", "Синхронизация заметок с GitHub", () => this.syncNow());
    this.configureAutoSync();
    if (this.settings.pullOnStartup) window.setTimeout(() => void this.pull(true), 1_500);
  }
  onunload(): void { if (this.autoSyncId !== null) window.clearInterval(this.autoSyncId); }
  async loadSettings(): Promise<void> { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); this.configureAutoSync(); }
  private configureAutoSync(): void {
    if (this.autoSyncId !== null) window.clearInterval(this.autoSyncId);
    this.autoSyncId = this.settings.autoSyncMinutes > 0 ? window.setInterval(() => void this.syncNow(true), this.settings.autoSyncMinutes * 60_000) : null;
  }
  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (!("basePath" in adapter) || typeof adapter.basePath !== "string") throw new Error("Плагину требуется локальное хранилище на диске.");
    return adapter.basePath;
  }
  private async git(args: string[]): Promise<string> {
    try {
      const { execFile } = require("child_process") as typeof import("child_process");
      const { promisify } = require("util") as typeof import("util");
      const execFileAsync = promisify(execFile);
      const { stdout, stderr } = await execFileAsync("git", args, { cwd: this.vaultPath(), windowsHide: true });
      return `${stdout}${stderr}`.trim();
    } catch (error: unknown) {
      const e = error as { stderr?: string; message?: string };
      throw new GitError(`Git ${args[0]} failed.`, (e.stderr || e.message || "Unknown Git error").trim());
    }
  }
  private async isRepository(): Promise<boolean> {
    try {
      const gitRoot = await this.git(["rev-parse", "--show-toplevel"]);
      const { resolve } = require("path") as typeof import("path");
      return resolve(gitRoot).toLocaleLowerCase() === resolve(this.vaultPath()).toLocaleLowerCase();
    } catch { return false; }
  }
  private assertConfigured(): void { if (!this.settings.remoteUrl.trim()) throw new Error("Сначала укажите URL репозитория GitHub в настройках плагина."); }
  async initializeRepository(): Promise<void> {
    if (this.syncing) return; this.syncing = true;
    try {
      this.assertConfigured(); if (await this.isRepository()) throw new Error("Это хранилище уже является Git-репозиторием. Используйте синхронизацию.");
      new Notice("Создание локального Git-репозитория…"); await this.git(["init"]); await this.git(["checkout", "-b", this.settings.branch]);
      this.writeGitIgnore(); await this.git(["add", "-A"]); await this.git(["commit", "-m", "Initial vault sync"]);
      await this.git(["remote", "add", "origin", this.settings.remoteUrl.trim()]); await this.git(["push", "-u", "origin", this.settings.branch]);
      new Notice("Репозиторий хранилища создан и отправлен в GitHub.");
    } catch (error) { this.showError(error); } finally { this.syncing = false; }
  }
  async connectDevice(): Promise<void> {
    if (this.syncing) return; this.syncing = true;
    try {
      this.assertConfigured();
      if (await this.isRepository()) throw new Error("Это хранилище уже является Git-репозиторием.");
      const { readdirSync } = require("fs") as typeof import("fs");
      const files = readdirSync(this.vaultPath()).filter((name: string) => name !== ".obsidian");
      if (files.length > 0) throw new Error("Для безопасности подключайте новое устройство только из пустого хранилища.");
      new Notice("Загрузка хранилища из GitHub...");
      await this.git(["init"]); await this.git(["remote", "add", "origin", this.settings.remoteUrl.trim()]);
      await this.git(["fetch", "origin", this.settings.branch]);
      await this.git(["checkout", "-B", this.settings.branch, "--track", `origin/${this.settings.branch}`]);
      new Notice("Хранилище загружено. Перезапустите Obsidian, чтобы применить синхронизированные настройки.");
    } catch (error) { this.showError(error); } finally { this.syncing = false; }
  }
  async pull(silent = false): Promise<void> {
    if (this.syncing) return; this.syncing = true;
    try { if (!await this.isRepository()) throw new Error("Сначала создайте репозиторий или подключите это хранилище к GitHub."); new Notice("Получение изменений из GitHub…"); await this.git(["pull", "--ff-only", "origin", this.settings.branch]); new Notice("Изменения из GitHub получены."); }
    catch (error) { this.showError(error, silent); } finally { this.syncing = false; }
  }
  async syncNow(silent = false): Promise<void> {
    if (this.syncing) { if (!silent) new Notice("Синхронизация уже выполняется."); return; } this.syncing = true;
    try {
      if (!await this.isRepository()) throw new Error("Сначала создайте репозиторий или подключите это хранилище к GitHub."); if (!silent) new Notice("Синхронизация хранилища…");
      await this.git(["pull", "--ff-only", "origin", this.settings.branch]); const changed = await this.git(["status", "--porcelain"]);
      if (changed) { await this.git(["add", "-A"]); await this.git(["commit", "-m", `Синхронизация хранилища ${new Date().toISOString()}`]); await this.git(["push", "origin", this.settings.branch]); if (!silent) new Notice("Изменения хранилища отправлены в GitHub."); }
      else if (!silent) new Notice("Хранилище уже синхронизировано.");
    } catch (error) { this.showError(error); } finally { this.syncing = false; }
  }
  private writeGitIgnore(): void {
    const { existsSync, writeFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const file = join(this.vaultPath(), ".gitignore"); if (existsSync(file)) return;
    const obsidianRules = this.settings.syncObsidianSettings ? ".obsidian/workspace*.json\n.obsidian/plugins/github-vault-sync/data.json\n" : ".obsidian/\n";
    writeFileSync(file, `.trash/\n.DS_Store\nThumbs.db\n${obsidianRules}`, "utf8");
  }
  private showError(error: unknown, silent = false): void {
    const message = error instanceof GitError ? `${error.message} ${error.details}` : error instanceof Error ? error.message : String(error);
    if (!silent) new Notice(`Синхронизация остановлена: ${message}`, 12_000); console.error("Синхронизация заметок с GitHub", error);
  }
}

class GitHubVaultSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitHubVaultSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: "Синхронизация заметок с GitHub" });
    containerEl.createEl("p", { text: "Используется локальный Git и его менеджер учётных данных. Плагин никогда не хранит токен GitHub." });
    if (!Platform.isDesktopApp) {
      new Setting(containerEl).setName("GitHub token для iPhone").setDesc("Создайте fine-grained token с доступом Contents: Read and write только к этому private-репозиторию. Токен не попадает в заметки или коммиты.").addText(text => { text.inputEl.type = "password"; text.setPlaceholder("github_pat_...").setValue(this.plugin.settings.githubToken).onChange(async value => { this.plugin.settings.githubToken = value.trim(); await this.plugin.saveSettings(); }); });
    }
    new Setting(containerEl).setName("URL репозитория").setDesc("HTTPS- или SSH-адрес репозитория GitHub.").addText(text => text.setPlaceholder("https://github.com/user/vault.git").setValue(this.plugin.settings.remoteUrl).onChange(async value => { this.plugin.settings.remoteUrl = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Ветка").setDesc("Обычно main.").addText(text => text.setValue(this.plugin.settings.branch).onChange(async value => { this.plugin.settings.branch = value.trim() || "main"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Интервал автосинхронизации").setDesc("В минутах. Ноль отключает автоматическую синхронизацию.").addText(text => text.setValue(String(this.plugin.settings.autoSyncMinutes)).onChange(async value => { this.plugin.settings.autoSyncMinutes = Math.max(0, Number.parseInt(value, 10) || 0); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Получать обновления при запуске Obsidian").setDesc("Проверяет GitHub вскоре после открытия хранилища. При запуске ничего не отправляется.").addToggle(toggle => toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async value => { this.plugin.settings.pullOnStartup = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Синхронизировать настройки Obsidian").setDesc("Передаёт темы, плагины и настройки, но всегда исключает раскладку окон и локальные данные этого плагина.").addToggle(toggle => toggle.setValue(this.plugin.settings.syncObsidianSettings).onChange(async value => { this.plugin.settings.syncObsidianSettings = value; await this.plugin.saveSettings(); }));
  }
}
