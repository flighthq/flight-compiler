import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import { createCompilerModuleFacadePlan } from '../../compiler-module/src/index.js';
import type {
  CompilerBackendModuleFile,
  CompilerModuleEvaluationBinding,
  CompilerModuleEvaluationModulePlan,
  CompilerModuleFacadeModulePlan,
  CompilerModuleIdentity,
  CompilerRustModuleConstantBindingPlan,
  CompilerRustModuleConstantModulePlan,
  CompilerRustModuleEvaluationBindingRepresentationPlan,
  CompilerRustModuleEvaluationEntryRepresentationPlan,
  CompilerRustModuleEvaluationGroupRepresentationPlan,
  CompilerRustModuleEvaluationImportAliasPlan,
  CompilerRustModuleEvaluationLocalBindingPlan,
  CompilerRustModuleEvaluationModuleRepresentationPlan,
  CompilerRustModuleEvaluationRepresentationPlan,
  CompilerRustModuleEvaluationRepresentationPlanInput,
  CompilerRustModuleEvaluationRepresentationPlanningFailure,
  CompilerRustModuleEvaluationRepresentationPlanningFailureCode,
  CompilerRustModuleEvaluationRepresentationRefusal,
  CompilerRustModuleEvaluationStepPlan,
  CompilerRustModuleStateBindingPlan,
  CompilerRustModuleStateModulePlan,
  CompilerRustReferenceModulePlan,
  CompilerRustReferenceRepresentation,
  CompilerRustSourceTreeFilePlan,
  CompilerRustSourceTreeModulePlan,
  IrBindingIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';

interface RustModuleEvaluationEvidence {
  readonly constants: ReadonlyMap<string, Readonly<CompilerRustModuleConstantBindingPlan>>;
  readonly module: Readonly<IrModule>;
  readonly references: ReadonlyMap<string, CompilerRustReferenceRepresentation>;
  readonly referenceRefusalByBinding: ReadonlyMap<string, string>;
  readonly state: ReadonlyMap<string, Readonly<CompilerRustModuleStateBindingPlan>>;
}

interface RustModuleEvaluationPlanningContext {
  readonly eligibilityRefusals: CompilerRustModuleEvaluationRepresentationRefusal[];
  readonly evidenceByModule: ReadonlyMap<string, RustModuleEvaluationEvidence>;
  readonly facadeByModule: ReadonlyMap<string, Readonly<CompilerModuleFacadeModulePlan>>;
  readonly locatorByModule: ReadonlyMap<
    string,
    Readonly<{ filePath: string; modulePath: readonly string[]; packageName: string }>
  >;
  readonly neutralByModule: ReadonlyMap<string, Readonly<CompilerModuleEvaluationModulePlan>>;
}

/**
 * Records the exact Rust representation boundary for finalized neutral module evaluation. The plan is
 * deliberately non-executable: entries remain unbound until a downstream invocation ABI exists, and no
 * driver path or symbol spelling is allocated here.
 */
export function createCompilerRustModuleEvaluationRepresentationPlan(
  input: Readonly<CompilerRustModuleEvaluationRepresentationPlanInput>,
): CompilerRustModuleEvaluationRepresentationPlan {
  assertRustModuleEvaluationRepresentationInput(input);
  const evaluation = input.finalization.moduleEvaluation;
  const retainedModules = createRustModuleEvaluationUniqueIdentityMap(input.modules, 'modules');
  const retainedFiles = createRustModuleEvaluationUniqueIdentityMap(input.finalization.moduleFiles, 'moduleFiles');
  const neutralModules = createRustModuleEvaluationUniqueIdentityMap(evaluation.modules, 'moduleEvaluation.modules');
  assertRustModuleEvaluationExactProjection(retainedModules, neutralModules, 'modules', 'moduleEvaluation.modules');
  assertRustModuleEvaluationContainsProjection(
    retainedFiles,
    neutralModules,
    'moduleFiles',
    'moduleEvaluation.modules',
  );

  const sourceTreeModules = createRustModuleEvaluationUniqueIdentityMap(input.sourceTree.modules, 'sourceTree.modules');
  const sourceFiles = createRustModuleEvaluationSourceFiles(input.sourceTree.files);
  const locators = createRustModuleEvaluationLocators(retainedModules, retainedFiles, sourceTreeModules, sourceFiles);
  const publicFacadeModules = createRustModuleEvaluationUniqueIdentityMap(
    input.finalization.facade.modules,
    'facade.modules',
  );
  assertRustModuleEvaluationContainsProjection(
    neutralModules,
    publicFacadeModules,
    'moduleEvaluation.modules',
    'facade.modules',
  );
  const facadeModules = createRustModuleEvaluationUniqueIdentityMap(
    createCompilerModuleFacadePlan({ evaluation, modules: input.modules }).modules,
    'evaluation facade modules',
  );
  assertRustModuleEvaluationExactProjection(
    facadeModules,
    neutralModules,
    'evaluation facade modules',
    'moduleEvaluation.modules',
  );
  const constantModules = createRustModuleEvaluationUniqueIdentityMap(
    input.constantPlan.modules,
    'constantPlan.modules',
  );
  const stateModules = createRustModuleEvaluationUniqueIdentityMap(input.statePlan.modules, 'statePlan.modules');
  const referenceModules = createRustModuleEvaluationUniqueIdentityMap(
    input.referencePlan.modules,
    'referencePlan.modules',
  );
  assertRustModuleEvaluationContainsProjection(
    constantModules,
    neutralModules,
    'constantPlan.modules',
    'retained modules',
  );
  assertRustModuleEvaluationContainsProjection(stateModules, neutralModules, 'statePlan.modules', 'retained modules');
  assertRustModuleEvaluationContainsProjection(
    referenceModules,
    neutralModules,
    'referencePlan.modules',
    'retained modules',
  );

  const evidenceByModule = new Map<string, RustModuleEvaluationEvidence>();
  for (const neutralModule of evaluation.modules) {
    const key = getRustModuleEvaluationIdentityKey(neutralModule.module);
    const module = retainedModules.get(key)!;
    evidenceByModule.set(
      key,
      createRustModuleEvaluationEvidence(
        module,
        constantModules.get(key)!,
        stateModules.get(key)!,
        referenceModules.get(key)!,
      ),
    );
  }

  const context: RustModuleEvaluationPlanningContext = {
    eligibilityRefusals: createRustModuleEvaluationScopeRefusals(input),
    evidenceByModule,
    facadeByModule: facadeModules,
    locatorByModule: locators,
    neutralByModule: neutralModules,
  };
  const entries = evaluation.entries.map((entry) => createRustModuleEvaluationEntry(entry, context));
  const groups = evaluation.groups.map((group) => createRustModuleEvaluationGroup(group, context));
  const modules = evaluation.modules.map((module) => createRustModuleEvaluationModule(module, context));
  const refusals = context.eligibilityRefusals;

  return cloneAndFreezeRustModuleEvaluationRepresentationValue({
    eligibility: {
      outcome: refusals.length === 0 ? ('eligible' as const) : ('refused' as const),
      refusals,
      scope: 'full-output' as const,
    },
    entries,
    groups,
    modules,
    schema: 'flight-rust-module-evaluation-representation-plan/1' as const,
    semantics: evaluation.semantics,
  });
}

export function isCompilerRustModuleEvaluationRepresentationPlanningFailure(
  value: unknown,
): value is CompilerRustModuleEvaluationRepresentationPlanningFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'rust-module-evaluation-representation-planning' &&
    'code' in value &&
    rustModuleEvaluationRepresentationPlanningFailureCodes.has(
      value.code as CompilerRustModuleEvaluationRepresentationPlanningFailureCode,
    ) &&
    'subjects' in value &&
    Array.isArray(value.subjects) &&
    value.subjects.length > 0 &&
    value.subjects.every((subject) => typeof subject === 'string' && subject.length > 0)
  );
}

