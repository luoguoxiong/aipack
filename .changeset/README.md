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

若已发布版本需要修正，只能升版本号，不能重新发布同一版本。

> 补充：`@aipack-ai/compression` / `@aipack-ai/memory` / `@aipack-ai/observability` 的 `2.0.0` 作废后，本地 `package.json` 曾误标为 `2.0.0`，该版本实际从未在 npm 上架，现已随 `1.1.5` 统一版本线修正。

## 统一版本线（fixed 分组）

`.changeset/config.json` 已启用 `fixed` 分组：

```json
"fixed": [["@aipack-ai/*"]]
```

含义：`@aipack-ai/*` 下所有包（10 个）永远保持同一个版本号；只要任意一个包有 changeset，整组都会一起升版本。**新增包无需登记**，会自动进入该分组。

其中 `@aipack-ai/docs`（`web-docs`）是私有文档站：它跟着一起升版本号以保持全仓库一致，但 `changeset publish` 会跳过私有包，**不会发布到 npm**。它一般没有自己的 changeset，因此 `web-docs/CHANGELOG.md` 里只会生成形如 `## 1.1.6` 的裸版本标题，没有其他内容。

当前统一版本：`1.1.5`（共 10 个包）。

注意：`fixed` 分组只会向上对齐（`semver.inc(组内最高版本, 组内最高 bump 类型)`），因此组内任何包都无法再单独降到该版本以下。

## 历史版本线

`@aipack-ai/mcp` 与 `@aipack-ai/skills` 的 `2.0.0` 已实际发布到 npm，但不属于当前统一版本线。自 `1.1.5` 起全仓库统一为一条版本线，这两个包的 `2.0.0` 仅作为历史版本保留。
