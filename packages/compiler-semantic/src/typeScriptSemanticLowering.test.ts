import ts from 'typescript';

import { lowerTypeScriptSource } from './typeScriptSemanticLowering.js';

function lower(file: string, source: string) {
  const sourceFile = ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
}

describe('lowerTypeScriptSource', () => {
  it('resolves enum auto-increment values after explicit discriminants', () => {
    const result = lower('mode.ts', 'export enum Mode { A = 1, B, C = Mode.A << 3, D }');

    expect(result.diagnostics).toEqual([]);
    expect(result.module.declarations[0]).toMatchObject({
      kind: 'enum',
      members: [
        { name: 'A', value: 1 },
        { name: 'B', value: 2 },
        { name: 'C', value: 8 },
        { name: 'D', value: 9 },
      ],
    });
  });

  it('preserves string enum representation in the neutral IR', () => {
    const result = lower('kind.ts', "export enum Kind { A = 'a', B = 'b' }");

    expect(result.module.declarations[0]).toMatchObject({
      kind: 'enum',
      members: [
        { name: 'A', value: 'a' },
        { name: 'B', value: 'b' },
      ],
    });
  });

  it('represents re-exports and default exports instead of silently skipping them', () => {
    const result = lower(
      'barrel.ts',
      "export { thing as value } from './thing.js'; export * from './other.js'; export default 1;",
    );

    expect(result.module.exports).toEqual([
      { exported: 'value', imported: 'thing', kind: 'reexport', specifier: './thing.js', typeOnly: false },
      { kind: 'all', specifier: './other.js', typeOnly: false },
      { expression: { kind: 'literal', value: 1 }, kind: 'default' },
    ]);
  });

  it('diagnoses constructor overloads and parameter properties without partial class IR', () => {
    const overloads = lower(
      'point.ts',
      'export class Point { constructor(a: number); constructor(a: string); constructor(x: number | string) {} }',
    );
    const parameterProperty = lower('value.ts', 'export class Value { constructor(public readonly value: number) {} }');

    expect(overloads.module.declarations).toEqual([]);
    expect(overloads.diagnostics[0]?.message).toContain('constructor overloads');
    expect(parameterProperty.module.declarations).toEqual([]);
    expect(parameterProperty.diagnostics[0]?.message).toContain('parameter properties');
  });

  it('returns stable globally identified one-based diagnostics', () => {
    const result = lower('namespace.ts', 'export namespace Values {}');

    expect(result.diagnostics).toEqual([
      {
        code: 'unsupported-typescript',
        column: 1,
        line: 1,
        message: 'namespace declarations are not represented in the neutral IR yet',
        packageName: '@flighthq/math',
        source: 'packages/math/src/namespace.ts',
      },
    ]);
  });

  it('uses per-declarator fingerprints and lowers negative literal types', () => {
    const result = lower('values.ts', 'export const a = 1, b = 2; export type Sign = -1 | 0 | 1;');
    const [a, b, sign] = result.module.declarations;

    expect(a?.origin.fingerprint).not.toBe(b?.origin.fingerprint);
    expect(sign).toMatchObject({ kind: 'type', type: { kind: 'union' } });
    if (sign?.kind !== 'type' || sign.type.kind !== 'union') throw new Error('Expected union type alias');
    expect(sign.type.types[0]).toEqual({ kind: 'literal', value: -1 });
  });
});
