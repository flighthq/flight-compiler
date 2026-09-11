import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerTypeValueIdentityAnalysis,
  CompilerTypeValueIdentityAnalyzer,
  IrDeclaration,
  IrModule,
  IrType,
  IrTypeParameter,
} from '../../compiler-types/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from './compilerStructuralTypeSubstitution.js';

type IdentityDeclaration = Readonly<Extract<IrDeclaration, { kind: 'class' | 'enum' | 'interface' | 'typeAlias' }>>;

interface IdentityDeclarationLocation {
  readonly declaration: IdentityDeclaration;
  readonly identity: string;
  readonly module: IdentityModuleRecord;
}

interface IdentityExportResolution {
  readonly cycle: boolean;
  readonly locations: readonly IdentityDeclarationLocation[];
  readonly unresolved: boolean;
}

interface IdentityModuleRecord {
  readonly declarations: ReadonlyMap<string, IdentityDeclarationLocation>;
  readonly identity: string;
  readonly importsByBindingId: ReadonlyMap<string, readonly IdentityImport[]>;
  readonly module: Readonly<IrModule>;
  readonly source: string;
  readonly typeParameters: ReadonlyMap<string, Readonly<IrTypeParameter>>;
}

interface IdentityImport {
  readonly imported: string;
  readonly specifier: string;
}

interface IdentityModuleSet {
  readonly exportResolutions: Map<string, IdentityExportResolution>;
  readonly modules: readonly IdentityModuleRecord[];
  readonly modulesByIdentity: ReadonlyMap<string, IdentityModuleRecord>;
  readonly modulesByPackageSource: ReadonlyMap<string, readonly IdentityModuleRecord[]>;
  readonly namedBindingOwnersByBindingId: ReadonlyMap<string, readonly IdentityModuleRecord[]>;
  readonly resolutionTargetsBySpecifier: ReadonlyMap<string, IdentityResolutionTargets>;
  readonly typeParameterOwnersByBindingId: ReadonlyMap<string, readonly IdentityModuleRecord[]>;
}

interface IdentityResolutionTargets {
  readonly fallback: readonly string[];
  readonly byImporter: ReadonlyMap<string, readonly string[]>;
}

interface TypeValueIdentityContext {
  readonly active: ReadonlySet<string>;
  readonly module: IdentityModuleRecord;
  readonly moduleSet: IdentityModuleSet;
}

export function analyzeIrTypeValueIdentity(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[] = [module],
  resolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlan,
): CompilerTypeValueIdentityAnalysis {
  return createIrTypeValueIdentityAnalyzer(modules, resolution).analyze(type, module);
}

export function createIrTypeValueIdentityAnalyzer(
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlan,
): CompilerTypeValueIdentityAnalyzer {
  const moduleSet = createIdentityModuleSet(modules, resolution);
  return Object.freeze({
    analyze(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getIdentityModuleRecord(module, moduleSet);
      if (!subject) throw new TypeError('Type value identity subject must belong to the explicit module set');
      return analyzeIrTypeValueIdentityInternal(type, { active: new Set(), module: subject, moduleSet });
    },
    schema: 'flight-compiler-type-value-identity-analyzer/1',
  });
}

function analyzeIrTypeValueIdentityInternal(
  type: Readonly<IrType>,
  context: Readonly<TypeValueIdentityContext>,
): CompilerTypeValueIdentityAnalysis {
  switch (type.kind) {
    case 'array':
    case 'function':
    case 'object':
    case 'tuple':
      return createCompilerTypeValueIdentityAnalysis('reference', 'intrinsic-reference');
    case 'intersection':
    case 'union':
      return analyzeIrCompoundTypeValueIdentity(type.types, context);
    case 'keyof':
      return createCompilerTypeValueIdentityAnalysis('value', 'intrinsic-value');
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
      return createCompilerTypeValueIdentityAnalysis('value', 'intrinsic-value');
    case 'named':
      return analyzeIrNamedTypeValueIdentity(type, context);
    case 'typeOf':
      return analyzeIrTypeOfValueIdentity(type, context);
    case 'indexedAccess':
      return createCompilerTypeValueIdentityAnalysis('indeterminate', 'type-operator');
    case 'unknown':
      return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unknown-type');
  }
}

