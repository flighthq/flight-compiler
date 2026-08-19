import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createRustCompilerBackend, emitIrModuleRust } from './rustCompilerBackend.js';

function lower(file: string, source: string) {
  const sourceFile = ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
}

describe('createRustCompilerBackend', () => {
  it('creates independent stateless backend records with Rust identity', () => {
    const first = createRustCompilerBackend();
    const second = createRustCompilerBackend();
    const module = lower('value.ts', 'export const value = 1;').module;

    expect(first).not.toBe(second);
    expect(first.name).toBe('rust');
    expect(first.emitModule(module, { modules: [], options: {} })).toEqual([emitIrModuleRust(module)]);
  });
});

describe('emitIrModuleRust', () => {
  it('emits numeric enums and rejects string enum representation', () => {
    const numeric = lower('mode.ts', 'export enum Mode { A = 1, B, C = Mode.A << 3, D }');
    const strings = lower('kind.ts', "export enum Kind { A = 'a', B = 'b' }");

    expect(emitIrModuleRust(numeric.module).contents).toContain('D = 9,');
    expect(() => emitIrModuleRust(strings.module)).toThrow('requires integer discriminants for Rust');
  });

  it('keeps local bindings distinct from same-named module constants', () => {
    const result = lower(
      'guard.ts',
      'export const limit: number = 4; export function check(value: number): number { const limit: number = 9; if (value > limit) throw new Error("too big"); return limit; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('const LIMIT: f64 = 4.0;');
    expect(output).toContain('let limit: f64 = 9.0;');
    expect(output).toContain('(value > limit)');
    expect(output).toContain('Error::new("too big".to_owned())');
    expect(output).toContain('panic!("{:?}",');
    expect(output).not.toContain('panic!("{{:?}}"');
  });

  it('restores module bindings after nested local shadowing', () => {
    const result = lower(
      'scope.ts',
      'export const limit: number = 4; export function read(flag: boolean): number { if (flag) { const limit: number = 9; return limit; } return limit; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('return limit;');
    expect(output).toContain('return LIMIT;');
  });

  it('keeps parameters and nested closure parameters local when they shadow module constants', () => {
    const result = lower(
      'parameters.ts',
      'export const limit: number = 4; export function read(limit: number): number { return limit; } export function makeReader(): (limit: number) => number { return (limit: number): number => limit; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('pub fn read(limit: f64) -> f64 {\n  return limit;');
    expect(output).toContain('return |limit| limit;');
    expect(output.match(/return LIMIT;/gu)).toBeNull();
  });

  it('rejects module facades, operators, and switch fallthrough without target lowering', () => {
    const barrel = lower('barrel.ts', "export * from './other.js';");
    const operator = lower('operator.ts', 'export function power(a: number, b: number): number { return a ** b; }');
    const fallthrough = lower(
      'switch.ts',
      'export function choose(a: number): number { switch (a) { case 1: case 2: return 2; default: return 0; } }',
    );

    expect(() => emitIrModuleRust(barrel.module)).toThrow('module-facade lowering');
    expect(() => emitIrModuleRust(operator.module)).toThrow('operator ** requires Rust semantic lowering');
    expect(() => emitIrModuleRust(fallthrough.module)).toThrow('fallthrough-aware Rust lowering');
  });

  it('rejects class state and default parameters that would otherwise be dropped', () => {
    const staticField = lower('config.ts', 'export class Config { static limit: number = 3; value: number = 1; }');
    const defaultParameter = lower('default.ts', 'export function read(value: number = 1): number { return value; }');

    expect(() => emitIrModuleRust(staticField.module)).toThrow('static fields require associated-item lowering');
    expect(() => emitIrModuleRust(defaultParameter.module)).toThrow('default parameter value');
  });
});
