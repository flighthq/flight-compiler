import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
  normalizePathPortable,
} from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal, getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerModuleEvaluationBinding,
  CompilerModuleEvaluationDependency,
  CompilerModuleEvaluationFailure,
  CompilerModuleEvaluationFailureCode,
  CompilerModuleEvaluationGroup,
  CompilerModuleEvaluationInput,
  CompilerModuleEvaluationModulePlan,
  CompilerModuleEvaluationPlan,
  CompilerModuleEvaluationStep,
  CompilerModuleIdentity,
  IrBindingIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrModule,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';

interface CompilerModuleEvaluationRecord {
  readonly dependencies: CompilerModuleEvaluationRecord[];
  readonly dependencyBySpecifier: Map<string, CompilerModuleEvaluationRecord>;
  readonly identity: CompilerModuleIdentity;
  readonly identityKey: string;
  readonly module: Readonly<IrModule>;
}

interface CompilerModuleEvaluationTraversalState {
  readonly groups: CompilerModuleEvaluationGroup[];
  index: number;
  readonly indices: Map<string, number>;
  readonly lowLinks: Map<string, number>;
  readonly onStack: Set<string>;
  readonly stack: CompilerModuleEvaluationRecord[];
}

export function createCompilerModuleEvaluationPlan(
  input: Readonly<CompilerModuleEvaluationInput>,
): CompilerModuleEvaluationPlan {
  if (!input || typeof input !== 'object' || !Array.isArray(input.modules)) {
    throw createCompilerModuleEvaluationFailure(
      'invalid-module',
      'modules',
      'Module evaluation requires a module array',
    );
  }
  if (!Array.isArray(input.dependencies)) {
    throw createCompilerModuleEvaluationFailure(
      'invalid-dependency',
      'dependencies',
      'Module evaluation requires a dependency array',
    );
  }
  if (!Array.isArray(input.entries)) {
    throw createCompilerModuleEvaluationFailure(
      'invalid-entry',
      'entries',
      'Module evaluation requires an entry array',
    );
  }
  const records = createCompilerModuleEvaluationRecords(input.modules);
  connectCompilerModuleEvaluationDependencies(records, input.dependencies);
  const entries = getCompilerModuleEvaluationEntries(records, input.entries);
  const groups = createCompilerModuleEvaluationGroups(entries);
  assertCompilerModuleEvaluationReachability(records, groups);
  const modules = [...records.values()]
    .sort((left, right) => compareTextCodeUnits(left.identityKey, right.identityKey))
    .map(createCompilerModuleEvaluationModulePlan);
  return cloneCompilerModuleEvaluationValue({
    entries: entries.map((entry) => entry.identity),
    groups,
    modules,
    schema: 'flight-compiler-module-evaluation/1' as const,
    semantics: {
      cycles: 'strongly-connected-live-environment' as const,
      dependencyEvaluation: 'depth-first-request-order' as const,
      importAccess: 'read-only-live-alias' as const,
      localExportAccess: 'live-alias' as const,
      phaseOrder: ['link', 'instantiate', 'evaluate-dependencies', 'evaluate'] as const,
      temporalAccess: 'throw-reference-error' as const,
      topLevelAwait: 'refuse' as const,
    },
  });
}

export function isCompilerModuleEvaluationFailure(value: unknown): value is CompilerModuleEvaluationFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-module-evaluation' &&
    'code' in value &&
    compilerModuleEvaluationFailureCodes.has(value.code as CompilerModuleEvaluationFailureCode) &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    value.subject.length > 0 &&
    (!('module' in value) || value.module === undefined || isCompilerModuleEvaluationIdentity(value.module))
  );
}

