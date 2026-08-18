# LangChain / LangGraph 开发工程师 面试题（含答案）

> 基于 LangChain 生态（langchain 0.3.x / langgraph v1.0+ / LangSmith / LangServe）2026 年最新状态编写。
> 难度标记：🟢 基础 / 🟡 进阶 / 🔴 高级 / 🟣 架构设计
> 注意：`create_react_agent` 在 langgraph 0.3.x 已被标记 deprecated，官方推荐迁移到 `langchain` 的 `create_agent`；本题为兼顾历史代码与新项目，两者都会涉及。

---

## 一、LangChain 生态基础

### Q1 🟢 LangChain 生态由哪些部分组成？各自定位是什么？

**考察点**：生态全景认知

**参考答案**：

```
┌─────────────────────────────────────────────┐
│              LangSmith                        │  可观测性 / Eval / Datasets
│              LangGraph Platform               │  托管运行时
├─────────────────────────────────────────────┤
│  langchain (0.3.x)                           │  高层编排 + create_agent
│  langgraph (v1.0+)                           │  Agent 编排引擎 (StateGraph)
│  langchain-community / langchain-openai ...  │  第三方集成
├─────────────────────────────────────────────┤
│  langchain-core (0.3.x)                      │  核心抽象 (Runnable/Message/Tool)
└─────────────────────────────────────────────┘
```

| 包 | 定位 | 关键内容 |
|------|------|------|
| **langchain-core** | 核心抽象 | Runnable、Message、Prompt、Tool、Callback、OutputParser；所有包都依赖它 |
| **langchain** | 高层编排 | 常用 chain/agent 实现；0.3 起提供新的 `create_agent` API |
| **langgraph** | Agent 编排引擎 | 用有向图建模有状态、可恢复、可循环的 workflow（v1.0 于 2025-10 稳定） |
| **langchain-community** | 第三方集成 | 各向量库、文档加载器等社区贡献 |
| **langchain-openai/anthropic** | 厂商集成 | 各模型 provider 适配 |
| **LangSmith** | 可观测平台 | Tracing、Eval、Datasets、实验对比 |
| **LangGraph Platform** | 托管运行时 | checkpoint 持久化、stream API、cron、HITL |

**理解要点**：langchain-core 是地基（定义接口），langchain 是标准库（常用实现），langgraph 是编排引擎（复杂 Agent），LangSmith 是运维平台。新版推荐用 langgraph 做 Agent，而非旧版 langchain 的 AgentExecutor。

### Q2 🟢 langchain-core 中的 Runnable 协议是什么？为什么要有它？

**考察点**：核心抽象理解

**参考答案**：

`Runnable` 是所有可执行组件的**统一接口**：

```python
class Runnable:
    def invoke(self, input, config=None) -> Output: ...      # 同步单次
    def ainvoke(self, input, config=None) -> Output: ...      # 异步单次
    def stream(self, input, config=None) -> Iterator: ...     # 同步流式
    def astream(self, input, config=None) -> AsyncIterator: ...  # 异步流式
    def batch(self, inputs, config=None) -> list[Output]: ... # 批量
    def abatch(self, inputs, config=None) -> list[Output]: ...# 异步批量
```

**为什么要有它**：

1. **统一组合**：prompt、model、parser、retriever、tool 都是 Runnable，可通过 `|`（LCEL）无缝组合
   ```python
   chain = prompt | model | parser  # 三个 Runnable 串联
   ```

2. **自动获得能力**：任何 Runnable 组合后自动拥有 stream / batch / async，无需手写每个变体

3. **非侵入式 Tracing**：通过 `RunnableConfig` 透传 callbacks / tags / metadata，每一步自动作为一个 run 上报到 LangSmith
   ```python
   chain.invoke(input, config={"callbacks": [handler], "tags": ["prod"]})
   ```

4. **组合原语**：内置 `RunnableSequence`（`|`）、`RunnableParallel`（dict）、`RunnablePassthrough`、`RunnableLambda`、`RunnableBranch`

**对比传统方式**：传统写法需为每个组件手写 stream/batch/async 包装，组合时需手动处理类型与错误。Runnable 统一接口后，组件可任意组合且能力自动继承。

### Q3 🟡 LangChain 0.3 相比 0.1/0.2 有哪些关键变化？迁移要注意什么？

**考察点**：版本演进认知

**参考答案**：

**关键变化**：

| 变化 | 说明 |
|------|------|
| 包拆分 (0.2+) | langchain → langchain-core + langchain + langchain-community，集成包独立发布（langchain-openai 等） |
| Python 版本 | 0.3 要求 3.9+；langgraph 1.0 要求 3.10+ |
| 旧 API 弃用 | `LLMChain` / `AgentExecutor` / `ConversationBufferMemory` 等弃用，迁移到 LCEL + LangGraph |
| Agent API | `create_react_agent`（langgraph.prebuilt）→ `create_agent`（langchain），签名相近 |
| StateGraph API | `set_entry_point()` / `set_finish_point()` 删除，改用 `add_edge(START, node)` |

**迁移要点**：

```python
# ❌ 旧 (0.1)
from langchain.chains import LLMChain
from langchain.agents import AgentExecutor
chain = LLMChain(llm=llm, prompt=prompt)
agent = AgentExecutor.from_agent_and_tools(...)

# ✅ 新 (0.3)
chain = prompt | model | parser  # LCEL
from langchain import create_agent  # 或 langgraph 的 create_react_agent
agent = create_agent(model, tools)
```

```python
# ❌ 旧: set_entry_point (已删除)
graph.set_entry_point("agent")

# ✅ 新: add_edge + START
from langgraph.graph import START
graph.add_edge(START, "agent")
```

- 用 `MessagesState` 替代手写消息 TypedDict（内置消息 reducer）
- 检查所有 import 路径：`langchain.llms` → `langchain_openai` / `langchain_community`
- 旧 `ConversationBufferMemory` → LangGraph 的 `MessagesState` + checkpointer

---

## 二、LCEL（LangChain Expression Language）

### Q4 🟡 解释 LCEL 的 `|` 管道组合机制，它和函数组合有什么区别？

**考察点**：LCEL 原理

**参考答案**：

`a | b | c` 等价于 `RunnableSequence(a, b, c)`，每个 Runnable 的输出作为下一个的输入：

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from langchain_core.output_parsers import StrOutputParser

chain = (
    ChatPromptTemplate.from_template("讲个关于{topic}的笑话")
    | ChatOpenAI(model="gpt-4o-mini")
    | StrOutputParser()
)
# 等价于 RunnableSequence(prompt, model, parser)
```

**相比裸函数组合 `c(b(a(x)))` 的优势**：

| 维度 | 函数组合 | LCEL `|` |
|------|----------|----------|
| stream | 需手写 | 自动获得（流式透传） |
| batch | 需手写 | 自动获得 |
| async | 需手写 a 版本 | 自动获得 ainvoke/astream |
| tracing | 需手动插桩 | 自动接入 Callbacks/LangSmith |
| 流式透传 | 无（先攒齐再传） | 有（parser 增量解析 model 的 token 流） |
| 类型 | 弱 | input_schema/output_schema 可推断 |

**流式透传示例**：
```python
# model 逐 token 输出 → parser 增量解析 → 下游逐 chunk 接收
for chunk in chain.stream({"topic": "猫"}):
    print(chunk, end="", flush=True)  # 打字机效果
```

**局限**：LCEL 适合**线性数据流**；复杂控制流（循环、条件跳转、状态分支）应上 LangGraph。

### Q5 🟡 LCEL 如何实现并行与条件分支？

**考察点**：组合原语

**参考答案**：

**并行——RunnableParallel**：
```python
from langchain_core.runnables import RunnableParallel

# 方式 1: dict 字面量（最常用）
chain = {
    "context": retriever | format_docs,   # 检索并格式化
    "question": RunnablePassthrough(),     # 原样传递
} | prompt | model | parser
# 两个分支并行执行，结果按 key 汇总

# 方式 2: 显式 RunnableParallel
chain = RunnableParallel({
    "summary": summarize_chain,
    "translation": translate_chain,
})
```

**条件分支——RunnableBranch**：
```python
from langchain_core.runnables import RunnableBranch

branch = RunnableBranch(
    (lambda x: x["lang"] == "zh", chinese_chain),  # 条件 + 分支
    (lambda x: x["lang"] == "en", english_chain),
    default_chain,  # 兜底
)
```

**更常见：RunnableLambda 内嵌 if/else**：
```python
from langchain_core.runnables import RunnableLambda

chain = RunnableLambda(lambda x: zh_chain if x["lang"]=="zh" else en_chain)
```

**典型 RAG 模式**：
```python
chain = (
    {"context": retriever | format_docs, "question": RunnablePassthrough()}
    | prompt
    | model
    | parser
)
```

**关键区别**：LCEL 的「分支」是**数据流的分叉**（多路并行处理后汇总），不是**状态机的条件跳转**。需要「根据条件跳到不同节点，且可能循环回来」必须用 LangGraph 的 `add_conditional_edges`。

### Q6 🔴 LCEL 链中如何实现真正的逐 token 流式输出？常见坑是什么？

**考察点**：流式实现细节

**参考答案**：

**原理**：`chain.stream(input)` 返回 `Iterator`，逐 chunk yield。流式透传依赖每个 Runnable 实现 `stream` 方法：

```
model.stream() → 逐 token 输出 AIMessageChunk
    ↓
parser.stream() → 增量解析，逐 chunk 输出
    ↓
下游接收
```

**常见坑**：

**坑 1：中间 RunnableLambda 打断流式**
```python
# ❌ 同步处理整段输入，变成先攒齐再输出
chain = model | RunnableLambda(lambda msg: msg.content.upper()) | parser
# model 流式输出 → Lambda 等待完整输入 → 一次性处理 → 打断流式

# ✅ 用 async generator 或 astream
async def upper_fn(msg_stream):
    async for chunk in msg_stream:
        yield chunk.content.upper()
chain = model.astream() | RunnableLambda(upper_fn)
```

**坑 2：JSON output parser 对 partial JSON 容错差**
```python
# ❌ JsonOutputParser 要求完整 JSON 才解析
# 模型流式输出 {"name": "张 → parser 报错

