import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function lower(source: string) {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/example/src/inferred.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/example',
    upstreamDirectory: '/flight',
  });
}

describe('C++ inferred ambient types', () => {
  it('keeps typed arrays and maps as named runtime types', () => {
    const result = lower(
      'interface Row { key: number } function table(): Map<number, Row> { return new Map<number, Row>(); } export function copy(bytes: Readonly<Uint8Array>): Uint8Array { const input = bytes as Uint8Array; const rows = table(); rows.size; return input.slice(0); }',
    );

    expect(result.diagnostics).toEqual([]);
    const output = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
    expect(output).toContain('flight::Uint8Array input = static_cast<flight::Uint8Array>(bytes)');
    expect(output).toContain('flight::Map<double, flight::Ref<Row>> rows = table()');
    expect(output).not.toMatch(/\bauto\s+(?:length|size)\s*;/u);
    expect(output).not.toContain('std::function<auto');
  });

  it('refuses an anonymous object data member without concrete type evidence', () => {
    const result = lower('export function wrap(value: any) { return { value }; }');
    expect(result.diagnostics).toEqual([]);
    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'anonymous object property value requires concrete C++ type evidence',
    );
  });

  it('refuses an unbound ambient namespace member instead of emitting property syntax', () => {
    const result = lower('export function random(): number { return Math.random(); }');
    expect(result.diagnostics).toEqual([]);
    expect(() => emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' })).toThrow(
      'ambient value Math member random has no C++ binding',
    );
  });
});
