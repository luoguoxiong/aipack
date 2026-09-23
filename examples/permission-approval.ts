/**
 * 根目录示例：框架级权限审批（PermissionPolicy + ApprovalManager）
 *
 * 演示四种决策在真实工具调用链路上的效果：
 *   1. allow   只读工具直接放行（read_file）
 *   2. deny    高危命令按参数内容拒绝（shell + rm -rf），工具根本不会执行
 *   3. confirm 内联人工确认：Runtime 同调用栈 await confirmFn，返回 true/false 决定是否执行
 *   4. pending 异步审批：Runtime 挂起并生成审批单，外部凭 approvalId 批准/驳回后继续
 *              —— 超时（approvalTimeoutMs）与 run abort 均按拒绝处理
 *   5. 审批单持久化 + 重启恢复（FileApprovalStore + restore()）
 *
 * 关键点：裁决发生在 executeTool 内、且先于 beforeToolCall 扩展钩子，
 *        工具自身无法绕过；被拒绝时返回 { blocked: true } 的 ToolResult（非执行错误），
 *        模型能看到 "[blocked] ..." 并自行调整策略。
 *
 * 本示例用「脚本化的 streamFn」替代真实 LLM（无需 API Key，离线可跑、结果确定）：
 *   每次模型调用按脚本吐出一条 assistant 消息（toolCall 或最终文本）。
 *
 * 运行:
 *   npx tsx examples/permission-approval.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntime,
  createRequest,
  createPermissionPolicy,
  createApprovalManager,
  FileApprovalStore,
  defaultApprovalDir,
} from '@aipack-ai/agent';
import type {
  AssistantMessage,
  StreamFn,
  StreamEvent,
  Tool,
  PendingApproval,
  ApprovalManager,
  PermissionRequest,
  Telemetry,
} from '@aipack-ai/agent';

// ─── 脚本化模型：用固定脚本替代真实 LLM ────────────────────────────

type ScriptStep =
  | { toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { text: string };

/** 每次被调用时消费一个脚本步骤；脚本耗尽后兜底返回文本 */
function createScriptedStreamFn(script: ScriptStep[]): StreamFn {
  const queue = [...script];
  return async function* (): AsyncGenerator<StreamEvent> {
    const step = queue.shift() ?? { text: '(脚本结束)' };
    const usage = { input: 10, output: 5, total: 15 };
    if ('toolCalls' in step) {
      const message: AssistantMessage = {
        role: 'assistant',
        content: step.toolCalls.map((tc) => ({
          type: 'toolCall',
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
        })),
        stopReason: 'toolUse',
        usage,
        timestamp: Date.now(),
      };
      yield { type: 'done', message };
    } else {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: step.text }],
        stopReason: 'stop',
        usage,
        timestamp: Date.now(),
      };
      yield { type: 'done', message };
    }
  };
}

// ─── 演示工具：声明 permissions，记录是否真的被执行 ─────────────────

/** 真实产生的副作用（用于验证工具到底执行了没有） */
const effects: string[] = [];

const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容（只读）',
  permissions: ['fs:read'],
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径' } },
    required: ['path'],
  },
  async execute(_toolCallId, args) {
    const { path: p } = (args ?? {}) as { path?: string };
    effects.push(`read_file(${p})`);
    return { content: [{ type: 'text', text: `# ${p}\nhello aipack` }], details: { path: p } };
  },
};

const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入文件（有副作用）',
  permissions: ['fs:write'],
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(_toolCallId, args) {
    const { path: p } = (args ?? {}) as { path?: string };
    effects.push(`write_file(${p})`);
    return { content: [{ type: 'text', text: `已写入 ${p}` }], details: { path: p } };
  },
};

const shellTool: Tool = {
  name: 'shell',
  description: '执行 shell 命令',
  permissions: ['shell:exec'],
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'],
  },
  // 参数预处理：权限策略与执行钩子都基于处理后的 args 裁决
  prepareArguments(args) {
    const raw = (args ?? {}) as { command?: unknown };
    return { command: String(raw.command ?? '').trim() };
  },
  async execute(_toolCallId, args) {
    const { command } = (args ?? {}) as { command?: string };
    effects.push(`shell(${command})`);
    return { content: [{ type: 'text', text: `$ ${command}\n(output)` }], details: { command } };
  },
};

const tools: Tool[] = [readFileTool, writeFileTool, shellTool];

// ─── 权限策略：规则按顺序匹配，未命中默认 deny ──────────────────────

/** confirm 决策的"人工回答"队列（真实场景可换成 readline 提问 / UI 弹窗） */
const confirmAnswers: boolean[] = [];

const permissionPolicy = createPermissionPolicy({
  rules: [
    { name: '只读放行', permission: 'fs:read', decision: 'allow' },
    {
      name: 'rm -rf 一律拒绝',
      toolName: /^shell$/,
      matchArgs: (args) => /rm\s+-rf/.test((args as { command?: string }).command ?? ''),
      decision: 'deny',
    },
    { name: 'shell 需人工确认', toolName: /^shell$/, decision: 'confirm' },
    { name: '写文件需异步审批', permission: 'fs:write', decision: 'pending' },
  ],
  defaultDecision: 'deny', // deny-by-default：未声明、未命中的一律拒绝
  confirmFn: async () => confirmAnswers.shift() ?? false,
});

