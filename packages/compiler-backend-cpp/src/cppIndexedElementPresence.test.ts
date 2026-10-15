import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function returned(contents: string, functionName = 'test'): string {
  const functionStart = contents.indexOf(` ${functionName}(`);
  expect(functionStart).toBeGreaterThanOrEqual(0);
  const line = contents
    .slice(functionStart)
    .split('\n')
    .find((candidate) => candidate.trim().startsWith('return '));
  expect(line).toBeDefined();
  return line!.trim();
}

const indexed = (test: string): string =>
  `return ([&]() { const auto& indexed_presence = slots.get(index); return ${test}; }());`;

function refusal(source: string) {
  try {
    emit(source);
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('Expected C++ emission to refuse the source');
}

describe('emitIrModuleCpp indexed element presence', () => {
  it.each([
    ['!== null', '!indexed_presence.has_value() || indexed_presence.value().has_value()'],
    ['=== null', 'indexed_presence.has_value() && !indexed_presence.value().has_value()'],
    ['!= null', 'indexed_presence.has_value() && indexed_presence.value().has_value()'],
    ['== null', '!indexed_presence.has_value() || !indexed_presence.value().has_value()'],
    ['!== undefined', 'indexed_presence.has_value()'],
    ['=== undefined', '!indexed_presence.has_value()'],
    ['!= undefined', 'indexed_presence.has_value() && indexed_presence.value().has_value()'],
    ['== undefined', '!indexed_presence.has_value() || !indexed_presence.value().has_value()'],
  ])('preserves the SDK nullable-slot truth table for %s', (operator, test) => {
    const contents = emit(
      `export function test<T extends (...values: any[]) => void>(slots: (T | null)[], index: number): boolean {
         return slots[index] ${operator};
       }`,
    );
    expect(returned(contents)).toBe(indexed(test));
  });

  it('keeps present zero and false on the value side of the inner carrier', () => {
    const contents = emit(
      `export function test(slots: (number | boolean | null)[], index: number): boolean {
         return slots[index] != null;
       }`,
    );
    expect(returned(contents)).toBe(indexed('indexed_presence.has_value() && indexed_presence.value().has_value()'));
    expect(returned(contents)).not.toContain('to_boolean');
  });

  it('treats an absent index and an undefined element as undefined without treating either as null', () => {
    const strictNull = emit(
      `export function test(slots: (number | undefined)[], index: number): boolean {
         return slots[index] === null;
       }`,
    );
    const strictUndefined = emit(
      `export function test(slots: (number | undefined)[], index: number): boolean {
         return slots[index] === undefined;
       }`,
    );
    expect(returned(strictNull)).toBe(indexed('false'));
    expect(returned(strictUndefined)).toBe(
      indexed('!indexed_presence.has_value() || !indexed_presence.value().has_value()'),
    );
  });

  it('preserves exact null-only and undefined-only element domains', () => {
    const nullElement = emit(
      `export function test(slots: null[], index: number): boolean { return slots[index] === null; }`,
    );
    const undefinedElement = emit(
      `export function test(slots: undefined[], index: number): boolean { return slots[index] !== undefined; }`,
    );
    expect(returned(nullElement)).toBe(indexed('indexed_presence.has_value()'));
    expect(returned(undefinedElement)).toBe(indexed('false'));
  });

  it('asks a present erased element for its own sentinel without collapsing an index miss', () => {
    const nullTest = emit(
      `export function test(slots: any[], index: number): boolean { return slots[index] !== null; }`,
    );
    const undefinedTest = emit(
      `export function test(slots: unknown[], index: number): boolean { return slots[index] === undefined; }`,
    );
    expect(returned(nullTest)).toBe(indexed('indexed_presence.has_value() && !indexed_presence.value().is_null()'));
    expect(returned(undefinedTest)).toBe(
      indexed('!indexed_presence.has_value() || indexed_presence.value().is_undefined()'),
    );
  });

  it('refuses an open generic element whose instantiation can choose a nullish carrier', () => {
    const open = refusal(
      `export function test<T>(slots: T[], index: number): boolean { return slots[index] !== null; }`,
    );
    expect(open.rule).toBe('cpp-indexed-element-presence-open-sentinel-domain');
    const nullishConstraint = refusal(
      `export function test<T extends number | undefined>(slots: T[], index: number): boolean {
         return slots[index] !== undefined;
       }`,
    );
    expect(nullishConstraint.rule).toBe('cpp-indexed-element-presence-open-sentinel-domain');

    const constrained = emit(
      `export function test<T extends number>(slots: T[], index: number): boolean {
         return slots[index] !== undefined;
       }`,
    );
    expect(returned(constrained)).toBe(indexed('indexed_presence.has_value()'));
  });

  it('tests both tagged element sentinels independently from an absent index', () => {
    const nullTest = emit(
      `export function test(slots: (number | null | undefined)[], index: number): boolean {
         return slots[index] === null;
       }`,
    );
    const undefinedTest = emit(
      `export function test(slots: (number | null | undefined)[], index: number): boolean {
         return slots[index] === undefined;
       }`,
    );
    const looseTest = emit(
      `export function test(slots: (number | null | undefined)[], index: number): boolean {
         return slots[index] == null;
       }`,
    );
    expect(returned(nullTest)).toContain(
      'indexed_presence.has_value() && std::holds_alternative<flight::Null>(indexed_presence.value())',
    );
    expect(returned(undefinedTest)).toContain(
      '!indexed_presence.has_value() || std::holds_alternative<flight::Undefined>(indexed_presence.value())',
    );
    expect(returned(looseTest)).toContain(
      '!indexed_presence.has_value() || std::holds_alternative<flight::Null>(indexed_presence.value()) || std::holds_alternative<flight::Undefined>(indexed_presence.value())',
    );
  });

  it('evaluates an unchecked collection and index once', () => {
    const contents = emit(
      `export function test(make: () => number[], next: () => number): boolean {
         return make()[next()] !== null;
       }`,
    );
    const result = returned(contents);
    expect(result).toContain('const auto& indexed_presence = make().get(next());');
    expect(result.match(/make\(\)/gu)).toHaveLength(1);
    expect(result.match(/next\(\)/gu)).toHaveLength(1);
    expect(result).not.toContain('.element(');
  });

  it('tests an immutable retained read rather than re-reading its mutated array alias', () => {
    const contents = emit(
      `export function test(slots: (number | null)[], index: number): boolean {
         const retained = slots[index];
         const alias = slots;
         alias[index] = null;
         return retained !== null;
       }`,
    );
    expect(contents).toContain('const std::optional<std::optional<double>> retained = slots.get(index);');
    expect(returned(contents)).toContain('const auto& indexed_presence = retained;');
    expect(returned(contents)).not.toContain('slots.get(index)');
  });

  it('does not reuse indexed initializer provenance after mutating the retained binding', () => {
    const mutable = refusal(
      `export function test(slots: (number | null)[], index: number): boolean {
         let retained = slots[index];
         retained = null;
         return retained !== null;
       }`,
    );
    expect(mutable.rule).toBe('cpp-indexed-element-presence-mutable-binding');
  });

  it('keeps typed-array, Map, Record, and closed-row presence on their own lanes', () => {
    const contents = emit(
      `interface Row { readonly value?: number }
       export function typed(values: Uint8Array, index: number): boolean { return values[index] !== undefined; }
       export function mapped(values: Map<string, number>, key: string): boolean {
         return values.get(key) !== undefined;
       }
       export function recorded(values: Readonly<Record<string, number>>, key: string): boolean {
         return values[key] !== undefined;
       }
       export function row(value: Row): boolean { return value['value'] !== undefined; }`,
    );
    expect(contents).not.toContain('indexed_presence');
    expect(returned(contents, 'typed')).toContain('values.get(index).has_value()');
    expect(returned(contents, 'mapped')).toContain('values.get(key).has_value()');
    expect(returned(contents, 'recorded')).toContain('values.get(key).has_value()');
    expect(returned(contents, 'row')).toMatch(/selection_receiver(?:_[0-9]+)?->value/u);
    expect(returned(contents, 'row')).toContain('.has_value()');
  });
});
