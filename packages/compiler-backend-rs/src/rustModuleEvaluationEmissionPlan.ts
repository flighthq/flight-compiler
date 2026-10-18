import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerRustModuleEvaluationEmissionFragment,
  CompilerRustModuleEvaluationEmissionLocator,
  CompilerRustModuleEvaluationEmissionPlan,
  CompilerRustModuleEvaluationEmissionPlanningFailure,
  CompilerRustModuleEvaluationEmissionPlanningFailureCode,
  CompilerRustModuleEvaluationEmissionSymbol,
  CompilerRustModuleEvaluationExecutionModulePlan,
  CompilerRustModuleEvaluationExecutionPlan,
  CompilerRustModuleEvaluationInvocationPlan,
  CompilerRustModuleEvaluationRepresentationRefusal,
  CompilerRustPublicCrateIdentity,
} from '../../compiler-types/src/index.js';

/**
 * Emits independently addressable Rust module-evaluation fragments without choosing or mutating a
 * source tree. The execution plan remains the sole authority for group ownership and call order.
 */
export function createCompilerRustModuleEvaluationEmissionPlan(
  executionPlan: Readonly<CompilerRustModuleEvaluationExecutionPlan>,
): CompilerRustModuleEvaluationEmissionPlan {
  assertRustModuleEvaluationEmissionExecutionPlan(executionPlan);
  if (executionPlan.availability.outcome === 'refused') {
    return cloneAndFreezeRustModuleEvaluationEmissionValue({
      availability: executionPlan.availability,
      error: executionPlan.error,
      executionSchema: executionPlan.schema,
      fragments: [],
      runtimeAbiSchema: executionPlan.runtimeAbiSchema,
      schema: 'flight-rust-module-evaluation-emission-plan/1',
    });
  }

  const builders = createRustModuleEvaluationEmissionBuilders(executionPlan.modules, executionPlan.error.crateName);
  const moduleByIdentity = new Map(
    executionPlan.modules.map((module) => [getRustModuleEvaluationEmissionIdentityKey(module.module), module]),
  );
  for (const phase of executionPlan.phases) {
    for (const invocation of phase.invocations) {
      const builder = getOrCreateRustModuleEvaluationCrateRootBuilder(builders, invocation.crate);
      builder.sources.push(
        emitRustModuleEvaluationGroupSource(invocation, phase.kind, moduleByIdentity, executionPlan.error.crateName),
      );
      builder.symbols.push({
        groupIndex: invocation.groupIndex,
        kind: 'group-lifecycle',
        modules: invocation.modules,
        phase: phase.kind,
        signature: invocation.signature.result,
        spelling: invocation.locator.spelling,
        visibility: invocation.locator.visibility,
      });
    }
  }

  const fragments = [...builders.values()]
    .sort((left, right) =>
      compareTextCodeUnits(
        getRustModuleEvaluationEmissionLocatorKey(left.locator),
        getRustModuleEvaluationEmissionLocatorKey(right.locator),
      ),
    )
    .map(
      (builder): CompilerRustModuleEvaluationEmissionFragment => ({
        locator: builder.locator,
        source: `${builder.sources.join('\n\n')}\n`,
        symbols: builder.symbols,
      }),
    );
  return cloneAndFreezeRustModuleEvaluationEmissionValue({
    availability: executionPlan.availability,
    error: executionPlan.error,
    executionSchema: executionPlan.schema,
    fragments,
    runtimeAbiSchema: executionPlan.runtimeAbiSchema,
    schema: 'flight-rust-module-evaluation-emission-plan/1',
  });
}

export function isCompilerRustModuleEvaluationEmissionPlanningFailure(
  value: unknown,
): value is CompilerRustModuleEvaluationEmissionPlanningFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'rust-module-evaluation-emission-planning' &&
    'code' in value &&
    rustModuleEvaluationEmissionPlanningFailureCodes.has(
      value.code as CompilerRustModuleEvaluationEmissionPlanningFailureCode,
    ) &&
    'subjects' in value &&
    Array.isArray(value.subjects) &&
    value.subjects.length > 0 &&
    value.subjects.every((subject) => typeof subject === 'string' && subject.length > 0)
  );
}