# ✅ 用 partial_json 库增量解析，或用 LangGraph structured output
from partial_json import parse
```

**坑 3：RunnableParallel 中某分支不流式拖慢整体**
```python
# 如果 context 分支（retriever）是同步阻塞的，
# 即使 question 分支可流式，整体也要等 context 完成
{"context": retriever, "question": passthrough} | ...
```

**结论**：真正复杂的流式（文本 + 工具调用交错）建议直接用 LangGraph 的 `stream_mode="messages"`，它能逐 token 输出 LLM 消息并附带 metadata（来源节点等），比 LCEL 更适合 Agent 场景。

---

## 三、LangGraph 核心概念

### Q7 🟡 解释 StateGraph 的工作原理：节点、边、状态如何协作？

**考察点**：LangGraph 基础（对应 v1.0 API）

**参考答案**：

```python
from langgraph.graph import StateGraph, START, END
from typing import TypedDict, Annotated
import operator

# 1. 定义状态
class State(TypedDict):
    messages: Annotated[list, operator.add]  # reducer: 列表拼接
    count: int                                 # 无 reducer: 直接覆盖

# 2. 定义节点（接收 state，返回部分更新）
def node_a(state: State) -> dict:
    return {"count": state["count"] + 1}  # 只返回要更新的 key

def node_b(state: State) -> dict:
    return {"messages": [("user", "hello")]}

# 3. 构建图
graph = StateGraph(State)
graph.add_node("a", node_a)
graph.add_node("b", node_b)
graph.add_edge(START, "a")          # 固定边
graph.add_edge("a", "b")
graph.add_conditional_edges("b",    # 条件边
    lambda state: "a" if state["count"] < 3 else END)

# 4. 编译执行
app = graph.compile()
result = app.invoke({"messages": [], "count": 0})
# → {"messages": [...], "count": 3}
```

**工作原理**：

| 概念 | 说明 |
|------|------|
| **State** | `TypedDict`/dataclass，所有节点共享；key 可指定 reducer（合并策略），无 reducer 直接覆盖 |
| **节点 (node)** | 接收 state、返回 **state 子集**（部分更新）的函数/Runnable |
| **边 (edge)** | `add_edge(src, dst)` 固定跳转；`add_conditional_edges(src, path_fn)` 动态路由 |
| **START / END** | 虚拟入口/出口节点 |
| **reducer 合并** | 节点返回的部分更新经 reducer 合并进全局 state 后，才进入下一节点 |

**执行引擎**：Pregel 风格的图执行引擎。`compile()` 后得到 `CompiledStateGraph`，支持 `invoke` / `stream` / `ainvoke` / `astream`。

### Q8 🟡 什么是 reducer？为什么消息列表要用 `operator.add` 而不是直接覆盖？

**考察点**：状态合并语义

**参考答案**：

**reducer** 决定节点返回的部分更新如何合并进全局 state。

```python
from typing import Annotated
import operator

class State(TypedDict):
    # 有 reducer: 列表拼接 → 每轮 append
    messages: Annotated[list, operator.add]
    # 无 reducer: 直接覆盖 → 后写覆盖前写
    current_step: str
```

**对比**：

```python
# 假设 state = {"messages": [msg1], "current_step": "search"}

# 节点返回 {"messages": [msg2], "current_step": "read"}

# messages 有 reducer (operator.add) → 拼接
# 结果: {"messages": [msg1, msg2], ...}  ✅ 消息累积

# current_step 无 reducer → 覆盖
# 结果: {"current_step": "read"}  ✅ 步骤更新
```

**为什么消息列表要用 `operator.add`**：
- Agent 每轮会产生新消息（user message、AI message、tool message）
- 需要**累积**而非覆盖，否则历史对话丢失
- `operator.add` = 列表拼接，每轮 append

**MessagesState 内置消息 reducer**：
```python
from langgraph.graph import MessagesState
# MessagesState 的 messages 字段自带 reducer:
# - 按 id 去重 + 追加
# - 支持编辑/删除同名消息（相同 id 的消息替换而非重复）
```

**选错 reducer 的后果**：
- 消息列表无 reducer → 每轮覆盖 → **历史丢失**
- 普通列表用 `operator.add` 无去重 → **消息重复**
- 无上限裁剪 → **上下文无限增长**

**自定义 reducer 示例**（容量上限）：
```python
def messages_reducer(existing: list, new: list) -> list:
    combined = existing + new
    return combined[-100:]  # 只保留最近 100 条

class State(TypedDict):
    messages: Annotated[list, messages_reducer]
```

### Q9 🔴 LangGraph 的 functional API（`@entrypoint` / `@task`）和 StateGraph 各适合什么场景？

**考察点**：两种 API 的取舍（2026 新特性）

**参考答案**：

**两种 API 对比**：

```python
# StateGraph：图优先，显式声明节点/边
graph = StateGraph(State)
graph.add_node("planner", plan)
graph.add_node("executor", execute)
graph.add_edge(START, "planner")
graph.add_conditional_edges("planner", lambda s: "executor" if s["ready"] else END)
app = graph.compile(checkpointer=MemorySaver())

# Functional API：代码优先，像写普通函数
from langgraph.func import entrypoint, task

@task
async def plan(input):
    return await llm.ainvoke(...)

@entrypoint(checkpointer=MemorySaver())
async def workflow(input):
    result = await plan(input)
    while not result["ready"]:
        result = await plan(result)
    return result
```

| 维度 | StateGraph | Functional API (`@entrypoint`/`@task`) |
|------|------------|---------------------------------------|
| 风格 | 声明式（先画图再执行） | 命令式（写函数，编译器转图） |
| 可视化 | ✅ 图结构可视化 | ❌ 无图可视化 |
| 子图组合 | ✅ 子图作为节点嵌入 | ⚠️ 需调用其它 entrypoint |
| 多入口 | ✅ 可有多条边从 START | ❌ 单入口函数 |
| 代码紧凑 | ⚠️ 节点/边声明较多 | ✅ 像写普通函数 |
| 循环 | add_edge 形成环 | while/for 循环 |
| 持久化 | ✅ checkpointer | ✅ checkpointer |
| interrupt | ✅ | ✅ @task 内可 interrupt() |

**选型建议**：
- **StateGraph**：需要图可视化、多分支/多 Agent 拓扑、子图组合、复杂条件路由
- **Functional API**：快速原型、线性/简单分支流程、代码更紧凑直观

**共享点**：两者底层共享同一 Pregel 执行引擎，都支持 checkpointer、interrupt、streaming。

**注意**：`@task` 内可调用 `interrupt()`，但跨 task 的状态持久化语义需特别注意——`@task` 的返回值会被持久化，重跑时从 checkpoint 恢复而非重新执行。

---

## 四、Agent 编排

### Q10 🟡 `create_react_agent` 内部生成了什么样的图？什么情况下应该手写 StateGraph？

**考察点**：预构建 Agent 的本质

**参考答案**：

**`create_react_agent` 生成的图结构**：
```
START → agent → tools_condition → tools → agent → tools_condition → END
                    ↓ (无 tool_call)
                   END
```

- **agent 节点**：调用绑定了 tools 的 LLM
- **tools 节点**：`ToolNode` 执行工具调用
- **tools_condition 条件边**：检查最后一条消息，有 `tool_calls` → 路由到 "tools"；无 → END
- **tools → agent 边**：工具结果回填后回到 agent，形成 ReAct 循环

**该手写 StateGraph 的信号**：

| 场景 | 原因 |
|------|------|
| 需要并行 fan-out | 多个子任务同时跑 → 用 `Send`，create_react_agent 不支持 |
| 多 Agent 子图组合 | supervisor 调度多个子 Agent 作为子图 |
| 自定义 state key | 需要不只是 messages 的状态（如 iteration 计数、任务列表） |
| 非 ReAct 控制流 | Plan-Execute / Reflexion 等需要多阶段编排 |
| 复杂 pre/post hook | pre_model_hook/post_model_hook 勉强可，但复杂逻辑手写更清晰 |

**示例：需要手写的场景**
```python
# Plan-Execute 模式：先规划再执行，需手写
graph = StateGraph(State)
graph.add_node("planner", plan_step)      # 规划
graph.add_node("executor", execute_step)  # 执行
graph.add_node("replanner", replan_step)  # 重新规划
graph.add_edge(START, "planner")
graph.add_edge("planner", "executor")
graph.add_conditional_edges("executor",
    lambda s: "replanner" if s["steps_left"] > 0 else END)
graph.add_conditional_edges("replanner",
    lambda s: "executor" if s["need_replan"] else END)
```

### Q11 🔴 如何防止 LangGraph Agent 无限循环？有哪些兜底机制？

**考察点**：循环控制

**参考答案**：

```python
from langgraph.errors import GraphRecursionError

try:
    result = app.invoke(
        input,
        config={"recursion_limit": 25}  # 默认 25 步
    )
except GraphRecursionError:
    # 超限兜底
    result = {"answer": "Agent 执行步数超限，已终止"}
```

**多层兜底机制**：

| 层级 | 机制 | 说明 |
|------|------|------|
| 框架层 | `recursion_limit` | 限制图执行步数（超边数），默认 25，超限抛 `GraphRecursionError` |
| 工具层 | `timeout` + `retry_policy` | 单工具超时 + 重试策略（`RetryPolicy`） |
| 业务层 | state 中维护计数 | 节点内判断 iteration 后主动 `Command(goto=END)` |
| 检测层 | 死循环检测 | 记录最近 K 步 (tool_name, args) 哈希，重复强制终止 |
| 预算层 | token 累计 | `post_model_hook` 累计 token，超预算 `Command(goto=END)` |

**注意 recursion_limit 的计数**：
- 计的是「超边数」（edge traversals），不是「模型调用数」
- 一个 agent→tools→agent 循环算 3 步（agent→tools 1 步 + tools→agent 1 步 + agent→? 1 步）
- 25 步约等于 ~8 轮 ReAct 循环

**业务层兜底示例**：
```python
def agent_node(state):
    if state.get("iteration", 0) >= 10:
        return Command(goto=END, update={"answer": "已达最大轮次"})
    response = model.invoke(state["messages"])
    return {"messages": [response], "iteration": state.get("iteration", 0) + 1}
