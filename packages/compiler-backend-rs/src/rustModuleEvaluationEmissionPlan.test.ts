import type {
  CompilerModuleIdentity,
  CompilerRustModuleEvaluationEmissionFragment,
  CompilerRustModuleEvaluationEmissionPlanningFailure,
  CompilerRustModuleEvaluationExecutionPlan,
  CompilerRustModuleEvaluationRepresentationRefusal,
  CompilerRustPublicCrateIdentity,
} from '../../compiler-types/src/index.js';
import {
  createCompilerRustModuleEvaluationEmissionPlan,
  isCompilerRustModuleEvaluationEmissionPlanningFailure,
} from './rustModuleEvaluationEmissionPlan.js';

describe('createCompilerRustModuleEvaluationEmissionPlan', () => {
  it('preserves refused evidence and emits no lifecycle or group symbols', () => {
    const module = moduleFixture('@scope/alpha', 'entry', []);
    const executionPlan = createExecutionPlan({ groups: [{ modules: [module.identity] }], modules: [module] });
    const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
      code: 'rust-module-evaluation-step-unrepresented',
      message: 'phase body unavailable',
      module: module.identity,
      subject: formatIdentity(module.identity),
    };
    Reflect.set(executionPlan, 'availability', {
      outcome: 'refused',
      refusals: [refusal],
      subjects: [refusal.subject],
    });
    executionPlan.phases.forEach((phase) => Reflect.set(phase, 'invocations', []));
    const snapshot = structuredClone(executionPlan);

    const emission = createCompilerRustModuleEvaluationEmissionPlan(executionPlan);

    expect(emission.availability).toEqual({
      outcome: 'refused',
      refusals: [refusal],
      subjects: [refusal.subject],
    });
    expect(emission.fragments).toEqual([]);
    expect(emission).toMatchObject({
      executionSchema: 'flight-rust-module-evaluation-execution-plan/1',
      runtimeAbiSchema: 'flight-rust-runtime-abi/4',
      schema: 'flight-rust-module-evaluation-emission-plan/1',
    });
    expect(executionPlan).toEqual(snapshot);
    expect(isDeeplyFrozen(emission, new WeakSet())).toBe(true);
  });

  it('emits a nested module lifecycle and crate-root group bridges at exact locators', () => {
    const module = moduleFixture('@scope/alpha', 'entry', ['feature', 'entry']);
    const executionPlan = createExecutionPlan({
      groups: [{ modules: [module.identity] }],
      modules: [module],
      runtimeCrate: 'custom_runtime',
    });

    const emission = createCompilerRustModuleEvaluationEmissionPlan(executionPlan);
    const moduleFragment = findFragment(emission.fragments, '@scope/alpha', ['feature', 'entry']);
    const rootFragment = findFragment(emission.fragments, '@scope/alpha', []);

    expect(moduleFragment.locator).toEqual({
      crate: crateIdentity('@scope/alpha'),
      filePath: 'alpha/src/entry.rs',
      kind: 'module',
      modulePath: ['feature', 'entry'],
      packageName: '@scope/alpha',
    });
    expect(moduleFragment.symbols.map(({ kind }) => kind)).toEqual([
      'module-state',
      'module-lifecycle',
      'module-lifecycle',
    ]);
    expect(moduleFragment.symbols.slice(1).map((symbol) => ('phase' in symbol ? symbol.phase : undefined))).toEqual([
      'instantiate',
      'evaluate',
    ]);
    expect(moduleFragment.source).toContain('enum __FlightModuleEvaluationState {');
    expect(moduleFragment.source).toContain('Errored(custom_runtime::FlightModuleEvaluationError)');
    expect(moduleFragment.source).toContain(
      'static __flight_module_evaluation_state: std::sync::Mutex<__FlightModuleEvaluationState>',
    );
    expect(moduleFragment.source).toContain('std::sync::Mutex::new(__FlightModuleEvaluationState::Uninstantiated)');
    expect(moduleFragment.source).toContain('unwrap_or_else(|poisoned| poisoned.into_inner())');
    expect(moduleFragment.source).not.toContain('#[derive(Debug)]');
    expect(rootFragment.locator).toEqual({
      crate: crateIdentity('@scope/alpha'),
      kind: 'crate-root',
      modulePath: [],
      packageName: '@scope/alpha',
    });
    expect(rootFragment.source).toContain('crate::feature::entry::__flight_instantiate_once()?;');
    expect(rootFragment.source).toContain('crate::feature::entry::__flight_evaluate_once()?;');
  });

  it('composes a root module lifecycle with every same-crate group hook exactly once', () => {
    const root = moduleFixture('@scope/alpha', 'root', []);
    const nested = moduleFixture('@scope/alpha', 'nested', ['nested']);
    const executionPlan = createExecutionPlan({
      groups: [{ modules: [root.identity] }, { modules: [nested.identity] }],
      modules: [root, nested],
    });

    const emission = createCompilerRustModuleEvaluationEmissionPlan(executionPlan);
    const rootFragment = findFragment(emission.fragments, '@scope/alpha', []);

    expect(emission.fragments).toHaveLength(2);
    expect(rootFragment.locator).toEqual({
      crate: crateIdentity('@scope/alpha'),
      filePath: 'alpha/src/root.rs',
      kind: 'crate-root',
      modulePath: [],
      packageName: '@scope/alpha',
    });
    for (const spelling of [
      '__flight_instantiate_group_0',
      '__flight_instantiate_group_1',
      '__flight_evaluate_group_0',
      '__flight_evaluate_group_1',
    ]) {
      expect(countText(rootFragment.source, `pub fn ${spelling}()`)).toBe(1);
    }
    expect(countText(rootFragment.source, 'enum __FlightModuleEvaluationState {')).toBe(1);
    expect(rootFragment.source).toContain('crate::__flight_instantiate_once()?;');
    expect(rootFragment.source).toContain('crate::nested::__flight_evaluate_once()?;');
    expect(rootFragment.symbols.filter(({ kind }) => kind === 'group-lifecycle').map(groupSymbolSummary)).toEqual([
      ['instantiate', 0],
      ['instantiate', 1],
      ['evaluate', 0],
      ['evaluate', 1],
    ]);
  });

  it('keeps global group indices when crates are interleaved and emits no per-crate initializer', () => {
    const alphaOne = moduleFixture('@scope/alpha', 'alpha-one', ['alpha_one']);
    const alphaTwo = moduleFixture('@scope/alpha', 'alpha-two', ['alpha_two']);
    const betaOne = moduleFixture('@scope/beta', 'beta-one', ['beta_one']);
    const betaTwo = moduleFixture('@scope/beta', 'beta-two', ['beta_two']);
    const executionPlan = createExecutionPlan({
      groups: [
        { modules: [betaOne.identity] },
        { modules: [alphaOne.identity] },
        { modules: [betaTwo.identity] },
        { modules: [alphaTwo.identity] },
      ],
      modules: [alphaOne, alphaTwo, betaOne, betaTwo],
    });

    const emission = createCompilerRustModuleEvaluationEmissionPlan(executionPlan);
    const alphaRoot = findFragment(emission.fragments, '@scope/alpha', []);
    const betaRoot = findFragment(emission.fragments, '@scope/beta', []);

    expect(alphaRoot.symbols.filter(({ kind }) => kind === 'group-lifecycle').map(groupSymbolSummary)).toEqual([
      ['instantiate', 1],
      ['instantiate', 3],
      ['evaluate', 1],
      ['evaluate', 3],
    ]);
    expect(betaRoot.symbols.filter(({ kind }) => kind === 'group-lifecycle').map(groupSymbolSummary)).toEqual([
      ['instantiate', 0],
      ['instantiate', 2],
      ['evaluate', 0],
      ['evaluate', 2],
    ]);
    expect(emission.fragments.every(({ source }) => !source.includes('eager') && !source.includes('initializer'))).toBe(
      true,
    );
  });

  it('uses authoritative same-crate cyclic module order without dependency recursion', () => {
    const first = moduleFixture('@scope/alpha', 'first', ['first']);
    const second = moduleFixture('@scope/alpha', 'second', ['second']);
    const executionPlan = createExecutionPlan({
      groups: [{ cyclic: true, modules: [second.identity, first.identity] }],
      modules: [first, second],
    });

    const source = findFragment(
      createCompilerRustModuleEvaluationEmissionPlan(executionPlan).fragments,
      '@scope/alpha',
      [],
    ).source;

    expect(source.indexOf('crate::second::__flight_instantiate_once()?;')).toBeLessThan(
      source.indexOf('crate::first::__flight_instantiate_once()?;'),
    );
    expect(source.indexOf('crate::second::__flight_evaluate_once()?;')).toBeLessThan(
      source.indexOf('crate::first::__flight_evaluate_once()?;'),
    );
  });

  it('emits cached success, cached first-error, and guard-free reentrancy paths', () => {
    const module = moduleFixture('@scope/alpha', 'entry', ['entry']);
    const source = findFragment(
      createCompilerRustModuleEvaluationEmissionPlan(
        createExecutionPlan({ groups: [{ modules: [module.identity] }], modules: [module] }),
      ).fragments,
      '@scope/alpha',
      ['entry'],
    ).source;

    expect(source).toContain(
      'pub(crate) fn __flight_instantiate_once() -> std::result::Result<(), flight_runtime::FlightModuleEvaluationError>',
    );
    expect(source).toContain(
      'pub(crate) fn __flight_evaluate_once() -> std::result::Result<(), flight_runtime::FlightModuleEvaluationError> {\n  __flight_instantiate_once()?;',
    );
    expect(source).toContain(
      '__FlightModuleEvaluationState::Instantiated | __FlightModuleEvaluationState::Evaluated => return Ok(())',
    );
    expect(source).toContain('__FlightModuleEvaluationState::Evaluated => return Ok(())');
    expect(source).toContain('*state = __FlightModuleEvaluationState::Errored(error.clone());\n      Err(error)');
    expect(source).toMatch(
      /std::mem::drop\(state\);\n      return Err\(flight_runtime::module_evaluation_reentrancy_error\(\)\);/,
    );
    expect(
      countText(source, 'let result: std::result::Result<(), flight_runtime::FlightModuleEvaluationError> = Ok(());'),
    ).toBe(2);
    expect(source).not.toContain('.unwrap()');
  });

  it('is deterministic, deeply frozen, and leaves its input untouched', () => {
    const zeta = moduleFixture('@scope/zeta', 'zeta', ['zeta']);
    const alpha = moduleFixture('@scope/alpha', 'alpha', ['alpha']);
    const executionPlan = createExecutionPlan({
      groups: [{ modules: [zeta.identity] }, { modules: [alpha.identity] }],
      modules: [zeta, alpha],
    });
    const snapshot = structuredClone(executionPlan);

    const first = createCompilerRustModuleEvaluationEmissionPlan(executionPlan);
    const repeat = createCompilerRustModuleEvaluationEmissionPlan(executionPlan);

    expect(first).toEqual(repeat);
    expect(first.fragments.map(({ locator }) => locator.packageName)).toEqual([
      '@scope/alpha',
      '@scope/alpha',
      '@scope/zeta',
      '@scope/zeta',
    ]);
    expect(executionPlan).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });

  it.each([
    ['schema', (plan: CompilerRustModuleEvaluationExecutionPlan) => Reflect.set(plan, 'schema', 'stale/1')],
    [
      'semantics',
      (plan: CompilerRustModuleEvaluationExecutionPlan) => Reflect.set(plan.semantics, 'reentrancy', 'allow'),
    ],
    [
      'lifecycle spelling',
      (plan: CompilerRustModuleEvaluationExecutionPlan) =>
        Reflect.set(plan.modules[0]!.lifecycle.evaluate, 'spelling', '__flight_stale'),
    ],
    [
      'group signature',
      (plan: CompilerRustModuleEvaluationExecutionPlan) =>
        Reflect.set(plan.phases[0].invocations[0]!.signature, 'result', 'Result<(), StaleError>'),
    ],
    [
      'missing group module',
      (plan: CompilerRustModuleEvaluationExecutionPlan) => Reflect.set(plan.phases[1].invocations[0]!, 'modules', []),
    ],
    [
      'refused hooks',
      (plan: CompilerRustModuleEvaluationExecutionPlan) =>
        Reflect.set(plan, 'availability', {
          outcome: 'refused',
          refusals: [
            {
              code: 'rust-module-evaluation-step-unrepresented',
              message: 'unavailable',
              subject: 'module',
            },
          ],
          subjects: ['module'],
        }),
    ],
  ] as const)('rejects malformed or stale execution %s', (_name, corrupt) => {
    const module = moduleFixture('@scope/alpha', 'entry', ['entry']);
    const executionPlan = createExecutionPlan({ groups: [{ modules: [module.identity] }], modules: [module] });
    corrupt(executionPlan);

    expect(captureFailure(executionPlan)).toMatchObject({
      kind: 'rust-module-evaluation-emission-planning',
    });
  });

  it('rejects duplicate module destinations even when identities differ', () => {
    const first = moduleFixture('@scope/alpha', 'first', ['shared']);
    const second = moduleFixture('@scope/alpha', 'second', ['shared']);
    const executionPlan = createExecutionPlan({
      groups: [{ modules: [first.identity] }, { modules: [second.identity] }],
      modules: [first, second],
    });

    expect(captureFailure(executionPlan).code).toBe('rust-module-evaluation-emission-projection-mismatch');
  });
});

