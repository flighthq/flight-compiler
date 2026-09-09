import type {
  CompilerAsyncStateMachineAnalysis,
  CompilerAsyncTaskInventory,
  CompilerAsyncTaskOperation,
  CompilerModuleIdentity,
  CompilerRuntimeTaskCapability,
  CompilerRuntimeTaskCapabilityPlan,
  CompilerRuntimeTaskCapabilityRequirements,
  IrBindingIdentity,
} from '../../compiler-types/src/index.js';
import {
  analyzeCompilerRuntimeTaskCapabilityCompleteness,
  collectCompilerRuntimeTaskCapabilityRequirements,
  isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure,
  isCompilerRuntimeTaskCapabilityContractMismatchFailure,
} from './compilerRuntimeTaskCapability.js';

describe('analyzeCompilerRuntimeTaskCapabilityCompleteness', () => {
  it('normalizes and validates a complete ABI independently of declaration order', () => {
    const requirements = createRequirements(['construct', 'continue', 'normalize']);
    const plan = createPlan();
    const snapshot = structuredClone(plan);
    const first = analyzeCompilerRuntimeTaskCapabilityCompleteness(requirements, plan);
    const second = analyzeCompilerRuntimeTaskCapabilityCompleteness(requirements, {
      ...plan,
      capabilities: [...plan.capabilities].reverse(),
    });

    expect(first.kind).toBe('complete');
    expect(first.capabilities.map((capability) => capability.capability)).toEqual([
      'cleanup',
      'construct',
      'continue',
      'joinAll',
      'normalize',
      'reject',
    ]);
    expect(first.capabilities.find((capability) => capability.capability === 'normalize')).toMatchObject({
      memberName: 'résolve',
    });
    expect(first).toEqual(second);
    expect(plan).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });

  it('reports every missing, duplicate, and semantically invalid required capability', () => {
    const complete = createPlan();
    const construct = complete.capabilities.find((capability) => capability.capability === 'construct')!;
    const continuation = complete.capabilities.find((capability) => capability.capability === 'continue')!;
    const normalize = complete.capabilities.find((capability) => capability.capability === 'normalize')!;
    const invalidNormalize = {
      ...normalize,
      operationSemantics: 'flight-compiler-task-operation-semantics/2',
    } as unknown as CompilerRuntimeTaskCapability;
    const result = analyzeCompilerRuntimeTaskCapabilityCompleteness(
      createRequirements(['cleanup', 'construct', 'continue', 'joinAll', 'normalize', 'reject']),
      {
        capabilities: [continuation, invalidNormalize, construct, continuation],
        contract: 'flight-runtime-task-capability-abi/1',
      },
    );

    expect(result).toMatchObject({
      duplicateCapabilities: ['continue'],
      invalidCapabilities: ['normalize'],
      kind: 'incomplete',
      missingCapabilities: ['cleanup', 'continue', 'joinAll', 'normalize', 'reject'],
      schema: 'flight-runtime-task-capability-completeness/1',
    });
  });

  it('allows a valid runtime to expose capabilities that one module does not require', () => {
    const result = analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), createPlan());

    expect(result.kind).toBe('complete');
    expect(result.capabilities).toHaveLength(6);
  });

  it('rejects each individual invalid capability property in isolation', () => {
    const plan = createPlan();
    const cleanup = plan.capabilities.find((capability) => capability.capability === 'cleanup')!;
    const construct = plan.capabilities.find((capability) => capability.capability === 'construct')!;
    const continuation = plan.capabilities.find((capability) => capability.capability === 'continue')!;

    const invalidCleanupInvocation = {
      ...cleanup,
      invocation: 'staticMethod',
    } as unknown as CompilerRuntimeTaskCapability;
    const invalidCleanupMember = { ...cleanup, memberName: '' } as unknown as CompilerRuntimeTaskCapability;
    const invalidCleanupOperation = { ...cleanup, operation: 'then' } as unknown as CompilerRuntimeTaskCapability;

    for (const broken of [invalidCleanupInvocation, invalidCleanupMember, invalidCleanupOperation]) {
      const result = analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), {
        ...plan,
        capabilities: plan.capabilities.map((c) => (c.capability === 'cleanup' ? broken : c)),
      });
      expect(result).toMatchObject({ invalidCapabilities: ['cleanup'] });
    }

    const invalidConstructSemantics = {
      ...construct,
      completionSemantics: 'wrong',
    } as unknown as CompilerRuntimeTaskCapability;
    const invalidConstructInvocation = {
      ...construct,
      executorInvocation: 'wrong',
    } as unknown as CompilerRuntimeTaskCapability;
    const invalidConstructParams = {
      ...construct,
      executorParameters: ['resolve'],
    } as unknown as CompilerRuntimeTaskCapability;

    for (const broken of [invalidConstructSemantics, invalidConstructInvocation, invalidConstructParams]) {
      const result = analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), {
        ...plan,
        capabilities: plan.capabilities.map((c) => (c.capability === 'construct' ? broken : c)),
      });
      expect(result).toMatchObject({ invalidCapabilities: ['construct'] });
    }

    const invalidContinueAwait = {
      ...continuation,
      awaitSemantics: 'wrong',
    } as unknown as CompilerRuntimeTaskCapability;
    const invalidContinueInvocation = {
      ...continuation,
      invocation: 'staticMethod',
    } as unknown as CompilerRuntimeTaskCapability;
    const invalidContinueOperation = {
      ...continuation,
      operation: 'catch',
    } as unknown as CompilerRuntimeTaskCapability;

    for (const broken of [invalidContinueAwait, invalidContinueInvocation, invalidContinueOperation]) {
      const result = analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), {
        ...plan,
        capabilities: plan.capabilities.map((c) => (c.capability === 'continue' ? broken : c)),
      });
      expect(result).toMatchObject({ invalidCapabilities: ['continue'] });
    }
  });

  it('reports incomplete when only one failure category has entries', () => {
    const plan = createPlan();
    const construct = plan.capabilities.find((capability) => capability.capability === 'construct')!;
    const duplicatedPlan = { ...plan, capabilities: [construct, construct, ...plan.capabilities] };
    const result = analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), duplicatedPlan);

    expect(result.kind).toBe('incomplete');
    expect(result).toMatchObject({
      duplicateCapabilities: ['construct'],
      invalidCapabilities: [],
      missingCapabilities: [],
    });
  });
});