function addCompilerModuleEvaluationBinding(
  bindings: CompilerModuleEvaluationBinding[],
  seen: Set<string>,
  binding: CompilerModuleEvaluationBinding,
  module: Readonly<CompilerModuleIdentity>,
): void {
  if (seen.has(binding.binding.id)) {
    throw createCompilerModuleEvaluationFailure(
      'duplicate-binding',
      binding.binding.id,
      `Module evaluation binding is duplicated: ${binding.binding.id}`,
      module,
    );
  }
  seen.add(binding.binding.id);
  bindings.push(binding);
}

function assertCompilerModuleEvaluationReachability(
  records: ReadonlyMap<string, CompilerModuleEvaluationRecord>,
  groups: readonly CompilerModuleEvaluationGroup[],
): void {
  const reached = new Set(groups.flatMap((group) => group.modules.map(getCompilerModuleEvaluationIdentityKey)));
  const unreachable = [...records.values()]
    .filter((record) => !reached.has(record.identityKey))
    .sort((left, right) => compareTextCodeUnits(left.identityKey, right.identityKey))[0];
  if (unreachable) {
    throw createCompilerModuleEvaluationFailure(
      'unreachable-module',
      unreachable.identityKey,
      `Module evaluation has no entry path to ${unreachable.identity.packageName}/${unreachable.identity.source}`,
      unreachable.identity,
    );
  }
}

function cloneCompilerModuleEvaluationValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerModuleEvaluationValue(clone, new WeakSet());
  return clone;
}

function collectCompilerModuleEvaluationPatternBindings(
  pattern: Readonly<IrBindingPattern>,
): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const nested =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) =>
          element ? collectCompilerModuleEvaluationPatternBindings(element.pattern) : [],
        )
      : pattern.properties.flatMap((property) => collectCompilerModuleEvaluationPatternBindings(property.pattern));
  return pattern.rest ? [...nested, ...collectCompilerModuleEvaluationPatternBindings(pattern.rest)] : nested;
}

function connectCompilerModuleEvaluationDependencies(
  records: ReadonlyMap<string, CompilerModuleEvaluationRecord>,
  dependencies: readonly Readonly<CompilerModuleEvaluationDependency>[],
): void {
  for (const [index, dependency] of dependencies.entries()) {
    const subject = `dependencies[${String(index)}]`;
    if (
      !dependency ||
      typeof dependency !== 'object' ||
      typeof dependency.specifier !== 'string' ||
      dependency.specifier.length === 0
    ) {
      throw createCompilerModuleEvaluationFailure(
        'invalid-dependency',
        subject,
        `Module evaluation dependency is malformed at ${subject}`,
      );
    }
    const importerIdentity = normalizeCompilerModuleEvaluationIdentity(
      dependency.importer,
      'invalid-dependency',
      subject,
    );
    const targetIdentity = normalizeCompilerModuleEvaluationIdentity(dependency.target, 'invalid-dependency', subject);
    const importer = records.get(getCompilerModuleEvaluationIdentityKey(importerIdentity));
    const target = records.get(getCompilerModuleEvaluationIdentityKey(targetIdentity));
    if (!importer || !target) {
      throw createCompilerModuleEvaluationFailure(
        'invalid-dependency',
        subject,
        `Module evaluation dependency must connect two input modules at ${subject}`,
        importer?.identity,
      );
    }
    if (importer.dependencyBySpecifier.has(dependency.specifier)) {
      throw createCompilerModuleEvaluationFailure(
        'duplicate-dependency',
        `${importer.identityKey}:${dependency.specifier}`,
        `Module evaluation dependency is duplicated for ${dependency.specifier}`,
        importer.identity,
      );
    }
    importer.dependencyBySpecifier.set(dependency.specifier, target);
    importer.dependencies.push(target);
  }
  for (const record of records.values()) {
    const expected = getCompilerModuleEvaluationRuntimeSpecifiers(record.module);
    for (const specifier of expected) {
      if (!record.dependencyBySpecifier.has(specifier)) {
        throw createCompilerModuleEvaluationFailure(
          'missing-dependency',
          `${record.identityKey}:${specifier}`,
          `Module evaluation dependency is missing for ${specifier}`,
          record.identity,
        );
      }
    }
    for (const specifier of record.dependencyBySpecifier.keys()) {
      if (!expected.has(specifier)) {
        throw createCompilerModuleEvaluationFailure(
          'unexpected-dependency',
          `${record.identityKey}:${specifier}`,
          `Module evaluation dependency is not requested by the module: ${specifier}`,
          record.identity,
        );
      }
    }
  }
}

