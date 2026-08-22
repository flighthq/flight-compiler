import {
  analyzeCompilerRuntimeTaskCapabilityCompleteness,
  collectCompilerRuntimeTaskCapabilityRequirements,
} from '../../compiler-runtime-contract/src/index.js';
import type {
  CompilerAsyncStateMachineAnalysis,
  CompilerAsyncStateMachineStep,
  CompilerHaxeTaskLowering,
  CompilerHaxeTaskLoweringFailure,
  CompilerHaxeTaskLoweringFailureCode,
  CompilerHaxeTaskLoweringFunction,
  CompilerHaxeTaskLoweringOptions,
  CompilerHaxeTaskLoweringStep,
  CompilerModuleIdentity,
  CompilerRuntimeTaskCapability,
  CompilerRuntimeTaskCapabilityCompleteness,
  CompilerRuntimeTaskCapabilityName,
  CompilerRuntimeTaskCapabilityPlan,
  CompilerRuntimeTaskCapabilityRequirements,
} from '../../compiler-types/src/index.js';
import { getCompilerRuntimeExternalSymbolTargetHaxe } from './haxeRuntimeExternalSymbolBinding.js';

export function isCompilerHaxeTaskLoweringFailure(value: unknown): value is CompilerHaxeTaskLoweringFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'haxe-task-lowering' &&
    'code' in value &&
    compilerHaxeTaskLoweringFailureCodes.has(value.code as CompilerHaxeTaskLoweringFailureCode) &&
    'module' in value &&
    isCompilerHaxeTaskLoweringModuleIdentity(value.module)
  );
}

export function lowerCompilerAsyncStateMachinesHaxe(
  analysis: Readonly<CompilerAsyncStateMachineAnalysis>,
  capabilityPlan: Readonly<CompilerRuntimeTaskCapabilityPlan>,
  options: Readonly<CompilerHaxeTaskLoweringOptions> = {},
): CompilerHaxeTaskLowering {
  const stateMachineRequirements = collectCompilerRuntimeTaskCapabilityRequirements(
    {
      module: analysis.module,
      operations: [],
      schema: 'flight-compiler-async-task-inventory/1',
      scopes: [],
      suspensions: [],
    },
    analysis,
  );
  const requirements: CompilerRuntimeTaskCapabilityRequirements = {
    ...stateMachineRequirements,
    requirements: compilerHaxeTaskLoweringCapabilityOrder.map((capability) => ({
      capability,
      evidence:
        stateMachineRequirements.requirements.find((requirement) => requirement.capability === capability)?.evidence ??
        [],
    })),
  };
  const completeness = analyzeCompilerRuntimeTaskCapabilityCompleteness(requirements, capabilityPlan);
  if (completeness.kind === 'incomplete') {
    throw createCompilerHaxeTaskLoweringFailure(
      'runtime-capability-incomplete',
      analysis.module,
      getCompilerHaxeTaskLoweringCompletenessMessage(completeness),
    );
  }
  const runtime = createCompilerHaxeTaskLoweringRuntime(completeness, analysis.module, options);
  return cloneCompilerHaxeTaskLoweringValue({
    functions: analysis.machines.map(lowerCompilerAsyncStateMachineFunctionHaxe),
    module: analysis.module,
    refusals: analysis.refusals.map((refusal) => ({
      code: refusal.code,
      kind: 'neutralStateMachine' as const,
      path: refusal.path,
      scopePath: refusal.scopePath,
    })),
    runtime,
    schema: 'flight-compiler-haxe-task-lowering/1' as const,
    strategy: {
      continuation: 'nested-callback-chain' as const,
      retainedBindings: 'lexical-closure-storage' as const,
      retainedCaptures: 'lexical-closure-storage' as const,
      settlement: 'executor-resolve-reject-callbacks' as const,
      taskConstruction: 'runtime-constructor-executor' as const,
      thisBinding: 'lexical' as const,
    },
  });
}

function cloneCompilerHaxeTaskLoweringValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerHaxeTaskLoweringValue(clone, new WeakSet());
  return clone;
}