interface RustModuleEvaluationEmissionBuilder {
  locator: CompilerRustModuleEvaluationEmissionLocator;
  readonly sources: string[];
  readonly symbols: CompilerRustModuleEvaluationEmissionSymbol[];
}

function assertRustModuleEvaluationEmissionExecutionPlan(
  executionPlan: Readonly<CompilerRustModuleEvaluationExecutionPlan>,
): void {
  if (
    !executionPlan ||
    typeof executionPlan !== 'object' ||
    executionPlan.schema !== 'flight-rust-module-evaluation-execution-plan/1' ||
    executionPlan.publicBindingSchema !== 'flight-rust-public-binding-plan/3' ||
    executionPlan.representationSchema !== 'flight-rust-module-evaluation-representation-plan/1' ||
    executionPlan.runtimeAbiSchema !== 'flight-rust-runtime-abi/4' ||
    !areRustModuleEvaluationEmissionValuesEqual(executionPlan.semantics, rustModuleEvaluationEmissionSemantics) ||
    !isRustModuleEvaluationEmissionError(executionPlan.error) ||
    !Array.isArray(executionPlan.entries) ||
    !Array.isArray(executionPlan.modules) ||
    !Array.isArray(executionPlan.phases) ||
    executionPlan.phases.length !== 2
  ) {
    throw createRustModuleEvaluationEmissionPlanningFailure(
      'rust-module-evaluation-emission-invalid-input',
      ['executionPlan'],
      'Rust module-evaluation emission requires the exact execution-plan schema and semantics',
    );
  }
  assertRustModuleEvaluationEmissionAvailability(executionPlan);
  const modules = assertRustModuleEvaluationEmissionModules(executionPlan.modules);
  assertRustModuleEvaluationEmissionEntries(executionPlan.entries, modules);
  assertRustModuleEvaluationEmissionPhases(executionPlan, modules);
}

function assertRustModuleEvaluationEmissionAvailability(
  executionPlan: Readonly<CompilerRustModuleEvaluationExecutionPlan>,
): void {
  const availability = executionPlan.availability;
  if (!availability || typeof availability !== 'object') {
    throw createRustModuleEvaluationEmissionInvalidInput(['availability']);
  }
  if (availability.outcome === 'available') return;
  if (
    availability.outcome !== 'refused' ||
    !Array.isArray(availability.refusals) ||
    availability.refusals.length === 0 ||
    !availability.refusals.every(isRustModuleEvaluationEmissionRefusal) ||
    !isRustModuleEvaluationEmissionSubjectSequence(availability.subjects)
  ) {
    throw createRustModuleEvaluationEmissionInvalidInput(['availability']);
  }
}

function assertRustModuleEvaluationEmissionModules(
  modules: readonly Readonly<CompilerRustModuleEvaluationExecutionModulePlan>[],
): ReadonlyMap<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>> {
  const moduleByIdentity = new Map<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>>();
  const moduleByLocator = new Map<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>>();
  for (const [index, module] of modules.entries()) {
    const subject = `modules[${String(index)}]`;
    if (
      !module ||
      typeof module !== 'object' ||
      !isRustModuleEvaluationEmissionIdentity(module.module) ||
      !isRustModuleEvaluationEmissionCrate(module.crate) ||
      module.crate.packageName !== module.module.packageName ||
      !Number.isSafeInteger(module.groupIndex) ||
      module.groupIndex < 0 ||
      !isRustModuleEvaluationEmissionLocator(module.locator) ||
      module.locator.packageName !== module.module.packageName ||
      !areRustModuleEvaluationEmissionValuesEqual(module.lifecycle, rustModuleEvaluationEmissionLifecycle)
    ) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    }
    const identityKey = getRustModuleEvaluationEmissionIdentityKey(module.module);
    const locatorKey = getRustModuleEvaluationEmissionModuleLocatorKey(module);
    if (moduleByIdentity.has(identityKey) || moduleByLocator.has(locatorKey)) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    }
    moduleByIdentity.set(identityKey, module);
    moduleByLocator.set(locatorKey, module);
  }
  return moduleByIdentity;
}

