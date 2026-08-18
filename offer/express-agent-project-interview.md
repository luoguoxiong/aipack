# Agent 快递业务场景项目实战 面试题（含答案）

> 以「中通式」全国网型快递公司为业务背景，围绕智能客服、异常运单处理、调度与路由、风控理赔、地址解析、数据洞察、工具集成、工程落地等真实项目场景编写。
> 难度标记：🟢 基础 / 🟡 进阶 / 🔴 高级 / 🟣 架构设计
> 业务术语约定：运单（waybill）、揽收（pickup）、干线（line-haul）、分拨中心（DC，distribution center）、派送（delivery）、签收（POD，proof of delivery）、客诉（customer complaint）、理赔（claim）。

---

## 一、业务理解与场景拆解

### Q1 🟢 快递公司的核心业务链路是怎样的？Agent 在哪些环节能产生真实价值？

**考察点**：业务全局观 + Agent 价值识别

**参考答案**：

**快递核心链路（端到端）**：

```
下单 → 揽收 → 入库(分拨) → 干线运输 → 中转(分拨) → 派送网点 → 派员揽派 → 签收
   ↓                                                       ↓
 计费/电子面单                                          异常/客诉/理赔
```

每个节点会产生大量结构化事件（扫描事件、称重、体积、签收照片）与非结构化数据（客户咨询、投诉文本、地址描述）。

**Agent 能产生真实价值的场景**（按 ROI 排序）：

| 场景 | 价值来源 | 适合 Agent 的原因 |
|------|----------|-------------------|
| 智能客服（查件/咨询/催单） | 替代 30-50% 人工坐席 | 多轮对话、需调多个系统、意图判定 |
| 异常运单自动处理 | 缩短异常处置时长（小时→分钟） | 规则复杂、需跨系统编排、要人工兜底 |
| 地址解析与纠错 | 提升自动化分拣率 | 文本理解 + 知识库匹配 |
| 风控审核（虚假运单/刷单） | 降低赔付损失 | 多源数据综合判断、需要解释性 |
| 理赔定损 | 缩短理赔周期 | 文本+图片理解、规则+判别 |
| 调度助手 | 提升车辆/人员利用率 | 多约束优化、需人审 |
| 运营报表/异常预警 | 替代 BI 临时取数 | 自然语言→SQL/指标、自动生成洞察 |

**不适合 Agent 化的场景**：纯流程编排（如固定路由计算、计费规则引擎）——传统规则系统更稳更快。Agent 适合「**规则不全、需理解文本、需跨系统决策、允许人审兜底**」的环节。

### Q2 🟡 你被任命落地「智能客服 Agent」MVP，如何在 8 周内交付？请给出里程碑和取舍。

**考察点**：项目落地能力、MVP 设计

**参考答案**：

**业务目标量化**（先和业务对齐，再开工）：
- 一期目标：自动解决率 ≥ 35%（基线人工分流率）、转人工率 ≤ 50%、单会话成本 ≤ ¥0.15、首响 ≤ 2s、平均会话时长 ≤ 4 分钟
- 覆盖意图：查件、催单、改地址、改电话、咨询运费、投诉破损/丢失/延误（6 类）
- 不覆盖：付款、法律纠纷、大客户专属客服

**8 周里程碑**：

| 周 | 关键产出 | 取舍 |
|----|----------|------|
| W1 | 意图分类法 + 评测集（500 条标注样本/意图） | 先做评测，后做模型 |
| W2 | 工具清单与 API 契约（运单查询、地址校验、催单、改单、工单创建） | 优先复用现成接口，不另起炉灶 |
| W3 | Runtime + 单 Agent 跑通 ReAct 主循环（查件+催单） | 不上多 Agent，先验证单 Agent |
| W4 | 意图分类模型（小模型蒸馏）+ 工具权限矩阵 | 用小模型分类省钱 |
| W5 | 流式输出 + UI 联动 + ApprovalManager 改地址兜底 | 副作用动作强制人审 |
| W6 | 评测闭环（200 条离线集 + 灰度回放）+ 成本看板 | 不上 eval 不上线 |
| W7 | 灰度 5% 流量 + 转人工降级 + 限流熔断 | 留逃生通道 |
| W8 | 复盘、扩量到 30%、迭代清单 | 量化收益 |

**关键取舍**：
1. **单 Agent 优先**：多 Agent 协作链路长、调试成本高，MVP 用单 Agent + 工具，待意图扩展再拆。
2. **副作用动作必人审**：改地址、改电话、退款一律走 ApprovalManager 异步审批，宁慢勿错。
3. **意图分类用小模型**：避免每轮都把全部上下文发给大模型做意图判定。
4. **离线评测集先行**：500 条标注样本每两天回归一次，不靠「感觉」。
5. **不碰多模态**：图片破损识别留到二期。

### Q3 🔴 同样是「Agent 平台」，快递公司的客服 Agent 与通用 Chatbot 在架构上有什么本质差异？

**考察点**：领域 Agent 的差异化认知

**参考答案**：

| 维度 | 通用 Chatbot | 快递客服 Agent |
|------|--------------|----------------|
| 任务边界 | 开放域闲聊/问答 | 强任务导向：每会话必须收敛到「查到结果 / 转人工 / 创建工单」 |
| 工具调用 | 偶尔查搜索 | 高频调用内部 API（运单、地址、催单、改单），每轮 ≥ 1 次 |
| 数据时效 | 知识截止 | 必须实时（运单状态每分钟变） |
| 副作用 | 几乎没有 | 改地址、退款、创建工单都是副作用，需审批 |
| SLA | 宽松 | 首响 ≤ 2s，TTFT ≤ 800ms，可用性 99.9% |
| 成本容忍 | 高 | 单会话 ≤ ¥0.15（量极大） |
| 失败兜底 | 抱歉了事 | 必须转人工，不能丢客户 |
| 评测 | 偏主观 | 强 KPI：解决率、转人工率、CSAT |
| 合规 | 弱 | 涉及个人信息（手机号、地址）、需 PII 脱敏、操作留痕 |

**架构差异要点**：
1. **强任务编排**：每个意图对应一条「状态机 + Agent」混合流程，不是纯 ReAct。
2. **工具前置**：工具调用是主路径而非增强，工具 API 的延迟直接决定用户体验。
3. **降级链路是一等公民**：转人工不是兜底，是与 Agent 平行的主路径。
4. **PII 与审计**：地址、电话、身份证号必须脱敏后才能进模型上下文，操作必须可回放。
5. **成本硬约束**：用量极大，必须做模型路由、缓存、Prompt 压缩，否则账单爆炸。

---

## 二、智能客服 Agent（核心项目）

### Q4 🟡 设计快递智能客服 Agent 的意图分类与工具调用流程，要求覆盖 6 大意图。

**考察点**：意图体系 + 工具编排

**参考答案**：

**意图分类法**（6 大类 + 子类）：

```
1. 查件（track_waybill）       → 子类：进度查询、签收图片、历史轨迹
2. 催单（urge）                → 子类：催揽收、催派送、催中转
3. 改单（modify_order）        → 子类：改地址、改电话、改收件人、改保价
4. 咨询（consult）             → 子类：运费、时效、网点、禁寄品、保价规则
5. 投诉（complaint）           → 子类：破损、丢失、延误、假签收、服务态度
6. 退款/理赔（refund_claim）   → 子类：运费退、保价理赔、增值服务退
```

**整体流程（意图分类前置 + Agent 编排）**：

```
用户输入
   ↓
[PII 脱敏 Transformer]  手机号/身份证/银行卡 → 占位符
   ↓
[意图分类器 (小模型)]   输出 intent + 置信度
   ↓
   ├─ 置信度 < 0.6  → 澄清话术 / 转人工
   ├─ 简单意图 (查件/咨询)  → 直接走 RAG/SQL，不进 Agent
   └─ 复杂意图 (改单/投诉/理赔) → 进 Agent 主循环
        ↓
   [Agent Runtime (ReAct)]
     ├─ beforeModelCall: 注入该意图的 system prompt + 工具白名单
     ├─ 模型推理 → 选择工具
     ├─ 工具执行（副作用动作经 ApprovalManager）
     ├─ 结果回填 → 继续推理
     └─ 终止 → 给出答案 / 创建工单 / 转人工
```

**工具白名单（按意图裁剪，控制 token 与误调用）**：

| 意图 | 可见工具 |
|------|----------|
| track_waybill | `queryWaybill`, `getProofOfDelivery`, `getTrajectory` |
| urge | `queryWaybill`, `createUrgeTicket`, `notifyCourier` |
| modify_order | `queryWaybill`, `validateAddress`, `updateOrder` (审批), `createTicket` |
| consult | `calcFee`, `queryTimeliness`, `queryOutlet`, `queryProhibitedItems` |
| complaint | `queryWaybill`, `uploadEvidence`, `createComplaintTicket` |
| refund_claim | `queryWaybill`, `queryPayment`, `createClaimTicket`, `refundPayment` (审批) |

**关键设计**：
- 意图分类前置降低大模型成本（小模型几分钱一次）
- 工具白名单按意图裁剪，避免模型误调用危险工具
- 副作用动作（updateOrder / refundPayment）一律走 ApprovalManager 异步审批
- 简单意图不进 Agent，走 RAG/SQL 直答，性能与成本双赢

### Q5 🔴 用户说「我的快递没收到，催一下，地址也要改成新地方」，如何处理这种混合意图？

**考察点**：多意图识别与编排

**参考答案**：

**问题拆解**：
- 意图 1：催派送（urge）
- 意图 2：改地址（modify_order）
- 隐含约束：改地址可能影响派送状态，需先改后催或先催后改的依赖判断

**处理方案（两阶段）**：

**阶段 1：意图识别（多标签分类）**

```python
# 意图分类器输出多标签 + 置信度
intents = classifier.predict(message)
# [
#   { intent: "urge", confidence: 0.92, slots: { waybill_no: null } },
#   { intent: "modify_order", confidence: 0.88, slots: { field: "address", value: null } }
# ]
```

**阶段 2：编排策略**

```typescript
async function orchestrate(message: string, intents: Intent[]) {
  // 1. 先抽取 slot（运单号、新地址）
  const waybillNo = await extractWaybillNo(message);
  if (!waybillNo) return await askForWaybillNo(); // 槽位未填，先问

  // 2. 查运单状态，判断是否允许改地址
  const waybill = await queryWaybill(waybillNo);
  if (waybill.status === 'delivered') {
    return "包裹已签收，无法改地址。是否要发起投诉？";
  }
  if (waybill.status === 'in_delivery') {
    // 派员已出发，改地址需走审批
    return await startApprovalFlow({
      type: 'modify_address_in_delivery',
      waybillNo,
      newAddress: await extractNewAddress(message),
    });
  }

  // 3. 改地址 + 催单的依赖关系：先改后催（避免催错地址）
  const modifyResult = await runAgent({
    intent: 'modify_order',
    slots: { waybillNo, field: 'address' },
    tools: ['validateAddress', 'updateOrder'],
    requireApproval: true,
  });
  if (modifyResult.success) {
    return await runAgent({
      intent: 'urge',
      slots: { waybillNo },
      tools: ['createUrgeTicket', 'notifyCourier'],
    });
  }
}
```

**关键要点**：
1. **多标签分类**：意图分类用 sigmoid 多标签而非 softmax 单标签
2. **依赖排序**：先改后催，避免催到旧地址
3. **业务规则前置**：运单状态决定能否改地址（已签收/已揽收状态规则不同）
4. **槽位填充**：运单号缺失时主动追问，不要让模型自己编
5. **降级**：复杂场景一次只处理一个意图，另一个转入下一轮（避免 Agent 失控）

### Q6 🟡 智能客服 Agent 的 system prompt 应该怎么写？请给出一个生产级模板。

**考察点**：Prompt 工程（业务场景化）

**参考答案**：

```markdown
# 角色
你是「快宝快递」智能客服，负责处理用户关于快递业务的咨询与办理。

# 工作原则
1. 每次回复前先确认运单号，未提供则主动询问
2. 涉及地址/电话/收件人修改、退款、理赔等操作，必须调用工具并等待审批结果，不得自行承诺
3. 涉及金额（运费、赔付）必须以工具返回的数字为准，禁止编造
4. 用户情绪激动（出现投诉、辱骂、法律威胁关键词）时，立即创建投诉工单并告知预计处理时长
5. 不得透露内部系统名称、网点编号、派员姓名电话（隐私合规）
6. 不得回答非快递业务问题（如政治、医疗），礼貌引导回业务

# 输出风格
- 简洁：单次回复不超过 3 句话，关键信息用列表
- 共情：用户表达不满时先共情再处理（如"非常抱歉给您带来不便"）
- 明确：进度类回复必须包含「当前状态 + 下一步动作 + 预计时间」三要素

# 当前会话上下文
- 用户身份：已认证（手机号 138****1234）
- 历史会话：用户 30 分钟前咨询过同一运单
- 已识别意图：modify_order
- 可用工具：queryWaybill, validateAddress, updateOrder(approval), createTicket

# 业务规则（当前意图相关）
- 运单状态 = "delivered" 时禁止改地址
- 运单状态 = "in_delivery" 时改地址需告知用户可能延迟 1-2 小时
- 改地址后 5 公里内免费，超出按新地址重新计费
- 同一运单 24 小时内最多改 2 次地址

# 输出格式
- 工具调用结果回来后，用自然语言向用户转述，禁止直接输出 JSON
- 转人工时输出固定话术：「正在为您转接人工客服，预计等待 X 分钟」
```

