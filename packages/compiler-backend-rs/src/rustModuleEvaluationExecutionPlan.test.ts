import type {
  CompilerModuleEvaluationDependency,
  CompilerModuleEvaluationGroup,
  CompilerModuleEvaluationPlan,
  CompilerModuleIdentity,
  CompilerRustModuleEvaluationExecutionPlanInput,
  CompilerRustModuleEvaluationExecutionPlanningFailure,
  CompilerRustModuleEvaluationGroupRepresentation,
  CompilerRustModuleEvaluationRepresentationPlan,
  CompilerRustModuleEvaluationRepresentationRefusal,
} from '../../compiler-types/src/index.js';
import {
  createCompilerRustModuleEvaluationExecutionPlan,
  isCompilerRustModuleEvaluationExecutionPlanningFailure,
} from './rustModuleEvaluationExecutionPlan.js';

describe('createCompilerRustModuleEvaluationExecutionPlan', () => {
  it('binds interleaved cross-crate groups into exact instantiate-then-evaluate order', () => {
    const entryOne = identity('@scope/alpha', 'entry-one');
    const entryTwo = identity('@scope/alpha', 'entry-two');
    const dependencyOne = identity('@scope/beta', 'dependency-one');
    const dependencyTwo = identity('@scope/beta', 'dependency-two');
    const input = createInput({
      entries: [entryOne, entryTwo],
      groups: [group(dependencyOne), group(entryOne), group(dependencyTwo), group(entryTwo)],
      modules: [entryOne, entryTwo, dependencyOne, dependencyTwo],
      runtimeCrate: 'custom_runtime',
    });
    const snapshot = structuredClone(input);

    const first = createCompilerRustModuleEvaluationExecutionPlan(input);
    const repeat = createCompilerRustModuleEvaluationExecutionPlan(input);

    expect(first).toEqual(repeat);
    expect(input).toEqual(snapshot);
    expect(first).toMatchObject({
      availability: { outcome: 'available' },
      error: {
        crateName: 'custom_runtime',
        result: 'Result<(), FlightModuleEvaluationError>',
        targetName: 'FlightModuleEvaluationError',
      },
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
    });
    expect(first.entries.map(({ groupIndex }) => groupIndex)).toEqual([1, 3]);
    expect(first.modules.map(({ groupIndex }) => groupIndex)).toEqual([1, 3, 0, 2]);
    expect(first.phases.map(({ kind }) => kind)).toEqual(['instantiate', 'evaluate']);
    expect(first.phases[0].invocations.map(invocationSummary)).toEqual([
      ['scope_beta', '__flight_instantiate_group_0', 'DependencyOne'],
      ['scope_alpha', '__flight_instantiate_group_1', 'EntryOne'],
      ['scope_beta', '__flight_instantiate_group_2', 'DependencyTwo'],
      ['scope_alpha', '__flight_instantiate_group_3', 'EntryTwo'],
    ]);
    expect(first.phases[1].invocations.map(invocationSummary)).toEqual([
      ['scope_beta', '__flight_evaluate_group_0', 'DependencyOne'],
      ['scope_alpha', '__flight_evaluate_group_1', 'EntryOne'],
      ['scope_beta', '__flight_evaluate_group_2', 'DependencyTwo'],
      ['scope_alpha', '__flight_evaluate_group_3', 'EntryTwo'],
    ]);
    expect(first.phases[0].invocations[0]).toMatchObject({
      crate: { cargoName: 'scope-beta', packageName: '@scope/beta', rustName: 'scope_beta' },
      groupIndex: 0,
      locator: { modulePath: [], visibility: 'public-doc-hidden' },
      signature: { parameters: [], result: 'Result<(), FlightModuleEvaluationError>' },
    });
    expect(first.modules[0]?.lifecycle).toEqual({
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
    });
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });

  it('keeps same-crate SCC order and excludes type-only linked modules from executable hooks', () => {
    const first = identity('@scope/math', 'first');
    const second = identity('@scope/math', 'second');
    const types = identity('@scope/types', 'types');
    const input = createInput({
      dependencies: [
        {
          evaluation: 'type-only',
          importer: first,
          specifier: './types.js',
          target: types,
        },
      ],
      entries: [first],
      groups: [{ cyclic: true, modules: [second, first] }],
      modules: [first, second, types],
    });

    const plan = createCompilerRustModuleEvaluationExecutionPlan(input);

    expect(plan.availability).toEqual({ outcome: 'available' });
    expect(plan.modules.map(({ module }) => module.name)).toEqual(['First', 'Second']);
    expect(plan.phases[0].invocations).toEqual([
      expect.objectContaining({
        crate: { cargoName: 'scope-math', packageName: '@scope/math', rustName: 'scope_math' },
        cyclic: true,
        groupIndex: 0,
        modules: [second, first],
      }),
    ]);
  });

  it('removes only authoritative entry refusals and blocks all invocations on every surviving refusal', () => {
    const entry = identity('@scope/math', 'entry');
    const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
      code: 'rust-module-evaluation-step-unrepresented',
      message: 'driver unavailable',
      module: entry,
      subject: `${formatIdentity(entry)}:["declarations",0]`,
    };
    const input = createInput({
      entries: [entry],
      extraRefusals: [refusal],
      groups: [group(entry)],
      modules: [entry],
    });

    const plan = createCompilerRustModuleEvaluationExecutionPlan(input);

    expect(plan.availability).toEqual({
      outcome: 'refused',
      refusals: [refusal],
      subjects: [refusal.subject],
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.modules).toHaveLength(1);
    expect(plan.phases).toEqual([
      { invocations: [], kind: 'instantiate' },
      { invocations: [], kind: 'evaluate' },
    ]);
  });

  it('refuses incomplete output without manufacturing entries, modules, or callable hooks', () => {
    const entry = identity('@scope/math', 'entry');
    const input = createInput({ entries: [entry], groups: [group(entry)], modules: [entry] });
    const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
      code: 'rust-module-evaluation-output-scope-incomplete',
      message: 'output is incomplete',
      subject: 'full-output',
    };
    input.representation = {
      kind: 'output-scope-incomplete',
      refusal: structuredClone(refusal) as Mutable<typeof refusal>,
      subjects: ['missing-module'],
    };

    const plan = createCompilerRustModuleEvaluationExecutionPlan(input);

    expect(plan.availability).toEqual({
      outcome: 'refused',
      refusals: [refusal],
      subjects: ['full-output', 'missing-module'],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.modules).toEqual([]);
    expect(plan.phases[0].invocations).toEqual([]);
    expect(plan.phases[1].invocations).toEqual([]);
  });

  it('represents an empty evaluation closure as an available no-op bootstrap', () => {
    const plan = createCompilerRustModuleEvaluationExecutionPlan(createInput({ entries: [], groups: [], modules: [] }));

    expect(plan).toMatchObject({
      availability: { outcome: 'available' },
      entries: [],
      modules: [],
    });
    expect(plan.phases).toEqual([
      { invocations: [], kind: 'instantiate' },
      { invocations: [], kind: 'evaluate' },
    ]);
  });

  it('preserves a cross-crate SCC refusal and emits no partial group hooks', () => {
    const alpha = identity('@scope/alpha', 'alpha');
    const beta = identity('@scope/beta', 'beta');
    const groupRefusal: CompilerRustModuleEvaluationRepresentationRefusal = {
      code: 'rust-module-evaluation-cross-crate-cycle-unrepresented',
      group: [alpha, beta],
      message: 'cross-crate coordination unavailable',
      subject: `${formatIdentity(alpha)} -> ${formatIdentity(beta)}`,
    };
    const input = createInput({
      entries: [alpha],
      extraRefusals: [groupRefusal],
      groupRepresentations: [{ kind: 'refused', refusal: groupRefusal }],
      groups: [{ cyclic: true, modules: [alpha, beta] }],
      modules: [alpha, beta],
    });

    const plan = createCompilerRustModuleEvaluationExecutionPlan(input);

    expect(plan.availability).toMatchObject({ outcome: 'refused', refusals: [groupRefusal] });
    expect(plan.phases.every(({ invocations }) => invocations.length === 0)).toBe(true);
  });

  it.each([
    ['missing', 'rust-module-evaluation-execution-entry-refusal-missing'],
    ['duplicate', 'rust-module-evaluation-execution-entry-refusal-duplicate'],
    ['non-entry', 'rust-module-evaluation-execution-entry-refusal-non-entry'],
  ] as const)('fails loudly on %s entry invocation evidence', (kind, expectedCode) => {
    const entry = identity('@scope/math', 'entry');
    const input = createInput({ entries: [entry], groups: [group(entry)], modules: [entry] });
    if (input.representation.kind !== 'plan') throw new Error('expected plan fixture');
    const refusals = input.representation.plan.eligibility.refusals;
    if (kind === 'missing') {
      input.representation.plan.eligibility.refusals = [];
      input.representation.plan.eligibility.outcome = 'eligible';
    } else if (kind === 'duplicate') {
      input.representation.plan.eligibility.refusals = structuredClone([
        ...refusals,
        refusals[0]!,
      ]) as typeof input.representation.plan.eligibility.refusals;
    } else {
      input.representation.plan.eligibility.refusals = structuredClone([
        ...refusals,
        createEntryRefusal(identity('@scope/math', 'not-an-entry')),
      ]) as typeof input.representation.plan.eligibility.refusals;
    }

    expect(captureFailure(input).code).toBe(expectedCode);
  });

  it('fails loudly on reserved lifecycle names and neutral projection reorderings', () => {
    const first = identity('@scope/math', 'first');
    const second = identity('@scope/math', 'second');
    const collision = createInput({ entries: [first], groups: [group(first)], modules: [first] });
    if (collision.representation.kind !== 'plan') throw new Error('expected plan fixture');
    collision.representation.plan.modules[0]!.locator.modulePath = ['__flight_reserved'];
    collision.representation.plan.entries[0]!.locator.modulePath = ['__flight_reserved'];

    expect(captureFailure(collision)).toMatchObject({
      code: 'rust-module-evaluation-execution-reserved-name-collision',
      subjects: [expect.stringContaining('__flight_reserved')],
    });

    const reordered = createInput({
      entries: [first],
      groups: [group(first), group(second)],
      modules: [first, second],
    });
    if (reordered.representation.kind !== 'plan') throw new Error('expected plan fixture');
    reordered.representation.plan.groups.reverse();

    expect(captureFailure(reordered).code).toBe('rust-module-evaluation-execution-projection-mismatch');
  });

  it('fails loudly when distinct source packages normalize to one owning crate', () => {
    const dashed = identity('@scope/a-b', 'dashed');
    const underscored = identity('@scope/a_b', 'underscored');
    const input = createInput({
      entries: [dashed, underscored],
      groups: [group(dashed), group(underscored)],
      modules: [dashed, underscored],
    });

    expect(captureFailure(input)).toMatchObject({
      code: 'rust-module-evaluation-execution-reserved-name-collision',
      subjects: ['@scope/a-b', '@scope/a_b'],
    });
  });
});

