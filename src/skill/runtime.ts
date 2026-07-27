import crypto from 'crypto';
import { logger } from '../utils/logger';
import { ToolRegistry } from '../tools/registry';
import { ContextManager } from './context-manager';
import { PromptCompiler } from './prompt-compiler';
import type {
  SkillDefinition,
  SkillContext,
  SkillResult,
  SkillTrace,
  SkillHook,
  SkillMatch,
} from './types';

/**
 * Skill Runtime — 执行引擎
 *
 * 职责：
 * 1. 执行前 Hook 链
 * 2. Context 准备（委托 ContextManager）
 * 3. Prompt 编译（委托 PromptCompiler）
 * 4. Skill 执行（直接执行 handler 或通过 LLM）
 * 5. 结果验证 + Trace 记录
 */
export class SkillRuntime {
  private toolRegistry: ToolRegistry;
  private contextManager: ContextManager;
  private promptCompiler: PromptCompiler;
  private hooks: SkillHook[] = [];
  private traces: SkillTrace[] = [];
  private consecutiveFailures: Map<string, number> = new Map();
  private readonly MAX_CONSECUTIVE_FAILURES = 5;

  constructor(toolRegistry: ToolRegistry, workspace?: string) {
    this.toolRegistry = toolRegistry;
    this.contextManager = new ContextManager(workspace);
    this.promptCompiler = new PromptCompiler();
  }

  // ─── Hook 管理 ───

  registerHook(hook: SkillHook): void {
    this.hooks.push(hook);
    logger.debug({ hookMethods: this.getHookMethodNames(hook) }, '[SKILL-RUNTIME] Hook 已注册');
  }

  private getHookMethodNames(hook: SkillHook): string[] {
    const methods: string[] = [];
    for (const key of Object.keys(hook) as (keyof SkillHook)[]) {
      if (key !== 'parallel' && typeof hook[key] === 'function') {
        methods.push(key);
      }
    }
    return methods;
  }

  // ─── 核心执行方法 ───

  async execute(
    skill: SkillDefinition,
    options?: {
      match?: SkillMatch;
      userInput?: string;
      signal?: AbortSignal;
    },
  ): Promise<SkillResult> {
    const traceId = crypto.randomUUID();
    const startTime = Date.now();
    const skillName = skill.manifest.name;

    logger.info({ skillName, traceId }, '[SKILL-RUNTIME] 开始执行');

    try {
      // 0. 检查连续失败（熔断）
      if (this.isCircuitBroken(skillName)) {
        return {
          content: `Skill "${skillName}" 已被自动禁用（连续失败 ${this.MAX_CONSECUTIVE_FAILURES} 次）`,
          tokensUsed: 0,
          durationMs: Date.now() - startTime,
          toolsUsed: [],
          status: 'error',
          error: 'circuit_broken',
        };
      }

      // 1. beforeExecute Hook
      const hookCtx = { skill, match: options?.match, signal: options?.signal };
      const hookResult = await this.runHooks('beforeExecute', hookCtx);
      if (hookResult?.abort) {
        return this.recordTrace(traceId, skill, startTime, {
          content: 'Hook 终止了 Skill 执行',
          tokensUsed: 0,
          durationMs: Date.now() - startTime,
          toolsUsed: [],
          status: 'error',
          error: 'hook_abort',
        });
      }

      // 2. 准备 Context（委托 ContextManager）
      const context = await this.prepareContext(skill, options);

      // 3. 编译 Prompt（委托 PromptCompiler）
      const toolDescriptions = this.toolRegistry.list();
      const compiled = this.promptCompiler.compile(skill, {
        context,
        userInput: options?.userInput,
        match: options?.match,
        toolDescriptions: skill.manifest.tools?.allowed
          ? toolDescriptions.filter(t => skill.manifest.tools!.allowed!.includes(t))
          : toolDescriptions,
      });

      // 4. 执行
      const result = await this.executeWithTimeout(
        skill,
        compiled.system,
        context,
        options?.signal,
      );

      // 5. afterExecute Hook
      await this.runHooks('afterExecute', { ...hookCtx, context, result });

      // 6. 清除连续失败计数
      this.consecutiveFailures.delete(skillName);

      return this.recordTrace(traceId, skill, startTime, result);
    } catch (err) {
      // 记录失败
      const failCount = (this.consecutiveFailures.get(skillName) || 0) + 1;
      this.consecutiveFailures.set(skillName, failCount);

      if (failCount >= this.MAX_CONSECUTIVE_FAILURES) {
        logger.error({ skillName, failCount }, '[SKILL-RUNTIME] Skill 已被自动禁用（连续失败）');
      }

      // onError Hook
      await this.runHooks('onError', { skill, match: options?.match, error: err as Error, signal: options?.signal });

      const errorResult: SkillResult = {
        content: '',
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
        toolsUsed: [],
        status: 'error',
        error: (err as Error).message,
      };
      return this.recordTrace(traceId, skill, startTime, errorResult);
    }
  }

  // ─── Context 准备（委托 ContextManager） ───

  private async prepareContext(
    skill: SkillDefinition,
    options?: { signal?: AbortSignal },
  ): Promise<SkillContext> {
    return this.contextManager.prepare(skill, options);
  }

  // ─── Prompt 编译（公开方法，供 prepareSkillInput 等场景使用） ───

