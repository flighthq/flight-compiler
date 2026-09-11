import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
  normalizePathPortable,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleEvaluationModulePlan,
  CompilerModuleFacadeFailure,
  CompilerModuleFacadeFailureCode,
  CompilerModuleFacadeHop,
  CompilerModuleFacadeIdentity,
  CompilerModuleFacadeInput,
  CompilerModuleFacadeLane,
  CompilerModuleFacadePlan,
  CompilerModuleFacadeRoute,
  CompilerModuleFacadeSlot,
  CompilerModuleFacadeSource,
  CompilerModuleIdentity,
  IrBindingIdentity,
  IrBindingPattern,
  IrExport,
  IrModule,
  IrTypeBindingIdentity,
} from '../../compiler-types/src/index.js';
import { createCompilerModuleFacadeIdentities } from './compilerModuleFacadeIdentity.js';

interface CompilerModuleFacadeRecord {
  readonly dependencies: Map<string, CompilerModuleFacadeDependencyRoute[]>;
  readonly evaluation: Readonly<CompilerModuleEvaluationModulePlan>;
  readonly identity: CompilerModuleIdentity;
  readonly identityKey: string;
  readonly module: Readonly<IrModule>;
}

interface CompilerModuleFacadeDependencyRoute {
  readonly importedNames?: readonly string[] | undefined;
  readonly target: CompilerModuleFacadeRecord;
}

interface CompilerModuleFacadeResolution {
  readonly route: CompilerModuleFacadeRoute;
  readonly via: readonly CompilerModuleFacadeHop[];
}

interface CompilerModuleFacadeCandidate {
  readonly exported: Readonly<Exclude<IrExport, { kind: 'all' }>>;
  readonly index: number;
}

export function createCompilerModuleFacadePlan(input: Readonly<CompilerModuleFacadeInput>): CompilerModuleFacadePlan {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.modules)) {
    throw createCompilerModuleFacadeLoweringFailure(
      'invalid-facade-module',
      'modules',
      'Module facade lowering requires a module array',
    );
  }
  if (input.evaluation === null || typeof input.evaluation !== 'object') {
    throw createCompilerModuleFacadeLoweringFailure(
      'invalid-facade-evaluation',
      'evaluation',
      'Module facade lowering requires a versioned module evaluation plan',
    );
  }
  if (input.evaluation.schema !== 'flight-compiler-module-evaluation/1' || !Array.isArray(input.evaluation.modules)) {
    throw createCompilerModuleFacadeLoweringFailure(
      'invalid-facade-evaluation',
      'evaluation',
      'Module facade lowering requires a versioned module evaluation plan',
    );
  }
  const records = createCompilerModuleFacadeRecords(input.modules, input.evaluation.modules);
  connectCompilerModuleFacadeRecords(records);
  const modules = [...records.values()]
    .sort((left, right) => compareTextCodeUnits(left.identityKey, right.identityKey))
    .map((record) => ({
      module: record.identity,
      slots: createCompilerModuleFacadeSlots(record),
    }));
  return cloneCompilerModuleFacadeValue({
    modules,
    schema: 'flight-compiler-module-facade/1' as const,
    semantics: {
      bindingAccess: 'live' as const,
      explicitPrecedence: 'named-over-star' as const,
      starAmbiguity: 'refuse-distinct-resolutions' as const,
      starDefault: 'excluded' as const,
      typeValueLanes: 'independent' as const,
    },
  });
}

function cloneCompilerModuleFacadeValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerModuleFacadeValue(clone, new WeakSet());
  return clone;
}

function collectCompilerModuleFacadeBindingPattern(pattern: Readonly<IrBindingPattern>): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const nested =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) =>
          element ? collectCompilerModuleFacadeBindingPattern(element.pattern) : [],
        )
      : pattern.properties.flatMap((property) => collectCompilerModuleFacadeBindingPattern(property.pattern));
  return pattern.rest ? [...nested, ...collectCompilerModuleFacadeBindingPattern(pattern.rest)] : nested;
}

function collectCompilerModuleFacadeExportNames(
  record: Readonly<CompilerModuleFacadeRecord>,
  active: ReadonlySet<string>,
): ReadonlySet<string> {
  if (active.has(record.identityKey)) return new Set();
  const next = new Set(active).add(record.identityKey);
  const names = new Set<string>();
  for (const exported of record.module.exports) {
    if (exported.kind === 'all') {
      const target = getCompilerModuleFacadeDependency(record, exported.specifier);
      for (const name of collectCompilerModuleFacadeExportNames(target, next)) {
        if (name !== 'default') names.add(name);
      }
    } else {
      names.add(exported.kind === 'default' ? 'default' : exported.exported);
    }
  }
  return names;
}