function analyzeIrCompoundTypeValueIdentity(
  types: readonly Readonly<IrType>[],
  context: Readonly<TypeValueIdentityContext>,
): CompilerTypeValueIdentityAnalysis {
  const analyses = types.map((type) => analyzeIrTypeValueIdentityInternal(type, context));
  const identity = analyses[0]!.identity;
  if (analyses.some((analysis) => analysis.identity !== identity)) {
    return createCompilerTypeValueIdentityAnalysis('indeterminate', 'ambiguous-compound');
  }
  if (identity === 'indeterminate') {
    const reason = analyses[0]!.reason;
    return analyses.every((analysis) => analysis.reason === reason)
      ? analyses[0]!
      : createCompilerTypeValueIdentityAnalysis('indeterminate', 'ambiguous-compound');
  }
  return createCompilerTypeValueIdentityAnalysis(identity, 'homogeneous-compound');
}

function analyzeIrNamedTypeValueIdentity(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: Readonly<TypeValueIdentityContext>,
): CompilerTypeValueIdentityAnalysis {
  const reference = type.reference;
  if (reference.kind === 'ambient') {
    const utility = compilerAmbientIdentityPreservingUtilities.get(reference.name);
    if (utility !== undefined) {
      return type.typeArguments.length === utility && type.typeArguments[0]
        ? analyzeIrTypeValueIdentityInternal(type.typeArguments[0], context)
        : createCompilerTypeValueIdentityAnalysis('indeterminate', 'invalid-type-application');
    }
    if (reference.name === 'Record') {
      return type.typeArguments.length === 2
        ? createCompilerTypeValueIdentityAnalysis('reference', 'known-ambient-reference')
        : createCompilerTypeValueIdentityAnalysis('indeterminate', 'invalid-type-application');
    }
    if (compilerUnsupportedAmbientIdentityUtilities.has(reference.name)) {
      return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unsupported-ambient-utility');
    }
    return compilerKnownAmbientReferenceTypes.has(reference.name)
      ? createCompilerTypeValueIdentityAnalysis('reference', 'known-ambient-reference')
      : createCompilerTypeValueIdentityAnalysis('indeterminate', 'unresolved-reference');
  }
  if (reference.binding.kind === 'typeParameter') {
    if (reference.path.length > 0 || type.typeArguments.length > 0) {
      return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unresolved-reference');
    }
    return analyzeIrTypeParameterValueIdentity(reference.binding.id, context);
  }
  const resolution = getIdentityDeclarationResolution(type, context.module, context.moduleSet);
  if (resolution.kind !== 'location') {
    return createCompilerTypeValueIdentityAnalysis(
      'indeterminate',
      resolution.cycle ? 'cyclic-reference' : 'unresolved-reference',
    );
  }
  const location = resolution.location;
  switch (location.declaration.kind) {
    case 'class':
    case 'interface':
      return createCompilerTypeValueIdentityAnalysis('reference', 'declared-reference');
    case 'enum':
      return createCompilerTypeValueIdentityAnalysis('value', 'declared-value');
    case 'typeAlias':
      return analyzeIrTypeAliasValueIdentity(type, location.declaration, location, context);
  }
}

function analyzeIrTypeAliasValueIdentity(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  declaration: Readonly<Extract<IrDeclaration, { kind: 'typeAlias' }>>,
  location: Readonly<IdentityDeclarationLocation>,
  context: Readonly<TypeValueIdentityContext>,
): CompilerTypeValueIdentityAnalysis {
  if (context.active.has(location.identity)) {
    return createCompilerTypeValueIdentityAnalysis('indeterminate', 'cyclic-reference');
  }
  let resolved: IrType;
  try {
    const plan = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
    resolved = resolveIrTypeStructuralSubstitution(declaration.type, plan);
  } catch (error) {
    if (!isCompilerStructuralTypeSubstitutionFailure(error)) throw error;
    return createCompilerTypeValueIdentityAnalysis('indeterminate', 'invalid-type-application');
  }
  return analyzeIrTypeValueIdentityInternal(resolved, {
    active: new Set(context.active).add(location.identity),
    module: location.module,
    moduleSet: context.moduleSet,
  });
}