describe('isCompilerRustModuleEvaluationExecutionPlanningFailure', () => {
  it('recognizes complete execution planning failures and rejects lookalikes', () => {
    const entry = identity('@scope/math', 'entry');
    const input = createInput({ entries: [entry], groups: [group(entry)], modules: [entry] });
    if (input.representation.kind !== 'plan') throw new Error('expected plan fixture');
    input.representation.plan.eligibility.refusals = [];
    input.representation.plan.eligibility.outcome = 'eligible';
    const failure = captureFailure(input);

    expect(isCompilerRustModuleEvaluationExecutionPlanningFailure(failure)).toBe(true);
    expect(isCompilerRustModuleEvaluationExecutionPlanningFailure(new Error('plain'))).toBe(false);
    expect(isCompilerRustModuleEvaluationExecutionPlanningFailure({ ...failure })).toBe(false);
    expect(
      isCompilerRustModuleEvaluationExecutionPlanningFailure(
        Object.assign(new Error('empty subjects'), { ...failure, subjects: [] }),
      ),
    ).toBe(false);
  });
});

interface FixtureOptions {
  readonly dependencies?: readonly CompilerModuleEvaluationDependency[];
  readonly entries: readonly CompilerModuleIdentity[];
  readonly extraRefusals?: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
  readonly groupRepresentations?: readonly CompilerRustModuleEvaluationGroupRepresentation[];
  readonly groups: readonly CompilerModuleEvaluationGroup[];
  readonly modules: readonly CompilerModuleIdentity[];
  readonly runtimeCrate?: string;
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Mutable<Value[Key]> };

