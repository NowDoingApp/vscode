import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { buildAuthHeaders } from "./auth";
import { readCapability } from "./capability";
import type { API, GitExtension, Repository } from "./git";
import { RepoWatcher } from "./repoWatcher";
import {
  buildActivitySearchPath,
  evaluateWatchIgnorePattern,
  errorMessageFromResponse,
  formatError,
  getRetryDelayMs,
  isRetryableNotifyError,
  parseJson,
} from "./util";

const CONFIG_SECTION = "nowdoing";
const BRANCH_ENDPOINT_PATH = "/branch-changed";
const HEALTHCHECK_ENDPOINT_PATH = "/healthcheck";
const ACTIVITY_SEARCH_ENDPOINT_PATH = "/activities/search";
const ACTIVITY_START_ENDPOINT_PATH = "/activities/start";
const CURRENT_ENDPOINT_PATH = "/current";
const MAX_RETRY_ATTEMPTS = 4;

type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "checking"
  | "needs-app";

interface ActivitySearchItem {
  id: string;
  name: string;
  groupName?: string;
}

interface ActivitySearchResponse {
  items: ActivitySearchItem[];
}

interface ActivityStartResult {
  activityID: string;
  activityName: string;
  created: boolean;
}

interface ActivityStartResponse {
  ok: boolean;
  result: ActivityStartResult;
}

interface ActivityQuickPickItem extends vscode.QuickPickItem {
  itemType: "activity" | "create";
  activityID?: string;
  createName?: string;
}

interface BranchChangeBody {
  repo: string;
  repoPath?: string;
  branch: string;
  previousBranch?: string;
}

interface CurrentActivityResult {
  activityID: string;
  activityName: string;
  startedAt: string;
  isOnBreak: boolean;
}

interface CurrentActivityResponse {
  ok: boolean;
  result: CurrentActivityResult | null;
}

interface ActivityStartBody {
  activityID?: string;
  name?: string;
  createIfMissing?: boolean;
}

interface QueuedBranchChange extends BranchChangeBody {
  attempts: number;
}

interface StatusActionItem extends vscode.QuickPickItem {
  action:
    | "startActivity"
    | "testConnection"
    | "reconnect"
    | "openSettings"
    | "showOutput";
}

interface CheckConnectionOptions {
  notify: boolean;
}

let activeExtension: NowDoingExtension | undefined;

export function activate(context: vscode.ExtensionContext): void {
  activeExtension = new NowDoingExtension(context);
  context.subscriptions.push(activeExtension);
}

export function deactivate(): void {
  activeExtension = undefined;
}