function analyzeIrTypeOfValueIdentity(
  type: Readonly<Extract<IrType, { kind: 'typeOf' }>>,
  context: Readonly<TypeValueIdentityContext>,
): CompilerTypeValueIdentityAnalysis {
  if (type.reference.kind === 'ambient') {
    return compilerKnownAmbientReferenceValues.has(type.reference.name)
      ? createCompilerTypeValueIdentityAnalysis('reference', 'known-ambient-reference')
      : createCompilerTypeValueIdentityAnalysis('indeterminate', 'unresolved-reference');
  }
  if (type.reference.path.length > 0) {
    return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unresolved-reference');
  }
  const bindingId = type.reference.binding.id;
  const declaration = context.module.module.declarations.find(
    (candidate) => 'binding' in candidate && candidate.binding.id === bindingId,
  );
  if (!declaration) return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unresolved-reference');
  switch (declaration.kind) {
    case 'class':
    case 'enum':
    case 'function':
      return createCompilerTypeValueIdentityAnalysis('reference', 'declared-reference');
    case 'variable':
      return declaration.type
        ? analyzeIrTypeValueIdentityInternal(declaration.type, context)
        : createCompilerTypeValueIdentityAnalysis('indeterminate', 'unknown-type');
    case 'interface':
    case 'typeAlias':
      return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unresolved-reference');
  }
}

function analyzeIrTypeParameterValueIdentity(
  bindingId: string,
  context: Readonly<TypeValueIdentityContext>,
): CompilerTypeValueIdentityAnalysis {
  const local = context.module.typeParameters.get(bindingId);
  const owners = context.moduleSet.typeParameterOwnersByBindingId.get(bindingId) ?? [];
  const owner = local ? context.module : owners.length === 1 ? owners[0] : undefined;
  const parameter = local ?? owner?.typeParameters.get(bindingId);
  if (!owner || !parameter?.constraint) {
    return createCompilerTypeValueIdentityAnalysis('indeterminate', 'unconstrained-type-parameter');
  }
  const identity = `${owner.identity}\0type-parameter\0${bindingId}`;
  if (context.active.has(identity)) {
    return createCompilerTypeValueIdentityAnalysis('indeterminate', 'cyclic-reference');
  }
  return analyzeIrTypeValueIdentityInternal(parameter.constraint, {
    ...context,
    active: new Set(context.active).add(identity),
    module: owner,
  });
}

function getIdentityDeclarationResolution(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  module: Readonly<IdentityModuleRecord>,
  moduleSet: Readonly<IdentityModuleSet>,
):
  | Readonly<{ cycle: boolean; kind: 'indeterminate' }>
  | Readonly<{ kind: 'location'; location: IdentityDeclarationLocation }> {
  if (type.reference.kind !== 'binding') return { cycle: false, kind: 'indeterminate' };
  const reference = type.reference;
  const binding = reference.binding;
  const local = module.declarations.has(binding.id) || module.importsByBindingId.has(binding.id);
  const owners = moduleSet.namedBindingOwnersByBindingId.get(binding.id) ?? [];
  const owner = local ? module : owners.length === 1 ? owners[0] : undefined;
  if (!owner) return { cycle: false, kind: 'indeterminate' };
  if (binding.kind !== 'import') {
    if (reference.path.length > 0) return { cycle: false, kind: 'indeterminate' };
    const location = owner.declarations.get(binding.id);
    return location ? { kind: 'location', location } : { cycle: false, kind: 'indeterminate' };
  }
  const imported = owner.importsByBindingId.get(binding.id) ?? [];
  const exportNames = imported.flatMap(({ imported: importedName, specifier }) => {
    if (importedName === '*' && reference.path.length === 1) {
      return [{ exportName: reference.path[0]!, specifier }];
    }
    return reference.path.length === 0 && importedName !== '*' ? [{ exportName: importedName, specifier }] : [];
  });
  const resolutions = exportNames.map(({ exportName, specifier }) =>
    getIdentityExportResolution(owner, specifier, exportName, moduleSet, new Set()),
  );
  const locations = deduplicateIdentityDeclarationLocations(resolutions.flatMap((resolution) => resolution.locations));
  if (locations.length === 1) return { kind: 'location', location: locations[0]! };
  return {
    cycle: resolutions.some((resolution) => resolution.cycle),
    kind: 'indeterminate',
  };
}

