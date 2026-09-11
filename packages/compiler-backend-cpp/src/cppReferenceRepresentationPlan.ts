import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  createIrTypeValueIdentityAnalyzer,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerCppReferenceRepresentationPlan,
  CompilerCppReferenceRepresentationPlanner,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerTypeValueIdentityAnalysis,
  IrDeclaration,
  IrModule,
  IrObjectTypeProperty,
  IrType,
} from '../../compiler-types/src/index.js';

type ReferenceDeclaration = Readonly<Extract<IrDeclaration, { kind: 'class' | 'interface' | 'typeAlias' }>>;

interface ReferenceDeclarationLocation {
  readonly declaration: ReferenceDeclaration;
  readonly identity: string;
  readonly module: ReferenceModuleRecord;
}

interface ReferenceModuleRecord {
  readonly declarations: ReadonlyMap<string, ReferenceDeclarationLocation>;
  readonly identity: string;
  readonly importsByBindingId: ReadonlyMap<string, readonly ReferenceImport[]>;
  readonly module: Readonly<IrModule>;
  readonly source: string;
}

interface ReferenceImport {
  readonly imported: string;
  readonly specifier: string;
}

interface ReferenceModuleSet {
  readonly declarationsByBindingId: ReadonlyMap<string, readonly ReferenceDeclarationLocation[]>;
  readonly modules: readonly ReferenceModuleRecord[];
  readonly modulesByIdentity: ReadonlyMap<string, ReferenceModuleRecord>;
  readonly modulesByPackageSource: ReadonlyMap<string, readonly ReferenceModuleRecord[]>;
  readonly resolutionTargetsBySpecifier: ReadonlyMap<string, ReferenceResolutionTargets>;
}

interface ReferenceResolutionTargets {
  readonly fallback: readonly string[];
  readonly byImporter: ReadonlyMap<string, readonly string[]>;
}

interface ReferencePlanningContext {
  readonly analyzeIdentity: (type: Readonly<IrType>, module: Readonly<IrModule>) => CompilerTypeValueIdentityAnalysis;
  readonly moduleSet: ReferenceModuleSet;
  readonly resolutionCache: ReferenceResolutionCache;
}

interface ReferenceResolutionCache {
  readonly exportLocations: Map<string, readonly ReferenceDeclarationLocation[]>;
  readonly specifierModules: Map<string, readonly ReferenceModuleRecord[]>;
}

export function createIrTypeReferenceRepresentationPlanCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[] = [module],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlanCpp,
): CompilerCppReferenceRepresentationPlan {
  return createIrTypeReferenceRepresentationPlannerCpp(modules, moduleResolution).plan(type, module);
}

export function createIrTypeReferenceRepresentationPlannerCpp(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlanCpp,
): CompilerCppReferenceRepresentationPlanner {
  const moduleSnapshot = structuredClone(modules);
  const resolutionSnapshot = structuredClone(moduleResolution);
  const analyzer = createIrTypeValueIdentityAnalyzer(moduleSnapshot, resolutionSnapshot);
  const moduleSet = createReferenceModuleSetCpp(moduleSnapshot, resolutionSnapshot);
  const aliasCache = new Map<string, Readonly<IrType> | null>();
  const resolutionCache = createReferenceResolutionCacheCpp();
  const context: ReferencePlanningContext = {
    analyzeIdentity: analyzer.analyze,
    moduleSet,
    resolutionCache,
  };
  return Object.freeze({
    plan(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ reference representation subject must belong to the explicit module set');
      return createIrTypeReferenceRepresentationPlanInternalCpp(type, subject, context);
    },
    resolveAlias(type: Readonly<IrType>, module: Readonly<IrModule>): Readonly<IrType> | undefined {
      return resolveIrTypeAliasCpp(type, module, moduleSet, resolutionCache, aliasCache);
    },
    resolveModule(specifier: string, module: Readonly<IrModule>): Readonly<IrModule> | undefined {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ module resolution subject must belong to the explicit module set');
      const targets = getReferenceSpecifierModulesCpp(subject, specifier, moduleSet, resolutionCache);
      return targets.length === 1 ? targets[0]!.module : undefined;
    },
    resolveObjectShape(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ object-shape subject must belong to the explicit module set');
      return resolveIrTypeObjectShapeCpp(type, subject, moduleSet, resolutionCache, new Set());
    },
    schema: 'flight-compiler-cpp-reference-representation-planner/1',
  });
}

function resolveIrTypeAliasCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  moduleSet: Readonly<ReferenceModuleSet>,
  resolutionCache: ReferenceResolutionCache,
  cache: Map<string, Readonly<IrType> | null>,
): Readonly<IrType> | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const subject = getReferenceModuleRecordCpp(module, moduleSet);
  if (!subject) throw new TypeError('C++ type-alias subject must belong to the explicit module set');
  const reference = type.reference;
  const key = `${subject.identity}\0${reference.binding.id}\0${reference.path.join('\0')}\0${JSON.stringify(type.typeArguments)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  let locations: readonly ReferenceDeclarationLocation[];
  if (reference.binding.kind === 'import') {
    const resolution = getReferenceDeclarationResolutionCpp(reference, subject, moduleSet, resolutionCache);
    locations = resolution.kind === 'location' ? [resolution.location] : [];
  } else if (reference.path.length === 0) {
    locations = moduleSet.declarationsByBindingId.get(reference.binding.id) ?? [];
  } else {
    locations = [];
  }
  const aliases = deduplicateReferenceDeclarationLocationsCpp(locations).filter(
    (location) => location.declaration.kind === 'typeAlias',
  );
  const alias = aliases.length === 1 ? aliases[0] : undefined;
  const result =
    alias?.declaration.kind === 'typeAlias'
      ? resolveIrTypeStructuralSubstitution(
          alias.declaration.type,
          createIrTypeParameterSubstitutionPlan(alias.declaration.typeParameters, type.typeArguments),
        )
      : null;
  cache.set(key, result);
  return result ?? undefined;
}

function resolveIrTypeObjectShapeCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
): readonly Readonly<IrObjectTypeProperty>[] | undefined {
  if (type.kind === 'object') return type.properties;
  if (type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') {
    if (type.typeArguments.length !== 1 || !type.typeArguments[0]) return undefined;
    const properties = resolveIrTypeObjectShapeCpp(type.typeArguments[0], module, moduleSet, cache, ancestors);
    if (!properties) return undefined;
    if (type.reference.name === 'Partial') {
      return properties.map((property) => ({ ...property, optional: true }));
    }
    if (type.reference.name === 'Readonly') {
      return properties.map((property) => ({ ...property, readonly: true }));
    }
    if (type.reference.name === 'Required') {
      return properties.map((property) => ({ ...property, optional: false }));
    }
    return undefined;
  }
  const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, moduleSet, cache);
  if (resolution.kind !== 'location') return undefined;
  const location = resolution.location;
  if (ancestors.has(location.identity)) return undefined;
  const nextAncestors = new Set(ancestors).add(location.identity);
  const declaration = location.declaration;
  const substitutions = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
  if (declaration.kind === 'typeAlias') {
    return resolveIrTypeObjectShapeCpp(
      resolveIrTypeStructuralSubstitution(declaration.type, substitutions),
      location.module,
      moduleSet,
      cache,
      nextAncestors,
    );
  }
  const inherited =
    declaration.kind === 'interface' ? declaration.extends : declaration.extends ? [declaration.extends] : [];
  const inheritedProperties = inherited.map((base) =>
    resolveIrTypeObjectShapeCpp(
      resolveIrTypeStructuralSubstitution(base, substitutions),
      location.module,
      moduleSet,
      cache,
      nextAncestors,
    ),
  );
  if (inheritedProperties.some((properties) => !properties)) return undefined;
  const ownProperties: readonly Readonly<IrObjectTypeProperty>[] =
    declaration.kind === 'interface'
      ? declaration.properties.map((property) => ({
          ...property,
          type: resolveIrTypeStructuralSubstitution(property.type, substitutions),
        }))
      : declaration.fields.flatMap((field): readonly Readonly<IrObjectTypeProperty>[] =>
          field.static || field.visibility !== 'public' || field.branded
            ? []
            : [
                {
                  name: field.name,
                  optional: field.optional,
                  readonly: field.readonly,
                  type: resolveIrTypeStructuralSubstitution(field.type, substitutions),
                },
              ],
        );
  if (declaration.kind === 'class' && declaration.methods.some((method) => !method.static)) return undefined;
  return mergeIrObjectShapePropertiesCpp([
    ...inheritedProperties.flatMap((properties) => properties!),
    ...ownProperties,
  ]);
}

function mergeIrObjectShapePropertiesCpp(
  properties: readonly Readonly<IrObjectTypeProperty>[],
): readonly Readonly<IrObjectTypeProperty>[] | undefined {
  const result = new Map<string, Readonly<IrObjectTypeProperty>>();
  for (const property of properties) {
    const existing = result.get(property.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(property)) return undefined;
    result.set(property.name, property);
  }
  return [...result.values()];
}

function createIrTypeReferenceRepresentationPlanInternalCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
): CompilerCppReferenceRepresentationPlan {
  const identity = context.analyzeIdentity(type, module.module);
  if (identity.identity === 'indeterminate') {
    if (identity.reason === 'unresolved-reference' && isUnresolvedImportBindingReferenceCpp(type)) {
      return createCompilerCppReferenceRepresentationSuccessCpp(
        identity,
        'interface',
        'object',
        'rawNamedObject',
        'flightReference',
      );
    }
    return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'indeterminateIdentity');
  }
  if (identity.identity === 'value') {
    return createCompilerCppReferenceRepresentationSuccessCpp(identity, 'value', 'none', 'inlineValue', 'inlineValue');
  }

  if (type.kind === 'array') {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'array',
      'object',
      'runtimeManaged',
      'runtimeReference',
    );
  }
  if (type.kind === 'function' || type.kind === 'tuple') {
    return createCompilerCppReferenceRepresentationSuccessCpp(identity, 'value', 'none', 'inlineValue', 'inlineValue');
  }
  if (type.kind === 'object') {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'anonymousObject',
      'object',
      'rawAnonymousObject',
      'flightReference',
    );
  }
  if (type.kind === 'named') return createNamedReferenceRepresentationPlanCpp(type, module, context, identity);
  if (type.kind === 'union') {
    return createCompilerCppReferenceRepresentationSuccessCpp(identity, 'value', 'none', 'inlineValue', 'inlineValue');
  }
  if (type.kind === 'intersection') {
    return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'compoundReference');
  }
  return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'unsupportedReferenceForm');
}

function createNamedReferenceRepresentationPlanCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
  identity: Readonly<CompilerTypeValueIdentityAnalysis>,
): CompilerCppReferenceRepresentationPlan {
  if (type.reference.kind === 'ambient') {
    const utilityArity = cppIdentityPreservingAmbientUtilities.get(type.reference.name);
    if (utilityArity !== undefined && type.typeArguments.length === utilityArity && type.typeArguments[0]) {
      return createIrTypeReferenceRepresentationPlanInternalCpp(type.typeArguments[0], module, context);
    }
    const category = getCppRuntimeReferenceCategory(type.reference.name);
    if (!category) {
      return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'unsupportedAmbientReference');
    }
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      category,
      category === 'typedArray' ? 'view' : 'object',
      'runtimeManaged',
      'runtimeReference',
    );
  }
  if (type.reference.binding.kind === 'typeParameter') {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'interface',
      'object',
      'rawNamedObject',
      'flightReference',
    );
  }

  const resolution = getReferenceDeclarationResolutionCpp(
    type.reference,
    module,
    context.moduleSet,
    context.resolutionCache,
  );
  if (resolution.kind !== 'location') {
    if (type.reference.binding.kind === 'import') {
      return createCompilerCppReferenceRepresentationSuccessCpp(
        identity,
        'interface',
        'object',
        'rawNamedObject',
        'flightReference',
      );
    }
    return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'unresolvedReferenceRepresentation');
  }
  const declaration = resolution.location.declaration;
  if (declaration.kind === 'class') {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'class',
      'object',
      'rawNamedObject',
      'flightReference',
    );
  }
  if (declaration.kind === 'interface') {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'interface',
      'object',
      'rawNamedObject',
      'flightReference',
    );
  }
  return createTypeAliasReferenceRepresentationPlanCpp(
    type,
    declaration,
    resolution.location.module,
    context,
    identity,
  );
}

function createTypeAliasReferenceRepresentationPlanCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  declaration: Readonly<Extract<IrDeclaration, { kind: 'typeAlias' }>>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
  identity: Readonly<CompilerTypeValueIdentityAnalysis>,
): CompilerCppReferenceRepresentationPlan {
  const substitution = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
  const resolved = resolveIrTypeStructuralSubstitution(declaration.type, substitution);
  const plan = createIrTypeReferenceRepresentationPlanInternalCpp(resolved, module, context);
  if (
    plan.kind === 'represented' &&
    plan.valueRepresentation === 'flightReference' &&
    (plan.category === 'anonymousObject' || plan.category === 'objectAlias')
  ) {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'objectAlias',
      'object',
      'rawNamedObject',
      'flightReference',
    );
  }
  return plan;
}

function createCompilerCppReferenceRepresentationRefusalCpp(
  identity: Readonly<CompilerTypeValueIdentityAnalysis>,
  reason: Extract<CompilerCppReferenceRepresentationPlan, { kind: 'refused' }>['reason'],
): CompilerCppReferenceRepresentationPlan {
  return Object.freeze({
    identity,
    kind: 'refused',
    reason,
    schema: 'flight-compiler-cpp-reference-representation/1',
  });
}

function createCompilerCppReferenceRepresentationSuccessCpp(
  identity: Readonly<CompilerTypeValueIdentityAnalysis>,
  category: Extract<CompilerCppReferenceRepresentationPlan, { kind: 'represented' }>['category'],
  identityDomain: Extract<CompilerCppReferenceRepresentationPlan, { kind: 'represented' }>['identityDomain'],
  storageRepresentation: Extract<
    CompilerCppReferenceRepresentationPlan,
    { kind: 'represented' }
  >['storageRepresentation'],
  valueRepresentation: Extract<CompilerCppReferenceRepresentationPlan, { kind: 'represented' }>['valueRepresentation'],
): CompilerCppReferenceRepresentationPlan {
  return Object.freeze({
    category,
    identity,
    identityDomain,
    kind: 'represented',
    schema: 'flight-compiler-cpp-reference-representation/1',
    storageRepresentation,
    valueRepresentation,
  });
}

function getCppRuntimeReferenceCategory(
  sourceName: string,
): Extract<CompilerCppReferenceRepresentationPlan, { kind: 'represented' }>['category'] | undefined {
  if (cppArrayReferenceTypes.has(sourceName)) return 'array';
  if (cppMapReferenceTypes.has(sourceName)) return 'map';
  if (cppSetReferenceTypes.has(sourceName)) return 'set';
  if (cppTaskReferenceTypes.has(sourceName)) return 'task';
  if (cppTypedArrayReferenceTypes.has(sourceName)) return 'typedArray';
  if (sourceName === 'Date') return 'date';
  if (sourceName === 'WeakMap') return 'weakMap';
  return undefined;
}

function getReferenceDeclarationResolutionCpp(
  reference: Readonly<Extract<Extract<IrType, { kind: 'named' }>['reference'], { kind: 'binding' }>>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache?: ReferenceResolutionCache | undefined,
): Readonly<{ kind: 'indeterminate' }> | Readonly<{ kind: 'location'; location: ReferenceDeclarationLocation }> {
  const binding = reference.binding;
  if (binding.kind !== 'import') {
    if (reference.path.length > 0) return { kind: 'indeterminate' };
    const location = module.declarations.get(binding.id);
    return location ? { kind: 'location', location } : { kind: 'indeterminate' };
  }
  const imported = module.importsByBindingId.get(binding.id) ?? [];
  const imports = imported.flatMap(({ imported: importedName, specifier }) => {
    if (importedName === '*' && reference.path.length === 1) {
      return [{ exportName: reference.path[0]!, specifier }];
    }
    return reference.path.length === 0 && importedName !== '*' ? [{ exportName: importedName, specifier }] : [];
  });
  const locations = deduplicateReferenceDeclarationLocationsCpp(
    imports.flatMap(({ exportName, specifier }) =>
      getReferenceSpecifierModulesCpp(module, specifier, moduleSet, cache).flatMap((target) =>
        getReferenceExportLocationsCpp(target, exportName, moduleSet, new Set(), cache),
      ),
    ),
  );
  if (locations.length === 1) return { kind: 'location', location: locations[0]! };
  return { kind: 'indeterminate' };
}

function getReferenceExportLocationsCpp(
  module: Readonly<ReferenceModuleRecord>,
  exportName: string,
  moduleSet: Readonly<ReferenceModuleSet>,
  seen: ReadonlySet<string>,
  cache?: ReferenceResolutionCache | undefined,
): readonly ReferenceDeclarationLocation[] {
  const identity = `${module.identity}\0${exportName}`;
  const cached = cache?.exportLocations.get(identity);
  if (cached) return cached;
  if (seen.has(identity)) return [];
  cache?.exportLocations.set(identity, []);
  const nextSeen = new Set(seen);
  nextSeen.add(identity);
  const locations = [...module.declarations.values()].filter(
    (location) => location.declaration.exported && location.declaration.binding.name === exportName,
  );
  for (const exported of module.module.exports) {
    if (exported.kind === 'local' && exported.exported === exportName) {
      const location = module.declarations.get(exported.binding.id);
      if (location) locations.push(location);
    }
    if (exported.kind === 'reexport' && exported.exported === exportName) {
      for (const target of getReferenceSpecifierModulesCpp(module, exported.specifier, moduleSet, cache)) {
        locations.push(...getReferenceExportLocationsCpp(target, exported.imported, moduleSet, nextSeen, cache));
      }
    }
    if (exported.kind === 'all') {
      for (const target of getReferenceSpecifierModulesCpp(module, exported.specifier, moduleSet, cache)) {
        locations.push(...getReferenceExportLocationsCpp(target, exportName, moduleSet, nextSeen, cache));
      }
    }
  }
  const result = deduplicateReferenceDeclarationLocationsCpp(locations);
  cache?.exportLocations.set(identity, result);
  return result;
}

function getReferenceSpecifierModulesCpp(
  from: Readonly<ReferenceModuleRecord>,
  specifier: string,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache?: ReferenceResolutionCache | undefined,
): readonly ReferenceModuleRecord[] {
  const key = `${from.identity}\0${specifier}`;
  const cached = cache?.specifierModules.get(key);
  if (cached) return cached;
  const candidates = getReferenceSpecifierSourceCandidatesCpp(from.source, specifier);
  const resolved = moduleSet.resolutionTargetsBySpecifier.get(specifier);
  const resolutionTargets = resolved?.byImporter.get(from.identity) ?? resolved?.fallback ?? [];
  const resultByIdentity = new Map<string, ReferenceModuleRecord>();
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
  const result = [...resultByIdentity.values()].sort(compareReferenceModuleRecordsCpp);
  cache?.specifierModules.set(key, result);
  return result;
}

function createReferenceResolutionCacheCpp(): ReferenceResolutionCache {
  return { exportLocations: new Map(), specifierModules: new Map() };
}

function getReferenceSpecifierSourceCandidatesCpp(source: string, specifier: string): ReadonlySet<string> {
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
  for (const [emitted, sourceExtension] of cppModuleSourceExtensions) {
    if (resolved.endsWith(emitted)) candidates.add(`${resolved.slice(0, -emitted.length)}${sourceExtension}`);
  }
  if (!/\.[^/]+$/u.test(resolved)) {
    candidates.add(`${resolved}.ts`);
    candidates.add(`${resolved}/index.ts`);
  }
  return candidates;
}

function isUnresolvedImportBindingReferenceCpp(type: Readonly<IrType>): boolean {
  return type.kind === 'named' && type.reference.kind === 'binding' && type.reference.binding.kind === 'import';
}

function createReferenceModuleSetCpp(
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
): ReferenceModuleSet {
  const records = modules.map(createReferenceModuleRecordCpp).sort(compareReferenceModuleRecordsCpp);
  const declarationsByBindingId = new Map<string, ReferenceDeclarationLocation[]>();
  const modulesByPackageSource = new Map<string, ReferenceModuleRecord[]>();
  for (const record of records) {
    const moduleKey = `${record.module.packageName}\0${record.source}`;
    const sourceRecords = modulesByPackageSource.get(moduleKey) ?? [];
    sourceRecords.push(record);
    modulesByPackageSource.set(moduleKey, sourceRecords);
    for (const [bindingId, location] of record.declarations) {
      const locations = declarationsByBindingId.get(bindingId) ?? [];
      locations.push(location);
      declarationsByBindingId.set(bindingId, locations);
    }
  }
  return {
    declarationsByBindingId,
    modules: records,
    modulesByIdentity: new Map(records.map((record) => [record.identity, record])),
    modulesByPackageSource,
    resolutionTargetsBySpecifier: createReferenceResolutionTargetsCpp(resolution),
  };
}

function createReferenceResolutionTargetsCpp(
  resolution: Readonly<CompilerModuleResolutionPlan>,
): ReadonlyMap<string, ReferenceResolutionTargets> {
  const targets = new Map<string, { fallback: Set<string>; byImporter: Map<string, Set<string>> }>();
  for (const edge of resolution.edges) {
    const entry = targets.get(edge.specifier) ?? { fallback: new Set(), byImporter: new Map() };
    const target = `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`;
    if (edge.importer) {
      const importer = createReferenceModuleKeyCpp(edge.importer);
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

function createReferenceModuleRecordCpp(module: Readonly<IrModule>): ReferenceModuleRecord {
  const source = normalizePathPortable(module.source);
  const identity = `${module.packageName}\0${source}\0${module.name}`;
  const record: {
    declarations: Map<string, ReferenceDeclarationLocation>;
    importsByBindingId: Map<string, ReferenceImport[]>;
  } & Omit<ReferenceModuleRecord, 'declarations' | 'importsByBindingId'> = {
    declarations: new Map(),
    identity,
    importsByBindingId: new Map(),
    module,
    source,
  };
  for (const declaration of module.declarations) {
    if (declaration.kind === 'class' || declaration.kind === 'interface' || declaration.kind === 'typeAlias') {
      record.declarations.set(declaration.binding.id, {
        declaration,
        identity: `${identity}\0${declaration.binding.id}`,
        module: record,
      });
    }
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

function getReferenceModuleRecordCpp(
  module: Readonly<IrModule>,
  moduleSet: Readonly<ReferenceModuleSet>,
): ReferenceModuleRecord | undefined {
  return moduleSet.modulesByIdentity.get(createReferenceModuleKeyCpp(module));
}

function createReferenceModuleKeyCpp(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}\0${normalizePathPortable(module.source)}\0${module.name}`;
}