function connectCompilerModuleFacadeRecords(records: ReadonlyMap<string, CompilerModuleFacadeRecord>): void {
  for (const record of records.values()) {
    const expected = new Set<string>();
    for (const imported of record.module.imports) expected.add(imported.specifier);
    for (const exported of record.module.exports) {
      if ('specifier' in exported) expected.add(exported.specifier);
    }
    for (const dependency of record.evaluation.dependencies) {
      if (normalizeCompilerModuleFacadeIdentityKey(dependency.importer) !== record.identityKey) {
        throw createCompilerModuleFacadeLoweringFailure(
          'invalid-facade-evaluation',
          `${record.identityKey}:dependencies`,
          'Module facade evaluation dependency is malformed or has the wrong importer',
        );
      }
      if (typeof dependency.specifier !== 'string' || dependency.specifier.length === 0) {
        throw createCompilerModuleFacadeLoweringFailure(
          'invalid-facade-evaluation',
          `${record.identityKey}:dependencies`,
          'Module facade evaluation dependency is malformed or has the wrong importer',
        );
      }
      if (dependency.evaluation !== 'runtime' && dependency.evaluation !== 'type-only') {
        throw createCompilerModuleFacadeLoweringFailure(
          'invalid-facade-evaluation',
          `${record.identityKey}:dependencies`,
          'Module facade evaluation dependency is malformed or has the wrong importer',
        );
      }
      const runtime = isCompilerModuleFacadeRuntimeDependency(record.module, dependency);
      if ((dependency.evaluation === 'runtime') !== runtime) {
        throw createCompilerModuleFacadeLoweringFailure(
          'invalid-facade-evaluation',
          `${record.identityKey}:${dependency.specifier}`,
          `Module facade dependency evaluation kind conflicts with source requests for ${dependency.specifier}`,
        );
      }
      const target = records.get(normalizeCompilerModuleFacadeIdentityKey(dependency.target));
      if (!target) {
        throw createCompilerModuleFacadeLoweringFailure(
          'missing-facade-dependency',
          `${record.identityKey}:${dependency.specifier}`,
          `Module facade dependency target is absent for ${dependency.specifier}`,
        );
      }
      const routes = record.dependencies.get(dependency.specifier) ?? [];
      if (
        routes.some(
          (route) =>
            route.importedNames === undefined ||
            dependency.importedNames === undefined ||
            route.importedNames.some((name) => dependency.importedNames!.includes(name)),
        )
      ) {
        throw createCompilerModuleFacadeLoweringFailure(
          'invalid-facade-evaluation',
          `${record.identityKey}:${dependency.specifier}`,
          `Module facade evaluation duplicates dependency ${dependency.specifier}`,
        );
      }
      record.dependencies.set(dependency.specifier, [
        ...routes,
        {
          ...(dependency.importedNames ? { importedNames: dependency.importedNames } : {}),
          target,
        },
      ]);
    }
    for (const specifier of expected) {
      if (!record.dependencies.has(specifier)) {
        throw createCompilerModuleFacadeLoweringFailure(
          'missing-facade-dependency',
          `${record.identityKey}:${specifier}`,
          `Module facade dependency is absent for ${specifier}`,
        );
      }
    }
    for (const specifier of record.dependencies.keys()) {
      if (!expected.has(specifier)) {
        throw createCompilerModuleFacadeLoweringFailure(
          'invalid-facade-evaluation',
          `${record.identityKey}:${specifier}`,
          `Module facade evaluation contains an unrequested dependency ${specifier}`,
        );
      }
    }
  }
}

function createCompilerModuleFacadeIdentityValue(
  record: Readonly<CompilerModuleFacadeRecord>,
  exportName: string,
  lane: CompilerModuleFacadeLane,
  source: Readonly<CompilerModuleFacadeSource>,
): CompilerModuleFacadeIdentity {
  const identity = `module-facade:${normalizeCompilerStructuralValueCanonical({
    exportName,
    lane,
    module: record.identity,
  })}`;
  return { exportName, identity, lane, module: record.identity, source };
}