function assertRustModuleEvaluationBindingEvidencePath(
  module: Readonly<IrModule>,
  bindingId: string,
  path: readonly (number | string)[],
  subject: string,
): void {
  let value: unknown;
  try {
    value = getIrModuleTraversalPathValue(module, path);
  } catch {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-path-mismatch',
      [formatRustModuleEvaluationIdentity(module), JSON.stringify(path)],
      `Rust module-evaluation evidence ${subject} has a path that does not resolve`,
    );
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('binding' in value) ||
    !value.binding ||
    typeof value.binding !== 'object' ||
    !('id' in value.binding) ||
    value.binding.id !== bindingId
  ) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-path-mismatch',
      [formatRustModuleEvaluationIdentity(module), bindingId, JSON.stringify(path)],
      `Rust module-evaluation evidence ${subject} does not resolve to binding ${bindingId}`,
    );
  }
}

function assertRustModuleEvaluationContainsProjection<Value extends { readonly module: CompilerModuleIdentity }>(
  available: ReadonlyMap<string, Readonly<Value>>,
  required: ReadonlyMap<string, unknown>,
  availableSubject: string,
  requiredSubject: string,
): void {
  const missing = [...required.keys()].filter((key) => !available.has(key)).sort(compareTextCodeUnits);
  if (missing.length === 0) return;
  throw createRustModuleEvaluationPlanningFailure(
    'rust-module-evaluation-representation-projection-mismatch',
    missing,
    `Rust module-evaluation ${availableSubject} omits identities required by ${requiredSubject}`,
  );
}