function deduplicateReferenceDeclarationLocationsCpp(
  locations: readonly ReferenceDeclarationLocation[],
): ReferenceDeclarationLocation[] {
  return [...new Map(locations.map((location) => [location.identity, location])).values()];
}

function compareReferenceModuleRecordsCpp(
  left: Readonly<ReferenceModuleRecord>,
  right: Readonly<ReferenceModuleRecord>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

const compilerEmptyModuleResolutionPlanCpp: CompilerModuleResolutionPlan = Object.freeze({
  edges: Object.freeze([]),
  schema: 'flight-compiler-module-resolution/1',
});

const cppIdentityPreservingAmbientUtilities = new Map([
  ['Omit', 2],
  ['Partial', 1],
  ['Pick', 2],
  ['Readonly', 1],
  ['Required', 1],
]);

const cppArrayReferenceTypes = new Set(['Array', 'ReadonlyArray']);
const cppMapReferenceTypes = new Set(['Map', 'ReadonlyMap']);
const cppModuleSourceExtensions = [
  ['.cjs', '.cts'],
  ['.js', '.ts'],
  ['.jsx', '.tsx'],
  ['.mjs', '.mts'],
] as const;
const cppSetReferenceTypes = new Set(['ReadonlySet', 'Set']);
const cppTaskReferenceTypes = new Set(['Promise', 'PromiseLike']);
const cppTypedArrayReferenceTypes = new Set([
  'Float32Array',
  'Float64Array',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
]);
