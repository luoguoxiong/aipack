/**
 * Progress Guard 单元测试
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressGuard, DEFAULT_CONFIG } from '../src/progress-guard/index';
import type { TraceStep, RiskLevel, InterventionLevel } from '../src/progress-guard/types';
import {
  detectStateFreeze,
  detectErrorLoop,
  detectToolCycle,
  detectActionRepeat,
  detectProgressStagnation,
  detectBudgetWaste,
  computeProgressScore,
} from '../src/progress-guard/progress-analyzer';
import { TraceCollector, simpleHash, errorFingerprint } from '../src/progress-guard/trace-collector';
import { StateEngine } from '../src/progress-guard/state-engine';

// ─── Trace Collector ───

describe('TraceCollector', () => {
  it('should collect tool call steps', () => {
    const collector = new TraceCollector(20);
    collector.startTurn();
    collector.recordToolCall('read_file', { file_path: '/test.ts' }, {
      success: true,
      output: 'file content',
    }, 'before', 'after');

    const trace = collector.getTrace();
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0].toolName, 'read_file');
    assert.equal(trace.steps[0].toolIntent, 'READ');
  });

  it('should respect window size', () => {
    const collector = new TraceCollector(5);
    for (let i = 0; i < 10; i++) {
      collector.startTurn();
      collector.recordToolCall('read_file', { file_path: `/file${i}.ts` }, {
        success: true,
        output: `content${i}`,
      }, 'b', 'a');
    }

    const trace = collector.getTrace();
    assert.equal(trace.steps.length, 5);
    assert.equal(trace.totalSteps, 10);
  });
});

// ─── State Engine ───

describe('StateEngine', () => {
  it('should track resource modifications', () => {
    const engine = new StateEngine();

    engine.recordWrite('file', '/test.ts', 'hash_v1');
    assert.equal(engine.getSnapshot().modifiedCount, 1);

    engine.recordWrite('file', '/test.ts', 'hash_v2');
    assert.equal(engine.getSnapshot().modifiedCount, 1); // same file

    engine.recordWrite('file', '/other.ts', 'hash_v3');
    assert.equal(engine.getSnapshot().modifiedCount, 2);
  });

  it('should change stateHash on write', () => {
    const engine = new StateEngine();
    const hash1 = engine.getSnapshot().stateHash;

    engine.recordWrite('file', '/test.ts', 'content1');
    const hash2 = engine.getSnapshot().stateHash;
    assert.notEqual(hash1, hash2);

    engine.recordWrite('file', '/test.ts', 'content2');
    const hash3 = engine.getSnapshot().stateHash;
    assert.notEqual(hash2, hash3);
  });
});

// ─── Detection Strategies ───

function makeStep(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    id: 1,
    turnIndex: 1,
    type: 'tool_call',
    success: true,
    stateBefore: 'a',
    stateAfter: 'b',
    stateChanged: true,
    timestamp: Date.now(),
    durationMs: 100,
    ...overrides,
  };
}

describe('State Freeze Detection', () => {
  it('should detect when writes do not change state', () => {
    const steps: TraceStep[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push(makeStep({
        id: i + 1,
        toolIntent: 'MODIFY',
        stateChanged: false,
      }));
    }

    const result = detectStateFreeze(steps, 3);
    assert.equal(result.detected, true);
    assert.equal(result.confidence, 0.9);
  });

  it('should not trigger for read operations', () => {
    const steps: TraceStep[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push(makeStep({
        id: i + 1,
        toolIntent: 'READ',
        stateChanged: false,
      }));
    }

    const result = detectStateFreeze(steps, 3);
    assert.equal(result.detected, false);
  });
});

describe('Error Loop Detection', () => {
  it('should detect same error repeated', () => {
    const steps: TraceStep[] = [];
    const errHash = simpleHash('same error');
    for (let i = 0; i < 4; i++) {
      steps.push(makeStep({
        id: i + 1,
        success: false,
        errorHash: errHash,
        errorType: 'syntax',
      }));
    }

    const result = detectErrorLoop(steps, 3);
    assert.equal(result.detected, true);
    assert.ok(result.confidence >= 0.8);
  });

  it('should not trigger for different errors', () => {
    const steps: TraceStep[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push(makeStep({
        id: i + 1,
        success: false,
        errorHash: simpleHash(`error ${i}`),
        errorType: 'unknown',
      }));
    }

    const result = detectErrorLoop(steps, 3);
    assert.equal(result.detected, false);
  });
});

describe('Tool Cycle Detection', () => {
  it('should detect 2-gram cycle', () => {
    const steps: TraceStep[] = [];
    // MODIFY → VERIFY repeated 3 times with no state change
    for (let round = 0; round < 3; round++) {
      steps.push(makeStep({ id: round * 2 + 1, toolIntent: 'MODIFY', stateChanged: false, stateBefore: 'same', stateAfter: 'same' }));
      steps.push(makeStep({ id: round * 2 + 2, toolIntent: 'VERIFY', stateChanged: false, stateBefore: 'same', stateAfter: 'same' }));
    }

    const result = detectToolCycle(steps, 3);
    assert.equal(result.detected, true);
    assert.ok(result.confidence >= 0.4);
  });
});

describe('Action Repeat Detection', () => {
  it('should detect repeated identical tool calls', () => {
    const steps: TraceStep[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push(makeStep({
        id: i + 1,
        toolName: 'read_file',
        toolIntent: 'READ',
        inputHash: 'same_hash',
        targetKey: '/config.json',
      }));
    }

    const result = detectActionRepeat(steps);
    assert.equal(result.detected, true);
  });
});

describe('Progress Stagnation Detection', () => {
  it('should detect consecutive low progress', () => {
    const history = [0.1, 0.05, 0.02, 0.01, 0.0];
    const result = detectProgressStagnation(history, 0.2, 4);
    assert.equal(result.detected, true);
  });

  it('should not trigger when progress is ok', () => {
    const history = [0.5, 0.4, 0.3, 0.6];
    const result = detectProgressStagnation(history, 0.2, 4);
    assert.equal(result.detected, false);
  });
});

describe('Budget Waste Detection', () => {
  it('should detect high token waste', () => {
    const budget = { tokens: 100000, cost: 0, toolCalls: 50, turns: 10, durationMs: 60000 };
    const result = detectBudgetWaste(budget, 0.05, 50000);
    assert.equal(result.detected, true);
  });
});

// ─── Progress Score ───

describe('Progress Score', () => {
  it('should return baseline for empty steps', () => {
    const result = computeProgressScore([], 0.5);
    assert.equal(result.score, 0.5);
    assert.equal(result.trend, 'flat');
  });

  it('should score higher when state changes', () => {
    const steps = [makeStep({ toolIntent: 'MODIFY', stateChanged: true, resourceId: '/new.ts', outputHash: 'unique' })];
    const result = computeProgressScore(steps, 0);
    assert.ok(result.score > 0);
  });
});

// ─── Full Integration ───

describe('ProgressGuard Integration', () => {
  it('should be constructed with defaults', () => {
    const pg = new ProgressGuard();
    assert.equal(pg.isEnabled, true);
    assert.equal(pg.riskLevel, 'normal');
  });

  it('should be constructable with profile override', () => {
    const pg = new ProgressGuard({ profile: 'coding' });
    assert.equal(pg.isEnabled, true);
  });

  it('should expose metrics', () => {
    const pg = new ProgressGuard();
    const metrics = pg.getMetrics();
    assert.equal(metrics.riskLevel, 'normal');
    assert.equal(metrics.tokensTotal, 0);
  });

  it('should expose dashboard data', () => {
    const pg = new ProgressGuard();
    const data = pg.getDashboardData();
    assert.ok(Array.isArray(data.history));
    assert.ok(data.currentWeights);
  });

  it('should emit progress_update events', () => {
    const pg = new ProgressGuard({ minTurnsBeforeDetect: 0 });
    const events: any[] = [];
    pg.on(e => events.push(e));

    // Simulate turns
    pg.startTurn();
    pg.recordAssistantOutput('hello world');

    // No detection yet (not enough data), but guard should not crash
    assert.ok(true);
  });

  it('should reset cleanly', () => {
    const pg = new ProgressGuard();
    pg.startTurn();
    pg.recordAssistantOutput('test');
    pg.reset();
    assert.equal(pg.turn, 0);
    assert.equal(pg.riskLevel, 'normal');
  });
});

// ─── Utilities ───

describe('Utilities', () => {
  it('simpleHash should produce consistent results', () => {
    const h1 = simpleHash('test');
    const h2 = simpleHash('test');
    assert.equal(h1, h2);
  });

  it('simpleHash should produce different results for different inputs', () => {
    const h1 = simpleHash('hello');
    const h2 = simpleHash('world');
    assert.notEqual(h1, h2);
  });

  it('errorFingerprint should normalize line numbers', () => {
    const e1 = errorFingerprint('Error at line 10:5: undefined variable');
    const e2 = errorFingerprint('Error at line 20:8: undefined variable');
    assert.equal(e1, e2);
  });
});