function assertRustModuleEvaluationExactProjection(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
  leftSubject: string,
  rightSubject: string,
): void {
  const onlyLeft = [...left.keys()].filter((key) => !right.has(key));
  const onlyRight = [...right.keys()].filter((key) => !left.has(key));
  const mismatch = [...onlyLeft, ...onlyRight].sort(compareTextCodeUnits);
  if (mismatch.length === 0) return;
  throw createRustModuleEvaluationPlanningFailure(
    'rust-module-evaluation-representation-projection-mismatch',
    mismatch,
    `Rust module-evaluation ${leftSubject} and ${rightSubject} are not exact identity projections`,
  );
}

function assertRustModuleEvaluationRepresentationInput(
  input: Readonly<CompilerRustModuleEvaluationRepresentationPlanInput>,
): void {
  if (!input || typeof input !== 'object' || !Array.isArray(input.modules)) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-invalid-input',
      ['input'],
      'Rust module-evaluation representation planning requires an input with retained modules',
    );
  }
  const schemas = [
    [input.finalization?.moduleEvaluation?.schema, 'flight-compiler-module-evaluation/1', 'moduleEvaluation'],
    [input.finalization?.facade?.schema, 'flight-compiler-module-facade/1', 'facade'],
    [input.sourceTree?.schema, 'flight-rust-source-tree-plan/1', 'sourceTree'],
    [input.constantPlan?.schema, 'flight-rust-module-constant-plan/1', 'constantPlan'],
    [input.statePlan?.schema, 'flight-rust-module-state-plan/1', 'statePlan'],
    [input.referencePlan?.schema, 'flight-rust-reference-representation-plan/1', 'referencePlan'],
  ] as const;
  const invalid = schemas.find(([actual, expected]) => actual !== expected);
  if (invalid) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-invalid-input',
      [invalid[2]],
      `Rust module-evaluation representation planning requires ${invalid[1]} for ${invalid[2]}`,
    );
  }
  if (!Array.isArray(input.finalization.moduleFiles)) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-invalid-input',
      ['moduleFiles'],
      'Rust module-evaluation representation planning requires finalized module files',
    );
  }
}

function cloneAndFreezeRustModuleEvaluationRepresentationValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeRustModuleEvaluationRepresentationValue(clone, new WeakSet());
  return clone;
}

function createRustModuleEvaluationBinding(
  binding: Readonly<CompilerModuleEvaluationBinding>,
  modulePlan: Readonly<CompilerModuleEvaluationModulePlan>,
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationBindingRepresentationPlan {
  return binding.kind === 'import'
    ? createRustModuleEvaluationImportAlias(binding, modulePlan, context)
    : createRustModuleEvaluationLocalBinding(binding, modulePlan.module, context);
}

function createRustModuleEvaluationBindingRefusal(
  code: 'rust-module-evaluation-binding-carrier-unrepresented' | 'rust-module-evaluation-tdz-carrier-unrepresented',
  module: Readonly<CompilerModuleIdentity>,
  binding: Readonly<IrBindingIdentity>,
  message: string,
  detailCode?: string,
): CompilerRustModuleEvaluationRepresentationRefusal {
  return {
    binding: cloneRustModuleEvaluationBinding(binding),
    code,
    ...(detailCode === undefined ? {} : { detailCode }),
    message,
    module: cloneRustModuleEvaluationIdentity(module),
    subject: `${formatRustModuleEvaluationIdentity(module)}#${binding.id}`,
  };
}

function createRustModuleEvaluationEntry(
  entry: Readonly<CompilerModuleIdentity>,
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationEntryRepresentationPlan {
  const key = getRustModuleEvaluationIdentityKey(entry);
  const locator = context.locatorByModule.get(key);
  if (!locator) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-projection-mismatch',
      [formatRustModuleEvaluationIdentity(entry)],
      'Rust module-evaluation entry has no retained source-tree locator',
    );
  }
  const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
    code: 'rust-module-evaluation-entry-invocation-unbound',
    message: `Rust module evaluation cannot invoke entry ${formatRustModuleEvaluationIdentity(entry)} until a downstream entry-hook ABI is bound`,
    module: cloneRustModuleEvaluationIdentity(entry),
    subject: formatRustModuleEvaluationIdentity(entry),
  };
  context.eligibilityRefusals.push(refusal);
  return {
    invocation: { kind: 'unbound', refusal },
    locator,
    module: cloneRustModuleEvaluationIdentity(entry),
  };
}