**模板要点**：
1. **角色与边界**：明确能做什么、不能做什么
2. **工作原则**：把业务规则翻译成模型可执行的指令
3. **会话上下文**：动态注入（已认证身份、历史、识别意图、工具白名单）
4. **业务规则片段化**：按当前意图注入相关规则，避免一次性塞入全部规则
5. **输出风格**：约束长度与风格，避免啰嗦
6. **合规约束**：PII 脱敏、不透露内部信息、转人工话术固定

### Q7 🟡 如何设计「转人工」的时机判断？过早转浪费人力，过晚转客户流失。

**考察点**：降级策略与体验平衡

**参考答案**：

**转人工触发条件（多维度联合判断）**：

```typescript
function shouldEscalateToHuman(ctx: RunContext): EscalateDecision {
  const reasons: string[] = [];

  // 1. 显式触发：用户主动要求
  if (ctx.lastUserMessage.includes('转人工') || ctx.lastUserMessage.includes('人工客服')) {
    return { escalate: true, reason: 'user_explicit', priority: 'high' };
  }

  // 2. 情绪触发：检测到负面情绪或投诉关键词
  if (detectNegativeEmotion(ctx.lastUserMessage) || hasComplaintKeywords(ctx.lastUserMessage)) {
    return { escalate: true, reason: 'negative_emotion', priority: 'high' };
  }

  // 3. 失败触发：连续 2 轮工具调用失败
  if (ctx.consecutiveToolFailures >= 2) {
    return { escalate: true, reason: 'tool_failure', priority: 'medium' };
  }

  // 4. 循环触发：同一意图连续 3 轮未收敛
  if (ctx.sameIntentTurns >= 3) {
    return { escalate: true, reason: 'no_convergence', priority: 'medium' };
  }

  // 5. 范围外：意图分类器置信度 < 0.4 连续 2 轮
  if (ctx.lowConfidenceTurns >= 2) {
    return { escalate: true, reason: 'out_of_scope', priority: 'low' };
  }

  // 6. 成本触发：单会话成本 > ¥0.5
  if (ctx.sessionCostCents > 50) {
    return { escalate: true, reason: 'cost_limit', priority: 'low' };
  }

  // 7. 业务硬规则：涉及法律、媒体、监管投诉
  if (hasLegalOrMediaKeywords(ctx.lastUserMessage)) {
    return { escalate: true, reason: 'legal_media', priority: 'critical' };
  }

  return { escalate: false };
}
```

**转人工的体验设计**：
1. **预告**：转之前用固定话术告知用户原因与预计等待时长
2. **上下文传递**：把当前会话摘要、运单号、用户身份同步给人工坐席系统
3. **优先级排队**：critical/high 优先接入，medium/low 按队列
4. **回访**：转人工后 24 小时内短信回访 CSAT
5. **反向学习**：人工处理的会话回流到评测集，迭代 Agent

**避免过早/过晚的平衡**：
- 早转：客户体验好但成本高，适合高价值客户、投诉、法律场景
- 晚转：客户体验差但成本低，适合查件、咨询类高频低价值场景
- 用 **用户分层** 区别对待：VIP 客户、企业客户、普通客户阈值不同
- 关键指标：**自动解决率** 与 **CSAT** 必须同时看，不能只追自动解决率

---

## 三、异常运单处理 Agent（多 Agent 协作）

### Q8 🔴 设计异常运单自动处理系统，覆盖「破损、丢失、延误、假签收」4 类，要求多 Agent 协作。

**考察点**：多 Agent 协作架构

**参考答案**：

**业务场景**：
- 每天全国产生约 50 万条异常运单事件（扫描异常、签收异常、客诉触发）
- 需自动分类、派单、跟踪、闭环，人工只处理复杂或大额案件
- SLA：分类 ≤ 5 分钟、首次联系客户 ≤ 30 分钟、闭环 ≤ 48 小时

**多 Agent 协作架构**：

```
                       ┌──────────────────────┐
                       │  Triage Agent (分类) │  ← 接入事件流
                       │  输入: 异常事件 + 运单详情
                       │  输出: 异常类型 + 严重等级 + 派单目标
                       └──────────┬───────────┘
                                  │
        ┌─────────────┬───────────┼─────────────┬──────────────┐
        ↓             ↓           ↓             ↓              ↓
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐
   │ Damage  │  │ Loss     │  │ Delay   │  │ FakePOD │  │ Escalation  │
   │ Agent   │  │ Agent    │  │ Agent   │  │ Agent   │  │ Agent (人审)│
   │ 破损处理│  │ 丢失处理 │  │ 延误处理│  │ 假签收  │  │ 升级处理    │
   └────┬────┘  └────┬─────┘  └────┬────┘  └────┬────┘  └──────┬──────┘
        │            │             │             │              │
        └────────────┴─────────────┴─────────────┴──────────────┘
                                  ↓
                       ┌──────────────────────┐
                       │  Resolution Agent    │  ← 收集所有处理结果
                       │  - 联系客户          │
                       │  - 计算赔付          │
                       │  - 关闭工单          │
                       │  - 上报数据          │
                       └──────────────────────┘
```

**各 Agent 职责**：

| Agent | 输入 | 工具 | 决策权 | 终止条件 |
|-------|------|------|--------|----------|
| Triage | 异常事件 + 运单 | `queryWaybill`, `queryCustomerProfile`, `classifyException` | 分类 + 严重度判定 | 输出分类结果 |
| Damage | 破损运单 + 照片 | `queryWaybill`, `analyzeImage`, `queryInsurance`, `createClaimTicket` | 赔付建议（≤¥500 自动） | 工单创建 |
| Loss | 丢失运单 | `queryTrajectory`, `queryLastScan`, `searchInWarehouse`, `createLossTicket` | 是否启动全网搜索 | 工单创建 + 搜索结果 |
| Delay | 延误运单 | `queryTrajectory`, `queryLineHaulStatus`, `notifyCustomer`, `createUrgeTicket` | 是否补偿（运费券） | 客户已通知 + 工单创建 |
| FakePOD | 签收异常 | `queryProofOfDelivery`, `analyzeSignature`, `callRecipient`, `createInvestigationTicket` | 是否启动调查 | 工单创建 |
| Escalation | 任意升级 | `notifyManager`, `createPriorityTicket` | 仅通知与升级 | 人工接管 |
| Resolution | 各 Agent 输出 | `contactCustomer`, `calcCompensation`, `closeTicket`, `reportMetrics` | 赔付金额（≤¥1000 自动） | 工单关闭 |

**协作机制**：

```typescript
// Agent 间通过共享 Blackboard 协作
interface ExceptionCase {
  caseId: string;
  waybillNo: string;
  exceptionType: 'damage' | 'loss' | 'delay' | 'fake_pod';
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: Evidence[];           // 各 Agent 收集的证据
  customerContacted: boolean;
  compensation: CompensationInfo; // 赔付信息
  status: 'triaging' | 'investigating' | 'resolving' | 'closed' | 'escalated';
  assignedAgents: string[];       // 已参与的 Agent
  auditLog: AuditEntry[];         // 全程审计
}

// Triage Agent 完成后写入 Blackboard，触发下游 Agent
class TriageAgent {
  async handle(event: ExceptionEvent): Promise<ExceptionCase> {
    const waybill = await this.tools.queryWaybill(event.waybillNo);
    const classification = await this.llm.classify(event, waybill);
    const case_ = {
      caseId: ulid(),
      waybillNo: event.waybillNo,
      exceptionType: classification.type,
      severity: classification.severity,
      // ...
    };
    await this.blackboard.write(case_);
    await this.eventBus.emit('case.triaged', case_);
    return case_;
  }
}

// Resolution Agent 监听所有下游 Agent 完成事件
class ResolutionAgent {
  @on('case.investigated')
  async resolve(case_: ExceptionCase) {
    const compensation = await this.calcCompensation(case_);
    if (compensation.amount <= 1000) {
      await this.tools.contactCustomer(case_, compensation);
      await this.tools.closeTicket(case_.caseId);
    } else {
      await this.tools.notifyManager(case_, compensation); // 大额人审
    }
  }
}
```

**关键设计**：
1. **Blackboard 模式**：共享 case 状态，Agent 间解耦，可扩展
2. **分级权限**：赔付金额 ≤ 阈值自动，超过人审
3. **全链路审计**：每个 Agent 的决策与工具调用都进 auditLog
4. **可降级**：任意 Agent 卡死/超时，触发 Escalation Agent 接管
5. **可观测**：每个 case 一个 traceId，串联所有 Agent 与工具调用

### Q9 🔴 破损 Agent 如何判断赔付金额？请描述决策流程与防欺诈策略。

**考察点**：业务规则 + 防欺诈

**参考答案**：

**赔付决策流程**：

```
破损运单 + 客户上传照片
        ↓
[1. 运单校验]
   - 是否已保价？保价金额？
   - 运单状态是否确实为已签收（破损需在签收时或 24h 内提出）
   - 是否在理赔时效内（签收后 7 天）
        ↓
[2. 图片分析]
   - 破损类型：外包装破损 / 内件破损 / 渗漏
   - 破损程度：轻微 / 中度 / 严重
   - 物品类型：普通 / 易碎 / 贵重
        ↓
[3. 赔付计算]
   - 保价物品：按保价金额赔付（不超过保价金额）
   - 未保价物品：
     * 普通物品：运费 3-5 倍 + 物品价值（不超过 ¥1000）
     * 易碎品：运费 1-2 倍（特殊条款）
     * 文件：运费退还
   - 邮费退还：另算
        ↓
[4. 防欺诈检查]
   - 同一收件人 30 天内理赔次数 ≥ 3 → 触发人审
   - 同一物品图片出现在历史理赔 → 触发人审
   - 物品价值异常高（>¥5000）但保价低 → 触发人审
   - 寄件人与收件人同 IP / 同设备 → 触发人审
        ↓
[5. 决策]
   - 赔付 ≤ ¥500 且无欺诈风险 → 自动赔付
   - ¥500 < 赔付 ≤ ¥2000 → 城市经理审批
   - 赔付 > ¥2000 或触发欺诈规则 → 总部理赔组审批
        ↓
[6. 执行赔付 + 关闭工单]
```

**关键代码**：

```typescript
class DamageAgent {
  async decideCompensation(case_: ExceptionCase): Promise<Compensation> {
    // 1. 运单校验
    const waybill = await this.tools.queryWaybill(case_.waybillNo);
    if (!this.isWithinClaimPeriod(waybill)) {
      return { amount: 0, reason: '超过理赔时效' };
    }

    // 2. 图片分析（多模态模型）
    const damage = await this.tools.analyzeImage(case_.evidence.images);
    const itemValue = await this.tools.queryItemValue(waybill.itemDescription);

    // 3. 赔付计算
    let amount: number;
    if (waybill.insuranceAmount > 0) {
      amount = Math.min(damage.lossRate * waybill.insuranceAmount, waybill.insuranceAmount);
    } else {
      const multiplier = waybill.itemType === 'fragile' ? 1.5 : 3;
      amount = Math.min(waybill.freight * multiplier + itemValue * damage.lossRate, 1000);
    }

    // 4. 防欺诈检查
    const fraudRisk = await this.fraudCheck(case_, waybill);
    if (fraudRisk.score > 0.7) {
      return { amount, requiresApproval: true, reason: '触发欺诈规则: ' + fraudRisk.reasons.join(',') };
    }

    // 5. 决策
    if (amount <= 500) {
      return { amount, requiresApproval: false };
    } else if (amount <= 2000) {
      return { amount, requiresApproval: true, approver: 'city_manager' };
    } else {
      return { amount, requiresApproval: true, approver: 'hq_claims' };
    }
  }

  private async fraudCheck(case_: ExceptionCase, waybill: Waybill): Promise<FraudRisk> {
    const reasons: string[] = [];
    let score = 0;

    // 规则 1: 高频理赔
    const recipientClaims = await this.tools.queryClaimHistory(waybill.recipientPhone);
    if (recipientClaims.last30Days >= 3) {
      reasons.push('30天内理赔超过3次');
      score += 0.4;
    }

    // 规则 2: 图片查重
    const imageHash = await this.tools.hashImage(case_.evidence.images[0]);
    const dupImage = await this.tools.queryImageHash(imageHash);
    if (dupImage) {
      reasons.push('破损图片与历史理赔重复');
      score += 0.5;
    }

    // 规则 3: 物品价值异常
    if (waybill.itemValue > 5000 && waybill.insuranceAmount < 1000) {
      reasons.push('高价值物品未足额保价');
      score += 0.3;
    }

    return { score: Math.min(score, 1), reasons };
  }
}
```

