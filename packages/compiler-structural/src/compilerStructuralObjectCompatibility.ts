import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerStructuralObjectCompatibilityDiagnostic,
  CompilerStructuralObjectCompatibilityDisposition,
  CompilerStructuralObjectCompatibilityReport,
  CompilerStructuralTypeSubstitutionPlan,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectExpression,
  IrObjectTypeProperty,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeReference,
} from '../../compiler-types/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from './compilerStructuralTypeSubstitution.js';

type StructuralDeclaration = Readonly<IrInterfaceDeclaration | IrTypeAliasDeclaration>;

interface StructuralDeclarationLocation {
  readonly declaration: StructuralDeclaration;
  readonly identity: string;
  readonly module: StructuralModuleRecord;
}

interface StructuralExportResolution {
  readonly cycle: boolean;
  readonly locations: readonly StructuralDeclarationLocation[];
  readonly unresolved: boolean;
}

interface StructuralModuleRecord {
  readonly declarations: ReadonlyMap<string, StructuralDeclarationLocation>;
  readonly identity: string;
  readonly module: Readonly<IrModule>;
  readonly source: string;
}

interface StructuralModuleSet {
  readonly exportResolutions: Map<string, StructuralExportResolution>;
  readonly moduleByIdentity: ReadonlyMap<string, StructuralModuleRecord>;
  readonly modules: readonly StructuralModuleRecord[];
  readonly replacement?: StructuralModuleRecord | undefined;
  readonly resolution: Readonly<CompilerModuleResolutionPlan>;
  readonly specifierModules: Map<string, readonly StructuralModuleRecord[]>;
}

type StructuralBindingTypeReference = Readonly<
  IrTypeReference & { reference: Extract<IrTypeReference['reference'], { kind: 'binding' }> }
>;

type StructuralTargetResolution =
  | Readonly<{ kind: 'closed'; properties: readonly IrObjectTypeProperty[] }>
  | Readonly<{
      code:
        | 'ambiguous-named-construction-target'
        | 'cyclic-construction-target'
        | 'invalid-type-application'
        | 'non-structural-construction-target'
        | 'open-construction-target'
        | 'unresolved-named-construction-target';
      disposition: 'incompatible' | 'indeterminate';
      kind: 'diagnostic';
      message: string;
    }>;

export function analyzeIrModuleStructuralObjectCompatibility(
  module: Readonly<IrModule>,
): CompilerStructuralObjectCompatibilityReport {
  return analyzeIrModuleStructuralObjectCompatibilityAcrossModules(module, [module], compilerEmptyModuleResolutionPlan);
}

export function analyzeIrModuleStructuralObjectCompatibilityAcrossModules(
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[],
  resolution?: Readonly<CompilerModuleResolutionPlan> | undefined,
): CompilerStructuralObjectCompatibilityReport {
  return createIrModuleStructuralObjectCompatibilityAnalyzer(modules, resolution)(module);
}

export function createIrModuleStructuralObjectCompatibilityAnalyzer(
  modules: readonly Readonly<IrModule>[],
  resolution?: Readonly<CompilerModuleResolutionPlan> | undefined,
): (module: Readonly<IrModule>) => CompilerStructuralObjectCompatibilityReport {
  const moduleSet = createStructuralModuleSet(
    modules,
    resolution === undefined ? compilerEmptyModuleResolutionPlan : resolution,
  );
  return (module) => {
    const replacement = createStructuralModuleRecord(module);
    if (!moduleSet.moduleByIdentity.has(replacement.identity)) {
      throw new TypeError('Structural compatibility subject must belong to the explicit module set');
    }
    return analyzeIrModuleStructuralObjectCompatibilityWithModuleSet(module, {
      ...moduleSet,
      exportResolutions: new Map(),
      replacement,
      specifierModules: new Map(),
    });
  };
}

