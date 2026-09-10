import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string, runtimeProfile: 'flight-cpp' | 'standard-library'): string {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/example/src/typed-array.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/example',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile }).contents;
}

describe('C++ typed-array member emission', () => {
  it.each(['flight-cpp', 'standard-library'] as const)('emits length through size() in the %s profile', (profile) => {
    const output = emit('export function length(values: Uint8Array): number { return values.length; }', profile);
    expect(output).toContain('static_cast<double>(values.size())');
  });

  it('emits the common flight-cpp typed-array methods against the runtime API', () => {
    const output = emit(
      'export function update(values: Uint8Array, source: Uint8Array): Uint8Array { values.fill(1); values.set(source); values.slice(0, 1); return values.subarray(0, 1); }',
      'flight-cpp',
    );
    expect(output).toContain('values.fill(1.0)');
    expect(output).toContain('values.set(source)');
    expect(output).toContain('values.slice(0.0, 1.0)');
    expect(output).toContain('values.subarray(0.0, 1.0)');
  });
});
