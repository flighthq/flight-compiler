import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

describe('flight-cpp array length assignments', () => {
  it('resizes an array and preserves the assignment expression value', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/example/src/resize.ts',
      'export function resize(values: number[], length: number): number { return (values.length = length); }',
      ts.ScriptTarget.Latest,
      true,
    );
    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/example',
      upstreamDirectory: '/flight',
    });

    expect(result.diagnostics).toEqual([]);
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
    expect(output).toContain('auto&& assignment_receiver = values');
    expect(output).toContain('assignment_receiver.resize(assignment_value)');
    expect(output).toContain('return assignment_value');
    expect(output).not.toContain('size() =');
  });

  it('refuses a write to fixed typed-array length', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/example/src/fixed.ts',
      'export function resize(values: Uint8Array, length: number): number { return (values.length = length); }',
      ts.ScriptTarget.Latest,
      true,
    );
    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/example',
      upstreamDirectory: '/flight',
    });

    expect(result.diagnostics).toEqual([]);
    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'typed-array length is read-only and cannot be resized',
    );
  });
});
