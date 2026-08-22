import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerAsyncStateMachineStep, IrModule } from '../../compiler-types/src/index.js';
import { analyzeIrModuleAsyncStateMachines } from './compilerAsyncStateMachine.js';

describe('analyzeIrModuleAsyncStateMachines', () => {
  it('builds deterministic linear states for binding initialization, rebinding, discard, and returned suspension', () => {
    const module = lower(`
      let external: number = 1;
      export async function linear(input: number): Promise<number> {
        const first = await Promise.resolve(input);
        let second: number = 0;
        second = await Promise.resolve(first);
        await Promise.resolve(second);
        return await Promise.resolve(second + external);
      }
    `);
    const snapshot = structuredClone(module);

    const analysis = analyzeIrModuleAsyncStateMachines(module);
    const machine = analysis.machines[0];
    const suspensions = machine?.states.flatMap((state) =>
      state.steps.filter(
        (step): step is Extract<CompilerAsyncStateMachineStep, { kind: 'suspend' }> => step.kind === 'suspend',
      ),
    );

    expect(analysis.schema).toBe('flight-compiler-async-state-machine-analysis/1');
    expect(analysis.refusals).toEqual([]);
    expect(machine?.states.map((state) => state.identity.kind)).toEqual(['entry', 'resume', 'resume', 'resume']);
    expect(suspensions?.map((step) => step.fulfillment.kind)).toEqual([
      'initializeBinding',
      'rebind',
      'discard',
      'resolve',
    ]);
    expect(suspensions?.slice(0, -1).every((step) => step.resumeState?.kind === 'resume')).toBe(true);
    expect(suspensions?.at(-1)).not.toHaveProperty('resumeState');
    expect(machine?.retainedCaptures.map((capture) => capture.binding.name)).toEqual(['external']);
    expect(machine?.retainedBindings.map((retained) => retained.binding.name)).toEqual(['second']);
    expect(machine?.retainedBindings[0]?.suspensionPaths).toEqual([suspensions?.[2]?.path]);
    expect(machine?.completionPaths.paths.some((completion) => completion.kind === 'return')).toBe(true);
    expect(machine?.completionPaths.paths.filter((completion) => completion.kind === 'throw')).toHaveLength(9);
    expect(module).toEqual(snapshot);
    expect(isDeeplyFrozen(analysis, new WeakSet())).toBe(true);
  });

  it('retains parameters and destructured locals only across suspensions where their current value remains live', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function retained(input: number, task: Promise<void>): Promise<number> {
          const [local] = [input];
          await task;
          return input + local;
        }
        export async function overwritten(task: Promise<number>): Promise<number> {
          let value = 1;
          value = await task;
          return value;
        }
      `),
    );
    const machines = new Map(
      analysis.machines.flatMap((machine) =>
        machine.origin.kind === 'functionDeclaration' ? [[machine.origin.binding.name, machine] as const] : [],
      ),
    );

    expect(machines.get('retained')?.retainedBindings.map((retained) => retained.binding.name)).toEqual([
      'input',
      'local',
    ]);
    expect(machines.get('retained')?.retainedBindings.every((retained) => retained.suspensionPaths.length === 1)).toBe(
      true,
    );
    expect(machines.get('overwritten')?.retainedBindings).toEqual([]);
  });

  it('supports concise async resolution, concise await, explicit settlement, and implicit fallthrough', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export const immediate = async (): Promise<number> => 1;
        export const awaited = async (): Promise<number> => await Promise.resolve(1);
        export const blockExpression = async (): Promise<number> => { return 1; };
        export async function empty(): Promise<void> {
          let vacant: number;
          const [value] = [1];
          value;
        }
        export async function returns(): Promise<void> { return; }
        export async function rejects(): Promise<void> { throw new Error('failure'); }
      `),
    );
    const immediate = analysis.machines[0];
    const awaited = analysis.machines[1];
    const machines = new Map(
      analysis.machines.flatMap((machine) =>
        machine.origin.kind === 'functionDeclaration' ? [[machine.origin.binding.name, machine] as const] : [],
      ),
    );

    expect(analysis.refusals).toEqual([]);
    expect(immediate?.states[0]?.steps.map((step) => step.kind)).toEqual(['resolve']);
    expect(awaited?.states[0]?.steps.map((step) => step.kind)).toEqual(['suspend']);
    expect(analysis.machines[2]?.states[0]?.steps.map((step) => step.kind)).toEqual(['resolve']);
    expect(machines.get('empty')?.states[0]?.steps.map((step) => step.kind)).toEqual([
      'execute',
      'execute',
      'execute',
      'resolve',
    ]);
    expect(machines.get('empty')?.completionPaths.paths.some((path) => path.kind === 'normal')).toBe(true);
    expect(machines.get('returns')?.states[0]?.steps[0]).toMatchObject({
      kind: 'resolve',
      value: { kind: 'implicitUndefined' },
    });
    expect(machines.get('rejects')?.states[0]?.steps[0]).toMatchObject({ kind: 'reject' });
  });

  it('covers async methods and nested async expressions without assigning suspensions to their parents', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export class Worker {
          async run(value: number): Promise<number> { return await Promise.resolve(value); }
        }
        export async function outer(value: number): Promise<number> {
          const nested = async (): Promise<number> => await Promise.resolve(value);
          nested;
          return value;
        }
      `),
    );

    expect(analysis.refusals).toEqual([]);
    expect(analysis.machines).toHaveLength(3);
    expect(analysis.machines.find((machine) => machine.origin.kind === 'classMethod')?.states[0]?.steps[0]?.kind).toBe(
      'suspend',
    );
    const outer = analysis.machines.find(
      (machine) => machine.origin.kind === 'functionDeclaration' && machine.origin.binding.name === 'outer',
    );
    const nested = analysis.machines.find((machine) => machine.origin.kind === 'functionExpression');
    expect(outer?.states).toHaveLength(1);
    expect(nested?.states[0]?.steps[0]?.kind).toBe('suspend');
  });

  it('returns stable refusals for every control-flow and suspension shape not yet proven safe', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function iteration(values: number[]): Promise<void> {
          for await (const value of values) value;
        }
        export async function branch(value: boolean): Promise<void> { if (value) return; }
        export async function unreachable(): Promise<void> { return; 1; }
        export async function escaped(): Promise<void> { break; }
        export async function nestedAwait(task: Promise<number>): Promise<number> {
          return 1 + await task;
        }
        export async function multiple(task: Promise<number>): Promise<number> {
          return await Promise.resolve(await task);
        }
        export async function property(task: Promise<number>, value: { result: number }): Promise<void> {
          value.result = await task;
        }
        export async function declarations(task: Promise<number>): Promise<void> {
          const first = await task, second = 1;
          first; second;
        }
        export async function pattern(task: Promise<[number]>): Promise<void> {
          const [first] = await task;
          first;
        }
        export const conciseUnsupported = async (task: Promise<number>): Promise<number> => 1 + await task;
      `),
    );

    expect(analysis.machines).toEqual([]);
    expect(analysis.refusals.map((refusal) => refusal.code)).toEqual([
      'unsupported-async-iteration',
      'unsupported-control-flow',
      'unreachable-statement',
      'escaping-control-flow',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
    ]);
  });

  it('runs non-suspending structured control flow inside one state and keeps its rejection path', () => {
    // Structured control flow only has to become states when a suspension is inside it. A branch or
    // loop that never awaits runs to completion within one state, so refusing it refused most of the
    // ordinary code in an async function. It can still reject from anywhere inside, which is why the
    // step carries the statement itself as an abrupt completion path.
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function work(values: number[], flag: boolean): Promise<number> {
          let total: number = 0;
          if (flag) { total = 1; } else { total = 2; }
          for (const value of values) total += value;
          while (total < 0) total += 1;
          switch (total) { case 1: total = 3; break; default: total = 4; }
          try { total += 1; } finally { total += 2; }
          return await Promise.resolve(total);
        }
      `),
    );
    const machine = analysis.machines[0];
    const executed = machine?.states.flatMap((state) =>
      state.steps.filter((step) => step.kind === 'execute').map((step) => step.path.at(-1)),
    );

    expect(analysis.refusals).toEqual([]);
    expect(analysis.machines).toHaveLength(1);
    expect(executed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      machine?.states
        .flatMap((state) => state.steps)
        .filter((step) => step.kind === 'execute')
        .every((step) => step.abruptValues.length > 0),
    ).toBe(true);
    expect(machine?.completionPaths.paths.some((path) => path.kind === 'return')).toBe(true);
  });

  it('is deterministic, deeply immutable, and vacuous for a module without async scopes', () => {
    const module = lower('export function read(value: number): number { return value; }');
    const first = analyzeIrModuleAsyncStateMachines(module);
    const second = analyzeIrModuleAsyncStateMachines(module);

    expect(first).toEqual({
      machines: [],
      module: { name: module.name, packageName: module.packageName, source: module.source },
      refusals: [],
      schema: 'flight-compiler-async-state-machine-analysis/1',
    });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });
});

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile('/flight/packages/task/src/state.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/task-state',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}