**防欺诈策略要点**：
1. **多维度规则**：频率、图片查重、价值保价比例、IP/设备关联
2. **图片哈希查重**：用感知哈希（pHash）识别历史重复图片
3. **黑名单**：累计欺诈次数超阈值的客户/手机号进黑名单
4. **图谱关联**：寄件人-收件人-手机号-IP 构建关系图谱，识别团伙
5. **可解释**：触发人审必须给出具体原因，便于人工复核

### Q10 🟡 异常运单事件量巨大（50 万/天），如何保证处理时效与成本可控？

**考察点**：高并发架构 + 成本控制

**参考答案**：

**分层处理（按事件严重度路由）**：

| 严重度 | 占比 | 处理方式 | 时效要求 |
|--------|------|----------|----------|
| P0 致命 | 1% | 立即进 Agent + 人工坐席 | ≤ 5 分钟首响 |
| P1 严重 | 5% | 进 Agent 自动处理 | ≤ 30 分钟闭环 |
| P2 一般 | 20% | 进简化 Agent（仅查 + 派单） | ≤ 4 小时闭环 |
| P3 轻微 | 74% | 不进 Agent，仅记录 + 模板短信通知 | 24 小时闭环 |

**架构设计**：

```
异常事件流（50 万/天）
   ↓
[Kafka topic: exception-events]  ← 削峰填谷
   ↓
[Flink 实时分类]   ← 规则引擎 + 模型，毫秒级
   ↓
   ├─ P0 → 直接推 P0 Agent + 通知人工坐席
   ├─ P1 → 入 P1 队列，消费 → Agent Worker
   ├─ P2 → 入 P2 队列，批量处理（合并相似工单）
   └─ P3 → 直接走模板短信，不进 Agent
```

**Agent Worker 池设计**：

```typescript
class AgentWorkerPool {
  private pools = {
    P0: new Pool({ max: 10, model: 'claude-opus' }),     // 高质量模型
    P1: new Pool({ max: 50, model: 'deepseek-v3' }),     // 性价比模型
    P2: new Pool({ max: 100, model: 'qwen-7b' }),        // 本地小模型
  };

  async dispatch(event: ExceptionEvent) {
    const severity = await this.classify(event);
    const pool = this.pools[severity];
    if (!pool) return;

    await pool.acquire(async () => {
      const agent = this.createAgent(severity, event);
      try {
        await withTimeout(agent.run(), this.getTimeout(severity));
      } catch (err) {
        await this.escalate(event, err);  // 失败转人工
      }
    });
  }
}
```

**成本控制策略**：

1. **模型分级**：P0 用大模型（贵但准）、P2 用小模型（便宜快）
2. **缓存**：相同运单 24h 内重复异常事件，复用上次分析结果
3. **批量推理**：P3 类事件用 batch API，单价降低 50%
4. **Prompt 压缩**：长运单轨迹先做摘要再喂模型
5. **早退**：规则明确的场景（如已签收 7 天后提出的破损）直接拒绝，不进 Agent
6. **预算熔断**：单 Agent Worker 每日预算上限，超出转人工
7. **结果复用**：同一收件人同地址的破损，可复用图片分析结果

**SLA 保障**：
- Kafka 消费者 lag 监控，超阈值告警
- Agent Worker 池预热（保持 10% idle）
- P0 事件绕过 Kafka，直接 HTTP 推送
- 失败重试 3 次仍失败 → 转人工 + 告警

---

## 四、调度与路由 Agent

### Q11 🟡 设计一个「调度助手 Agent」，帮助网点调度员安排车辆与人员。

**考察点**：业务建模 + Agent 设计

**参考答案**：

**业务场景**：
- 网点每天需要安排：早班揽收（5-9 点）、白班派送（8-18 点）、晚班干线（19-24 点）
- 变量：车辆数、人员数、运单量、地理分布、时效要求
- 约束：车辆载重/容积、人员资质（A2 驾照、电动车证）、人员工时、客户时效承诺
- 目标：最小化成本（车辆数 × 里程 + 人员工时）+ 最大化时效达成率

**Agent 架构（决策建议 + 人审执行）**：

```
网点调度员发起请求："今天早班怎么排？"
        ↓
[调度 Agent]
  - 工具 1: queryWaybills(timeRange, status)  // 待揽收运单
  - 工具 2: queryFleet(available)              // 可用车辆
  - 工具 3: queryStaff(available, qualification) // 可用人员
  - 工具 4: queryTraffic()                    // 实时路况
  - 工具 5: calcRoute(waybills, vehicle)       // 路径规划
  - 工具 6: optimize(waybills, fleet, staff)   // 优化求解
        ↓
[输出建议]
  - 推荐方案 A/B/C，附理由与权衡
  - 风险提示（如：方案 A 时效达成率高但成本高 15%）
        ↓
[人审]
  - 调度员选择 / 修改 / 拒绝
        ↓
[执行]
  - 调用 ERP 接口落单，通知司机/业务员
```

**关键设计**：

1. **Agent 不做最优求解，做编排**：路径优化是运筹学问题，用专门求解器（OR-Tools），Agent 负责调用与解释
2. **多方案推荐**：不直接给「最优解」，给 2-3 个权衡方案让人选
3. **可解释**：每个方案必须说明「为什么这么排」（成本、时效、风险）
4. **学习能力**：调度员的修改回流到训练数据，迭代推荐模型

**Prompt 片段**：

```markdown
你是快递网点调度助手。基于今日运单与资源情况，给出 2-3 个排班方案。

输出要求：
1. 每个方案包含：车辆分配、人员分配、预计里程、预计时长、成本估算、时效达成率
2. 必须说明每个方案的取舍（如：方案 A 成本最低但时效达成率 85%，方案 B 时效达成率 95% 但成本高 15%）
3. 推荐其中一个并说明理由
4. 给出风险提示（如：方案 A 在 17-19 点高峰期可能延误）

约束：
- 不得输出超出可用资源的方案
- 不得安排无资质人员（如让 C1 驾照开大货车）
- 必须遵守劳动法（连续工时 ≤ 4 小时，每日 ≤ 8 小时）
```

### Q12 🔴 干线运输遇突发情况（如高速封路），如何动态重新规划路由？

**考察点**：实时响应 + 业务约束

**参考答案**：

**场景**：
- 一辆干线车从北京 DC 出发前往上海 DC，途中徐州段高速因事故封路
- 需在 5 分钟内给出替代方案，并通知司机、调整 ETA、评估影响

**Agent 处理流程**：

```typescript
class RouteAgent {
  async handleDisruption(event: TrafficDisruption) {
    // 1. 查询受影响的在途车辆
    const affectedVehicles = await this.tools.queryVehiclesOnRoute(event.segmentId);

    for (const vehicle of affectedVehicles) {
      // 2. 重新规划路径（约束：避开封路段、最迟到达时间、车辆载重限制）
      const alternatives = await this.tools.calcAlternativeRoutes({
        vehicle,
        avoidSegments: [event.segmentId],
        deadline: vehicle.waybill.eta,
      });

      // 3. 评估每个方案的影响
      const evaluations = alternatives.map(alt => ({
        route: alt,
        delayMinutes: alt.eta - vehicle.originalEta,
        extraCost: alt.toll + alt.fuel - vehicle.originalCost,
        affectedWaybills: this.countAffectedWaybills(vehicle, alt.eta),
      }));

      // 4. 决策（自动 or 人审）
      const bestRoute = this.pickBestRoute(evaluations);
      if (bestRoute.delayMinutes <= 60 && bestRoute.extraCost <= 500) {
        // 小影响，自动调整
        await this.tools.notifyDriver(vehicle, bestRoute.route);
        await this.tools.updateETA(vehicle, bestRoute.route.eta);
        await this.notifyAffectedCustomers(vehicle, bestRoute.delayMinutes);
      } else {
        // 大影响，人审
        await this.tools.escalateToDispatcher(vehicle, evaluations);
      }
    }
  }
}
```

**关键要点**：

1. **实时感知**：订阅交通数据源（高德/百度 API + 内部车机 GPS）
2. **批量处理**：一次封路可能影响多辆车，并行处理
3. **影响评估**：不只看车辆，还要看车上运单的下游影响（中转衔接、客户时效承诺）
4. **分级决策**：小影响自动、大影响人审
5. **通知链路**：司机、调度、客服、客户多层通知
6. **回滚机制**：方案失败（如新路线也堵）时回退到原方案 + 转人工
7. **历史学习**：所有重规划案例入库，训练更准的 ETA 模型

### Q13 🟡 Agent 给出的调度方案，调度员往往不采纳，如何提升采纳率？

**考察点**：用户接受度优化

**参考答案**：

**采纳率低的常见原因**：
1. 方案脱离实际（如不知道某条路常堵车、某司机今天身体不适）
2. 缺乏解释（光给结果，不说为什么）
3. 不考虑隐性约束（如客户偏好、司机偏好）
4. 没有渐进式学习（每次都从头算，不吸收调度员的反馈）

**提升策略**：

**1. 上下文注入更丰富**：

```typescript
const context = {
  // 硬约束（必填）
  waybills, fleet, staff,

  // 软约束（隐性偏好）
  driverPreferences: await this.queryDriverPrefs(),    // 司机偏好路线
  customerPriorities: await this.queryCustomerTier(), // VIP 客户优先
  historicalTraffic: await this.queryHistoryTraffic(), // 历史同时段路况
  dispatcherNotes: await this.queryTodayNotes(),       // 调度员今日备注（如"老张请假"）

  // 反馈学习
  recentAdjustments: await this.queryRecentAdjustments(7), // 过去7天调度员修改记录
};
```

**2. 多方案对比 + 解释**：

```
方案 A（推荐）: 5 辆车 / 8 人 / 时效达成率 92% / 成本 ¥2,400
  - 取舍：时效优先，比 B 多 1 辆车但达成率高 7%
  - 风险：17-19 点高峰可能延误 2 单

方案 B: 4 辆车 / 7 人 / 时效达成率 85% / 成本 ¥1,900
  - 取舍：成本优先，节省 ¥500 但延误风险高
  - 风险：3 单可能超时赔付（预计 ¥300-¥800）

方案 C: 复用昨日方案
  - 取舍：稳定，但昨日有 2 单延误
```

**3. 反馈闭环**：

```typescript
// 调度员修改方案时记录
async onDispatcherModify(originalPlan, modifiedPlan, reason) {
  await this.feedbackStore.save({
    original: originalPlan,
    modified: modifiedPlan,
    reason,           // 调度员填写的原因
    timestamp: Date.now(),
  });

  // 累积足够样本后微调推荐模型
  if (await this.feedbackStore.count() % 100 === 0) {
    await this.retrainRecommendationModel();
  }
}
```

**4. 渐进式信任建立**：
- 上线初期：Agent 只给建议，不直接执行（纯建议模式）
- 1 个月后：低风险方案自动执行（如车数 ≤ 5）
- 3 个月后：根据采纳率逐步放开自动执行范围

**5. 评估指标**：
- 采纳率（直接采纳 / 修改后采纳 / 拒绝）
- 修改幅度（修改前后差异）
- 调度员 CSAT
- 方案执行后实际效果（时效达成率、成本）

---

## 五、风控与理赔 Agent

### Q14 🔴 设计一个「虚假运单识别 Agent」，要兼顾准确率与误杀率。

**考察点**：风控建模 + 风险与体验平衡

**参考答案**：

**业务背景**：
- 虚假运单类型：刷单（无真实寄件）、空包（实际无物）、自寄自收（刷信用）
- 影响：占用网络资源、虚假 GMV、监管风险
- 难点：特征隐蔽、团伙作案、规则易被绕过

**Agent 架构（规则 + 模型 + 图谱三层联防）**：

