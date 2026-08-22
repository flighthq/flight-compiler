import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerAsyncStateMachineAnalysis,
  CompilerAsyncTaskInventory,
  CompilerAsyncTaskOperation,
  CompilerModuleIdentity,
  CompilerRuntimeTaskCapability,
  CompilerRuntimeTaskCapabilityAnalysisMismatchFailure,
  CompilerRuntimeTaskCapabilityCompleteness,
  CompilerRuntimeTaskCapabilityContractMismatchFailure,
  CompilerRuntimeTaskCapabilityName,
  CompilerRuntimeTaskCapabilityPlan,
  CompilerRuntimeTaskCapabilityRequirementEvidence,
  CompilerRuntimeTaskCapabilityRequirements,
} from '../../compiler-types/src/index.js';

export function analyzeCompilerRuntimeTaskCapabilityCompleteness(
  requirements: Readonly<CompilerRuntimeTaskCapabilityRequirements>,
  plan: Readonly<CompilerRuntimeTaskCapabilityPlan>,
): CompilerRuntimeTaskCapabilityCompleteness {
  assertCompilerRuntimeTaskCapabilityContract(plan);
  const capabilities = plan.capabilities.map(normalizeCompilerRuntimeTaskCapability).sort(compareTaskCapabilities);
  const capabilityGroups = new Map<CompilerRuntimeTaskCapabilityName, CompilerRuntimeTaskCapability[]>();
  for (const capability of capabilities) {
    const group = capabilityGroups.get(capability.capability) ?? [];
    group.push(capability);
    capabilityGroups.set(capability.capability, group);
  }
  const duplicateCapabilities = compilerRuntimeTaskCapabilityOrder.filter(
    (capability) => (capabilityGroups.get(capability)?.length ?? 0) > 1,
  );
  const invalidCapabilities = compilerRuntimeTaskCapabilityOrder.filter((capability) =>
    capabilityGroups.get(capability)?.some((candidate) => !isCompilerRuntimeTaskCapabilityValid(candidate)),
  );
  const missingCapabilities = requirements.requirements
    .map((requirement) => requirement.capability)
    .filter((capability) => {
      const group = capabilityGroups.get(capability);
      return group?.length !== 1 || !isCompilerRuntimeTaskCapabilityValid(group[0]!);
    });
  const common = {
    capabilities,
    contract: plan.contract,
    requirements,
    schema: 'flight-runtime-task-capability-completeness/1' as const,
  };
  return cloneCompilerRuntimeTaskCapabilityValue(
    duplicateCapabilities.length === 0 && invalidCapabilities.length === 0 && missingCapabilities.length === 0
      ? { ...common, kind: 'complete' as const }
      : {
          ...common,
          duplicateCapabilities,
          invalidCapabilities,
          kind: 'incomplete' as const,
          missingCapabilities,
        },
  );
}

export function collectCompilerRuntimeTaskCapabilityRequirements(
  taskInventory: Readonly<CompilerAsyncTaskInventory>,
  stateMachines: Readonly<CompilerAsyncStateMachineAnalysis>,
): CompilerRuntimeTaskCapabilityRequirements {
  if (!isCompilerRuntimeTaskCapabilityModuleEqual(taskInventory.module, stateMachines.module)) {
    throw createCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(taskInventory.module, stateMachines.module);
  }
  const evidence = new Map<CompilerRuntimeTaskCapabilityName, CompilerRuntimeTaskCapabilityRequirementEvidence[]>();
  for (const machine of stateMachines.machines) {
    addCompilerRuntimeTaskCapabilityEvidence(evidence, 'construct', {
      kind: 'stateMachine',
      path: machine.path,
      reason: 'construction',
    });
    for (const step of machine.states.flatMap((state) => state.steps)) {
      if (step.kind === 'resolve') {
        addCompilerRuntimeTaskCapabilityEvidence(evidence, 'normalize', {
          kind: 'stateMachine',
          path: step.path,
          reason: 'assimilation',
        });
      }
      if (step.kind === 'suspend') {
        addCompilerRuntimeTaskCapabilityEvidence(evidence, 'continue', {
          kind: 'stateMachine',
          path: step.path,
          reason: 'continuation',
        });
      }
    }
  }
  for (const operation of taskInventory.operations) {
    const capability = getCompilerAsyncTaskOperationRuntimeCapability(operation);
    if (!capability) continue;
    addCompilerRuntimeTaskCapabilityEvidence(evidence, capability, {
      kind: 'taskOperation',
      operation: operation.operation,
      path: operation.path,
    });
  }
  return cloneCompilerRuntimeTaskCapabilityValue({
    module: taskInventory.module,
    requirements: compilerRuntimeTaskCapabilityOrder.flatMap((capability) => {
      const capabilityEvidence = evidence.get(capability);
      return capabilityEvidence
        ? [
            {
              capability,
              evidence: createCompilerRuntimeTaskCapabilityEvidenceSet(capabilityEvidence),
            },
          ]
        : [];
    }),
    schema: 'flight-runtime-task-capability-requirements/1' as const,
  });
}

