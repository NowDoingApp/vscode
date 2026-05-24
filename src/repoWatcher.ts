export interface WatchedDisposable {
  dispose(): void;
}

export interface WatchedRepository {
  readonly state: {
    readonly HEAD?: { readonly name?: string };
    onDidChange(listener: () => void): WatchedDisposable;
  };
}

export type BranchChangeListener = (
  branch: string,
  previousBranch: string | undefined
) => void;

export class RepoWatcher {
  private lastBranch: string | undefined;
  private debounceHandle: ReturnType<typeof setTimeout> | undefined;
  private readonly disposable: WatchedDisposable;

  constructor(
    private readonly repo: WatchedRepository,
    private readonly onChange: BranchChangeListener,
    private readonly getDebounceMs: () => number
  ) {
    this.lastBranch = repo.state.HEAD?.name;
    this.disposable = repo.state.onDidChange(() => this.onStateChange());
  }

  dispose(): void {
    this.disposable.dispose();
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = undefined;
    }
  }

  private onStateChange(): void {
    const next = this.repo.state.HEAD?.name;
    if (next === this.lastBranch) {
      return;
    }
    const previous = this.lastBranch;
    this.lastBranch = next;
    if (!next) {
      return;
    }

    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = undefined;
      this.onChange(next, previous);
    }, this.getDebounceMs());
  }
}