```

**死循环检测示例**：
```python
def check_loop(state):
    recent = [(tc["name"], hash(str(tc["args"]))) for tc in state["messages"][-1].tool_calls]
    history = state.get("recent_calls", [])
    if recent and recent == history[-1:]:  # 连续重复
        return Command(goto=END, update={"answer": "检测到死循环"})
    return {"recent_calls": history + recent}
```

### Q12 🟡 `Command` 对象解决了什么问题？举例说明其用法。

**考察点**：Command 统一抽象（v1.0 核心）

**参考答案**：

**`Command` 解决的问题**：把「状态更新 + 动态路由 + 恢复」三件事合并为一个返回值。

旧版写法（割裂）：
```python
# 旧：返回 dict 更新状态 + 用 add_conditional_edges 声明路由
def node(state):
    return {"status": "pending"}  # 只更新状态

# 路由在图定义时声明，无法在节点内动态决定
graph.add_conditional_edges("node", lambda s: "review" if s["status"]=="pending" else END)
```

**Command 新写法（统一）**：
```python
from langgraph.types import Command

def route(state) -> Command:
    if state["needs_review"]:
        return Command(
            update={"status": "pending"},
            goto="human_review"  # 动态路由
        )
    return Command(
        update={"status": "done"},
        goto=END
    )

# 图定义更简洁，不需要 add_conditional_edges
graph.add_node("route", route)
```

**三大字段**：

| 字段 | 作用 |
|------|------|
| `update=` | 状态更新（经 reducer 合并） |
| `goto=` | 下一个节点（单个或列表，列表触发并行） |
| `resume=` | 人机协作恢复值 |

**与 `add_conditional_edges` 的区别**：

| 维度 | add_conditional_edges | Command |
|------|----------------------|---------|
| 路由决策时机 | 边编译期固定（声明式） | 运行时决定（命令式） |
| 灵活性 | 路由逻辑需提前声明 | 节点内随时决定 |
| 静态可分析 | ✅ 图结构可静态分析 | ❌ 运行时才知道走向 |
| 适用 | 固定模式路由 | 复杂动态决策 |

**resume 用法**（人机协作）：
```python
def approve_node(state) -> Command:
    decision = interrupt({"request": "是否继续?"})  # 暂停
    # resume 后继续执行
    return Command(resume=decision)  # 把恢复值传给后续
```

### Q13 🔴 `Send` 和 `Command(goto=[...])` 都能并行，区别在哪？

**考察点**：fan-out 语义

**参考答案**：

```python
from langgraph.types import Send, Command

# Send: map-reduce 式 fan-out，每个实例携带独立输入
def planner(state) -> list[Send]:
    return [Send("researcher", q) for q in state["subquestions"]]
    # 每个 subquestion 触发一个独立的 researcher 实例，参数不同

# Command(goto=[...]): 并行跳转到不同节点，共享同一 state
def dispatch(state) -> Command:
    return Command(goto=["translate", "summarize"])
    # 两个不同节点并行执行，看到相同的 state
```

| 维度 | `Send(node, arg)` | `Command(goto=["a", "b"])` |
|------|-------------------|---------------------------|
| 并行对象 | 同一节点的多个实例 | 不同节点各一个实例 |
| 输入 | 每个实例携带**独立参数** (arg) | 各分支**共享同一 state** |
| 典型场景 | 对列表每个元素并行处理（map-reduce） | 同时进入多个不同处理分支 |
| 结果汇聚 | 各实例返回值通过 reducer 汇聚回 state | 各分支返回值各自更新 state |

**关键区别**：
- **Send**：节点函数收到的参数不同（`def researcher(state, question)` 中的 `question` 是 Send 的 arg）
- **Command**：各分支看到相同的 state，没有独立参数

**示例对比**：
```python
# 场景: 研究多个子问题
# ✅ 用 Send
def plan(state):
    return [Send("research", q) for q in ["AI趋势", "市场分析", "竞品调研"]]
    # 3 个 research 实例并行，各研究不同问题

# 场景: 同时翻译和摘要
# ✅ 用 Command
def process(state):
    return Command(goto=["translate", "summarize"])
    # translate 和 summarize 并行，都处理同一文档
```

**汇聚**：Send 的多个实例结果通过 state 的 reducer（如 `operator.add`）自动合并。

---

## 五、工具调用（Tool Calling）

### Q14 🟡 LangChain 中定义工具有哪几种方式？推荐哪种？

**考察点**：工具定义规范

**参考答案**：

**三种方式**：

```python
# 方式 1: @tool 装饰器（✅ 推荐）
from langchain_core.tools import tool

@tool
def search_weather(city: str, unit: str = "celsius") -> str:
    """查询指定城市的天气。

    Args:
        city: 城市名称，如 "北京"
        unit: 温度单位，celsius 或 fahrenheit
    """
    # docstring 会作为工具描述给模型看
    return f"{city} 今天 25°{unit[0].upper()}"

# 方式 2: 继承 BaseTool（适合复杂工具）
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词")
    limit: int = Field(default=10, description="结果数量")

class SearchTool(BaseTool):
    name: str = "search"
    description: str = "搜索内部文档"
    args_schema: type[BaseModel] = SearchInput

    def _run(self, query: str, limit: int = 10) -> str:
        return do_search(query, limit)

    async def _arun(self, query: str, limit: int = 10) -> str:
        return await do_search_async(query, limit)

# 方式 3: StructuredTool.from_function（介于两者之间）
from langchain_core.tools import StructuredTool
search = StructuredTool.from_function(
    func=do_search,
    name="search",
    description="搜索内部文档",
    args_schema=SearchInput,
)
```

**推荐 `@tool`**：
- 从函数签名 + docstring 自动推断 name/description/args_schema
- 配合 type hints + Pydantic v2 自动生成 JSON Schema，模型可见性最好
- 代码最简洁

**进阶用法**：
```python
# InjectedState: 让框架自动注入图状态，不暴露给模型
from langgraph.prebuilt import InjectedState

@tool
def update_profile(state: Annotated[dict, InjectedState], name: str) -> str:
    """更新用户资料"""  # state 不出现在模型可见的参数中
    return f"已更新 {name}，当前会话: {state['session_id']}"

# return_direct: 工具结果直接返回，不经过模型再处理
@tool(return_direct=True)
def get_time() -> str:
    """获取当前时间"""
    return datetime.now().isoformat()
```

### Q15 🟡 ToolNode 是如何工作的？它如何处理并行工具调用？

**考察点**：ToolNode 机制

**参考答案**：

```python
from langgraph.prebuilt import ToolNode

# ToolNode 是预构建节点
tool_node = ToolNode([search_tool, calc_tool, file_tool])
```

**工作流程**：
```
1. 从 state["messages"] 读取最后一条 AIMessage
2. 提取 AIMessage.tool_calls（可能有多个）
3. 并行执行所有 tool_call
4. 每个结果包装成 ToolMessage（带 tool_call_id 关联）
5. 返回 {"messages": [tool_msg1, tool_msg2, ...]}
```

**并行处理**：
```python
# 模型一轮可能输出多个工具调用
AIMessage(tool_calls=[
    {"name": "search", "args": {"q": "weather"}, "id": "call_1"},
    {"name": "calculate", "args": {"expr": "2+2"}, "id": "call_2"},
])

# ToolNode 并行执行（asyncio.gather 或线程池）
# 结果:
[
    ToolMessage(content="北京 25°C", tool_call_id="call_1"),
    ToolMessage(content="4", tool_call_id="call_2"),
]
```

**错误处理**：
```python
# 工具抛错默认转为 ToolMessage（错误信息），让模型自行处理
try:
    result = tool.invoke(args)
except Exception as e:
    # 默认: 返回错误信息作为 ToolMessage
    return ToolMessage(content=f"Error: {e}", tool_call_id=tc["id"])

# 可配置 handle_tool_errors
ToolNode(tools, handle_tool_errors=True)   # 返回错误信息（默认）
ToolNode(tools, handle_tool_errors=False)  # 抛错中断图
ToolNode(tools, handle_tool_errors=handler) # 自定义处理函数
```

**与 `tools_condition` 配合**：
```python
from langgraph.prebuilt import tools_condition

# tools_condition 判断最后一条消息是否有 tool_calls
# 有 → 返回 "tools"（路由到 ToolNode）
# 无 → 返回 END
graph.add_conditional_edges("agent", tools_condition)
```

### Q16 🔴 工具调用的参数校验失败时，LangChain/LangGraph 如何处理？如何让模型自我修正？

**考察点**：鲁棒性

**参考答案**：

**默认机制**：
```python
@tool
def search(query: str, limit: int) -> str:
    """搜索"""
    ...

# 模型输出: {"query": "test", "limit": "10"}  ← limit 是字符串而非 int
# Pydantic 校验失败 → 抛 ToolException
# ToolNode 默认把 ToolException 转成 ToolMessage（错误信息）回填
# 模型下一轮看到错误后通常会修正参数重试
```

**自我修正流程**：
```
模型输出 tool_call(args 不合法)
    ↓
Pydantic 校验失败 → ToolException
    ↓
ToolNode 把错误转为 ToolMessage: "limit must be int, got str"
    ↓
模型看到错误 → 下一轮修正为 {"limit": 10} 重新调用
    ↓
校验通过 → 正常执行
```

**防止无限重试**：
```python
# 方式 1: 配合 recursion_limit（框架兜底）
config = {"recursion_limit": 25}

# 方式 2: state 中记录同工具失败次数
def tool_node_with_limit(state):
    fail_count = state.get("tool_fail_count", {})
    for tc in state["messages"][-1].tool_calls:
        key = f"{tc['name']}:{tc['id']}"
        if fail_count.get(key, 0) >= 2:
            return Command(goto=END, update={"answer": "参数多次错误，请手动提供"})
    ...
```

**进阶：ValidationNode 预校验**：
```python
from langgraph.prebuilt import ValidationNode