function createCompilerHaxeTaskLoweringFailure(
  code: CompilerHaxeTaskLoweringFailureCode,
  module: Readonly<CompilerModuleIdentity>,
  message: string,
  details: Readonly<{ capability?: CompilerRuntimeTaskCapabilityName; received?: string }> = {},
): CompilerHaxeTaskLoweringFailure {
  const failure = Object.assign(new Error(message), details, {
    code,
    kind: 'haxe-task-lowering' as const,
    module: structuredClone(module),
  });
  failure.name = 'CompilerHaxeTaskLoweringError';
  return failure;
}

function createCompilerHaxeTaskLoweringRuntime(
  completeness: Extract<CompilerRuntimeTaskCapabilityCompleteness, { kind: 'complete' }>,
  module: Readonly<CompilerModuleIdentity>,
  options: Readonly<CompilerHaxeTaskLoweringOptions>,
): CompilerHaxeTaskLowering['runtime'] {
  const taskTypeName = getCompilerRuntimeExternalSymbolTargetHaxe('Promise', 'value', options.runtimeModule);
  if (!taskTypeName || !isCompilerHaxeTaskLoweringQualifiedNameValid(taskTypeName)) {
    throw createCompilerHaxeTaskLoweringFailure(
      'runtime-task-type-name',
      module,
      `Haxe task runtime target is not a valid qualified name: ${String(taskTypeName)}`,
      { received: String(taskTypeName) },
    );
  }
  const cleanup = getCompilerHaxeTaskLoweringCapability(completeness.capabilities, 'cleanup');
  const construct = getCompilerHaxeTaskLoweringCapability(completeness.capabilities, 'construct');
  const continuation = getCompilerHaxeTaskLoweringCapability(completeness.capabilities, 'continue');
  const joinAll = getCompilerHaxeTaskLoweringCapability(completeness.capabilities, 'joinAll');
  const normalize = getCompilerHaxeTaskLoweringCapability(completeness.capabilities, 'normalize');
  const reject = getCompilerHaxeTaskLoweringCapability(completeness.capabilities, 'reject');
  for (const capability of [cleanup, continuation, joinAll, normalize, reject]) {
    if (!isCompilerHaxeTaskLoweringIdentifierValid(capability.memberName)) {
      throw createCompilerHaxeTaskLoweringFailure(
        'runtime-member-name',
        module,
        `Haxe task runtime ${capability.capability} member is not a valid identifier: ${capability.memberName}`,
        { capability: capability.capability, received: capability.memberName },
      );
    }
  }
  return {
    cleanupMemberName: cleanup.memberName,
    continueMemberName: continuation.memberName,
    executorParameters: construct.executorParameters,
    joinAllMemberName: joinAll.memberName,
    normalizeMemberName: normalize.memberName,
    rejectMemberName: reject.memberName,
    taskTypeName,
  };
}

function freezeCompilerHaxeTaskLoweringValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerHaxeTaskLoweringValue(child, seen);
  Object.freeze(value);
}

function getCompilerHaxeTaskLoweringCapability<Name extends CompilerRuntimeTaskCapabilityName>(
  capabilities: readonly CompilerRuntimeTaskCapability[],
  name: Name,
): Extract<CompilerRuntimeTaskCapability, { capability: Name }> {
  return capabilities.find((capability) => capability.capability === name) as Extract<
    CompilerRuntimeTaskCapability,
    { capability: Name }
  >;
}

function getCompilerHaxeTaskLoweringCompletenessMessage(
  completeness: Extract<CompilerRuntimeTaskCapabilityCompleteness, { kind: 'incomplete' }>,
): string {
  const problems = [
    `missing ${completeness.missingCapabilities.join(', ')}`,
    completeness.duplicateCapabilities.length > 0
      ? `duplicate ${completeness.duplicateCapabilities.join(', ')}`
      : undefined,
    completeness.invalidCapabilities.length > 0 ? `invalid ${completeness.invalidCapabilities.join(', ')}` : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  return `Haxe task runtime capability ABI is incomplete: ${problems.join('; ')}`;
}

function isCompilerHaxeTaskLoweringIdentifierValid(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) && !compilerHaxeTaskLoweringReservedWords.has(value);
}

