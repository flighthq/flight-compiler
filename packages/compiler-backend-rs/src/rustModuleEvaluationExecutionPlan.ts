import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleEvaluationGroup,
  CompilerModuleIdentity,
  CompilerRustModuleEvaluationExecutionEntryPlan,
  CompilerRustModuleEvaluationExecutionModulePlan,
  CompilerRustModuleEvaluationExecutionPlan,
  CompilerRustModuleEvaluationExecutionPlanInput,
  CompilerRustModuleEvaluationExecutionPlanningFailure,
  CompilerRustModuleEvaluationExecutionPlanningFailureCode,
  CompilerRustModuleEvaluationInvocationPlan,
  CompilerRustModuleEvaluationRepresentationPlan,
  CompilerRustModuleEvaluationRepresentationRefusal,
  CompilerRustPublicCrateIdentity,
} from '../../compiler-types/src/index.js';
import { convertPackageNameToRustCrateName, getRustPreferredBindingName } from './rustCompilerIdentity.js';

/**
 * Binds a finalized Rust representation to an ordered, host-callable lifecycle ABI. Neutral SCC order
 * remains authoritative: every group receives one crate-owned hook, and no crate-wide eager initializer
 * may reorder groups that are interleaved across crates.
 */
export function createCompilerRustModuleEvaluationExecutionPlan(
  input: Readonly<CompilerRustModuleEvaluationExecutionPlanInput>,
): CompilerRustModuleEvaluationExecutionPlan {
  assertRustModuleEvaluationExecutionInput(input);
  if (input.representation.kind === 'output-scope-incomplete') {
    return cloneAndFreezeRustModuleEvaluationExecutionValue(
      createRustModuleEvaluationExecutionPlanValue({
        availability: {
          outcome: 'refused',
          refusals: [input.representation.refusal],
          subjects: createRustModuleEvaluationExecutionSubjects([
            input.representation.refusal.subject,
            ...input.representation.subjects,
          ]),
        },
        entries: [],
        modules: [],
        phases: [
          { invocations: [], kind: 'instantiate' },
          { invocations: [], kind: 'evaluate' },
        ],
        runtimeCrate: input.runtimeCrate,
      }),
    );
  }

  const representation = input.representation.plan;
  assertRustModuleEvaluationExecutionProjection(input.moduleEvaluation, representation);
  const refusals = consumeRustModuleEvaluationEntryRefusals(input.moduleEvaluation.entries, representation);
  assertRustModuleEvaluationExecutionRefusedGroups(representation, refusals);
  assertRustModuleEvaluationExecutionReservedNamespace(representation);
  const crates = createRustModuleEvaluationExecutionCrates(representation);
  const groupIndexByModule = createRustModuleEvaluationExecutionGroupIndex(representation);
  const entries = representation.entries.map((entry): CompilerRustModuleEvaluationExecutionEntryPlan => {
    const groupIndex = groupIndexByModule.get(getRustModuleEvaluationExecutionIdentityKey(entry.module));
    if (groupIndex === undefined) {
      throw createRustModuleEvaluationExecutionProjectionMismatch([
        formatRustModuleEvaluationExecutionIdentity(entry.module),
      ]);
    }
    return {
      crate: crates.get(entry.module.packageName)!,
      groupIndex,
      locator: entry.locator,
      module: entry.module,
    };
  });
  const modules = representation.modules
    .filter((module) => groupIndexByModule.has(getRustModuleEvaluationExecutionIdentityKey(module.module)))
    .map(
      (module): CompilerRustModuleEvaluationExecutionModulePlan => ({
        crate: crates.get(module.module.packageName)!,
        groupIndex: groupIndexByModule.get(getRustModuleEvaluationExecutionIdentityKey(module.module))!,
        lifecycle: {
          evaluate: {
            signature: { parameters: [], result: 'Result<(), FlightModuleEvaluationError>' },
            spelling: '__flight_evaluate_once',
            visibility: 'crate',
          },
          instantiate: {
            signature: { parameters: [], result: 'Result<(), FlightModuleEvaluationError>' },
            spelling: '__flight_instantiate_once',
            visibility: 'crate',
          },
          state: {
            spelling: '__flight_module_evaluation_state',
            states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'],
            visibility: 'private',
          },
        },
        locator: module.locator,
        module: module.module,
      }),
    );
  const available = refusals.length === 0;
  const instantiate = available ? createRustModuleEvaluationInvocations(representation, crates, 'instantiate') : [];
  const evaluate = available ? createRustModuleEvaluationInvocations(representation, crates, 'evaluate') : [];

  return cloneAndFreezeRustModuleEvaluationExecutionValue(
    createRustModuleEvaluationExecutionPlanValue({
      availability: available
        ? { outcome: 'available' }
        : {
            outcome: 'refused',
            refusals,
            subjects: createRustModuleEvaluationExecutionSubjects(refusals.map(({ subject }) => subject)),
          },
      entries,
      modules,
      phases: [
        { invocations: instantiate, kind: 'instantiate' },
        { invocations: evaluate, kind: 'evaluate' },
      ],
      runtimeCrate: input.runtimeCrate,
    }),
  );
}