function getIdentityExportResolution(
  from: Readonly<IdentityModuleRecord>,
  specifier: string,
  exportName: string,
  moduleSet: Readonly<IdentityModuleSet>,
  ancestors: ReadonlySet<string>,
): IdentityExportResolution {
  const targets = getIdentitySpecifierModules(from, specifier, moduleSet);
  const resolutions = targets.map((target) =>
    getIdentityModuleExportResolution(target, exportName, moduleSet, ancestors),
  );
  return {
    cycle: resolutions.some((resolution) => resolution.cycle),
    locations: deduplicateIdentityDeclarationLocations(resolutions.flatMap((resolution) => resolution.locations)),
    unresolved: targets.length === 0 || resolutions.some((resolution) => resolution.unresolved),
  };
}

function getIdentityModuleExportResolution(
  module: Readonly<IdentityModuleRecord>,
  exportName: string,
  moduleSet: Readonly<IdentityModuleSet>,
  ancestors: ReadonlySet<string>,
): IdentityExportResolution {
  const query = `${module.identity}\0${exportName}`;
  const cacheable = ancestors.size === 0;
  const cached = cacheable ? moduleSet.exportResolutions.get(query) : undefined;
  if (cached) return cached;
  if (ancestors.has(query)) return { cycle: true, locations: [], unresolved: false };
  const next = new Set(ancestors).add(query);
  const locations = [...module.declarations.values()].filter(
    (location) => location.declaration.exported && location.declaration.binding.name === exportName,
  );
  const nested: IdentityExportResolution[] = [];
  for (const exported of module.module.exports) {
    switch (exported.kind) {
      case 'all':
        if (exportName !== 'default') {
          nested.push(getIdentityExportResolution(module, exported.specifier, exportName, moduleSet, next));
        }
        break;
      case 'local':
        if (exported.exported === exportName) {
          const location = module.declarations.get(exported.binding.id);
          if (location) locations.push(location);
        }
        break;
      case 'reexport':
        if (exported.exported === exportName) {
          nested.push(getIdentityExportResolution(module, exported.specifier, exported.imported, moduleSet, next));
        }
        break;
      case 'default':
      case 'namespace':
        break;
    }
  }
  const result = {
    cycle: nested.some((resolution) => resolution.cycle),
    locations: deduplicateIdentityDeclarationLocations([
      ...locations,
      ...nested.flatMap((resolution) => resolution.locations),
    ]),
    unresolved: nested.some((resolution) => resolution.unresolved),
  };
  if (cacheable) moduleSet.exportResolutions.set(query, result);
  return result;
}

function getIdentitySpecifierModules(
  from: Readonly<IdentityModuleRecord>,
  specifier: string,
  moduleSet: Readonly<IdentityModuleSet>,
): readonly IdentityModuleRecord[] {
  const candidates = getIdentitySpecifierSourceCandidates(from.source, specifier);
  const resolved = moduleSet.resolutionTargetsBySpecifier.get(specifier);
  const resolutionTargets = resolved?.byImporter.get(from.identity) ?? resolved?.fallback ?? [];
  const resultByIdentity = new Map<string, IdentityModuleRecord>();
  for (const source of candidates) {
    for (const candidate of moduleSet.modulesByPackageSource.get(`${from.module.packageName}\0${source}`) ?? []) {
      resultByIdentity.set(candidate.identity, candidate);
    }
  }
  for (const target of resolutionTargets) {
    for (const candidate of moduleSet.modulesByPackageSource.get(target) ?? []) {
      resultByIdentity.set(candidate.identity, candidate);
    }
  }
  return [...resultByIdentity.values()].sort(compareIdentityModuleRecords);
}

