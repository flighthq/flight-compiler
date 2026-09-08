import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { analyzeIrModuleAsyncStateMachines } from '../../compiler-task/src/index.js';
import type { CompilerRuntimeTaskCapabilityPlan, IrModule } from '../../compiler-types/src/index.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';
import { isCompilerHaxeTaskLoweringFailure, lowerCompilerAsyncStateMachinesHaxe } from './haxeTaskLowering.js';

describe('isCompilerHaxeTaskLoweringFailure', () => {
  it('recognizes exact failures and rejects structural lookalikes', () => {
    try {
      lowerCompilerAsyncStateMachinesHaxe(analyzeIrModuleAsyncStateMachines(lowerAsyncModule()), {
        capabilities: [],
        contract: 'flight-runtime-task-capability-abi/1',
      });
      expect.unreachable('Expected Haxe task lowering failure');
    } catch (error) {
      expect(isCompilerHaxeTaskLoweringFailure(error)).toBe(true);
      expect(error).toMatchObject({ code: 'runtime-capability-incomplete', kind: 'haxe-task-lowering' });
    }

    expect(isCompilerHaxeTaskLoweringFailure(new Error('failure'))).toBe(false);
    expect(
      isCompilerHaxeTaskLoweringFailure({
        code: 'runtime-capability-incomplete',
        kind: 'haxe-task-lowering',
        module: { name: 'Task', packageName: '@flighthq/task', source: 'Task.ts' },
      }),
    ).toBe(false);
  });
});