# 在进入 ToolNode 前预校验，把校验错误直接作为 feedback
# 避免浪费一次工具执行
validation_node = ValidationNode(tools)
graph.add_node("validate", validation_node)
graph.add_edge("agent", "validate")  # agent → validate → tools
graph.add_conditional_edges("validate", ...)
```

**强约束场景**：
```python
# 用 with_structured_output 让模型直接输出结构化结果（非工具调用路径）
# 适合不需要工具循环的场景
structured_model = model.with_structured_output(SearchInput)
result = structured_model.invoke("搜索天气，限制10条")  # 直接输出 SearchInput 对象
```

---

## 六、RAG（检索增强生成）

### Q17 🟡 描述一个完整的 RAG 流程，每一步有哪些选择？

**考察点**：RAG 全流程

**参考答案**：

```
文档加载 → 切分 → 嵌入 → 存储 → 检索 → 生成
```

| 步骤 | 选择 | 推荐 |
|------|------|------|
| **加载 (Loader)** | PDF/HTML/Markdown/DB/Notion | `DirectoryLoader` + 对应 parser |
| **切分 (Splitter)** | RecursiveCharacter / 语义切分 / 结构切分 | `RecursiveCharacterTextSplitter`（默认） |
| **嵌入 (Embedding)** | OpenAI / Cohere / BGE / Jina | 按语言和领域选 |
| **存储 (VectorStore)** | FAISS / Chroma / pgvector / Pinecone / Milvus | FAISS（本地）/ pgvector（生产） |
| **检索 (Retriever)** | 纯向量 / hybrid / rerank / metadata 过滤 | hybrid + rerank |
| **生成** | prompt + model + parser | LCEL 链 |

**完整代码示例**：
```python
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnablePassthrough

# 1. 加载 + 切分
splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
chunks = splitter.split_documents(docs)

# 2. 嵌入 + 存储
embeddings = OpenAIEmbeddings()
vectorstore = FAISS.from_documents(chunks, embeddings)
retriever = vectorstore.as_retriever(search_kwargs={"k": 5})

# 3. 生成链
prompt = ChatPromptTemplate.from_template("""
基于以下上下文回答问题：
{context}
问题：{question}
""")
def format_docs(docs):
    return "\n\n".join(d.page_content for d in docs)

rag_chain = (
    {"context": retriever | format_docs, "question": RunnablePassthrough()}
    | prompt
    | ChatOpenAI(model="gpt-4o-mini")
    | StrOutputParser()
)

answer = rag_chain.invoke("什么是 RAG？")
```

**常见增强**：Multi-Query / HyDE / Parent-Child 分块 / 时间加权 / Self-Query。

### Q18 🔴 Naive RAG 的检索质量瓶颈在哪？如何系统性提升？

**考察点**：RAG 进阶优化

**参考答案**：

**瓶颈分析**：
1. **切分粒度不当**：太碎丢失上下文，太长稀释信号
2. **嵌入对领域不敏感**：通用 embedding 对代码/术语/专有名词理解差
3. **单路检索召回率低**：纯向量检索对精确关键词弱
4. **查询表达差**：用户原始 query 与文档语言风格不匹配

**系统性优化方案**：

```
用户 Query
    ↓
[查询改写] Multi-Query / HyDE / Step-back
    ↓
[混合检索] BM25 + 向量双路召回
    ↓
[重排] Cross-encoder Rerank TopK → TopN
    ↓
[上下文组装] Parent-Child 扩展 / metadata 注入
    ↓
[生成] LLM
```

**1. 查询改写**：
```python
# Multi-Query: LLM 生成多个查询变体，并行检索取并集
multi_query = "生成3个语义相同的变体查询"

# HyDE: 先让 LLM 生成假设答案，用答案去检索（答案与文档语言更接近）
hyde = "先回答这个问题（假设性），用回答检索"

# Step-back: 先问更抽象的问题
# 原始: "GPT-4 的上下文窗口多大" → Step-back: "大语言模型的上下文窗口"
```

**2. 混合检索**：
```python
from langchain.retrievers import EnsembleRetriever
# BM25 (关键词) + 向量 (语义)，RRF 融合
hybrid_retriever = EnsembleRetriever(
    retrievers=[bm25_retriever, vector_retriever],
    weights=[0.4, 0.6],
)
```

**3. Rerank**：
```python
from langchain.retrievers import ContextualCompressionRetriever
from langchain_cohere import CohereRerank

# 检索 TopK(20) → rerank → TopN(5)
compression_retriever = ContextualCompressionRetriever(
    base_compressor=CohereRerank(top_n=5),
    base_retriever=hybrid_retriever,
)
```

**4. 分块策略**：
- **Parent-Child**：检索小块（精确匹配），返回大块（提供上下文）
- **语义切分**：按语义边界切分而非固定长度

**5. 评估闭环**：
```python
# 用 LangSmith / RAGAS 评估
# 指标: context recall / precision / faithfulness / answer relevance
# 持续优化切分策略、检索参数、prompt
```

### Q19 🟡 如何在 LangGraph 中实现一个「检索 → 判断是否需要再检索」的自纠正 RAG（CRAG / Self-RAG）？

**考察点**：Agentic RAG

**参考答案**：

```python
from langgraph.graph import StateGraph, START, END
from typing import TypedDict, Annotated
import operator

class State(TypedDict):
    question: str
    documents: list
    generation: str
    retries: int

def retrieve(state):
    docs = retriever.invoke(state["question"])
    return {"documents": docs}

def grade_documents(state):
    # LLM 评分每个文档的相关性
    relevant = []
    for doc in state["documents"]:
        score = grader.invoke({"question": state["question"], "doc": doc})
        if score["relevant"]:
            relevant.append(doc)
    return {"documents": relevant}

def transform_query(state):
    # 查询改写
    new_q = rewriter.invoke({"question": state["question"]})
    return {"question": new_q, "retries": state.get("retries", 0) + 1}

def generate(state):
    answer = llm.invoke({"context": state["documents"], "question": state["question"]})
    return {"generation": answer}

def decide_after_grade(state):
    if len(state["documents"]) >= 2:  # 相关文档足够
        return "generate"
    elif state.get("retries", 0) < 2:  # 可重试
        return "transform_query"
    else:  # 重试耗尽，兜底生成
        return "generate"

# 构建图
graph = StateGraph(State)
graph.add_node("retrieve", retrieve)
graph.add_node("grade", grade_documents)
graph.add_node("transform_query", transform_query)
graph.add_node("generate", generate)

graph.add_edge(START, "retrieve")
graph.add_edge("retrieve", "grade")
graph.add_conditional_edges("grade", decide_after_grade,
    {"generate": "generate", "transform_query": "transform_query"})
graph.add_edge("transform_query", "retrieve")  # 改写后重新检索
graph.add_edge("generate", END)

app = graph.compile()
```

**相比线性 RAG 的价值**：
- 加入「检索质量评估 + 查询改写」的**循环**
- 检索结果不好时自动改写查询重检索，而非硬生成
- 这正是 LangGraph 相对 LCEL 的核心优势：**循环 + 条件跳转**

**进阶（CRAG）**：检索低质量时回退到 web search：
```python
def decide_after_grade(state):
    if len(state["documents"]) < 2:
        return "web_search"  # 回退到网络搜索
    return "generate"
```

---

## 七、记忆与持久化

### Q20 🟡 LangGraph 的 Checkpointer 和 Store 有什么区别？

**考察点**：两层持久化

**参考答案**：

| 维度 | Checkpointer | Store |
|------|--------------|-------|
| **定位** | 短期会话状态 | 长期跨会话记忆 |
| **粒度** | 按 `thread_id` 存图状态快照 | 按 `namespace + key` 存任意对象 |
| **用途** | 断点续跑、时间旅行、HITL 恢复 | 跨会话用户偏好、长期事实 |
| **实现** | InMemorySaver / SqliteSaver / PostgresSaver | InMemoryStore / PostgresStore |
| **检索** | 按 thread_id + checkpoint_id | 支持语义搜索（向量索引） |
| **自动触发** | 每个节点执行完自动写 | 需手动 put/get |

**类比理解**：
- Checkpointer = **短期记忆**（当前对话的上下文，断点能恢复）
- Store = **长期记忆**（跨对话记住的用户信息）

```python
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

# Checkpointer: 让图可恢复
app = graph.compile(checkpointer=InMemorySaver())

# Store: 跨会话记忆
app = graph.compile(
    checkpointer=InMemorySaver(),
    store=InMemoryStore(),  # 节点内可 store.put/search
)
```

### Q21 🟡 如何实现「同一用户跨会话记住偏好」的长期记忆？

**考察点**：Store 实战

**参考答案**：

```python
from langgraph.store.memory import InMemoryStore
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.prebuilt import InjectedStore
from typing import Annotated

store = InMemoryStore()  # 生产用 PostgresStore（带向量索引）

# 1. 写入记忆
def save_preference(state, store: Annotated[BaseStore, InjectedStore]):
    user_id = state["user_id"]
    namespace = ("user", user_id)
    # 从对话中提取偏好
    preference = extract_preference(state["messages"])
    if preference:
        store.put(namespace, f"pref_{preference.key}", {
            "type": "preference",
            "content": preference.content,
            "created_at": datetime.now(),
        })
    return state

# 2. 检索记忆
def load_memories(state, store: Annotated[BaseStore, InjectedStore]):
    user_id = state["user_id"]
    namespace = ("user", user_id)
    # 语义搜索相关记忆
    memories = store.search(
        namespace,
        query=state["messages"][-1].content,  # 用最新消息检索
        limit=5,
    )
    # 注入到 system prompt
    memory_text = "\n".join(f"- {m.value['content']}" for m in memories)
    return {"messages": [SystemMessage(f"已知用户信息:\n{memory_text}")]}

# 3. 编译图，注入 store
app = graph.compile(
    checkpointer=InMemorySaver(),
    store=store,
)
```

**流程**：
```
用户消息进来 → load_memories 检索相关长期记忆 → 注入 system prompt
    → 模型生成回复 → save_preference 提取新偏好 → 写入 Store
```

**生产化要点**：
- `InMemoryStore` 开发用，生产换 `PostgresStore`（带向量索引，支持语义搜索）
- 记忆条目带 metadata（来源、时间、置信度）便于过滤
- namespace 设计：`("user", user_id)` 或 `("user", user_id, "topic", topic_name)`
- 记忆去重：写入前 search 相似记忆，重复则合并更新

### Q22 🔴 Checkpointer 如何支持「时间旅行」调试？实际怎么用？

**考察点**：checkpoint 历史

**参考答案**：

```python
# 每个节点的执行都会产生一个 checkpoint 快照
app = graph.compile(checkpointer=InMemorySaver())
config = {"configurable": {"thread_id": "thread-1"}}

