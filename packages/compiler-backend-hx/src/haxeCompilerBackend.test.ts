import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createHaxeCompilerBackend, emitIrModuleHaxe } from './haxeCompilerBackend.js';

function lower(file: string, source: string) {
  const sourceFile = ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
}

describe('createHaxeCompilerBackend', () => {
  it('creates independent stateless backend records with Haxe identity', () => {
    const first = createHaxeCompilerBackend();
    const second = createHaxeCompilerBackend();

    expect(first).not.toBe(second);
    expect(first.name).toBe('haxe');
    expect(first.emitModule(lower('value.ts', 'export const value = 1;').module, { modules: [], options: {} })).toEqual(
      [emitIrModuleHaxe(lower('value.ts', 'export const value = 1;').module)],
    );
  });
});

describe('emitIrModuleHaxe', () => {
  it('emits numeric and string enums from neutral representation', () => {
    const numeric = lower('mode.ts', 'export enum Mode { A = 1, B, C = Mode.A << 3, D }');
    const strings = lower('kind.ts', "export enum Kind { A = 'a', B = 'b' }");

    expect(emitIrModuleHaxe(numeric.module).contents).toContain('var D = 9;');
    expect(emitIrModuleHaxe(strings.module).contents).toContain('enum abstract Kind(String) from String to String');
  });

  it('uses one identity for emitted and imported index modules and rejects default imports', () => {
    const index = lower('index.ts', 'export function helper(): number { return 1; }');
    const consumer = lower(
      'consumer.ts',
      "import { helper } from './index.js'; export function use(): number { return helper(); }",
    );
    const defaultImport = lower(
      'default.ts',
      "import helper from './index.js'; export function use(): number { return helper(); }",
    );

    expect(emitIrModuleHaxe(index.module).path).toBe('flighthq/math/_Index.hx');
    expect(emitIrModuleHaxe(index.module).contents).toContain('class _Index');
    expect(emitIrModuleHaxe(consumer.module).contents).toContain('import flighthq.math._Index.helper;');
    expect(() => emitIrModuleHaxe(defaultImport.module)).toThrow('default imports require explicit Haxe mapping');
  });

  it('rejects module facades and switch fallthrough without semantic lowering', () => {
    const barrel = lower('barrel.ts', "export * from './other.js';");
    const fallthrough = lower(
      'switch.ts',
      'export function choose(a: number): number { switch (a) { case 1: case 2: return 2; default: return 0; } }',
    );

    expect(() => emitIrModuleHaxe(barrel.module)).toThrow('module-facade lowering');
    expect(() => emitIrModuleHaxe(fallthrough.module)).toThrow('switch fallthrough');
  });

  it.each([
    [
      'assignment',
      'export function power(a: number, b: number): number { a **= b; return a; }',
      'operator **= requires Haxe semantic lowering',
    ],
    [
      'binary',
      'export function power(a: number, b: number): number { return a ** b; }',
      'operator ** requires Haxe semantic lowering',
    ],
    [
      'keyword unary',
      'export function type(a: number): string { return typeof a; }',
      'operator typeof requires Haxe semantic lowering',
    ],
  ])('refuses unsupported %s operators explicitly', (family, source, message) => {
    const result = lower(`${family.replaceAll(' ', '-')}-operator.ts`, source);

    expect(() => emitIrModuleHaxe(result.module)).toThrow(message);
  });

  it('rejects undefined expressions without Haxe nullability lowering', () => {
    const nullable = lower('nullable.ts', 'export function nullable(): string | null { return null; }');
    const undefinedValue = lower('missing.ts', 'export function missing(): undefined { return undefined; }');

    expect(emitIrModuleHaxe(nullable.module).contents).toContain(
      'static function nullable():Null<String> {\n    return null;',
    );
    expect(() => emitIrModuleHaxe(undefinedValue.module)).toThrow(
      'undefined expressions require Haxe nullability lowering',
    );
  });

  it('preserves final locals and abstract classes', () => {
    const result = lower(
      'base.ts',
      'export abstract class Base {} export function read(): number { const value: number = 1; return value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('abstract class Base');
    expect(output).toContain('final value:Float = 1;');
  });

  it('emits supported postfix operators from the closed target mapping', () => {
    const result = lower(
      'increment.ts',
      'export function increment(value: number): number { let result: number = value; return result++; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('return result++;');
  });

  it('emits supported assignment, binary, and prefix operators from closed target mappings', () => {
    const result = lower(
      'operators.ts',
      'export function operators(left: number, right: number, disabled: boolean): boolean { let value: number = left; value += right; return value === right && !disabled; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value += right;');
    expect(output).toContain('return ((value == right) && ! disabled);');
  });

  it('returns a tagged emission failure', () => {
    const result = lower('unsupported.ts', 'export async function read(): Promise<number> { return 1; }');

    try {
      emitIrModuleHaxe(result.module);
      expect.unreachable('Expected Haxe emission to fail');
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
      expect(error).toMatchObject({
        backend: 'haxe',
        code: 'unsupported-ir',
        kind: 'backend-emission',
        name: 'BackendEmissionError',
        packageName: '@flighthq/math',
        source: 'packages/math/src/unsupported.ts',
      });
    }
  });
});