export function isCompilerRustModuleEvaluationExecutionPlanningFailure(
  value: unknown,
): value is CompilerRustModuleEvaluationExecutionPlanningFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'rust-module-evaluation-execution-planning' &&
    'code' in value &&
    rustModuleEvaluationExecutionPlanningFailureCodes.has(
      value.code as CompilerRustModuleEvaluationExecutionPlanningFailureCode,
    ) &&
    'subjects' in value &&
    Array.isArray(value.subjects) &&
    value.subjects.length > 0 &&
    value.subjects.every((subject) => typeof subject === 'string' && subject.length > 0)
  );
}

function assertRustModuleEvaluationExecutionInput(
  input: Readonly<CompilerRustModuleEvaluationExecutionPlanInput>,
): void {
  if (
    !input ||
    typeof input !== 'object' ||
    input.moduleEvaluation?.schema !== 'flight-compiler-module-evaluation/1' ||
    !input.representation ||
    (input.representation.kind !== 'plan' && input.representation.kind !== 'output-scope-incomplete') ||
    (input.runtimeCrate !== undefined && input.runtimeCrate.length === 0)
  ) {
    throw createRustModuleEvaluationExecutionPlanningFailure(
      'rust-module-evaluation-execution-invalid-input',
      ['input'],
      'Rust module-evaluation execution planning requires finalized representation and neutral plan evidence',
    );
  }
  if (input.representation.kind === 'plan') {
    if (input.representation.plan?.schema !== 'flight-rust-module-evaluation-representation-plan/1') {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-invalid-input',
        ['representation'],
        'Rust module-evaluation execution planning requires representation plan schema 1',
      );
    }
    return;
  }
  if (
    input.representation.refusal?.code !== 'rust-module-evaluation-output-scope-incomplete' ||
    !Array.isArray(input.representation.subjects) ||
    input.representation.subjects.length === 0
  ) {
    throw createRustModuleEvaluationExecutionPlanningFailure(
      'rust-module-evaluation-execution-invalid-input',
      ['representation'],
      'Rust module-evaluation incomplete output requires its refusal and deterministic subjects',
    );
  }
}

