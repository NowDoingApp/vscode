import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  RepoWatcher,
  type WatchedDisposable,
  type WatchedRepository,
} from "../repoWatcher";

interface FakeRepoControls {
  repo: WatchedRepository;
  setBranch(name: string | undefined): void;
  emitStateChange(): void;
  listenerCount(): number;
}

function makeFakeRepo(initialBranch: string | undefined): FakeRepoControls {
  let head: { name?: string } | undefined =
    initialBranch === undefined ? undefined : { name: initialBranch };
  const listeners = new Set<() => void>();

  const repo: WatchedRepository = {
    state: {
      get HEAD() {
        return head;
      },
      onDidChange(listener: () => void): WatchedDisposable {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
  };

  return {
    repo,
    setBranch(name) {
      head = name === undefined ? undefined : { name };
    },
    emitStateChange() {
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
}

interface CapturedChange {
  branch: string;
  previousBranch: string | undefined;
}

function makeWatcher(
  initial: string | undefined,
  debounceMs = 50
): {
  control: FakeRepoControls;
  watcher: RepoWatcher;
  changes: CapturedChange[];
} {
  const control = makeFakeRepo(initial);
  const changes: CapturedChange[] = [];
  const watcher = new RepoWatcher(
    control.repo,
    (branch, previousBranch) => changes.push({ branch, previousBranch }),
    () => debounceMs
  );
  return { control, watcher, changes };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the initial branch is captured but not announced", async () => {
  const { watcher, changes } = makeWatcher("main", 10);
  // No state change emitted yet — nothing should fire even after the debounce window.
  await wait(30);
  assert.deepEqual(changes, []);
  watcher.dispose();
});

test("a branch change fires after the debounce window with previous branch", async () => {
  const { control, watcher, changes } = makeWatcher("main", 20);

  control.setBranch("feature/x");
  control.emitStateChange();
  assert.deepEqual(changes, [], "must not fire synchronously");

  await wait(50);
  assert.deepEqual(changes, [{ branch: "feature/x", previousBranch: "main" }]);
  watcher.dispose();
});

test("a state change that does not move HEAD is ignored", async () => {
  const { control, watcher, changes } = makeWatcher("main", 20);

  // Repository emits onDidChange for many reasons (index updates, etc.) —
  // we must only notify when the branch name actually changes.
  control.emitStateChange();
  control.emitStateChange();
  await wait(40);
  assert.deepEqual(changes, []);
  watcher.dispose();
});

test("rapid successive changes are coalesced — only the final branch is announced", async () => {
  const { control, watcher, changes } = makeWatcher("main", 40);

  control.setBranch("a");
  control.emitStateChange();
  await wait(10);
  control.setBranch("b");
  control.emitStateChange();
  await wait(10);
  control.setBranch("c");
  control.emitStateChange();

  await wait(70);
  assert.equal(changes.length, 1, "debounce must coalesce to a single fire");
  assert.equal(changes[0].branch, "c");
  // The previous branch is whatever was active just before the LAST change —
  // in this rapid-switch sequence that is "b".
  assert.equal(changes[0].previousBranch, "b");
  watcher.dispose();
});

test("detached HEAD (HEAD?.name = undefined) is recorded but not announced", async () => {
  const { control, watcher, changes } = makeWatcher("main", 20);

  control.setBranch(undefined);
  control.emitStateChange();
  await wait(40);
  assert.deepEqual(changes, [], "detached HEAD must not trigger a notification");

  // Returning to a real branch from detached state should announce, with the
  // previous branch field being undefined (since detached was the last state).
  control.setBranch("main");
  control.emitStateChange();
  await wait(40);
  assert.deepEqual(changes, [{ branch: "main", previousBranch: undefined }]);
  watcher.dispose();
});

test("dispose unsubscribes from the repository and cancels a pending debounce", async () => {
  const { control, watcher, changes } = makeWatcher("main", 30);

  control.setBranch("feature/x");
  control.emitStateChange();
  assert.equal(control.listenerCount(), 1);

  watcher.dispose();
  assert.equal(
    control.listenerCount(),
    0,
    "dispose must remove the onDidChange listener"
  );

  await wait(60);
  assert.deepEqual(changes, [], "pending debounce must not fire after dispose");
});

test("debounce duration is re-read on every change (config can be live-updated)", async () => {
  const control = makeFakeRepo("main");
  const changes: CapturedChange[] = [];
  let currentDebounce = 100;
  const watcher = new RepoWatcher(
    control.repo,
    (branch: string, previousBranch: string | undefined) => {
      changes.push({ branch, previousBranch });
    },
    () => currentDebounce
  );

  // First change uses long debounce — should still be pending after 30ms.
  control.setBranch("a");
  control.emitStateChange();
  await wait(30);
  assert.equal(changes.length, 0);

  // Shorten debounce; the next change should use the new value (the old timer
  // is cleared, the new one is the active one).
  currentDebounce = 20;
  control.setBranch("b");
  control.emitStateChange();
  await wait(50);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].branch, "b");
  watcher.dispose();
});
