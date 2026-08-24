# observability-server 代码审查报告

> 审查日期:2026-08-24
> 审查范围:`packages/observability-server/src` 全部模块(stores / mq / worker / aggregator / api / auth / alerts / archive / 入口文件)
> 审查方式:静态代码审查 + 依赖行为验证(kafkajs 2.2.4 源码验证)

## 总体评价

架构设计(分层 Store / MQ 解耦 / 双写迁移 / RBAC)合理,基础功扎实:密码 scrypt(N=2^15)+ 恒时比较、SQLite/MySQL 全参数化查询、Lua 原子限流、producer 默认 acks=-1。

但存在三类硬伤:

1. **多用户模式下查询端点越权(IDOR)**——任意注册用户可读全平台数据;
2. **Kafka/聚合/归档链路多处丢数据或算错数据**——"可靠性"承诺不成立;
3. **两个上线即坏的功能 Bug**(MySQL 迁移必失败、错误下钻接口必 500)。

部分代码路径(Redis/Hybrid 聚合、ClickHouse 查询)明显缺少真实环境验证。

**问题统计**:高 15 项 / 中 20+ 项 / 低 15+ 项。

---

## 一、高危:安全漏洞

### S1. 查询端点水平越权(IDOR)——最严重

- **位置**:`src/middleware/auth.ts` L56-98、`src/server.ts` L49
- **问题**:`/metrics/*`、`/traces*` 只校验可选的 `projectId` 参数本身的 ACL,对 `appId` 无项目归属校验:
  - 注册端点完全开放,任意新用户 `GET /traces`(不带 appId)→ appId 缺省不过滤 → 返回**全平台所有项目**的 trace 列表与明细;
  - A 项目 viewer 可传 B 项目任意 `appId` 查询数据;
  - `/traces/:traceId` 完全无归属校验。
- **修复**:鉴权层根据用户 ACL 解析可访问 appId 集合,与请求 appId 求交,不在集合内返回 403;多用户模式下"全局聚合"应收敛为"用户全部项目聚合";trace 详情返回前校验归属。

### S2. appSecret 泄露链

- **位置**:`src/admin.ts` L263-269、`src/api/projects.ts` L308-326
- **问题**:
  - 未关联项目的 app 对 viewer 直接放行读 secret(OBS_APPS 种子应用全中招,appId 可从无鉴权的 `/metrics/prometheus` 枚举);
  - `linkApp` 不校验 app 归属,可把他人 app 关联进自己项目再读 secret → 可伪造上报污染数据/成本/告警。
- **修复**:未关联项目的 app 一律拒绝 secret 读取;link/unlink 校验目标 app 现有归属;secret 读取提升为 owner-only 或脱敏展示。

### S3. 告警 webhook SSRF

- **位置**:`src/alerts/rules.ts` L146-147、`src/alerts/notify.ts` L74-109
- **问题**:`webhookUrl` 用户可控,无私网/环回地址黑名单,可探测内网(`169.254.169.254`、本机 ClickHouse 8123 等);test 端点构成状态码 oracle。
- **修复**:仅允许 http/https;DNS 解析后拒绝环回/私网/链路本地/元数据地址;提供域名 allowlist 配置。

### S4. 单用户 token 在多用户模式下被放行(认证混淆后门)

- **位置**:`src/auth/jwt.ts` L244-247、`src/middleware/auth.ts` L74-77
- **问题**:multi 模式 jwtSecret 复用 `SESSION_SECRET` 时,single 模式旧 token(无 type 字段)可通过校验并被放行为 owner 等价权限。
- **修复**:multi 模式拒绝无 `type` 字段的 token;文档明确 multi 部署必须使用独立 `JWT_SECRET`。

### S5. S3 凭证明文入 SQL

- **位置**:`src/archive/parquet-writer.ts` L80-87
- **问题**:accessKey/secretKey 拼进 `INSERT INTO FUNCTION s3(...)`,CH 默认开启的 `query_log` 会记录明文。
- **修复**:改用 CH named collection 或服务端 s3 配置,凭证由 DBA 在 CH 侧管理。

### 中危安全项

| # | 问题 | 位置 |
|---|------|------|
| S6 | 告警规则/事件端点无角色校验、无项目隔离,任何登录用户可 CRUD 全局规则、读全局事件 | admin.ts L118-139 |
| S7 | 模型价格端点(POST/DELETE /metrics/model-prices)任何登录用户可篡改全平台成本核算 | server.ts L313-365 |
| S8 | refresh token 无撤销机制:logout 不失效、轮换不作废旧 token、无重放检测,泄露可无限续期 | auth/jwt.ts L176-194、api/auth.ts L50-53 |
| S9 | 项目删除不级联清理 ACL/agent_definitions(残留 ACL 使已删项目下的 Agent 定义永久可读写);token pid 匹配时 role 不重查 ACL | project-store.ts L107-110、middleware/auth.ts L79 |
| S10 | `/metrics/prometheus` 无鉴权,匿名可枚举全部 app_id 与指标 | prometheus.ts、collector.ts L447-451 |

