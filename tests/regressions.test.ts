import ts from 'typescript';

import type { BackendEmissionError } from '../src/index.ts';
import {
  applySemanticPatches,
  emitHaxeModule,
  emitRustModule,
  lowerTypeScriptSource,
  parseTypeScriptSource,
} from '../src/index.ts';

function lower(file: string, source: string) {
  return lowerTypeScriptSource(parseTypeScriptSource(`/flight/packages/math/src/${file}`, source), {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
}

describe('neutral lowering regressions', () => {
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
    expect(emitHaxeModule(result.module).contents).toContain('var D = 9;');
    expect(emitRustModule(result.module).contents).toContain('D = 9,');
  });

  it('preserves string enum representation for Haxe and rejects it for Rust', () => {
    const result = lower('kind.ts', "export enum Kind { A = 'a', B = 'b' }");

    expect(emitHaxeModule(result.module).contents).toContain('enum abstract Kind(String) from String to String');
    expect(() => emitRustModule(result.module)).toThrow('requires integer discriminants for Rust');
  });

  it('represents re-exports and default exports instead of silently skipping them', () => {
    const result = lower(
      'barrel.ts',
      "export { thing as value } from './thing.js'; export * from './other.js'; export default 1;",
    );

    expect(result.accountedDeclarations).toBe(0);
    expect(result.accountedExports).toBe(3);
    expect(result.module.exports).toEqual([
      { exported: 'value', imported: 'thing', kind: 'reexport', specifier: './thing.js', typeOnly: false },
      { kind: 'all', specifier: './other.js', typeOnly: false },
      { expression: { kind: 'literal', value: 1 }, kind: 'default' },
    ]);
    expect(() => emitHaxeModule(result.module)).toThrow('module-facade lowering');
    expect(() => emitRustModule(result.module)).toThrow('module-facade lowering');
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

  it('uses per-declarator fingerprints and lowers negative literal types', () => {
    const result = lower('values.ts', 'export const a = 1, b = 2; export type Sign = -1 | 0 | 1;');
    const [a, b, sign] = result.module.declarations;

    expect(a?.origin.fingerprint).not.toBe(b?.origin.fingerprint);
    expect(sign).toMatchObject({ kind: 'type', type: { kind: 'union' } });
    if (sign?.kind !== 'type' || sign.type.kind !== 'union') throw new Error('Expected union type alias');
    expect(sign.type.types[0]).toEqual({ kind: 'literal', value: -1 });
  });

  it('selects TSX parsing from the source extension', () => {
    expect(parseTypeScriptSource('/flight/component.tsx', 'const view = <div />;').languageVariant).toBe(
      ts.LanguageVariant.JSX,
    );
  });
});

describe('backend emission regressions', () => {
  it('keeps Rust local bindings distinct from same-named module constants', () => {
    const result = lower(
      'guard.ts',
      'export const limit: number = 4; export function check(value: number): number { const limit: number = 9; if (value > limit) throw new Error("too big"); return limit; }',
    );
    const output = emitRustModule(result.module).contents;

    expect(output).toContain('const LIMIT: f64 = 4.0;');
    expect(output).toContain('let limit: f64 = 9.0;');
    expect(output).toContain('(value > limit)');
    expect(output).toContain('Error::new("too big".to_owned())');
    expect(output).toContain('panic!("{:?}",');
    expect(output).not.toContain('panic!("{{:?}}"');
  });

  it('restores Rust module bindings after a nested shadowing scope', () => {
    const result = lower(
      'scope.ts',
      'export const limit: number = 4; export function read(flag: boolean): number { if (flag) { const limit: number = 9; return limit; } return limit; }',
    );
    const output = emitRustModule(result.module).contents;

    expect(output).toContain('return limit;');
    expect(output).toContain('return LIMIT;');
  });

  it('keeps Rust parameters and nested closure parameters local when they shadow module constants', () => {
    const result = lower(
      'parameters.ts',
      'export const limit: number = 4; export function read(limit: number): number { return limit; } export function makeReader(): (limit: number) => number { return (limit: number): number => limit; }',
    );
    const output = emitRustModule(result.module).contents;

    expect(output).toContain('pub fn read(limit: f64) -> f64 {\n  return limit;');
    expect(output).toContain('return |limit| limit;');
    expect(output.match(/return LIMIT;/gu)).toBeNull();
  });

  it('uses one Haxe identity for emitted and imported index modules and rejects default imports', () => {
    const index = lower('index.ts', 'export function helper(): number { return 1; }');
    const consumer = lower(
      'consumer.ts',
      "import { helper } from './index.js'; export function use(): number { return helper(); }",
    );
    const defaultImport = lower(
      'default.ts',
      "import helper from './index.js'; export function use(): number { return helper(); }",
    );

    expect(emitHaxeModule(index.module).path).toBe('flighthq/math/_Index.hx');
    expect(emitHaxeModule(index.module).contents).toContain('class _Index');
    expect(emitHaxeModule(consumer.module).contents).toContain('import flighthq.math._Index.helper;');
    expect(() => emitHaxeModule(defaultImport.module)).toThrow('default imports require explicit Haxe mapping');
  });

  it('rejects operators and switch control flow without semantic lowering', () => {
    const operator = lower('operator.ts', 'export function power(a: number, b: number): number { return a ** b; }');
    const fallthrough = lower(
      'switch.ts',
      'export function choose(a: number): number { switch (a) { case 1: case 2: return 2; default: return 0; } }',
    );

    expect(() => emitHaxeModule(operator.module)).toThrow('operator ** requires Haxe semantic lowering');
    expect(() => emitRustModule(operator.module)).toThrow('operator ** requires Rust semantic lowering');
    expect(() => emitHaxeModule(fallthrough.module)).toThrow('switch fallthrough');
    expect(() => emitRustModule(fallthrough.module)).toThrow('fallthrough-aware Rust lowering');
  });

  it('rejects Rust class state and default parameters that would otherwise be dropped', () => {
    const staticField = lower('config.ts', 'export class Config { static limit: number = 3; value: number = 1; }');
    const defaultParameter = lower('default.ts', 'export function read(value: number = 1): number { return value; }');

    expect(() => emitRustModule(staticField.module)).toThrow('static fields require associated-item lowering');
    expect(() => emitRustModule(defaultParameter.module)).toThrow('default parameter value');
  });

  it('preserves Haxe final locals and abstract classes', () => {
    const result = lower(
      'base.ts',
      'export abstract class Base {} export function read(): number { const value: number = 1; return value; }',
    );
    const output = emitHaxeModule(result.module).contents;

    expect(output).toContain('abstract class Base');
    expect(output).toContain('final value:Float = 1;');
  });

  it('sets backend error identity', () => {
    const result = lower('unsupported.ts', 'export async function read(): Promise<number> { return 1; }');

    expect(() => emitHaxeModule(result.module)).toThrow(
      expect.objectContaining<Partial<BackendEmissionError>>({ name: 'BackendEmissionError' }),
    );
  });
});

describe('semantic patch precedence', () => {
  it('applies backend patches after neutral patches independent of patch identifiers', () => {
    const result = lower('clamp.ts', 'export function clamp(value: number): number { return value; }');
    const declaration = result.module.declarations[0]!;
    const target = {
      export: declaration.name,
      package: declaration.origin.packageName,
      source: declaration.origin.source,
    };
    const base = {
      expect: { fingerprint: declaration.origin.fingerprint, kind: 'function' as const },
      reason: 'test',
      target,
    };
    const patched = applySemanticPatches(
      [result.module],
      [
        { ...base, id: 'zzz-neutral', name: 'neutralName', operation: 'rename', scope: { kind: 'neutral' } },
        { ...base, id: 'aaa-rust', name: 'rustName', operation: 'rename', scope: { backend: 'rust', kind: 'backend' } },
      ],
      'rust',
    );

    expect(patched.modules[0]?.declarations[0]?.name).toBe('rustName');
    expect(patched.audit.applied.map((record) => record.id)).toEqual(['zzz-neutral', 'aaa-rust']);
  });
});