function createCompilerModuleFacadeLoweringFailure(
  code: CompilerModuleFacadeFailureCode,
  subject: string,
  message: string,
): CompilerModuleFacadeFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-module-facade' as const,
    subject,
  });
  failure.name = 'CompilerModuleFacadeError';
  return failure;
}

function createCompilerModuleFacadeRecords(
  modules: readonly Readonly<IrModule>[],
  evaluationModules: readonly Readonly<CompilerModuleEvaluationModulePlan>[],
): ReadonlyMap<string, CompilerModuleFacadeRecord> {
  const modulesByKey = new Map<string, Readonly<IrModule>>();
  for (const [index, module] of modules.entries()) {
    const identity = normalizeCompilerModuleFacadeIdentity(module, `modules[${String(index)}]`);
    const key = normalizeCompilerModuleFacadeIdentityKey(identity);
    if (modulesByKey.has(key)) {
      throw createCompilerModuleFacadeLoweringFailure(
        'invalid-facade-module',
        key,
        `Module facade input duplicates ${identity.packageName}/${identity.source}`,
      );
    }
    if (!Array.isArray(module.imports) || !Array.isArray(module.exports) || !Array.isArray(module.declarations)) {
      throw createCompilerModuleFacadeLoweringFailure(
        'invalid-facade-module',
        key,
        'Module facade input must contain import, export, and declaration arrays',
      );
    }
    createCompilerModuleFacadeIdentities(module);
    modulesByKey.set(key, module);
  }
  const records = new Map<string, CompilerModuleFacadeRecord>();
  for (const [index, evaluation] of evaluationModules.entries()) {
    if (evaluation === null || typeof evaluation !== 'object') {
      throw createCompilerModuleFacadeLoweringFailure(
        'invalid-facade-evaluation',
        `evaluation.modules[${String(index)}]`,
        'Module facade evaluation module is malformed',
      );
    }
    if (!Array.isArray(evaluation.dependencies)) {
      throw createCompilerModuleFacadeLoweringFailure(
        'invalid-facade-evaluation',
        `evaluation.modules[${String(index)}]`,
        'Module facade evaluation module is malformed',
      );
    }
    const identity = normalizeCompilerModuleFacadeIdentity(
      evaluation.module,
      `evaluation.modules[${String(index)}].module`,
    );
    const identityKey = normalizeCompilerModuleFacadeIdentityKey(identity);
    const module = modulesByKey.get(identityKey);
    if (!module || records.has(identityKey)) {
      throw createCompilerModuleFacadeLoweringFailure(
        'mismatched-facade-module',
        identityKey,
        `Module facade evaluation does not match exactly one input module: ${identityKey}`,
      );
    }
    records.set(identityKey, {
      dependencies: new Map(),
      evaluation,
      identity,
      identityKey,
      module,
    });
  }
  if (records.size !== modulesByKey.size) {
    const missing = [...modulesByKey.keys()].find((key) => !records.has(key))!;
    throw createCompilerModuleFacadeLoweringFailure(
      'mismatched-facade-module',
      missing,
      `Module facade evaluation omits input module ${missing}`,
    );
  }
  return records;
}

function createCompilerModuleFacadeSlots(
  record: Readonly<CompilerModuleFacadeRecord>,
): readonly CompilerModuleFacadeSlot[] {
  const names = [...collectCompilerModuleFacadeExportNames(record, new Set())].sort(compareTextCodeUnits);
  const slots: CompilerModuleFacadeSlot[] = [];
  for (const exportName of names) {
    for (const lane of compilerModuleFacadeLanes) {
      const resolved = resolveCompilerModuleFacadeExport(record, exportName, lane, new Set());
      if (!resolved) continue;
      const source = getCompilerModuleFacadeSource(record, exportName, lane, resolved);
      slots.push({
        ...createCompilerModuleFacadeIdentityValue(record, exportName, lane, source),
        route: resolved.route,
        via: resolved.via,
      });
    }
    assertCompilerModuleFacadeNamedExportResolution(record, exportName);
  }
  return slots.sort((left, right) => compareTextCodeUnits(left.identity, right.identity));
}