describe('isCompilerRustModuleEvaluationEmissionPlanningFailure', () => {
  it('recognizes complete failures and rejects lookalikes', () => {
    const module = moduleFixture('@scope/alpha', 'entry', ['entry']);
    const executionPlan = createExecutionPlan({ groups: [{ modules: [module.identity] }], modules: [module] });
    Reflect.set(executionPlan, 'schema', 'stale/1');
    const failure = captureFailure(executionPlan);

    expect(isCompilerRustModuleEvaluationEmissionPlanningFailure(failure)).toBe(true);
    expect(isCompilerRustModuleEvaluationEmissionPlanningFailure(new Error('plain'))).toBe(false);
    expect(isCompilerRustModuleEvaluationEmissionPlanningFailure({ ...failure })).toBe(false);
  });
});

interface ModuleFixture {
  readonly identity: CompilerModuleIdentity;
  readonly locator: Readonly<{ filePath: string; modulePath: readonly string[]; packageName: string }>;
}

interface GroupFixture {
  readonly cyclic?: boolean;
  readonly modules: readonly CompilerModuleIdentity[];
}

interface ExecutionFixtureOptions {
  readonly groups: readonly GroupFixture[];
  readonly modules: readonly ModuleFixture[];
  readonly runtimeCrate?: string;
}