function getIdentitySpecifierSourceCandidates(source: string, specifier: string): ReadonlySet<string> {
  const normalized = normalizePathPortable(specifier);
  if (normalized !== '.' && normalized !== '..' && !normalized.startsWith('./') && !normalized.startsWith('../')) {
    return new Set();
  }
  const parts = source.split('/');
  parts.pop();
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return new Set();
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const resolved = parts.join('/');
  const candidates = new Set([resolved]);
  const extensions = [
    ['.cjs', '.cts'],
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
  ] as const;
  for (const [emitted, sourceExtension] of extensions) {
    if (resolved.endsWith(emitted)) candidates.add(`${resolved.slice(0, -emitted.length)}${sourceExtension}`);
  }
  if (!/\.[^/]+$/u.test(resolved)) {
    candidates.add(`${resolved}.ts`);
    candidates.add(`${resolved}/index.ts`);
  }
  return candidates;
}

function createIdentityModuleSet(
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
): IdentityModuleSet {
  if (!Array.isArray(modules)) throw new TypeError('Type value identity module set must be an array');
  validateIdentityModuleResolutionPlan(resolution);
  const records = modules.map(createIdentityModuleRecord).sort(compareIdentityModuleRecords);
  if (records.some((record, index) => index > 0 && record.identity === records[index - 1]!.identity)) {
    throw new TypeError('Type value identity module set contains a duplicate module identity');
  }
  const modulesByPackageSource = new Map<string, IdentityModuleRecord[]>();
  for (const record of records) {
    const key = `${record.module.packageName}\0${record.source}`;
    const candidates = modulesByPackageSource.get(key) ?? [];
    candidates.push(record);
    modulesByPackageSource.set(key, candidates);
  }
  const typeParameterOwnersByBindingId = new Map<string, IdentityModuleRecord[]>();
  const namedBindingOwnersByBindingId = new Map<string, IdentityModuleRecord[]>();
  for (const record of records) {
    for (const bindingId of new Set([...record.declarations.keys(), ...record.importsByBindingId.keys()])) {
      const owners = namedBindingOwnersByBindingId.get(bindingId) ?? [];
      owners.push(record);
      namedBindingOwnersByBindingId.set(bindingId, owners);
    }
    for (const bindingId of record.typeParameters.keys()) {
      const owners = typeParameterOwnersByBindingId.get(bindingId) ?? [];
      owners.push(record);
      typeParameterOwnersByBindingId.set(bindingId, owners);
    }
  }
  return {
    exportResolutions: new Map(),
    modules: records,
    modulesByIdentity: new Map(records.map((record) => [record.identity, record])),
    modulesByPackageSource,
    namedBindingOwnersByBindingId,
    resolutionTargetsBySpecifier: createIdentityResolutionTargets(resolution),
    typeParameterOwnersByBindingId,
  };
}

function createIdentityResolutionTargets(
  resolution: Readonly<CompilerModuleResolutionPlan>,
): ReadonlyMap<string, IdentityResolutionTargets> {
  const targets = new Map<string, { fallback: Set<string>; byImporter: Map<string, Set<string>> }>();
  for (const edge of resolution.edges) {
    const entry = targets.get(edge.specifier) ?? { fallback: new Set(), byImporter: new Map() };
    const target = `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`;
    if (edge.importer) {
      const importer = getIdentityModuleKey(edge.importer);
      const exact = entry.byImporter.get(importer) ?? new Set();
      exact.add(target);
      entry.byImporter.set(importer, exact);
    } else {
      entry.fallback.add(target);
    }
    targets.set(edge.specifier, entry);
  }
  return new Map(
    [...targets].map(([specifier, entry]) => [
      specifier,
      {
        byImporter: new Map(
          [...entry.byImporter].map(([importer, exact]) => [importer, [...exact].sort(compareTextCodeUnits)]),
        ),
        fallback: [...entry.fallback].sort(compareTextCodeUnits),
      },
    ]),
  );
}