class NowDoingExtension implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly activityItem: vscode.StatusBarItem;
  private readonly elapsedItem: vscode.StatusBarItem;
  private readonly watchedRepos = new Map<string, RepoWatcher>();
  private currentStatus: ConnectionStatus = "checking";
  private currentActivity: CurrentActivityResult | null = null;
  private pollHandle: NodeJS.Timeout | undefined;
  private tickHandle: NodeJS.Timeout | undefined;
  private configListener: vscode.Disposable | undefined;
  private retryQueue: QueuedBranchChange[] = [];
  private retryHandle: NodeJS.Timeout | undefined;
  private invalidWatchIgnorePattern: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("NowDoing");
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      0
    );
    this.statusBarItem.command = "nowdoing.statusBarClick";
    this.statusBarItem.name = "NowDoing Connection Status";
    this.setStatus("checking");
    this.statusBarItem.show();

    this.activityItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      0
    );
    this.activityItem.name = "NowDoing Current Activity";
    this.activityItem.command = "nowdoing.startActivity";

    this.elapsedItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      0
    );
    this.elapsedItem.name = "NowDoing Elapsed Time";
    this.elapsedItem.command = "nowdoing.startActivity";

    this.registerCommands();
    this.attachGitApi();
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        if (e.affectsConfiguration("nowdoing.watchIgnorePattern")) {
          this.validateWatchIgnorePattern(true);
        }
        this.renderCurrentActivity();
        this.restartPolling();
      }
    });
    this.context.subscriptions.push(this.configListener);
    this.validateWatchIgnorePattern(false);
    void this.bootstrap();
    this.startPolling();
    this.tickHandle = setInterval(() => this.renderCurrentActivity(), 30_000);
  }

  dispose(): void {
    for (const watcher of this.watchedRepos.values()) watcher.dispose();
    this.watchedRepos.clear();
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.retryHandle) clearTimeout(this.retryHandle);
    this.retryQueue.length = 0;
    this.statusBarItem.dispose();
    this.activityItem.dispose();
    this.elapsedItem.dispose();
    this.output.dispose();
  }

  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand("nowdoing.testConnection", () =>
        this.runTestConnection()
      ),
      vscode.commands.registerCommand("nowdoing.reconnect", async () => {
        this.setStatus("checking");
        await this.checkConnection({ notify: true });
      }),
      vscode.commands.registerCommand("nowdoing.showOutput", () => {
        this.output.show();
      }),
      vscode.commands.registerCommand("nowdoing.startActivity", () =>
        this.runStartActivityCommand()
      ),
      vscode.commands.registerCommand("nowdoing.openSettings", () => {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:NowDoing.nowdoing-vscode"
        );
      }),
      vscode.commands.registerCommand("nowdoing.statusBarClick", () =>
        this.handleStatusBarClick()
      ),
      vscode.commands.registerCommand("nowdoing.showStatusMenu", () =>
        this.runStatusActionMenu()
      ),
      vscode.commands.registerCommand("nowdoing.toggleCurrentActivity", () =>
        this.toggleSetting("showCurrentActivity")
      ),
      vscode.commands.registerCommand("nowdoing.toggleElapsedTime", () =>
        this.toggleSetting("showElapsedTime")
      )
    );
  }

  private async toggleSetting(
    key: "showCurrentActivity" | "showElapsedTime"
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const current = config.get<boolean>(key, true);
    await config.update(key, !current, vscode.ConfigurationTarget.Global);
  }

  private startPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    const seconds = Math.max(2, readNumber("currentPollSeconds", 10));
    this.pollHandle = setInterval(() => {
      void this.refreshCurrentActivity();
    }, seconds * 1000);
    void this.refreshCurrentActivity();
  }

  private restartPolling(): void {
    this.startPolling();
  }

  private async refreshCurrentActivity(): Promise<void> {
    if (
      this.currentStatus === "needs-app" ||
      this.currentStatus === "disconnected"
    ) {
      this.currentActivity = null;
      this.renderCurrentActivity();
      return;
    }
    try {
      const response = await this.requestNowDoing(
        "GET",
        CURRENT_ENDPOINT_PATH
      );
      if (response.status < 200 || response.status >= 300) {
        this.currentActivity = null;
      } else {
        const payload = parseJson<CurrentActivityResponse>(response.body);
        this.currentActivity = payload?.result ?? null;
      }
    } catch (err) {
      this.log(`Current activity poll failed: ${formatError(err)}`);
      this.currentActivity = null;
    }
    this.renderCurrentActivity();
  }

  private renderCurrentActivity(): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showActivity = config.get<boolean>("showCurrentActivity", true);
    const showElapsed = config.get<boolean>("showElapsedTime", true);

    if (!showActivity || !this.currentActivity) {
      this.activityItem.hide();
    } else {
      const breakSuffix = this.currentActivity.isOnBreak ? " (Break)" : "";
      this.activityItem.text = `$(watch) ${this.currentActivity.activityName}${breakSuffix}`;
      this.activityItem.tooltip = `NowDoing: ${this.currentActivity.activityName} - click to track new activity`;
      this.activityItem.show();
    }

    if (!showElapsed || !this.currentActivity) {
      this.elapsedItem.hide();
    } else {
      const startedMs = Date.parse(this.currentActivity.startedAt);
      const elapsedMs = Number.isFinite(startedMs)
        ? Math.max(0, Date.now() - startedMs)
        : 0;
      this.elapsedItem.text = `$(clock) ${formatElapsed(elapsedMs)}`;
      this.elapsedItem.tooltip = `Elapsed since ${new Date(
        startedMs
      ).toLocaleTimeString()} - click to track new activity`;
      this.elapsedItem.show();
    }
  }

  private attachGitApi(): void {
    const gitExt = vscode.extensions.getExtension<GitExtension>("vscode.git")!;

    const start = (api: API): void => {
      for (const repo of api.repositories) {
        this.attachRepo(repo);
      }
      this.context.subscriptions.push(
        api.onDidOpenRepository((repo) => this.attachRepo(repo)),
        api.onDidCloseRepository((repo) => this.detachRepo(repo))
      );
    };

    const ensureActivated = async (): Promise<void> => {
      const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      start(exports.getAPI(1));
    };

    void ensureActivated().catch((err) => {
      this.log(`Failed to activate Git API: ${formatError(err)}`);
    });
  }

  private async bootstrap(): Promise<void> {
    await this.checkConnection({ notify: false });
  }

  private attachRepo(repo: Repository): void {
    const key = repo.rootUri.toString();
    if (this.watchedRepos.has(key)) return;
    this.watchedRepos.set(
      key,
      new RepoWatcher(
        repo,
        (branch, previousBranch) =>
          this.notifyBranchChange(repo, branch, previousBranch),
        () => readNumber("debounceMs", 1500)
      )
    );
    this.log(`Watching repository ${repo.rootUri.fsPath}`);
  }

  private detachRepo(repo: Repository): void {
    const key = repo.rootUri.toString();
    const watcher = this.watchedRepos.get(key);
    if (watcher) {
      watcher.dispose();
      this.watchedRepos.delete(key);
      this.log(`Stopped watching repository ${repo.rootUri.fsPath}`);
    }
  }

  private async notifyBranchChange(
    repo: Repository,
    branch: string,
    previousBranch: string | undefined
  ): Promise<void> {
    if (this.shouldIgnoreBranch(branch)) {
      this.log(
        `Ignoring branch change due to nowdoing.watchIgnorePattern: ${branch}`
      );
      return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (config.get<boolean>("enabled", true) === false) return;

    const payload: BranchChangeBody = {
      repo: path.basename(repo.rootUri.fsPath),
      repoPath: repo.rootUri.fsPath,
      branch,
      previousBranch,
    };

    try {
      const status = await this.postBranchChange(payload);
      this.log(`Notified NowDoing: ${payload.repo} -> ${branch} (HTTP ${status})`);
      this.setStatus("connected");
    } catch (err) {
      this.log(
        `Failed to notify NowDoing for ${payload.repo} -> ${branch}: ${formatError(err)}`
      );
      if (isRetryableNotifyError(err)) {
        this.enqueueBranchRetry(payload, err);
      }
      this.setStatus("disconnected");
    }
  }

  private async runTestConnection(): Promise<void> {
    try {
      const status = await this.pingHealthcheck();
      this.setStatus("connected");
      void vscode.window.showInformationMessage(
        `NowDoing reachable (HTTP ${status}).`
      );
    } catch (err) {
      this.setStatus("disconnected");
      void vscode.window.showErrorMessage(
        `Could not reach NowDoing: ${formatError(err)}`
      );
    }
  }

  private async checkConnection(options: CheckConnectionOptions): Promise<void> {
    try {
      readCapability();
    } catch (err) {
      this.setStatus("needs-app");
      if (options.notify) {
        void vscode.window
          .showWarningMessage(
            "NowDoing: App not reachable. Open the NowDoing app and enable the VSCode integration.",
            "Retry"
          )
          .then((choice) => {
            if (choice === "Retry") {
              void vscode.commands.executeCommand("nowdoing.reconnect");
            }
          });
      } else {
        this.log(`Capability file unavailable: ${formatError(err)}`);
      }
      return;
    }
    try {
      await this.pingHealthcheck();
      this.setStatus("connected");
      if (options.notify) {
        void vscode.window.showInformationMessage("NowDoing: Connected.");
      }
    } catch (err) {
      this.setStatus("disconnected");
      if (options.notify) {
        void vscode.window
          .showErrorMessage(
            `NowDoing: Connection failed: ${formatError(err)}`,
            "Retry",
            "Show Output"
          )
          .then((choice) => {
            if (choice === "Retry") {
              void vscode.commands.executeCommand("nowdoing.reconnect");
            } else if (choice === "Show Output") {
              void vscode.commands.executeCommand("nowdoing.showOutput");
            }
          });
      } else {
        this.log(`Connection check failed: ${formatError(err)}`);
      }
    }
  }

  private async pingHealthcheck(): Promise<number> {
    const response = await this.requestNowDoing(
      "GET",
      HEALTHCHECK_ENDPOINT_PATH
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(errorMessageFromResponse(response.status, response.body));
    }
    return response.status;
  }

  private setStatus(state: ConnectionStatus): void {
    const previous = this.currentStatus;
    this.currentStatus = state;
    switch (state) {
      case "connected":
        this.statusBarItem.text = "$(check) NowDoing";
        this.statusBarItem.tooltip = "NowDoing: Connected, click for actions";
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Connected, click for actions",
          role: "button",
        };
        break;
      case "disconnected":
        this.statusBarItem.text = "$(warning) NowDoing";
        this.statusBarItem.tooltip = "NowDoing: Disconnected, click for actions";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Disconnected, click for actions",
          role: "button",
        };
        break;
      case "checking":
        this.statusBarItem.text = "$(sync~spin) NowDoing";
        this.statusBarItem.tooltip = "NowDoing: Checking connection..., click for actions";
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Checking connection, click for actions",
          role: "button",
        };
        break;
      case "needs-app":
        this.statusBarItem.text = "$(warning) NowDoing";
        this.statusBarItem.tooltip =
          "NowDoing: App not reachable, click for actions";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: App not reachable, click for actions",
          role: "button",
        };
        break;
    }

    if (
      previous === "connected" &&
      (state === "disconnected" || state === "needs-app")
    ) {
      void vscode.window
        .showWarningMessage(
          "NowDoing: Connection lost. Branch changes are not being sent.",
          "Retry",
          "Show Output"
        )
        .then((choice) => {
          if (choice === "Retry") {
            void vscode.commands.executeCommand("nowdoing.reconnect");
          } else if (choice === "Show Output") {
            void vscode.commands.executeCommand("nowdoing.showOutput");
          }
        });
    }
  }

  private async handleStatusBarClick(): Promise<void> {
    await this.runStatusActionMenu();
  }

  private async runStatusActionMenu(): Promise<void> {
    const selected = await vscode.window.showQuickPick<StatusActionItem>(
      [
        {
          label: "$(play) Track New Activity",
          description: "Open activity picker",
          action: "startActivity",
        },
        {
          label: "$(pulse) Test Connection",
          description: "Call /healthcheck",
          action: "testConnection",
        },
        {
          label: "$(debug-restart) Reconnect",
          description: "Re-check app connectivity",
          action: "reconnect",
        },
        {
          label: "$(settings-gear) Open Settings",
          description: "Open extension settings",
          action: "openSettings",
        },
        {
          label: "$(output) Show Output Log",
          description: "Open NowDoing output channel",
          action: "showOutput",
        },
      ],
      {
        title: "NowDoing",
        placeHolder: "Choose an action",
        ignoreFocusOut: true,
      }
    );

    switch (selected?.action) {
      case "startActivity":
        await this.runStartActivityCommand();
        break;
      case "testConnection":
        await this.runTestConnection();
        break;
      case "reconnect":
        this.setStatus("checking");
        await this.checkConnection({ notify: true });
        break;
      case "openSettings":
        await vscode.commands.executeCommand("nowdoing.openSettings");
        break;
      case "showOutput":
        await vscode.commands.executeCommand("nowdoing.showOutput");
        break;
    }
  }

  private async runStartActivityCommand(): Promise<void> {
    try {
      readCapability();
    } catch {
      void vscode.window
        .showWarningMessage(
          "NowDoing: App not reachable. Open the NowDoing app and enable the VSCode integration.",
          "Retry"
        )
        .then((choice) => {
          if (choice === "Retry") {
            void vscode.commands.executeCommand("nowdoing.reconnect");
          }
        });
      return;
    }

    const quickPick = vscode.window.createQuickPick<ActivityQuickPickItem>();
    quickPick.title = "NowDoing: Start activity";
    quickPick.placeholder = "Search activities...";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.ignoreFocusOut = true;

    let debounceHandle: NodeJS.Timeout | undefined;
    let requestVersion = 0;

    const updateItems = async (query: string): Promise<void> => {
      const version = ++requestVersion;
      quickPick.busy = true;
      try {
        const items = await this.searchActivities(query, 20);
        if (version !== requestVersion) return;

        const options: ActivityQuickPickItem[] = items.map((item) => ({
          itemType: "activity",
          label: item.name,
          description: item.groupName ? `Group: ${item.groupName}` : undefined,
          activityID: item.id,
        }));

        const trimmed = query.trim();
        const exactMatch =
          trimmed.length > 0 &&
          items.some(
            (item) =>
              item.name.localeCompare(trimmed, undefined, {
                sensitivity: "accent",
              }) === 0
          );
        if (trimmed.length > 0 && !exactMatch) {
          options.unshift({
            itemType: "create",
            label: `Create new activity: ${trimmed}`,
            description: "New activity",
            createName: trimmed,
          });
        }

        quickPick.items = options;
      } catch (err) {
        if (version !== requestVersion) return;
        quickPick.items = [];
        const message = `NowDoing search failed: ${formatError(err)}`;
        this.log(message);
        void vscode.window.showErrorMessage(message);
      } finally {
        if (version === requestVersion) {
          quickPick.busy = false;
        }
      }
    };

    quickPick.onDidChangeValue((value) => {
      if (debounceHandle) {
        clearTimeout(debounceHandle);
      }
      debounceHandle = setTimeout(() => {
        void updateItems(value);
      }, 140);
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected) return;

      quickPick.busy = true;
      quickPick.enabled = false;

      try {
        if (selected.itemType === "activity" && selected.activityID) {
          const result = await this.startActivity({
            activityID: selected.activityID,
          });
          void vscode.window.showInformationMessage(
            result.created
              ? `NowDoing: Activity created and started: ${result.activityName}`
              : `NowDoing: Activity started: ${result.activityName}`
          );
        } else if (selected.itemType === "create" && selected.createName) {
          const result = await this.startActivity({
            name: selected.createName,
            createIfMissing: true,
          });
          void vscode.window.showInformationMessage(
            result.created
              ? `NowDoing: Activity created and started: ${result.activityName}`
              : `NowDoing: Activity started: ${result.activityName}`
          );
        }
        quickPick.hide();
      } catch (err) {
        const message = `NowDoing start failed: ${formatError(err)}`;
        this.log(message);
        void vscode.window.showErrorMessage(message);
        quickPick.enabled = true;
        quickPick.busy = false;
      }
    });

    quickPick.onDidHide(() => {
      if (debounceHandle) {
        clearTimeout(debounceHandle);
        debounceHandle = undefined;
      }
      quickPick.dispose();
    });

    quickPick.show();
    await updateItems("");
  }

  private async searchActivities(
    query: string,
    limit: number
  ): Promise<ActivitySearchItem[]> {
    const requestPath = buildActivitySearchPath(
      ACTIVITY_SEARCH_ENDPOINT_PATH,
      query,
      limit
    );
    const response = await this.requestNowDoing("GET", requestPath);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(errorMessageFromResponse(response.status, response.body));
    }

    const payload = parseJson<ActivitySearchResponse>(response.body);
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("invalid search response");
    }
    return payload.items;
  }

  private async startActivity(
    body: ActivityStartBody
  ): Promise<ActivityStartResult> {
    const response = await this.requestNowDoing(
      "POST",
      ACTIVITY_START_ENDPOINT_PATH,
      body
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(errorMessageFromResponse(response.status, response.body));
    }

    const payload = parseJson<ActivityStartResponse>(response.body);
    if (!payload || !payload.result) {
      throw new Error("invalid start response");
    }
    return payload.result;
  }

  private async requestNowDoing(
    method: "GET" | "POST",
    requestPath: string,
    body?: unknown
  ): Promise<{ status: number; body: string }> {
    const cap = readCapability();

    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const authHeaders = buildAuthHeaders(method, requestPath, payload, cap.token);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: cap.socketPath,
          path: requestPath,
          method,
          headers: {
            "X-NowDoing-Token": cap.token,
            "X-NowDoing-Timestamp": authHeaders.timestamp,
            "X-NowDoing-Nonce": authHeaders.nonce,
            "X-NowDoing-Signature": authHeaders.signature,
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": payload.byteLength,
                }
              : {}),
          },
          timeout: 4000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("error", reject);
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  private postBranchChange(body: BranchChangeBody): Promise<number> {
    return this.requestNowDoing("POST", BRANCH_ENDPOINT_PATH, body).then(
      (response) => {
        if (response.status >= 200 && response.status < 300) {
          return response.status;
        }
        throw new Error(errorMessageFromResponse(response.status, response.body));
      }
    );
  }

  private shouldIgnoreBranch(branch: string): boolean {
    const pattern = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("watchIgnorePattern", "")
      .trim();

    const result = evaluateWatchIgnorePattern(pattern, branch);
    if (result.invalidPattern && this.invalidWatchIgnorePattern !== pattern) {
      this.invalidWatchIgnorePattern = pattern;
      this.log(
        `Invalid nowdoing.watchIgnorePattern regex: ${pattern}. Ignoring this setting.`
      );
    }
    if (!result.invalidPattern) {
      this.invalidWatchIgnorePattern = undefined;
    }

    return result.isIgnored;
  }

  private validateWatchIgnorePattern(notify: boolean): void {
    const pattern = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("watchIgnorePattern", "")
      .trim();

    if (!pattern) {
      this.invalidWatchIgnorePattern = undefined;
      return;
    }

    const result = evaluateWatchIgnorePattern(pattern, "validation");
    if (!result.invalidPattern) {
      this.invalidWatchIgnorePattern = undefined;
      return;
    }

    if (this.invalidWatchIgnorePattern === pattern) {
      return;
    }
    this.invalidWatchIgnorePattern = pattern;
    this.log(
      `Invalid nowdoing.watchIgnorePattern regex: ${pattern}. Ignoring this setting.`
    );
    if (notify) {
      void vscode.window.showWarningMessage(
        "NowDoing: watchIgnorePattern is not a valid regular expression and will be ignored."
      );
    }
  }

  private enqueueBranchRetry(body: BranchChangeBody, err: unknown): void {
    const existing = this.retryQueue.find(
      (item) => item.repoPath === body.repoPath && item.branch === body.branch
    );
    if (existing) {
      return;
    }

    const queued: QueuedBranchChange = { ...body, attempts: 1 };
    this.retryQueue.push(queued);
    const delay = getRetryDelayMs(queued.attempts);
    this.log(
      `Queued retry in ${delay}ms for ${queued.repo} -> ${queued.branch}: ${formatError(err)}`
    );
    this.scheduleRetryFlush(delay);
  }

  private scheduleRetryFlush(delayMs: number): void {
    if (this.retryHandle) {
      return;
    }
    this.retryHandle = setTimeout(() => {
      this.retryHandle = undefined;
      void this.flushRetryQueue();
    }, delayMs);
  }

  private async flushRetryQueue(): Promise<void> {
    if (this.retryQueue.length === 0) {
      return;
    }

    let nextDelay: number | undefined;
    const pending = this.retryQueue.splice(0, this.retryQueue.length);

    for (const item of pending) {
      try {
        const status = await this.postBranchChange(item);
        this.log(
          `Retried notification succeeded for ${item.repo} -> ${item.branch} (HTTP ${status})`
        );
        this.setStatus("connected");
      } catch (err) {
        const nextAttempt = item.attempts + 1;
        if (isRetryableNotifyError(err) && nextAttempt <= MAX_RETRY_ATTEMPTS) {
          const retryItem: QueuedBranchChange = {
            ...item,
            attempts: nextAttempt,
          };
          this.retryQueue.push(retryItem);
          const delay = getRetryDelayMs(nextAttempt);
          nextDelay = nextDelay === undefined ? delay : Math.min(nextDelay, delay);
          this.log(
            `Retry ${nextAttempt}/${MAX_RETRY_ATTEMPTS} scheduled for ${item.repo} -> ${item.branch} in ${delay}ms: ${formatError(err)}`
          );
        } else {
          this.log(
            `Dropping queued notification for ${item.repo} -> ${item.branch}: ${formatError(err)}`
          );
        }
        this.setStatus("disconnected");
      }
    }

    if (this.retryQueue.length > 0) {
      this.scheduleRetryFlush(nextDelay ?? getRetryDelayMs(2));
    }
  }

  private log(message: string): void {
    this.output.appendLine(message);
  }
}

function readNumber(key: string, fallback: number): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(key, fallback);
  return Number.isFinite(value) ? value : fallback;
}

function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