function assertRustModuleEvaluationEmissionEntries(
  entries: Readonly<CompilerRustModuleEvaluationExecutionPlan>['entries'],
  moduleByIdentity: ReadonlyMap<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>>,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const subject = `entries[${String(index)}]`;
    if (
      !entry ||
      typeof entry !== 'object' ||
      !isRustModuleEvaluationEmissionIdentity(entry.module) ||
      !isRustModuleEvaluationEmissionCrate(entry.crate) ||
      !isRustModuleEvaluationEmissionLocator(entry.locator) ||
      !Number.isSafeInteger(entry.groupIndex) ||
      entry.groupIndex < 0
    ) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    }
    const key = getRustModuleEvaluationEmissionIdentityKey(entry.module);
    const module = moduleByIdentity.get(key);
    if (
      seen.has(key) ||
      !module ||
      entry.groupIndex !== module.groupIndex ||
      !areRustModuleEvaluationEmissionValuesEqual(entry.crate, module.crate) ||
      !areRustModuleEvaluationEmissionValuesEqual(entry.locator, module.locator)
    ) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    }
    seen.add(key);
  }
}

function assertRustModuleEvaluationEmissionPhases(
  executionPlan: Readonly<CompilerRustModuleEvaluationExecutionPlan>,
  moduleByIdentity: ReadonlyMap<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>>,
): void {
  const instantiate = executionPlan.phases[0];
  const evaluate = executionPlan.phases[1];
  if (
    !instantiate ||
    !evaluate ||
    instantiate.kind !== 'instantiate' ||
    evaluate.kind !== 'evaluate' ||
    !Array.isArray(instantiate.invocations) ||
    !Array.isArray(evaluate.invocations)
  ) {
    throw createRustModuleEvaluationEmissionProjectionMismatch(['phases']);
  }
  if (executionPlan.availability.outcome === 'refused') {
    if (instantiate.invocations.length !== 0 || evaluate.invocations.length !== 0) {
      throw createRustModuleEvaluationEmissionProjectionMismatch(['availability', 'phases']);
    }
    return;
  }
  if (instantiate.invocations.length !== evaluate.invocations.length) {
    throw createRustModuleEvaluationEmissionProjectionMismatch(['phases']);
  }
  const groupedModuleKeys = new Set<string>();
  for (const [index, instantiateInvocation] of instantiate.invocations.entries()) {
    const evaluateInvocation = evaluate.invocations[index]!;
    assertRustModuleEvaluationEmissionInvocation(
      instantiateInvocation,
      'instantiate',
      index,
      moduleByIdentity,
      groupedModuleKeys,
    );
    assertRustModuleEvaluationEmissionInvocation(evaluateInvocation, 'evaluate', index, moduleByIdentity);
    if (
      !areRustModuleEvaluationEmissionValuesEqual(
        createRustModuleEvaluationEmissionInvocationProjection(instantiateInvocation),
        createRustModuleEvaluationEmissionInvocationProjection(evaluateInvocation),
      )
    ) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([`phases[1].invocations[${String(index)}]`]);
    }
  }
  if (
    groupedModuleKeys.size !== moduleByIdentity.size ||
    [...moduleByIdentity.keys()].some((key) => !groupedModuleKeys.has(key))
  ) {
    throw createRustModuleEvaluationEmissionProjectionMismatch(['modules', 'phases']);
  }
}

function assertRustModuleEvaluationEmissionInvocation(
  invocation: Readonly<CompilerRustModuleEvaluationInvocationPlan>,
  phase: 'evaluate' | 'instantiate',
  index: number,
  moduleByIdentity: ReadonlyMap<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>>,
  groupedModuleKeys?: Set<string>,
): void {
  const subject = `phases[${phase === 'instantiate' ? '0' : '1'}].invocations[${String(index)}]`;
  if (
    !invocation ||
    typeof invocation !== 'object' ||
    !isRustModuleEvaluationEmissionCrate(invocation.crate) ||
    typeof invocation.cyclic !== 'boolean' ||
    invocation.groupIndex !== index ||
    !invocation.locator ||
    typeof invocation.locator !== 'object' ||
    !Array.isArray(invocation.locator.modulePath) ||
    invocation.locator.modulePath.length !== 0 ||
    invocation.locator.spelling !== `__flight_${phase}_group_${String(index)}` ||
    invocation.locator.visibility !== 'public-doc-hidden' ||
    !areRustModuleEvaluationEmissionValuesEqual(invocation.signature, rustModuleEvaluationEmissionSignature) ||
    !Array.isArray(invocation.modules) ||
    invocation.modules.length === 0
  ) {
    throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
  }
  const invocationKeys = new Set<string>();
  for (const identity of invocation.modules) {
    if (!isRustModuleEvaluationEmissionIdentity(identity)) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    }
    const key = getRustModuleEvaluationEmissionIdentityKey(identity);
    const module = moduleByIdentity.get(key);
    if (
      invocationKeys.has(key) ||
      !module ||
      module.groupIndex !== invocation.groupIndex ||
      !areRustModuleEvaluationEmissionValuesEqual(module.crate, invocation.crate)
    ) {
      throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    }
    invocationKeys.add(key);
    if (groupedModuleKeys?.has(key)) throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
    groupedModuleKeys?.add(key);
  }
  const plannedGroupKeys = [...moduleByIdentity.entries()]
    .filter(([, module]) => module.groupIndex === invocation.groupIndex)
    .map(([key]) => key);
  if (plannedGroupKeys.length !== invocationKeys.size || plannedGroupKeys.some((key) => !invocationKeys.has(key))) {
    throw createRustModuleEvaluationEmissionProjectionMismatch([subject]);
  }
}