function createRustModuleEvaluationEvidence(
  module: Readonly<IrModule>,
  constants: Readonly<CompilerRustModuleConstantModulePlan>,
  state: Readonly<CompilerRustModuleStateModulePlan>,
  references: Readonly<CompilerRustReferenceModulePlan>,
): RustModuleEvaluationEvidence {
  const constantByBinding = createRustModuleEvaluationUniqueBindingMap(constants.bindings, 'constantPlan.bindings');
  const stateByBinding = createRustModuleEvaluationUniqueBindingMap(state.bindings, 'statePlan.bindings');
  for (const binding of constants.bindings) {
    assertRustModuleEvaluationBindingEvidencePath(
      module,
      binding.bindingId,
      binding.declarationPath,
      'constantPlan.bindings',
    );
  }
  for (const binding of state.bindings) {
    assertRustModuleEvaluationBindingEvidencePath(
      module,
      binding.bindingId,
      binding.declarationPath,
      'statePlan.bindings',
    );
  }
  const referenceByBinding = new Map<string, CompilerRustReferenceRepresentation>();
  const addReference = (binding: Readonly<IrBindingIdentity>, representation: CompilerRustReferenceRepresentation) => {
    if (referenceByBinding.has(binding.id)) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-duplicate-identity',
        [formatRustModuleEvaluationIdentity(module), binding.id],
        `Rust module-evaluation reference evidence duplicates binding ${binding.id}`,
      );
    }
    referenceByBinding.set(binding.id, representation);
  };
  for (const binding of references.sharedArrayBindings) addReference(binding.binding, binding.representation);
  for (const binding of references.sharedArrayTupleBindings) addReference(binding.binding, 'shared-ref-cell-vec');
  for (const binding of references.sharedClassBindings) addReference(binding.binding, binding.representation);
  for (const binding of references.sharedMapBindings) addReference(binding.binding, binding.representation);
  for (const binding of references.sharedSetBindings) addReference(binding.binding, binding.representation);
  const referenceRefusalByBinding = new Map<string, string>();
  for (const refusal of references.refusals) {
    if (!refusal.owner || referenceRefusalByBinding.has(refusal.owner.id)) continue;
    referenceRefusalByBinding.set(refusal.owner.id, refusal.code);
  }
  return {
    constants: constantByBinding,
    module,
    references: referenceByBinding,
    referenceRefusalByBinding,
    state: stateByBinding,
  };
}

function createRustModuleEvaluationGroup(
  group: Readonly<{ cyclic: boolean; modules: readonly CompilerModuleIdentity[] }>,
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationGroupRepresentationPlan {
  for (const module of group.modules) {
    if (!context.neutralByModule.has(getRustModuleEvaluationIdentityKey(module))) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-projection-mismatch',
        [formatRustModuleEvaluationIdentity(module)],
        'Rust module-evaluation group contains a module outside the authoritative projection',
      );
    }
  }
  const packageNames = [...new Set(group.modules.map((module) => module.packageName))];
  if (group.cyclic && packageNames.length > 1) {
    const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
      code: 'rust-module-evaluation-cross-crate-cycle-unrepresented',
      group: group.modules.map(cloneRustModuleEvaluationIdentity),
      message:
        'Rust module evaluation has no cross-crate lifecycle coordination ABI for this strongly connected component',
      subject: group.modules.map(formatRustModuleEvaluationIdentity).join(' -> '),
    };
    context.eligibilityRefusals.push(refusal);
    return {
      cyclic: group.cyclic,
      modules: group.modules.map(cloneRustModuleEvaluationIdentity),
      representation: { kind: 'refused', refusal },
    };
  }
  return {
    cyclic: group.cyclic,
    modules: group.modules.map(cloneRustModuleEvaluationIdentity),
    representation: group.cyclic
      ? { kind: 'same-crate-scc', packageName: packageNames[0]! }
      : { kind: 'single-module' },
  };
}