function assertRustModuleEvaluationExecutionProjection(
  neutral: Readonly<CompilerRustModuleEvaluationExecutionPlanInput['moduleEvaluation']>,
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
): void {
  if (
    representation.eligibility.scope !== 'full-output' ||
    representation.eligibility.outcome !==
      (representation.eligibility.refusals.length === 0 ? 'eligible' : 'refused') ||
    !areRustModuleEvaluationExecutionValuesEqual(representation.semantics, neutral.semantics)
  ) {
    throw createRustModuleEvaluationExecutionProjectionMismatch(['eligibility', 'semantics']);
  }
  assertRustModuleEvaluationExecutionIdentitySequence(
    neutral.entries,
    representation.entries.map(({ module }) => module),
    'entries',
  );
  assertRustModuleEvaluationExecutionIdentitySequence(
    neutral.modules.map(({ module }) => module),
    representation.modules.map(({ module }) => module),
    'modules',
  );
  if (neutral.groups.length !== representation.groups.length) {
    throw createRustModuleEvaluationExecutionProjectionMismatch(['groups']);
  }
  neutral.groups.forEach((group, index) => {
    const projected = representation.groups[index];
    if (
      !projected ||
      group.cyclic !== projected.cyclic ||
      !areRustModuleEvaluationExecutionIdentitiesEqual(group.modules, projected.modules)
    ) {
      throw createRustModuleEvaluationExecutionProjectionMismatch([`groups[${String(index)}]`]);
    }
    assertRustModuleEvaluationExecutionGroupRepresentation(group, projected.representation, index);
  });

  const moduleByIdentity = new Map(
    representation.modules.map((module) => [getRustModuleEvaluationExecutionIdentityKey(module.module), module]),
  );
  for (const module of representation.modules) {
    if (
      module.locator.packageName !== module.module.packageName ||
      !areRustModuleEvaluationExecutionValuesEqual(module.lifecycle, {
        evaluate: 'module-private-evaluate-once-function',
        instantiate: 'module-private-instantiate-once-function',
        state: 'module-private-lifecycle-state',
        states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'],
      })
    ) {
      throw createRustModuleEvaluationExecutionProjectionMismatch([
        formatRustModuleEvaluationExecutionIdentity(module.module),
      ]);
    }
  }
  for (const entry of representation.entries) {
    const module = moduleByIdentity.get(getRustModuleEvaluationExecutionIdentityKey(entry.module));
    if (!module || !areRustModuleEvaluationExecutionValuesEqual(entry.locator, module.locator)) {
      throw createRustModuleEvaluationExecutionProjectionMismatch([
        formatRustModuleEvaluationExecutionIdentity(entry.module),
      ]);
    }
  }
}

function assertRustModuleEvaluationExecutionGroupRepresentation(
  group: Readonly<CompilerModuleEvaluationGroup>,
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan['groups'][number]['representation']>,
  index: number,
): void {
  const packages = [...new Set(group.modules.map(({ packageName }) => packageName))];
  const valid = group.cyclic
    ? packages.length === 1
      ? representation.kind === 'same-crate-scc' && representation.packageName === packages[0]
      : packages.length > 1 &&
        representation.kind === 'refused' &&
        representation.refusal.code === 'rust-module-evaluation-cross-crate-cycle-unrepresented'
    : group.modules.length === 1 && representation.kind === 'single-module';
  if (!valid) throw createRustModuleEvaluationExecutionProjectionMismatch([`groups[${String(index)}].representation`]);
}

function assertRustModuleEvaluationExecutionIdentitySequence(
  expected: readonly Readonly<CompilerModuleIdentity>[],
  actual: readonly Readonly<CompilerModuleIdentity>[],
  subject: string,
): void {
  if (
    expected.length !== actual.length ||
    expected.some(
      (identity, index) =>
        getRustModuleEvaluationExecutionIdentityKey(identity) !==
        getRustModuleEvaluationExecutionIdentityKey(actual[index]!),
    )
  ) {
    throw createRustModuleEvaluationExecutionProjectionMismatch([subject]);
  }
  const keys = expected.map(getRustModuleEvaluationExecutionIdentityKey);
  if (new Set(keys).size !== keys.length) throw createRustModuleEvaluationExecutionProjectionMismatch([subject]);
}

function assertRustModuleEvaluationExecutionRefusedGroups(
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
  refusals: readonly Readonly<CompilerRustModuleEvaluationRepresentationRefusal>[],
): void {
  for (const [index, group] of representation.groups.entries()) {
    if (group.representation.kind !== 'refused') continue;
    const groupRefusal = group.representation.refusal;
    if (!refusals.some((refusal) => areRustModuleEvaluationExecutionValuesEqual(refusal, groupRefusal))) {
      throw createRustModuleEvaluationExecutionProjectionMismatch([`groups[${String(index)}].refusal`]);
    }
  }
}

