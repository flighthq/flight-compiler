import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

function emit(source: string): string {
  const lowering = lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/power/src/probe.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/power', upstreamDirectory: '/flight' },
  );
  expect(lowering.diagnostics).toEqual([]);
  const session = createCppCompilerBackend().createEmissionSession!({
    modules: [lowering.module],
    options: {
      packageTargets: {
        '@flighthq/power': { includePrefix: 'flight/power', namespace: 'flight::power' },
      },
      runtimeProfile: 'flight-cpp',
    },
  });
  return session.emitModule(lowering.module)[0]!.contents;
}

describe('C++ nullish assignment on an erased target', () => {
  it('keeps the conditional write when the assignment is a statement', () => {
    const contents = emit(`
      export function accumulate(values: readonly number[]): unknown {
        let current: unknown = null;
        for (const value of values) current ??= value;
        return current;
      }`);

    expect(contents).toContain('if (assignment_target.is_nullish()) assignment_target = value;');
  });

  it('keeps the conditional write when the assignment value is consumed', () => {
    const contents = emit(`
      export function pick(fallback: unknown): unknown {
        let current: unknown = null;
        return current ??= fallback;
      }`);

    expect(contents).toContain('if (assignment_target.is_nullish()) assignment_target = fallback;');
  });

  it('uses one loose guard for both null and undefined initial states', () => {
    const fromNull = emit(`
      export function pick(fallback: unknown): unknown {
        let current: unknown = null;
        return current ??= fallback;
      }`);
    const fromUndefined = emit(`
      export function pick(fallback: unknown): unknown {
        let current: unknown = undefined;
        return current ??= fallback;
      }`);

    for (const contents of [fromNull, fromUndefined]) {
      expect(contents).toContain('assignment_target.is_nullish()');
      expect(contents).not.toContain('assignment_target.is_null()');
      expect(contents).not.toContain('assignment_target.is_undefined()');
    }
  });

  it('evaluates a property assignment target once and preserves its Any carrier', () => {
    const contents = emit(`
      interface State { current: unknown }
      export function pick(getState: () => State, fallback: unknown): unknown {
        return getState().current ??= fallback;
      }`);
    const assignment = contents.split('\n').find((line) => line.includes('assignment_target =')) ?? '';

    expect(assignment).toContain('auto&& assignment_target = get_state()->current;');
    expect(assignment.match(/get_state\(\)/gu)).toHaveLength(1);
  });

  it('leaves a carrier that cannot hold null or undefined on the no-op path', () => {
    const contents = emit(`
      export function bump(count: number): number {
        let total: number = 0;
        total ??= count;
        return total;
      }`);

    expect(contents).not.toContain('is_nullish');
    expect(contents).toContain('total;');
  });
});