```
新运单生成事件
        ↓
[第 1 层：规则引擎]   毫秒级
   - 寄件人 = 收件人
   - 同一手机号 24h 内 ≥ 50 单
   - 重量 < 50g 但保价 > ¥1000
   - 地址为已知空包地址库
        ↓ 命中即拦截
[第 2 层：ML 模型]    秒级
   - 输入：运单特征 + 历史行为
   - 输出：欺诈概率
        ↓ 概率 > 0.7 进 Agent
[第 3 层：Agent 综合判断]  分钟级
   - 调用图谱工具查关联关系
   - 调用历史运单工具查轨迹异常
   - 调用客户画像工具查信用
   - 综合输出：是否虚假 + 证据链
        ↓
[决策]
   - 高置信度虚假 → 拦截 + 通知风控
   - 中置信度 → 人审
   - 低置信度 → 放行
```

**Agent 工具集**：

```typescript
class FraudAgent {
  tools = {
    queryWaybillHistory,      // 寄件/收件人历史运单
    queryAddressCluster,      // 地址聚类（识别空包地址）
    queryDeviceFingerprint,   // 下单设备指纹
    queryPaymentMethod,       // 支付方式
    queryGraphRelations,      // 图谱关联（同 IP/同设备/同手机号）
    queryCustomerCredit,      // 客户信用画像
    queryTrajectoryAnomaly,   // 轨迹异常（如太快签收、扫描点缺失）
    searchSimilarCases,       // 历史相似案例
  };

  async evaluate(waybill: Waybill): Promise<FraudResult> {
    // 1. 收集证据
    const evidence = await this.collectEvidence(waybill);

    // 2. 让模型基于证据综合判断
    const judgment = await this.llm.invoke({
      system: FRAUD_JUDGE_PROMPT,
      user: JSON.stringify({ waybill, evidence }),
    });

    // 3. 输出结构化结果
    return {
      isFraud: judgment.isFraud,
      confidence: judgment.confidence,
      reasons: judgment.reasons,           // 必须给出具体原因
      evidenceChain: judgment.evidenceChain, // 证据链
      recommendAction: judgment.confidence > 0.85 ? 'block' : 'review',
    };
  }
}
```

**防误杀策略**：

1. **分级处置**：
   - 高置信度（> 0.85）：直接拦截
   - 中置信度（0.5 - 0.85）：人审，运单先放行不阻断
   - 低置信度（< 0.5）：放行，但标记监控

2. **白名单机制**：
   - 大客户、长期合作商家、企业客户进白名单
   - 白名单内即使触发规则也优先放行，事后抽查

3. **申诉通道**：
   - 被拦截用户可一键申诉
   - 申诉率 > 5% 的规则需重新评估

4. **A/B 测试**：
   - 新规则先 1% 流量灰度
   - 监控误杀率（申诉率/拦截率）与漏报率（事后发现的虚假运单占比）

5. **可解释性**：
   - 每次拦截必须给出具体证据链
   - 申诉时人工可看到完整推理过程

### Q15 🟡 理赔 Agent 如何处理用户上传的破损图片？如何防止重复使用同一图片骗赔？

**考察点**：多模态 + 防欺诈

**参考答案**：

**图片处理流程**：

```typescript
class ClaimImageProcessor {
  async process(images: Buffer[], waybillNo: string): Promise<DamageAnalysis> {
    // 1. 基础校验
    for (const img of images) {
      if (img.length > 10 * 1024 * 1024) throw new Error('图片过大');
      const meta = await this.readExif(img);
      if (meta.timestamp) {
        const ageHours = (Date.now() - meta.timestamp) / 3600_000;
        if (ageHours > 24 * 7) {
          return { suspicious: true, reason: '图片拍摄时间超过7天' };
        }
      }
    }

    // 2. 图片查重（防重复骗赔）
    const duplicateCheck = await this.checkImageDuplication(images);
    if (duplicateCheck.found) {
      return {
        suspicious: true,
        reason: `图片与历史理赔 ${duplicateCheck.matchedCaseId} 重复`,
        duplicateScore: duplicateCheck.score,
      };
    }

    // 3. 多模态分析（破损识别）
    const analysis = await this.multimodal.invoke({
      images,
      prompt: `分析此快递破损情况，输出 JSON:
      {
        "package_condition": "完好|外包装破损|内件破损|渗漏",
        "damage_level": "none|minor|moderate|severe",
        "item_identifiable": true/false,
        "estimated_loss_rate": 0-1,
        "consistency_with_claim": true/false  // 与运单物品是否一致
      }`,
    });

    return analysis;
  }

  private async checkImageDuplication(images: Buffer[]): Promise<DuplicationResult> {
    const hashes = await Promise.all(images.map(img => this.pHash(img)));

    // 1. 精确哈希匹配（同一图片）
    for (const hash of hashes) {
      const exact = await this.tools.queryImageHash(hash);
      if (exact) {
        return { found: true, matchedCaseId: exact.caseId, score: 1.0 };
      }
    }

    // 2. 感知哈希相似度匹配（裁剪/压缩过的同一图片）
    for (const hash of hashes) {
      const similar = await this.tools.querySimilarImageHash(hash, threshold: 0.9);
      if (similar) {
        return { found: true, matchedCaseId: similar.caseId, score: similar.similarity };
      }
    }

    // 3. 同一收件人历史图片
    const recipientHistory = await this.tools.queryRecipientImages(recipientPhone);
    for (const histImg of recipientHistory) {
      const sim = await this.compareImage(images[0], histImg);
      if (sim > 0.85) {
        return { found: true, matchedCaseId: histImg.caseId, score: sim };
      }
    }

    return { found: false };
  }
}
```

**防骗赔策略**：

1. **图片查重三层**：
   - 精确 MD5 哈希（防完全重复）
   - 感知哈希 pHash（防裁剪/压缩/旋转）
   - 同收件人历史图片特征比对（防本人多次骗赔）

2. **EXIF 元数据**：
   - 拍摄时间（防使用旧图）
   - GPS 位置（防异地图片）
   - 设备信息（防网络盗图）

3. **多模态一致性检查**：
   - 图片物品与运单申报物品是否一致
   - 图片中外包装品牌是否与本公司一致
   - 破损程度与申报金额是否匹配

4. **行为模式**：
   - 同一手机号 30 天内 ≥ 3 次理赔
   - 同一设备指纹多账号理赔
   - 短时间内不同账号上传相似图片

5. **图谱关联**：
   - 寄件人-收件人-手机号-IP-设备构建关系图谱
   - 识别团伙作案（同一图片在多个账号间流转）

---

## 六、地址解析与智能分拣

### Q16 🟡 用户输入「北京市朝阳区国贸CBD万达广场A座1501，张三收 13800138000」，如何解析为结构化字段？

**考察点**：地址解析（NER + 规则）

**参考答案**：

**地址解析难点**：
- 用户写法不规范（如「北京朝阳国贸万达广场」省略了「市」「区」）
- 包含姓名、电话、地址混合
- 地址层级缺失（只有街道没有区）
- 别名/旧名（如「国贸」=「国际贸易中心」）

**解析流程（混合方案：规则 + 模型 + 知识库）**：

```typescript
class AddressParser {
  async parse(rawInput: string): Promise<ParsedAddress> {
    // 1. 字段切分（规则）
    const segmented = this.segmentByRule(rawInput);
    // { addressPart: "北京市朝阳区国贸CBD万达广场A座1501",
    //   namePart: "张三",
    //   phonePart: "13800138000" }

    // 2. 电话与姓名提取（正则 + 模型）
    const phone = this.extractPhone(segmented.phonePart ?? rawInput);
    const name = this.extractName(segmented.namePart ?? rawInput);

    // 3. 地址结构化（LLM）
    const structured = await this.llm.invoke({
      system: `将快递地址解析为标准结构，输出 JSON：
      {
        "province": "省/直辖市",
        "city": "市",
        "district": "区/县",
        "street": "街道/乡镇",
        "detail": "详细地址",
        "landmark": "地标（可选）",
        "building": "楼宇（可选）",
        "room": "房间号（可选）"
      }
      注意：
      - 直辖市时 city 与 province 相同
      - 缺失字段填 null，不要编造
      - 别名需映射（如"国贸"→"国际贸易中心"）`,
      user: segmented.addressPart,
    });

    // 4. 地址校验与纠错（知识库匹配）
    const validated = await this.validateAddress(structured);

    return { ...structured, name, phone, validation: validated };
  }

  private async validateAddress(addr: ParsedAddress): Promise<ValidationResult> {
    // 1. 行政区划合法性
    const adminCheck = await this.tools.queryAdminDivision(addr.province, addr.city, addr.district);
    if (!adminCheck.valid) {
      return { valid: false, errors: ['行政区划不合法'], suggestion: adminCheck.suggestion };
    }

    // 2. 地址标准化（POI 匹配）
    const poiMatch = await this.tools.searchPOI(`${addr.city}${addr.district}${addr.street}${addr.detail}`);
    if (poiMatch.confidence > 0.8) {
      return {
        valid: true,
        standardized: poiMatch.standardAddress,
        coordinates: poiMatch.coordinates,  // 经纬度，用于路由
      };
    }

    // 3. 模糊匹配（用户地址无法精确匹配时）
    const fuzzy = await this.tools.fuzzyMatchAddress(addr);
    return {
      valid: false,
      errors: ['无法精确匹配，请确认'],
      suggestion: fuzzy.bestMatch,
    };
  }
}
```

**关键技术点**：

1. **正则提取电话/姓名**：电话用 `1[3-9]\d{9}`，姓名用「收件人」「收」前后文
2. **LLM 结构化**：用 function calling 强制 JSON 输出，避免自由文本
3. **POI 知识库**：高德/百度 POI 接口做地址标准化与经纬度反查
4. **别名映射**：维护本地别名库（如「国贸」→「国际贸易中心」）
5. **校验三步**：行政区划合法性 → POI 精确匹配 → 模糊匹配建议

### Q17 🔴 用户地址是「深圳市南山区科技园」，但实际想寄到「深圳市南山区科技园路 X 号」，Agent 如何主动纠错并确认？

**考察点**：地址补全与交互设计

**参考答案**：

**问题分析**：
- 用户地址缺少详细门牌号
- 「科技园」可能是科技园片区、科技园路、科技园地铁站等多个 POI
- 不能擅自决定具体地址（可能寄错）

**Agent 处理流程**：

```typescript
class AddressCorrectionAgent {
  async handle(incompleteAddress: ParsedAddress): Promise<AddressInteraction> {
    // 1. 查询可能的候选 POI
    const candidates = await this.tools.searchPOI(incompleteAddress.toString(), { limit: 5 });

    if (candidates.length === 0) {
      // 2a. 无匹配，请用户提供更多细节
      return {
        action: 'ask_user',
        message: '未找到「科技园」对应的具体地址，请提供完整地址（含路名与门牌号）',
      };
    }

    if (candidates.length === 1 && candidates[0].confidence > 0.9) {
      // 2b. 唯一高置信度匹配，自动填充并提示用户
      const candidate = candidates[0];
      return {
        action: 'confirm_with_user',
        message: `您输入的「${incompleteAddress.detail}」匹配到：${candidate.standardAddress}，是否使用此地址？`,
        suggestedAddress: candidate,
      };
    }

    // 2c. 多个候选，让用户选择
    return {
      action: 'select_from_candidates',
      message: '找到多个匹配地址，请选择：',
      candidates: candidates.map((c, i) => ({
        index: i + 1,
        address: c.standardAddress,
        distance: c.distance,
        landmark: c.landmark,
      })),
    };
  }
}
```

**交互话术设计**：

```
用户：寄到深圳市南山区科技园

Agent：找到以下与「科技园」相关的地址，请选择或补充：
1. 深圳市南山区科技园路 1 号（科技园片区，最近匹配）
2. 深圳市南山区科技中一路（深圳软件产业基地）
3. 深圳市南山区科苑南路（科技园地铁站附近）
4. 以上都不是，我补充详细地址：______

（用户选择 1）

Agent：已确认收件地址：深圳市南山区科技园路 1 号。
       该地址在「科技园片区」，预计派送时间：明天 14:00-18:00。
       是否继续下单？
```

**关键设计**：

1. **不擅自填充**：高置信度也需用户确认，避免寄错
2. **候选 ≤ 5 个**：避免选择困难，超过则要求补充信息
3. **地理上下文**：附带片区、地标、距离帮助用户识别
4. **学习反馈**：用户最终确认的地址回写到地址库，提升下次匹配率
5. **缓存**：常见模糊地址的匹配结果缓存，降低 POI API 调用成本

---

## 七、数据分析与运营洞察

### Q18 🟡 运营经理问「为什么本周华东片区签收率下降 5%？」Agent 如何自动分析？

**考察点**：NL2SQL + 多步分析

**参考答案**：

**Agent 分析流程**：

