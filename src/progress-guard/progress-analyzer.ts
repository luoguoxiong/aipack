/**
 * Progress Analyzer — 计算进展评分 + 6 种检测策略
 */

import type {
  TraceStep,
  ExecutionTrace,
  ProgressScore,
  ProgressSignals,
  DetectionResult,
  StrategyName,
  BudgetState,
} from './types';

// ─── 进展评分 ───

const DEFAULT_SIGNAL_WEIGHTS = {
  stateChange: 0.35,
  infoGain: 0.30,
  errorMovement: 0.20,
  novelty: 0.10,
  outputGrowth: 0.05,
};

export function computeProgressScore(
  steps: TraceStep[],
  previousScore: number,
): ProgressScore {
  if (steps.length === 0) {
    return { score: 0.5, trend: 'flat', signals: zeroSignals() };
  }

  const recent = steps.slice(-5); // 最近 5 步
  const signals = computeSignals(recent, steps);

  const score =
    DEFAULT_SIGNAL_WEIGHTS.stateChange * signals.stateChange +
    DEFAULT_SIGNAL_WEIGHTS.infoGain * signals.infoGain +
    DEFAULT_SIGNAL_WEIGHTS.errorMovement * signals.errorMovement +
    DEFAULT_SIGNAL_WEIGHTS.novelty * signals.novelty +
    DEFAULT_SIGNAL_WEIGHTS.outputGrowth * signals.outputGrowth;

  const clampedScore = Math.max(0, Math.min(1, score));

  let trend: ProgressScore['trend'] = 'flat';
  if (clampedScore > previousScore + 0.05) trend = 'up';
  else if (clampedScore < previousScore - 0.05) trend = 'down';

  return { score: clampedScore, trend, signals };
}

function zeroSignals(): ProgressSignals {
  return { stateChange: 0, infoGain: 0, errorMovement: 0, novelty: 0, outputGrowth: 0 };
}

function computeSignals(recent: TraceStep[], all: TraceStep[]): ProgressSignals {
  // stateChange: 最近写操作是否改变了状态
  const writeSteps = recent.filter(s => s.toolIntent === 'MODIFY');
  const stateChange = writeSteps.length > 0
    ? writeSteps.filter(s => s.stateChanged).length / writeSteps.length
    : 0;

  // infoGain: 最近是否有新的输出/新的资源
  const uniqueOutputHashes = new Set(recent.filter(s => s.outputHash).map(s => s.outputHash));
  const uniqueResourceIds = new Set(recent.filter(s => s.resourceId).map(s => s.resourceId));
  const infoGain = Math.min(1, (uniqueOutputHashes.size + uniqueResourceIds.size * 0.5) / 5);

  // errorMovement: 错误是否在变化/减少
  const errorSteps = recent.filter(s => !s.success);
  if (errorSteps.length === 0) {
    // 没有错误 = 好的进展
    return { stateChange, infoGain, errorMovement: 0.5, novelty: 0, outputGrowth: 0 };
  }
  const uniqueErrors = new Set(errorSteps.map(s => s.errorHash));
  // 错误种类少且集中 = 不好；错误在变化 = 还在尝试
  const errorMovement = uniqueErrors.size > 1 ? 0.3 : 0;

  // novelty: 操作了多少不同的资源
  const allResourceIds = new Set(all.map(s => s.resourceId).filter(Boolean));
  const recentResourceIds = new Set(recent.map(s => s.resourceId).filter(Boolean));
  const newResources = [...recentResourceIds].filter(id => !allResourceIds.has(id) || true); // 最近都在用新的
  const novelty = Math.min(1, recentResourceIds.size / 3);

  // outputGrowth: 文本输出是否在增长
  const textSteps = recent.filter(s => s.textLength && s.textLength > 0);
  const outputGrowth = textSteps.length > 0
    ? Math.min(1, textSteps.reduce((sum, s) => sum + (s.textLength || 0), 0) / 2000)
    : 0;

  return { stateChange, infoGain, errorMovement, novelty, outputGrowth };
}