function isCompilerHaxeTaskLoweringModuleIdentity(value: unknown): value is CompilerModuleIdentity {
  return (
    !!value &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'packageName' in value &&
    typeof value.packageName === 'string' &&
    'source' in value &&
    typeof value.source === 'string'
  );
}

function isCompilerHaxeTaskLoweringQualifiedNameValid(value: string): boolean {
  return value.split('.').every(isCompilerHaxeTaskLoweringIdentifierValid);
}

function lowerCompilerAsyncStateMachineFunctionHaxe(
  machine: Readonly<CompilerAsyncStateMachineAnalysis['machines'][number]>,
): CompilerHaxeTaskLoweringFunction {
  return {
    completionPaths: machine.completionPaths,
    origin: machine.origin,
    path: machine.path,
    retainedBindings: machine.retainedBindings.map((retained) => ({
      ...retained,
      storage: 'lexicalClosure' as const,
    })),
    retainedCaptures: machine.retainedCaptures.map((retained) => ({
      ...retained,
      storage: 'lexicalClosure' as const,
    })),
    states: machine.states.map((state) => ({
      ...(state.guard ? { guard: state.guard } : {}),
      identity: state.identity,
      steps: state.steps.map(lowerCompilerAsyncStateMachineStepHaxe),
    })),
  };
}

function lowerCompilerAsyncStateMachineStepHaxe(
  step: Readonly<CompilerAsyncStateMachineStep>,
): CompilerHaxeTaskLoweringStep {
  switch (step.kind) {
    case 'branch':
      return {
        conditionPath: step.conditionPath,
        evaluationRejection: step.evaluationRejection,
        kind: 'branchState',
        path: step.path,
        whenFalse: step.whenFalse,
        whenTrue: step.whenTrue,
      };
    case 'goto':
      return { kind: 'continueState', path: step.path, target: step.target };
    case 'guard':
      return {
        body: step.body,
        ...(step.carrier ? { carrier: step.carrier } : {}),
        catchState: step.catchState,
        join: step.join,
        kind: 'guardState',
        path: step.path,
      };
    case 'carry':
      return { binding: step.binding, kind: 'carryValue', path: step.path, value: step.value };
    case 'loop':
      return { header: step.header, kind: 'loopState', path: step.path };
    case 'execute':
      return {
        abruptValues: step.abruptValues,
        kind: 'executeSource',
        onAbrupt: 'rejectTask',
        path: step.path,
      };
    case 'reject':
    case 'resolve':
      return {
        ...(step.evaluationRejection ? { evaluationRejection: step.evaluationRejection } : {}),
        kind: step.kind === 'resolve' ? 'resolveTask' : 'rejectTask',
        path: step.path,
        value: step.value,
      };
    case 'suspend':
      return {
        fulfillment: step.fulfillment,
        kind: 'awaitRuntime',
        operandPath: step.operandPath,
        path: step.path,
        ...(step.rejectState ? { rejectState: step.rejectState } : {}),
        rejection: step.rejection,
        ...(step.resumeState ? { resumeState: step.resumeState } : {}),
      };
  }
}

const compilerHaxeTaskLoweringFailureCodes = new Set<CompilerHaxeTaskLoweringFailureCode>([
  'runtime-capability-incomplete',
  'runtime-member-name',
  'runtime-task-type-name',
]);

const compilerHaxeTaskLoweringCapabilityOrder: readonly CompilerRuntimeTaskCapabilityName[] = [
  'cleanup',
  'construct',
  'continue',
  'joinAll',
  'normalize',
  'reject',
];

const compilerHaxeTaskLoweringReservedWords = new Set([
  'abstract',
  'break',
  'case',
  'cast',
  'catch',
  'class',
  'continue',
  'default',
  'do',
  'dynamic',
  'else',
  'enum',
  'extends',
  'extern',
  'false',
  'final',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'inline',
  'interface',
  'macro',
  'new',
  'null',
  'operator',
  'overload',
  'override',
  'package',
  'private',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typedef',
  'untyped',
  'using',
  'var',
  'while',
]);
