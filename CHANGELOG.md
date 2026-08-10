# Changelog

所有显著变更均记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### agentpack（核心框架）

#### 新增
- **SessionManager 多会话门面**：`createSessionManager()` 让多个会话共享同一 Runtime（模型/工具/扩展跨会话复用），按 sessionKey 提供 run/stream/getMessages/abort/isBusy 等按会话粒度操作；底层由 Runtime 内建 `request.sessionKey` 多会话路由实现，同会话消息历史隔离 + 串行队列独立，`maxSessions` 超限 LRU 淘汰
- **框架级权限层 PermissionPolicy**：`Tool.permissions` 能力声明 + `RuntimeOptions.permissionPolicy` 裁决（deny-by-default + confirm 钩子），内置 `createPermissionPolicy` / `createAllowListPolicy` / `createDenyAllPolicy` / `hasPermission`；deny 产出 `details.blocked` 结果不中断 run；新增 `onPermissionDenied` 遥测事件
- **存储级锁**：`SessionStorage.withLock/acquireLock`，文件实现基于 O_EXCL 锁文件 + 陈旧锁回收 + 指数退避 jitter，多进程对同一会话读写互斥；Runtime 的 run/stream/deleteSession 默认启用

#### 变更
- **凭证链全线统一**：`Models` 注入的 `credentials` 真实生效（dispatchStream 透传），`getAuth()` 与 `resolveApiKey` 遵循同一优先级（注入 store → env → 自定义 auth 解析器）；移除死代码 `InMemoryCredentialStore`，默认 `EnvCredentialStore`
- **env 变量名统一为约定名**：google 由 `GEMINI_API_KEY` 改为 `GOOGLE_API_KEY`（**破坏性变更**），与 `getEnvApiKey`/`hasProviderConfigured` 探测一致，修复"探测有 key 实际解析失败"的不一致

### agentpack-coding
- **run_command 无 shell 执行**：`parseCommandToArgv` 解析 argv + `spawn(file, args, { shell: false })`，多语句（`;`/`&&`/`||`/换行）/管道/重定向/命令替换/未引用通配符一律拒绝并提示替代工具；前导 `NAME=value` 收集为子进程 env
- **工具声明权限能力**：read_file/write_file/edit_file/list_directory/grep/glob 声明 `fs:read`/`fs:write`，run_command 声明 `shell:exec`，可被框架级 PermissionPolicy 统一裁决

### 测试
- 新增 SessionManager 多会话测试、存储级锁多进程互斥测试、PermissionPolicy 单测 + Runtime 集成（deny/allowList/confirm/流式/telemetry）、parseCommandToArgv 与无 shell 执行用例（引号/env 前缀/多语句/管道/通配符/重定向）、symlink 沙箱逃逸用例、Models credentials 注入 + getAuth + google envVar 回归

## [0.1.0] - 2026-08-10

### agentpack（核心框架）

#### 修复
- **HTTP 429/5xx 重试从未生效**：`retry` 支持 `err.status` / `Response` 对象分类，catch 分支消费响应体，避免连接泄漏与 `[object ReadableStream]` 错误消息
- **`setThinkingLevel()` 配置无效**：adapter 透传 `merged.reasoning`（不再写死 `reasoningEffort`）
- **OpenAI 路径 `usage.total` 恒为 0**：`buildUsage` 补齐 `total`，token 统计/成本/持久化恢复正确
- **无费率模型崩溃**：`calculateCost` 对未配置 `cost` 的模型空保护
- **压缩深度跨 turn 累积**：`compressionDepth` 每次 run 重置，L2 不再因深度累积永久失效
- **L4 检查点丢失资源语义**：checkpoint 持久化 `fullResources` 快照，`pinned/meta/type` 恢复不丢
- **`telemetryHistory` 无限增长**：截断保留最近 100 条

#### 新增
- **统一错误体系**：`AgentError`（retryable/timeout/auth/context-overflow/rate-limit）+ `classifyError`/`formatCategoryError`/`formatHttpError`，stream 层错误消息带 `[auth]`/`[timeout]` 等前缀
- **凭证统一管理**：`resolveApiKey` 收敛为单一实现 + `CredentialStore`（默认 env，可注入 KMS），删除 5 处重复实现
- **流式健壮性**：`try/finally` 释放 reader、idle 超时（默认 60s）、总超时 `timeoutMs`、SSE `\r\n` 终止符、Anthropic 工具参数接入 partial-json
- **可观测性**：`Telemetry` 接口（onRunEnd/onToolCall/onModelCall）+ `noopTelemetry`，runtime 三处插桩
- **发布工程化**：`sideEffects: false`、`engines >= 18.19`、CI 工作流、各包 MIT LICENSE、CHANGELOG

### agentpack-coding
- 命令执行禁用 shell 串联绕过（`splitCommandStatements`/`hasShellMeta` 校验 + 参数数组 spawn）
- 进程组 kill 防孙子进程拖住 close
- `resolveWithin` 使用 `realpath` 解析 symlink，封堵沙箱逃逸

### agentpack-compression
- fork 重试按 HTTP status 精细化判断（4xx 不重试、429/5xx 重试）
- `compressionDepth` 单次 pipeline 计数、`telemetryHistory` 上限、checkpoint 完整资源快照

### agentpack-memory
- consolidator 先存后删（原子性），delete 失败仅留重复不丢记忆
- BM25 分数按 Σidf 归一化到 [0,1]，与 0.85 阈值量纲统一（合并可真正触发）

### agentpack-cli
- 配置文件优先级与注释一致（项目级优先于全局）

### 测试
- 新增 stream/adapter mock-fetch 流式测试（UTF-8 跨 chunk、abort、idle/总超时、429/5xx、usage 尾块）
- 新增 errors/credentials/telemetry 单测；coding 安全用例（串联/symlink）；cli 配置优先级测试

[Unreleased]: https://github.com/agentpack/agentpack/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agentpack/agentpack/releases/tag/v0.1.0