function createRustModuleEvaluationImportAlias(
  binding: Readonly<Extract<CompilerModuleEvaluationBinding, { kind: 'import' }>>,
  modulePlan: Readonly<CompilerModuleEvaluationModulePlan>,
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationImportAliasPlan {
  const providerFacade = context.facadeByModule.get(getRustModuleEvaluationIdentityKey(binding.initialization.module));
  const providers = providerFacade?.slots.filter(
    (slot) => slot.lane === 'value' && slot.exportName === binding.initialization.imported,
  );
  if (!providers || providers.length !== 1) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-projection-mismatch',
      [
        formatRustModuleEvaluationIdentity(modulePlan.module),
        formatRustModuleEvaluationIdentity(binding.initialization.module),
        binding.initialization.imported,
      ],
      'Rust module-evaluation import alias has no exact finalized facade provider',
    );
  }
  const provider = providers[0]!;
  const providerRoute = provider.route;
  let decision: CompilerRustModuleEvaluationImportAliasPlan['decision'];
  if (providerRoute.kind === 'binding') {
    const providerNeutral = context.neutralByModule.get(getRustModuleEvaluationIdentityKey(providerRoute.module));
    const providerBinding = providerNeutral?.bindings.find(
      (candidate) => candidate.kind === 'local' && candidate.binding.id === providerRoute.binding.id,
    );
    const providerConstant = context.evidenceByModule
      .get(getRustModuleEvaluationIdentityKey(providerRoute.module))
      ?.constants.get(providerRoute.binding.id);
    if (providerBinding?.mutation === 'immutable' && providerConstant) {
      decision = { outcome: 'erased', reason: 'immutable-primitive-constant' };
    } else {
      const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
        binding: cloneRustModuleEvaluationBinding(binding.binding),
        code: 'rust-module-evaluation-live-alias-unrepresented',
        message: `Rust import ${binding.binding.name} has no target carrier preserving read-only live access to ${binding.initialization.imported}`,
        module: cloneRustModuleEvaluationIdentity(modulePlan.module),
        subject: `${formatRustModuleEvaluationIdentity(modulePlan.module)}#${binding.binding.id}`,
      };
      context.eligibilityRefusals.push(refusal);
      decision = { outcome: 'refused', refusals: [refusal] };
    }
  } else {
    const refusal: CompilerRustModuleEvaluationRepresentationRefusal = {
      binding: cloneRustModuleEvaluationBinding(binding.binding),
      code: 'rust-module-evaluation-binding-carrier-unrepresented',
      message: `Rust import ${binding.binding.name} resolves through a ${provider.route.kind} facade route with no module binding carrier`,
      module: cloneRustModuleEvaluationIdentity(modulePlan.module),
      subject: `${formatRustModuleEvaluationIdentity(modulePlan.module)}#${binding.binding.id}`,
    };
    context.eligibilityRefusals.push(refusal);
    decision = { outcome: 'refused', refusals: [refusal] };
  }
  return {
    access: binding.access,
    binding: cloneRustModuleEvaluationBinding(binding.binding),
    decision,
    imported: binding.initialization.imported,
    kind: 'import',
    mutation: binding.mutation,
    provider,
    request: { module: cloneRustModuleEvaluationIdentity(binding.initialization.module) },
  };
}