function createExecutionPlan(options: Readonly<ExecutionFixtureOptions>): CompilerRustModuleEvaluationExecutionPlan {
  const groupIndexByModule = new Map<string, number>();
  options.groups.forEach((group, groupIndex) => {
    group.modules.forEach((module) => groupIndexByModule.set(formatIdentity(module), groupIndex));
  });
  const modules = options.modules.map((module) => ({
    crate: crateIdentity(module.identity.packageName),
    groupIndex: groupIndexByModule.get(formatIdentity(module.identity))!,
    lifecycle: {
      evaluate: {
        signature: { parameters: [] as const, result: 'Result<(), FlightModuleEvaluationError>' as const },
        spelling: '__flight_evaluate_once' as const,
        visibility: 'crate' as const,
      },
      instantiate: {
        signature: { parameters: [] as const, result: 'Result<(), FlightModuleEvaluationError>' as const },
        spelling: '__flight_instantiate_once' as const,
        visibility: 'crate' as const,
      },
      state: {
        spelling: '__flight_module_evaluation_state' as const,
        states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'] as const,
        visibility: 'private' as const,
      },
    },
    locator: module.locator,
    module: module.identity,
  }));
  const createInvocations = (phase: 'evaluate' | 'instantiate') =>
    options.groups.map((group, groupIndex) => ({
      crate: crateIdentity(group.modules[0]!.packageName),
      cyclic: group.cyclic ?? false,
      groupIndex,
      locator: {
        modulePath: [] as const,
        spelling: `__flight_${phase}_group_${groupIndex}` as const,
        visibility: 'public-doc-hidden' as const,
      },
      modules: group.modules,
      signature: { parameters: [] as const, result: 'Result<(), FlightModuleEvaluationError>' as const },
    }));
  return {
    availability: { outcome: 'available' },
    entries: [],
    error: {
      crateName: options.runtimeCrate ?? 'flight_runtime',
      result: 'Result<(), FlightModuleEvaluationError>',
      targetName: 'FlightModuleEvaluationError',
    },
    modules,
    phases: [
      { invocations: createInvocations('instantiate'), kind: 'instantiate' },
      { invocations: createInvocations('evaluate'), kind: 'evaluate' },
    ],
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

function captureFailure(
  executionPlan: Readonly<CompilerRustModuleEvaluationExecutionPlan>,
): CompilerRustModuleEvaluationEmissionPlanningFailure {
  try {
    createCompilerRustModuleEvaluationEmissionPlan(executionPlan);
  } catch (error) {
    if (isCompilerRustModuleEvaluationEmissionPlanningFailure(error)) return error;
    throw error;
  }
  throw new Error('expected Rust module-evaluation emission planning to fail');
}

function crateIdentity(packageName: string): CompilerRustPublicCrateIdentity {
  const cargoName = packageName.replace(/^@/, '').replaceAll('/', '-');
  return { cargoName, packageName, rustName: cargoName.replaceAll('-', '_') };
}

function moduleFixture(packageName: string, name: string, modulePath: readonly string[]): ModuleFixture {
  const packageDirectory = packageName.split('/').at(-1)!;
  const rustFileName = name.replaceAll('-', '_');
  return {
    identity: {
      name: name
        .split('-')
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(''),
      packageName,
      source: `packages/${packageDirectory}/src/${name}.ts`,
    },
    locator: {
      filePath: `${packageDirectory}/src/${rustFileName}.rs`,
      modulePath,
      packageName,
    },
  };
}

function findFragment(
  fragments: readonly CompilerRustModuleEvaluationEmissionFragment[],
  packageName: string,
  modulePath: readonly string[],
): CompilerRustModuleEvaluationEmissionFragment {
  const fragment = fragments.find(
    ({ locator }) =>
      locator.packageName === packageName && JSON.stringify(locator.modulePath) === JSON.stringify(modulePath),
  );
  if (!fragment) throw new Error(`missing fragment ${packageName}:${modulePath.join('::')}`);
  return fragment;
}

function formatIdentity(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}/${module.source}#${module.name}`;
}

function groupSymbolSummary(
  symbol: CompilerRustModuleEvaluationEmissionFragment['symbols'][number],
): readonly ['evaluate' | 'instantiate', number] {
  if (symbol.kind !== 'group-lifecycle') throw new Error('expected group lifecycle symbol');
  return [symbol.phase, symbol.groupIndex];
}

function countText(source: string, text: string): number {
  return source.split(text).length - 1;
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((member) => isDeeplyFrozen(member, seen));
}