function assertRustModuleEvaluationExecutionReservedNamespace(
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
): void {
  const collisions: string[] = [];
  const executablePackages = new Set(
    representation.groups.flatMap(({ modules }) => modules.map(({ packageName }) => packageName)),
  );
  for (const module of representation.modules) {
    if (!executablePackages.has(module.module.packageName)) continue;
    for (const segment of module.locator.modulePath) {
      if (segment.startsWith(rustModuleEvaluationExecutionReservedPrefix)) {
        collisions.push(`${formatRustModuleEvaluationExecutionIdentity(module.module)}::${segment}`);
      }
    }
    const constants = new Set(
      module.bindings.flatMap((binding) =>
        binding.kind === 'local' && binding.binding.kind === 'variable' && binding.mutation === 'immutable'
          ? [binding.binding.id]
          : [],
      ),
    );
    for (const binding of module.bindings) {
      const spelling = getRustPreferredBindingName(binding.binding, constants);
      if (spelling.startsWith(rustModuleEvaluationExecutionReservedPrefix)) {
        collisions.push(`${formatRustModuleEvaluationExecutionIdentity(module.module)}#${binding.binding.id}`);
      }
    }
  }
  if (collisions.length > 0) {
    throw createRustModuleEvaluationExecutionPlanningFailure(
      'rust-module-evaluation-execution-reserved-name-collision',
      collisions,
      'Rust source output collides with the reserved __flight_ module-evaluation lifecycle namespace',
    );
  }
}

function consumeRustModuleEvaluationEntryRefusals(
  entries: readonly Readonly<CompilerModuleIdentity>[],
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
): readonly CompilerRustModuleEvaluationRepresentationRefusal[] {
  const entryKeys = new Set(entries.map(getRustModuleEvaluationExecutionIdentityKey));
  const projectedByKey = new Map<string, CompilerRustModuleEvaluationRepresentationRefusal>();
  for (const entry of representation.entries) {
    const key = getRustModuleEvaluationExecutionIdentityKey(entry.module);
    if (
      entry.invocation.kind !== 'unbound' ||
      entry.invocation.refusal.code !== 'rust-module-evaluation-entry-invocation-unbound' ||
      !entry.invocation.refusal.module ||
      getRustModuleEvaluationExecutionIdentityKey(entry.invocation.refusal.module) !== key
    ) {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-entry-refusal-missing',
        [formatRustModuleEvaluationExecutionIdentity(entry.module)],
        'Rust module-evaluation entry lacks its authoritative unbound invocation refusal',
      );
    }
    projectedByKey.set(key, entry.invocation.refusal);
  }

  const unboundByKey = new Map<string, CompilerRustModuleEvaluationRepresentationRefusal[]>();
  for (const refusal of representation.eligibility.refusals) {
    if (refusal.code !== 'rust-module-evaluation-entry-invocation-unbound') continue;
    if (!refusal.module || !entryKeys.has(getRustModuleEvaluationExecutionIdentityKey(refusal.module))) {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-entry-refusal-non-entry',
        [refusal.subject],
        'Rust module-evaluation execution evidence contains an unbound refusal for a non-entry module',
      );
    }
    const key = getRustModuleEvaluationExecutionIdentityKey(refusal.module);
    unboundByKey.set(key, [...(unboundByKey.get(key) ?? []), refusal]);
  }
  for (const entry of entries) {
    const key = getRustModuleEvaluationExecutionIdentityKey(entry);
    const refusals = unboundByKey.get(key) ?? [];
    if (refusals.length === 0) {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-entry-refusal-missing',
        [formatRustModuleEvaluationExecutionIdentity(entry)],
        'Rust module-evaluation eligibility omits the authoritative entry invocation refusal',
      );
    }
    if (refusals.length > 1) {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-entry-refusal-duplicate',
        [formatRustModuleEvaluationExecutionIdentity(entry)],
        'Rust module-evaluation eligibility duplicates an entry invocation refusal',
      );
    }
    if (!areRustModuleEvaluationExecutionValuesEqual(projectedByKey.get(key), refusals[0])) {
      throw createRustModuleEvaluationExecutionProjectionMismatch([formatRustModuleEvaluationExecutionIdentity(entry)]);
    }
  }
  return representation.eligibility.refusals.filter(
    ({ code }) => code !== 'rust-module-evaluation-entry-invocation-unbound',
  );
}