function createCompilerModuleEvaluationFailure(
  code: CompilerModuleEvaluationFailureCode,
  subject: string,
  message: string,
  module?: Readonly<CompilerModuleIdentity>,
): CompilerModuleEvaluationFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-module-evaluation' as const,
    ...(module ? { module: structuredClone(module) } : {}),
    subject,
  });
  failure.name = 'CompilerModuleEvaluationError';
  return failure;
}

function createCompilerModuleEvaluationGroups(
  entries: readonly CompilerModuleEvaluationRecord[],
): readonly CompilerModuleEvaluationGroup[] {
  const state: CompilerModuleEvaluationTraversalState = {
    groups: [],
    index: 0,
    indices: new Map(),
    lowLinks: new Map(),
    onStack: new Set(),
    stack: [],
  };
  for (const entry of entries) {
    if (!state.indices.has(entry.identityKey)) visitCompilerModuleEvaluationRecord(entry, state);
  }
  return state.groups;
}

function createCompilerModuleEvaluationModulePlan(
  record: Readonly<CompilerModuleEvaluationRecord>,
): CompilerModuleEvaluationModulePlan {
  const bindings: CompilerModuleEvaluationBinding[] = [];
  const seenBindings = new Set<string>();
  const steps: CompilerModuleEvaluationStep[] = [];
  const topLevelAwaitPath = getCompilerModuleEvaluationTopLevelAwaitPath(record.module);
  if (topLevelAwaitPath) {
    throw createCompilerModuleEvaluationFailure(
      'top-level-await',
      JSON.stringify(topLevelAwaitPath),
      `Module evaluation does not yet represent top-level await at ${JSON.stringify(topLevelAwaitPath)}`,
      record.identity,
    );
  }
  record.module.imports.forEach((imported) => {
    const target = record.dependencyBySpecifier.get(imported.specifier)!;
    for (const importedBinding of imported.bindings) {
      if (importedBinding.typeOnly) continue;
      addCompilerModuleEvaluationBinding(
        bindings,
        seenBindings,
        {
          access: 'dependency-live',
          binding: importedBinding.binding,
          initialization: {
            imported: importedBinding.imported,
            kind: 'dependency',
            module: target.identity,
          },
          kind: 'import',
          mutation: 'read-only',
        },
        record.identity,
      );
    }
  });
  record.module.declarations.forEach((declaration, index) =>
    addCompilerModuleEvaluationDeclaration(declaration, index, bindings, seenBindings, steps, record.identity),
  );
  const defaultExpressions = record.module.exports
    .map((exported, index) => ({ exported, index }))
    .filter((entry) => entry.exported.kind === 'default');
  if (defaultExpressions.length > 1) {
    throw createCompilerModuleEvaluationFailure(
      'invalid-module',
      'exports',
      'Module evaluation cannot contain multiple default export expressions',
      record.identity,
    );
  }
  const defaultExpression = defaultExpressions[0];
  if (defaultExpression) {
    if (steps.length > 0) {
      throw createCompilerModuleEvaluationFailure(
        'unsupported-default-expression-order',
        `exports[${String(defaultExpression.index)}]`,
        'Module evaluation cannot order a default export expression relative to runtime declarations',
        record.identity,
      );
    }
    steps.push({
      action: 'initialize',
      bindings: [],
      completion: 'abrupt-stops-module-evaluation',
      declaration: 'defaultExpression',
      path: ['exports', defaultExpression.index, 'expression'],
    });
  }
  return {
    bindings,
    dependencies: [...record.dependencyBySpecifier].map(([specifier, dependency]) => ({
      importer: record.identity,
      specifier,
      target: dependency.identity,
    })),
    module: record.identity,
    steps,
  };
}

