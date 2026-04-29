# Contributing to convograph

## Releases

This repo uses **[semantic-release](https://semantic-release.gitbook.io/)**. Every push to `main` triggers a CI run that:

1. Reads commit messages since the last release.
2. Determines the next version using [Conventional Commits](https://www.conventionalcommits.org/).
3. If a release is warranted, builds + publishes to npm, creates a GitHub Release with auto-generated notes, and updates `CHANGELOG.md`.

You don't bump versions manually. Don't edit `package.json` `version` field — semantic-release owns it.

## Commit message format

```
<type>(<optional scope>): <subject>

[optional body]

[optional footer(s)]
```

| Type | Effect |
|---|---|
| `feat:` | minor version bump (new feature) |
| `fix:` | patch version bump (bug fix) |
| `perf:` | patch version bump |
| `refactor:` | patch version bump |
| `docs:` | patch version bump |
| `test:`, `ci:`, `chore:`, `style:` | **no release** |

Breaking changes — append `!` after the type **or** include a `BREAKING CHANGE:` footer. Triggers a major version bump.

### Examples

```
feat(graph): add `onNodeStart` callback to SubgraphCallbacks

fix(extractor): coerce date slot strings to ISO format

docs(readme): clarify HistoryAdapter contract

feat(graph)!: rename `runTurnStream` to `streamTurn`

BREAKING CHANGE: callers must update import paths.
```

## Local development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # ESM + CJS + types via tsup
npm pack --dry-run  # inspect what would be published
```

## CI secrets

The release workflow needs an `NPM_TOKEN` secret in the GitHub repo settings: a granular npm access token with `Read and write` permission on the `convograph` package and "Bypass 2FA when publishing" enabled.
