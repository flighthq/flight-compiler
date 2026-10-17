import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { createBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerRustRuntimeAbiManifest,
  CompilerRustRuntimeRequirement,
  CompilerRustRuntimeRequirementsPlan,
} from '../../compiler-types/src/index.js';
import { createCompilerRustAmbientMemberBindingPlan } from './rustAmbientMemberBinding.js';
import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import { createCompilerRustRuntimeExternalSymbolBindingPlan } from './rustRuntimeExternalSymbolBinding.js';

export function createCompilerRustRuntimeAbiManifest(): CompilerRustRuntimeAbiManifest {
  return cloneAndFreezeRustRuntimeAbiValue({
    ambientMembers: createCompilerRustAmbientMemberBindingPlan(),
    constructors: createCompilerRuntimeExternalConstructorAbiPlanRust(),
    externalSymbols: createCompilerRustRuntimeExternalSymbolBindingPlan(),
    representation: {
      nullability: { nonNull: 'direct', nullableTargetName: 'Option' },
      ownership: { nonCopyReuse: 'clone', runtimeWrapperCarrier: 'owned', temporaryAccess: 'borrow' },
      schema: 'flight-rust-runtime-representation/1',
    },
    requirements: createCompilerRustRuntimeRequirementsPlan(),
    schema: 'flight-rust-runtime-abi/3',
  });
}

export function validateCompilerRustRuntimeAbiManifest(
  module: Readonly<CompilerModuleIdentity>,
  manifest: Readonly<CompilerRustRuntimeAbiManifest>,
): void {
  const expected = createCompilerRustRuntimeRequirementsPlan();
  const expectedByIdentity = new Map(
    expected.requirements.map((requirement) => [getRustRuntimeRequirementIdentity(requirement), requirement]),
  );
  const actualIdentities = manifest.requirements.requirements.map(getRustRuntimeRequirementIdentity);
  const actualGroups = new Map<string, number>();
  for (const identity of actualIdentities) actualGroups.set(identity, (actualGroups.get(identity) ?? 0) + 1);
  const missing = [...expectedByIdentity.keys()].filter((identity) => !actualGroups.has(identity));
  const duplicate = [...actualGroups].filter(([, count]) => count > 1).map(([identity]) => identity);
  const unexpected = [...actualGroups.keys()].filter((identity) => !expectedByIdentity.has(identity));
  const invalidPlans = [
    ...(manifest.schema === 'flight-rust-runtime-abi/3' ? [] : [`manifest schema ${String(manifest.schema)}`]),
    ...(manifest.requirements.schema === 'flight-rust-runtime-requirements/1'
      ? []
      : [`requirements schema ${String(manifest.requirements.schema)}`]),
    ...(JSON.stringify(manifest.requirements.tasks) === JSON.stringify(expected.tasks) ? [] : ['task requirements']),
    ...(JSON.stringify(manifest.requirements.unsupportedCapabilities) ===
    JSON.stringify(expected.unsupportedCapabilities)
      ? []
      : ['unsupported capabilities']),
  ];
  const problems = [
    ...missing.map((identity) => `missing ${formatRustRuntimeRequirementIdentity(identity)}`),
    ...duplicate.map((identity) => `duplicate ${formatRustRuntimeRequirementIdentity(identity)}`),
    ...unexpected.map((identity) => `unexpected ${formatRustRuntimeRequirementIdentity(identity)}`),
    ...invalidPlans.map((plan) => `invalid ${plan}`),
  ].sort(compareTextCodeUnits);
  if (problems.length === 0) return;
  throw createBackendEmissionFailure(
    'rust',
    module,
    `Rust runtime ABI requirements are incomplete: ${problems.join('; ')}`,
    'rust-runtime-abi-requirement-incomplete',
    { classification: 'target-runtime' },
  );
}

function addRustRuntimeRequirement(
  requirements: Map<string, CompilerRustRuntimeRequirement>,
  requirement: CompilerRustRuntimeRequirement,
): void {
  requirements.set(getRustRuntimeRequirementIdentity(requirement), requirement);
}