// ─── 审批管理器 + 遥测采集 ──────────────────────────────────────────

const approvals = createApprovalManager();

const deniedLog: string[] = [];
const pendingLog: string[] = [];
const resolvedLog: string[] = [];

const telemetry: Telemetry = {
  onPermissionDenied(info) {
    deniedLog.push(`${info.toolName} ← ${info.reason}`);
  },
  onApprovalPending(info) {
    pendingLog.push(`${info.toolName} ← ${info.approvalId}`);
  },
  onApprovalResolved(info) {
    resolvedLog.push(`${info.toolName} ← ${info.outcome} (${info.waitedMs}ms)`);
  },
};

/** 按脚本创建一个 Runtime（共享策略 / 审批管理器 / 遥测） */
function makeRuntime(script: ScriptStep[], approvalTimeoutMs = 300_000) {
  return createRuntime({
    streamFn: createScriptedStreamFn(script),
    tools,
    permissionPolicy,
    approvals,
    approvalTimeoutMs,
    telemetry,
    systemPrompt: '你是一个会调用工具的助手。',
  });
}

// ─── 辅助 ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等待首个审批单出现（模拟 Web 审批面板订阅待审批列表） */
function nextApproval(mgr: ApprovalManager, timeoutMs = 5_000): Promise<PendingApproval> {
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('等待审批单超时'));
    }, timeoutMs);
    unsub = mgr.onPending((approval) => {
      clearTimeout(timer);
      unsub();
      resolve(approval);
    });
  });
}

function section(title: string) {
  console.log(`\n${'─'.repeat(56)}\n  ${title}\n${'─'.repeat(56)}`);
}

function showResult(label: string, content: string) {
  console.log(`  ${label}: ${content.replace(/\n/g, ' ').slice(0, 90)}`);
}