function assertCompilerModuleFacadeNamedExportResolution(
  record: Readonly<CompilerModuleFacadeRecord>,
  exportName: string,
): void {
  const candidates = getCompilerModuleFacadeExplicitCandidates(record, exportName);
  if (candidates.length === 0) return;
  for (const candidate of candidates) {
    const resolved = getCompilerModuleFacadeCandidateLanes(candidate.exported).some((lane) => {
      const resolutionKey = normalizeCompilerStructuralValueCanonical({
        exportName,
        lane,
        module: record.identity,
      });
      return resolveCompilerModuleFacadeCandidate(record, candidate, exportName, lane, new Set([resolutionKey]));
    });
    if (resolved) continue;
    throw createCompilerModuleFacadeLoweringFailure(
      'missing-facade-export',
      `${record.identityKey}:exports[${String(candidate.index)}]`,
      `Module facade export ${exportName} does not resolve in an expected lane`,
    );
  }
}

function freezeCompilerModuleFacadeValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerModuleFacadeValue(child, seen);
  Object.freeze(value);
}

function getCompilerModuleFacadeCandidateLanes(exported: Readonly<IrExport>): readonly CompilerModuleFacadeLane[] {
  if (exported.kind === 'default') return ['value'];
  if (exported.kind === 'namespace') return exported.typeOnly ? ['type'] : ['value'];
  if (exported.kind === 'all' || exported.kind === 'reexport') {
    return exported.typeOnly ? ['type'] : ['type', 'value'];
  }
  if (exported.typeOnly) return ['type'];
  if (exported.binding.kind === 'class' || exported.binding.kind === 'enum' || exported.binding.kind === 'import') {
    return ['type', 'value'];
  }
  return ['value'];
}

function getCompilerModuleFacadeDependency(
  record: Readonly<CompilerModuleFacadeRecord>,
  specifier: string,
  importedName?: string,
): CompilerModuleFacadeRecord {
  const routes = record.dependencies.get(specifier) ?? [];
  const matching = routes.filter(
    (route) =>
      route.importedNames === undefined || (importedName !== undefined && route.importedNames.includes(importedName)),
  );
  if (matching.length !== 1) {
    throw createCompilerModuleFacadeLoweringFailure(
      'missing-facade-dependency',
      `${record.identityKey}:${specifier}`,
      `Module facade dependency does not resolve exactly once for ${specifier}`,
    );
  }
  return matching[0]!.target;
}

function getCompilerModuleFacadeExplicitCandidates(
  record: Readonly<CompilerModuleFacadeRecord>,
  exportName: string,
): readonly CompilerModuleFacadeCandidate[] {
  return record.module.exports.flatMap((exported, index) => {
    if (exported.kind === 'all') return [];
    const candidateName = exported.kind === 'default' ? 'default' : exported.exported;
    return candidateName === exportName ? [{ exported, index }] : [];
  });
}

function getCompilerModuleFacadeImport(
  record: Readonly<CompilerModuleFacadeRecord>,
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
): Readonly<{ imported: string; specifier: string }> | undefined {
  const matches = record.module.imports.flatMap((imported) =>
    imported.bindings
      .filter((candidate) => candidate.binding.id === binding.id)
      .map((candidate) => ({ imported: candidate.imported, specifier: imported.specifier })),
  );
  if (matches.length > 1) {
    throw createCompilerModuleFacadeLoweringFailure(
      'missing-facade-binding',
      binding.id,
      `Module facade import binding is introduced more than once: ${binding.id}`,
    );
  }
  return matches[0];
}

function getCompilerModuleFacadeIntroducedBinding(
  record: Readonly<CompilerModuleFacadeRecord>,
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
): IrBindingIdentity | IrTypeBindingIdentity | undefined {
  const imports = record.module.imports.flatMap((imported) => imported.bindings.map((candidate) => candidate.binding));
  const declarations: (IrBindingIdentity | IrTypeBindingIdentity)[] = [];
  for (const declaration of record.module.declarations) {
    if (declaration.kind !== 'variable') {
      declarations.push(declaration.binding);
    } else if ('binding' in declaration) {
      declarations.push(declaration.binding);
    } else {
      declarations.push(...collectCompilerModuleFacadeBindingPattern(declaration.pattern));
    }
  }
  return [...imports, ...declarations].find(
    (candidate) =>
      candidate.id === binding.id &&
      normalizeCompilerStructuralValueCanonical(candidate) === normalizeCompilerStructuralValueCanonical(binding),
  );
}