function createRustModuleEvaluationLocalBinding(
  binding: Readonly<Extract<CompilerModuleEvaluationBinding, { kind: 'local' }>>,
  module: Readonly<CompilerModuleIdentity>,
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationLocalBindingPlan {
  const evidence = context.evidenceByModule.get(getRustModuleEvaluationIdentityKey(module))!;
  const constant = evidence.constants.get(binding.binding.id);
  const state = evidence.state.get(binding.binding.id);
  const reference = evidence.references.get(binding.binding.id);
  const referenceRefusal = evidence.referenceRefusalByBinding.get(binding.binding.id);
  if (constant) {
    return {
      access: binding.access,
      binding: cloneRustModuleEvaluationBinding(binding.binding),
      decision: { outcome: 'erased', reason: 'primitive-constant' },
      initialization: binding.initialization,
      kind: 'local',
      mutation: binding.mutation,
      storage: { evidence: constant, kind: 'primitive-constant' },
    };
  }
  if (state) {
    return {
      access: binding.access,
      binding: cloneRustModuleEvaluationBinding(binding.binding),
      decision: { outcome: 'erased', reason: 'private-scalar-state' },
      initialization: binding.initialization,
      kind: 'local',
      mutation: binding.mutation,
      storage: { evidence: state, kind: 'private-scalar-state' },
    };
  }
  if (binding.initialization.kind === 'instantiation' && binding.initialization.value === 'function') {
    return {
      access: binding.access,
      binding: cloneRustModuleEvaluationBinding(binding.binding),
      decision: { outcome: 'erased', reason: 'function-item' },
      initialization: binding.initialization,
      kind: 'local',
      mutation: binding.mutation,
      storage: { kind: 'function-item' },
    };
  }
  const refusals: CompilerRustModuleEvaluationRepresentationRefusal[] = [];
  const carrierRefusal = createRustModuleEvaluationBindingRefusal(
    'rust-module-evaluation-binding-carrier-unrepresented',
    module,
    binding.binding,
    `Rust module binding ${binding.binding.name} has no proven lifecycle-aware storage carrier`,
    referenceRefusal,
  );
  refusals.push(carrierRefusal);
  if (binding.access === 'temporal-until-evaluation') {
    refusals.push(
      createRustModuleEvaluationBindingRefusal(
        'rust-module-evaluation-tdz-carrier-unrepresented',
        module,
        binding.binding,
        `Rust module binding ${binding.binding.name} has no carrier for temporal-dead-zone ReferenceError semantics`,
      ),
    );
  }
  context.eligibilityRefusals.push(...refusals);
  return {
    access: binding.access,
    binding: cloneRustModuleEvaluationBinding(binding.binding),
    decision: { outcome: 'refused', refusals },
    initialization: binding.initialization,
    kind: 'local',
    mutation: binding.mutation,
    storage: reference ? { kind: 'reference-carrier', representation: reference } : { kind: 'unrepresented' },
  };
}

function createRustModuleEvaluationLocators(
  modules: ReadonlyMap<string, Readonly<IrModule>>,
  retainedFiles: ReadonlyMap<string, Readonly<CompilerBackendModuleFile>>,
  sourceTreeModules: ReadonlyMap<string, Readonly<CompilerRustSourceTreeModulePlan>>,
  sourceFiles: ReadonlyMap<string, Readonly<CompilerRustSourceTreeFilePlan>>,
): ReadonlyMap<string, Readonly<{ filePath: string; modulePath: readonly string[]; packageName: string }>> {
  const locators = new Map<
    string,
    Readonly<{ filePath: string; modulePath: readonly string[]; packageName: string }>
  >();
  for (const [key, module] of modules) {
    const retainedFile = retainedFiles.get(key)!;
    const sourceTreeModule = sourceTreeModules.get(key);
    const sourceFile = sourceFiles.get(key);
    if (!sourceTreeModule || !sourceFile) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-projection-mismatch',
        [formatRustModuleEvaluationIdentity(module)],
        'Rust module-evaluation retained module has no exact source-owned source-tree projection',
      );
    }
    if (
      sourceTreeModule.filePath !== sourceFile.filePath ||
      retainedFile.file.path !== sourceFile.filePath ||
      sourceFile.packageName !== module.packageName ||
      !areRustModuleEvaluationPathsEqual(sourceTreeModule.modulePath, sourceFile.modulePath)
    ) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-path-mismatch',
        [
          formatRustModuleEvaluationIdentity(module),
          retainedFile.file.path,
          sourceTreeModule.filePath,
          sourceFile.filePath,
        ],
        'Rust module-evaluation retained file and finalized source-tree locator disagree',
      );
    }
    locators.set(key, {
      filePath: sourceTreeModule.filePath,
      modulePath: sourceTreeModule.modulePath,
      packageName: module.packageName,
    });
  }
  return locators;
}

function createRustModuleEvaluationModule(
  modulePlan: Readonly<CompilerModuleEvaluationModulePlan>,
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationModuleRepresentationPlan {
  const key = getRustModuleEvaluationIdentityKey(modulePlan.module);
  const locator = context.locatorByModule.get(key);
  if (!locator) {
    throw createRustModuleEvaluationPlanningFailure(
      'rust-module-evaluation-representation-projection-mismatch',
      [formatRustModuleEvaluationIdentity(modulePlan.module)],
      'Rust module-evaluation module has no retained source-tree locator',
    );
  }
  for (const dependency of modulePlan.dependencies) {
    if (
      getRustModuleEvaluationIdentityKey(dependency.importer) !== key ||
      !context.neutralByModule.has(getRustModuleEvaluationIdentityKey(dependency.target))
    ) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-projection-mismatch',
        [formatRustModuleEvaluationIdentity(modulePlan.module), dependency.specifier],
        'Rust module-evaluation dependency is outside its authoritative module projection',
      );
    }
  }
  const bindings = modulePlan.bindings.map((binding) =>
    createRustModuleEvaluationBinding(binding, modulePlan, context),
  );
  return {
    bindings,
    dependencies: modulePlan.dependencies,
    lifecycle: {
      evaluate: 'module-private-evaluate-once-function',
      instantiate: 'module-private-instantiate-once-function',
      state: 'module-private-lifecycle-state',
      states: ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'],
    },
    locator,
    module: cloneRustModuleEvaluationIdentity(modulePlan.module),
    steps: modulePlan.steps.map((step, index) =>
      createRustModuleEvaluationStep(step, index, modulePlan, bindings, context),
    ),
  };
}

function createRustModuleEvaluationPlanningFailure(
  code: CompilerRustModuleEvaluationRepresentationPlanningFailureCode,
  subjects: readonly string[],
  message: string,
): CompilerRustModuleEvaluationRepresentationPlanningFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'rust-module-evaluation-representation-planning' as const,
    subjects: [...new Set(subjects)].sort(compareTextCodeUnits),
  });
  failure.name = 'CompilerRustModuleEvaluationRepresentationPlanningError';
  return failure;
}

