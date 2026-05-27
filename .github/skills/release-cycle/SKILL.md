---
name: release-cycle
description: "Prepare and validate a NowDoing VS Code extension release. Use when the task involves version bumps, changelog generation, release notes, GitHub releases, or packaging a new VSIX. Trigger phrases: release, cut a release, bump version, generate changelog, publish release notes, prepare patch release, prepare minor release."
---

# Release Cycle

Use this workflow for repository releases.

## Commands

```sh
npm run release:dry-run
npm run release:patch
npm run release:minor
npm run release:major
npm run release:check
npm run release:notes
```

## Workflow

1. Preview the generated release with `npm run release:dry-run`.
2. Prepare the intended bump with `npm run release:patch`, `npm run release:minor`, or `npm run release:major`.
3. Review changes in `package.json`, `package-lock.json`, and `CHANGELOG.md`.
4. Run `npm run release:check`.
5. Commit the release preparation once the branch is truly ready to ship.
6. Run the GitHub release workflow from `main`.

## Notes

- Changelog entries are generated from Conventional Commits.
- GitHub release notes are sourced from the newest `CHANGELOG.md` section.
- Tag creation is handled by `.github/workflows/release.yml`, not by the local prepare command.