function createCompilerModuleEvaluationRecords(
  modules: readonly Readonly<IrModule>[],
): Map<string, CompilerModuleEvaluationRecord> {
  const records = new Map<string, CompilerModuleEvaluationRecord>();
  for (const [index, module] of modules.entries()) {
    const identity = normalizeCompilerModuleEvaluationIdentity(module, 'invalid-module', `modules[${String(index)}]`);
    const identityKey = getCompilerModuleEvaluationIdentityKey(identity);
    if (records.has(identityKey)) {
      throw createCompilerModuleEvaluationFailure(
        'duplicate-module',
        identityKey,
        `Module evaluation input duplicates ${identity.packageName}/${identity.source}`,
        identity,
      );
    }
    if (!Array.isArray(module.declarations) || !Array.isArray(module.exports) || !Array.isArray(module.imports)) {
      throw createCompilerModuleEvaluationFailure(
        'invalid-module',
        identityKey,
        'Module evaluation input must contain declaration, export, and import arrays',
        identity,
      );
    }
    records.set(identityKey, {
      dependencies: [],
      dependencyBySpecifier: new Map(),
      identity,
      identityKey,
      module,
    });
  }
  return records;
}

function addCompilerModuleEvaluationDeclaration(
  declaration: Readonly<IrDeclaration>,
  index: number,
  bindings: CompilerModuleEvaluationBinding[],
  seenBindings: Set<string>,
  steps: CompilerModuleEvaluationStep[],
  module: Readonly<CompilerModuleIdentity>,
): void {
  const path = ['declarations', index] as const;
  switch (declaration.kind) {
    case 'class': {
      const step = steps.length;
      steps.push({
        action: 'initialize',
        bindings: [declaration.binding],
        completion: 'abrupt-stops-module-evaluation',
        declaration: declaration.kind,
        path,
      });
      addCompilerModuleEvaluationBinding(
        bindings,
        seenBindings,
        {
          access: 'temporal-until-evaluation',
          binding: declaration.binding,
          initialization: { kind: 'evaluation', step },
          kind: 'local',
          mutation: 'mutable',
        },
        module,
      );
      return;
    }
    case 'enum':
      steps.push({
        action: 'assign',
        bindings: [declaration.binding],
        completion: 'abrupt-stops-module-evaluation',
        declaration: 'enum',
        path,
      });
      addCompilerModuleEvaluationBinding(
        bindings,
        seenBindings,
        {
          access: 'available-after-instantiation',
          binding: declaration.binding,
          initialization: { kind: 'instantiation', value: 'undefined' },
          kind: 'local',
          mutation: 'mutable',
        },
        module,
      );
      return;
    case 'function':
      addCompilerModuleEvaluationBinding(
        bindings,
        seenBindings,
        {
          access: 'available-after-instantiation',
          binding: declaration.binding,
          initialization: { kind: 'instantiation', value: 'function' },
          kind: 'local',
          mutation: 'mutable',
        },
        module,
      );
      return;
    case 'variable':
      addCompilerModuleEvaluationVariableDeclaration(declaration, path, bindings, seenBindings, steps, module);
      return;
    case 'interface':
    case 'typeAlias':
      return;
  }
}