function createRustModuleEvaluationEmissionInvocationProjection(
  invocation: Readonly<CompilerRustModuleEvaluationInvocationPlan>,
): unknown {
  return {
    crate: invocation.crate,
    cyclic: invocation.cyclic,
    groupIndex: invocation.groupIndex,
    modulePath: invocation.locator.modulePath,
    modules: invocation.modules,
    signature: invocation.signature,
    visibility: invocation.locator.visibility,
  };
}

function createRustModuleEvaluationEmissionBuilders(
  modules: readonly Readonly<CompilerRustModuleEvaluationExecutionModulePlan>[],
  runtimeCrate: string,
): Map<string, RustModuleEvaluationEmissionBuilder> {
  const builders = new Map<string, RustModuleEvaluationEmissionBuilder>();
  for (const module of modules) {
    const root = module.locator.modulePath.length === 0;
    const locator: CompilerRustModuleEvaluationEmissionLocator = root
      ? {
          crate: module.crate,
          filePath: module.locator.filePath,
          kind: 'crate-root',
          modulePath: [],
          packageName: module.locator.packageName,
        }
      : {
          crate: module.crate,
          filePath: module.locator.filePath,
          kind: 'module',
          modulePath: module.locator.modulePath as readonly [string, ...string[]],
          packageName: module.locator.packageName,
        };
    const builder: RustModuleEvaluationEmissionBuilder = {
      locator,
      sources: [emitRustModuleEvaluationLifecycleSource(module, runtimeCrate)],
      symbols: createRustModuleEvaluationEmissionModuleSymbols(module),
    };
    builders.set(getRustModuleEvaluationEmissionLocatorKey(locator), builder);
  }
  return builders;
}

function getOrCreateRustModuleEvaluationCrateRootBuilder(
  builders: Map<string, RustModuleEvaluationEmissionBuilder>,
  crate: Readonly<CompilerRustPublicCrateIdentity>,
): RustModuleEvaluationEmissionBuilder {
  const locator: CompilerRustModuleEvaluationEmissionLocator = {
    crate,
    kind: 'crate-root',
    modulePath: [],
    packageName: crate.packageName,
  };
  const key = getRustModuleEvaluationEmissionLocatorKey(locator);
  const existing = builders.get(key);
  if (existing) return existing;
  const builder: RustModuleEvaluationEmissionBuilder = { locator, sources: [], symbols: [] };
  builders.set(key, builder);
  return builder;
}

function createRustModuleEvaluationEmissionModuleSymbols(
  module: Readonly<CompilerRustModuleEvaluationExecutionModulePlan>,
): CompilerRustModuleEvaluationEmissionSymbol[] {
  return [
    {
      enumSpelling: '__FlightModuleEvaluationState',
      kind: 'module-state',
      module: module.module,
      spelling: module.lifecycle.state.spelling,
      states: ['Uninstantiated', 'Instantiating', 'Instantiated', 'Evaluating', 'Evaluated', 'Errored'],
      visibility: module.lifecycle.state.visibility,
    },
    {
      kind: 'module-lifecycle',
      module: module.module,
      phase: 'instantiate',
      signature: module.lifecycle.instantiate.signature.result,
      spelling: module.lifecycle.instantiate.spelling,
      visibility: module.lifecycle.instantiate.visibility,
    },
    {
      kind: 'module-lifecycle',
      module: module.module,
      phase: 'evaluate',
      signature: module.lifecycle.evaluate.signature.result,
      spelling: module.lifecycle.evaluate.spelling,
      visibility: module.lifecycle.evaluate.visibility,
    },
  ];
}