export function isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(
  value: unknown,
): value is CompilerRuntimeTaskCapabilityAnalysisMismatchFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'runtime-task-capability-analysis-mismatch' &&
    'code' in value &&
    value.code === 'module-identity' &&
    'taskInventoryModule' in value &&
    isCompilerRuntimeTaskCapabilityModuleIdentity(value.taskInventoryModule) &&
    'stateMachineModule' in value &&
    isCompilerRuntimeTaskCapabilityModuleIdentity(value.stateMachineModule)
  );
}

export function isCompilerRuntimeTaskCapabilityContractMismatchFailure(
  value: unknown,
): value is CompilerRuntimeTaskCapabilityContractMismatchFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'runtime-task-capability-contract-mismatch' &&
    'expected' in value &&
    value.expected === 'flight-runtime-task-capability-abi/1' &&
    'received' in value &&
    typeof value.received === 'string'
  );
}

function addCompilerRuntimeTaskCapabilityEvidence(
  evidence: Map<CompilerRuntimeTaskCapabilityName, CompilerRuntimeTaskCapabilityRequirementEvidence[]>,
  capability: CompilerRuntimeTaskCapabilityName,
  item: CompilerRuntimeTaskCapabilityRequirementEvidence,
): void {
  const existing = evidence.get(capability) ?? [];
  existing.push(item);
  evidence.set(capability, existing);
}

function assertCompilerRuntimeTaskCapabilityContract(plan: Readonly<CompilerRuntimeTaskCapabilityPlan>): void {
  if (plan.contract === 'flight-runtime-task-capability-abi/1') return;
  const failure = Object.assign(
    new Error(
      `Runtime task capability plan uses ${String(plan.contract)}; expected flight-runtime-task-capability-abi/1`,
    ),
    {
      expected: 'flight-runtime-task-capability-abi/1' as const,
      kind: 'runtime-task-capability-contract-mismatch' as const,
      received: String(plan.contract),
    },
  );
  failure.name = 'CompilerRuntimeTaskCapabilityContractMismatchError';
  throw failure;
}

function cloneCompilerRuntimeTaskCapabilityValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerRuntimeTaskCapabilityValue(clone, new WeakSet());
  return clone;
}

function compareTaskCapabilities(
  left: Readonly<CompilerRuntimeTaskCapability>,
  right: Readonly<CompilerRuntimeTaskCapability>,
): number {
  return (
    compilerRuntimeTaskCapabilityOrder.indexOf(left.capability) -
      compilerRuntimeTaskCapabilityOrder.indexOf(right.capability) ||
    compareTextCodeUnits(JSON.stringify(left), JSON.stringify(right))
  );
}

function createCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(
  taskInventoryModule: Readonly<CompilerModuleIdentity>,
  stateMachineModule: Readonly<CompilerModuleIdentity>,
): CompilerRuntimeTaskCapabilityAnalysisMismatchFailure {
  const failure = Object.assign(new Error('Task inventory and state-machine analysis identify different modules'), {
    code: 'module-identity' as const,
    kind: 'runtime-task-capability-analysis-mismatch' as const,
    stateMachineModule: structuredClone(stateMachineModule),
    taskInventoryModule: structuredClone(taskInventoryModule),
  });
  failure.name = 'CompilerRuntimeTaskCapabilityAnalysisMismatchError';
  return failure;
}

function createCompilerRuntimeTaskCapabilityEvidenceSet(
  evidence: readonly CompilerRuntimeTaskCapabilityRequirementEvidence[],
): CompilerRuntimeTaskCapabilityRequirementEvidence[] {
  return [
    ...new Map(evidence.map((item) => [getCompilerRuntimeTaskCapabilityEvidenceIdentity(item), item])).values(),
  ].sort((left, right) =>
    compareTextCodeUnits(
      getCompilerRuntimeTaskCapabilityEvidenceIdentity(left),
      getCompilerRuntimeTaskCapabilityEvidenceIdentity(right),
    ),
  );
}

