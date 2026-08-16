# Changesets

Hi! This file is used by `@changesets/cli` to record changes to packages in this
monorepo. When you make a change that should be released, run:

```bash
pnpm changeset
```

This will prompt you to:

1. Select the package(s) affected by your change
2. Choose the semver bump type (major / minor / patch)
3. Write a short changelog message

The resulting changeset file is committed alongside your code. When a
"Version Packages" PR is merged, the changesets are consumed to bump versions,
update CHANGELOG.md files, and publish to npm automatically via GitHub Actions.

See https://github.com/changesets/changesets for full docs.