function addRustRuntimeTypeMembers(
  requirements: Map<string, CompilerRustRuntimeRequirement>,
  targetNames: readonly string[],
  memberNames: readonly string[],
): void {
  for (const targetName of targetNames) {
    for (const memberName of memberNames)
      addRustRuntimeRequirement(requirements, { kind: 'member', memberName, targetName });
  }
}

function cloneAndFreezeRustRuntimeAbiValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeRustRuntimeAbiValue(clone, new WeakSet());
  return clone;
}

function createCompilerRustRuntimeRequirementsPlan(): CompilerRustRuntimeRequirementsPlan {
  const externalSymbols = createCompilerRustRuntimeExternalSymbolBindingPlan();
  const ambientMembers = createCompilerRustAmbientMemberBindingPlan();
  const constructors = createCompilerRuntimeExternalConstructorAbiPlanRust();
  const requirements = new Map<string, CompilerRustRuntimeRequirement>();
  const runtimeTargetsBySource = new Map<string, Set<string>>();
  for (const binding of externalSymbols.bindings) {
    if (binding.kind === 'runtime') {
      addRustRuntimeRequirement(requirements, { kind: 'type', targetName: binding.targetName });
      const targets = runtimeTargetsBySource.get(binding.externalSymbol.sourceName) ?? new Set<string>();
      targets.add(binding.targetName);
      runtimeTargetsBySource.set(binding.externalSymbol.sourceName, targets);
    }
    for (const member of binding.members ?? []) {
      if (member.targetName.startsWith('flight_runtime::')) {
        addRustRuntimeRequirement(requirements, { kind: 'function', targetName: member.targetName });
      } else if (binding.kind === 'runtime' && member.targetName.startsWith(`${binding.targetName}::`)) {
        addRustRuntimeRequirement(requirements, {
          kind: 'member',
          memberName: member.targetName.slice(binding.targetName.length + 2),
          targetName: binding.targetName,
        });
      }
    }
  }

  addRustRuntimeRequirement(requirements, { kind: 'type', targetName: 'FlightSymbol' });
  addRustRuntimeRequirement(requirements, { kind: 'type', targetName: 'OpaqueHostValue' });
  addRustRuntimeRequirement(requirements, {
    kind: 'function',
    targetName: 'flight_runtime::panic_task_rejection',
  });

  const typedArrayTargets = rustTypedArraySourceNames.flatMap((sourceName) => [
    ...(runtimeTargetsBySource.get(sourceName) ?? []),
  ]);
  const ambientReceiverTargets = new Map([
    ['arrayBuffer', [...(runtimeTargetsBySource.get('ArrayBuffer') ?? [])]],
    ['dataView', [...(runtimeTargetsBySource.get('DataView') ?? [])]],
    ['date', [...(runtimeTargetsBySource.get('Date') ?? [])]],
    ['typedArray', typedArrayTargets],
  ]);
  for (const { binding, receiver } of ambientMembers.bindings) {
    if (binding.kind === 'runtimeMethod') {
      addRustRuntimeRequirement(requirements, { kind: 'function', targetName: binding.targetName });
      continue;
    }
    addRustRuntimeTypeMembers(requirements, ambientReceiverTargets.get(receiver) ?? [], [binding.targetName]);
  }

  if (hasRustRuntimeConstructorArity(constructors, 'ArrayBuffer', 1)) {
    addRustRuntimeTypeMembers(requirements, [...(runtimeTargetsBySource.get('ArrayBuffer') ?? [])], ['new']);
  }
  addRustRuntimeTypeMembers(
    requirements,
    [...(runtimeTargetsBySource.get('DataView') ?? [])],
    [
      ...(hasRustRuntimeConstructorArity(constructors, 'DataView', 1) ? ['from_buffer'] : []),
      ...(hasRustRuntimeConstructorArity(constructors, 'DataView', 2) ? ['from_buffer_offset'] : []),
      ...(hasRustRuntimeConstructorArity(constructors, 'DataView', 3) ? ['from_buffer_range'] : []),
    ],
  );
  addRustRuntimeTypeMembers(requirements, typedArrayTargets, [
    'copy_from',
    'get_index',
    'set_index',
    'slice_range',
    'subarray_range',
  ]);
  for (const sourceName of rustTypedArraySourceNames) {
    addRustRuntimeTypeMembers(
      requirements,
      [...(runtimeTargetsBySource.get(sourceName) ?? [])],
      [
        ...(hasRustRuntimeConstructorArity(constructors, sourceName, 0) ? ['empty'] : []),
        ...(hasRustRuntimeConstructorArity(constructors, sourceName, 1) ? ['from_buffer', 'from_source'] : []),
        ...(hasRustRuntimeConstructorArity(constructors, sourceName, 2) ? ['from_buffer_offset'] : []),
        ...(hasRustRuntimeConstructorArity(constructors, sourceName, 3) ? ['from_buffer_range'] : []),
      ],
    );
  }

  addRustRuntimeRequirement(requirements, { kind: 'member', memberName: 'ready', targetName: 'FlightTask' });
  addRustRuntimeRequirement(requirements, { kind: 'member', memberName: 'from_future', targetName: 'FlightTask' });
  addRustRuntimeRequirement(requirements, { kind: 'member', memberName: 'settle', targetName: 'FlightTask' });
  addRustRuntimeRequirement(requirements, { kind: 'trait', targetName: 'FlightTask', traitName: 'Clone' });
  addRustRuntimeRequirement(requirements, { kind: 'trait', targetName: 'FlightTask', traitName: 'Future' });

  return {
    requirements: [...requirements.values()].sort((left, right) =>
      compareTextCodeUnits(getRustRuntimeRequirementIdentity(left), getRustRuntimeRequirementIdentity(right)),
    ),
    schema: 'flight-rust-runtime-requirements/1',
    tasks: {
      adapter: {
        cancellation: 'drop-future-on-last-task-owner',
        executor: 'local-eager',
        future: "Future<Output = T> + 'static",
        member: 'from_future',
        ownership: 'consume-once',
        rejection: {
          panicFunction: 'flight_runtime::panic_task_rejection',
          stringPanic: 'preserve-string',
          taskRejection: 'preserve-string',
          unknownPanic: 'native future panicked',
        },
        sharing: 'shared-settlement',
        unwind: 'required',
      },
      awaitBoundary: {
        cloneTrait: 'Clone',
        futureTrait: 'Future',
        repeatedAwait: 'clone-before-await',
      },
      readyMember: 'ready',
      schema: 'flight-rust-runtime-task-requirements/2',
      settlement: {
        rejectionCarrier: 'String',
        result: 'Result<T, String>',
        settleMember: 'settle',
        unhandledRejection: 'structured-panic',
      },
      taskType: 'FlightTask',
    },
    unsupportedCapabilities: [
      {
        capability: 'typed-error-carrier',
        rule: 'rust-runtime-error-carrier-incomplete',
        subjects: ['Error', 'RangeError', 'TypeError'],
      },
      {
        capability: 'utf16-code-unit-index',
        rule: 'rust-string-utf16-index-unrepresented',
        subjects: ['string.charAt'],
      },
      {
        capability: 'utf16-code-unit-range',
        rule: 'rust-string-utf16-range-unrepresented',
        subjects: ['string.slice', 'string.substring'],
      },
    ],
  };
}

function formatRustRuntimeRequirementIdentity(identity: string): string {
  return identity.replaceAll('\u0000', '::');
}

function freezeRustRuntimeAbiValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRustRuntimeAbiValue(child, seen);
  Object.freeze(value);
}

function getRustRuntimeRequirementIdentity(requirement: Readonly<CompilerRustRuntimeRequirement>): string {
  switch (requirement.kind) {
    case 'function':
    case 'type':
      return `${requirement.kind}\u0000${requirement.targetName}`;
    case 'member':
      return `${requirement.kind}\u0000${requirement.targetName}\u0000${requirement.memberName}`;
    case 'trait':
      return `${requirement.kind}\u0000${requirement.targetName}\u0000${requirement.traitName}`;
  }
}

function hasRustRuntimeConstructorArity(
  constructors: ReturnType<typeof createCompilerRuntimeExternalConstructorAbiPlanRust>,
  sourceName: string,
  argumentCount: number,
): boolean {
  return constructors.constructors.some(
    (constructor) =>
      constructor.externalSymbol.sourceName === sourceName && constructor.fixedArgumentCounts.includes(argumentCount),
  );
}

const rustTypedArraySourceNames = [
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
] as const;