function freezeCompilerRuntimeTaskCapabilityValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerRuntimeTaskCapabilityValue(child, seen);
  Object.freeze(value);
}

function getCompilerAsyncTaskOperationRuntimeCapability(
  operation: Readonly<CompilerAsyncTaskOperation>,
): CompilerRuntimeTaskCapabilityName | undefined {
  switch (operation.operation) {
    case 'catch':
    case 'then':
      return 'continue';
    case 'construct':
      return 'construct';
    case 'finally':
      return 'cleanup';
    case 'joinAll':
      return 'joinAll';
    case 'ready':
      return 'normalize';
    case 'reject':
      return 'reject';
    case 'invokeAsync':
      return undefined;
  }
}

function getCompilerRuntimeTaskCapabilityEvidenceIdentity(
  evidence: Readonly<CompilerRuntimeTaskCapabilityRequirementEvidence>,
): string {
  return JSON.stringify(
    evidence.kind === 'stateMachine'
      ? [evidence.path, evidence.kind, evidence.reason]
      : [evidence.path, evidence.kind, evidence.operation],
  );
}

function isCompilerRuntimeTaskCapabilityModuleEqual(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): boolean {
  return left.name === right.name && left.packageName === right.packageName && left.source === right.source;
}

function isCompilerRuntimeTaskCapabilityModuleIdentity(value: unknown): value is CompilerModuleIdentity {
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

function isCompilerRuntimeTaskCapabilityValid(capability: Readonly<CompilerRuntimeTaskCapability>): boolean {
  switch (capability.capability) {
    case 'cleanup':
      return (
        capability.invocation === 'instanceMethod' &&
        isCompilerRuntimeTaskCapabilityMemberNameValid(capability.memberName) &&
        capability.operation === 'finally' &&
        capability.operationSemantics === 'flight-compiler-task-operation-semantics/1'
      );
    case 'construct':
      return (
        capability.completionSemantics === 'flight-compiler-async-task-completion/1' &&
        capability.executorInvocation === 'synchronous' &&
        Array.isArray(capability.executorParameters) &&
        capability.executorParameters.length === 2 &&
        capability.executorParameters[0] === 'resolve' &&
        capability.executorParameters[1] === 'reject' &&
        capability.invocation === 'constructor' &&
        capability.settlementCallbacks === 'first-call-wins-assimilating-resolve-exact-reject'
      );
    case 'continue':
      return (
        capability.awaitSemantics === 'flight-compiler-await-semantics/1' &&
        capability.invocation === 'instanceMethod' &&
        isCompilerRuntimeTaskCapabilityMemberNameValid(capability.memberName) &&
        capability.operation === 'then' &&
        capability.operationSemantics === 'flight-compiler-task-operation-semantics/1'
      );
    case 'joinAll':
    case 'normalize':
    case 'reject':
      return (
        capability.invocation === 'staticMethod' &&
        isCompilerRuntimeTaskCapabilityMemberNameValid(capability.memberName) &&
        capability.operation === compilerRuntimeTaskCapabilityOperation[capability.capability] &&
        capability.operationSemantics === 'flight-compiler-task-operation-semantics/1'
      );
  }
}

function isCompilerRuntimeTaskCapabilityMemberNameValid(memberName: string): boolean {
  return memberName.length > 0 && memberName === memberName.normalize('NFC');
}

function normalizeCompilerRuntimeTaskCapability(
  capability: Readonly<CompilerRuntimeTaskCapability>,
): CompilerRuntimeTaskCapability {
  return capability.capability === 'construct'
    ? { ...capability, executorParameters: [...capability.executorParameters] }
    : { ...capability, memberName: capability.memberName.normalize('NFC') };
}

const compilerRuntimeTaskCapabilityOperation = {
  joinAll: 'joinAll',
  normalize: 'ready',
  reject: 'reject',
} as const;

const compilerRuntimeTaskCapabilityOrder: readonly CompilerRuntimeTaskCapabilityName[] = [
  'cleanup',
  'construct',
  'continue',
  'joinAll',
  'normalize',
  'reject',
];