```typescript
class InsightAgent {
  tools = {
    queryMetric,       // 查询指标库（聚合数据）
    queryRawData,      // 查询明细数据
    comparePeriod,     // 同比/环比对比
    drillDown,          // 下钻分析
    queryWeather,      // 外部数据
    queryEventLog,     // 内部事件
    generateChart,     // 生成图表
  };

  async analyze(question: string): Promise<InsightReport> {
    // Step 1: 拆解问题
    const subQuestions = await this.llm.invoke({
      system: `将业务问题拆解为可量化的子问题，输出 JSON 数组。
      示例：「为什么本周华东签收率下降5%」拆解为：
      [
        "本周华东签收率是多少？对比上周/去年同期？",
        "签收率按城市拆解，哪个城市下降最显著？",
        "下降城市的签收失败原因分布是什么？",
        "本周华东是否有异常事件（天气、爆仓、网点停业）？",
        "下降是否与特定快递员/网点相关？"
      ]`,
      user: question,
    });

    // Step 2: 逐个分析子问题（每个子问题一个工具调用）
    const findings: Finding[] = [];
    for (const sq of subQuestions) {
      const finding = await this.analyzeSubQuestion(sq);
      findings.push(finding);
    }

    // Step 3: 综合归因
    const synthesis = await this.llm.invoke({
      system: `基于以下分析发现，给出业务归因结论。
      输出格式：
      {
        "root_cause": "主要原因",
        "contributing_factors": ["次要原因1", "次要原因2"],
        "evidence": [{"finding": "...", "data": "..."}],
        "recommendation": "建议行动"
      }
      注意：
      - 必须基于数据，不能臆测
      - 多原因时按贡献度排序
      - 给出可执行的建议`,
      user: JSON.stringify(findings),
    });

    return { question, findings, synthesis, charts: await this.generateCharts(findings) };
  }

  private async analyzeSubQuestion(sq: string): Promise<Finding> {
    // NL2SQL 或 NL2Metric
    const query = await this.llm.toQuery(sq);  // 转换为 SQL 或指标查询
    const data = await this.tools.queryMetric(query);

    // 自动发现异常点
    const anomalies = this.detectAnomalies(data);

    return { question: sq, query, data, anomalies };
  }
}
```

**关键设计**：

1. **问题拆解**：把开放性业务问题转为可量化子问题
2. **NL2SQL/NL2Metric**：自然语言转查询，需 Prompt 模板与 schema 注入
3. **异常自动发现**：基于统计方法（标准差、同比环比）自动找异常点
4. **多源数据**：内部指标 + 外部数据（天气、节假日、突发事件）
5. **可视化**：自动生成图表（趋势、对比、分布）
6. **归因结论**：模型综合所有发现给出根因与建议，必须基于数据

**示例输出**：

```
📊 分析报告：本周华东签收率下降 5%

结论：主要原因是上海爆仓（贡献度 60%），次要原因是杭州连续阴雨（贡献度 25%）。

证据链：
1. 整体：华东签收率 89% → 84%（环比 -5%），其中：
   - 上海：92% → 78%（-14%，贡献下降的 56%）
   - 杭州：88% → 82%（-6%）
   - 其他城市变化 < 2%
2. 上海下钻：浦东分拨中心 11/12 派送延误，签收失败原因中「未联系上收件人」占比从 20% 升至 45%
3. 关联事件：11/12 上海浦东 DC 因双 11 量增长 200% 爆仓
4. 杭州同期：连续 3 天阴雨，户外派送效率下降

建议：
1. 短期：上海浦东 DC 增派 30 名临时派员，预计 3 天恢复
2. 长期：双 11 期间华东 DC 容量扩容预案
3. 杭州：恶劣天气预警机制，提前通知客户改约时间
```

### Q19 🟡 Agent 如何生成每日运营早报？如何确保数据准确与内容稳定？

**考察点**：自动化报表 + 质量保障

**参考答案**：

**早报需求**：
- 每日 8:00 推送到运营群
- 内容：昨日核心指标 + 异常告警 + 重点事件 + 今日待办
- 风险：数据错误、内容不稳定、模型幻觉

**架构**：

```typescript
class DailyReportScheduler {
  // 每日 7:30 触发
  @cron('30 7 * * *')
  async generate() {
    // 1. 数据准备（规则化，不让模型参与）
    const metrics = await this.collectMetrics();  // 昨日核心指标
    const anomalies = await this.detectAnomalies(metrics);  // 异常检测
    const events = await this.queryMajorEvents();  // 重大事件

    // 2. 数据校验
    const validation = this.validateMetrics(metrics);
    if (!validation.pass) {
      await this.alertOpsTeam('数据异常，早报未生成: ' + validation.errors);
      return;
    }

    // 3. 模型生成文案（基于结构化数据，不允许自由发挥）
    const report = await this.llm.invoke({
      system: `生成快递运营早报。基于以下结构化数据，按固定模板输出。
      规则：
      - 不得添加未提供的数据或结论
      - 数字必须与输入完全一致，禁止四舍五入或编造
      - 异常项必须标注 ⚠️
      - 不超过 500 字
      - 输出固定段落：核心指标 / 异常告警 / 重点事件 / 今日待办`,
      user: JSON.stringify({ metrics, anomalies, events }),
    });

    // 4. 二次校验（数字一致性）
    const consistencyCheck = this.verifyNumbers(report, { metrics, anomalies });
    if (!consistencyCheck.pass) {
      // 数字不一致，用规则重写或重新生成
      await this.regenerate({ metrics, anomalies, events });
    }

    // 5. 发送
    await this.sendToGroup('ops-morning', report);
  }

  private validateMetrics(m: Metrics): ValidationResult {
    // 与前 7 天同期对比，偏离 > 50% 的指标标记可疑
    const suspicious = [];
    for (const [k, v] of Object.entries(m)) {
      const history = this.history7d[k];
      const avg = average(history);
      if (Math.abs(v - avg) / avg > 0.5) {
        suspicious.push(`${k}: ${v} (7日均值 ${avg.toFixed(2)})`);
      }
    }
    return suspicious.length > 0
      ? { pass: false, errors: suspicious }
      : { pass: true };
  }

  private verifyNumbers(report: string, source: any): ConsistencyCheck {
    // 提取报告中的数字，与源数据对比
    const numbers = extractNumbers(report);
    for (const [key, value] of Object.entries(source.metrics)) {
      if (!numbers.includes(value)) {
        return { pass: false, mismatch: key };
      }
    }
    return { pass: true };
  }
}
```

**质量保障要点**：

1. **数据与生成解耦**：数据收集用规则代码，模型只负责文案
2. **固定模板**：用模板约束输出，减少自由发挥空间
3. **数字一致性校验**：报告中的数字必须与源数据完全匹配
4. **异常检测**：偏离历史均值过多的指标先校验后报告
5. **失败兜底**：数据异常时不发报告，告警运维
6. **可回放**：每次早报的输入数据与生成报告入库，便于复盘
7. **A/B 文案**：同一数据生成多版本文案，人工择优（线下评测）

---

## 八、工具集成与外部系统对接

### Q20 🟡 设计 Agent 与公司现有 ERP/WMS/TMS 系统的集成方案，如何降低耦合？

**考察点**：系统集成架构

**参考答案**：

**问题**：快递公司内部系统众多（ERP、WMS、TMS、CRM、计费、风控），Agent 不能直接调用每个系统的内部 API。

**架构（Adapter + Gateway 双层）**：

```
┌─────────────────────────────────────────────┐
│              Agent 层                       │
│  (调用统一 Tool API)                        │
└──────────────────┬──────────────────────────┘
                   │ 统一 Tool 接口
                   ↓
┌─────────────────────────────────────────────┐
│           Tool Gateway                       │
│  - 统一鉴权（Agent → Gateway 用 mTLS）       │
│  - 限流（每 Agent 每工具配额）              │
│  - 审计（每次调用记录）                     │
│  - 缓存（幂等查询缓存）                     │
└────┬───────┬───────┬───────┬───────┬────────┘
     ↓       ↓       ↓       ↓       ↓
  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
  │ ERP │ │ WMS │ │ TMS │ │ CRM │ │ 计费│
  │Adapt│ │Adapt│ │Adapt│ │Adapt│ │Adapt│
  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘
     ↓       ↓       ↓       ↓       ↓
   ERP     WMS     TMS     CRM     计费
   API     API     API     API     API
```

**Adapter 模式**：

```typescript
// 统一工具接口
interface Tool {
  name: string;
  schema: JSONSchema;
  execute(args: any, ctx: Context): Promise<any>;
}

// ERP 适配器
class ErpQueryWaybillTool implements Tool {
  name = 'queryWaybill';
  schema = { /* ... */ };

  async execute(args: { waybillNo: string }, ctx: Context) {
    // 1. 调用 ERP 接口
    const raw = await this.erpClient.queryWaybill(args.waybillNo);

    // 2. 转换为统一格式（屏蔽 ERP 内部结构）
    return {
      waybillNo: raw.wb_no,
      status: this.mapStatus(raw.stat_cd),
      sender: { name: raw.snd_nm, phone: raw.snd_tel, address: raw.snd_addr },
      recipient: { name: raw.rcv_nm, phone: raw.rcv_tel, address: raw.rcv_addr },
      items: raw.itm_lst.map(i => ({ name: i.nm, quantity: i.qty, value: i.val })),
      insuranceAmount: raw.ins_amt,
      freight: raw.frt_amt,
      createdAt: raw.crt_ts,
    };
  }

  private mapStatus(code: string): string {
    const map = { '10': 'created', '20': 'picked_up', /* ... */ };
    return map[code] ?? 'unknown';
  }
}
```

**Gateway 设计**：

```typescript
class ToolGateway {
  // 统一鉴权
  async authenticate(agentId: string, toolName: string): Promise<boolean> {
    return this.policy.allow(agentId, toolName);
  }

  // 限流（每 Agent 每工具配额）
  async rateLimit(agentId: string, toolName: string): Promise<boolean> {
    return this.limiter.allow(`${agentId}:${toolName}`, {
      requests: 100,
      perMinute: 60,
    });
  }

  // 审计
  async audit(log: AuditLog) {
    await this.auditStore.save({
      ...log,
      timestamp: Date.now(),
      hash: sha256(JSON.stringify(log.args)),
    });
  }

  // 缓存（幂等查询）
  async cachedExecute(tool: Tool, args: any, ctx: Context) {
    if (tool.isIdempotent) {
      const cacheKey = `${tool.name}:${sha256(args)}`;
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
      const result = await tool.execute(args, ctx);
      await this.cache.set(cacheKey, result, { ttl: 60 });
      return result;
    }
    return tool.execute(args, ctx);
  }
}
```

**关键设计**：

1. **Adapter 屏蔽差异**：ERP/WMS/TMS 各自接口不同，统一为 Tool 接口
2. **Gateway 集中管控**：鉴权、限流、审计、缓存统一处理
3. **mTLS 双向认证**：Agent 与 Gateway 间用证书认证，防止冒充
4. **工具版本化**：`queryWaybill.v1`、`queryWaybill.v2` 共存，平滑升级
5. **mock 与灰度**：开发环境用 mock adapter，生产灰度按比例切换真实/mock
6. **错误标准化**：各系统错误码统一映射为 Agent 可理解的错误

### Q21 🔴 Agent 调用外部系统失败时如何降级？请设计一个完整的容错方案。

**考察点**：容错与降级

**参考答案**：

**失败场景分类**：

| 失败类型 | 原因 | 处理策略 |
|----------|------|----------|
| 超时 | 网络抖动、系统慢 | 重试 + 指数退避 |
| 限流 | 429 | 等待 Retry-After 后重试 |
| 服务端错误 | 5xx | 重试 + 切换备用源 |
| 客户端错误 | 4xx | 不重试，返回错误给 Agent |
| 数据缺失 | 接口返回空 | 降级到备用数据源 |
| 数据不一致 | 多源数据冲突 | 用优先级规则裁决 |

**容错方案**：

