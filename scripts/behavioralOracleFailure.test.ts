import { describe, expect, it } from 'vitest';

import {
  assertBehavioralOracleProcessSucceeded,
  createBehavioralOracleFailureRecord,
  getBehavioralOracleFailureSummaries,
  type BehavioralOracleFailureStage,
} from './behavioralOracleFailure.js';

describe('behavioral-oracle process failures', () => {
  it('classifies compiler failures as build and nonzero fixture execution as run without reading messages', () => {
    const capture = (fixture: string, stage: BehavioralOracleFailureStage, message: string) => {
      try {
        assertBehavioralOracleProcessSucceeded(stage, 1, message);
      } catch (error) {
        return createBehavioralOracleFailureRecord(fixture, 'cpp', error);
      }
      throw new Error('Expected the process boundary to fail');
    };

    const compile = capture('brokenHeader', 'build', 'same diagnostic');
    const execute = capture('dateOperations', 'run', 'same diagnostic');

    expect(compile.stage).toBe('build');
    expect(execute.stage).toBe('run');
    expect(getBehavioralOracleFailureSummaries([execute, compile])).toEqual([
      '1 fixture(s) failed to build or link (cpp: 1 (brokenHeader)).',
      '1 fixture(s) failed to run (cpp: 1 (dateOperations)).',
    ]);
  });

  it('reports each failure class and target with deterministic fixture counts', () => {
    expect(
      getBehavioralOracleFailureSummaries([
        { fixture: 'zeta', message: 'compile', stage: 'build', target: 'haxe' },
        { fixture: 'alpha', message: 'link', stage: 'build', target: 'cpp' },
        { fixture: 'omega', message: 'execute', stage: 'run', target: 'rust' },
        { fixture: 'dateOperations', message: 'execute', stage: 'run', target: 'cpp' },
      ]),
    ).toEqual([
      '2 fixture(s) failed to build or link (cpp: 1 (alpha); haxe: 1 (zeta)).',
      '2 fixture(s) failed to run (cpp: 1 (dateOperations); rust: 1 (omega)).',
    ]);
  });
});
