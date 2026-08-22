import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { analyzeIrModuleAsyncStateMachines } from '../../compiler-task/src/index.js';
import type {
  CompilerHaxeTaskLowering,
  CompilerHaxeTaskLoweringFunction,
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';
import { emitCompilerHaxeTaskLoweringFunction } from './haxeTaskEmission.js';
import { lowerCompilerAsyncStateMachinesHaxe } from './haxeTaskLowering.js';

describe('emitCompilerHaxeTaskLoweringFunction', () => {
  it('emits the nested callback chain selected by the Haxe lowering plan', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/task/src/Task.ts',
      'export async function task(input: Promise<number>): Promise<number> { const value = await input; return value; }',
      ts.ScriptTarget.Latest,
      true,
    );
    const module = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/task',
      upstreamDirectory: '/flight',
    }).module;
    const lowering = lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(module),
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
    );
    const names = new Map<string, number>();
    const lines = emitCompilerHaxeTaskLoweringFunction(lowering.functions[0]!, lowering.runtime, module, {
      emitExpression: emitExpression,
      emitStatement: emitStatement,
      fail(message): never {
        throw new Error(message);
      },
      getBindingName: (binding) => binding.name,
      getGeneratedName(preferredName) {
        const count = (names.get(preferredName) ?? 0) + 1;
        names.set(preferredName, count);
        return count === 1 ? preferredName : `${preferredName}_${String(count)}`;
      },
    });

    expect(lines.join('\n')).toBe(`return new flighthq._internal._Promise(function(resolveTask, rejectTask) {
  try {
    flighthq._internal._Promise.resolve(input).then(
      function(awaitValue) {
        var value = awaitValue;
        try {
          resolveTask(value);
          return;
        } catch (taskError_2:Dynamic) {
          rejectTask(taskError_2);
        }
      },
      function(awaitError) {
        rejectTask(awaitError);
      }
    );
    return;
  } catch (taskError:Dynamic) {
    rejectTask(taskError);
  }
});`);
  });

  it('emits one join local function and calls it from both arms of a branch', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/task/src/Task.ts',
      'export async function choose(task: Promise<number>, flag: boolean): Promise<number> { let total: number = 0; if (flag) { total = await task; } return total; }',
      ts.ScriptTarget.Latest,
      true,
    );
    const module = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/task',
      upstreamDirectory: '/flight',
    }).module;
    const lowering = lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(module),
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
    );
    const names = new Map<string, number>();
    const source = emitCompilerHaxeTaskLoweringFunction(lowering.functions[0]!, lowering.runtime, module, {
      emitExpression: emitExpression,
      emitStatement: emitStatement,
      fail(message): never {
        throw new Error(message);
      },
      getBindingName: (binding) => binding.name,
      getGeneratedName(preferredName) {
        const count = (names.get(preferredName) ?? 0) + 1;
        names.set(preferredName, count);
        return count === 1 ? preferredName : `${preferredName}_${String(count)}`;
      },
    }).join('\n');

    // The continuation after the branch belongs to both arms. Emitting it once as a local function
    // and calling it is what keeps a nested branch from duplicating the whole tail of the machine.
    expect(source.match(/var taskJoin = function\(\) \{/gu)).toHaveLength(1);
    expect(source.match(/taskJoin\(\);/gu)).toHaveLength(2);
    expect(source).toContain('if (flag) {');
    expect(source).toContain('} else {');
    expect(source).toContain('resolveTask(total);');
  });

  it('emits a loop header as a named local function the back edge can re-enter', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/task/src/Task.ts',
      'export async function drain(task: Promise<number>, again: boolean): Promise<number> { let last: number = 0; let pending: boolean = true; while (pending) { last = await task; pending = again; } return last; }',
      ts.ScriptTarget.Latest,
      true,
    );
    const module = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/task',
      upstreamDirectory: '/flight',
    }).module;
    const lowering = lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(module),
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
    );
    const names = new Map<string, number>();
    const source = emitCompilerHaxeTaskLoweringFunction(lowering.functions[0]!, lowering.runtime, module, {
      emitExpression: emitExpression,
      emitStatement: emitStatement,
      fail(message): never {
        throw new Error(message);
      },
      getBindingName: (binding) => binding.name,
      getGeneratedName(preferredName) {
        const count = (names.get(preferredName) ?? 0) + 1;
        names.set(preferredName, count);
        return count === 1 ? preferredName : `${preferredName}_${String(count)}`;
      },
    }).join('\n');

    // A named local function, not a variable holding a closure: the back edge calls it from inside
    // its own body, which a variable initializer cannot see.
    expect(source).toContain('function taskLoop() {');
    expect(source.match(/taskLoop\(\);/gu)).toHaveLength(2);
    expect(source).toContain('if (pending) {');
  });

  it('emits execute, rebind, discard, rejection, and implicit resolution actions', () => {
    const { lowering, module } = createFixture(`
      export async function actions(input: Promise<number>): Promise<number> {
        let value = 0;
        value = await input;
        await input;
        throw value;
      }
      export async function empty(): Promise<void> { return; }
    `);
    const actions = emitFunction(lowering.functions[0]!, lowering, module).join('\n');
    const empty = emitFunction(lowering.functions[1]!, lowering, module).join('\n');

    expect(actions).toContain('execute:variable;');
    expect(actions).toContain('value = awaitValue;');
    expect(actions).toContain('rejectTask(value);');
    expect(actions.match(/\.resolve\(input\)\.then\(/gu)).toHaveLength(2);
    expect(empty).toContain('resolveTask(null);');
  });

  it('fails loudly for malformed state graphs, completion values, and source paths', () => {
    const immediate = createFixture('export async function immediate(): Promise<number> { return 1; }');
    const immediatePlan = immediate.lowering.functions[0]!;
    const immediateState = immediatePlan.states[0]!;
    const immediateStep = immediateState.steps[0]!;
    if (immediateStep.kind !== 'resolveTask') throw new Error('Expected immediate resolution');
    const emitImmediate = (functionPlan: CompilerHaxeTaskLoweringFunction) =>
      emitFunction(functionPlan, immediate.lowering, immediate.module);

    expect(() => emitImmediate({ ...immediatePlan, states: [] })).toThrow('has no entry state');
    expect(() =>
      emitImmediate({
        ...immediatePlan,
        states: [{ ...immediateState, steps: [{ ...immediateStep, value: { kind: 'empty' } }] }],
      }),
    ).toThrow('cannot emit an empty completion value');
    expect(() =>
      emitImmediate({
        ...immediatePlan,
        states: [
          {
            ...immediateState,
            steps: [
              {
                ...immediateStep,
                value: { kind: 'expression', path: ['declarations', 0, 'body', 0, 'expression'], phase: 'abrupt' },
              },
            ],
          },
        ],
      }),
    ).toThrow('cannot emit abrupt value');
    expect(() =>
      emitImmediate({
        ...immediatePlan,
        states: [
          {
            ...immediateState,
            steps: [{ ...immediateStep, value: { kind: 'expression', path: ['missing'], phase: 'result' } }],
          },
        ],
      }),
    ).toThrow('source path does not exist');
    expect(() =>
      emitImmediate({
        ...immediatePlan,
        states: [
          {
            ...immediateState,
            steps: [{ ...immediateStep, value: { kind: 'expression', path: ['name'], phase: 'result' } }],
          },
        ],
      }),
    ).toThrow('source path is not a node');

    const suspended = createFixture(
      'export async function suspended(input: Promise<number>): Promise<number> { const value = await input; return value; }',
    );
    const suspendedPlan = suspended.lowering.functions[0]!;
    const entry = suspendedPlan.states[0]!;
    const resume = suspendedPlan.states[1]!;
    const awaitStep = entry.steps[0]!;
    if (awaitStep.kind !== 'awaitRuntime') throw new Error('Expected suspension');
    const emitSuspended = (functionPlan: CompilerHaxeTaskLoweringFunction) =>
      emitFunction(functionPlan, suspended.lowering, suspended.module);

    expect(() => emitSuspended({ ...suspendedPlan, states: [entry] })).toThrow('has no matching state');
    expect(() =>
      emitSuspended({
        ...suspendedPlan,
        states: [
          {
            ...entry,
            steps: [{ ...awaitStep, fulfillment: { kind: 'discard' }, resumeState: undefined }],
          },
        ],
      }),
    ).toThrow('has no resume state');
    expect(() =>
      emitSuspended({
        ...suspendedPlan,
        states: [
          entry,
          {
            ...resume,
            steps: [{ ...awaitStep, fulfillment: { kind: 'discard' }, resumeState: resume.identity }],
          },
        ],
      }),
    ).toThrow('state graph contains a cycle');
  });
});