function addCompilerModuleEvaluationVariableDeclaration(
  declaration: Readonly<IrVariableDeclaration>,
  path: CompilerIrTraversalPath,
  bindings: CompilerModuleEvaluationBinding[],
  seenBindings: Set<string>,
  steps: CompilerModuleEvaluationStep[],
  module: Readonly<CompilerModuleIdentity>,
): void {
  if (!compilerModuleEvaluationVariableDeclarationKinds.has(declaration.declarationKind)) {
    throw createCompilerModuleEvaluationFailure(
      'invalid-declaration-kind',
      `${JSON.stringify(path)}.declarationKind`,
      `Module variable declaration kind is invalid: ${String(declaration.declarationKind)}`,
      module,
    );
  }
  if ((declaration.declarationKind === 'const') === declaration.mutable) {
    throw createCompilerModuleEvaluationFailure(
      'invalid-declaration-kind',
      `${JSON.stringify(path)}.mutable`,
      `Module variable mutability conflicts with ${declaration.declarationKind}`,
      module,
    );
  }
  const declarationBindings =
    'binding' in declaration
      ? [declaration.binding]
      : collectCompilerModuleEvaluationPatternBindings(declaration.pattern);
  const evaluationStep =
    declaration.declarationKind === 'var' && !declaration.initializer
      ? undefined
      : steps.push({
          action: declaration.declarationKind === 'var' ? 'assign' : 'initialize',
          bindings: declarationBindings,
          completion: 'abrupt-stops-module-evaluation',
          declaration: 'variable',
          path,
        }) - 1;
  for (const binding of declarationBindings) {
    addCompilerModuleEvaluationBinding(
      bindings,
      seenBindings,
      {
        access: declaration.declarationKind === 'var' ? 'available-after-instantiation' : 'temporal-until-evaluation',
        binding,
        initialization:
          declaration.declarationKind === 'var'
            ? { kind: 'instantiation', value: 'undefined' }
            : { kind: 'evaluation', step: evaluationStep! },
        kind: 'local',
        mutation: declaration.mutable ? 'mutable' : 'immutable',
      },
      module,
    );
  }
}

function freezeCompilerModuleEvaluationValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerModuleEvaluationValue(child, seen);
  Object.freeze(value);
}

function getCompilerModuleEvaluationEntries(
  records: ReadonlyMap<string, CompilerModuleEvaluationRecord>,
  entries: readonly Readonly<CompilerModuleIdentity>[],
): readonly CompilerModuleEvaluationRecord[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const identity = normalizeCompilerModuleEvaluationIdentity(entry, 'invalid-entry', `entries[${String(index)}]`);
    const identityKey = getCompilerModuleEvaluationIdentityKey(identity);
    if (seen.has(identityKey)) {
      throw createCompilerModuleEvaluationFailure(
        'duplicate-entry',
        identityKey,
        `Module evaluation entry is duplicated: ${identity.packageName}/${identity.source}`,
        identity,
      );
    }
    seen.add(identityKey);
    const record = records.get(identityKey);
    if (!record) {
      throw createCompilerModuleEvaluationFailure(
        'invalid-entry',
        identityKey,
        `Module evaluation entry is not an input module: ${identity.packageName}/${identity.source}`,
        identity,
      );
    }
    return record;
  });
}

function getCompilerModuleEvaluationIdentityKey(identity: Readonly<CompilerModuleIdentity>): string {
  return normalizeCompilerStructuralValueCanonical(identity);
}

function getCompilerModuleEvaluationRuntimeSpecifiers(module: Readonly<IrModule>): ReadonlySet<string> {
  const specifiers = new Set<string>();
  for (const imported of module.imports) {
    if (!imported.typeOnly) specifiers.add(imported.specifier);
  }
  for (const exported of module.exports) {
    if ('specifier' in exported && !exported.typeOnly) specifiers.add(exported.specifier);
  }
  return specifiers;
}

function getCompilerModuleEvaluationTopLevelAwaitPath(module: Readonly<IrModule>): CompilerIrTraversalPath | undefined {
  let awaitPath: CompilerIrTraversalPath | undefined;
  analyzeIrModuleTraversal(module, {
    expression(expression, path) {
      if (!awaitPath && expression.kind === 'await' && isCompilerModuleEvaluationExpressionTopLevel(module, path)) {
        awaitPath = path;
      }
      return undefined;
    },
  });
  return awaitPath;
}