function emitRustModuleEvaluationLifecycleSource(
  module: Readonly<CompilerRustModuleEvaluationExecutionModulePlan>,
  runtimeCrate: string,
): string {
  const errorType = `${runtimeCrate}::FlightModuleEvaluationError`;
  const state = module.lifecycle.state.spelling;
  const instantiate = module.lifecycle.instantiate.spelling;
  const evaluate = module.lifecycle.evaluate.spelling;
  return [
    'enum __FlightModuleEvaluationState {',
    '  Uninstantiated,',
    '  Instantiating,',
    '  Instantiated,',
    '  Evaluating,',
    '  Evaluated,',
    `  Errored(${errorType}),`,
    '}',
    '',
    '#[allow(non_upper_case_globals)]',
    `static ${state}: std::sync::Mutex<__FlightModuleEvaluationState> =`,
    '  std::sync::Mutex::new(__FlightModuleEvaluationState::Uninstantiated);',
    '',
    ...emitRustModuleEvaluationPhaseSource({
      errorType,
      phase: 'instantiate',
      reentrancyFunction: `${runtimeCrate}::module_evaluation_reentrancy_error`,
      spelling: instantiate,
      state,
    }),
    '',
    ...emitRustModuleEvaluationPhaseSource({
      errorType,
      instantiateSpelling: instantiate,
      phase: 'evaluate',
      reentrancyFunction: `${runtimeCrate}::module_evaluation_reentrancy_error`,
      spelling: evaluate,
      state,
    }),
  ].join('\n');
}

interface RustModuleEvaluationPhaseSourceInput {
  readonly errorType: string;
  readonly instantiateSpelling?: '__flight_instantiate_once';
  readonly phase: 'evaluate' | 'instantiate';
  readonly reentrancyFunction: string;
  readonly spelling: '__flight_evaluate_once' | '__flight_instantiate_once';
  readonly state: '__flight_module_evaluation_state';
}

function emitRustModuleEvaluationPhaseSource(input: Readonly<RustModuleEvaluationPhaseSourceInput>): string[] {
  const transitional =
    input.phase === 'instantiate'
      ? '__FlightModuleEvaluationState::Instantiating | __FlightModuleEvaluationState::Evaluating'
      : '__FlightModuleEvaluationState::Evaluating | __FlightModuleEvaluationState::Instantiating';
  const cached =
    input.phase === 'instantiate'
      ? '__FlightModuleEvaluationState::Instantiated | __FlightModuleEvaluationState::Evaluated'
      : '__FlightModuleEvaluationState::Evaluated';
  const ready = input.phase === 'instantiate' ? '__FlightModuleEvaluationState::Uninstantiated' : '_';
  const transition = input.phase === 'instantiate' ? 'Instantiating' : 'Evaluating';
  const success = input.phase === 'instantiate' ? 'Instantiated' : 'Evaluated';
  return [
    `pub(crate) fn ${input.spelling}() -> std::result::Result<(), ${input.errorType}> {`,
    ...(input.instantiateSpelling ? [`  ${input.instantiateSpelling}()?;`] : []),
    `  let mut state = ${input.state}`,
    '    .lock()',
    '    .unwrap_or_else(|poisoned| poisoned.into_inner());',
    '  match &*state {',
    `    ${cached} => return Ok(()),`,
    `    ${transitional} => {`,
    '      std::mem::drop(state);',
    `      return Err(${input.reentrancyFunction}());`,
    '    }',
    '    __FlightModuleEvaluationState::Errored(error) => {',
    '      let error = error.clone();',
    '      std::mem::drop(state);',
    '      return Err(error);',
    '    }',
    `    ${ready} => {}`,
    '  }',
    `  *state = __FlightModuleEvaluationState::${transition};`,
    '  std::mem::drop(state);',
    `  let result: std::result::Result<(), ${input.errorType}> = Ok(());`,
    `  let mut state = ${input.state}`,
    '    .lock()',
    '    .unwrap_or_else(|poisoned| poisoned.into_inner());',
    '  match result {',
    '    Ok(()) => {',
    `      *state = __FlightModuleEvaluationState::${success};`,
    '      Ok(())',
    '    }',
    '    Err(error) => {',
    '      *state = __FlightModuleEvaluationState::Errored(error.clone());',
    '      Err(error)',
    '    }',
    '  }',
    '}',
  ];
}

