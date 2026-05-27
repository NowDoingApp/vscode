# AGENTS.md

## Purpose

Repository-wide instructions for coding agents working in this workspace.
This file is intended to be actionable: how to work, what to run, what to
update, and what is required before a change is considered complete.

## Repository Context

- This repository is a VS Code extension for NowDoing.
- Runtime entrypoint: `src/extension.ts`.
- Supporting logic lives in small TypeScript modules under `src/`.
- Automated tests live in `src/test/`.
- Bundled output is written to `dist/`.
- Test build output is written to `out/`.
- CI validates on pushes and pull requests to `main` and `dev`.

## Delivery Standard

- Prefer root-cause fixes over surface patches.
- Keep changes minimal, targeted, and production-ready.
- Maintain a high quality bar for correctness, readability, and consistency with the existing codebase.
- Avoid unrelated refactors unless they are required to complete the task safely.
- Preserve the existing architecture unless there is a concrete defect or maintainability reason to adjust it.

## Working Agreement

- Do the smallest complete change that fully solves the task.
- Update tests together with implementation changes.
- Validate the touched area immediately after the first substantive edit.
- Surface assumptions, blockers, and validation results explicitly.
- Do not stop at code changes; finish with validation.

## Commits And Change Types

- Use Conventional Commit semantics when describing or preparing changes.
- For minor and patch-level updates, default to `feat:` or `fix:` as appropriate.
- Use `feat:` for user-visible behavior or capability additions.
- Use `fix:` for bug fixes, regressions, and behavior corrections.
- Use more specific types only when they materially improve clarity.

## Required Commands

Run the narrowest command that validates the work, then run the repo baseline before closing out any code change.

- Install dependencies: `npm ci`
- Typecheck: `npm run typecheck`
- Test suite: `npm test`
- Production bundle: `npm run bundle`
- Watch bundle during development: `npm run watch`
- Package extension manually: `npm run package`
- Preview generated release output: `npm run release:dry-run`
- Prepare a patch release: `npm run release:patch`
- Prepare a minor release: `npm run release:minor`
- Prepare a major release: `npm run release:major`
- Validate a prepared release: `npm run release:check`
- Print GitHub release notes from the newest changelog entry: `npm run release:notes`

## Tests And Validation

- Tests are mandatory for every code change.
- Add or update the narrowest relevant automated tests with each behavior change or bug fix.
- Do not consider the task complete until the affected tests have been run successfully.
- For code changes in this repository, the default validation baseline is:
	- `npm run typecheck`
	- `npm test`
- Run `npm run bundle` when the change may affect extension packaging, activation, imports, or runtime bundling.
- If a narrower targeted check fails, repair that slice first before widening scope.

## File Update Rules

- Update `CHANGELOG.md` whenever shipped behavior changes, commands change, settings change, or release-visible fixes/features are added.
- Keep documentation aligned with user-facing command names and settings.
- Do not edit generated outputs in `dist/` or `out/` manually unless the task explicitly requires it.

## Version And Push Rule

- Version bumps are release work, not routine implementation work.
- If a task includes a release or version bump, update `package.json` to the intended release version and keep lockfile/package metadata in sync.
- When versioning a release, also update `CHANGELOG.md` in the same change.
- Preferred release preparation path: use `npm run release:patch`, `npm run release:minor`, or `npm run release:major` so version and changelog stay aligned.
- Do not manually create or push a release tag unless explicitly asked.
- The repository release workflow reads the version from `package.json`, requires that `v<version>` does not already exist, builds/tests/packages from `main`, and only then pushes the tag.
- The repository release workflow also reads the newest `CHANGELOG.md` section and publishes it as the GitHub release notes.
- Practical rule: code changes can be pushed normally; version changes should only be pushed when the branch is ready for release, because the release workflow uses the committed `package.json` version as the source of truth.
- If uncertain whether a change should bump the version, leave the version untouched and call it out explicitly.

## Release Notes

- Release workflow file: `.github/workflows/release.yml`.
- CI workflow file: `.github/workflows/ci.yml`.
- Release automation runs only from `main`.
- The release workflow performs: `npm ci`, `npm run typecheck`, `npm test`, `npm run bundle`, VSIX packaging, tag push, and GitHub Release creation.
- Use the workflow's dry-run mode for packaging verification without tag/release creation when appropriate.

## Skills And Reuse

- Create a reusable skill when a workflow is repeated, multi-step, or benefits from explicit packaged guidance.
- Keep one-off task instructions in the local change rather than creating unnecessary skills.
- A new skill should include clear trigger phrases, a narrow scope, and concrete steps or assets that save time on future tasks.
- Do not create a skill just to restate what already belongs in this AGENTS.md.

## Response Expectations

- Report what changed, how it was validated, and any remaining risk.
- If tests or commands could not be run, say so plainly.
- If repo state suggests a follow-up outside the requested change, mention it without expanding scope automatically.