```typescript
class ResilientToolExecutor {
  async execute(toolName: string, args: any, ctx: Context) {
    const tool = this.registry.get(toolName);

    try {
      // 1. 主路径执行（带重试）
      return await withRetry(
        () => tool.execute(args, ctx),
        {
          retries: 3,
          timeout: tool.timeout ?? 30000,
          backoff: 'exponential',
          retryIf: (err) => this.isRetryable(err),
        }
      );
    } catch (err) {
      // 2. 主路径失败，尝试降级
      return await this.fallback(tool, args, ctx, err);
    }
  }

  private async fallback(tool: Tool, args: any, ctx: Context, primaryErr: Error) {
    // 2a. 缓存降级
    if (tool.cacheable) {
      const stale = await this.cache.getStale(tool.name, args);
      if (stale) {
        return { ...stale, _meta: { degraded: true, reason: 'using stale cache' } };
      }
    }

    // 2b. 备用数据源降级
    if (tool.fallbackTo) {
      try {
        const altTool = this.registry.get(tool.fallbackTo);
        const result = await altTool.execute(args, ctx);
        return { ...result, _meta: { degraded: true, source: altTool.name } };
      } catch (altErr) {
        // 备用也失败，继续降级
      }
    }

    // 2c. 默认值降级
    if (tool.defaultValue) {
      return { ...tool.defaultValue(args), _meta: { degraded: true, reason: 'using default' } };
    }

    // 2d. 软失败：返回错误信息让 Agent 处理
    return {
      _meta: { degraded: true, failed: true },
      error: `${tool.name} 调用失败: ${primaryErr.message}`,
      suggestion: this.getRecoverySuggestion(tool, primaryErr),
    };
  }

  private getRecoverySuggestion(tool: Tool, err: Error): string {
    if (err instanceof TimeoutError) {
      return `${tool.name} 响应超时，建议告知用户稍后重试或转人工`;
    }
    if (err instanceof RateLimitError) {
      return `${tool.name} 被限流，建议等待 ${err.retryAfter}s 后重试`;
    }
    return `${tool.name} 暂时不可用，建议转人工处理`;
  }
}
```

**Agent 层降级逻辑**：

```typescript
// Agent 收到工具错误后的处理
class Agent {
  async handleToolError(error: ToolError, ctx: RunContext) {
    // 1. 简单错误，让模型自行决策
    if (error.degraded && !error.failed) {
      // 用降级数据继续推理
      return this.continueWith(error.data);
    }

    // 2. 关键工具失败，影响任务完成
    if (error.tool.isCritical) {
      // 2a. 转人工
      if (this.canEscalate) {
        return this.escalateToHuman('关键工具失败: ' + error.message);
      }
      // 2b. 通知用户稍后重试
      return this.replyToUser('系统暂时不可用，请稍后重试或转人工');
    }

    // 3. 非关键工具失败，继续推理
    return this.continueWith(null);  // 告诉模型该工具不可用
  }
}
```

**关键设计**：

1. **多层降级**：重试 → 缓存 → 备用源 → 默认值 → 软失败
2. **关键工具识别**：queryWaybill 是关键的，getWeather 是非关键的
3. **降级标记**：所有降级结果带 `_meta.degraded` 标记，便于审计
4. **可观测**：每次降级都打 metric，监控降级率
5. **熔断**：某工具失败率 > 阈值（如 30%）触发熔断，直接走降级路径不再调用
6. **用户体验**：降级时也要给用户明确反馈，不能装作没发生

---

## 九、工程实践（性能、可靠性、可观测）

### Q22 🔴 智能客服 Agent 在双 11 流量峰值（QPS 提升 10 倍）如何保障 SLA？

**考察点**：高并发与降级

**参考答案**：

**峰值场景特征**：
- 平日 QPS 200，双 11 峰值 QPS 2000
- 模型 API 也可能限流（OpenAI/Anthropic 容量有限）
- 用户容忍度低（双 11 焦虑，等不及）
- 客服坐席也紧张

**多层保障方案**：

**1. 流量削峰**：

```typescript
// 客户端层：阶梯式进入
- 等待 > 30s 时显示「预计等待 X 分钟，可点击转人工」
- 等待 > 60s 时直接转人工
- 同时进入会话数 > 容量 80% 时显示排队

// 接入层：限流
- 全局限流：QPS 上限 = 模型容量 × 80%
- 用户级限流：单用户 QPS ≤ 1
- IP 级限流：单 IP QPS ≤ 5

// Agent 层：优先级队列
class PriorityQueue {
  enqueue(req: Request) {
    const priority = this.calcPriority(req);
    // VIP 客户 > 投诉 > 查件 > 咨询
    this.queues[priority].push(req);
  }
}
```

**2. 模型容量保障**：

```typescript
// 多 Provider 容灾
class ModelRouter {
  providers = [
    { name: 'openai', weight: 0.5, rateLimit: 500 },
    { name: 'anthropic', weight: 0.3, rateLimit: 300 },
    { name: 'deepseek', weight: 0.2, rateLimit: 1000 },
  ];

  async invoke(req: ChatRequest) {
    // 1. 轮询分配
    for (const p of this.providers) {
      if (this.limiter.allow(p.name, p.rateLimit)) {
        try {
          return await this.adapters[p.name].invoke(req);
        } catch (err) {
          if (err instanceof RateLimitError) {
            this.limiter.block(p.name, err.retryAfter);
            continue;
          }
          throw err;
        }
      }
    }
    // 2. 全部限流，走降级
    throw new AllProvidersLimitedError();
  }
}
```

**3. 降级策略（按严重度分级）**：

```typescript
class DegradeStrategy {
  // Level 1: 关闭非核心功能
  // - 关闭「智能推荐相关问题」
  // - 关闭「会话摘要自动生成」
  // - 工具白名单只保留最关键的（queryWaybill, createTicket）

  // Level 2: 模型降级
  // - 大模型 → 小模型（如 GPT-4 → GPT-4o-mini）
  // - 流式 → 非流式（节省连接）

  // Level 3: 路径降级
  // - 复杂意图（投诉/理赔）直接转人工
  // - 仅保留查件、催单两个核心意图

  // Level 4: 极限降级
  // - 完全关闭 Agent，所有会话转人工
  // - 仅 FAQ 关键词匹配
}
```

**4. 缓存与预计算**：

```typescript
// 高频查询缓存
class WaybillCache {
  // 运单状态缓存 60s（双 11 期间缩短到 30s）
  async get(waybillNo: string) {
    return this.cache.get(`wb:${waybillNo}`, { ttl: 30 });
  }
}

// 热门问题预生成
// - 「双11快递什么时候到」类问题，预生成标准答案
// - 用户输入相似度 > 0.9 直接返回
```

**5. 容量规划**：

- 模型容量：双 11 前 1 个月向 Provider 申请配额提升
- 服务器：Agent Worker 池预热（保持 30% idle）
- 数据库：读副本扩容
- 监控：双 11 期间 24 小时值班

**6. 演练与压测**：
- 双 11 前 1 周做全链路压测
- 模拟 Provider 限流场景
- 演练降级流程

### Q23 🟡 设计 Agent 的全链路可观测方案，要能定位「为什么这个会话体验差」。

**考察点**：可观测性设计

**参考答案**：

**观测维度（三支柱）**：

```
┌─────────────────────────────────────────────┐
│              Trace（链路追踪）               │
│  一次会话 → 一个 trace，串联所有 span         │
│  - Agent loop 每次 iteration                 │
│  - 每次模型调用                              │
│  - 每次工具调用                              │
│  - 每次意图分类                              │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│              Metric（指标）                  │
│  - 业务指标：解决率、转人工率、CSAT           │
│  - 性能指标：TTFT、首响、会话时长             │
│  - 成本指标：单会话 token、单会话成本          │
│  - 异常指标：工具失败率、降级率、循环次数      │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│              Log（日志）                     │
│  - 结构化日志：每次工具调用参数与结果         │
│  - 模型输入输出（脱敏后）                    │
│  - 异常堆栈                                  │
└─────────────────────────────────────────────┘
```

**Trace 结构**：

```typescript
interface SessionTrace {
  traceId: string;        // 会话级 traceId
  sessionId: string;
  userId: string;
  intent: string;
  spans: Span[];          // 每个操作一个 span
}

interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;           // 'agent.loop' | 'llm.invoke' | 'tool.execute'
  startTime: number;
  endTime: number;
  attributes: {           // 结构化属性
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costCents?: number;
    toolName?: string;
    toolArgs?: any;       // 脱敏后
    toolResult?: any;     // 脱敏后
    status: 'success' | 'error' | 'timeout';
    error?: string;
  };
}
```

**「会话体验差」定位流程**：

```typescript
class SessionDebugger {
  async diagnose(sessionId: string): Promise<Diagnosis> {
    const trace = await this.traceStore.get(sessionId);

    const issues: Issue[] = [];

    // 1. 性能问题
    const totalDuration = trace.endTime - trace.startTime;
    if (totalDuration > 4 * 60 * 1000) {
      issues.push({ type: 'performance', severity: 'high', message: `会话时长 ${totalDuration/1000}s 超阈值` });

      // 找最慢的 span
      const slowest = trace.spans.reduce((a, b) =>
        (b.endTime - b.startTime) > (a.endTime - a.startTime) ? b : a
      );
      issues.push({ type: 'performance', message: `最慢 span: ${slowest.name} (${slowest.endTime - slowest.startTime}ms)` });
    }

    // 2. 循环过多
    const loopCount = trace.spans.filter(s => s.name === 'agent.loop').length;
    if (loopCount > 10) {
      issues.push({ type: 'loop_excessive', message: `循环 ${loopCount} 次，可能死循环` });
    }

    // 3. 工具失败
    const failedTools = trace.spans.filter(s => s.name === 'tool.execute' && s.attributes.status === 'error');
    if (failedTools.length > 0) {
      issues.push({
        type: 'tool_failure',
        message: `${failedTools.length} 次工具失败: ${failedTools.map(t => t.attributes.toolName).join(',')}`,
      });
    }

    // 4. 成本过高
    const totalCost = sum(trace.spans.map(s => s.attributes.costCents ?? 0));
    if (totalCost > 50) {
      issues.push({ type: 'cost', message: `单会话成本 ¥${totalCost/100}，超阈值` });
    }

    // 5. 重复工具调用
    const toolCalls = trace.spans.filter(s => s.name === 'tool.execute');
    const duplicates = findDuplicates(toolCalls, t => `${t.attributes.toolName}:${hash(t.attributes.toolArgs)}`);
    if (duplicates.length > 0) {
      issues.push({ type: 'duplicate_call', message: `${duplicates.length} 次重复工具调用` });
    }

    return { trace, issues, recommendation: this.recommend(issues) };
  }
}
```

**示例输出**：

```
📋 会话调试报告 (sessionId: abc123)

❌ 发现 3 个问题：
1. [高] 会话时长 312s，超过 4 分钟阈值
   - 最慢 span: tool.execute(queryWaybill) 8200ms
2. [中] 循环 12 次，可能死循环
   - 第 8-12 次循环重复调用 queryWaybill，参数相同
3. [低] 单会话成本 ¥0.62，超阈值
   - 大量 token 用于重复 queryWaybill

💡 建议：
- queryWaybill 接口本身慢（8s），需优化或加缓存
- 死循环检测器阈值过松，建议降低到 5
- 在 Agent 中加入「相同工具+相同参数」拦截
```

**关键设计**：

1. **三支柱联动**：Trace 串上下文、Metric 看趋势、Log 查细节
2. **会话级 traceId**：所有 span 共享一个 traceId，便于回放
3. **PII 脱敏**：日志中所有 PII 字段脱敏后存储
4. **自动诊断**：根据规则自动发现问题，给出建议
5. **回放能力**：可以基于 trace 重新执行会话，复现问题
6. **采样策略**：100% 异常会话采样，正常会话 1% 采样

### Q24 🟡 如何评测智能客服 Agent 的质量？设计一套评测体系。

**考察点**：评测体系设计

**参考答案**：

**评测维度（4 层）**：

| 层级 | 维度 | 指标 | 评测方法 |
|------|------|------|----------|
| L1 业务指标 | 整体效果 | 自动解决率、转人工率、CSAT、首响时间 | 线上监控 |
| L2 任务指标 | 任务完成 | 意图识别准确率、任务完成率、工具调用成功率 | 离线评测集 |
| L3 对话指标 | 对话质量 | 工具调用合理性、回答准确性、风格一致性 | LLM-as-Judge |
| L4 安全指标 | 合规与安全 | PII 泄露率、违规话术率、越界回答率 | 规则 + 模型 |

**评测集设计**：

```typescript
interface EvalCase {
  caseId: string;
  category: string;        // 'track_waybill' | 'urge' | ...
  difficulty: 'easy' | 'medium' | 'hard';
  conversation: Message[];  // 多轮对话历史
  expectedBehavior: {
    intent?: string;
    toolsCalled?: string[];
    finalAction?: 'answer' | 'create_ticket' | 'escalate';
    finalAnswerContains?: string[];  // 答案应包含的关键信息
    mustNotContain?: string[];       // 不能说的话（如内部系统名）
  };
  // LLM-as-Judge 评分维度
  judgingCriteria: {
    accuracy: number;       // 1-5
    helpfulness: number;    // 1-5
    safety: number;         // 1-5
    tone: number;           // 1-5
  };
}
```

**评测执行流程**：

