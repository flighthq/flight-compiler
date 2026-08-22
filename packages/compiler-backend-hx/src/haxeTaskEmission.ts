import { indentSourceLines } from '../../compiler-emission/src/index.js';
import { getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerCompletionValueSource,
  CompilerHaxeTaskEmissionCapabilities,
  CompilerHaxeTaskLoweringFunction,
  CompilerHaxeTaskLoweringRuntime,
  CompilerHaxeTaskLoweringState,
  CompilerHaxeTaskLoweringStep,
  CompilerIrTraversalPath,
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';

interface HaxeTaskEmissionNames {
  readonly reject: string;
  readonly resolve: string;
}

export function emitCompilerHaxeTaskLoweringFunction(
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
): readonly string[] {
  const entry = functionPlan.states.find((state) => state.identity.kind === 'entry');
  if (!entry) capabilities.fail(`Haxe task function at ${JSON.stringify(functionPlan.path)} has no entry state`);
  const names: HaxeTaskEmissionNames = {
    reject: capabilities.getGeneratedName('rejectTask'),
    resolve: capabilities.getGeneratedName('resolveTask'),
  };
  return [
    `return new ${runtime.taskTypeName}(function(${names.resolve}, ${names.reject}) {`,
    ...indentSourceLines(
      emitCompilerHaxeTaskLoweringState(entry, functionPlan, runtime, module, capabilities, names, new Set()),
    ),
    '});',
  ];
}

function emitCompilerHaxeTaskCompletionValue(
  value: Readonly<CompilerCompletionValueSource>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  awaitValue: Readonly<{ name: string; path: CompilerIrTraversalPath }> | undefined,
): string {
  switch (value.kind) {
    case 'empty':
      return capabilities.fail('Haxe task settlement cannot emit an empty completion value');
    case 'implicitUndefined':
      return 'null';
    case 'expression':
      if (value.phase === 'abrupt') {
        return capabilities.fail(`Haxe task settlement cannot emit abrupt value ${JSON.stringify(value.path)}`);
      }
      if (awaitValue && isCompilerHaxeTaskEmissionPathEqual(value.path, awaitValue.path)) return awaitValue.name;
      return capabilities.emitExpression(
        getCompilerHaxeTaskEmissionSourceValue<IrExpression>(module, value.path, capabilities),
      );
  }
}

function emitCompilerHaxeTaskLoweringState(
  state: Readonly<CompilerHaxeTaskLoweringState>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  ancestors: ReadonlySet<string>,
): string[] {
  const identity = getCompilerHaxeTaskEmissionStateIdentity(state);
  if (ancestors.has(identity)) capabilities.fail(`Haxe task state graph contains a cycle at ${identity}`);
  const nextAncestors = new Set([...ancestors, identity]);
  const errorName = capabilities.getGeneratedName('taskError');
  const body = state.steps.flatMap((step) =>
    emitCompilerHaxeTaskLoweringStep(step, functionPlan, runtime, module, capabilities, names, nextAncestors),
  );
  return [
    'try {',
    ...indentSourceLines(body),
    `} catch (${errorName}:Dynamic) {`,
    `  ${names.reject}(${errorName});`,
    '}',
  ];
}

function emitCompilerHaxeTaskLoweringStep(
  step: Readonly<CompilerHaxeTaskLoweringStep>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  ancestors: ReadonlySet<string>,
): string[] {
  switch (step.kind) {
    case 'executeSource':
      return [
        ...capabilities.emitStatement(
          getCompilerHaxeTaskEmissionSourceValue<IrStatement>(module, step.path, capabilities),
        ),
      ];
    case 'rejectTask':
    case 'resolveTask': {
      const value = emitCompilerHaxeTaskCompletionValue(step.value, module, capabilities, undefined);
      return [`${step.kind === 'resolveTask' ? names.resolve : names.reject}(${value});`, 'return;'];
    }
    case 'awaitRuntime': {
      const awaitValueName = capabilities.getGeneratedName('awaitValue');
      const awaitErrorName = capabilities.getGeneratedName('awaitError');
      const fulfillment = emitCompilerHaxeTaskSuspensionFulfillment(
        step,
        functionPlan,
        runtime,
        module,
        capabilities,
        names,
        awaitValueName,
        ancestors,
      );
      const operand = capabilities.emitExpression(
        getCompilerHaxeTaskEmissionSourceValue<IrExpression>(module, step.operandPath, capabilities),
      );
      return [
        `${runtime.taskTypeName}.${runtime.normalizeMemberName}(${operand}).${runtime.continueMemberName}(`,
        `  function(${awaitValueName}) {`,
        ...indentSourceLines(fulfillment, 2),
        '  },',
        `  function(${awaitErrorName}) {`,
        `    ${names.reject}(${awaitErrorName});`,
        '  }',
        ');',
        'return;',
      ];
    }
  }
}

function emitCompilerHaxeTaskSuspensionFulfillment(
  step: Readonly<Extract<CompilerHaxeTaskLoweringStep, { kind: 'awaitRuntime' }>>,
  functionPlan: Readonly<CompilerHaxeTaskLoweringFunction>,
  runtime: Readonly<CompilerHaxeTaskLoweringRuntime>,
  module: Readonly<IrModule>,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
  names: Readonly<HaxeTaskEmissionNames>,
  awaitValueName: string,
  ancestors: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  switch (step.fulfillment.kind) {
    case 'discard':
      break;
    case 'initializeBinding':
      lines.push(`var ${capabilities.getBindingName(step.fulfillment.binding)} = ${awaitValueName};`);
      break;
    case 'rebind':
      lines.push(`${capabilities.getBindingName(step.fulfillment.binding)} = ${awaitValueName};`);
      break;
    case 'resolve':
      lines.push(
        `${names.resolve}(${emitCompilerHaxeTaskCompletionValue(step.fulfillment.value, module, capabilities, {
          name: awaitValueName,
          path: step.path,
        })});`,
        'return;',
      );
      break;
  }
  if (!step.resumeState) {
    if (step.fulfillment.kind !== 'resolve') {
      capabilities.fail(`Haxe task suspension at ${JSON.stringify(step.path)} has no resume state`);
    }
    return lines;
  }
  const resumeState = functionPlan.states.find(
    (state) => getCompilerHaxeTaskEmissionStateIdentity(state) === getCompilerHaxeTaskEmissionStateIdentity(step),
  );
  if (!resumeState) capabilities.fail(`Haxe task suspension at ${JSON.stringify(step.path)} has no matching state`);
  lines.push(
    ...emitCompilerHaxeTaskLoweringState(resumeState, functionPlan, runtime, module, capabilities, names, ancestors),
  );
  return lines;
}

function getCompilerHaxeTaskEmissionSourceValue<Value>(
  module: Readonly<IrModule>,
  path: CompilerIrTraversalPath,
  capabilities: Readonly<CompilerHaxeTaskEmissionCapabilities>,
): Readonly<Value> {
  let value: unknown;
  try {
    value = getIrModuleTraversalPathValue(module, path);
  } catch {
    return capabilities.fail(`Haxe task source path does not exist: ${JSON.stringify(path)}`);
  }
  if (!value || typeof value !== 'object') {
    return capabilities.fail(`Haxe task source path is not a node: ${JSON.stringify(path)}`);
  }
  return value as Readonly<Value>;
}

function getCompilerHaxeTaskEmissionStateIdentity(
  state:
    | Readonly<CompilerHaxeTaskLoweringState>
    | Readonly<Extract<CompilerHaxeTaskLoweringStep, { kind: 'awaitRuntime' }>>,
): string {
  const identity = 'identity' in state ? state.identity : state.resumeState;
  return identity?.kind === 'resume' ? JSON.stringify(identity.suspensionPath) : 'entry';
}

function isCompilerHaxeTaskEmissionPathEqual(left: CompilerIrTraversalPath, right: CompilerIrTraversalPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