function isCompilerModuleEvaluationExpressionTopLevel(
  module: Readonly<IrModule>,
  path: CompilerIrTraversalPath,
): boolean {
  const ancestors = path.slice(1).map((_, index) => getIrModuleTraversalPathValue(module, path.slice(0, index + 1)));
  if (
    ancestors.some(
      (ancestor) => !!ancestor && typeof ancestor === 'object' && 'kind' in ancestor && ancestor.kind === 'function',
    )
  )
    return false;
  if (path[0] === 'exports') return true;
  const declaration = module.declarations[path[1] as number];
  if (declaration?.kind === 'variable') return true;
  if (declaration?.kind !== 'class' || path[2] !== 'fields') return false;
  return declaration.fields[path[3] as number]?.static === true;
}

function isCompilerModuleEvaluationIdentity(value: unknown): value is CompilerModuleIdentity {
  return (
    !!value &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    'packageName' in value &&
    typeof value.packageName === 'string' &&
    value.packageName.length > 0 &&
    'source' in value &&
    typeof value.source === 'string' &&
    value.source.length > 0
  );
}

function normalizeCompilerModuleEvaluationIdentity(
  value: unknown,
  code: Extract<CompilerModuleEvaluationFailureCode, 'invalid-dependency' | 'invalid-entry' | 'invalid-module'>,
  subject: string,
): CompilerModuleIdentity {
  if (!isCompilerModuleEvaluationIdentity(value)) {
    throw createCompilerModuleEvaluationFailure(code, subject, `Module evaluation identity is malformed at ${subject}`);
  }
  return {
    name: value.name,
    packageName: value.packageName,
    source: normalizePathPortable(value.source),
  };
}

function visitCompilerModuleEvaluationRecord(
  record: CompilerModuleEvaluationRecord,
  state: CompilerModuleEvaluationTraversalState,
): void {
  const index = state.index;
  state.index += 1;
  state.indices.set(record.identityKey, index);
  state.lowLinks.set(record.identityKey, index);
  state.stack.push(record);
  state.onStack.add(record.identityKey);
  for (const dependency of record.dependencies) {
    if (!state.indices.has(dependency.identityKey)) {
      visitCompilerModuleEvaluationRecord(dependency, state);
      state.lowLinks.set(
        record.identityKey,
        Math.min(state.lowLinks.get(record.identityKey)!, state.lowLinks.get(dependency.identityKey)!),
      );
    } else if (state.onStack.has(dependency.identityKey)) {
      state.lowLinks.set(
        record.identityKey,
        Math.min(state.lowLinks.get(record.identityKey)!, state.indices.get(dependency.identityKey)!),
      );
    }
  }
  if (state.lowLinks.get(record.identityKey) !== state.indices.get(record.identityKey)) return;
  const modules: CompilerModuleIdentity[] = [];
  let member: CompilerModuleEvaluationRecord;
  do {
    member = state.stack.pop()!;
    state.onStack.delete(member.identityKey);
    modules.push(member.identity);
  } while (member !== record);
  state.groups.push({
    cyclic: modules.length > 1 || record.dependencies.some((dependency) => dependency === record),
    modules,
  });
}

const compilerModuleEvaluationFailureCodes = new Set<CompilerModuleEvaluationFailureCode>([
  'duplicate-binding',
  'duplicate-dependency',
  'duplicate-entry',
  'duplicate-module',
  'invalid-declaration-kind',
  'invalid-dependency',
  'invalid-entry',
  'invalid-module',
  'missing-dependency',
  'top-level-await',
  'unexpected-dependency',
  'unreachable-module',
  'unsupported-default-expression-order',
]);

const compilerModuleEvaluationVariableDeclarationKinds = new Set(['const', 'let', 'var']);