// ─── 检测策略 ───

/**
 * 5.1 State Freeze: 写操作后资源状态没有变化
 */
export function detectStateFreeze(steps: TraceStep[], threshold = 3): DetectionResult {
  const writeSteps = steps.filter(s => s.toolIntent === 'MODIFY' && s.type === 'tool_call');

  if (writeSteps.length < threshold) {
    return { detected: false, confidence: 0 };
  }

  // 从最近的写操作往前找连续的冻结
  let consecutiveFreeze = 0;
  for (let i = writeSteps.length - 1; i >= 0; i--) {
    if (!writeSteps[i].stateChanged) {
      consecutiveFreeze++;
    } else {
      break;
    }
  }

  if (consecutiveFreeze >= threshold) {
    return {
      detected: true,
      confidence: 0.9,
      pattern: 'state_freeze',
      detail: `连续 ${consecutiveFreeze} 次写操作未改变资源状态`,
      evidenceIndices: writeSteps.slice(-consecutiveFreeze).map(s => s.id),
    };
  }

  return { detected: false, confidence: consecutiveFreeze / threshold * 0.5 };
}

/**
 * 5.2 Error Loop: 同一错误反复出现
 */
export function detectErrorLoop(steps: TraceStep[], threshold = 3): DetectionResult {
  const errorSteps = steps.filter(s => !s.success && s.errorHash);

  if (errorSteps.length < threshold) {
    return { detected: false, confidence: 0 };
  }

  // 统计每个 errorHash 的出现次数
  const errorCounts = new Map<string, number>();
  for (const step of errorSteps) {
    const hash = step.errorHash!;
    errorCounts.set(hash, (errorCounts.get(hash) || 0) + 1);
  }

  // 找到出现最多的错误
  let maxCount = 0;
  let maxHash = '';
  for (const [hash, count] of errorCounts) {
    if (count > maxCount) {
      maxCount = count;
      maxHash = hash;
    }
  }

  if (maxCount >= threshold) {
    const errorStep = errorSteps.find(s => s.errorHash === maxHash);
    return {
      detected: true,
      confidence: 0.85,
      pattern: 'error_loop',
      detail: `同一错误出现 ${maxCount} 次: ${errorStep?.errorType || 'unknown'}`,
      evidenceIndices: errorSteps.filter(s => s.errorHash === maxHash).map(s => s.id),
    };
  }

  return { detected: false, confidence: maxCount / threshold * 0.4 };
}

/**
 * 5.3 Tool Intent Cycle: N-gram 模式匹配
 */
export function detectToolCycle(steps: TraceStep[], threshold = 3): DetectionResult {
  const toolSteps = steps.filter(s => s.toolIntent && s.type === 'tool_call');
  const intentSeq = toolSteps.map(s => s.toolIntent!);

  if (intentSeq.length < 4) {
    return { detected: false, confidence: 0 };
  }

  // 检测 2-gram 和 3-gram 的重复
  for (const gramSize of [2, 3, 4] as const) {
    if (intentSeq.length < gramSize * threshold) continue;

    const patterns = new Map<string, { count: number; indices: number[] }>();

    for (let i = 0; i <= intentSeq.length - gramSize; i++) {
      const pattern = intentSeq.slice(i, i + gramSize).join('→');
      const existing = patterns.get(pattern);
      if (existing) {
        existing.count++;
        existing.indices.push(i);
      } else {
        patterns.set(pattern, { count: 1, indices: [i] });
      }
    }

    // 找到重复最多的模式
    for (const [pattern, { count, indices }] of patterns) {
      if (count >= threshold) {
        // 检查是否有进展（stateChange 或 infoGain）
        const patternSteps = indices.flatMap(startIdx =>
          toolSteps.slice(startIdx, startIdx + gramSize),
        );
        const hasProgress = patternSteps.some(s => s.stateChanged);
        if (hasProgress) continue;

        const baseConfidence = gramSize === 2 ? 0.5 : gramSize === 3 ? 0.65 : 0.75;
        const confidence = Math.min(0.85, baseConfidence + (count - threshold) * 0.05);

        return {
          detected: true,
          confidence,
          pattern: `tool_cycle_${gramSize}gram`,
          detail: `模式 [${pattern}] 重复 ${count} 次`,
          evidenceIndices: patternSteps.map(s => s.id),
        };
      }
    }
  }

  return { detected: false, confidence: 0 };
}