function createRustModuleEvaluationExecutionCrates(
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
): ReadonlyMap<string, Readonly<CompilerRustPublicCrateIdentity>> {
  const packageNames = [
    ...new Set(representation.groups.flatMap(({ modules }) => modules.map(({ packageName }) => packageName))),
  ].sort(compareTextCodeUnits);
  const crates = new Map<string, CompilerRustPublicCrateIdentity>();
  const packageByCargoName = new Map<string, string>();
  for (const packageName of packageNames) {
    let cargoName: string;
    try {
      cargoName = convertPackageNameToRustCrateName(packageName);
    } catch {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-invalid-input',
        [packageName],
        `Rust module-evaluation package ${packageName} has no valid crate identity`,
      );
    }
    const collision = packageByCargoName.get(cargoName);
    if (collision) {
      throw createRustModuleEvaluationExecutionPlanningFailure(
        'rust-module-evaluation-execution-reserved-name-collision',
        [collision, packageName],
        `Rust module-evaluation packages share crate identity ${cargoName}`,
      );
    }
    packageByCargoName.set(cargoName, packageName);
    crates.set(packageName, { cargoName, packageName, rustName: cargoName.replaceAll('-', '_') });
  }
  return crates;
}

function createRustModuleEvaluationExecutionGroupIndex(
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
): ReadonlyMap<string, number> {
  const groupIndexByModule = new Map<string, number>();
  for (const [groupIndex, group] of representation.groups.entries()) {
    for (const module of group.modules) {
      const key = getRustModuleEvaluationExecutionIdentityKey(module);
      if (groupIndexByModule.has(key)) throw createRustModuleEvaluationExecutionProjectionMismatch([key]);
      groupIndexByModule.set(key, groupIndex);
    }
  }
  const moduleKeys = new Set(
    representation.modules.map(({ module }) => getRustModuleEvaluationExecutionIdentityKey(module)),
  );
  for (const key of groupIndexByModule.keys()) {
    if (!moduleKeys.has(key)) throw createRustModuleEvaluationExecutionProjectionMismatch([key]);
  }
  return groupIndexByModule;
}

function createRustModuleEvaluationExecutionPlanValue(
  input: Readonly<{
    availability: CompilerRustModuleEvaluationExecutionPlan['availability'];
    entries: CompilerRustModuleEvaluationExecutionPlan['entries'];
    modules: CompilerRustModuleEvaluationExecutionPlan['modules'];
    phases: CompilerRustModuleEvaluationExecutionPlan['phases'];
    runtimeCrate: string | undefined;
  }>,
): CompilerRustModuleEvaluationExecutionPlan {
  return {
    availability: input.availability,
    entries: input.entries,
    error: {
      crateName: input.runtimeCrate ?? 'flight_runtime',
      result: 'Result<(), FlightModuleEvaluationError>',
      targetName: 'FlightModuleEvaluationError',
    },
    modules: input.modules,
    phases: input.phases,
    publicBindingSchema: 'flight-rust-public-binding-plan/3',
    representationSchema: 'flight-rust-module-evaluation-representation-plan/1',
    runtimeAbiSchema: 'flight-rust-runtime-abi/4',
    schema: 'flight-rust-module-evaluation-execution-plan/1',
    semantics: {
      concurrency: 'serialized-by-bootstrap',
      facadeAccess: 'successful-bootstrap-before-value-access',
      failure: 'cache-first-error-stop-without-retry',
      groupOrder: 'flight-compiler-module-evaluation/1',
      phaseOrder: ['instantiate', 'evaluate'],
      reentrancy: 'reject',
      repeatedInvocation: 'cache-first-result',
      reservedNamespace: '__flight_',
    },
  };
}

