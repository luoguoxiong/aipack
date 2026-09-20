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

## ⚠️ 已被 npm 永久占用的版本号

npm 规定：**已发布过的版本号即使被 unpublish，也不能再次发布**（会报 `E400 Cannot publish over previously published version`）。

以下版本号曾发布后被 unpublish，已永久作废，**不要再使用**：

| 包 | 作废版本 |
| --- | --- |
| `@aipack-ai/compression` / `@aipack-ai/memory` / `@aipack-ai/observability` | `1.0.0`、`1.0.1`、`2.0.0` |
| `@aipack-ai/agent` / `@aipack-ai/cli` / `@aipack-ai/observability-server` | `0.2.0`、`0.2.1`、`0.3.0` |

因此本次 1.0.0 发布统一改用 `1.0.2`（全仓库对齐）。若已发布版本需要修正，只能升版本号，不能重新发布同一版本。