# 执行图
result = app.invoke(input, config)

# 获取所有历史快照（按时间倒序）
for snapshot in app.get_state_history(config):
    print(f"Checkpoint: {snapshot.config['configurable']['checkpoint_id']}")
    print(f"  Node: {snapshot.next}")        # 下一步要执行的节点
    print(f"  Values: {snapshot.values}")     # 当时的 state
    print(f"  Tasks: {snapshot.tasks}")       # 待执行任务
```

**时间旅行**：回到某个历史点重新执行
```python
# 找到出错前的 checkpoint
target_snapshot = list(app.get_state_history(config))[5]  # 第 5 个快照
target_config = target_snapshot.config  # 含特定 checkpoint_id

# 从该点「分叉」重跑（不覆盖原历史，生成新分支）
# 传入 None 作为输入，表示从 checkpoint 继续
result = app.invoke(None, target_config)
```

**修改重跑**（what-if 分析）：
```python
# 修改历史 state 后重跑
app.update_state(
    target_config,
    values={"documents": [modified_doc]},  # 注入修改后的文档
    as_node="retrieve",  # 假装是 retrieve 节点产出的
)
# 从修改后的 state 继续
result = app.invoke(None, target_config)
```

**实战价值**：
1. **调试决策错误**：Agent 在第 3 步选错了工具 → 回到第 2 步，检查当时的 state，理解为什么模型做了错误决策
2. **What-if 分析**：「如果当时检索到的是另一个文档，结果会怎样」→ 修改 state 重跑
3. **分支对比**：从同一点分叉，跑不同参数，对比结果

**LangSmith 集成**：LangSmith 提供可视化时间旅行，在 trace 视图中点击任意节点即可「replay from here」。

---

## 八、人机协作（Human-in-the-Loop）

### Q23 🟡 LangGraph 的 `interrupt()` 机制如何工作？

**考察点**：HITL 核心机制

**参考答案**：

```python
from langgraph.types import interrupt, Command

def human_approval_node(state):
    # 1. 暂停执行，把 value 返回给调用方
    decision = interrupt({
        "type": "approval",
        "request": f"确认执行操作：{state['action']}？",
    })

    # 2. 调用方人工决策后，通过 Command(resume=...) 恢复
    # interrupt() 返回的值就是 resume 传入的值
    # 节点代码像「同步等待」一样继续执行

    if decision["approved"]:
        return {"result": do_action(state["action"])}
    else:
        return {"result": "用户拒绝"}
```

**工作原理**：
```
节点执行到 interrupt(value)
    ↓
图暂停，state 被 Checkpointer 持久化（含 interrupts 信息）
    ↓
invoke/stream 返回，带 interrupts 数据给调用方
    ↓
调用方人工决策
    ↓
调用方传 Command(resume=decision) 恢复执行
    ↓
interrupt() 返回 decision 值，节点继续执行
```

**三种中断方式对比**：

| 方式 | 粒度 | 用法 |
|------|------|------|
| `interrupt_before=["node"]` | 节点级（执行前停） | `compile(interrupt_before=["tools"])` |
| `interrupt_after=["node"]` | 节点级（执行后停） | `compile(interrupt_after=["agent"])` |
| `interrupt(value)` | 函数级（节点内任意位置停） | 节点函数内调用 |

`interrupt()` 最灵活：可以在节点内部任意位置暂停，且能携带任意 value 给调用方。

### Q24 🔴 设计一个「危险操作需人工确认」的审批流程，要求支持超时和拒绝。

**考察点**：完整 HITL 设计

**参考答案**：

```python
import asyncio
from langgraph.types import interrupt, Command
from langgraph.prebuilt.interrupt import ActionRequest, HumanInterrupt

def risky_action_node(state):
    # 1. 构造审批请求
    proposal = ActionRequest(
        action="delete_file",
        args={"path": state["target_path"]},
    )

    # 2. interrupt 暂停，等待人工决策
    decision = interrupt({
        "type": "approval",
        "request": proposal,
        "description": f"将删除文件: {state['target_path']}",
    })

    # 3. 根据决策执行
    if decision["approved"]:
        result = delete_file(state["target_path"])
        return {"messages": [ToolMessage(f"已删除: {result}")]}
    else:
        return {"messages": [ToolMessage(f"用户拒绝: {decision.get('reason', '')}")]}

# 调用方：超时控制
async def run_with_approval():
    config = {"configurable": {"thread_id": "t1"}}

    # 第一次 invoke，会在 interrupt 处暂停
    try:
        result = await asyncio.wait_for(
            app.ainvoke(input, config),
            timeout=300,  # 5 分钟超时
        )
    except asyncio.TimeoutError:
        # 超时自动拒绝
        result = await app.ainvoke(
            Command(resume={"approved": False, "reason": "审批超时"}),
            config,
        )

    # 正常审批流程
    state = app.get_state(config)
    if state.interrupts:
        # 推送审批请求到 IM/工单系统
        approval_request = state.interrupts[0].value
        send_to_im(approval_request)

        # 等待人工回调
        decision = await wait_for_human_decision(approval_request)
        result = await app.ainvoke(
            Command(resume=decision),
            config,
        )
```

**完整设计要点**：

1. **审批请求**：用 `ActionRequest` 标准化（工具名 + 参数），便于前端渲染
2. **超时**：外层 `asyncio.wait_for` 包裹 invoke，超时自动传 `{"approved": False}` 拒绝
3. **拒绝**：resume 传 `{"approved": False, "reason": "..."}`，节点返回拒绝信息让模型另寻方案
4. **多级审批**：多次 `interrupt()` 串联
   ```python
   def multi_approval(state):
       # 第一级：主管审批
       mgr = interrupt({"level": "manager", "request": ...})
       if not mgr["approved"]: return rejected

       # 第二级：财务审批
       fin = interrupt({"level": "finance", "request": ...})
       if not fin["approved"]: return rejected

       return execute()
   ```
5. **生产化**：审批请求推送到 IM/工单系统，人工回调触发 `Command(resume=...)`

### Q25 🟡 `interrupt()` 能在工具（ToolNode 内）中使用吗？有什么限制？

**考察点**：HITL 边界

**参考答案**：

**可以**。工具函数内调用 `interrupt()`，ToolNode 执行到该工具时会暂停整个图：

```python
from langgraph.prebuilt import InjectedState
from typing import Annotated

@tool
def delete_file(path: str, state: Annotated[dict, InjectedState]) -> str:
    """删除文件"""
    # 危险操作，需人工确认
    decision = interrupt({
        "type": "approval",
        "action": "delete_file",
        "args": {"path": path},
    })
    if decision["approved"]:
        os.remove(path)
        return f"已删除 {path}"
    return "用户拒绝删除"

# ToolNode 执行到 delete_file 时，interrupt() 暂停整个图
# 人工确认后 resume，delete_file 继续执行
```

**限制**：

1. **需图执行上下文**：工具必须在 LangGraph 执行上下文内（有 checkpointer + thread_id）。纯 LCEL 链中 `interrupt()` 不生效（没有 checkpoint 机制）

2. **并行工具调用复杂**：
   ```python
   # 模型一轮输出多个工具调用，其中两个都有 interrupt
   AIMessage(tool_calls=[delete_file("a"), delete_file("b")])
   # ToolNode 并行执行 → 两个 interrupt 同时触发
   # 需逐个 resume（multi-interrupt），语义复杂
   ```

3. **resume 值只返回给发起 interrupt 的工具**：并行工具中，resume 值只传给对应的 interrupt，其它工具不受影响

4. **实践建议**：
   - 危险工具用 `InjectedState` 获取图状态，内部 `interrupt()`
   - 非危险工具正常执行（不 interrupt）
   - 避免在同一轮并行调用多个需审批的工具（改为串行）

---

## 九、流式处理

### Q26 🟡 LangGraph 的 `stream_mode` 有哪些？各自适用场景？

**考察点**：流式模式

**参考答案**：

| 模式 | 输出 | 适用 |
|------|------|------|
| `values` | 每步后的完整 state | 看整体演进 |
| `updates` | 每步的增量更新（节点返回值） | 看每节点产出 |
| `messages` | LLM 的逐 token 消息 | **UI 打字机效果**（最常用） |
| `custom` | 节点内 `get_stream_writer()` 自定义事件 | 业务自定义进度 |
| `debug` | 任务调度细节 | 调试图执行 |
| `tasks` | 任务生命周期事件 | 监控并行任务 |

**使用示例**：
```python
# 单模式
for chunk in app.stream(input, config, stream_mode="updates"):
    print(chunk)  # {"node_name": {"key": "value"}}

# 多模式同时（返回元组）
for mode, chunk in app.stream(input, config, stream_mode=["messages", "updates"]):
    if mode == "messages":
        print(chunk[0].content, end="")  # 逐 token
    elif mode == "updates":
        print(f"\n节点更新: {chunk}")

# 异步
async for chunk in app.astream(input, config, stream_mode="messages"):
    print(chunk[0].content, end="", flush=True)
```

**`messages` 模式详解**：
```python
for message, metadata in app.stream(input, config, stream_mode="messages"):
    print(message.content, end="")
    # metadata 含:
    # - langgraph_node: 来源节点名
    # - langgraph_step: 步骤号
    # - 便于区分是哪个节点产出的 token
```

**选型建议**：
- 前端打字机效果 → `messages`
- 看每节点产出 → `updates`
- 工具执行进度 → `custom`（配合 `get_stream_writer()`）
- 调试图执行 → `debug`

### Q27 🔴 如何在 LangGraph 中实现「工具执行进度实时上报到前端」？

**考察点**：custom stream 实战

**参考答案**：

```python
from langgraph.config import get_stream_writer

# 节点/工具内用 get_stream_writer() 写自定义事件
@tool
def long_running_search(query: str) -> str:
    """搜索（耗时操作）"""
    writer = get_stream_writer()

    steps = ["解析查询", "检索索引", "排序结果", "格式化输出"]
    results = []

    for i, step in enumerate(steps):
        # 上报进度
        writer({
            "type": "progress",
            "step": step,
            "progress": (i + 1) / len(steps),
            "query": query,
        })
        result = do_step(step, query)
        results.append(result)

    return "\n".join(results)

