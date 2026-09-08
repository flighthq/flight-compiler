import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createIrModuleClosureCapturePlanCpp } from './cppClosureCapturePlan.js';

describe('createIrModuleClosureCapturePlanCpp', () => {
  it('elects direct module access, value copies, and shared mutable cells from neutral evidence', () => {
    const module = lower(`
      let moduleValue: number = 0;
      export function plans(seed: number): () => number {
        const fixed: number = seed;
        let changed: number = seed;
        let observed: number = seed;
        const read = (): number => fixed + changed + observed + moduleValue;
        const write = (): void => { changed += 1; };
        observed += 1;
        write();
        return read;
      }
    `);

    const plan = createIrModuleClosureCapturePlanCpp(module);
    const byName = new Map(plan.bindings.map((binding) => [binding.binding.name, binding]));

    expect(plan.schema).toBe('flight-compiler-cpp-closure-capture-plan/1');
    expect(byName.get('moduleValue')).toMatchObject({
      reasons: ['moduleLifetime'],
      representation: 'directModuleBinding',
    });
    expect(byName.get('fixed')).toMatchObject({ reasons: ['valueSnapshot'], representation: 'valueCopy' });
    expect(byName.get('changed')).toMatchObject({
      reasons: ['capturedBindingMutation', 'capturedMutableBinding', 'outsideMutation'],
      representation: 'sharedMutableCell',
    });
    expect(byName.get('observed')).toMatchObject({
      reasons: ['capturedMutableBinding', 'outsideMutation'],
      representation: 'sharedMutableCell',
    });
  });

  it('coalesces binding and referent mutation reasons across closures', () => {
    const plan = createIrModuleClosureCapturePlanCpp(
      lower(`
        export function mutate(): () => number {
          let state: { value: number } = { value: 0 };
          const mutateReferent = (): void => { state.value += 1; };
          return (): number => { state = { value: state.value + 1 }; mutateReferent(); return state.value; };
        }
      `),
    );

    expect(plan.bindings.find((binding) => binding.binding.name === 'state')).toMatchObject({
      reasons: ['capturedBindingMutation', 'capturedMutableBinding', 'capturedReferentMutation', 'outsideMutation'],
      representation: 'sharedMutableCell',
    });
  });

  it('retains mutation evidence for direct module bindings', () => {
    const plan = createIrModuleClosureCapturePlanCpp(
      lower(`
        const state: { value: number } = { value: 0 };
        export function update(): void { state.value += 1; }
      `),
    );

    expect(plan.bindings.find((binding) => binding.binding.name === 'state')).toMatchObject({
      reasons: ['moduleLifetime', 'capturedReferentMutation'],
      representation: 'directModuleBinding',
    });
  });

  it('keeps mutable var iteration bindings shared when assignment precedes each closure creation', () => {
    const plan = createIrModuleClosureCapturePlanCpp(
      lower(`
        export function readers(): Array<() => string> {
          const result: Array<() => string> = [];
          for (var key in { first: 1, second: 2 }) result.push((): string => key);
          return result;
        }
      `),
    );

    expect(plan.bindings.find((binding) => binding.binding.name === 'key')).toMatchObject({
      reasons: expect.arrayContaining(['capturedMutableBinding']),
      representation: 'sharedMutableCell',
    });
  });

  it('returns deterministic deeply immutable evidence without changing the module', () => {
    const module = lower(`
      export function counter(): () => number {
        let count: number = 0;
        return (): number => { count += 1; return count; };
      }
    `);
    const before = structuredClone(module);
    const first = createIrModuleClosureCapturePlanCpp(module);
    const second = createIrModuleClosureCapturePlanCpp(module);

    expect(first).toEqual(second);
    expect(module).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.bindings)).toBe(true);
    expect(Object.isFrozen(first.bindings[0]?.binding)).toBe(true);
    expect(() => (first.bindings as unknown[]).push({})).toThrow();
  });
});

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile('/flight/packages/math/src/capture.ts', source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/math', upstreamDirectory: '/flight' }).module;
}