### 低危安全项

- CSRF:cookie 鉴权下无 CSRF token/Origin 校验,依赖默认 SameSite=Lax 缓解;`JWT_COOKIE_SAMESITE=none` 配置下可利用。建议加 Origin 校验或双提交 token。
- 用户枚举:注册 409 显式回显"该邮箱已注册";登录路径用户存在与否存在 scrypt 时序差异(不存在时应执行哑 scrypt)。
- JWT secret 由 ADMIN_PASS 派生(config.ts):弱密码可离线暴力推导,生产应强制显式 JWT_SECRET。
- `app_secret` 明文存储(密码已正确用 scrypt,API 凭证却明文);建议改 SHA-256 存储 + 哈希比对。

---

## 二、高危:数据丢失 / 算错

### D1. Kafka consumer 丢数据

- **位置**:`src/mq/kafka-consumer.ts` L85-137
- **问题**:消息处理**前**就 `resolveOffset`(kafkajs commit 提交的是全部已 resolve 的最大 offset);定时器 `void this.flushBuffer()` 吞错(flush 失败 rethrow 后无人捕获 → unhandled rejection,Node 15+ 默认进程崩溃);失败消息的 offset 仍被提交 → 永久丢失。`eachBatchAutoResolve` 未显式关闭(默认 true)与手动 resolve 意图冲突。
- **修复**:handler 成功后才 resolve 本批最后一条;定时器回调显式 `.catch()`;flush 失败不丢弃消息;显式 `eachBatchAutoResolve: false`。

### D2. producer 懒连接失败后永不恢复

- **位置**:`src/mq/kafka-producer.ts` L70-78
- **问题**:`connectPromise` 缓存 rejected promise,Kafka 短暂不可用后该实例直到重启都发不出消息。
- **修复**:连接失败时清空缓存的 promise,允许重试。

### D3. DLQ 发送失败即消息蒸发

- **位置**:`src/worker/ingest-worker.ts` L250-264、L348-360
- **问题**:DLQ produce 失败仅打日志,offset 照常提交 → 消息既未落库也未进 DLQ。DLQ 自身无重试/本地暂存。
- **修复**:DLQ 失败重试(退避);仍失败本地落盘 outbox 待恢复重发。

### D4. 归档失败窗口漏档 + 误删未归档数据

- **位置**:`src/archive/scheduler.ts` L57-83、L121-140
- **问题**:窗口按运行时 `now` 动态滑动,某次失败后该窗口永远不被覆盖;`deleteAfterArchive=true` 时删除范围(`< toMs` 全部)大于归档范围,会把**从未导出的数据物理删除**(ALTER TABLE DELETE 不可逆)。
- **修复**:持久化"已归档进度水位",失败次日重试同一窗口;删除条件与本次成功导出窗口精确对齐并校验行数;改按分区 DROP PARTITION。

### D5. Hybrid 聚合 L1/L2 双计,最近 1 分钟指标翻倍

- **位置**:`src/aggregator/hybrid-aggregator.ts` L63-190
- **问题**:同一条数据同时写 L1(1min)与 L2(60min,含最近 1min),读取时计数器**相加** → requests/tokens/cost 翻倍;timeseries 的 successRate 合并用简单平均而非加权。文档却称 hybrid 是"推荐"后端。
- **修复**:L2 查询窗口排除最近 1min,或改为 L1 桥接模式(L2 不直写);successRate 按 requests 加权。

### D6. Redis 聚合分位数全 NaN

- **位置**:`src/aggregator/redis-aggregator.ts` L413-416
- **问题**:`zrangebyscore` 未带 `WITHSCORES`,返回 member 而非 score,`Number(member)` 全 NaN → redis/hybrid 后端 p50/p95/p99 全是 NaN。
- **修复**:`zrangebyscore(key, 0, '+inf', 'WITHSCORES')`,解析取偶数下标。

### D7. Redis 内存无限增长

- **位置**:`src/aggregator/redis-aggregator.ts` L246-259(histKey)、L130(tracever)
- **问题**:直方图 ZSET 无 EXPIRE、`maxHistogramSamples` 声明后从未实现;tracever Hash 每 trace 一个 field 永不清理,百万级 trace 后单 key 数百 MB。
- **修复**:histKey 加 `pexpire(2×window)`;实现采样上限;tracever 加 TTL 或拆 per-bucket key。