function createIdentityModuleRecord(module: Readonly<IrModule>): IdentityModuleRecord {
  const source = normalizePathPortable(module.source);
  const identity = `${module.packageName}\0${source}\0${module.name}`;
  const record: {
    declarations: Map<string, IdentityDeclarationLocation>;
    importsByBindingId: Map<string, IdentityImport[]>;
  } & Omit<IdentityModuleRecord, 'declarations' | 'importsByBindingId' | 'typeParameters'> & {
      typeParameters: Map<string, Readonly<IrTypeParameter>>;
    } = {
    declarations: new Map(),
    identity,
    importsByBindingId: new Map(),
    module,
    source,
    typeParameters: new Map(),
  };
  for (const declaration of module.declarations) {
    if (
      declaration.kind === 'class' ||
      declaration.kind === 'enum' ||
      declaration.kind === 'interface' ||
      declaration.kind === 'typeAlias'
    ) {
      if (record.declarations.has(declaration.binding.id)) {
        throw new TypeError('Type value identity module contains a duplicate declaration identity');
      }
      record.declarations.set(declaration.binding.id, {
        declaration,
        identity: `${identity}\0${declaration.binding.id}`,
        module: record,
      });
    }
    collectIrDeclarationTypeParameters(declaration, record.typeParameters);
  }
  for (const entry of module.imports) {
    for (const binding of entry.bindings) {
      const imports = record.importsByBindingId.get(binding.binding.id) ?? [];
      imports.push({ imported: binding.imported, specifier: entry.specifier });
      record.importsByBindingId.set(binding.binding.id, imports);
    }
  }
  return record;
}

function collectIrDeclarationTypeParameters(
  declaration: Readonly<IrDeclaration>,
  parameters: Map<string, Readonly<IrTypeParameter>>,
): void {
  switch (declaration.kind) {
    case 'class':
      addIrTypeParameters(declaration.typeParameters, parameters);
      declaration.methods.forEach((method) => addIrTypeParameters(method.typeParameters, parameters));
      break;
    case 'function':
    case 'interface':
    case 'typeAlias':
      addIrTypeParameters(declaration.typeParameters, parameters);
      break;
    case 'enum':
    case 'variable':
      break;
  }
}

function addIrTypeParameters(
  additions: readonly Readonly<IrTypeParameter>[],
  parameters: Map<string, Readonly<IrTypeParameter>>,
): void {
  for (const parameter of additions) {
    if (parameters.has(parameter.binding.id)) {
      throw new TypeError('Type value identity module contains a duplicate type parameter identity');
    }
    parameters.set(parameter.binding.id, parameter);
  }
}

function getIdentityModuleRecord(
  module: Readonly<IrModule>,
  moduleSet: Readonly<IdentityModuleSet>,
): IdentityModuleRecord | undefined {
  return moduleSet.modulesByIdentity.get(createIdentityModuleKey(module));
}

function createIdentityModuleKey(module: Readonly<IrModule>): string {
  return `${module.packageName}\0${normalizePathPortable(module.source)}\0${module.name}`;
}

function deduplicateIdentityDeclarationLocations(
  locations: readonly IdentityDeclarationLocation[],
): IdentityDeclarationLocation[] {
  return [...new Map(locations.map((location) => [location.identity, location])).values()].sort(
    compareIdentityDeclarationLocations,
  );
}