describe('collectCompilerRuntimeTaskCapabilityRequirements', () => {
  it('preserves path-addressed state-machine and operation evidence in canonical order', () => {
    const inventory = createInventory();
    const machines = createStateMachines();
    const inventorySnapshot = structuredClone(inventory);
    const machineSnapshot = structuredClone(machines);

    const first = collectCompilerRuntimeTaskCapabilityRequirements(inventory, machines);
    const second = collectCompilerRuntimeTaskCapabilityRequirements(
      { ...inventory, operations: [...inventory.operations].reverse() },
      { ...machines, machines: [...machines.machines].reverse() },
    );

    expect(first.schema).toBe('flight-runtime-task-capability-requirements/1');
    expect(first.requirements.map((requirement) => requirement.capability)).toEqual([
      'cleanup',
      'construct',
      'continue',
      'joinAll',
      'normalize',
      'reject',
    ]);
    expect(first.requirements.find((requirement) => requirement.capability === 'construct')?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'stateMachine', reason: 'construction' }),
        expect.objectContaining({ kind: 'taskOperation', operation: 'construct' }),
      ]),
    );
    expect(first.requirements.find((requirement) => requirement.capability === 'continue')?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'stateMachine', reason: 'continuation' }),
        expect.objectContaining({ kind: 'taskOperation', operation: 'catch' }),
        expect.objectContaining({ kind: 'taskOperation', operation: 'then' }),
      ]),
    );
    expect(first).toEqual(second);
    expect(inventory).toEqual(inventorySnapshot);
    expect(machines).toEqual(machineSnapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });

  it('returns an immutable empty requirement set for a synchronous module', () => {
    const inventory = createInventory({ operations: [] });
    const machines = createStateMachines({ machines: [] });

    expect(collectCompilerRuntimeTaskCapabilityRequirements(inventory, machines)).toEqual({
      module: compilerModule,
      requirements: [],
      schema: 'flight-runtime-task-capability-requirements/1',
    });
  });
});