function analyzeIrModuleStructuralObjectCompatibilityWithModuleSet(
  module: Readonly<IrModule>,
  moduleSet: Readonly<StructuralModuleSet>,
): CompilerStructuralObjectCompatibilityReport {
  const subject = getStructuralModuleRecord(module, moduleSet);
  if (!subject) throw new TypeError('Structural compatibility subject must belong to the explicit module set');
  const diagnostics: CompilerStructuralObjectCompatibilityDiagnostic[] = [];
  analyzeIrModuleTraversal(module, {
    expression(expression, path) {
      if (expression.kind === 'object') {
        analyzeIrObjectExpressionStructuralCompatibility(expression, path, subject, moduleSet, diagnostics);
      }
    },
  });
  const frozenDiagnostics = Object.freeze(
    diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, path: Object.freeze([...diagnostic.path]) })),
  );
  return Object.freeze({
    diagnostics: frozenDiagnostics,
    module: Object.freeze({ name: module.name, packageName: module.packageName, source: module.source }),
    schema: 'flight-compiler-structural-object-compatibility/1',
    status: getCompilerStructuralObjectCompatibilityStatus(frozenDiagnostics),
  });
}

function analyzeIrObjectExpressionStructuralCompatibility(
  expression: Readonly<IrObjectExpression>,
  path: CompilerIrTraversalPath,
  module: Readonly<StructuralModuleRecord>,
  moduleSet: Readonly<StructuralModuleSet>,
  diagnostics: CompilerStructuralObjectCompatibilityDiagnostic[],
): void {
  const resolution = getIrTypeStructuralConstructionTarget(expression.type, module, moduleSet, new Set());
  if (resolution.kind === 'diagnostic') {
    addCompilerStructuralObjectCompatibilityDiagnostic(
      resolution.code,
      resolution.disposition,
      resolution.message,
      path,
      undefined,
      diagnostics,
    );
  }

  const properties = resolution.kind === 'closed' ? resolution.properties : undefined;
  const propertyNames = properties ? new Set(properties.map((property) => property.name)) : undefined;
  const provided = new Set<string>();
  let membershipIndeterminate = false;
  expression.members.forEach((member, index) => {
    const memberPath = [...path, 'members', index];
    if (member.kind === 'computedProperty') {
      membershipIndeterminate = true;
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'computed-property-indeterminate',
        'requires-lowering',
        'computed object property membership requires property-key and evaluation lowering',
        memberPath,
        undefined,
        diagnostics,
      );
      return;
    }
    if (member.kind === 'spread') {
      membershipIndeterminate = true;
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'spread-membership-indeterminate',
        'requires-lowering',
        'object spread membership requires structural copy and source-shape lowering',
        memberPath,
        undefined,
        diagnostics,
      );
      return;
    }
    if (provided.has(member.name)) {
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'duplicate-property-requires-normalization',
        'requires-lowering',
        `object property ${member.name} is written more than once and requires evaluation-preserving normalization`,
        memberPath,
        member.name,
        diagnostics,
      );
    }
    provided.add(member.name);
    if (propertyNames && !propertyNames.has(member.name)) {
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'unknown-property',
        'incompatible',
        `object property ${member.name} is absent from its closed construction type`,
        memberPath,
        member.name,
        diagnostics,
      );
    }
  });
  if (!properties || membershipIndeterminate) return;
  for (const property of properties) {
    if (!property.optional && !provided.has(property.name)) {
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'missing-required-property',
        'incompatible',
        `required object property ${property.name} is absent from its construction`,
        path,
        property.name,
        diagnostics,
      );
    }
  }
}