function emitRustModuleEvaluationGroupSource(
  invocation: Readonly<CompilerRustModuleEvaluationInvocationPlan>,
  phase: 'evaluate' | 'instantiate',
  moduleByIdentity: ReadonlyMap<string, Readonly<CompilerRustModuleEvaluationExecutionModulePlan>>,
  runtimeCrate: string,
): string {
  const calls = invocation.modules.map((identity) => {
    const module = moduleByIdentity.get(getRustModuleEvaluationEmissionIdentityKey(identity))!;
    const spelling =
      phase === 'instantiate' ? module.lifecycle.instantiate.spelling : module.lifecycle.evaluate.spelling;
    return `  ${['crate', ...module.locator.modulePath, spelling].join('::')}()?;`;
  });
  return [
    '#[doc(hidden)]',
    `pub fn ${invocation.locator.spelling}() -> std::result::Result<(), ${runtimeCrate}::FlightModuleEvaluationError> {`,
    ...calls,
    '  Ok(())',
    '}',
  ].join('\n');
}

function isRustModuleEvaluationEmissionError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const error = value as Readonly<Record<string, unknown>>;
  return (
    typeof error.crateName === 'string' &&
    rustModuleEvaluationEmissionRustPath.test(error.crateName) &&
    error.result === 'Result<(), FlightModuleEvaluationError>' &&
    error.targetName === 'FlightModuleEvaluationError'
  );
}

function isRustModuleEvaluationEmissionCrate(value: unknown): value is CompilerRustPublicCrateIdentity {
  if (!value || typeof value !== 'object') return false;
  const crate = value as Readonly<Record<string, unknown>>;
  return (
    typeof crate.cargoName === 'string' &&
    crate.cargoName.length > 0 &&
    typeof crate.packageName === 'string' &&
    crate.packageName.length > 0 &&
    typeof crate.rustName === 'string' &&
    crate.rustName.length > 0 &&
    crate.rustName === crate.cargoName.replaceAll('-', '_')
  );
}

function isRustModuleEvaluationEmissionIdentity(value: unknown): value is CompilerModuleIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Readonly<Record<string, unknown>>;
  return (
    typeof identity.name === 'string' &&
    identity.name.length > 0 &&
    typeof identity.packageName === 'string' &&
    identity.packageName.length > 0 &&
    typeof identity.source === 'string' &&
    identity.source.length > 0
  );
}

function isRustModuleEvaluationEmissionLocator(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const locator = value as Readonly<Record<string, unknown>>;
  return (
    typeof locator.filePath === 'string' &&
    locator.filePath.length > 0 &&
    Array.isArray(locator.modulePath) &&
    locator.modulePath.every((segment) => typeof segment === 'string' && segment.length > 0) &&
    typeof locator.packageName === 'string' &&
    locator.packageName.length > 0
  );
}

function isRustModuleEvaluationEmissionRefusal(
  value: unknown,
): value is CompilerRustModuleEvaluationRepresentationRefusal {
  if (!value || typeof value !== 'object') return false;
  const refusal = value as Readonly<Record<string, unknown>>;
  return (
    typeof refusal.code === 'string' &&
    rustModuleEvaluationEmissionRefusalCodes.has(refusal.code) &&
    typeof refusal.message === 'string' &&
    refusal.message.length > 0 &&
    typeof refusal.subject === 'string' &&
    refusal.subject.length > 0
  );
}

function isRustModuleEvaluationEmissionSubjectSequence(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((subject) => typeof subject === 'string' && subject.length > 0) &&
    new Set(value).size === value.length &&
    value.every((subject, index) => index === 0 || compareTextCodeUnits(value[index - 1]!, subject) < 0)
  );
}

