import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import {
  analyzeIrModuleOwnershipEvidenceRust,
  collectIrModuleMovedBindingIdsRust,
  collectIrModuleReferentMutatedParameterIdsRust,
} from './rustOwnershipEvidence.js';

describe('analyzeIrModuleOwnershipEvidenceRust', () => {
  it('records identity, mutation, reuse, closure, record, carrier, and suspension obligations', () => {
    const module = lower(`
      export async function inspect(input: { count: number }, scalar: number): Promise<number> {
        let alias: { count: number } = input;
        let total: number = scalar;
        let both: { count: number } = input;
        var repeated: number = 0;
        var repeated: number;
        const record: { alias: { count: number } } = { alias };
        const closure: () => number = () => alias.count + total;
        const carrier: { alias: { count: number } } = ({ alias } = { alias: input });
        carrier;
        alias.count += 1;
        input.count += 1;
        both = { count: 0 };
        both.count += 1;
        await Promise.resolve(total);
        for await (const next of [] as number[]) { total += next; }
        total += closure();
        total++;
        total--;
        record;
        both;
        return alias.count + total;
      }
    `);
    const snapshot = structuredClone(module);

    const evidence = analyzeIrModuleOwnershipEvidenceRust(module);
    const byName = new Map(evidence.bindings.map((binding) => [binding.binding.name, binding]));

    expect(evidence.schema).toBe('flight-compiler-rust-ownership-evidence/1');
    expect(evidence.module).toEqual({ name: module.name, packageName: module.packageName, source: module.source });
    expect(byName.get('alias')).toMatchObject({
      boundaries: ['closureCapture', 'statementValueCarrier', 'structuralRecord', 'suspension'],
      declaration: 'mutable',
      mutation: 'bindingAndReferent',
      reuse: 'multiple',
      storage: 'sharedIdentity',
    });
    expect(byName.get('total')).toMatchObject({
      boundaries: ['closureCapture', 'suspension'],
      declaration: 'mutable',
      mutation: 'bindingReassigned',
      storage: 'valueSemantic',
    });
    expect(byName.get('both')).toMatchObject({ mutation: 'bindingAndReferent', storage: 'sharedIdentity' });
    expect(byName.get('repeated')).toMatchObject({ declaration: 'mutable', reuse: 'unused' });
    expect(byName.get('input')).toMatchObject({ declaration: 'parameter', storage: 'sharedIdentity' });
    expect(byName.get('scalar')).toMatchObject({ declaration: 'parameter', storage: 'valueSemantic' });
    expect(module).toEqual(snapshot);
  });

  it('classifies value, shared-identity, and unresolved type families without representation policy', () => {
    const evidence = analyzeIrModuleOwnershipEvidenceRust(
      lower(`
        interface Box { value: number }
        type Indexed = Box['value'];
        export function classify(): void {
          let literal: 1;
          let neverValue: never;
          let nullValue: null;
          let primitive: number;
          let undefinedValue: undefined;
          let arrayValue: number[];
          let functionValue: () => void;
          let objectValue: { value: number };
          let tupleValue: [number];
          let indexedValue: Box['value'];
          let intersectionValue: Box & { label: string };
          let keyValue: keyof Box;
          let namedValue: Box;
          let typeOfValue: typeof classify;
          let unionValue: number | string;
          let unknownValue: unknown;
          literal; neverValue; nullValue; primitive; undefinedValue;
          arrayValue; functionValue; objectValue; tupleValue;
          indexedValue; intersectionValue; keyValue; namedValue; typeOfValue; unionValue; unknownValue;
          if (false) classify();
        }
      `),
    );
    const storage = new Map(evidence.bindings.map((binding) => [binding.binding.name, binding.storage]));

    for (const name of ['indexedValue', 'literal', 'neverValue', 'nullValue', 'primitive', 'undefinedValue']) {
      expect(storage.get(name)).toBe('valueSemantic');
    }
    for (const name of ['arrayValue', 'functionValue', 'objectValue', 'tupleValue']) {
      expect(storage.get(name)).toBe('sharedIdentity');
    }
    for (const name of ['intersectionValue', 'keyValue', 'namedValue', 'typeOfValue', 'unionValue', 'unknownValue']) {
      expect(storage.get(name)).toBe('indeterminate');
    }
  });

  it('distinguishes unused, single-use, and multiple-use values across async and synchronous methods', () => {
    const evidence = analyzeIrModuleOwnershipEvidenceRust(
      lower(`
        export class Worker {
          constructor(value: number = 1) { value; }
          async run(value: number): Promise<number> { await Promise.resolve(); return value; }
          sync(value: number): number {
            const unused: number = 0;
            const once: number = value;
            const many: number = value;
            const [pattern] = [value];
            let [mutablePattern, , ...restPattern] = [value, value, value];
            const { value: objectPattern, ...objectRest } = { value };
            pattern;
            mutablePattern; restPattern; objectPattern; objectRest;
            many;
            many;
            return once;
          }
        }
        export class EmptyWorker { run(): void {} }
      `),
    );
    const named = evidence.bindings.filter((binding) => ['once', 'unused'].includes(binding.binding.name));

    expect(named.map((binding) => ({ name: binding.binding.name, reuse: binding.reuse }))).toEqual([
      { name: 'unused', reuse: 'unused' },
      { name: 'once', reuse: 'single' },
    ]);
    expect(evidence.bindings.some((binding) => binding.reuse === 'multiple')).toBe(true);
    expect(evidence.bindings.find((binding) => binding.binding.name === 'pattern')?.declaration).toBe('immutable');
    expect(evidence.bindings.find((binding) => binding.binding.name === 'mutablePattern')?.declaration).toBe('mutable');
  });

  it('keeps a binding with omitted pattern type evidence indeterminate', () => {
    const module = structuredClone(lower('export function inspect(): void { const [unresolved] = [1]; unresolved; }'));
    const declaration = module.declarations[0];
    if (!declaration || declaration.kind !== 'function') throw new Error('expected function declaration');
    const statement = declaration.body[0];
    if (!statement || statement.kind !== 'variable') throw new Error('expected variable statement');
    const variable = statement.declarations[0];
    if (!variable || !('pattern' in variable) || variable.pattern.kind !== 'array') {
      throw new Error('expected array binding pattern');
    }
    const element = variable.pattern.elements[0];
    if (!element || element.pattern.kind !== 'binding') throw new Error('expected binding pattern leaf');
    Reflect.deleteProperty(variable, 'type');
    Reflect.deleteProperty(variable.pattern, 'type');
    Reflect.deleteProperty(element.pattern, 'type');

    const evidence = analyzeIrModuleOwnershipEvidenceRust(module);

    expect(evidence.bindings.find((binding) => binding.binding.name === 'unresolved')?.storage).toBe('indeterminate');
  });

  it('returns deterministic deeply immutable evidence', () => {
    const module = lower('export function read(value: number): number { return value; }');
    const first = analyzeIrModuleOwnershipEvidenceRust(module);
    const second = analyzeIrModuleOwnershipEvidenceRust(module);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });
});