/**
 * 5.4 Action Repetition: 完全相同的工具调用重复
 */
export function detectActionRepeat(steps: TraceStep[]): DetectionResult {
  const toolSteps = steps.filter(s => s.type === 'tool_call' && s.toolName && s.inputHash);

  if (toolSteps.length < 3) {
    return { detected: false, confidence: 0 };
  }

  // 从末尾往前找连续重复
  const last = toolSteps[toolSteps.length - 1];
  const key = `${last.toolName}:${last.inputHash}`;
  let consecutiveRepeat = 1;

  for (let i = toolSteps.length - 2; i >= 0; i--) {
    const step = toolSteps[i];
    if (`${step.toolName}:${step.inputHash}` === key) {
      consecutiveRepeat++;
    } else {
      break;
    }
  }

  // 读操作阈值更高（5），写操作阈值更低（3）
  const isRead = last.toolIntent === 'READ' || last.toolIntent === 'RESEARCH';
  const threshold = isRead ? 5 : 3;

  if (consecutiveRepeat >= threshold) {
    return {
      detected: true,
      confidence: isRead ? 0.4 : 0.6,
      pattern: 'action_repeat',
      detail: `${last.toolName}(${last.targetKey || 'unknown'}) 连续调用 ${consecutiveRepeat} 次`,
      evidenceIndices: toolSteps.slice(-consecutiveRepeat).map(s => s.id),
    };
  }

  return { detected: false, confidence: 0 };
}

/**
 * 5.5 Progress Stagnation: 连续多轮进展分低于阈值
 */
export function detectProgressStagnation(
  progressHistory: number[],
  threshold = 0.2,
  minTurns = 4,
): DetectionResult {
  if (progressHistory.length < minTurns) {
    return { detected: false, confidence: 0 };
  }

  const recent = progressHistory.slice(-minTurns);
  const allBelowThreshold = recent.every(s => s < threshold);

  if (allBelowThreshold) {
    // 趋势是否在下降
    const isDeclining = recent[recent.length - 1] < recent[0];
    const confidence = isDeclining ? 0.8 : 0.6;

    return {
      detected: true,
      confidence,
      pattern: 'progress_stagnation',
      detail: `连续 ${minTurns} 轮进展分低于 ${threshold}${isDeclining ? '，且持续下降' : ''}`,
    };
  }

  return { detected: false, confidence: 0 };
}

/**
 * 5.6 Budget Waste: 高消耗 + 低进展
 */
export function detectBudgetWaste(
  budget: BudgetState,
  progressScore: number,
  efficiencyThreshold = 50000,
): DetectionResult {
  if (!budget.tokens || budget.tokens < 5000) {
    return { detected: false, confidence: 0 };
  }

  const efficiency = budget.tokens / (progressScore + 0.1);

  if (efficiency > efficiencyThreshold) {
    const confidence = Math.min(0.8, 0.4 + (efficiency / efficiencyThreshold - 1) * 0.2);
    return {
      detected: true,
      confidence,
      pattern: 'budget_waste',
      detail: `token 效率比 ${Math.round(efficiency)} 超过阈值 ${efficiencyThreshold}`,
    };
  }

  return { detected: false, confidence: 0 };
}