function getCompilerModuleFacadeSource(
  record: Readonly<CompilerModuleFacadeRecord>,
  exportName: string,
  lane: CompilerModuleFacadeLane,
  resolution: Readonly<CompilerModuleFacadeResolution>,
): CompilerModuleFacadeSource {
  const firstHop = resolution.via[0];
  if (
    firstHop?.kind === 'star-reexport' &&
    normalizeCompilerModuleFacadeIdentityKey(firstHop.module) === record.identityKey
  ) {
    return { kind: 'module-all', specifier: firstHop.specifier };
  }
  const explicit = getCompilerModuleFacadeExplicitCandidates(record, exportName).find((candidate) =>
    getCompilerModuleFacadeCandidateLanes(candidate.exported).includes(lane),
  )!.exported;
  switch (explicit.kind) {
    case 'default':
      return { kind: 'local-expression' };
    case 'local':
      return { bindingId: explicit.binding.id, kind: 'local-binding' };
    case 'namespace':
      return { kind: 'module-namespace', specifier: explicit.specifier };
    case 'reexport':
      return { imported: explicit.imported, kind: 'module-binding', specifier: explicit.specifier };
  }
}

function isCompilerModuleFacadeRuntimeRequest(module: Readonly<IrModule>, specifier: string): boolean {
  return (
    module.imports.some((imported) => imported.specifier === specifier && !imported.typeOnly) ||
    module.exports.some((exported) => 'specifier' in exported && exported.specifier === specifier && !exported.typeOnly)
  );
}

function isCompilerModuleFacadeRuntimeDependency(
  module: Readonly<IrModule>,
  dependency: Readonly<CompilerModuleEvaluationModulePlan['dependencies'][number]>,
): boolean {
  if (!dependency.importedNames) return isCompilerModuleFacadeRuntimeRequest(module, dependency.specifier);
  const importedNames = new Set(dependency.importedNames);
  return module.imports.some(
    (imported) =>
      imported.specifier === dependency.specifier &&
      !imported.typeOnly &&
      imported.bindings.some((binding) => !binding.typeOnly && importedNames.has(binding.imported)),
  );
}

function normalizeCompilerModuleFacadeIdentity(value: unknown, subject: string): CompilerModuleIdentity {
  if (value === null) throwInvalidCompilerModuleFacadeIdentity(subject);
  if (typeof value !== 'object') throwInvalidCompilerModuleFacadeIdentity(subject);
  if (!('name' in value)) throwInvalidCompilerModuleFacadeIdentity(subject);
  if (typeof value.name !== 'string') throwInvalidCompilerModuleFacadeIdentity(subject);
  if (value.name.length === 0) throwInvalidCompilerModuleFacadeIdentity(subject);
  if (!('packageName' in value)) throwInvalidCompilerModuleFacadeIdentity(subject);
  if (typeof value.packageName !== 'string') throwInvalidCompilerModuleFacadeIdentity(subject);
  if (value.packageName.length === 0) throwInvalidCompilerModuleFacadeIdentity(subject);
  if (!('source' in value)) throwInvalidCompilerModuleFacadeIdentity(subject);
  if (typeof value.source !== 'string') throwInvalidCompilerModuleFacadeIdentity(subject);
  if (value.source.length === 0) throwInvalidCompilerModuleFacadeIdentity(subject);
  return { name: value.name, packageName: value.packageName, source: normalizePathPortable(value.source) };
}

function normalizeCompilerModuleFacadeIdentityKey(identity: Readonly<CompilerModuleIdentity>): string {
  return normalizeCompilerStructuralValueCanonical({
    name: identity.name,
    packageName: identity.packageName,
    source: normalizePathPortable(identity.source),
  });
}

function prependCompilerModuleFacadeHop(
  resolution: Readonly<CompilerModuleFacadeResolution>,
  hop: CompilerModuleFacadeHop,
): CompilerModuleFacadeResolution {
  return { route: resolution.route, via: [hop, ...resolution.via] };
}