function createFixture(source: string): {
  lowering: CompilerHaxeTaskLowering;
  module: IrModule;
} {
  const sourceFile = ts.createSourceFile('/flight/packages/task/src/Task.ts', source, ts.ScriptTarget.Latest, true);
  const module = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/task',
    upstreamDirectory: '/flight',
  }).module;
  return {
    lowering: lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(module),
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
    ),
    module,
  };
}

function emitFunction(
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  lowering: Readonly<CompilerHaxeTaskLowering>,
  module: Readonly<IrModule>,
): readonly string[] {
  const names = new Map<string, number>();
  return emitCompilerHaxeTaskLoweringFunction(functionPlan, lowering.runtime, module, {
    emitExpression,
    emitStatement,
    fail(message): never {
      throw new Error(message);
    },
    getBindingName: (binding) => binding.name,
    getGeneratedName(preferredName) {
      const count = (names.get(preferredName) ?? 0) + 1;
      names.set(preferredName, count);
      return count === 1 ? preferredName : `${preferredName}_${String(count)}`;
    },
  });
}

function emitExpression(expression: Readonly<IrExpression>): string {
  if (expression.kind === 'identifier') {
    return expression.reference.kind === 'binding'
      ? expression.reference.binding.name
      : expression.reference.kind === 'ambient'
        ? expression.reference.name
        : expression.reference.kind;
  }
  if (expression.kind === 'literal') return String(expression.value);
  throw new Error(`Unsupported test expression: ${expression.kind}`);
}

function emitStatement(statement: Readonly<IrStatement>): readonly string[] {
  return [`execute:${statement.kind};`];
}