function getIrTypeStructuralConstructionTarget(
  type: Readonly<IrType>,
  module: Readonly<StructuralModuleRecord>,
  moduleSet: Readonly<StructuralModuleSet>,
  ancestors: ReadonlySet<string>,
): StructuralTargetResolution {
  if (type.kind === 'object') return { kind: 'closed', properties: type.properties };
  if (type.kind === 'union' || type.kind === 'intersection') {
    const resolutions = type.types.map((member) =>
      getIrTypeStructuralConstructionTarget(member, module, moduleSet, ancestors),
    );
    const closed = resolutions.filter(
      (resolution): resolution is Extract<StructuralTargetResolution, { kind: 'closed' }> =>
        resolution.kind === 'closed',
    );
    if (type.kind === 'intersection' && closed.length !== resolutions.length) {
      return resolutions.find(
        (resolution): resolution is Extract<StructuralTargetResolution, { kind: 'diagnostic' }> =>
          resolution.kind === 'diagnostic',
      )!;
    }
    if (closed.length > 0) {
      return {
        kind: 'closed',
        properties: mergeIrStructuralConstructionProperties(
          closed.map((resolution) => resolution.properties),
          type.kind,
        ),
      };
    }
  }
  if (type.kind !== 'named') {
    return {
      code: 'open-construction-target',
      disposition: 'indeterminate',
      kind: 'diagnostic',
      message: 'object construction lacks closed structural target evidence',
    };
  }
  const target = getIrTypeStructuralConstructionTargetName(type);
  if (type.reference.kind !== 'binding') {
    return {
      code: 'unresolved-named-construction-target',
      disposition: 'indeterminate',
      kind: 'diagnostic',
      message: `named structural construction target ${target} is not locally resolvable`,
    };
  }
  const declarationResolution = getStructuralDeclarationLocation(
    { ...type, reference: type.reference },
    module,
    moduleSet,
  );
  if (declarationResolution.kind === 'diagnostic') return declarationResolution;
  const location = declarationResolution.location;
  if (ancestors.has(location.identity)) {
    return {
      code: 'cyclic-construction-target',
      disposition: 'incompatible',
      kind: 'diagnostic',
      message: `structural construction target ${target} is cyclic`,
    };
  }
  const declaration = location.declaration;
  let plan: CompilerStructuralTypeSubstitutionPlan;
  try {
    plan = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
  } catch (error) {
    if (!isCompilerStructuralTypeSubstitutionFailure(error)) throw error;
    return {
      code: 'invalid-type-application',
      disposition: 'incompatible',
      kind: 'diagnostic',
      message: `structural construction target ${target} has invalid generic application (${error.code})`,
    };
  }
  const nextAncestors = new Set(ancestors).add(location.identity);
  if (declaration.kind === 'interface') {
    const inherited: (readonly IrObjectTypeProperty[])[] = [];
    for (const base of declaration.extends) {
      const resolvedBase = resolveIrTypeStructuralSubstitution(base, plan);
      const resolution = getIrTypeStructuralConstructionTarget(resolvedBase, location.module, moduleSet, nextAncestors);
      if (resolution.kind === 'diagnostic') return resolution;
      inherited.push(resolution.properties);
    }
    const own = declaration.properties.map((property) => ({
      ...property,
      type: resolveIrTypeStructuralSubstitution(property.type, plan),
    }));
    return {
      kind: 'closed',
      properties: mergeIrStructuralConstructionProperties([...inherited, own], 'intersection'),
    };
  }
  const resolved = resolveIrTypeStructuralSubstitution(declaration.type, plan);
  if (resolved.kind === 'object') return { kind: 'closed', properties: resolved.properties };
  if (resolved.kind === 'named') {
    return getIrTypeStructuralConstructionTarget(resolved, location.module, moduleSet, nextAncestors);
  }
  if (resolved.kind === 'union' || resolved.kind === 'intersection') {
    return getIrTypeStructuralConstructionTarget(resolved, location.module, moduleSet, nextAncestors);
  }
  return {
    code: 'non-structural-construction-target',
    disposition: 'incompatible',
    kind: 'diagnostic',
    message: `object construction target ${target} does not resolve to a structural record`,
  };
}