function captureFailure(
  input: Readonly<CompilerRustModuleEvaluationExecutionPlanInput>,
): CompilerRustModuleEvaluationExecutionPlanningFailure {
  try {
    createCompilerRustModuleEvaluationExecutionPlan(input);
  } catch (error) {
    if (isCompilerRustModuleEvaluationExecutionPlanningFailure(error)) return error;
    throw error;
  }
  throw new Error('expected Rust module-evaluation execution planning to fail');
}

function createEntryRefusal(
  module: Readonly<CompilerModuleIdentity>,
): CompilerRustModuleEvaluationRepresentationRefusal {
  return {
    code: 'rust-module-evaluation-entry-invocation-unbound',
    message: `entry ${formatIdentity(module)} is unbound`,
    module,
    subject: formatIdentity(module),
  };
}

function createInput(options: Readonly<FixtureOptions>): Mutable<CompilerRustModuleEvaluationExecutionPlanInput> {
  const semantics: CompilerModuleEvaluationPlan['semantics'] = {
    cycles: 'strongly-connected-live-environment',
    dependencyEvaluation: 'depth-first-request-order',
    importAccess: 'read-only-live-alias',
    localExportAccess: 'live-alias',
    phaseOrder: ['link', 'instantiate', 'evaluate-dependencies', 'evaluate'],
    temporalAccess: 'throw-reference-error',
    topLevelAwait: 'refuse',
    typeOnlyLinking: 'link-without-evaluation',
  };
  const neutral: CompilerModuleEvaluationPlan = {
    entries: options.entries,
    groups: options.groups,
    modules: options.modules.map((module) => ({
      bindings: [],
      dependencies: (options.dependencies ?? []).filter(
        (dependency) => formatIdentity(dependency.importer) === formatIdentity(module),
      ),
      module,
      steps: [],
    })),
    schema: 'flight-compiler-module-evaluation/1',
    semantics,
  };
  const modulePlans = options.modules.map((module) => ({
    bindings: [],
    dependencies: neutral.modules.find((candidate) => formatIdentity(candidate.module) === formatIdentity(module))!
      .dependencies,
    lifecycle: {
      evaluate: 'module-private-evaluate-once-function' as const,
      instantiate: 'module-private-instantiate-once-function' as const,
      state: 'module-private-lifecycle-state' as const,
      states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'] as const,
    },
    locator: locator(module),
    module,
    steps: [],
  }));
  const entryPlans = options.entries.map((module) => {
    const refusal = createEntryRefusal(module);
    return { invocation: { kind: 'unbound' as const, refusal }, locator: locator(module), module };
  });
  const refusals = [...entryPlans.map(({ invocation }) => invocation.refusal), ...(options.extraRefusals ?? [])];
  const representation: CompilerRustModuleEvaluationRepresentationPlan = {
    eligibility: {
      outcome: refusals.length === 0 ? 'eligible' : 'refused',
      refusals,
      scope: 'full-output',
    },
    entries: entryPlans,
    groups: options.groups.map((candidate, index) => ({
      cyclic: candidate.cyclic,
      modules: candidate.modules,
      representation:
        options.groupRepresentations?.[index] ??
        (candidate.cyclic
          ? { kind: 'same-crate-scc', packageName: candidate.modules[0]!.packageName }
          : { kind: 'single-module' }),
    })),
    modules: modulePlans,
    schema: 'flight-rust-module-evaluation-representation-plan/1',
    semantics,
  };
  return structuredClone({
    moduleEvaluation: neutral,
    representation: { kind: 'plan' as const, plan: representation },
    ...(options.runtimeCrate === undefined ? {} : { runtimeCrate: options.runtimeCrate }),
  }) as Mutable<CompilerRustModuleEvaluationExecutionPlanInput>;
}

function formatIdentity(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}/${module.source}#${module.name}`;
}

function group(module: Readonly<CompilerModuleIdentity>): CompilerModuleEvaluationGroup {
  return { cyclic: false, modules: [module] };
}

function identity(packageName: string, name: string): CompilerModuleIdentity {
  return {
    name: name
      .split('-')
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(''),
    packageName,
    source: `packages/${packageName.split('/').at(-1)}/src/${name}.ts`,
  };
}

function invocationSummary(
  invocation: Readonly<{
    crate: Readonly<{ rustName: string }>;
    locator: Readonly<{ spelling: string }>;
    modules: readonly CompilerModuleIdentity[];
  }>,
): readonly [string, string, string] {
  return [invocation.crate.rustName, invocation.locator.spelling, invocation.modules[0]!.name];
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((member) => isDeeplyFrozen(member, seen));
}

function locator(module: Readonly<CompilerModuleIdentity>) {
  return {
    filePath: `${module.packageName.split('/').at(-1)}/src/${module.name.toLowerCase()}.rs`,
    modulePath: [module.name.toLowerCase()],
    packageName: module.packageName,
  };
}