function getRustModuleEvaluationEmissionIdentityKey(module: Readonly<CompilerModuleIdentity>): string {
  return JSON.stringify([module.packageName, module.source, module.name]);
}

function getRustModuleEvaluationEmissionModuleLocatorKey(
  module: Readonly<CompilerRustModuleEvaluationExecutionModulePlan>,
): string {
  return JSON.stringify([module.crate.packageName, module.locator.modulePath]);
}

function getRustModuleEvaluationEmissionLocatorKey(
  locator: Readonly<CompilerRustModuleEvaluationEmissionLocator>,
): string {
  return JSON.stringify([locator.crate.packageName, locator.modulePath]);
}

function areRustModuleEvaluationEmissionValuesEqual(left: unknown, right: unknown): boolean {
  return normalizeCompilerStructuralValueCanonical(left) === normalizeCompilerStructuralValueCanonical(right);
}

function createRustModuleEvaluationEmissionInvalidInput(
  subjects: readonly string[],
): CompilerRustModuleEvaluationEmissionPlanningFailure {
  return createRustModuleEvaluationEmissionPlanningFailure(
    'rust-module-evaluation-emission-invalid-input',
    subjects,
    'Rust module-evaluation emission requires a complete execution plan',
  );
}

function createRustModuleEvaluationEmissionProjectionMismatch(
  subjects: readonly string[],
): CompilerRustModuleEvaluationEmissionPlanningFailure {
  return createRustModuleEvaluationEmissionPlanningFailure(
    'rust-module-evaluation-emission-projection-mismatch',
    subjects,
    'Rust module-evaluation execution plan is internally inconsistent',
  );
}

function createRustModuleEvaluationEmissionPlanningFailure(
  code: CompilerRustModuleEvaluationEmissionPlanningFailureCode,
  subjects: readonly string[],
  message: string,
): CompilerRustModuleEvaluationEmissionPlanningFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'rust-module-evaluation-emission-planning' as const,
    subjects: [...new Set(subjects)].sort(compareTextCodeUnits),
  });
  failure.name = 'CompilerRustModuleEvaluationEmissionPlanningError';
  return failure;
}

function cloneAndFreezeRustModuleEvaluationEmissionValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeRustModuleEvaluationEmissionValue(clone, new WeakSet());
  return clone;
}

function freezeRustModuleEvaluationEmissionValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const member of Object.values(value)) freezeRustModuleEvaluationEmissionValue(member, seen);
}

const rustModuleEvaluationEmissionLifecycle = {
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
} as const;

const rustModuleEvaluationEmissionSemantics = {
  concurrency: 'serialized-by-bootstrap',
  facadeAccess: 'successful-bootstrap-before-value-access',
  failure: 'cache-first-error-stop-without-retry',
  groupOrder: 'flight-compiler-module-evaluation/1',
  phaseOrder: ['instantiate', 'evaluate'],
  reentrancy: 'reject',
  repeatedInvocation: 'cache-first-result',
  reservedNamespace: '__flight_',
} as const;

const rustModuleEvaluationEmissionSignature = {
  parameters: [],
  result: 'Result<(), FlightModuleEvaluationError>',
} as const;

const rustModuleEvaluationEmissionPlanningFailureCodes: ReadonlySet<CompilerRustModuleEvaluationEmissionPlanningFailureCode> =
  new Set(['rust-module-evaluation-emission-invalid-input', 'rust-module-evaluation-emission-projection-mismatch']);

const rustModuleEvaluationEmissionRefusalCodes: ReadonlySet<string> = new Set([
  'rust-module-evaluation-abrupt-completion-unrepresented',
  'rust-module-evaluation-binding-carrier-unrepresented',
  'rust-module-evaluation-cross-crate-cycle-unrepresented',
  'rust-module-evaluation-entry-invocation-unbound',
  'rust-module-evaluation-live-alias-unrepresented',
  'rust-module-evaluation-output-scope-incomplete',
  'rust-module-evaluation-salvaged-declaration',
  'rust-module-evaluation-step-unrepresented',
  'rust-module-evaluation-tdz-carrier-unrepresented',
]);

const rustModuleEvaluationEmissionRustPath = /^(?:r#)?[A-Za-z_][A-Za-z0-9_]*(?:::(?:r#)?[A-Za-z_][A-Za-z0-9_]*)*$/;
