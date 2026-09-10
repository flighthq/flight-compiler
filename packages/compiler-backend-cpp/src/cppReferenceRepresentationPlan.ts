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
  readonly module: Readonly<IrModule>;
  readonly source: string;
}

interface ReferenceModuleSet {
  readonly modules: readonly ReferenceModuleRecord[];
  readonly modulesByIdentity: ReadonlyMap<string, ReferenceModuleRecord>;
  readonly resolution: Readonly<CompilerModuleResolutionPlan>;
}

interface ReferencePlanningContext {
  readonly analyzeIdentity: (type: Readonly<IrType>, module: Readonly<IrModule>) => CompilerTypeValueIdentityAnalysis;
  readonly moduleSet: ReferenceModuleSet;
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
  const context: ReferencePlanningContext = {
    analyzeIdentity: analyzer.analyze,
    moduleSet,
  };
  return Object.freeze({
    plan(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ reference representation subject must belong to the explicit module set');
      return createIrTypeReferenceRepresentationPlanInternalCpp(type, subject, context);
    },
    schema: 'flight-compiler-cpp-reference-representation-planner/1',
  });
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
  if (type.kind === 'intersection' || type.kind === 'union') {
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
    return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'unsupportedReferenceForm');
  }

  const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, context.moduleSet);
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
): Readonly<{ kind: 'indeterminate' }> | Readonly<{ kind: 'location'; location: ReferenceDeclarationLocation }> {
  const binding = reference.binding;
  if (binding.kind !== 'import') {
    if (reference.path.length > 0) return { kind: 'indeterminate' };
    const location = module.declarations.get(binding.id);
    return location ? { kind: 'location', location } : { kind: 'indeterminate' };
  }
  const imported = module.module.imports.flatMap((entry) =>
    entry.bindings
      .filter((candidate) => candidate.binding.id === binding.id)
      .map((candidate) => ({ imported: candidate.imported, specifier: entry.specifier })),
  );
  const imports = imported.flatMap(({ imported: importedName, specifier }) => {
    if (importedName === '*' && reference.path.length === 1) {
      return [{ exportName: reference.path[0]!, specifier }];
    }
    return reference.path.length === 0 && importedName !== '*' ? [{ exportName: importedName, specifier }] : [];
  });
  const locations = deduplicateReferenceDeclarationLocationsCpp(
    imports.flatMap(({ exportName, specifier }) =>
      getReferenceSpecifierModulesCpp(module, specifier, moduleSet).flatMap((target) =>
        getReferenceExportLocationsCpp(target, exportName, moduleSet, new Set()),
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
): readonly ReferenceDeclarationLocation[] {
  const identity = `${module.identity}\0${exportName}`;
  if (seen.has(identity)) return [];
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
      for (const target of getReferenceSpecifierModulesCpp(module, exported.specifier, moduleSet)) {
        locations.push(...getReferenceExportLocationsCpp(target, exported.imported, moduleSet, nextSeen));
      }
    }
    if (exported.kind === 'all') {
      for (const target of getReferenceSpecifierModulesCpp(module, exported.specifier, moduleSet)) {
        locations.push(...getReferenceExportLocationsCpp(target, exportName, moduleSet, nextSeen));
      }
    }
  }
  return deduplicateReferenceDeclarationLocationsCpp(locations);
}

function getReferenceSpecifierModulesCpp(
  from: Readonly<ReferenceModuleRecord>,
  specifier: string,
  moduleSet: Readonly<ReferenceModuleSet>,
): readonly ReferenceModuleRecord[] {
  const candidates = getReferenceSpecifierSourceCandidatesCpp(from.source, specifier);
  const matching = moduleSet.resolution.edges.filter((edge) => edge.specifier === specifier);
  const exact = matching.filter(
    (edge) => edge.importer && createReferenceModuleKeyCpp(edge.importer) === from.identity,
  );
  const resolutionTargets = (exact.length > 0 ? exact : matching.filter((edge) => !edge.importer)).map(
    (edge) => `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`,
  );
  return moduleSet.modules.filter(
    (candidate) =>
      (candidate.module.packageName === from.module.packageName && candidates.has(candidate.source)) ||
      resolutionTargets.includes(`${candidate.module.packageName}\0${candidate.source}`),
  );
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
  return {
    modules: records,
    modulesByIdentity: new Map(records.map((record) => [record.identity, record])),
    resolution,
  };
}

function createReferenceModuleRecordCpp(module: Readonly<IrModule>): ReferenceModuleRecord {
  const source = normalizePathPortable(module.source);
  const identity = `${module.packageName}\0${source}\0${module.name}`;
  const record: { declarations: Map<string, ReferenceDeclarationLocation> } & Omit<
    ReferenceModuleRecord,
    'declarations'
  > = {
    declarations: new Map(),
    identity,
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