function createRustModuleEvaluationScopeRefusals(
  input: Readonly<CompilerRustModuleEvaluationRepresentationPlanInput>,
): CompilerRustModuleEvaluationRepresentationRefusal[] {
  const unavailable = new Map<string, Readonly<{ code: string; module: CompilerModuleIdentity }>>();
  for (const refusal of input.finalization.refusals ?? []) {
    unavailable.set(getRustModuleEvaluationIdentityKey(refusal.module), { code: refusal.code, module: refusal.module });
  }
  for (const module of input.finalization.placeholderModules ?? []) {
    const key = getRustModuleEvaluationIdentityKey(module);
    if (!unavailable.has(key)) unavailable.set(key, { code: 'placeholder', module });
  }
  for (const file of input.sourceTree.files) {
    if (file.ownership.kind !== 'placeholder') continue;
    const key = getRustModuleEvaluationIdentityKey(file.ownership.module);
    if (!unavailable.has(key)) unavailable.set(key, { code: 'placeholder', module: file.ownership.module });
  }
  if (unavailable.size === 0) return [];
  const entries = [...unavailable.values()].sort((left, right) =>
    compareTextCodeUnits(
      getRustModuleEvaluationIdentityKey(left.module),
      getRustModuleEvaluationIdentityKey(right.module),
    ),
  );
  return [
    {
      code: 'rust-module-evaluation-output-scope-incomplete',
      message:
        'Rust module evaluation requires one complete retained output closure; refused or placeholder modules make the scope incomplete',
      subject: 'full-output',
    },
    ...entries.map(
      ({ code, module }): CompilerRustModuleEvaluationRepresentationRefusal => ({
        code: 'rust-module-evaluation-salvaged-declaration',
        detailCode: code,
        message: `Rust module evaluation cannot include partial or placeholder output for ${formatRustModuleEvaluationIdentity(module)}`,
        module: cloneRustModuleEvaluationIdentity(module),
        subject: formatRustModuleEvaluationIdentity(module),
      }),
    ),
  ];
}

function createRustModuleEvaluationSourceFiles(
  files: readonly Readonly<CompilerRustSourceTreeFilePlan>[],
): ReadonlyMap<string, Readonly<CompilerRustSourceTreeFilePlan>> {
  const sourceFiles = new Map<string, Readonly<CompilerRustSourceTreeFilePlan>>();
  for (const file of files) {
    if (file.ownership.kind !== 'source') continue;
    const key = getRustModuleEvaluationIdentityKey(file.ownership.module);
    if (sourceFiles.has(key)) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-duplicate-identity',
        [key],
        `Rust module-evaluation source tree duplicates source ownership for ${key}`,
      );
    }
    sourceFiles.set(key, file);
  }
  return sourceFiles;
}

function createRustModuleEvaluationStep(
  step: Readonly<CompilerModuleEvaluationModulePlan['steps'][number]>,
  index: number,
  modulePlan: Readonly<CompilerModuleEvaluationModulePlan>,
  bindings: readonly CompilerRustModuleEvaluationBindingRepresentationPlan[],
  context: RustModuleEvaluationPlanningContext,
): CompilerRustModuleEvaluationStepPlan {
  const decisions = step.bindings.map((binding) =>
    bindings.find((candidate) => candidate.kind === 'local' && candidate.binding.id === binding.id),
  );
  for (const [bindingIndex, decision] of decisions.entries()) {
    if (
      !decision ||
      decision.kind !== 'local' ||
      decision.initialization.kind !== 'evaluation' ||
      decision.initialization.step !== index
    ) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-projection-mismatch',
        [formatRustModuleEvaluationIdentity(modulePlan.module), step.bindings[bindingIndex]!.id],
        `Rust module-evaluation step ${String(index)} and binding initialization evidence disagree`,
      );
    }
    const evidencePath =
      decision.storage.kind === 'primitive-constant' || decision.storage.kind === 'private-scalar-state'
        ? decision.storage.evidence.declarationPath
        : undefined;
    if (evidencePath && !areRustModuleEvaluationTraversalPathsEqual(evidencePath, step.path)) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-path-mismatch',
        [
          formatRustModuleEvaluationIdentity(modulePlan.module),
          decision.binding.id,
          JSON.stringify(evidencePath),
          JSON.stringify(step.path),
        ],
        `Rust module-evaluation step ${String(index)} and phase-erasure evidence have different paths`,
      );
    }
  }
  const erased = decisions.every(
    (decision) =>
      decision?.kind === 'local' &&
      decision.decision.outcome === 'erased' &&
      (decision.decision.reason === 'primitive-constant' || decision.decision.reason === 'private-scalar-state'),
  );
  if (step.bindings.length > 0 && erased) {
    return {
      index,
      outcome: {
        evidence: decisions.map((decision) => {
          if (!decision || decision.kind !== 'local' || decision.decision.outcome !== 'erased') {
            throw new Error('unreachable Rust module-evaluation erased-step decision');
          }
          return {
            bindingId: decision.binding.id,
            kind:
              decision.decision.reason === 'primitive-constant'
                ? ('primitive-constant' as const)
                : ('private-scalar-state' as const),
          };
        }),
        outcome: 'erased',
      },
      provenance: step,
    };
  }
  const pathSubject = JSON.stringify(step.path);
  const refusals: CompilerRustModuleEvaluationRepresentationRefusal[] = [
    {
      code: 'rust-module-evaluation-step-unrepresented',
      message: `Rust module evaluation has no executable driver representation for ${step.declaration} step ${String(index)}`,
      module: cloneRustModuleEvaluationIdentity(modulePlan.module),
      path: [...step.path],
      subject: `${formatRustModuleEvaluationIdentity(modulePlan.module)}:${pathSubject}`,
    },
    {
      code: 'rust-module-evaluation-abrupt-completion-unrepresented',
      message: `Rust module evaluation has no cached abrupt-completion carrier for ${step.declaration} step ${String(index)}`,
      module: cloneRustModuleEvaluationIdentity(modulePlan.module),
      path: [...step.path],
      subject: `${formatRustModuleEvaluationIdentity(modulePlan.module)}:${pathSubject}`,
    },
  ];
  context.eligibilityRefusals.push(...refusals);
  return { index, outcome: { outcome: 'refused', refusals }, provenance: step };
}