describe('isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure', () => {
  it('recognizes an exact mismatch and rejects structural lookalikes', () => {
    try {
      collectCompilerRuntimeTaskCapabilityRequirements(createInventory(), {
        ...createStateMachines(),
        module: { ...compilerModule, source: 'other.ts' },
      });
      expect.unreachable('Expected module analysis mismatch');
    } catch (error) {
      expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'module-identity',
        kind: 'runtime-task-capability-analysis-mismatch',
      });
    }

    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(new Error('mismatch'))).toBe(false);
    expect(
      isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure({
        code: 'module-identity',
        kind: 'runtime-task-capability-analysis-mismatch',
      }),
    ).toBe(false);
  });

  it('rejects errors that match all but one required property', () => {
    const validModule = { name: 'task', packageName: '@flighthq/task', source: 'task.ts' };
    const base = Object.assign(new Error('mismatch'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: validModule,
      taskInventoryModule: validModule,
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(base)).toBe(true);

    const wrongCode = Object.assign(new Error('m'), {
      code: 'other',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: validModule,
      taskInventoryModule: validModule,
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(wrongCode)).toBe(false);

    const missingTaskModule = Object.assign(new Error('m'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: validModule,
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(missingTaskModule)).toBe(false);

    const invalidTaskModule = Object.assign(new Error('m'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: validModule,
      taskInventoryModule: { name: 42, packageName: 'pkg', source: 'a.ts' },
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(invalidTaskModule)).toBe(false);

    const invalidTaskModulePackage = Object.assign(new Error('m'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: validModule,
      taskInventoryModule: { name: 'task', packageName: 42, source: 'a.ts' },
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(invalidTaskModulePackage)).toBe(false);

    const invalidTaskModuleSource = Object.assign(new Error('m'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: validModule,
      taskInventoryModule: { name: 'task', packageName: 'pkg', source: 42 },
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(invalidTaskModuleSource)).toBe(false);

    const missingStateMachineModule = Object.assign(new Error('m'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      taskInventoryModule: validModule,
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(missingStateMachineModule)).toBe(false);

    const invalidStateMachineModule = Object.assign(new Error('m'), {
      code: 'module-identity',
      kind: 'runtime-task-capability-analysis-mismatch',
      stateMachineModule: { name: 42, packageName: 'pkg', source: 'a.ts' },
      taskInventoryModule: validModule,
    });
    expect(isCompilerRuntimeTaskCapabilityAnalysisMismatchFailure(invalidStateMachineModule)).toBe(false);
  });
});

describe('isCompilerRuntimeTaskCapabilityContractMismatchFailure', () => {
  it('recognizes an exact version mismatch and rejects structural lookalikes', () => {
    const incompatible = {
      capabilities: [],
      contract: 'flight-runtime-task-capability-abi/2',
    } as unknown as CompilerRuntimeTaskCapabilityPlan;

    expect(() => analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), incompatible)).toThrow(
      'Runtime task capability plan uses flight-runtime-task-capability-abi/2; expected flight-runtime-task-capability-abi/1',
    );
    try {
      analyzeCompilerRuntimeTaskCapabilityCompleteness(createRequirements([]), incompatible);
      expect.unreachable('Expected task capability contract mismatch');
    } catch (error) {
      expect(isCompilerRuntimeTaskCapabilityContractMismatchFailure(error)).toBe(true);
    }
    expect(isCompilerRuntimeTaskCapabilityContractMismatchFailure(new Error('mismatch'))).toBe(false);
    expect(
      isCompilerRuntimeTaskCapabilityContractMismatchFailure({
        expected: 'flight-runtime-task-capability-abi/1',
        kind: 'runtime-task-capability-contract-mismatch',
        received: 'flight-runtime-task-capability-abi/2',
      }),
    ).toBe(false);
  });

  it('rejects errors that match all but one required property', () => {
    const base = Object.assign(new Error('m'), {
      expected: 'flight-runtime-task-capability-abi/1',
      kind: 'runtime-task-capability-contract-mismatch',
      received: 'flight-runtime-task-capability-abi/2',
    });
    expect(isCompilerRuntimeTaskCapabilityContractMismatchFailure(base)).toBe(true);

    const wrongExpected = Object.assign(new Error('m'), {
      expected: 'flight-runtime-task-capability-abi/2',
      kind: 'runtime-task-capability-contract-mismatch',
      received: 'flight-runtime-task-capability-abi/2',
    });
    expect(isCompilerRuntimeTaskCapabilityContractMismatchFailure(wrongExpected)).toBe(false);

    const missingReceived = Object.assign(new Error('m'), {
      expected: 'flight-runtime-task-capability-abi/1',
      kind: 'runtime-task-capability-contract-mismatch',
    });
    expect(isCompilerRuntimeTaskCapabilityContractMismatchFailure(missingReceived)).toBe(false);

    const nonStringReceived = Object.assign(new Error('m'), {
      expected: 'flight-runtime-task-capability-abi/1',
      kind: 'runtime-task-capability-contract-mismatch',
      received: 42,
    });
    expect(isCompilerRuntimeTaskCapabilityContractMismatchFailure(nonStringReceived)).toBe(false);
  });
});

function createInventory(overrides: Partial<CompilerAsyncTaskInventory> = {}): CompilerAsyncTaskInventory {
  const operationNames = [
    'construct',
    'ready',
    'reject',
    'joinAll',
    'then',
    'catch',
    'finally',
    'invokeAsync',
  ] as const;
  return {
    module: compilerModule,
    operations: operationNames.map(createOperation),
    schema: 'flight-compiler-async-task-inventory/1',
    scopes: [],
    suspensions: [],
    ...overrides,
  };
}

function createBinding(id: string, name: string): IrBindingIdentity {
  return {
    column: 1,
    fingerprint: 'sha256:task',
    id,
    kind: 'function',
    line: 1,
    name,
    packageName: compilerModule.packageName,
    scope: 'module',
    source: compilerModule.source,
    space: 'value',
  };
}

function createOperation(
  operation: CompilerAsyncTaskOperation['operation'],
  index: number,
): CompilerAsyncTaskOperation {
  const common = { argumentCount: 1 as const, optional: false, path: ['operations', index] };
  switch (operation) {
    case 'construct':
      return { ...common, evidence: 'ambient-promise-constructor', operation };
    case 'joinAll':
    case 'ready':
    case 'reject':
      return { ...common, evidence: 'ambient-promise-static', operation };
    case 'invokeAsync':
      return { ...common, evidence: 'async-binding', operation };
    case 'catch':
    case 'finally':
    case 'then':
      return { ...common, evidence: 'property-name-candidate', operation };
  }
}

function createPlan(): CompilerRuntimeTaskCapabilityPlan {
  return {
    capabilities: [
      {
        capability: 'construct',
        completionSemantics: 'flight-compiler-async-task-completion/1',
        executorInvocation: 'synchronous',
        executorParameters: ['resolve', 'reject'],
        invocation: 'constructor',
        settlementCallbacks: 'first-call-wins-assimilating-resolve-exact-reject',
      },
      {
        awaitSemantics: 'flight-compiler-await-semantics/1',
        capability: 'continue',
        invocation: 'instanceMethod',
        memberName: 'then',
        operation: 'then',
        operationSemantics: 'flight-compiler-task-operation-semantics/1',
      },
      {
        capability: 'cleanup',
        invocation: 'instanceMethod',
        memberName: 'finally',
        operation: 'finally',
        operationSemantics: 'flight-compiler-task-operation-semantics/1',
      },
      {
        capability: 'joinAll',
        invocation: 'staticMethod',
        memberName: 'all',
        operation: 'joinAll',
        operationSemantics: 'flight-compiler-task-operation-semantics/1',
      },
      {
        capability: 'normalize',
        invocation: 'staticMethod',
        memberName: 're\u0301solve',
        operation: 'ready',
        operationSemantics: 'flight-compiler-task-operation-semantics/1',
      },
      {
        capability: 'reject',
        invocation: 'staticMethod',
        memberName: 'reject',
        operation: 'reject',
        operationSemantics: 'flight-compiler-task-operation-semantics/1',
      },
    ],
    contract: 'flight-runtime-task-capability-abi/1',
  };
}

function createRequirements(
  capabilities: CompilerRuntimeTaskCapability['capability'][],
): CompilerRuntimeTaskCapabilityRequirements {
  return {
    module: compilerModule,
    requirements: capabilities.map((capability) => ({ capability, evidence: [] })),
    schema: 'flight-runtime-task-capability-requirements/1',
  };
}

function createStateMachines(
  overrides: Partial<CompilerAsyncStateMachineAnalysis> = {},
): CompilerAsyncStateMachineAnalysis {
  return {
    machines: [
      {
        completionPaths: { paths: [], schema: 'flight-compiler-value-completion-path-set/1' },
        origin: {
          binding: createBinding('binding:task', 'task'),
          kind: 'functionDeclaration',
        },
        path: ['declarations', 0],
        retainedBindings: [],
        retainedCaptures: [],
        states: [
          {
            identity: { kind: 'entry' },
            steps: [
              {
                fulfillment: { kind: 'discard' },
                kind: 'suspend',
                operandPath: ['declarations', 0, 'body', 0, 'expression', 'expression'],
                path: ['declarations', 0, 'body', 0, 'expression'],
                rejection: {
                  kind: 'expression',
                  path: ['declarations', 0, 'body', 0, 'expression'],
                  phase: 'abrupt',
                },
                resumeState: {
                  kind: 'resume',
                  suspensionPath: ['declarations', 0, 'body', 0, 'expression'],
                },
              },
            ],
          },
          {
            identity: {
              kind: 'resume',
              suspensionPath: ['declarations', 0, 'body', 0, 'expression'],
            },
            steps: [
              {
                kind: 'resolve',
                path: ['declarations', 0, 'body', 'end'],
                value: { kind: 'implicitUndefined' },
              },
            ],
          },
        ],
      },
      {
        completionPaths: { paths: [], schema: 'flight-compiler-value-completion-path-set/1' },
        origin: {
          binding: createBinding('binding:rejecting', 'rejecting'),
          kind: 'functionDeclaration',
        },
        path: ['declarations', 1],
        retainedBindings: [],
        retainedCaptures: [],
        states: [
          {
            identity: { kind: 'entry' },
            steps: [
              {
                kind: 'reject',
                path: ['declarations', 1, 'body', 0],
                value: {
                  kind: 'expression',
                  path: ['declarations', 1, 'body', 0, 'expression'],
                  phase: 'result',
                },
              },
            ],
          },
        ],
      },
    ],
    module: compilerModule,
    refusals: [],
    schema: 'flight-compiler-async-state-machine-analysis/1',
    ...overrides,
  };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

const compilerModule: CompilerModuleIdentity = {
  name: 'task',
  packageName: '@flighthq/task',
  source: 'task.ts',
};
