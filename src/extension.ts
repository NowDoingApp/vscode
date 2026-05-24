import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { buildAuthHeaders } from "./auth";
import type { API, GitExtension, Repository } from "./git";
import { RepoWatcher } from "./repoWatcher";
import {
  buildActivitySearchPath,
  errorMessageFromResponse,
  formatError,
  parseJson,
} from "./util";

const CONFIG_SECTION = "nowdoing";
const LOOPBACK_HOST = "127.0.0.1";
const SECRET_API_TOKEN_KEY = "nowdoing.apiToken";
const TOKEN_CONFIGURED_STATE_KEY = "nowdoing.tokenConfigured";
const BRANCH_ENDPOINT_PATH = "/branch-changed";
const HEALTHCHECK_ENDPOINT_PATH = "/healthcheck";
const ACTIVITY_SEARCH_ENDPOINT_PATH = "/activities/search";
const ACTIVITY_START_ENDPOINT_PATH = "/activities/start";

type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "checking"
  | "needs-token";

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

interface ActivityStartBody {
  activityID?: string;
  name?: string;
  createIfMissing?: boolean;
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
  private readonly watchedRepos = new Map<string, RepoWatcher>();
  private currentStatus: ConnectionStatus = "checking";

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

    this.registerCommands();
    this.attachGitApi();
    void this.bootstrap();
  }

  dispose(): void {
    for (const watcher of this.watchedRepos.values()) watcher.dispose();
    this.watchedRepos.clear();
    this.statusBarItem.dispose();
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
      vscode.commands.registerCommand("nowdoing.setToken", () =>
        this.promptAndStoreToken()
      ),
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
      )
    );
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
    const everConfigured = this.context.globalState.get<boolean>(
      TOKEN_CONFIGURED_STATE_KEY,
      false
    );
    await this.checkConnection({ notify: everConfigured });
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
    const token = await this.readStoredToken();
    if (!token) {
      this.setStatus("needs-token");
      if (options.notify) {
        void vscode.window
          .showWarningMessage(
            "NowDoing: Token not configured.",
            "Set Token",
            "Open Settings"
          )
          .then((choice) => {
            if (choice === "Set Token") {
              void vscode.commands.executeCommand("nowdoing.setToken");
            } else if (choice === "Open Settings") {
              void vscode.commands.executeCommand("nowdoing.openSettings");
            }
          });
      }
      return;
    }
    try {
      await this.pingHealthcheck(token);
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
            "Open Settings"
          )
          .then((choice) => {
            if (choice === "Retry") {
              void vscode.commands.executeCommand("nowdoing.reconnect");
            } else if (choice === "Open Settings") {
              void vscode.commands.executeCommand("nowdoing.openSettings");
            }
          });
      } else {
        this.log(`Connection check failed: ${formatError(err)}`);
      }
    }
  }

  private async pingHealthcheck(token?: string): Promise<number> {
    const response = await this.requestNowDoing(
      "GET",
      HEALTHCHECK_ENDPOINT_PATH,
      undefined,
      token
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
        this.statusBarItem.tooltip = "NowDoing: Connected";
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Connected",
          role: "button",
        };
        break;
      case "disconnected":
        this.statusBarItem.text = "$(warning) NowDoing";
        this.statusBarItem.tooltip = "NowDoing: Disconnected, click to retry";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Disconnected, click to retry",
          role: "button",
        };
        break;
      case "checking":
        this.statusBarItem.text = "$(sync~spin) NowDoing";
        this.statusBarItem.tooltip = "NowDoing: Checking connection...";
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Checking connection",
          role: "button",
        };
        break;
      case "needs-token":
        this.statusBarItem.text = "$(warning) NowDoing";
        this.statusBarItem.tooltip =
          "NowDoing: Token not configured, click to set up";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.accessibilityInformation = {
          label: "NowDoing: Token not configured, click to set up",
          role: "button",
        };
        break;
    }

    if (previous === "connected" && state === "disconnected") {
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
    switch (this.currentStatus) {
      case "needs-token":
        await vscode.commands.executeCommand("nowdoing.setToken");
        return;
      case "connected":
        try {
          await this.pingHealthcheck();
          this.setStatus("connected");
        } catch (err) {
          this.log(`Status bar re-ping failed: ${formatError(err)}`);
          this.setStatus("disconnected");
        }
        return;
      case "checking":
      case "disconnected":
        await vscode.commands.executeCommand("nowdoing.reconnect");
        return;
    }
  }

  private async runStartActivityCommand(): Promise<void> {
    const token = await this.readStoredToken();
    if (!token) {
      void vscode.window
        .showWarningMessage("NowDoing: Token not configured.", "Set Token")
        .then((choice) => {
          if (choice === "Set Token") {
            void vscode.commands.executeCommand("nowdoing.setToken");
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
        const items = await this.searchActivities(query, 20, token);
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
          const result = await this.startActivity(
            { activityID: selected.activityID },
            token
          );
          void vscode.window.showInformationMessage(
            result.created
              ? `NowDoing: Activity created and started: ${result.activityName}`
              : `NowDoing: Activity started: ${result.activityName}`
          );
        } else if (selected.itemType === "create" && selected.createName) {
          const result = await this.startActivity(
            { name: selected.createName, createIfMissing: true },
            token
          );
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
        void vscode.window
          .showErrorMessage(message, "Open Settings")
          .then((choice) => {
            if (choice === "Open Settings") {
              void vscode.commands.executeCommand("nowdoing.openSettings");
            }
          });
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
    limit: number,
    token: string
  ): Promise<ActivitySearchItem[]> {
    const requestPath = buildActivitySearchPath(
      ACTIVITY_SEARCH_ENDPOINT_PATH,
      query,
      limit
    );
    const response = await this.requestNowDoing(
      "GET",
      requestPath,
      undefined,
      token
    );
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
    body: ActivityStartBody,
    token: string
  ): Promise<ActivityStartResult> {
    const response = await this.requestNowDoing(
      "POST",
      ACTIVITY_START_ENDPOINT_PATH,
      body,
      token
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
    body?: unknown,
    tokenOverride?: string
  ): Promise<{ status: number; body: string }> {
    const port = readNumber("port", 39847);
    const token = tokenOverride ?? (await this.readStoredToken());
    if (!token) {
      throw new Error(
        "NowDoing token is missing. Use the 'NowDoing: Set Token' command."
      );
    }

    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const authHeaders = buildAuthHeaders(method, requestPath, payload, token);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: LOOPBACK_HOST,
          port,
          path: requestPath,
          method,
          headers: {
            "X-NowDoing-Token": token,
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

  private async readStoredToken(): Promise<string> {
    const token =
      (await this.context.secrets.get(SECRET_API_TOKEN_KEY)) ?? "";
    return token.trim();
  }

  private async storeToken(token: string): Promise<void> {
    await this.context.secrets.store(SECRET_API_TOKEN_KEY, token);
    await this.context.globalState.update(TOKEN_CONFIGURED_STATE_KEY, true);
  }

  private async promptAndStoreToken(): Promise<void> {
    const existing = await this.readStoredToken();
    const entered = await vscode.window.showInputBox({
      title: "NowDoing Token",
      prompt: "Paste the token from NowDoing settings",
      value: existing,
      password: true,
      ignoreFocusOut: true,
    });

    if (entered === undefined) {
      return;
    }

    const token = entered.trim();
    if (!token) {
      void vscode.window.showWarningMessage(
        "NowDoing: Empty token was not saved."
      );
      return;
    }

    await this.storeToken(token);
    this.setStatus("checking");
    await this.checkConnection({ notify: true });
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