function compareIdentityDeclarationLocations(
  left: Readonly<IdentityDeclarationLocation>,
  right: Readonly<IdentityDeclarationLocation>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

function compareIdentityModuleRecords(
  left: Readonly<IdentityModuleRecord>,
  right: Readonly<IdentityModuleRecord>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

function createCompilerTypeValueIdentityAnalysis(
  identity: CompilerTypeValueIdentityAnalysis['identity'],
  reason: CompilerTypeValueIdentityAnalysis['reason'],
): CompilerTypeValueIdentityAnalysis {
  return Object.freeze({ identity, reason, schema: 'flight-compiler-type-value-identity/1' });
}

function validateIdentityModuleResolutionPlan(resolution: Readonly<CompilerModuleResolutionPlan>): void {
  if (
    !resolution ||
    resolution.schema !== 'flight-compiler-module-resolution/1' ||
    !Array.isArray(resolution.edges as unknown)
  ) {
    throw new TypeError('Type value identity module resolution plan is invalid');
  }
  const importedNamesBySpecifier = new Map<string, ReadonlySet<string> | undefined>();
  for (const edge of resolution.edges) {
    const importer = edge?.importer;
    const importerKey = importer ? getIdentityModuleKey(importer) : '';
    const resolutionKey = `${importerKey}\0${edge?.specifier ?? ''}`;
    const importedNamesValid =
      edge?.importedNames === undefined ||
      (Array.isArray(edge.importedNames) &&
        edge.importedNames.length > 0 &&
        edge.importedNames.every((name) => typeof name === 'string' && name.length > 0) &&
        new Set(edge.importedNames).size === edge.importedNames.length);
    const importedNames = edge?.importedNames ? new Set(edge.importedNames) : undefined;
    const priorNames = importedNamesBySpecifier.get(resolutionKey);
    const duplicate =
      importedNamesBySpecifier.has(resolutionKey) &&
      (priorNames === undefined ||
        importedNames === undefined ||
        [...importedNames].some((name) => priorNames.has(name)));
    if (
      !edge ||
      typeof edge.specifier !== 'string' ||
      edge.specifier.length === 0 ||
      !edge.target ||
      typeof edge.target.packageName !== 'string' ||
      edge.target.packageName.length === 0 ||
      typeof edge.target.source !== 'string' ||
      edge.target.source.length === 0 ||
      (importer !== undefined &&
        (typeof importer.packageName !== 'string' ||
          importer.packageName.length === 0 ||
          typeof importer.source !== 'string' ||
          importer.source.length === 0 ||
          typeof importer.name !== 'string' ||
          importer.name.length === 0)) ||
      !importedNamesValid ||
      duplicate
    ) {
      throw new TypeError('Type value identity module resolution plan contains an invalid or duplicate edge');
    }
    importedNamesBySpecifier.set(
      resolutionKey,
      importedNames === undefined ? undefined : new Set([...(priorNames ?? []), ...importedNames]),
    );
  }
}

function getIdentityModuleKey(identity: Readonly<CompilerModuleIdentity>): string {
  return `${identity.packageName}\0${normalizePathPortable(identity.source)}\0${identity.name}`;
}

const compilerEmptyModuleResolutionPlan: CompilerModuleResolutionPlan = Object.freeze({
  edges: Object.freeze([]),
  schema: 'flight-compiler-module-resolution/1',
});

const compilerAmbientIdentityPreservingUtilities = new Map([
  ['Omit', 2],
  ['Partial', 1],
  ['Pick', 2],
  ['Readonly', 1],
  ['Required', 1],
]);

const compilerKnownAmbientReferenceTypes = new Set([
  'Array',
  'ArrayBuffer',
  'ArrayConstructor',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncIterator',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'Console',
  'DataView',
  'Date',
  'DateConstructor',
  'Error',
  'ErrorConstructor',
  'Float32Array',
  'Float64Array',
  'Function',
  'Generator',
  'IArguments',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Iterable',
  'IterableIterator',
  'Iterator',
  'JSON',
  'Map',
  'MapConstructor',
  'Math',
  'Number',
  'NumberConstructor',
  'Object',
  'Promise',
  'PromiseConstructor',
  'PromiseLike',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'RegExp',
  'Set',
  'SetConstructor',
  'SharedArrayBuffer',
  'String',
  'StringConstructor',
  'SymbolConstructor',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakMapConstructor',
  'WeakSet',
]);

const compilerKnownAmbientReferenceValues = new Set([
  'Array',
  'Date',
  'Error',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Set',
  'String',
  'Symbol',
  'console',
]);

const compilerUnsupportedAmbientIdentityUtilities = new Set([
  'Awaited',
  'ConstructorParameters',
  'Exclude',
  'Extract',
  'InstanceType',
  'NonNullable',
  'OmitThisParameter',
  'Parameters',
  'ReturnType',
  'ThisParameterType',
]);