  async compilePrompt(
    skill: SkillDefinition,
    options?: {
      match?: SkillMatch;
      userInput?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ compiled: string; context: SkillContext }> {
    const context = await this.contextManager.prepare(skill, options);
    const toolDescriptions = this.toolRegistry.list();
    const compiled = this.promptCompiler.compile(skill, {
      context,
      userInput: options?.userInput,
      match: options?.match,
      toolDescriptions: skill.manifest.tools?.allowed
        ? toolDescriptions.filter(t => skill.manifest.tools!.allowed!.includes(t))
        : toolDescriptions,
    });
    return { compiled: compiled.system, context };
  }

  // ─── 执行（带超时） ───

  private async executeWithTimeout(
    skill: SkillDefinition,
    prompt: string,
    context: SkillContext,
    signal?: AbortSignal,
  ): Promise<SkillResult> {
    const timeout = skill.manifest.runtime?.timeout || 30000;
    const handlerPath = skill.handlerPath;
    const toolsUsed: string[] = [];

    const startTime = Date.now();

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    try {
      const combinedSignal = signal
        ? this.combineSignals(signal, timeoutController.signal)
        : timeoutController.signal;

      if (handlerPath) {
        // 执行 handler.ts
        try {
          const handler = await this.loadHandler(handlerPath);
          const result = await handler(prompt, context, combinedSignal);
          toolsUsed.push(...(result.toolsUsed || []));
          return {
            content: result.content,
            tokensUsed: result.tokensUsed || Math.ceil(result.content.length / 4),
            durationMs: Date.now() - startTime,
            toolsUsed,
            status: 'success',
          };
        } catch (err) {
          if (combinedSignal.aborted) {
            return {
              content: '',
              tokensUsed: 0,
              durationMs: Date.now() - startTime,
              toolsUsed: [],
              status: 'timeout',
              error: `Skill 执行超时（${timeout}ms）`,
            };
          }
          throw err;
        }
      } else {
        // 没有 handler — 作为 Knowledge Skill 直接返回编译后的 prompt
        return {
          content: prompt,
          tokensUsed: Math.ceil(prompt.length / 4),
          durationMs: Date.now() - startTime,
          toolsUsed: [],
          status: 'success',
        };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async loadHandler(
    handlerPath: string,
  ): Promise<(prompt: string, context: SkillContext, signal: AbortSignal) => Promise<SkillResult>> {
    const mod = await import(handlerPath);
    const exportFn = mod.default || mod.execute;
    if (typeof exportFn !== 'function') {
      throw new Error(`Handler ${handlerPath} 必须导出 default 函数或 execute 函数`);
    }
    return exportFn;
  }

  // ─── 信号合并 ───

  private combineSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    s1.addEventListener('abort', onAbort);
    s2.addEventListener('abort', onAbort);
    if (s1.aborted || s2.aborted) controller.abort();
    return controller.signal;
  }

  // ─── 熔断 ───

  isCircuitBroken(skillName: string): boolean {
    return (this.consecutiveFailures.get(skillName) || 0) >= this.MAX_CONSECUTIVE_FAILURES;
  }

  resetCircuitBreaker(skillName: string): void {
    this.consecutiveFailures.delete(skillName);
  }

  getCircuitBreakerStatus(): Record<string, { failures: number; isBroken: boolean }> {
    const status: Record<string, { failures: number; isBroken: boolean }> = {};
    for (const [name, count] of this.consecutiveFailures) {
      status[name] = { failures: count, isBroken: count >= this.MAX_CONSECUTIVE_FAILURES };
    }
    return status;
  }

  // ─── Trace ───

  private recordTrace(
    traceId: string,
    skill: SkillDefinition,
    startTime: number,
    result: SkillResult,
  ): SkillResult {
    const trace: SkillTrace = {
      traceId,
      spanId: crypto.randomUUID().slice(0, 8),
      skillName: skill.manifest.name,
      version: skill.manifest.version,
      startTime,
      durationMs: result.durationMs,
      tokensUsed: result.tokensUsed,
      tools: result.toolsUsed,
      status: result.status,
      error: result.error,
      metadata: {
        triggerType: '',
        inputSize: 0,
        outputSize: result.content.length,
        retryCount: 0,
      },
    };

    this.traces.push(trace);
    logger.info({ trace: trace.traceId, skill: trace.skillName, duration: trace.durationMs, status: trace.status }, '[SKILL-TRACE]');

    return result;
  }

  getTraces(limit = 50): SkillTrace[] {
    return this.traces.slice(-limit);
  }

  clearTraces(): void {
    this.traces = [];
  }

  // ─── Hook 执行 ───

  private async runHooks(
    phase: keyof SkillHook,
    ctx: Record<string, unknown>,
  ): Promise<void | { abort: boolean }> {
    const relevantHooks = this.hooks.filter(h => typeof h[phase] === 'function');
    if (relevantHooks.length === 0) return;

    const serialHooks = relevantHooks.filter(h => !h.parallel);
    const parallelHooks = relevantHooks.filter(h => h.parallel);

    for (const hook of serialHooks) {
      const fn = hook[phase] as (ctx: any) => Promise<void | { abort: boolean }>;
      if (fn) {
        const result = await fn(ctx);
        if (result?.abort) return { abort: true };
      }
    }

    if (parallelHooks.length > 0) {
      const results = await Promise.all(
        parallelHooks.map(hook => {
          const fn = hook[phase] as (ctx: any) => Promise<void | { abort: boolean }>;
          return fn ? fn(ctx).catch(err => {
            logger.error({ hookPhase: phase, error: (err as Error).message }, '[SKILL-RUNTIME] Hook 执行出错');
            return undefined;
          }) : undefined;
        }),
      );
      for (const result of results) {
        if (result?.abort) return { abort: true };
      }
    }
  }
}