// ─── 主流程 ─────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   aipack 权限审批演示（PermissionPolicy）        ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('  规则: fs:read → allow | shell + rm -rf → deny');
  console.log('        shell → confirm | fs:write → pending | 其余 → deny\n');

  // ── 1. allow：只读工具直接放行 ────────────────────────────────
  section('1. allow —— 只读工具直接放行');
  const r1 = makeRuntime([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: './README.md' } }] },
    { text: '文件内容是 hello aipack。' },
  ]);
  const res1 = await r1.run(createRequest('读一下 README.md', { sessionKey: 'demo-allow' }));
  showResult('助手', res1.content);
  console.log(`  ✅ 工具已执行: ${effects.includes('read_file(./README.md)')}`);
  await r1.close();

  // ── 2. deny：按参数内容拒绝（matchArgs）──────────────────────
  section('2. deny —— 高危命令被拒绝（工具不会执行）');
  const r2 = makeRuntime([
    { toolCalls: [{ id: 'c2', name: 'shell', args: { command: 'rm -rf /data' } }] },
    { text: '该命令被安全策略拒绝，我不会执行删除操作。' },
  ]);
  const res2 = await r2.run(createRequest('清理 /data 目录', { sessionKey: 'demo-deny' }));
  showResult('助手', res2.content);
  console.log(`  ❌ 工具未执行: ${!effects.some((e) => e.startsWith('shell(rm'))}`);
  await r2.close();

  // ── 3. confirm：内联人工确认（同调用栈 await）────────────────
  section('3. confirm —— 内联人工确认（approve / reject）');
  confirmAnswers.push(true); // 3a 批准
  const r3a = makeRuntime([
    { toolCalls: [{ id: 'c3', name: 'shell', args: { command: 'git status' } }] },
    { text: '工作区干净。' },
  ]);
  const res3a = await r3a.run(createRequest('看下 git 状态', { sessionKey: 'demo-confirm-ok' }));
  showResult('批准 → 助手', res3a.content);
  console.log(`  ✅ 工具已执行: ${effects.includes('shell(git status)')}`);
  await r3a.close();

  confirmAnswers.push(false); // 3b 驳回
  const r3b = makeRuntime([
    { toolCalls: [{ id: 'c4', name: 'shell', args: { command: 'curl http://example.com' } }] },
    { text: '未获授权，已跳过该命令。' },
  ]);
  const res3b = await r3b.run(createRequest('请求一下 example.com', { sessionKey: 'demo-confirm-no' }));
  showResult('驳回 → 助手', res3b.content);
  console.log(`  ❌ 工具未执行: ${!effects.some((e) => e.startsWith('shell(curl'))}`);
  await r3b.close();

  // ── 4. pending：异步审批（挂起 → 批准）───────────────────────
  section('4. pending —— 异步审批：挂起 run，外部批准后继续');
  const r4 = makeRuntime([
    { toolCalls: [{ id: 'c5', name: 'write_file', args: { path: '/tmp/report.txt', content: 'hi' } }] },
    { text: '已写入报告。' },
  ]);
  let run4Done = false;
  const run4 = r4
    .run(createRequest('把报告写到 /tmp/report.txt', { sessionKey: 'demo-pending' }))
    .then((r) => {
      run4Done = true;
      return r;
    });

  const approval4 = await nextApproval(approvals);
  console.log(`  ⏳ 审批单 ${approval4.id}：${approval4.request.toolName} ${JSON.stringify(approval4.request.args)}`);
  console.log(`     待审批列表: ${approvals.list().length} 条 | run 已结束: ${run4Done}（false = 正挂起等待审批）`);

  await sleep(200); // 模拟审批人思考 / UI 往返
  console.log('  🖱 审批面板点击「批准」');
  approvals.resolve(approval4.id, true);

  const res4 = await run4;
  showResult('助手', res4.content);
  console.log(`  ✅ 工具已执行: ${effects.includes('write_file(/tmp/report.txt)')}`);
  await r4.close();

  // ── 5. pending：异步审批（挂起 → 驳回）───────────────────────
  section('5. pending —— 异步审批：驳回');
  const r5 = makeRuntime([
    { toolCalls: [{ id: 'c6', name: 'write_file', args: { path: '/etc/hosts', content: 'x' } }] },
    { text: '未获批准，已放弃写入。' },
  ]);
  const run5 = r5.run(createRequest('改一下 /etc/hosts', { sessionKey: 'demo-pending-deny' }));
  const approval5 = await nextApproval(approvals);
  console.log(`  ⏳ 审批单 ${approval5.id}：${approval5.request.toolName} ${JSON.stringify(approval5.request.args)}`);
  approvals.resolve(approval5.id, false); // 驳回
  const res5 = await run5;
  showResult('助手', res5.content);
  console.log(`  ❌ 工具未执行: ${!effects.some((e) => e.startsWith('write_file(/etc/hosts'))}`);
  await r5.close();

  // ── 6. pending：无人审批 → 超时按拒绝处理 ────────────────────
  section('6. pending —— 无人审批，超时（approvalTimeoutMs=400）自动拒绝');
  const r6 = makeRuntime(
    [
      { toolCalls: [{ id: 'c7', name: 'write_file', args: { path: '/tmp/a.txt', content: 'x' } }] },
      { text: '审批超时，操作已取消。' },
    ],
    400,
  );
  const res6 = await r6.run(createRequest('写个临时文件', { sessionKey: 'demo-timeout' }));
  showResult('助手', res6.content);
  console.log(`  ❌ 工具未执行: ${!effects.some((e) => e.startsWith('write_file(/tmp/a.txt'))}`);
  await r6.close();

  // ── 7. 审批单持久化 + 重启恢复 ───────────────────────────────
  section('7. 审批单持久化（FileApprovalStore）+ 重启恢复');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipack-approvals-'));
  const store = new FileApprovalStore({ baseDir: tmpDir });
  console.log(`  默认落盘位置: ${defaultApprovalDir()}（本例改用临时目录 ${tmpDir}）`);

  // 进程 A：创建审批单后"崩溃"（不结算）
  const mgrA = createApprovalManager({ store });
  const permReq: PermissionRequest = {
    toolName: 'deploy_prod',
    permissions: ['shell:exec'],
    args: { command: 'kubectl apply -f prod.yaml' },
    sessionKey: 'demo-restore',
    request: createRequest('部署到生产环境'),
    shared: new Map(),
  };
  const orphan = mgrA.create(permReq, { timeoutMs: 60_000 });
  for (let i = 0; i < 50 && fs.readdirSync(tmpDir).length === 0; i++) await sleep(10);
  console.log(`  进程 A 创建未决审批单 ${orphan.id}，磁盘: ${fs.readdirSync(tmpDir).join(', ')}`);

  // 进程 B：重启后恢复（原 run 已丢失 → 孤儿审批单）
  const mgrB = createApprovalManager({ store });
  const restoredCount = await mgrB.restore();
  const restoredList = mgrB.list();
  console.log(`  进程 B 恢复 ${restoredCount} 条（restored 标记: ${restoredList.every((a) => a.restored)}）`);

  // 批准孤儿审批单：无等待方被唤醒，但审计留痕
  mgrB.resolve(restoredList[0]!.id, true);
  await sleep(50);
  const history = path.join(tmpDir, 'history.jsonl');
  console.log(`  批准后磁盘: ${fs.readdirSync(tmpDir).join(', ')}`);
  console.log(`  审计记录: ${fs.existsSync(history) ? fs.readFileSync(history, 'utf8').trim() : '（无）'}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ── 汇总 ────────────────────────────────────────────────────
  section('汇总');
  console.log(`  实际产生的副作用: ${effects.join(' | ') || '（无）'}`);
  console.log(`  onApprovalPending : ${pendingLog.join(' | ') || '（无）'}`);
  console.log(`  onApprovalResolved: ${resolvedLog.join(' | ') || '（无）'}`);
  console.log(`  onPermissionDenied: ${deniedLog.length} 次`);
  for (const d of deniedLog) console.log(`     • ${d}`);

  await approvals.close();
  console.log('\n✅ 权限审批演示完成');
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