# 前端同时收进度与文本
async for mode, chunk in app.astream(
    input, config, stream_mode=["custom", "messages"]
):
    if mode == "custom":
        # 进度事件
        print(f"\r进度: {chunk['progress']:.0%} - {chunk['step']}", end="")
    elif mode == "messages":
        # LLM 文本（打字机效果）
        print(chunk[0].content, end="")

# 输出示例:
# 进度: 25% - 解析查询
# 进度: 50% - 检索索引
# 进度: 75% - 排序结果
# 进度: 100% - 格式化输出
# 根据查询结果，找到了以下相关文档...
```

**关键要点**：
1. **`get_stream_writer()`**：在节点/工具函数内调用，写入 custom stream 事件
2. **必须在图执行上下文内调用**：脱离上下文（如独立线程）无效
3. **前端用 `stream_mode=["custom", "messages"]`** 同时收进度与文本
4. **配合 LangGraph Platform**：SSE/WebSocket 推送到浏览器
5. **自定义事件结构**：可设计 `{type, progress, step, detail}` 等，前端按 type 渲染不同 UI

---

## 十、可观测性（LangSmith）

### Q28 🟡 LangSmith 的 tracing 和 LangGraph 原生 stream 是什么关系？

**考察点**：可观测性层次

**参考答案**：

| 维度 | LangGraph stream | LangSmith tracing |
|------|------------------|-------------------|
| 定位 | 运行时数据流 | 执行链路记录 |
| 面向 | 应用前端（驱动 UI 渲染） | 开发调试/监控 |
| 持久化 | 随执行结束而消失 | 持久化存储可回溯 |
| 实时性 | 实时推送 | 异步上报 |
| 内容 | state 更新、token 流 | 完整调用树（输入输出、耗时、token、错误） |

**关系：互补，不替代**

```
Agent 执行
    ├── stream（在线）→ 前端 UI 实时渲染
    │                    随执行结束消失
    │
    └── tracing（离线）→ LangSmith 持久化存储
                          可回溯分析、对比、eval
```

**自动接入**：
```python
import os
os.environ["LANGSMITH_TRACING"] = "true"
os.environ["LANGSMITH_API_KEY"] = "ls__xxx"

# LangChain/LangGraph 内置 Callbacks 自动上报
# 无需改代码，每个 Runnable/节点/工具调用自动作为一个 run 记录
result = app.invoke(input)  # 自动上报 trace
```

**Trace 结构**：
```
Run (根: graph invoke)
├── Run (节点: agent)
│   ├── Run (LLM call: 输入、输出、耗时、token)
│   └── Run (tool call: 输入、输出、耗时)
├── Run (节点: tools)
│   └── Run (tool execution)
└── Run (节点: generate)
    └── Run (LLM call)
```

### Q29 🟡 如何用 LangSmith 评估一个 Agent 的质量？

**考察点**：Eval 闭环

**参考答案**：

**三要素**：
- **Dataset**：输入-期望输出/轨迹样例
- **Evaluator**：评判函数
- **Target**：被测 chain/agent

```python
from langsmith import Client
from langsmith.evaluation import evaluate

client = Client()

# 1. 创建 Dataset
dataset = client.create_dataset("agent-eval")
for input, expected in test_cases:
    client.create_example(
        inputs={"question": input},
        outputs={"answer": expected},
        dataset_id=dataset.id,
    )

# 2. 定义 Evaluator
def correctness_eval(run, example):
    """精确匹配"""
    return {"key": "correctness", "score": run.outputs["answer"] == example.outputs["answer"]}

def helpfulness_eval(run, example):
    """LLM-as-judge: 输出是否有帮助"""
    score = judge_llm.invoke({
        "question": example.inputs["question"],
        "answer": run.outputs["answer"],
    })
    return {"key": "helpfulness", "score": score}

def trajectory_eval(run, example):
    """轨迹正确性: 是否调了期望的工具"""
    expected_tools = example.outputs.get("expected_tools", [])
    actual_tools = [tc["name"] for tc in run.outputs.get("tool_calls", [])]
    return {"key": "trajectory", "score": set(expected_tools) == set(actual_tools)}

# 3. 运行评估
results = evaluate(
    lambda x: app.invoke(x),  # target
    data="agent-eval",
    evaluators=[correctness_eval, helpfulness_eval, trajectory_eval],
    experiment_name="agent-v2",
)
# LangSmith 仪表盘对比多次实验
```

**关键 evaluator 类型**：
- **精确匹配**：输出是否完全一致（适合结构化任务）
- **LLM-as-judge**：用强模型评判输出质量（`CriteriaEvalChain`）
- **轨迹正确性**：是否调了期望的工具、调用顺序对不对
- **自定义业务指标**：如 RAG 的 context recall / faithfulness

**CI 集成**：
```yaml
# GitHub Actions: PR 触发子集 eval
- name: Run Agent Eval
  run: python eval_agent.py --experiment pr-${{ github.event.number }}
# nightly 跑全量
```

### Q30 🔴 生产环境如何降低 tracing 的性能与成本开销？

**考察点**：tracing 工程化

**参考答案**：

| 策略 | 说明 |
|------|------|
| **采样** | 高 QPS 按比例采样（如 10%），错误链路 100% 采样 |
| **批量异步上报** | SDK 默认批量异步，勿同步阻塞主流程 |
| **脱敏** | `hide_input` / `hide_output` 隐藏敏感字段 |
| **裁剪大 payload** | 大文档/长输出截断，避免 trace 膨胀 |
| **环境隔离** | 本地/CI 关闭，仅生产/预发开启 |
| **成本监控** | LangSmith 用量告警 |

**采样实现**：
```python
import os, random

class SamplingCallback(BaseCallbackHandler):
    def __init__(self, sample_rate=0.1):
        self.sample_rate = sample_rate

    def should_trace(self):
        # 错误 100% 采样
        if self.last_run_error:
            return True
        # 正常按比例
        return random.random() < self.sample_rate
```

**脱敏**：
```python
from langchain_core.tracers.context import tracing_v2_enabled

with tracing_v2_enabled(
    tags=["prod"],
    metadata={"user_id": "u123"},
    # 隐藏敏感输入输出
):
    result = chain.invoke({"credit_card": "4111..."})  # 不会记录到 trace
```

**裁剪**：
```python
# 大文档截断后再传入，避免 trace 记录完整内容
trimmed_docs = [d[:500] + "...[truncated]" for d in large_docs]
```

**环境隔离**：
```python
# .env
# 生产
LANGSMITH_TRACING=true
# 本地/CI
LANGSMITH_TRACING=false  # 关闭
```

---

## 十一、多 Agent 与高级编排

### Q31 🟡 LangGraph 中实现多 Agent 协作有哪些模式？

**考察点**：多 Agent 模式

**参考答案**：

```
模式 1: Supervisor（主管）— 最常用
         ┌────────────┐
         │ Supervisor │ ← 根据任务路由到子 Agent
         └──┬──┬──┬──┘
            │  │  │
     ┌──────┘  │  └──────┐
     ▼         ▼         ▼
  [Agent A] [Agent B] [Agent C]
     │         │         │
     └─────────┴─────────┘
              ↓
         回到 Supervisor

模式 2: Hierarchical（层级）— 树状调度
         [Top Supervisor]
         /              \
   [Mid Supervisor]   [Mid Supervisor]
      /      \            /      \
   [A]     [B]        [C]     [D]

模式 3: Network（网络）— Agent 互调
   [A] ←→ [B]
    ↕  ×  ↕
   [C] ←→ [D]
   每个 Agent 可调用其它 Agent 作为工具

模式 4: Handoff（交接）— OpenAI Agents 风格
   [A] → handoff → [B] → handoff → [C]
   显式把控制权交给另一 Agent
```

**实现方式**：
```python
# Supervisor 模式: 子 Agent 作为工具被 supervisor 调用
from langgraph.prebuilt import create_react_agent

def supervisor(state):
    # supervisor 本身是一个 agent，子 Agent 是它的「工具」
    return supervisor_agent.invoke(state)

# 或子 Agent 作为子图
graph.add_node("researcher", research_subgraph)  # 子图作为节点
graph.add_node("writer", writer_subgraph)
graph.add_node("supervisor", supervisor)
```

**关键设计**：
- **职责隔离**：每个子 Agent 独立 session + 独立 system prompt，避免角色串扰
- **通信方式**：Supervisor 模式通过共享 state；Network 模式通过工具调用
- **选择依据**：Supervisor 适合有明确分工的任务；Network 适合需要灵活协作的复杂任务

### Q32 🔴 多 Agent 系统如何控制成本和延迟？

**考察点**：多 Agent 工程化

**参考答案**：

| 策略 | 说明 | 效果 |
|------|------|------|
| **模型分层** | supervisor 用强模型（决策），worker 用小模型（执行） | 降本 |
| **并行化** | 独立子任务用 `Send` 并行 fan-out | 降延迟 |
| **状态精简** | 子 Agent 间传压缩摘要，非完整历史 | 降本+降延迟 |
| **早停** | supervisor 在产出足够时主动终止 | 降本+降延迟 |
| **缓存** | 子 Agent 确定性中间结果缓存 | 降本+降延迟 |
| **Prompt Caching** | Claude 固定 system prompt 命中缓存 | 降本 |
| **可观测** | 每个子 Agent 独立 trace span | 定位热点 |

**模型分层示例**：
```python
# Supervisor: 强模型做决策（调用频率低，决策质量关键）
supervisor = ChatAnthropic(model="claude-sonnet")  # 贵但准

# Worker: 小模型做执行（调用频率高，任务简单）
researcher = ChatAnthropic(model="claude-haiku")  # 便宜快
writer = ChatOpenAI(model="gpt-4o-mini")          # 便宜快
```

**并行化示例**：
```python
# ❌ 串行: 3 个子问题依次研究，总延迟 = 3 × 单次延迟
for q in questions:
    result = research(q)

# ✅ 并行: 用 Send 同时研究
def plan(state):
    return [Send("researcher", q) for q in questions]