```typescript
class AgentEvaluator {
  async run(evalSet: EvalCase[]): Promise<EvalReport> {
    const results: CaseResult[] = [];

    for (const case_ of evalSet) {
      // 1. 回放对话
      const session = await this.agent.replay(case_.conversation);

      // 2. 规则检查
      const ruleCheck = this.checkRules(session, case_);
      // - 工具调用是否符合预期
      // - 最终动作是否正确
      // - 是否包含禁止内容

      // 3. LLM-as-Judge
      const judgeScore = await this.llmJudge(session, case_);

      results.push({
        caseId: case_.caseId,
        passed: ruleCheck.passed && judgeScore.overall >= 4,
        ruleCheck,
        judgeScore,
      });
    }

    return this.aggregate(results);
  }

  private async llmJudge(session: Session, case_: EvalCase): Promise<JudgeScore> {
    return await this.llm.invoke({
      system: `评估以下 Agent 会话质量，输出 JSON：
      {
        "accuracy": 1-5,        // 信息是否准确（基于 expectedBehavior）
        "helpfulness": 1-5,      // 是否真正帮助用户
        "safety": 1-5,          // 是否合规（无 PII 泄露、无违规话术）
        "tone": 1-5,            // 风格是否得体
        "overall": 1-5,         // 综合评分
        "issues": ["问题1", "问题2"]
      }`,
      user: JSON.stringify({
        conversation: session.messages,
        expectedBehavior: case_.expectedBehavior,
      }),
    });
  }
}
```

**LLM-as-Judge Prompt 模板**：

```markdown
你是快递客服 Agent 的质量评审员。请基于以下信息评估会话质量。

## 评估维度（1-5 分）
- accuracy: 信息是否准确，是否编造数据
- helpfulness: 是否真正解决了用户问题
- safety: 是否合规（无 PII 泄露、无违规话术）
- tone: 风格是否得体（简洁、共情、专业）

## 评估要点
1. 是否调用了正确的工具？
2. 工具参数是否合理？
3. 最终答案是否准确反映工具返回的数据？
4. 是否有越界行为（如透露内部系统名、承诺无法兑现的事）？
5. 是否有遗漏（如该转人工没转、该创建工单没创建）？

## 评分标准
- 5: 完美，无任何问题
- 4: 基本正确，有小瑕疵
- 3: 有明显问题但不影响任务完成
- 2: 任务未完成或严重错误
- 1: 严重违规（PII 泄露、误导用户）

## 输入
会话: {conversation}
预期行为: {expectedBehavior}
```

**评测节奏**：
- **每次发版前**：跑完整评测集（500 条），通过率 ≥ 95% 才能发版
- **每日回归**：跑核心子集（100 条），监控指标漂移
- **线上灰度**：1% 流量灰度，对比核心指标
- **每周 LLM-as-Judge**：随机采样 200 条线上会话，人工 + 模型双评

**评测陷阱**：
1. **只看通过率**：通过率 95% 但未通过的 5% 可能是关键场景（如投诉）
2. **过度依赖 LLM-as-Judge**：模型评分有偏差，需人工抽检校准
3. **静态评测集**：用户输入会演化，评测集需每月补充新 case
4. **忽略对话质量**：任务完成不代表体验好，可能多轮废话后勉强完成

---

## 十、上线与运营

### Q25 🟡 设计 Agent 上线的灰度发布方案，要求支持快速回滚。

**考察点**：发布与回滚

**参考答案**：

**灰度策略（按流量比例）**：

```
Day 1: 0.1% 流量  → 监控 24h，无异常升 1%
Day 2: 1%         → 监控 24h
Day 3: 5%         → 监控 12h
Day 4: 20%        → 监控 12h
Day 5: 50%        → 监控 12h
Day 6: 100%
```

**灰度分流规则**：

```typescript
class GrayRelease {
  // 按用户 hash 分流，确保同一用户始终命中同一版本
  shouldUseNewVersion(userId: string): boolean {
    const hash = crc32(userId);
    const bucket = hash % 10000;  // 万分位
    return bucket < this.currentRollout * 100;  // currentRollout: 0.001 ~ 1.0
  }

  // 优先灰度内部员工
  isInternal(userId: string): boolean {
    return this.internalUserSet.has(userId);
  }
}
```

**监控指标与回滚阈值**：

```typescript
const rollbackRules: RollbackRule[] = [
  {
    metric: 'error_rate',
    threshold: 0.05,        // 错误率 > 5%
    window: '5m',
    action: 'immediate_rollback',
  },
  {
    metric: 'avg_session_duration',
    threshold: baseline * 1.5,  // 比基线高 50%
    window: '15m',
    action: 'alert_and_review',
  },
  {
    metric: 'escalation_rate',  // 转人工率
    threshold: baseline * 1.2,
    window: '30m',
    action: 'alert_and_review',
  },
  {
    metric: 'csat_score',
    threshold: 4.0,        // CSAT < 4.0
    window: '1h',
    action: 'alert_and_review',
  },
  {
    metric: 'cost_per_session',
    threshold: 0.30,       // 单会话成本 > ¥0.30
    window: '1h',
    action: 'alert_and_review',
  },
];
```

**回滚机制**：

```typescript
class RollbackManager {
  async rollback(reason: string) {
    // 1. 切换流量到旧版本
    await this.config.set('agent.version', this.previousVersion);
    await this.config.set('rollout.percent', 0);

    // 2. 等待新连接结束（最多 60s）
    await this.drainConnections(60_000);

    // 3. 通知运维与业务
    await this.notify({
      channel: '#ops-alert',
      message: `Agent 已回滚到 v${this.previousVersion}，原因：${reason}`,
    });

    // 4. 记录回滚事件
    await this.incidentStore.save({ reason, timestamp: Date.now() });
  }

  // 一键回滚按钮（运维有权触发）
  @http.post('/admin/rollback')
  async manualRollback(@body() reason: string) {
    await this.auditLog.record({ action: 'manual_rollback', operator: this.user, reason });
    await this.rollback(reason);
  }
}
```

**关键设计**：

1. **用户 hash 分流**：同一用户体验一致，不会忽新忽旧
2. **内部优先**：员工先试用，暴露问题再扩量
3. **多维监控**：不只看错误率，看体验指标（CSAT、转人工率）
4. **快速回滚**：≤ 1 分钟完成回滚，连接优雅退出
5. **审计**：每次回滚有记录，便于复盘
6. **演练**：上线前演练回滚流程，确保按钮可用

### Q26 🟡 如何衡量 Agent 上线后的业务价值？给老板看的报表应该包含什么？

**考察点**：业务价值衡量

**参考答案**：

**价值衡量框架（4 层）**：

```
L1 财务价值（老板最关心）
   - 节省人力成本（替代坐席数 × 人均成本）
   - 增加收入（如自动改地址减少二次派送）
   - 降低赔付（智能理赔减少错误赔付）

L2 运营价值（业务部门关心）
   - 自动解决率（替代了多少人工）
   - 平均处理时长（AHT）
   - 异常处置时长
   - 转人工率

L3 用户体验（客服部门关心）
   - 首响时间
   - CSAT 评分
   - 问题一次性解决率（FCR）
   - 投诉率

L4 系统健康（技术团队关心）
   - 可用性（SLA）
   - 错误率
   - 单会话成本
   - P95 响应时间
```

**示例报表（双月报）**：

```markdown
# 智能客服 Agent 双月报（2026-07 ~ 2026-08）

## 一、财务价值
- 替代坐席等效：35 FTE（按工作时长折算）
- 节省人力成本：¥560,000（双月）
- 减少错误赔付：¥120,000
- 减少二次派送：8,200 单，节省 ¥41,000
- Agent 总成本：¥85,000（含模型、服务器）
- **净收益：¥636,000**

## 二、运营指标
| 指标 | 上线前 | 当前 | 变化 |
|------|--------|------|------|
| 自动解决率 | 0% | 42% | +42% |
| 平均处理时长 | 5m20s | 3m15s | -39% |
| 转人工率 | 100% | 38% | -62% |
| 异常首响时长 | 12min | 4min | -67% |

## 三、用户体验
| 指标 | 基线 | 当前 |
|------|------|------|
| 首响时间 | 12s | 1.8s |
| CSAT 评分 | 4.1 | 4.3 |
| 一次性解决率 | 68% | 75% |
| 投诉率 | 3.2% | 2.1% |

## 四、系统健康
- 可用性：99.92%（SLA 99.9% ✅）
- P95 首响：1.2s
- 单会话成本：¥0.13（目标 ¥0.15 ✅）
- 错误率：0.3%

## 五、问题与改进
1. 投诉类意图自动解决率仅 22%，需重点优化
2. 大模型成本占比 78%，下阶段引入小模型路由
3. P95 首响在峰值时段达 3.5s，需优化

## 六、下阶段计划
- 二期覆盖付款、大客户专属场景
- 引入多模态（破损图片识别）
- 优化投诉处理 Agent
```

**关键设计**：

1. **财务价值优先**：老板最先看钱，必须算清楚净收益
2. **基线对比**：所有指标必须有上线前基线对比
3. **诚实呈现问题**：不夸大成绩，问题与改进同时呈现
4. **目标对照**：与上线时设定的目标对比（达成 / 未达成）
5. **可验证**：数据来源可追溯，避免「自说自话」

---

## 十一、编码题

### Q27 🟢 实现一个简化的运单查询工具，要求带缓存与超时。

**考察点**：工具实现基础

**参考答案**：

```typescript
interface Waybill {
  waybillNo: string;
  status: 'created' | 'picked_up' | 'in_transit' | 'delivering' | 'delivered' | 'exception';
  sender: { name: string; phone: string; address: string };
  recipient: { name: string; phone: string; address: string };
  createdAt: number;
  updatedAt: number;
  trajectory: TrajectoryPoint[];
}

interface TrajectoryPoint {
  time: number;
  location: string;
  event: string;
}

class QueryWaybillTool implements Tool {
  name = 'queryWaybill';
  description = '查询运单详情，返回当前状态、收发件人信息与轨迹';
  schema = {
    type: 'object',
    properties: {
      waybillNo: { type: 'string', description: '运单号，如 "SF1234567890"' },
    },
    required: ['waybillNo'],
  };
  cacheable = true;

  constructor(
    private apiClient: WaybillApiClient,
    private cache: Cache,
  ) {}

  async execute(args: { waybillNo: string }): Promise<Waybill | null> {
    const { waybillNo } = args;

    // 1. 缓存命中（30s TTL，运单状态变化快）
    const cacheKey = `waybill:${waybillNo}`;
    const cached = await this.cache.get<Waybill>(cacheKey);
    if (cached) {
      return { ...cached, _fromCache: true };
    }

    // 2. 调用 API（5s 超时）
    const result = await withTimeout(
      this.apiClient.query(waybillNo),
      5000,
    );

    // 3. 写缓存
    if (result) {
      await this.cache.set(cacheKey, result, { ttl: 30 });
    }

    return result;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}
```

**要点**：
- 短 TTL 缓存（30s）平衡性能与数据新鲜度
- 超时保护避免单工具卡死整个 Agent
- 缓存命中标记 `_fromCache`，便于观测
- schema 清晰描述参数

### Q28 🟡 实现一个简单的死循环检测器，识别 Agent 是否在重复调用相同工具。

**考察点**：循环检测

**参考答案**：

```typescript
interface ToolCall {
  toolName: string;
  args: any;
  timestamp: number;
}

class LoopDetector {
  private history: ToolCall[] = [];
  private windowSize: number;
  private maxRepeats: number;

  constructor(options: { windowSize?: number; maxRepeats?: number } = {}) {
    this.windowSize = options.windowSize ?? 5;      // 检查最近 5 次
    this.maxRepeats = options.maxRepeats ?? 2;      // 同一调用最多 2 次
  }

  record(toolName: string, args: any) {
    this.history.push({ toolName, args, timestamp: Date.now() });
    // 保留最近 windowSize * 2 条
    if (this.history.length > this.windowSize * 2) {
      this.history = this.history.slice(-this.windowSize * 2);
    }
  }

  isLooping(): boolean {
    if (this.history.length < this.windowSize) return false;

    const recent = this.history.slice(-this.windowSize);

    // 检查 1: 最近 N 次是否都是同一 (toolName, argsHash)
    const signatures = recent.map(c => `${c.toolName}:${this.hashArgs(c.args)}`);
    const uniqueSignatures = new Set(signatures).size;
    if (uniqueSignatures === 1) return true;  // 全部相同

    // 检查 2: 同一签名出现 > maxRepeats 次
    const counter = new Map<string, number>();
    for (const sig of signatures) {
      counter.set(sig, (counter.get(sig) ?? 0) + 1);
    }
    for (const count of counter.values()) {
      if (count > this.maxRepeats) return true;
    }

    // 检查 3: A-B-A-B 交替模式
    if (this.windowSize >= 4) {
      const pattern = signatures.join('|');
      if (/^([^|]+)\|([^|]+)\|\1\|\2$/.test(pattern)) return true;
    }

    return false;
  }

  private hashArgs(args: any): string {
    // 稳定哈希：JSON 序列化后做 hash
    const json = JSON.stringify(args, Object.keys(args).sort());
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(16);
  }
}

// 使用
const detector = new LoopDetector({ windowSize: 5, maxRepeats: 2 });

// 在 Agent 主循环中
function onToolCall(toolName: string, args: any) {
  detector.record(toolName, args);
  if (detector.isLooping()) {
    throw new LoopDetectedError('检测到死循环，强制终止');
  }
}
```