describe('lowerCompilerAsyncStateMachinesHaxe', () => {
  it('elects nested Haxe callbacks and lexical storage without losing completion evidence', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(lowerAsyncModule());
    const snapshot = structuredClone(analysis);
    const result = lowerCompilerAsyncStateMachinesHaxe(analysis, createCompilerRuntimeTaskCapabilityPlanHaxe());
    const machine = analysis.machines[0]!;
    const lowered = result.functions[0]!;

    expect(result.schema).toBe('flight-compiler-haxe-task-lowering/1');
    expect(result.runtime).toEqual({
      cleanupMemberName: 'finally',
      continueMemberName: 'then',
      executorParameters: ['resolve', 'reject'],
      joinAllMemberName: 'all',
      normalizeMemberName: 'resolve',
      rejectMemberName: 'reject',
      taskTypeName: 'flighthq._internal._Promise',
    });
    expect(result.strategy).toEqual({
      continuation: 'nested-callback-chain',
      retainedBindings: 'lexical-closure-storage',
      retainedCaptures: 'lexical-closure-storage',
      settlement: 'executor-resolve-reject-callbacks',
      taskConstruction: 'runtime-constructor-executor',
      thisBinding: 'lexical',
    });
    expect(lowered.completionPaths).toEqual(machine.completionPaths);
    expect(lowered.retainedBindings.every((binding) => binding.storage === 'lexicalClosure')).toBe(true);
    expect(lowered.retainedCaptures.every((capture) => capture.storage === 'lexicalClosure')).toBe(true);
    expect(lowered.states.flatMap((state) => state.steps).map((step) => step.kind)).toEqual([
      'awaitRuntime',
      'executeSource',
      'awaitRuntime',
      'rejectTask',
    ]);
    expect(lowered.states.flatMap((state) => state.steps).find((step) => step.kind === 'executeSource')).toMatchObject({
      onAbrupt: 'rejectTask',
    });
    expect(analysis).toEqual(snapshot);
    expect(isDeeplyFrozen(result, new WeakSet())).toBe(true);
  });

  it('uses explicit runtime module and capability member names', () => {
    const plan = createCompilerRuntimeTaskCapabilityPlanHaxe();
    const customized: CompilerRuntimeTaskCapabilityPlan = {
      ...plan,
      capabilities: plan.capabilities.map((capability) =>
        capability.capability === 'continue' ? { ...capability, memberName: 'continueTask' } : capability,
      ),
    };
    const result = lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(lowerAsyncModule()),
      customized,
      { runtimeModule: 'custom.runtime' },
    );

    expect(result.runtime.continueMemberName).toBe('continueTask');
    expect(result.runtime.taskTypeName).toBe('custom.runtime._Promise');
  });

  it('preserves every neutral refusal instead of silently dropping unsupported async syntax', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`export async function branch(value: boolean): Promise<void> { if (value) return; }`),
    );
    const result = lowerCompilerAsyncStateMachinesHaxe(analysis, createCompilerRuntimeTaskCapabilityPlanHaxe());

    expect(result.functions).toEqual([]);
    expect(result.refusals).toEqual([
      expect.objectContaining({ code: 'unsupported-control-flow', kind: 'neutralStateMachine' }),
    ]);
  });

  it('maps direct resolution, evaluation failure, and terminal suspension exactly', () => {
    const result = lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(
        lower(`
          export async function empty(): Promise<void> { return; }
          export async function expression(): Promise<number> { return 1; }
          export async function terminal(task: Promise<number>): Promise<number> { return await task; }
        `),
      ),
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
    );
    const steps = result.functions.map((lowered) => lowered.states[0]!.steps[0]!);

    expect(steps[0]).toEqual(expect.objectContaining({ kind: 'resolveTask', value: { kind: 'implicitUndefined' } }));
    expect(steps[0]).not.toHaveProperty('evaluationRejection');
    expect(steps[1]).toEqual(expect.objectContaining({ kind: 'resolveTask', evaluationRejection: expect.anything() }));
    expect(steps[2]).toEqual(expect.objectContaining({ kind: 'awaitRuntime' }));
    expect(steps[2]).not.toHaveProperty('resumeState');
  });

  it('fails loudly for incomplete capability tables and invalid Haxe target names', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(lowerAsyncModule());
    expect(() =>
      lowerCompilerAsyncStateMachinesHaxe(analysis, {
        capabilities: [],
        contract: 'flight-runtime-task-capability-abi/1',
      }),
    ).toThrow('Haxe task runtime capability ABI is incomplete');

    const plan = createCompilerRuntimeTaskCapabilityPlanHaxe();
    const construct = plan.capabilities.find((capability) => capability.capability === 'construct')!;
    const invalidNormalize = {
      ...plan.capabilities.find((capability) => capability.capability === 'normalize')!,
      operationSemantics: 'flight-compiler-task-operation-semantics/2',
    } as unknown as CompilerRuntimeTaskCapabilityPlan['capabilities'][number];
    expect(() =>
      lowerCompilerAsyncStateMachinesHaxe(analysis, {
        ...plan,
        capabilities: [...plan.capabilities, construct, invalidNormalize],
      }),
    ).toThrow('duplicate construct, normalize; invalid normalize');

    const invalidMember: CompilerRuntimeTaskCapabilityPlan = {
      ...plan,
      capabilities: plan.capabilities.map((capability) =>
        capability.capability === 'continue' ? { ...capability, memberName: 'not-valid' } : capability,
      ),
    };
    expect(() => lowerCompilerAsyncStateMachinesHaxe(analysis, invalidMember)).toThrow(
      'Haxe task runtime continue member is not a valid identifier: not-valid',
    );
    try {
      lowerCompilerAsyncStateMachinesHaxe(analysis, plan, { runtimeModule: 'invalid-module' });
      expect.unreachable('Expected invalid task runtime target');
    } catch (error) {
      expect(isCompilerHaxeTaskLoweringFailure(error)).toBe(true);
      expect(error).toMatchObject({ code: 'runtime-task-type-name', received: 'invalid-module._Promise' });
    }
  });

  it('lowers try-catch guards, carry values, and reject-state suspension', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function guarded(task: Promise<number>): Promise<number> {
          try {
            const value = await task;
            return value;
          } catch (error) {
            return 0;
          }
        }
      `),
    );
    const result = lowerCompilerAsyncStateMachinesHaxe(analysis, createCompilerRuntimeTaskCapabilityPlanHaxe());
    const steps = result.functions[0]?.states.flatMap((state) => state.steps) ?? [];
    const guards = result.functions[0]?.states.filter((state) => state.guard) ?? [];
    const stepKinds = steps.map((step) => step.kind);

    expect(stepKinds).toContain('guardState');
    expect(guards.length).toBeGreaterThan(0);
    const suspendStep = steps.find((step) => step.kind === 'awaitRuntime');
    expect(suspendStep).toHaveProperty('rejectState');

    const finallyAnalysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function cleanup(task: Promise<number>, log: Promise<void>): Promise<number> {
          try {
            return await task;
          } finally {
            await log;
          }
        }
      `),
    );
    const finallyResult = lowerCompilerAsyncStateMachinesHaxe(
      finallyAnalysis,
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
    );
    const finallySteps = finallyResult.functions[0]?.states.flatMap((state) => state.steps) ?? [];
    const finallyKinds = finallySteps.map((step) => step.kind);
    expect(finallyKinds).toEqual(expect.arrayContaining(['guardState']));
  });

  it('lowers neutral branching into branch and continue steps with their join targets intact', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function choose(task: Promise<number>, flag: boolean): Promise<number> {
          let total: number = 0;
          if (flag) { total = await task; }
          return total;
        }
      `),
    );
    const result = lowerCompilerAsyncStateMachinesHaxe(analysis, createCompilerRuntimeTaskCapabilityPlanHaxe());
    const steps = result.functions[0]?.states.flatMap((state) => state.steps) ?? [];
    const branchPath = ['declarations', 0, 'body', 1];

    expect(steps.filter((step) => step.kind === 'branchState')).toMatchObject([
      {
        conditionPath: [...branchPath, 'condition'],
        kind: 'branchState',
        whenFalse: { kind: 'join', path: branchPath },
        whenTrue: { arm: 'whenTrue', kind: 'branchArm', path: branchPath },
      },
    ]);
    expect(steps.filter((step) => step.kind === 'continueState')).toMatchObject([
      { kind: 'continueState', target: { kind: 'join', path: branchPath } },
    ]);
  });

  it('lowers carry steps for non-await return values preserved through try-finally cleanup', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>): Promise<number> {
          const value = await task;
          try { return value; } finally { value; }
        }
      `),
    );
    const result = lowerCompilerAsyncStateMachinesHaxe(analysis, createCompilerRuntimeTaskCapabilityPlanHaxe());
    const steps = result.functions[0]?.states.flatMap((state) => state.steps) ?? [];
    const carrySteps = steps.filter((step) => step.kind === 'carryValue');

    expect(carrySteps.length).toBeGreaterThan(0);
    expect(carrySteps[0]).toHaveProperty('binding');
    expect(carrySteps[0]).toHaveProperty('value');
  });
});

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile('/flight/packages/task/src/Task.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/task',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

function lowerAsyncModule(): IrModule {
  return lower(`
    let external = 1;
    export async function task(input: Promise<number>): Promise<number> {
      let value = await input;
      value += external;
      await Promise.resolve(value);
      throw value;
    }
  `);
}