### D8. 非 MQ 模式落盘 fire-and-forget

- **位置**:`src/collector.ts` L582-584
- **问题**:默认部署下 ingest 落盘 `flush().catch(console.error)`,失败无重试、无计数,整批丢失。
- **修复**:失败计数打点;返回 5xx 让客户端补报(HttpReporter 已有 429 缓存补报机制可复用)。

### 其他数据可靠性中危项

| # | 问题 | 位置 |
|---|------|------|
| D9 | CH flush 五表并行 INSERT 部分失败后整批重试 → 已成功表重复插入(普通 MergeTree 无去重),指标重复计算 | clickhouse-store.ts L99-145 |
| D10 | 双写 secondary 失败被静默吞掉,无告警无对账,主从静默漂移 | dual-trace-store.ts L149-158 |
| D11 | worker shutdown 遗漏 `aggHandle.close()`,Redis 在途写入丢失、连接未释放 | ingest-worker.ts L377-387 |
| D12 | producer 未启用幂等(`idempotent: true`),重试产生重复消息 | kafka-producer.ts L61-64 |
| D13 | worker 重试退避上限过低(100/200/400ms),CH 短暂不可用即推 DLQ;且无 DLQ 回放工具 | ingest-worker.ts L304-319 |
| D14 | `commitOffsetsIfNecessary` 受 5s 间隔限制,"手动提交"实为延迟提交(扩大 D1 丢数据窗口) | kafka-consumer.ts L127-130 |

---

## 三、高危:上线即坏的功能 Bug

### F1. 错误归因下钻接口必 500

- **位置**:`src/store.ts` L895-952(辅助 L1171-1208)
- **问题**:SQLite 版 `queryErrorClassDrill` 第 2、3 段查询的 SQL 组装是坏的:`replace` 链全部落空或错位(无过滤时 `WHERE 1=1` → `WHERE r.1=1` 语法错误;有过滤时列无前缀 → ambiguous column),参数数量必然不匹配(`Too many parameter values`)。**任何 filter 组合都 500**,该接口在默认部署下完全不可用。L1201 注释"better-sqlite3 无法在 JOIN 里用参数化两次"是错误认知。
- **修复**:删除 replace 链与 `buildErrorWhereForJoin`,统一生成带 `r.` 前缀的条件数组,全部用 `?` 占位符传参(与 `queryRuns` 写法对齐)。

### F2. MySQL 迁移必失败

- **位置**:`src/stores/migrations/v1-initial-schema.ts` L12-92
- **问题**:v1 迁移 SQL 8 条 CREATE TABLE 之间**没有任何分号**,`split(';')` 得到 1 条巨型语句,mysql2 prepared 协议不支持 multi-statement → `BUSINESS_STORE=mysql` 且 autoMigrate 时**启动即崩**。
- **修复**:每条语句补 `;`;建议改用更稳健的语句切分方式。

### F3. ClickHouse 时间戳解析缺陷

- **位置**:`src/stores/clickhouse-store.ts` L567-590、L738-748
- **问题**:CH DateTime64 输出为字符串,`Number(...)` → NaN(列表页时间全坏);`chDateTimeTs` 的 `Date.parse` 按**本地时区**解析 UTC 字符串,东八区整体 +8 小时。
- **修复**:统一走带 `'Z'` 后缀的 UTC 解析,或 SQL 里直接 `toUnixTimestamp64Milli()` 输出毫秒。

### F4. CH 跨热冷边界查询全量拉表 OOM

- **位置**:`src/stores/clickhouse-store.ts` L149-190
- **问题**:查询窗口跨 90 天归档边界时对两表各执行**无 LIMIT 全量查询**(每行还带重试子查询),拉回 Node 侧排序分页。与"亿级 Trace 检索"的设计目标相悖。
- **修复**:`UNION ALL + ORDER BY + LIMIT/OFFSET` 下推到 CH 单条 SQL 分页。

### 其他功能中危项

| # | 问题 | 位置 |
|---|------|------|
| F5 | `queryTrace` 只查热表,冷归档 trace 详情 404(列表可见但详情不可见) | clickhouse-store.ts L218-247 |
| F6 | SQLite 外键从未启用(`PRAGMA foreign_keys` 未开),deleteProject 留孤儿数据,与 MySQL CASCADE 行为不一致 | project-store.ts、store.ts |
| F7 | dual 模式打开的裸 SQLite 连接从未使用也从未关闭(句柄泄漏) | stores/index.ts L219-223 |
| F8 | agent-definition `rollback` 不校验目标版本存在性,失败后 Agent 陷入"无 published 版本"状态 | agent-definition-store.ts L237-263 |
| F9 | CH `queryVersionMetrics` 在 GROUP BY 里用非分组列做相关子查询,真实 CH 上大概率报错 | clickhouse-store.ts L257-280 |
| F10 | healthz 检查的是内部 SQLite 而非实际注入的 traceStore(MySQL/CH 挂了探针照样绿) | collector.ts L454-461 |