function resolveCompilerModuleFacadeCandidate(
  record: Readonly<CompilerModuleFacadeRecord>,
  candidate: Readonly<CompilerModuleFacadeCandidate>,
  exportName: string,
  lane: CompilerModuleFacadeLane,
  active: ReadonlySet<string>,
): CompilerModuleFacadeResolution | undefined {
  const exported = candidate.exported;
  switch (exported.kind) {
    case 'default':
      return {
        route: { kind: 'expression', module: record.identity, path: ['exports', candidate.index, 'expression'] },
        via: [],
      };
    case 'local': {
      const binding = getCompilerModuleFacadeIntroducedBinding(record, exported.binding);
      if (!binding) {
        throw createCompilerModuleFacadeLoweringFailure(
          'missing-facade-binding',
          exported.binding.id,
          `Module facade local binding is not introduced: ${exported.binding.id}`,
        );
      }
      if (binding.kind !== 'import') return { route: { binding, kind: 'binding', module: record.identity }, via: [] };
      const imported = getCompilerModuleFacadeImport(record, binding)!;
      const target = getCompilerModuleFacadeDependency(record, imported.specifier, imported.imported);
      const hop: CompilerModuleFacadeHop = {
        kind: 'import',
        module: record.identity,
        specifier: imported.specifier,
        target: target.identity,
      };
      if (imported.imported === '*') {
        return { route: { kind: 'namespace', module: target.identity }, via: [hop] };
      }
      const resolved = resolveCompilerModuleFacadeExport(target, imported.imported, lane, active);
      return resolved ? prependCompilerModuleFacadeHop(resolved, hop) : undefined;
    }
    case 'namespace': {
      const target = getCompilerModuleFacadeDependency(record, exported.specifier);
      return {
        route: { kind: 'namespace', module: target.identity },
        via: [
          {
            kind: 'namespace-reexport',
            module: record.identity,
            specifier: exported.specifier,
            target: target.identity,
          },
        ],
      };
    }
    case 'reexport': {
      const target = getCompilerModuleFacadeDependency(record, exported.specifier, exported.imported);
      const resolved = resolveCompilerModuleFacadeExport(target, exported.imported, lane, active);
      return resolved
        ? prependCompilerModuleFacadeHop(resolved, {
            kind: 'named-reexport',
            module: record.identity,
            specifier: exported.specifier,
            target: target.identity,
          })
        : undefined;
    }
  }
}

function resolveCompilerModuleFacadeExport(
  record: Readonly<CompilerModuleFacadeRecord>,
  exportName: string,
  lane: CompilerModuleFacadeLane,
  active: ReadonlySet<string>,
): CompilerModuleFacadeResolution | undefined {
  const resolutionKey = normalizeCompilerStructuralValueCanonical({ exportName, lane, module: record.identity });
  if (active.has(resolutionKey)) return undefined;
  const next = new Set(active).add(resolutionKey);
  const explicit = getCompilerModuleFacadeExplicitCandidates(record, exportName);
  const eligible = explicit.filter((candidate) =>
    getCompilerModuleFacadeCandidateLanes(candidate.exported).includes(lane),
  );
  const explicitResolutions = eligible.flatMap((candidate) => {
    const resolved = resolveCompilerModuleFacadeCandidate(record, candidate, exportName, lane, next);
    return resolved ? [resolved] : [];
  });
  if (explicitResolutions.length > 1) {
    throw createCompilerModuleFacadeLoweringFailure(
      'duplicate-facade-identity',
      resolutionKey,
      `Module facade has multiple explicit ${lane} exports named ${exportName}`,
    );
  }
  if (explicitResolutions[0]) return explicitResolutions[0];
  if (exportName === 'default') return undefined;
  const starResolutions: CompilerModuleFacadeResolution[] = [];
  for (const exported of record.module.exports) {
    if (exported.kind !== 'all' || !getCompilerModuleFacadeCandidateLanes(exported).includes(lane)) continue;
    const target = getCompilerModuleFacadeDependency(record, exported.specifier);
    const resolved = resolveCompilerModuleFacadeExport(target, exportName, lane, next);
    if (!resolved) continue;
    starResolutions.push(
      prependCompilerModuleFacadeHop(resolved, {
        kind: 'star-reexport',
        module: record.identity,
        specifier: exported.specifier,
        target: target.identity,
      }),
    );
  }
  const distinct = new Map<string, CompilerModuleFacadeResolution>();
  for (const resolution of starResolutions) {
    const key = normalizeCompilerStructuralValueCanonical(resolution.route);
    if (!distinct.has(key)) distinct.set(key, resolution);
  }
  if (distinct.size > 1) {
    throw createCompilerModuleFacadeLoweringFailure(
      'ambiguous-facade-star',
      resolutionKey,
      `Module facade star exports resolve ${exportName} to distinct ${lane} bindings`,
    );
  }
  return distinct.values().next().value;
}

function throwInvalidCompilerModuleFacadeIdentity(subject: string): never {
  throw createCompilerModuleFacadeLoweringFailure(
    'invalid-facade-module',
    subject,
    `Module facade identity is malformed at ${subject}`,
  );
}

const compilerModuleFacadeLanes = ['type', 'value'] as const;