function mergeIrStructuralConstructionProperties(
  branches: readonly (readonly IrObjectTypeProperty[])[],
  kind: 'intersection' | 'union',
): readonly IrObjectTypeProperty[] {
  const names = new Set(branches.flatMap((properties) => properties.map((property) => property.name)));
  return [...names].sort(compareTextCodeUnits).map((name) => {
    const matches = branches.flatMap((properties) => {
      const property = properties.find((candidate) => candidate.name === name);
      return property ? [property] : [];
    });
    const representative = matches[0]!;
    const optional =
      kind === 'union'
        ? matches.length !== branches.length || matches.some((property) => property.optional)
        : matches.every((property) => property.optional);
    return { ...representative, optional };
  });
}

function getStructuralDeclarationLocation(
  type: StructuralBindingTypeReference,
  module: Readonly<StructuralModuleRecord>,
  moduleSet: Readonly<StructuralModuleSet>,
):
  | Readonly<{ kind: 'diagnostic' } & Extract<StructuralTargetResolution, { kind: 'diagnostic' }>>
  | Readonly<{ kind: 'location'; location: StructuralDeclarationLocation }> {
  const target = getIrTypeStructuralConstructionTargetName(type);
  const reference = type.reference;
  const binding = reference.binding;
  if (binding.kind !== 'import') {
    if (reference.path.length > 0) {
      return {
        code: 'unresolved-named-construction-target',
        disposition: 'indeterminate',
        kind: 'diagnostic',
        message: `qualified structural construction target ${target} is not module-resolvable`,
      };
    }
    const location = module.declarations.get(binding.id);
    return location
      ? { kind: 'location', location }
      : {
          code: 'unresolved-named-construction-target',
          disposition: 'indeterminate',
          kind: 'diagnostic',
          message: `named structural construction target ${target} is unavailable in this module`,
        };
  }
  const imported = module.module.imports.flatMap((entry) =>
    entry.bindings
      .filter((candidate) => candidate.binding.id === binding.id)
      .map((candidate) => ({ imported: candidate.imported, specifier: entry.specifier })),
  );
  const exportNames = imported.flatMap(({ imported: importedName, specifier }) => {
    if (importedName === '*' && reference.path.length === 1) {
      return [{ exportName: reference.path[0]!, specifier }];
    }
    return reference.path.length === 0 && importedName !== '*' ? [{ exportName: importedName, specifier }] : [];
  });
  const resolutions = exportNames.map(({ exportName, specifier }) =>
    getStructuralExportResolution(module, specifier, exportName, moduleSet, new Set()),
  );
  const locations = deduplicateStructuralDeclarationLocations(
    resolutions.flatMap((resolution) => resolution.locations),
  );
  if (locations.length === 1) return { kind: 'location', location: locations[0]! };
  if (locations.length > 1) {
    return {
      code: 'ambiguous-named-construction-target',
      disposition: 'indeterminate',
      kind: 'diagnostic',
      message: `named structural construction target ${target} resolves to multiple module declarations`,
    };
  }
  if (resolutions.some((resolution) => resolution.cycle)) {
    return {
      code: 'cyclic-construction-target',
      disposition: 'incompatible',
      kind: 'diagnostic',
      message: `structural construction target ${target} has a cyclic module export route`,
    };
  }
  return {
    code: 'unresolved-named-construction-target',
    disposition: 'indeterminate',
    kind: 'diagnostic',
    message: `named structural construction target ${target} is unavailable in the explicit module set`,
  };
}

function getStructuralExportResolution(
  from: Readonly<StructuralModuleRecord>,
  specifier: string,
  exportName: string,
  moduleSet: Readonly<StructuralModuleSet>,
  ancestors: ReadonlySet<string>,
): StructuralExportResolution {
  const cacheKey = ancestors.size === 0 ? `${from.identity}\0${specifier}\0${exportName}` : undefined;
  const cached = cacheKey ? moduleSet.exportResolutions.get(cacheKey) : undefined;
  if (cached) return cached;
  const targets = getStructuralSpecifierModules(from, specifier, moduleSet);
  const resolutions = targets.map((target) =>
    getStructuralModuleExportResolution(target, exportName, moduleSet, ancestors),
  );
  const result = {
    cycle: resolutions.some((resolution) => resolution.cycle),
    locations: deduplicateStructuralDeclarationLocations(resolutions.flatMap((resolution) => resolution.locations)),
    unresolved: targets.length === 0 || resolutions.some((resolution) => resolution.unresolved),
  };
  if (cacheKey) moduleSet.exportResolutions.set(cacheKey, result);
  return result;
}