function createRustModuleEvaluationInvocations(
  representation: Readonly<CompilerRustModuleEvaluationRepresentationPlan>,
  crates: ReadonlyMap<string, Readonly<CompilerRustPublicCrateIdentity>>,
  phase: 'evaluate' | 'instantiate',
): readonly CompilerRustModuleEvaluationInvocationPlan[] {
  return representation.groups.map((group, groupIndex) => {
    const packageName = group.modules[0]!.packageName;
    return {
      crate: crates.get(packageName)!,
      cyclic: group.cyclic,
      groupIndex,
      locator: {
        modulePath: [],
        spelling: `__flight_${phase}_group_${groupIndex}`,
        visibility: 'public-doc-hidden',
      },
      modules: group.modules,
      signature: { parameters: [], result: 'Result<(), FlightModuleEvaluationError>' },
    };
  });
}

function createRustModuleEvaluationExecutionPlanningFailure(
  code: CompilerRustModuleEvaluationExecutionPlanningFailureCode,
  subjects: readonly string[],
  message: string,
): CompilerRustModuleEvaluationExecutionPlanningFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'rust-module-evaluation-execution-planning' as const,
    subjects: createRustModuleEvaluationExecutionSubjects(subjects),
  });
  failure.name = 'CompilerRustModuleEvaluationExecutionPlanningError';
  return failure;
}

function createRustModuleEvaluationExecutionProjectionMismatch(
  subjects: readonly string[],
): CompilerRustModuleEvaluationExecutionPlanningFailure {
  return createRustModuleEvaluationExecutionPlanningFailure(
    'rust-module-evaluation-execution-projection-mismatch',
    subjects,
    'Rust module-evaluation representation does not exactly project the authoritative neutral plan',
  );
}

function createRustModuleEvaluationExecutionSubjects(subjects: readonly string[]): readonly string[] {
  return [...new Set(subjects)].sort(compareTextCodeUnits);
}

function areRustModuleEvaluationExecutionIdentitiesEqual(
  left: readonly Readonly<CompilerModuleIdentity>[],
  right: readonly Readonly<CompilerModuleIdentity>[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (identity, index) =>
        getRustModuleEvaluationExecutionIdentityKey(identity) ===
        getRustModuleEvaluationExecutionIdentityKey(right[index]!),
    )
  );
}

function areRustModuleEvaluationExecutionValuesEqual(left: unknown, right: unknown): boolean {
  return normalizeCompilerStructuralValueCanonical(left) === normalizeCompilerStructuralValueCanonical(right);
}

function cloneAndFreezeRustModuleEvaluationExecutionValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeRustModuleEvaluationExecutionValue(clone, new WeakSet());
  return clone;
}

function formatRustModuleEvaluationExecutionIdentity(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}/${module.source}#${module.name}`;
}

function freezeRustModuleEvaluationExecutionValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const member of Object.values(value)) freezeRustModuleEvaluationExecutionValue(member, seen);
}

function getRustModuleEvaluationExecutionIdentityKey(module: Readonly<CompilerModuleIdentity>): string {
  return JSON.stringify([module.packageName, module.source, module.name]);
}

const rustModuleEvaluationExecutionPlanningFailureCodes: ReadonlySet<CompilerRustModuleEvaluationExecutionPlanningFailureCode> =
  new Set([
    'rust-module-evaluation-execution-entry-refusal-duplicate',
    'rust-module-evaluation-execution-entry-refusal-missing',
    'rust-module-evaluation-execution-entry-refusal-non-entry',
    'rust-module-evaluation-execution-invalid-input',
    'rust-module-evaluation-execution-projection-mismatch',
    'rust-module-evaluation-execution-reserved-name-collision',
  ]);

const rustModuleEvaluationExecutionReservedPrefix = '__flight_';