describe('collectIrModuleMovedBindingIdsRust', () => {
  it('elects a binding consumed twice and a binding one loop consumes again', () => {
    const module = lower(`
      export function twice(values: readonly number[], scalar: number): number {
        return values.length + values.length + scalar + scalar;
      }
      export function looped(rows: readonly number[]): number {
        let sum: number = 0;
        for (let index: number = 0; index < 2; index += 1) { sum += rows.length; }
        return sum;
      }
    `);
    expect(namesOf(module, collectIrModuleMovedBindingIdsRust(module))).toEqual(['rows', 'values']);
  });

  it('leaves a binding consumed once outside a loop to move', () => {
    const module = lower(`
      export function once(values: readonly number[]): number {
        return values.length;
      }
    `);
    expect(collectIrModuleMovedBindingIdsRust(module).size).toBe(0);
  });

  it('excludes numeric-literal and never Copy types from the moved set', () => {
    const module = lower(`
      export function copyLiterals(count: 1, absent: never): number {
        return count + count;
      }
    `);
    expect(collectIrModuleMovedBindingIdsRust(module).size).toBe(0);
  });
});

describe('collectIrModuleReferentMutatedParameterIdsRust', () => {
  it('elects a parameter assigned into, one grown, and one handed to a function that mutates it', () => {
    const module = lower(`
      export function bump(cell: { value: number }, next: number): void { cell.value = next; }
      export function fill(out: number[], value: number): void { out.push(value); }
      export function twice(cell: { value: number }): void { bump(cell, 1); }
      export function read(cell: { value: number }): number { return cell.value; }
    `);
    expect(namesOf(module, collectIrModuleReferentMutatedParameterIdsRust(module))).toEqual(['cell', 'cell', 'out']);
  });

  it('detects map.set and set.add as referent mutation', () => {
    const module = lower(`
      export function populate(entries: Map<string, number>, values: Set<string>): void { entries.set("a", 1); values.add("b"); }
    `);
    expect(namesOf(module, collectIrModuleReferentMutatedParameterIdsRust(module))).toEqual(['entries', 'values']);
  });

  it('does not propagate mutation through a non-binding argument', () => {
    const module = lower(`
      export function bump(cell: { value: number }, next: number): void { cell.value = next; }
      export function indirect(next: number): void { bump({ value: 0 }, next); }
    `);
    expect(namesOf(module, collectIrModuleReferentMutatedParameterIdsRust(module))).toEqual(['cell']);
  });

  it('leaves a parameter only read alone, however many times it is read', () => {
    const module = lower(`
      export function span(cell: { value: number }): number { return cell.value + cell.value; }
    `);
    expect(collectIrModuleReferentMutatedParameterIdsRust(module).size).toBe(0);
  });
});

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/ownership/src/evidence.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/ownership',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

function namesOf(module: IrModule, ids: ReadonlySet<string>): string[] {
  return analyzeIrModuleOwnershipEvidenceRust(module)
    .bindings.filter((binding) => ids.has(binding.binding.id))
    .map((binding) => binding.binding.name)
    .sort();
}