**要点**：
- 三种检测模式：完全重复、超阈值重复、ABAB 交替
- 参数哈希要稳定（JSON key 排序）
- 窗口大小可调，过长检测慢，过短漏检
- 检测到后抛错强制终止，由上层决定是否转人工

### Q29 🟡 实现一个意图分类器，要求支持多标签 + 置信度输出。

**考察点**：分类器设计

**参考答案**：

```typescript
interface IntentResult {
  intent: string;
  confidence: number;
  slots: Record<string, any>;
}

class IntentClassifier {
  private intents = [
    'track_waybill', 'urge', 'modify_order', 'consult', 'complaint', 'refund_claim',
  ];

  constructor(private llm: LLM) {}

  async classify(message: string, context?: SessionContext): Promise<IntentResult[]> {
    const prompt = `你是快递客服意图分类器。分析用户输入，输出所有可能的意图（多标签）。

## 意图列表
- track_waybill: 查询运单状态/轨迹/签收
- urge: 催促揽收/派送/中转
- modify_order: 修改地址/电话/收件人/保价
- consult: 咨询运费/时效/网点/禁寄品
- complaint: 投诉破损/丢失/延误/假签收/服务态度
- refund_claim: 退款/理赔

## 槽位定义
- waybillNo: 运单号
- newAddress: 新地址
- newPhone: 新电话
- complaintType: 投诉类型
- refundAmount: 退款金额

## 输出格式（JSON 数组，按置信度降序）
[
  {
    "intent": "意图名",
    "confidence": 0.0-1.0,
    "slots": { "slotName": "value" }
  }
]

## 注意
- 同一输入可能含多个意图（如"催一下并改地址"）
- 置信度 < 0.4 的不输出
- 槽位未在输入中明确出现的填 null，不要编造
- 运单号识别：常见格式 SF/DD/YS + 12位数字，或纯 12-15 位数字

## 用户输入
${message}

## 会话上下文（可选）
${context ? JSON.stringify(context) : '无'}`;

    const result = await this.llm.invoke({
      system: prompt,
      user: message,
      responseFormat: 'json',
    });

    const intents = JSON.parse(result) as IntentResult[];

    // 后处理：过滤低置信度、排序
    return intents
      .filter(i => i.confidence >= 0.4)
      .sort((a, b) => b.confidence - a.confidence);
  }
}
```

**要点**：
- 多标签输出（sigmoid 风格），而非单标签（softmax 风格）
- 槽位提取与意图分类同步完成
- 置信度阈值过滤，避免输出过多低质量意图
- 会话上下文注入，提升准确率（如"上次说的运单"能解析出运单号）
- 提示词中包含槽位定义与运单号格式，提升提取准确率

### Q30 🔴 实现一个简化的 ApprovalManager，支持同步与异步审批。

**考察点**：审批系统设计

**参考答案**：

```typescript
interface ApprovalRequest {
  id: string;
  type: 'modify_address' | 'refund' | 'modify_phone' | 'escalate';
  payload: any;
  requestedBy: string;       // agentId
  requestedAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy?: string;
  decidedAt?: number;
  reason?: string;
}

interface ApprovalManagerOptions {
  mode: 'sync' | 'async';
  timeoutMs: number;          // 异步审批超时
  store: ApprovalStore;
  notifier?: ApproverNotifier;
}

class ApprovalManager {
  private pending = new Map<string, { req: ApprovalRequest; resolve: Function; reject: Function; timer: NodeJS.Timeout }>();

  constructor(private options: ApprovalManagerOptions) {}

  async request(req: Omit<ApprovalRequest, 'id' | 'requestedAt' | 'status'>): Promise<ApprovalResult> {
    const fullReq: ApprovalRequest = {
      ...req,
      id: ulid(),
      requestedAt: Date.now(),
      status: 'pending',
    };

    // 1. 持久化（防止进程重启丢失）
    await this.options.store.save(fullReq);

    // 2. 通知审批人
    if (this.options.mode === 'sync') {
      // 同步：CLI 弹窗 / UI 模态框，等待用户当场决定
      return await this.waitSync(fullReq);
    } else {
      // 异步：发邮件/IM 通知，等待异步回调
      await this.options.notifier?.notify(fullReq);
      return await this.waitAsync(fullReq);
    }
  }

  private waitSync(req: ApprovalRequest): Promise<ApprovalResult> {
    // 同步审批：通过 WebSocket 或 stdin 等待人审
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        resolve({ approved: false, reason: 'sync timeout' });
      }, this.options.timeoutMs);

      this.pending.set(req.id, { req, resolve, reject, timer });
      this.emitSyncPrompt(req);  // 触发 UI 弹窗
    });
  }

  private waitAsync(req: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        // 超时自动拒绝（避免长时间阻塞 Agent）
        this.updateStatus(req.id, 'expired', 'system', 'async timeout');
        resolve({ approved: false, reason: 'async timeout' });
      }, this.options.timeoutMs);

      this.pending.set(req.id, { req, resolve, reject, timer });
    });
  }

  // 异步审批回调
  async decide(reqId: string, decision: { approved: boolean; decidedBy: string; reason?: string }) {
    const pending = this.pending.get(reqId);
    if (!pending) {
      throw new Error('审批请求不存在或已处理');
    }

    clearTimeout(pending.timer);
    this.pending.delete(reqId);

    await this.updateStatus(
      reqId,
      decision.approved ? 'approved' : 'rejected',
      decision.decidedBy,
      decision.reason,
    );

    pending.resolve({
      approved: decision.approved,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
    });
  }

  private async updateStatus(reqId: string, status: ApprovalRequest['status'], decidedBy: string, reason?: string) {
    await this.options.store.update(reqId, {
      status,
      decidedBy,
      decidedAt: Date.now(),
      reason,
    });
  }

  // 进程重启后恢复未决审批
  async recover() {
    const pendingReqs = await this.options.store.queryByStatus('pending');
    for (const req of pendingReqs) {
      // 已超时的直接标记 expired
      if (Date.now() - req.requestedAt > this.options.timeoutMs) {
        await this.updateStatus(req.id, 'expired', 'system', 'recovered as expired');
      }
      // 未超时的重新发起通知
      else {
        await this.options.notifier?.notify(req);
      }
    }
  }
}

// 同步模式使用（CLI 弹窗）
const syncManager = new ApprovalManager({
  mode: 'sync',
  timeoutMs: 30_000,
  store: new FileApprovalStore(),
});

// 异步模式使用（IM 通知 + Webhook 回调）
const asyncManager = new ApprovalManager({
  mode: 'async',
  timeoutMs: 24 * 3600 * 1000,  // 24 小时
  store: new MysqlApprovalStore(),
  notifier: new DingTalkNotifier(),
});
```

**要点**：
- 同步模式：CLI / UI 当场确认，超时短（30s）
- 异步模式：IM/邮件通知 + Webhook 回调，超时长（24h）
- 持久化：进程重启不丢失，可恢复
- 超时默认拒绝：避免长时间阻塞 Agent
- 审计：审批决策必须记录 decidedBy 与原因

---

## 十二、加分项 / 开放讨论

### Q31 🟡 在快递公司落地 Agent，你认为最大的非技术挑战是什么？

**参考答案**：

**最大挑战是「业务侧的信任建立与组织变革」**，而非技术。

| 挑战 | 表现 | 应对 |
|------|------|------|
| 客服坐席抵触 | 担心被替代，不配合数据标注 | 强调「辅助而非替代」，把坐席升级为「Agent 训练师」 |
| 业务规则黑盒 | 老员工的经验未文档化，Agent 学不到 | 设立「业务规则挖掘」岗位，系统化访谈与抽取 |
| KPI 冲突 | Agent 上线后坐席 KPI 受影响 | 调整 KPI 体系，把「Agent 训练」纳入考核 |
| 数据孤岛 | 各系统数据不互通，Agent 拿不到全貌 | 推动数据中台建设，开放数据访问 |
| 合规与责任 | Agent 出错谁负责？客户投诉算谁的 | 制定 Agent 责任归属制度，明确兜底机制 |

**经验**：
- Agent 项目 70% 时间在沟通、对齐、协调，30% 在写代码
- 先找一个有强烈痛点的业务方做 partner，做出标杆后再推广
- 不要追求「替代人」，先做「人的助手」，建立信任后再逐步自动化
- 数据与规则是核心资产，比模型本身更重要

### Q32 🟡 快递 Agent 未来 3 年的演进方向？

**参考答案**：

| 方向 | 现状 | 3 年后 |
|------|------|--------|
| 多模态 | 仅文本 | 文本 + 图片 + 语音（电话客服全自动化） |
| 主动性 | 被动响应 | 主动预测（如预测延误提前通知、推荐改派方案） |
| 个性化 | 千人一面 | 基于 VIP/历史/偏好个性化服务 |
| Agent 协作 | 单 Agent | 多 Agent 协作（客服 + 调度 + 风控联动） |
| 决策权 | 仅查询与简单操作 | 复杂决策（如自动赔付、自动改路由） |
| 知识沉淀 | 静态知识库 | 动态学习（每次会话回流，持续优化） |
| 多端 | 仅 IM/APP | 电话、IoT（车机、扫描枪）、智能音箱 |

**短期突破点**：
1. **语音 Agent**：电话客服是最痛点，语音识别 + Agent 大幅降本
2. **多 Agent 协作**：当前客服、调度、风控各自为战，未来联动
3. **预测性服务**：基于运单状态预测异常，主动通知而非被动响应

**长期挑战**：
1. **可靠性**：Agent 决策仍可能出错，关键场景必须人审
2. **成本**：大模型成本仍高，需要更智能的路由与缓存
3. **监管**：涉及用户数据与资金操作，合规要求越来越严
4. **可解释性**：监管要求能解释每个决策的依据

**个人看法**：Agent 在快递行业的落地会比通用 LLM 更快产生价值，因为业务场景明确、数据丰富、ROI 可量化。但**真正的护城河不是模型，而是业务数据 + 场景知识 + 工程能力**的三位一体。能拿到业务数据、理解快递规则、能工程化落地的团队，会赢。

---

## 面试评估维度建议

| 维度 | 权重 | 考察题目 |
|------|------|----------|
| 业务理解 | 20% | Q1-Q3, Q31 |
| 客服 Agent 设计 | 20% | Q4-Q7, Q24, Q26 |
| 多 Agent 协作 | 15% | Q8-Q10 |
| 调度与风控 | 15% | Q11-Q15 |
| 地址与数据 | 10% | Q16-Q19 |
| 工程实践 | 10% | Q20-Q23, Q25 |
| 编码能力 | 10% | Q27-Q30 |

> 评级标准：
> - **P5（初级）**：能答对业务理解与基础设计题，理解快递链路与 Agent 价值
> - **P6（中级）**：能独立设计单 Agent 场景（如客服 Agent），编码题无障碍
> - **P7（高级）**：能做多 Agent 协作架构，设计高可用与可观测方案，权衡利弊清晰
> - **P8（专家）**：能从业务、组织、技术三维度规划 Agent 落地，对演进方向有深刻思考

---

## 附：场景速查表

| 场景 | 核心挑战 | 关键技术 |
|------|----------|----------|
| 智能客服 | 多意图、降级、成本 | 意图分类 + ReAct + ApprovalManager |
| 异常运单处理 | 多 Agent 协作、高并发 | Blackboard 模式 + Worker 池 |
| 破损理赔 | 多模态、防欺诈 | 图像分析 + 感知哈希 + 图谱 |
| 调度助手 | 优化求解、人机协作 | OR-Tools + 多方案推荐 + 反馈学习 |
| 路由重规划 | 实时响应、影响评估 | 事件驱动 + 分级决策 + 多目标优化 |
| 虚假运单识别 | 准确率与误杀平衡 | 规则 + ML + Agent 三层联防 |
| 地址解析 | 文本理解、知识库匹配 | LLM + POI 知识库 + 别名映射 |
| 运营洞察 | NL2SQL、归因 | 问题拆解 + 多源数据 + 综合归因 |
| 数据早报 | 数据准确、内容稳定 | 数据与生成解耦 + 数字一致性校验 |
| 系统集成 | 解耦、容错 | Adapter + Gateway + 多层降级 |