---

## 四、性能优化建议

| # | 问题 | 建议 |
|---|------|------|
| P1 | 热路径鉴权无缓存:每次 ingest 都 `verifyApp` 查库 + `touchApp` 写库,MySQL 模式每请求 2 次网络往返 | verifyApp 按 appId 加 30-60s TTL 缓存(密钥重置时失效);touchApp 节流到每 appId 每分钟一次 |
| P2 | sweep 用 `KEYS pattern` 全量扫描,阻塞 Redis 主线程 | 改 `SCAN ... MATCH ... COUNT` 迭代,或维护维度成员 Set 索引 |
| P3 | 内存聚合器外层 key(sessionKey 高基数)永不删除,内存泄漏;`summary(groupBy='session')` 返回大量全零分组 | sweep 时内层空则删外层 key |
| P4 | 每条记录 5 次 ingest 各触发一次全量 sweep,O(维度×桶) 复杂度 | 加时间戳节流(每分钟最多一次,对齐 RedisAggregator) |
| P5 | 静态文件无缓存头,每次请求读盘 | 对带 hash 资源加 `Cache-Control: immutable` + ETag |
| P6 | `readBody` 用字符串拼接,且 `raw.length` 按 UTF-16 码元计数与字节上限不符 | 改 Buffer 数组累加再 concat,按字节数判断上限 |
| P7 | 冗余索引:`users(email)` UNIQUE 又建 idx、model_prices 主键前缀与 idx 重复 | 删除冗余索引,减少写放大 |
| P8 | worker `ingestToolCall` 直方图 member 用 `${traceId}:${toolName}:${idx}`,同名工具调用覆盖样本,分位数失真 | member 改用 spanId |
| P9 | Redis 限流用客户端时钟,多实例时钟偏移导致慢实例误限流 | Lua 内用 `redis.call('TIME')` 取服务端时钟 |
| P10 | 进程内令牌桶无时钟回拨保护(NTP 回拨期间误拒) | 对齐 Redis 版钳零保护 |

---

## 五、值得肯定的实践

- 密码安全:scrypt(N=32768/r=8/p=1)+ 16 字节随机盐 + 参数自描述编码 + `timingSafeEqual` 恒时比较;
- SQLite 主体查询全参数化,prepared statement 复用,`flush` 用事务保证批量原子性;
- MySQL `transaction` 的 getConnection/rollback/finally-release 结构正确,无连接泄漏;
- `cost/calculator.ts` 对价格查询做了 5 分钟 TTL 缓存(含负缓存);
- producer 默认 acks=-1;Redis 限流 Lua 脚本原子性正确且有时钟回拨保护;
- 内存聚合器 Histogram 用对数桶实现 O(1) 插入;
- `agent-definition/schema.ts` 字段级校验完整(类型/长度/白名单/范围)。

---

## 六、修复优先级路线图

### 第一批:立即(安全)
1. S1 查询端点注入项目 ACL 约束
2. S2 appSecret 泄露链(拒绝未关联项目读 secret + linkApp 归属校验)
3. S3 webhook URL 内网校验
4. S4 拒绝无 type 字段的旧 token

### 第二批:立即(功能损坏)
1. F2 MySQL 迁移补分号
2. F1 错误下钻接口重写(占位符参数化)
3. F3 CH 时间戳统一 UTC 解析
4. F10 healthz 改查实际 traceStore

### 第三批:近期(数据可靠性)
1. D1 consumer offset 模型重构(resolve 时机 + 定时器错误处理 + eachBatchAutoResolve)
2. D2 producer 连接失败重置
3. D3 DLQ 兜底暂存
4. D4 归档水位化 + 删除对齐
5. D8 非 MQ 模式失败计数 + 5xx
6. D11 shutdown 补 aggHandle.close()

### 第四批:近期(正确性)
1. D5 hybrid 双计
2. D6 WITHSCORES
3. D7 Redis TTL + 采样上限
4. F5 queryTrace 冷表回落
5. F6 开启 SQLite 外键 / 级联删除

### 第五批:规划
1. 性能优化 P1-P10
2. ClickHouse 查询全面参数化(当前手工转义拼接是高危反模式,CH HTTP 原生支持 `{id:String}` 参数绑定)
3. refresh token 撤销机制(jti 黑名单/用户版本号)
4. 补集成测试:拉起真实 Redis/Kafka/CH 断言数值,防止 D5/D6 这类"从产出起就错误"的缺陷