# 总延迟 = max(单次延迟) ≈ 1 × 单次延迟
```

**状态精简**：
```python
# ❌ 传完整消息历史给子 Agent（token 多）
sub_agent.invoke({"messages": state["messages"]})  # 可能 50K tokens

# ✅ 传压缩摘要
summary = summarize(state["messages"])
sub_agent.invoke({"task": summary})  # 可能 2K tokens
```

### Q33 🟣 设计一个「研究 Agent」：能拆解问题、并行检索、汇总成报告。用 LangGraph 描述图结构。

**考察点**：综合编排能力

**参考答案**：

```
START → planner ──Send──→ researcher(子问题1) ──┐
                  ──Send──→ researcher(子问题2) ──┤
                  ──Send──→ researcher(子问题3) ──┤
                                                   ↓
                                              aggregator
                                                  │
                                        ┌─────────┴─────────┐
                                   信息不足            信息充分
                                        ↓                  ↓
                                    planner             writer → END
                                   (补充子问题)         (生成报告)
```

```python
from langgraph.graph import StateGraph, START, END
from langgraph.types import Send
from typing import TypedDict, Annotated
import operator

class State(TypedDict):
    question: str
    subquestions: list[str]
    findings: Annotated[list, operator.add]  # reducer: 各 researcher 结果拼接
    report: str
    iteration: int

def planner(state):
    # 拆解问题为子问题（限制 ≤5 个控制成本）
    subqs = llm.invoke(f"将以下问题拆解为最多5个子问题: {state['question']}")
    return {"subquestions": subqs, "iteration": state.get("iteration", 0) + 1}

# planner 返回 Send 列表触发并行 fan-out
def route_to_researchers(state):
    return [Send("researcher", q) for q in state["subquestions"]]

def researcher(question: str):
    # 每个子问题独立检索 + 摘要
    docs = retriever.invoke(question)
    finding = llm.invoke(f"基于以下文档回答: {question}\n{docs}")
    return {"findings": [{"question": question, "answer": finding}]}

def aggregator(state):
    # 汇总，判断是否需要补充研究
    assessment = llm.invoke(f"评估以下信息是否足够回答原始问题:\n{state['findings']}")
    if assessment["sufficient"] or state["iteration"] >= 2:
        return Command(goto="writer")
    else:
        # 信息不足，补充子问题
        new_subqs = assessment["additional_questions"]
        return Command(goto="planner", update={"subquestions": new_subqs})

def writer(state):
    report = llm.invoke(f"基于以下研究发现生成报告:\n{state['findings']}")
    return {"report": report}

# 构建图
graph = StateGraph(State)
graph.add_node("planner", planner)
graph.add_node("researcher", researcher)
graph.add_node("aggregator", aggregator)
graph.add_node("writer", writer)

graph.add_edge(START, "planner")
graph.add_conditional_edges("planner", route_to_researchers)  # Send 并行
graph.add_edge("researcher", "aggregator")  # 所有 researcher 完成后进 aggregator
graph.add_conditional_edges("aggregator", lambda s: s["next"])  # 动态路由
graph.add_edge("writer", END)

app = graph.compile(checkpointer=MemorySaver())
```

**设计要点**：
1. **并行检索**：`Send` 对每个子问题触发独立 researcher 实例，并行执行
2. **结果汇聚**：`findings` 用 `operator.add` reducer 自动拼接各 researcher 结果
3. **自纠正**：aggregator 判断信息不足时回到 planner 补充子问题（限 2 轮）
4. **成本控制**：planner 限子问题数 ≤5，researcher 限检索轮次，iteration 限 2 轮
5. **人类介入**：writer 前可加 `interrupt()` 让用户确认报告大纲

---

## 十二、工程实践与部署

### Q34 🟡 LangGraph 应用部署到生产有哪些方案？

**考察点**：部署选型

**参考答案**：

| 方案 | 说明 | 适用 |
|------|------|------|
| **LangGraph Platform（托管）** | 官方托管运行时，自带 checkpoint/stream/cron/HITL | 省心、付费 |
| **自托管 LangGraph Server** | `langgraph-cli` / Docker 自部署，自管 Postgres | 需要控制、免费 |
| **嵌入 Web 框架** | compiled graph 作为库嵌入 FastAPI/Flask | 轻量、需自己处理持久化 |

**方案 3 示例（FastAPI）**：
```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.postgres import PostgresSaver

app = FastAPI()
checkpointer = PostgresSaver(conn_string=DATABASE_URL)
compiled = graph.compile(checkpointer=checkpointer)

@app.post("/invoke")
async def invoke(input: dict, thread_id: str):
    config = {"configurable": {"thread_id": thread_id}}
    result = await compiled.ainvoke(input, config)
    return result

@app.post("/stream")
async def stream(input: dict, thread_id: str):
    config = {"configurable": {"thread_id": thread_id}}
    async def event_stream():
        async for mode, chunk in compiled.astream(
            input, config, stream_mode=["messages", "updates"]
        ):
            yield f"data: {json.dumps({'mode': mode, 'chunk': str(chunk)})}\n\n"
    return StreamingResponse(event_stream(), media_type="text/event-stream")
```

**关键考量**：

1. **持久化**：生产必须用 `PostgresSaver`（非 InMemorySaver），否则重启丢失所有会话状态
2. **流式**：SSE（`text/event-stream`）或 WebSocket 推送 stream 事件
3. **并发**：`thread_id` 级别串行（同一会话不并发，避免 state 竞态），跨会话并行
4. **鉴权**：LangGraph Platform 自带；自托管需自己加（JWT/OAuth）
5. **健康检查**：`/health` 端点 + Postgres 连接检查

### Q35 🟡 如何测试 LangGraph Agent？有哪些特殊难点？

**考察点**：Agent 测试

**参考答案**：

**难点**：LLM 非确定性、依赖外部 API、长链路、工具副作用。

**分层测试**：

```python
# 1. 单元测试: 节点纯逻辑（mock state）
def test_retrieve_node():
    mock_state = {"question": "什么是RAG", "documents": []}
    with mock.patch("retriever.invoke", return_value=[fake_doc]):
        result = retrieve(mock_state)
    assert len(result["documents"]) == 1

# 2. 集成测试: mock model，验证图拓扑与路由
from langchain_community.chat_models.fake import FakeListChatModel

def test_agent_graph():
    # 固定模型响应序列
    fake_model = FakeListChatModel(responses=[
        # 第1轮: 调工具
        AIMessage(content="", tool_calls=[{"name": "search", "args": {"q": "test"}, "id": "1"}]),
        # 第2轮: 最终回答
        AIMessage(content="搜索完成，答案是..."),
    ])
    app = build_graph(model=fake_model, tools=[mock_tool])
    result = app.invoke({"messages": [HumanMessage("搜索test")]})
    assert "答案是" in result["messages"][-1].content

# 3. 快照测试: state 演进
def test_state_progression(snapshot):
    result = app.invoke(input, config)
    state = app.get_state(config)
    snapshot.assert_match(state.values)  # 防 topology 回归

# 4. Eval 测试: LangSmith Dataset + LLM-as-judge
# (见 Q29)
```

**确定性技巧**：
- `temperature=0` + 固定 model 版本
- mock 工具（避免真实副作用）
- 用 LangSmith recordings 回放固定模型响应
- 仍需容忍偶发抖动（LLM 不是完全确定的）

**CI 集成**：
- PR 跑子集 eval（快速反馈）
- nightly 跑全量 eval + 录制回放

### Q36 🔴 LangGraph 中如何实现 durable execution（崩溃后恢复）？

**考察点**：持久化执行

**参考答案**：

**核心：Checkpointer 自动持久化每个节点的执行状态**

```python
from langgraph.checkpoint.postgres import PostgresSaver

# 生产用 PostgresSaver（持久可靠）
checkpointer = PostgresSaver(conn_string=DATABASE_URL)
app = graph.compile(checkpointer=checkpointer)

# 执行
config = {"configurable": {"thread_id": "session-123"}}
result = app.invoke(input, config)

# 假设在节点 B 执行时崩溃
# 恢复: 用相同 thread_id 重新 invoke
result = app.invoke(None, config)  # None 表示从 checkpoint 继续
# 引擎从最近 checkpoint 恢复，跳过已完成的节点 A，重新执行节点 B
```

**关键要求**：

1. **节点幂等**：
   - 崩溃可能在「执行完工具但未写 checkpoint」间发生
   - 恢复会**重新执行**该节点
   - 节点函数需幂等（重复执行不产生副作用）

2. **副作用工具幂等**：
   ```python
   @tool
   def charge_payment(amount: int, idempotency_key: str) -> str:
       """扣款（幂等）"""
       # 用 idempotency_key 去重，避免重复扣款
       if already_charged(idempotency_key):
           return get_existing_charge(idempotency_key)
       return do_charge(amount, idempotency_key)
   ```

3. **PostgresSaver**：保证 checkpoint 可靠持久（InMemorySaver 重启即丢）

**durability 模式**：
```python
# async: 异步写 checkpoint，崩溃可能丢最后一步，性能好（默认）
app = graph.compile(checkpointer=PostgresSaver(...), durability="async")

# sync: 同步写，强一致，性能差
app = graph.compile(checkpointer=PostgresSaver(...), durability="sync")
```

**生产推荐**：`async` + 工具幂等，兼顾性能与正确性。

---

## 十三、编码题

### Q37 🟡 用 LangGraph 实现一个带工具调用的 ReAct Agent（手写 StateGraph，不用 create_react_agent）。

**参考答案**：

```python
from langgraph.graph import StateGraph, MessagesState, START, END
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import InMemorySaver
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool

# 1. 定义工具
@tool
def search(query: str) -> str:
    """搜索网络信息"""
    return f"搜索结果: {query} 的相关信息"

@tool
def calculate(expression: str) -> str:
    """计算数学表达式"""
    try:
        return str(eval(expression))
    except:
        return "计算错误"

tools = [search, calculate]

# 2. 绑定工具到模型
model = ChatOpenAI(model="gpt-4o-mini", temperature=0)
model_with_tools = model.bind_tools(tools)

# 3. 定义 agent 节点
def call_model(state: MessagesState):
    response = model_with_tools.invoke(state["messages"])
    return {"messages": [response]}