function createRustModuleEvaluationUniqueBindingMap<Value extends { readonly bindingId: string }>(
  values: readonly Readonly<Value>[],
  subject: string,
): ReadonlyMap<string, Readonly<Value>> {
  const byBinding = new Map<string, Readonly<Value>>();
  for (const value of values) {
    if (byBinding.has(value.bindingId)) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-duplicate-identity',
        [subject, value.bindingId],
        `Rust module-evaluation ${subject} duplicates binding ${value.bindingId}`,
      );
    }
    byBinding.set(value.bindingId, value);
  }
  return byBinding;
}

function createRustModuleEvaluationUniqueIdentityMap<
  Value extends
    | CompilerModuleIdentity
    | { readonly identity: CompilerModuleIdentity }
    | { readonly module: CompilerModuleIdentity },
>(values: readonly Readonly<Value>[], subject: string): ReadonlyMap<string, Readonly<Value>> {
  const byIdentity = new Map<string, Readonly<Value>>();
  for (const value of values) {
    const identity = getRustModuleEvaluationValueIdentity(value);
    const key = getRustModuleEvaluationIdentityKey(identity);
    if (byIdentity.has(key)) {
      throw createRustModuleEvaluationPlanningFailure(
        'rust-module-evaluation-representation-duplicate-identity',
        [subject, key],
        `Rust module-evaluation ${subject} duplicates ${key}`,
      );
    }
    byIdentity.set(key, value);
  }
  return byIdentity;
}

function areRustModuleEvaluationPathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function areRustModuleEvaluationTraversalPathsEqual(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function cloneRustModuleEvaluationBinding(binding: Readonly<IrBindingIdentity>): IrBindingIdentity {
  return structuredClone(binding);
}

function cloneRustModuleEvaluationIdentity(module: Readonly<CompilerModuleIdentity>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function formatRustModuleEvaluationIdentity(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}/${module.source}#${module.name}`;
}

function freezeRustModuleEvaluationRepresentationValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const member of Object.values(value)) freezeRustModuleEvaluationRepresentationValue(member, seen);
}

function getRustModuleEvaluationIdentityKey(module: Readonly<CompilerModuleIdentity>): string {
  return JSON.stringify([module.packageName, module.source, module.name]);
}

function getRustModuleEvaluationValueIdentity(
  value: Readonly<
    CompilerModuleIdentity | { readonly identity: CompilerModuleIdentity } | { readonly module: CompilerModuleIdentity }
  >,
): Readonly<CompilerModuleIdentity> {
  if ('module' in value) return value.module;
  if ('identity' in value) return value.identity;
  return value;
}

const rustModuleEvaluationRepresentationPlanningFailureCodes: ReadonlySet<CompilerRustModuleEvaluationRepresentationPlanningFailureCode> =
  new Set([
    'rust-module-evaluation-representation-duplicate-identity',
    'rust-module-evaluation-representation-finalization-mismatch',
    'rust-module-evaluation-representation-invalid-input',
    'rust-module-evaluation-representation-path-mismatch',
    'rust-module-evaluation-representation-projection-mismatch',
  ]);