function getStructuralModuleExportResolution(
  module: Readonly<StructuralModuleRecord>,
  exportName: string,
  moduleSet: Readonly<StructuralModuleSet>,
  ancestors: ReadonlySet<string>,
): StructuralExportResolution {
  const query = `${module.identity}\0${exportName}`;
  if (ancestors.has(query)) return { cycle: true, locations: [], unresolved: false };
  const next = new Set(ancestors).add(query);
  const locations = [...module.declarations.values()].filter(
    (location) => location.declaration.exported && location.declaration.binding.name === exportName,
  );
  const nested: StructuralExportResolution[] = [];
  for (const exported of module.module.exports) {
    switch (exported.kind) {
      case 'all':
        if (exportName !== 'default') {
          nested.push(getStructuralExportResolution(module, exported.specifier, exportName, moduleSet, next));
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
          nested.push(getStructuralExportResolution(module, exported.specifier, exported.imported, moduleSet, next));
        }
        break;
      case 'default':
      case 'namespace':
        break;
    }
  }
  return {
    cycle: nested.some((resolution) => resolution.cycle),
    locations: deduplicateStructuralDeclarationLocations([
      ...locations,
      ...nested.flatMap((resolution) => resolution.locations),
    ]),
    unresolved: nested.some((resolution) => resolution.unresolved),
  };
}

function getStructuralSpecifierModules(
  from: Readonly<StructuralModuleRecord>,
  specifier: string,
  moduleSet: Readonly<StructuralModuleSet>,
): readonly StructuralModuleRecord[] {
  const cacheKey = `${from.identity}\0${specifier}`;
  const cached = moduleSet.specifierModules.get(cacheKey);
  if (cached) return cached;
  const candidates = getStructuralSpecifierSourceCandidates(from.source, specifier);
  const matching = moduleSet.resolution.edges.filter((edge) => edge.specifier === specifier);
  const exact = matching.filter(
    (edge) => edge.importer && getStructuralModuleIdentityKey(edge.importer) === from.identity,
  );
  const resolutionTargets = new Set(
    (exact.length > 0 ? exact : matching.filter((edge) => !edge.importer)).map(
      (edge) => `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`,
    ),
  );
  const result = moduleSet.modules
    .map((candidate) => (moduleSet.replacement?.identity === candidate.identity ? moduleSet.replacement : candidate))
    .filter(
      (candidate) =>
        (candidate.module.packageName === from.module.packageName && candidates.has(candidate.source)) ||
        resolutionTargets.has(`${candidate.module.packageName}\0${candidate.source}`),
    );
  moduleSet.specifierModules.set(cacheKey, result);
  return result;
}

function getStructuralSpecifierSourceCandidates(source: string, specifier: string): ReadonlySet<string> {
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

function createStructuralModuleSet(
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
): StructuralModuleSet {
  if (!Array.isArray(modules)) throw new TypeError('Structural module set must be an array');
  validateCompilerModuleResolutionPlan(resolution);
  const records = modules.map(createStructuralModuleRecord).sort(compareStructuralModuleRecords);
  if (records.some((record, index) => index > 0 && record.identity === records[index - 1]!.identity)) {
    throw new TypeError('Structural module set contains a duplicate module identity');
  }
  return {
    exportResolutions: new Map(),
    moduleByIdentity: new Map(records.map((record) => [record.identity, record])),
    modules: records,
    resolution,
    specifierModules: new Map(),
  };
}

function validateCompilerModuleResolutionPlan(resolution: Readonly<CompilerModuleResolutionPlan>): void {
  if (
    !resolution ||
    resolution.schema !== 'flight-compiler-module-resolution/1' ||
    !Array.isArray(resolution.edges as unknown)
  ) {
    throw new TypeError('Structural module resolution plan is invalid');
  }
  const importedNamesBySpecifier = new Map<string, ReadonlySet<string> | undefined>();
  for (const edge of resolution.edges) {
    const importer = edge?.importer;
    const importerKey = importer ? getStructuralModuleIdentityKey(importer) : '';
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
      throw new TypeError('Structural module resolution plan contains an invalid or duplicate edge');
    }
    importedNamesBySpecifier.set(
      resolutionKey,
      importedNames === undefined ? undefined : new Set([...(priorNames ?? []), ...importedNames]),
    );
  }
}