# 4. 构建图
graph = StateGraph(MessagesState)
graph.add_node("agent", call_model)
graph.add_node("tools", ToolNode(tools))

graph.add_edge(START, "agent")
# tools_condition: 有 tool_calls → "tools"，无 → END
graph.add_conditional_edges("agent", tools_condition)
# 工具结果回 agent 形成循环
graph.add_edge("tools", "agent")

# 5. 编译（加 checkpointer 支持持久化）
app = graph.compile(checkpointer=InMemorySaver())

# 6. 执行
from langchain_core.messages import HumanMessage
config = {"configurable": {"thread_id": "demo"}}
result = app.invoke(
    {"messages": [HumanMessage("2+2等于几？然后搜索一下Python")]},
    config
)
print(result["messages"][-1].content)
```

**考察点**：
- `tools_condition` 默认返回 `"tools"` 或 `END`（路由名需匹配节点名）
- `tools → agent` 循环边形成 ReAct 循环
- `checkpointer` 注入实现持久化
- `MessagesState` 内置消息 reducer（自动累积）

### Q38 🔴 实现一个带「文档评分 + 查询改写」的 Self-RAG 图。

**参考答案**：

```python
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command
from typing import TypedDict, Annotated
import operator
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

# 1. 定义 State
class State(TypedDict):
    question: str
    documents: list           # 当前检索到的文档
    relevant_docs: list       # 评分后相关的文档
    retries: int              # 重试次数
    generation: str           # 最终生成

# 2. 节点: 检索
def retrieve(state: State):
    docs = retriever.invoke(state["question"])
    return {"documents": docs}  # 覆盖（每次重新检索）

# 3. 节点: 文档评分
def grade_documents(state: State):
    relevant = []
    for doc in state["documents"]:
        prompt = ChatPromptTemplate.from_template("""
        判断以下文档是否与问题相关。只回答 "yes" 或 "no"。
        问题: {question}
        文档: {doc}
        """)
        result = (prompt | llm).invoke({
            "question": state["question"],
            "doc": doc.page_content[:500],
        })
        if "yes" in result.content.lower():
            relevant.append(doc)
    return {"relevant_docs": relevant}

# 4. 节点: 查询改写
def transform_query(state: State):
    prompt = ChatPromptTemplate.from_template("""
    重新表述以下问题，使其更适合检索:
    原问题: {question}
    """)
    new_q = (prompt | llm).invoke({"question": state["question"]})
    return {
        "question": new_q.content,
        "retries": state.get("retries", 0) + 1,
    }

# 5. 节点: 生成
def generate(state: State):
    context = "\n\n".join(d.page_content for d in state["relevant_docs"])
    prompt = ChatPromptTemplate.from_template("""
    基于以下上下文回答问题:
    上下文: {context}
    问题: {question}
    """)
    result = (prompt | llm).invoke({
        "context": context,
        "question": state["question"],
    })
    return {"generation": result.content}

# 6. 条件路由: 评分后决定
def decide_after_grade(state: State) -> str:
    if len(state["relevant_docs"]) >= 2:
        return "generate"           # 相关文档足够
    elif state.get("retries", 0) < 2:
        return "transform_query"    # 改写查询重检索
    else:
        return "generate"           # 重试耗尽，兜底生成

# 7. 构建图
graph = StateGraph(State)
graph.add_node("retrieve", retrieve)
graph.add_node("grade", grade_documents)
graph.add_node("transform_query", transform_query)
graph.add_node("generate", generate)

graph.add_edge(START, "retrieve")
graph.add_edge("retrieve", "grade")
graph.add_conditional_edges("grade", decide_after_grade, {
    "generate": "generate",
    "transform_query": "transform_query",
})
graph.add_edge("transform_query", "retrieve")  # 改写后重新检索
graph.add_edge("generate", END)

app = graph.compile()

# 执行
result = app.invoke({
    "question": "LangGraph 如何实现循环？",
    "documents": [],
    "relevant_docs": [],
    "retries": 0,
})
print(result["generation"])
```

**考察点**：
- **自定义 State**：`question` / `documents` / `relevant_docs` / `retries`
- **条件路由**：`decide_after_grade` 根据相关文档数和重试次数决定走向
- **循环计数兜底**：`retries < 2` 防止无限重检索
- **reducer 选择**：`documents` 用覆盖（每次重新检索），`relevant_docs` 也覆盖
- **查询改写**：`transform_query` 更新 `question`，`retrieve` 用新 question 检索

---

## 十四、加分项 / 开放讨论

### Q39 🟡 LangChain/LangGraph 相比直接用 OpenAI SDK / Anthropic SDK 的权衡是什么？

**参考答案**：

| 维度 | 直接用厂商 SDK | LangChain/LangGraph |
|------|---------------|---------------------|
| **轻量性** | ✅ 无抽象层，直接调 | ❌ 多层抽象，有性能开销 |
| **学习曲线** | ✅ 低（看厂商文档） | ❌ 高（需学 LCEL/LangGraph 概念） |
| **生态集成** | ❌ 自己写 loader/splitter/vectorstore | ✅ 开箱即用 |
| **编排能力** | ❌ 自己写循环/状态管理 | ✅ StateGraph/checkpointer/HITL |
| **模型无关** | ❌ 切换 provider 需改代码 | ✅ 改一行 import |
| **可观测** | ❌ 自己搭 | ✅ LangSmith 开箱即用 |
| **API 稳定性** | ✅ 厂商 API 稳定 | ❌ LangChain 版本迭代快，API 常变 |
| **生态锁定** | ✅ 无 | ❌ 绑定 LangChain 生态 |

**选型建议**：
- **简单单次调用**（如翻译、摘要）→ 直接用厂商 SDK 更轻
- **原型/复杂 Agent**（需循环、状态、HITL、多 Agent）→ LangGraph 价值凸显
- **需要持久化/HITL/可观测** → LangGraph + LangSmith 省大量自研成本
- **极致性能** → 直接 SDK（LangGraph 的 checkpoint 有序列化开销）

### Q40 🟡 如何看待 MCP（Model Context Protocol）与 LangChain 工具生态的关系？

**参考答案**：

**MCP 定义**：Anthropic 提出的跨厂商工具/资源标准协议，让工具成为可独立部署的 MCP Server。

**与 LangChain 的关系**：

```
传统:  LangChain 工具 (LangChain 专用)  ←→  各 API
MCP:   LangChain ← MCP Client ← MCP Server ←→  各 API
                              ↑ 标准协议
       Claude Desktop ← MCP Client ← 同一 MCP Server
       其它 Agent     ← MCP Client ← 同一 MCP Server
```

**趋势：工具层标准化（MCP）+ 编排层框架化（LangGraph）**

- LangChain 已支持把 MCP Server 接入为工具（`langchain-mcp-adapters`）
- LangGraph 专注编排（图/状态/循环），工具层交给 MCP
- 两者各司其职，不冲突

**价值**：
- **工具一次实现，跨框架复用**：写一个「搜索」MCP Server，Claude Desktop / LangGraph / 其它 Agent 都能消费
- **工具可独立部署升级**：MCP Server 是独立进程，与 Agent 解耦
- **类比**：USB-C 之于硬件接口，MCP 之于 Agent 工具接口

**局限**：
- 增加一层 RPC 开销（本地工具调用变 IPC）
- 仍处早期，生态 adoption 中

### Q41 🔴 你认为当前 Agent 框架（含 LangGraph）最大的局限是什么？

**参考答案**：

| 局限 | 说明 | 演进方向 |
|------|------|----------|
| **可靠性** | 图保证控制流正确，但保证不了 LLM 决策正确；eval 仍是最大短板 | 更强结构化约束、形式化验证关键路径 |
| **状态膨胀** | 长任务 state 持续增长，checkpoint 序列化成本高 | 分层 state、增量 checkpoint |
| **调试** | 图可视化好，但「为什么模型这样决策」仍是黑盒 | 决策可视化、时间旅行调试 |
| **多 Agent 通信** | 缺乏成熟 Agent 间消息协议（state 共享有耦合，tool 调用啰嗦） | A2A（Agent-to-Agent）标准协议 |
| **性能** | Python + 多次 LLM 调用，延迟难压；checkpoint 有开销 | 推测执行、流式 checkpoint |
| **评估** | 缺乏自动化 eval 闭环，质量难保障 | CI 集成 eval、回归测试 |

**个人看法**（面试时可展开）：

当前 Agent 框架解决了「编排」问题（如何让 LLM 循环调用工具），但没解决「可靠性」问题——模型决策仍可能出错，框架无法保证正确性。

未来最大的突破点：
1. **形式化约束**：用类型系统/形式化方法约束模型输出，减少幻觉
2. **A2A 协议**：Agent 间标准通信协议，让多 Agent 系统真正解耦
3. **eval 闭环**：把 eval 从「事后手动」变成「CI 自动化」，像传统软件测试一样保障质量
4. **推测执行**：模型预测可能路径并预执行，降低延迟

---

## 面试评估维度建议

| 维度 | 权重 | 考察题目 |
|------|------|----------|
| 生态与基础 | 15% | Q1-Q3, Q7-Q9 |
| LCEL 与流式 | 12% | Q4-Q6, Q26-Q27 |
| Agent 编排 | 22% | Q10-Q13, Q31-Q33 |
| 工具与 RAG | 18% | Q14-Q19 |
| 记忆/持久化/HITL | 15% | Q20-Q25 |
| 可观测与工程化 | 10% | Q28-Q30, Q34-Q36 |
| 编码与设计 | 8% | Q37-Q38 |

> 评级标准：
> - **P5（初级）**：理解 LCEL/Runnable，能用 `create_react_agent` 搭简单工具 Agent，会基础 RAG
> - **P6（中级）**：能手写 StateGraph，理解 reducer/checkpointer，实现 Self-RAG、HITL 审批，会用 LangSmith eval
> - **P7（高级）**：能设计多 Agent 协作、durable execution、成本延迟优化，熟悉 functional API 与 Command/Send 高级语义
> - **P8（专家）**：对框架局限有深刻思考，能做架构选型权衡（LangGraph vs 自研 vs 厂商 SDK），推动 eval 闭环与生产可观测性建设