function getStructuralModuleIdentityKey(identity: Readonly<CompilerModuleIdentity>): string {
  return `${identity.packageName}\0${normalizePathPortable(identity.source)}\0${identity.name}`;
}

function createStructuralModuleRecord(module: Readonly<IrModule>): StructuralModuleRecord {
  const source = normalizePathPortable(module.source);
  const identity = `${module.packageName}\0${source}\0${module.name}`;
  const record: { declarations: Map<string, StructuralDeclarationLocation> } & Omit<
    StructuralModuleRecord,
    'declarations'
  > = {
    declarations: new Map(),
    identity,
    module,
    source,
  };
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'interface' && declaration.kind !== 'typeAlias') continue;
    if (record.declarations.has(declaration.binding.id)) {
      throw new TypeError('Structural module contains a duplicate declaration identity');
    }
    record.declarations.set(declaration.binding.id, {
      declaration,
      identity: `${identity}\0${declaration.binding.id}`,
      module: record,
    });
  }
  return record;
}

function getStructuralModuleRecord(
  module: Readonly<IrModule>,
  moduleSet: Readonly<StructuralModuleSet>,
): StructuralModuleRecord | undefined {
  const source = normalizePathPortable(module.source);
  const identity = `${module.packageName}\0${source}\0${module.name}`;
  return moduleSet.replacement?.identity === identity
    ? moduleSet.replacement
    : moduleSet.moduleByIdentity.get(identity);
}

function deduplicateStructuralDeclarationLocations(
  locations: readonly StructuralDeclarationLocation[],
): StructuralDeclarationLocation[] {
  return [...new Map(locations.map((location) => [location.identity, location])).values()].sort(
    compareStructuralDeclarationLocations,
  );
}

function compareStructuralDeclarationLocations(
  left: Readonly<StructuralDeclarationLocation>,
  right: Readonly<StructuralDeclarationLocation>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

function compareStructuralModuleRecords(
  left: Readonly<StructuralModuleRecord>,
  right: Readonly<StructuralModuleRecord>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

function getIrTypeStructuralConstructionTargetName(type: Readonly<Extract<IrType, { kind: 'named' }>>): string {
  return type.reference.kind === 'ambient'
    ? type.reference.name
    : [type.reference.binding.name, ...type.reference.path].join('.');
}

function addCompilerStructuralObjectCompatibilityDiagnostic(
  code: CompilerStructuralObjectCompatibilityDiagnostic['code'],
  disposition: CompilerStructuralObjectCompatibilityDisposition,
  message: string,
  path: CompilerIrTraversalPath,
  property: string | undefined,
  diagnostics: CompilerStructuralObjectCompatibilityDiagnostic[],
): void {
  diagnostics.push({ code, disposition, message, path, ...(property === undefined ? {} : { property }) });
}

function getCompilerStructuralObjectCompatibilityStatus(
  diagnostics: readonly CompilerStructuralObjectCompatibilityDiagnostic[],
): CompilerStructuralObjectCompatibilityReport['status'] {
  if (diagnostics.some((diagnostic) => diagnostic.disposition === 'incompatible')) return 'incompatible';
  return diagnostics.length === 0 ? 'compatible' : 'indeterminate';
}

const compilerEmptyModuleResolutionPlan: CompilerModuleResolutionPlan = Object.freeze({
  edges: Object.freeze([]),
  schema: 'flight-compiler-module-resolution/1',
});
