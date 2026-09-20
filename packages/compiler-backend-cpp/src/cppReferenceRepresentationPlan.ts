import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
  normalizePathPortable,
} from '../../compiler-canonical-form/src/index.js';
import {
  analyzeIrTypeStructuralAssignability,
  createIrTypeParameterSubstitutionPlan,
  createIrTypeValueIdentityAnalyzer,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerCppReferenceRepresentationPlan,
  CompilerCppReferenceRepresentationPlanner,
  CompilerCppStructuralRowPlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerTypeValueIdentityAnalysis,
  CppCompilerExternalBindingManifest,
  IrDeclaration,
  IrModule,
  IrObjectTypeProperty,
  IrType,
} from '../../compiler-types/src/index.js';
import { getCompilerExternalBindingEvidenceCpp } from './cppRuntimeExternalSymbolBinding.js';
import { getIrHomogeneousTupleElementTypeCpp } from './cppTupleRepresentation.js';

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
  readonly typeParameterBindingIds: ReadonlySet<string>;
  readonly valueTypesByBindingId: ReadonlyMap<string, Readonly<IrType>>;
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
  readonly namedBindingOwnersByBindingId: ReadonlyMap<string, readonly ReferenceModuleRecord[]>;
  readonly resolutionTargetsBySpecifier: ReadonlyMap<string, ReferenceResolutionTargets>;
  readonly typeParameterOwnersByBindingId: ReadonlyMap<string, readonly ReferenceModuleRecord[]>;
  readonly valueBindingOwnersByBindingId: ReadonlyMap<string, readonly ReferenceModuleRecord[]>;
}

interface ReferenceResolutionTargets {
  readonly fallback: readonly string[];
  readonly byImporter: ReadonlyMap<string, readonly string[]>;
}

interface ReferencePlanningContext {
  readonly analyzeIdentity: (type: Readonly<IrType>, module: Readonly<IrModule>) => CompilerTypeValueIdentityAnalysis;
  readonly externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined;
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
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): CompilerCppReferenceRepresentationPlan {
  return createIrTypeReferenceRepresentationPlannerCpp(modules, moduleResolution, externalBindings).plan(type, module);
}

export function createIrTypeReferenceRepresentationPlannerCpp(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlanCpp,
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): CompilerCppReferenceRepresentationPlanner {
  const moduleSnapshot = structuredClone(modules);
  const resolutionSnapshot = structuredClone(moduleResolution);
  const externalBindingSnapshot = externalBindings ? structuredClone(externalBindings) : undefined;
  const analyzer = createIrTypeValueIdentityAnalyzer(moduleSnapshot, resolutionSnapshot);
  const moduleSet = createReferenceModuleSetCpp(moduleSnapshot, resolutionSnapshot);
  const aliasCache = new Map<string, Readonly<IrType> | null>();
  const resolutionCache = createReferenceResolutionCacheCpp();
  const context: ReferencePlanningContext = {
    analyzeIdentity: analyzer.analyze,
    ...(externalBindingSnapshot ? { externalBindings: externalBindingSnapshot } : {}),
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
    resolveConditionalFacetReference(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ conditional-facet subject must belong to the explicit module set');
      return resolveIrConditionalFacetReferenceCpp(type, subject, moduleSet, resolutionCache, aliasCache, new Set());
    },
    resolveFacetReference(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ facet subject must belong to the explicit module set');
      return resolveIrFacetReferenceCpp(type, subject, moduleSet, resolutionCache);
    },
    resolveExternalProjection(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ external projection subject must belong to the explicit module set');
      return resolveIrExternalProjectionCpp(type, subject, context);
    },
    resolveClosedIntersectionDistribution(
      type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
      module: Readonly<IrModule>,
    ): Readonly<IrType> | undefined {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ intersection-distribution subject must belong to the explicit module set');
      return resolveIrTypeClosedIntersectionDistributionCpp(type, subject, moduleSet, resolutionCache);
    },
    resolveModule(specifier: string, module: Readonly<IrModule>): Readonly<IrModule> | undefined {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ module resolution subject must belong to the explicit module set');
      const targets = getReferenceSpecifierModulesCpp(subject, specifier, moduleSet, resolutionCache);
      return targets.length === 1 ? targets[0]!.module : undefined;
    },
    resolveModules(specifier: string, module: Readonly<IrModule>): readonly Readonly<IrModule>[] {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ module resolution subject must belong to the explicit module set');
      return getReferenceSpecifierModulesCpp(subject, specifier, moduleSet, resolutionCache).map(
        (target) => target.module,
      );
    },
    resolveObjectShape(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ object-shape subject must belong to the explicit module set');
      return resolveIrTypeObjectShapeCpp(type, subject, moduleSet, resolutionCache, new Set());
    },
    resolveOwnObjectProperty(type: Readonly<IrType>, propertyName: string, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ own-property subject must belong to the explicit module set');
      return resolveIrTypeOwnObjectPropertyCpp(type, propertyName, subject, moduleSet, resolutionCache);
    },
    resolveStructuralRow(type: Readonly<IrType>, module: Readonly<IrModule>) {
      const subject = getReferenceModuleRecordCpp(module, moduleSet);
      if (!subject) throw new TypeError('C++ structural-row subject must belong to the explicit module set');
      return resolveIrTypeStructuralRowCpp(type, subject, moduleSet, resolutionCache, new Set(), false);
    },
    schema: 'flight-compiler-cpp-reference-representation-planner/1',
  });
}

function resolveIrTypeOwnObjectPropertyCpp(
  type: Readonly<IrType>,
  propertyName: string,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
): Readonly<IrObjectTypeProperty> | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, moduleSet, cache);
  if (resolution.kind !== 'location') return undefined;
  const declaration = resolution.location.declaration;
  if (declaration.kind === 'typeAlias') return undefined;
  const substitution = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
  if (declaration.kind === 'interface') {
    const property = declaration.properties.find((candidate) => candidate.name === propertyName);
    return property
      ? { ...property, type: resolveIrTypeStructuralSubstitution(property.type, substitution) }
      : undefined;
  }
  const field = declaration.fields.find(
    (candidate) =>
      candidate.name === propertyName && !candidate.static && candidate.visibility === 'public' && !candidate.branded,
  );
  if (field) return { ...field, type: resolveIrTypeStructuralSubstitution(field.type, substitution) };
  const getter = declaration.methods.find(
    (candidate) =>
      candidate.name === propertyName &&
      candidate.accessor === 'get' &&
      !candidate.static &&
      candidate.visibility === 'public' &&
      !candidate.branded,
  );
  return getter
    ? {
        name: getter.name,
        optional: false,
        readonly: true,
        type: resolveIrTypeStructuralSubstitution(getter.returns, substitution),
      }
    : undefined;
}

function resolveIrTypeStructuralRowCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  aliases: ReadonlySet<string>,
  allowRowOf: boolean,
): Readonly<CompilerCppStructuralRowPlan> | undefined {
  if (type.kind === 'named' && type.reference.kind === 'ambient') {
    if (
      (type.reference.name === 'NoInfer' || type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
      type.typeArguments.length === 1 &&
      type.typeArguments[0]
    ) {
      const argument = type.typeArguments[0];
      const row =
        resolveIrTypeStructuralRowCpp(
          argument,
          module,
          moduleSet,
          cache,
          aliases,
          type.reference.name === 'NoInfer' ? allowRowOf : true,
        ) ??
        // `Required` is the one marker a plain subject reference cannot express, so it is the one
        // that needs the projection resolved to a row. See the helper.
        (type.reference.name === 'Required'
          ? resolveIrTypeProjectionSubjectRowCpp(argument, module, moduleSet, cache, aliases)
          : undefined);
      if (!row) return undefined;
      if (type.reference.name === 'Readonly') return { kind: 'readonly', row };
      // `Required` names every member as present, which is what the row marker states: the subject
      // keeps its own storage, and the row is what makes an optional member readable as its value.
      if (type.reference.name === 'Required') return { kind: 'required', row };
      return row;
    }
    if (type.reference.name === 'Partial' && type.typeArguments.length === 1 && type.typeArguments[0]) {
      if (!allowRowOf && resolveIrTypeObjectShapeCpp(type.typeArguments[0], module, moduleSet, cache, new Set())) {
        return undefined;
      }
      const row = resolveIrTypeStructuralRowCpp(type.typeArguments[0], module, moduleSet, cache, aliases, true);
      return row ? { kind: 'partial', row } : undefined;
    }
    return undefined;
  }
  if (type.kind === 'named' && type.reference.kind === 'binding') {
    if (type.reference.binding.kind === 'typeParameter') {
      const local = module.typeParameterBindingIds.has(type.reference.binding.id);
      const owners = moduleSet.typeParameterOwnersByBindingId.get(type.reference.binding.id) ?? [];
      const owner = local ? module : owners.length === 1 ? owners[0] : undefined;
      return owner && allowRowOf && type.reference.path.length === 0 && type.typeArguments.length === 0
        ? { kind: 'rowOf', type }
        : undefined;
    }
    const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, moduleSet, cache);
    if (resolution.kind !== 'location') return undefined;
    const location = resolution.location;
    const declaration = location.declaration;
    if (declaration.kind !== 'typeAlias') return allowRowOf ? { kind: 'rowOf', type } : undefined;
    const key = `${location.identity}\0${JSON.stringify(type.typeArguments)}`;
    if (aliases.has(key)) return undefined;
    const typeArguments =
      type.typeArguments.length === 0 && declaration.typeParameters.length > 0
        ? declaration.typeParameters.map(
            (parameter): IrType => ({
              kind: 'named',
              reference: { binding: parameter.binding, kind: 'binding', path: [] },
              typeArguments: [],
            }),
          )
        : type.typeArguments;
    const resolved = resolveIrTypeStructuralSubstitution(
      declaration.type,
      createIrTypeParameterSubstitutionPlan(declaration.typeParameters, typeArguments),
    );
    let row = resolveIrTypeStructuralRowCpp(
      resolved,
      location.module,
      moduleSet,
      cache,
      new Set(aliases).add(key),
      declaration.objectView === 'writable',
    );
    // A generic homomorphic partial alias can establish a structural view while its concrete
    // expansion becomes a closed object shape. Keep that declared view instead of falling back to
    // RowOf<Alias<...>>, which would inspect the StructuralRef wrapper rather than its subject row.
    if (
      !row ||
      (row.kind === 'rowOf' &&
        normalizeCompilerStructuralValueCanonical(row.type) === normalizeCompilerStructuralValueCanonical(type))
    ) {
      const openRow = resolveIrTypeStructuralRowCpp(
        declaration.type,
        location.module,
        moduleSet,
        cache,
        new Set(aliases).add(key),
        declaration.objectView === 'writable',
      );
      if (openRow?.kind === 'partial') {
        row = substituteCppStructuralRowPlan(
          openRow,
          createIrTypeParameterSubstitutionPlan(declaration.typeParameters, typeArguments),
        );
      }
    }
    if (row) return declaration.objectView === 'writable' ? { kind: 'writable', row } : row;
    if (
      declaration.objectView === 'writable' &&
      resolveIrTypeObjectShapeCpp(resolved, location.module, moduleSet, cache, new Set())
    ) {
      return { kind: 'writable', row: { kind: 'rowOf', type: resolved } };
    }
    return allowRowOf && resolveIrTypeObjectShapeCpp(type, module, moduleSet, cache, new Set())
      ? { kind: 'rowOf', type }
      : undefined;
  }
  if (type.kind === 'intersection') {
    const shape = resolveIrTypeObjectShapeCpp(type, module, moduleSet, cache, new Set());
    const memberShapes = type.types.map((member) =>
      resolveIrTypeObjectShapeCpp(member, module, moduleSet, cache, new Set()),
    );
    const carriesRuntimeSymbol = memberShapes.some((memberShape) =>
      memberShape?.some((property) => property.computedKey && !property.phantom),
    );
    const pairsGenericSubjectWithConcreteRow = type.types.some(
      (member, memberIndex) =>
        member.kind === 'named' &&
        member.typeArguments.some((argument) =>
          type.types.some(
            (candidate, candidateIndex) =>
              candidateIndex !== memberIndex &&
              normalizeCompilerStructuralValueCanonical(candidate) ===
                normalizeCompilerStructuralValueCanonical(argument),
          ),
        ),
    );
    const concreteRuntimeRow = carriesRuntimeSymbol && pairsGenericSubjectWithConcreteRow;
    if (shape && !concreteRuntimeRow) return undefined;
    // When every closed member resolves but their merge does not, the missing shape is a conflict,
    // not an open row. A symbol-bearing entity intersection cannot turn that conflict into storage.
    if (!shape && concreteRuntimeRow && memberShapes.every((memberShape) => memberShape)) return undefined;
    const rows = type.types.map((member) =>
      resolveIrTypeStructuralRowCpp(member, module, moduleSet, cache, aliases, true),
    );
    if (
      rows.some((row) => !row) ||
      !type.types.some(
        (member, index) =>
          isIrBareStructuralRowTypeParameterCpp(member) || rows[index]?.kind !== 'rowOf' || concreteRuntimeRow,
      )
    ) {
      return undefined;
    }
    return {
      kind: 'merge',
      rows: [rows[0]!, rows[1]!, ...rows.slice(2).map((row) => row!)],
    };
  }
  return allowRowOf && type.kind === 'object' ? { kind: 'rowOf', type } : undefined;
}

function substituteCppStructuralRowPlan(
  row: Readonly<CompilerCppStructuralRowPlan>,
  substitutions: Parameters<typeof resolveIrTypeStructuralSubstitution>[1],
): Readonly<CompilerCppStructuralRowPlan> {
  switch (row.kind) {
    case 'merge':
      return {
        kind: 'merge',
        rows: [
          substituteCppStructuralRowPlan(row.rows[0], substitutions),
          substituteCppStructuralRowPlan(row.rows[1], substitutions),
          ...row.rows.slice(2).map((member) => substituteCppStructuralRowPlan(member, substitutions)),
        ],
      };
    case 'partial':
    case 'readonly':
    case 'required':
    case 'writable':
      return { kind: row.kind, row: substituteCppStructuralRowPlan(row.row, substitutions) };
    case 'rowOf':
      return { kind: 'rowOf', type: resolveIrTypeStructuralSubstitution(row.type, substitutions) };
  }
}

// A key projection is a subset of its subject's members, every one of which the row the target keeps
// for that subject already carries, so the projection's row is its subject's row. `Required` is the
// one marker that needs it: the projection alone is still a view the subject reference can carry,
// but stating that a member is present needs a member cell to state it about. This is the spelling
// the downstream register names for `Required<Pick<HostClipboardChangeProvider, 'subscribe' |
// 'unsubscribe'>>`, where the optional member has to read as its value at the call site.
function resolveIrTypeProjectionSubjectRowCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  aliases: ReadonlySet<string>,
): Readonly<CompilerCppStructuralRowPlan> | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'ambient') return undefined;
  if (type.reference.name !== 'Omit' && type.reference.name !== 'Pick') return undefined;
  if (type.typeArguments.length !== 2 || !type.typeArguments[0]) return undefined;
  return resolveIrTypeStructuralRowCpp(type.typeArguments[0], module, moduleSet, cache, aliases, true);
}

function isIrBareStructuralRowTypeParameterCpp(type: Readonly<IrType>): boolean {
  if (type.kind === 'named' && type.reference.kind === 'binding' && type.reference.binding.kind === 'typeParameter') {
    return type.reference.path.length === 0 && type.typeArguments.length === 0;
  }
  return (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'NoInfer' &&
    type.typeArguments.length === 1 &&
    Boolean(type.typeArguments[0] && isIrBareStructuralRowTypeParameterCpp(type.typeArguments[0]))
  );
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
  let result: Readonly<IrType> | null = null;
  if (alias?.declaration.kind === 'typeAlias') {
    try {
      result = resolveIrTypeStructuralSubstitution(
        alias.declaration.type,
        createIrTypeParameterSubstitutionPlan(alias.declaration.typeParameters, type.typeArguments),
      );
    } catch (error) {
      if (!isCompilerStructuralTypeSubstitutionFailure(error)) throw error;
    }
  }
  cache.set(key, result);
  return result ?? undefined;
}

// `Partial`, `Readonly` and `Required` are homomorphic: they distribute over a union, so
// `Partial<A | B>` is `Partial<A> | Partial<B>`. The target keeps one storage shape, so the
// distributed members are merged into the one object their union can name -- a member any branch
// carries is a member the value may have. `Pick` and `Omit` are deliberately not distributed: they
// key off `keyof T`, which over a union is the keys the branches agree on, so distributing them would
// name members the source cannot reach. Without this a utility applied to a union of interfaces has
// no shape at all, which is why `Partial<TextureLike> & { resource?: ... }` refused while
// `Partial<Texture2D> & { resource?: ... }` emitted and the Omit-over-Partial case refused the same way.
function resolveIrTypeDistributedObjectShapeCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
): readonly Readonly<IrObjectTypeProperty>[] | undefined {
  if (type.kind === 'union') {
    const members = type.types.map((member) =>
      resolveIrTypeDistributedObjectShapeCpp(member, module, moduleSet, cache, ancestors),
    );
    if (members.some((properties) => !properties)) return undefined;
    return mergeIrObjectShapePropertiesCpp(
      members.flatMap((properties) => properties!),
      module,
      moduleSet,
      cache,
      ancestors,
      true,
    );
  }
  const step = resolveIrTypeShapeAliasStepCpp(type, module, moduleSet, cache, ancestors);
  return step
    ? resolveIrTypeDistributedObjectShapeCpp(step.type, step.module, moduleSet, cache, step.ancestors)
    : resolveIrTypeObjectShapeCpp(type, module, moduleSet, cache, ancestors);
}

interface IrTypeShapeAliasStepCpp {
  readonly ancestors: ReadonlySet<string>;
  readonly module: Readonly<ReferenceModuleRecord>;
  readonly type: Readonly<IrType>;
}

// A union usually arrives as the alias that names it -- `Partial<TextureLike>` holds `TextureLike` as a
// binding, not as a union of its branches, and `Exclude<TrayCreateProviderResult, ...>` holds an alias
// too -- so a branch that only inspects the type never sees the union underneath. The alias is
// resolved here, one step, exactly as the structural-row resolver does, and the caller is told which
// module and which ancestor set to continue in. Undefined means the type is not an alias, NOT that it
// has no shape.
function resolveIrTypeShapeAliasStepCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
): IrTypeShapeAliasStepCpp | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, moduleSet, cache);
  if (resolution.kind !== 'location' || resolution.location.declaration.kind !== 'typeAlias') return undefined;
  const declaration = resolution.location.declaration;
  const key = `${resolution.location.identity}\0${JSON.stringify(type.typeArguments)}`;
  if (ancestors.has(key)) return undefined;
  const typeArguments =
    type.typeArguments.length === 0 && declaration.typeParameters.length > 0
      ? declaration.typeParameters.map(
          (parameter): IrType => ({
            kind: 'named',
            reference: { binding: parameter.binding, kind: 'binding', path: [] },
            typeArguments: [],
          }),
        )
      : type.typeArguments;
  return {
    ancestors: new Set(ancestors).add(key),
    module: resolution.location.module,
    type: resolveIrTypeStructuralSubstitution(
      declaration.type,
      createIrTypeParameterSubstitutionPlan(declaration.typeParameters, typeArguments),
    ),
  };
}

// `Exclude<T, U>` is `T extends U ? never : T`: the members of `T` that `U` does not accept. The
// comparison is ASSIGNABILITY and not shape equality, and the difference is not academic. A subject
// whose `outcome` is the literal `'created'` IS assignable to an exclusion naming `outcome: string`,
// so an equality rule would keep a member the source resolves to `never`. Worse, the shape that
// prompted this -- `Exclude<TrayCreateProviderResult, { outcome: 'created' }>` -- is right under
// either rule, which is exactly how a rule that is wrong in general passes the one case in front of
// it. A member `U` accepts is dropped, and if none survive the answer is `never`, which has no object
// shape and refuses.
function resolveIrTypeExcludedObjectShapeCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
): readonly Readonly<IrObjectTypeProperty>[] | undefined {
  const [subject, exclusion] = type.typeArguments;
  if (!subject || !exclusion) return undefined;
  const comparison: IrTypeStructuralComparisonStateCpp = {
    aliases: new Set(),
    ancestors: new WeakMap(),
    valueQueries: new Set(),
  };
  // `Exclude` is `T extends U ? never : T` applied to the members `T` distributes into, so an alias
  // subject has to be resolved before there are any members to test. Without this the subject is one
  // binding, the test is made against the binding, and the refusal names `Exclude` at a site whose
  // answer was already decided.
  const step = resolveIrTypeShapeAliasStepCpp(subject, module, moduleSet, cache, ancestors);
  const resolved = step?.type ?? subject;
  const resolvedModule = step?.module ?? module;
  const resolvedAncestors = step?.ancestors ?? ancestors;
  const members = resolved.kind === 'union' ? resolved.types : [resolved];
  const surviving = members.filter(
    (member) =>
      !isIrTypeStructurallyAssignableCpp(
        member,
        exclusion,
        resolvedModule,
        moduleSet,
        cache,
        resolvedAncestors,
        comparison,
      ),
  );
  const [first, second, ...rest] = surviving;
  if (!first) return undefined;
  const remaining: Readonly<IrType> = second ? { kind: 'union', types: [first, second, ...rest] } : first;
  // The survivors of an exclusion over a union alias are themselves a union -- `Exclude<TrayCreateProviderResult,
  // { outcome: 'created' }>` keeps four of five branches -- so what remains has to be resolved the way any
  // other union is, by merging the branches. Asking for its object shape alone is the path that has no arm
  // for a union, which is how this arm resolved its subject correctly and still refused.
  return resolveIrTypeDistributedObjectShapeCpp(remaining, resolvedModule, moduleSet, cache, resolvedAncestors);
}

function resolveIrTypeObjectShapeCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
): readonly Readonly<IrObjectTypeProperty>[] | undefined {
  if (type.kind === 'object') return type.properties;
  if (type.kind === 'conditionalFacet') {
    return resolveIrConditionalFacetArmCpp(type, module, moduleSet, cache) ? [] : undefined;
  }
  if (type.kind === 'intersection') {
    const members = type.types.map((member) =>
      resolveIrTypeObjectShapeCpp(member, module, moduleSet, cache, ancestors),
    );
    if (members.some((properties) => !properties)) return undefined;
    return mergeIrObjectShapePropertiesCpp(
      members.flatMap((properties) => properties!),
      module,
      moduleSet,
      cache,
      ancestors,
    );
  }
  if (type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') {
    if (
      (type.reference.name === 'Omit' || type.reference.name === 'Pick') &&
      type.typeArguments.length === 2 &&
      type.typeArguments[0] &&
      type.typeArguments[1]
    ) {
      const properties = resolveIrTypeObjectShapeCpp(type.typeArguments[0], module, moduleSet, cache, ancestors);
      const keys = getIrObjectProjectionKeysCpp(type.typeArguments[1]);
      if (!properties || !keys) return undefined;
      const available = new Set(properties.map((property) => property.name));
      if ([...keys].some((key) => !available.has(key))) return undefined;
      const projection = type.reference.name;
      return properties.filter((property) =>
        projection === 'Pick' ? keys.has(property.name) : !keys.has(property.name),
      );
    }
    if (type.reference.name === 'Exclude' && type.typeArguments.length === 2) {
      return resolveIrTypeExcludedObjectShapeCpp(type, module, moduleSet, cache, ancestors);
    }
    if (type.typeArguments.length !== 1 || !type.typeArguments[0]) return undefined;
    const properties = resolveIrTypeDistributedObjectShapeCpp(
      type.typeArguments[0],
      module,
      moduleSet,
      cache,
      ancestors,
    );
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
    // `NoInfer<T>` withholds a position from TypeScript's inference and is otherwise exactly `T`, so it
    // contributes the shape its argument has. Without this arm the conjunct that `NodeOf<Traits>` turns
    // on -- `Node<Traits> & NoInfer<Traits>` -- is the one member of the intersection with no shape, and
    // the whole family refuses for a wrapper that says nothing about the value it wraps.
    if (type.reference.name === 'NoInfer') {
      return properties;
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
  return mergeIrObjectShapePropertiesCpp(
    [...inheritedProperties.flatMap((properties) => properties!), ...ownProperties],
    location.module,
    moduleSet,
    cache,
    nextAncestors,
  );
}

function resolveIrFacetReferenceCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
): Readonly<{ base: IrType; facet: IrType }> | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind === 'typeParameter' ||
    type.reference.path.length > 0 ||
    type.typeArguments.length > 0
  ) {
    return undefined;
  }
  const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, moduleSet, cache);
  if (resolution.kind !== 'location' || resolution.location.declaration.kind !== 'interface') return undefined;
  const declaration = resolution.location.declaration;
  if (
    declaration.typeParameters.length > 0 ||
    declaration.extends.length !== 1 ||
    declaration.properties.length !== 1
  ) {
    return undefined;
  }
  const marker = declaration.properties[0]!;
  if (
    marker.phantom !== true ||
    !marker.computedKey ||
    marker.optional ||
    !marker.readonly ||
    marker.role ||
    marker.type.kind !== 'literal' ||
    marker.type.value !== true
  ) {
    return undefined;
  }
  return { base: declaration.extends[0]!, facet: type };
}

function resolveIrConditionalFacetArmCpp(
  type: Readonly<Extract<IrType, { kind: 'conditionalFacet' }>>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
): Readonly<{ base: IrType; facet: IrType; path: readonly [string, ...string[]] }> | undefined {
  if (
    type.path.length === 0 ||
    type.path.some((segment) => segment.length === 0) ||
    type.check.kind !== 'named' ||
    type.check.reference.kind !== 'binding' ||
    type.check.reference.binding.kind !== 'typeParameter' ||
    type.check.reference.path.length > 0 ||
    type.check.typeArguments.length > 0
  ) {
    return undefined;
  }
  const facet = resolveIrFacetReferenceCpp(type.facet, module, moduleSet, cache);
  return facet ? { base: facet.base, facet: facet.facet, path: type.path } : undefined;
}

function resolveIrConditionalFacetReferenceCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  aliasCache: Map<string, Readonly<IrType> | null>,
  aliases: ReadonlySet<string>,
):
  | Readonly<{
      base: IrType;
      check: IrType;
      rules: readonly Readonly<{ facet: IrType; path: readonly [string, ...string[]] }>[];
    }>
  | undefined {
  if (type.kind === 'named' && type.reference.kind === 'binding') {
    const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
    if (aliases.has(key)) return undefined;
    const resolved = resolveIrTypeAliasCpp(type, module.module, moduleSet, cache, aliasCache);
    return resolved
      ? resolveIrConditionalFacetReferenceCpp(resolved, module, moduleSet, cache, aliasCache, new Set(aliases).add(key))
      : undefined;
  }
  if (type.kind !== 'intersection') return undefined;
  const conditional = type.types.filter(
    (member): member is Extract<IrType, { kind: 'conditionalFacet' }> => member.kind === 'conditionalFacet',
  );
  const bases = type.types.filter((member) => member.kind !== 'conditionalFacet');
  if (conditional.length === 0 || bases.length !== 1) return undefined;
  const base = bases[0]!;
  if (base.kind !== 'named') return undefined;
  const arms = conditional.map((member) => resolveIrConditionalFacetArmCpp(member, module, moduleSet, cache));
  if (arms.some((arm) => !arm)) return undefined;
  const check = conditional[0]!.check;
  const checkIdentity = normalizeCompilerStructuralValueCanonical(check);
  if (
    conditional.some((member) => normalizeCompilerStructuralValueCanonical(member.check) !== checkIdentity) ||
    arms.some(
      (arm) => normalizeCompilerStructuralValueCanonical(arm!.base) !== normalizeCompilerStructuralValueCanonical(base),
    )
  ) {
    return undefined;
  }
  const rules = arms.map((arm) => ({ facet: arm!.facet, path: arm!.path }));
  const paths = rules.map((rule) => JSON.stringify(rule.path));
  const facets = rules.map((rule) => normalizeCompilerStructuralValueCanonical(rule.facet));
  if (new Set(paths).size !== paths.length || new Set(facets).size !== facets.length) return undefined;
  return { base, check, rules };
}

function resolveIrTypeClosedIntersectionDistributionCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
): Readonly<IrType> | undefined {
  // A union usually arrives as the alias that names it. `CollisionBuiltInShape2D & Entity` holds
  // `CollisionBuiltInShape2D`, a binding, and looking only for a literal union member found no union at
  // all -- so distribution never ran and the intersection refused with a message about
  // multiple-inheritance lowering, four call sites away from the alias that caused it. Each member is
  // resolved one alias step first, the same rule the rest of this file applies: the wrapper is between
  // the value and the thing being looked for, and it is invisible from the symptom every time.
  const resolvedMembers = type.types.map((member, index) => {
    const step = resolveIrTypeShapeAliasStepCpp(member, module, moduleSet, cache, new Set());
    return step?.type ?? type.types[index]!;
  });
  const unionIndexes = resolvedMembers.flatMap((member, index) => (member.kind === 'union' ? [index] : []));
  if (unionIndexes.length !== 1) return undefined;
  const unionIndex = unionIndexes[0]!;
  const union = resolvedMembers[unionIndex];
  if (union?.kind !== 'union') return undefined;
  const branchAlternatives = union.types.map(
    (alternative): readonly Readonly<Extract<IrType, { kind: 'object' }>>[] | undefined => {
      const distributedMembers = resolvedMembers.map((member, index) => (index === unionIndex ? alternative : member));
      const distributed: Readonly<Extract<IrType, { kind: 'intersection' }>> = {
        kind: 'intersection',
        types: [distributedMembers[0]!, distributedMembers[1]!, ...distributedMembers.slice(2)],
      };
      // A branch that is ITSELF a union alias distributes the same way one level down.
      // `CollisionColliderShape3D` is `CollisionBuiltInShape3D | CollisionStaticShape3D` and both members
      // are unions, so the branch reaches here as an alias to a union -- and asking it for an object shape
      // is asking a union for the one thing it does not have. Recursing terminates because each level's
      // union is strictly a branch of the one above it, and the innermost branches are intersections with
      // no union left to find.
      const nested = resolveIrTypeClosedIntersectionDistributionCpp(distributed, module, moduleSet, cache);
      if (!nested) {
        const memberShapes = distributedMembers.map((member) =>
          resolveIrTypeObjectShapeCpp(member, module, moduleSet, cache, new Set()),
        );
        if (memberShapes.some((properties) => !properties)) return undefined;
        // A branch whose discriminant contradicts another member is `never` and drops out of the union:
        // no value is both a sphere and a capsule, so `CollisionBuiltInShape3D & { kind: 'capsule' }`
        // keeps only the capsule branch. The check is narrow on purpose -- both sides must be literal
        // values that cannot overlap -- so a member that is merely unresolvable still refuses rather
        // than silently dropping a branch that might be inhabited.
        const shapes = memberShapes.map((properties) => properties!);
        const contradicts = shapes.some((left, index) =>
          shapes.slice(index + 1).some((right) => isIrContradictoryObjectShapePairCpp(left, right)),
        );
        if (contradicts) return [];
        const properties = resolveIrTypeObjectShapeCpp(distributed, module, moduleSet, cache, new Set());
        return properties ? [{ kind: 'object', properties }] : undefined;
      }
      // The nested branches stay SEPARATE alternatives rather than being merged into one. Merging would
      // claim the value carries every branch's members at once, which is what a union does not say. A
      // fully narrowed nested branch is not a union at all, so it is one alternative.
      const nestedMembers = nested.kind === 'union' ? nested.types : [nested];
      const nestedProperties = nestedMembers.map((member) =>
        resolveIrTypeObjectShapeCpp(member, module, moduleSet, cache, new Set()),
      );
      if (nestedProperties.some((properties) => !properties)) return undefined;
      return nestedProperties.map((properties) => ({ kind: 'object', properties: properties! }));
    },
  );
  if (branchAlternatives.some((alternatives) => !alternatives)) return undefined;
  const alternatives = branchAlternatives.flatMap((alternatives) => alternatives!);
  const [first, second, ...rest] = alternatives;
  if (!first) return undefined;
  return second ? { kind: 'union', types: [first, second, ...rest] } : first;
}

// Two object shapes contradict when they state the same member as literal values that cannot overlap.
// That is the discriminant case and only that case: a member one side leaves unresolvable, or states as
// a non-literal type, is not a contradiction and the caller keeps refusing for it.
function isIrContradictoryObjectShapePairCpp(
  left: readonly Readonly<IrObjectTypeProperty>[],
  right: readonly Readonly<IrObjectTypeProperty>[],
): boolean {
  return left.some((property) => {
    const other = right.find((candidate) => candidate.name === property.name);
    if (!other) return false;
    const leftValues = getIrLiteralValueSetCpp(property.type);
    const rightValues = getIrLiteralValueSetCpp(other.type);
    return Boolean(leftValues && rightValues && ![...leftValues].some((value) => rightValues.has(value)));
  });
}

function getIrLiteralValueSetCpp(type: Readonly<IrType>): ReadonlySet<string> | undefined {
  if (type.kind === 'literal') return new Set([JSON.stringify(type.value)]);
  if (type.kind !== 'union') return undefined;
  const members = type.types.map(getIrLiteralValueSetCpp);
  return members.some((member) => !member) ? undefined : new Set(members.flatMap((member) => [...member!]));
}

// A member repeated across the branches of a distributed union names the union of what those branches
// carry. An already-union member stays flat, so three branches spell one three-member union rather
// than a union nested inside another.
function createIrTypeDistributedMemberTypeCpp(
  existing: Readonly<IrType>,
  property: Readonly<IrType>,
): Readonly<IrType> {
  const members = [
    ...(existing.kind === 'union' ? existing.types : [existing]),
    ...(property.kind === 'union' ? property.types : [property]),
  ];
  return { kind: 'union', types: [members[0]!, members[1]!, ...members.slice(2)] };
}

function getIrObjectProjectionKeysCpp(type: Readonly<IrType>): ReadonlySet<string> | undefined {
  if (type.kind === 'literal' && (typeof type.value === 'number' || typeof type.value === 'string')) {
    return new Set([String(type.value)]);
  }
  if (type.kind === 'typeOf' && type.reference.kind === 'binding' && type.reference.path.length === 0) {
    return new Set([type.reference.binding.name]);
  }
  if (type.kind !== 'union') return undefined;
  const members = type.types.map(getIrObjectProjectionKeysCpp);
  return members.some((member) => !member) ? undefined : new Set(members.flatMap((member) => [...member!]));
}

// `unionOnConflict` separates the two readings of a repeated member name. Members of an INTERSECTION
// must agree: TypeScript gives `{ a: 'x' } & { a: 'y' }` the member `a: never`, so a disagreement is a
// refusal, which is the default. Members of a DISTRIBUTED union must not: `Partial<A | B>` is
// `Partial<A> | Partial<B>`, so reading that member yields the union of what the branches carry, and
// the merged shape states exactly that. Using the intersection reading there would refuse an
// expression whose own type is well formed.
function mergeIrObjectShapePropertiesCpp(
  properties: readonly Readonly<IrObjectTypeProperty>[],
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
  unionOnConflict = false,
): readonly Readonly<IrObjectTypeProperty>[] | undefined {
  const result = new Map<string, Readonly<IrObjectTypeProperty>>();
  for (const property of properties) {
    const existing = result.get(property.name);
    if (!existing) {
      result.set(property.name, property);
      continue;
    }
    if (
      !areIrObjectShapeComputedKeysEquivalentCpp(existing, property, module, moduleSet) ||
      existing.role !== property.role
    ) {
      return undefined;
    }
    const type =
      mergeIrObjectShapePropertyTypesCpp(
        existing.type,
        property.type,
        module,
        moduleSet,
        cache,
        ancestors,
        { aliases: new Set(), ancestors: new WeakMap(), valueQueries: new Set() },
        unionOnConflict,
      ) ?? (unionOnConflict ? createIrTypeDistributedMemberTypeCpp(existing.type, property.type) : undefined);
    if (!type) return undefined;
    result.set(property.name, {
      ...existing,
      optional: existing.optional && property.optional,
      readonly: existing.readonly && property.readonly,
      type,
    });
  }
  return [...result.values()];
}

function areIrObjectShapeComputedKeysEquivalentCpp(
  left: Readonly<IrObjectTypeProperty>,
  right: Readonly<IrObjectTypeProperty>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
): boolean {
  if (!left.computedKey || !right.computedKey) return left.computedKey === right.computedKey;
  return (
    getIrComputedPropertySourceNameCpp(left.computedKey, module, moduleSet) ===
    getIrComputedPropertySourceNameCpp(right.computedKey, module, moduleSet)
  );
}

function getIrComputedPropertySourceNameCpp(
  reference: NonNullable<Readonly<IrObjectTypeProperty>['computedKey']>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
): string {
  if (reference.kind === 'ambient') return reference.name;
  if (reference.binding.kind === 'import') {
    const local = module.importsByBindingId.has(reference.binding.id);
    const owners = moduleSet.namedBindingOwnersByBindingId.get(reference.binding.id) ?? [];
    const owner = local ? module : owners.length === 1 ? owners[0] : undefined;
    const imported = owner?.importsByBindingId.get(reference.binding.id);
    if (imported?.length === 1 && imported[0]!.imported !== '*') {
      return [imported[0]!.imported, ...reference.path].join('.');
    }
  }
  return [reference.binding.name, ...reference.path].join('.');
}

function mergeIrObjectShapePropertyTypesCpp(
  existing: Readonly<IrType>,
  property: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  ancestors: ReadonlySet<string>,
  comparison: IrTypeStructuralComparisonStateCpp,
  unionOnConflict = false,
): Readonly<IrType> | undefined {
  if (JSON.stringify(existing) === JSON.stringify(property)) return existing;
  if (isIrTypeStructurallyAssignableCpp(property, existing, module, moduleSet, cache, ancestors, comparison)) {
    return property;
  }
  if (isIrTypeStructurallyAssignableCpp(existing, property, module, moduleSet, cache, ancestors, comparison)) {
    return existing;
  }
  const existingProperties = resolveIrTypeObjectShapeCpp(existing, module, moduleSet, cache, ancestors);
  const propertyProperties = resolveIrTypeObjectShapeCpp(property, module, moduleSet, cache, ancestors);
  if (!existingProperties || !propertyProperties) return undefined;
  const properties = mergeIrObjectShapePropertiesCpp(
    [...existingProperties, ...propertyProperties],
    module,
    moduleSet,
    cache,
    ancestors,
    unionOnConflict,
  );
  return properties ? { kind: 'object', properties } : undefined;
}

interface IrTypeStructuralComparisonStateCpp {
  readonly aliases: Set<string>;
  readonly ancestors: WeakMap<object, WeakSet<object>>;
  readonly valueQueries: Set<string>;
}

function isIrTypeStructurallyAssignableCpp(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
  shapeAncestors: ReadonlySet<string>,
  comparison: IrTypeStructuralComparisonStateCpp,
): boolean {
  if (JSON.stringify(source) === JSON.stringify(target)) return true;
  const targets = comparison.ancestors.get(source) ?? new WeakSet<object>();
  if (targets.has(target)) return true;
  targets.add(target);
  comparison.ancestors.set(source, targets);
  try {
    if (source.kind === 'union') {
      return source.types.every((member) =>
        isIrTypeStructurallyAssignableCpp(member, target, module, moduleSet, cache, shapeAncestors, comparison),
      );
    }
    if (target.kind === 'union') {
      return target.types.some((member) =>
        isIrTypeStructurallyAssignableCpp(source, member, module, moduleSet, cache, shapeAncestors, comparison),
      );
    }
    const sourceValueQuery = resolveIrTypeValueQueryForShapeComparisonCpp(source, module, moduleSet);
    if (sourceValueQuery && !comparison.valueQueries.has(sourceValueQuery.identity)) {
      comparison.valueQueries.add(sourceValueQuery.identity);
      try {
        return isIrTypeStructurallyAssignableCpp(
          sourceValueQuery.type,
          target,
          sourceValueQuery.module,
          moduleSet,
          cache,
          shapeAncestors,
          comparison,
        );
      } finally {
        comparison.valueQueries.delete(sourceValueQuery.identity);
      }
    }
    const targetValueQuery = resolveIrTypeValueQueryForShapeComparisonCpp(target, module, moduleSet);
    if (targetValueQuery && !comparison.valueQueries.has(targetValueQuery.identity)) {
      comparison.valueQueries.add(targetValueQuery.identity);
      try {
        return isIrTypeStructurallyAssignableCpp(
          source,
          targetValueQuery.type,
          targetValueQuery.module,
          moduleSet,
          cache,
          shapeAncestors,
          comparison,
        );
      } finally {
        comparison.valueQueries.delete(targetValueQuery.identity);
      }
    }
    const sourceAlias = resolveIrTypeAliasForShapeComparisonCpp(source, module, moduleSet, cache);
    if (sourceAlias && !comparison.aliases.has(sourceAlias.identity)) {
      comparison.aliases.add(sourceAlias.identity);
      try {
        return isIrTypeStructurallyAssignableCpp(
          sourceAlias.type,
          target,
          sourceAlias.module,
          moduleSet,
          cache,
          shapeAncestors,
          comparison,
        );
      } finally {
        comparison.aliases.delete(sourceAlias.identity);
      }
    }
    const targetAlias = resolveIrTypeAliasForShapeComparisonCpp(target, module, moduleSet, cache);
    if (targetAlias && !comparison.aliases.has(targetAlias.identity)) {
      comparison.aliases.add(targetAlias.identity);
      try {
        return isIrTypeStructurallyAssignableCpp(
          source,
          targetAlias.type,
          targetAlias.module,
          moduleSet,
          cache,
          shapeAncestors,
          comparison,
        );
      } finally {
        comparison.aliases.delete(targetAlias.identity);
      }
    }
    const sourceProperties = resolveIrTypeObjectShapeCpp(source, module, moduleSet, cache, shapeAncestors);
    const targetProperties = resolveIrTypeObjectShapeCpp(target, module, moduleSet, cache, shapeAncestors);
    if (sourceProperties && targetProperties) {
      const sourceByName = new Map(sourceProperties.map((candidate) => [candidate.name, candidate]));
      return targetProperties.every((targetProperty) => {
        const sourceProperty = sourceByName.get(targetProperty.name);
        if (!sourceProperty) return targetProperty.optional;
        return (
          areIrObjectShapeComputedKeysEquivalentCpp(sourceProperty, targetProperty, module, moduleSet) &&
          sourceProperty.role === targetProperty.role &&
          (!sourceProperty.optional || targetProperty.optional) &&
          (!sourceProperty.readonly || targetProperty.readonly) &&
          isIrTypeStructurallyAssignableCpp(
            sourceProperty.type,
            targetProperty.type,
            module,
            moduleSet,
            cache,
            shapeAncestors,
            comparison,
          )
        );
      });
    }
    return analyzeIrTypeStructuralAssignability(source, target).status === 'compatible';
  } finally {
    targets.delete(target);
  }
}

function resolveIrTypeAliasForShapeComparisonCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
  cache: ReferenceResolutionCache,
):
  | Readonly<{
      identity: string;
      module: Readonly<ReferenceModuleRecord>;
      type: Readonly<IrType>;
    }>
  | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const resolution = getReferenceDeclarationResolutionCpp(type.reference, module, moduleSet, cache);
  if (resolution.kind !== 'location') return undefined;
  const location = resolution.location;
  const declaration = location.declaration;
  if (declaration.kind !== 'typeAlias') return undefined;
  return {
    identity: `${location.identity}\0${JSON.stringify(type.typeArguments)}`,
    module: location.module,
    type: resolveIrTypeStructuralSubstitution(
      declaration.type,
      createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments),
    ),
  };
}

function resolveIrTypeValueQueryForShapeComparisonCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  moduleSet: Readonly<ReferenceModuleSet>,
):
  | Readonly<{
      identity: string;
      module: Readonly<ReferenceModuleRecord>;
      type: Readonly<IrType>;
    }>
  | undefined {
  if (type.kind !== 'typeOf' || type.reference.kind !== 'binding' || type.reference.path.length > 0) return undefined;
  const bindingId = type.reference.binding.id;
  const local = module.valueTypesByBindingId.has(bindingId);
  const owners = moduleSet.valueBindingOwnersByBindingId.get(bindingId) ?? [];
  const owner = local ? module : owners.length === 1 ? owners[0] : undefined;
  const valueType = owner?.valueTypesByBindingId.get(bindingId);
  return owner && valueType
    ? {
        identity: `${owner.identity}\0${bindingId}`,
        module: owner,
        type: valueType,
      }
    : undefined;
}

function createIrTypeReferenceRepresentationPlanInternalCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
): CompilerCppReferenceRepresentationPlan {
  const externalProjection = resolveIrExternalProjectionCpp(type, module, context);
  if (externalProjection) {
    return createIrTypeReferenceRepresentationPlanInternalCpp(externalProjection, module, context);
  }
  const structuralRow = resolveIrTypeStructuralRowCpp(
    type,
    module,
    context.moduleSet,
    context.resolutionCache,
    new Set(),
    false,
  );
  if (structuralRow) {
    return createCompilerCppReferenceRepresentationSuccessCpp(
      context.analyzeIdentity(type, module.module),
      'structuralRow',
      'object',
      'runtimeManaged',
      'runtimeReference',
    );
  }
  const conditionalFacet = resolveIrConditionalFacetReferenceCpp(
    type,
    module,
    context.moduleSet,
    context.resolutionCache,
    new Map(),
    new Set(),
  );
  if (conditionalFacet) {
    const base = createIrTypeReferenceRepresentationPlanInternalCpp(conditionalFacet.base, module, context);
    if (base.kind === 'represented' && base.valueRepresentation === 'flightReference') {
      return createCompilerCppReferenceRepresentationSuccessCpp(
        base.identity,
        'facet',
        'object',
        'runtimeManaged',
        'runtimeReference',
      );
    }
  }
  if (type.kind === 'named' && type.reference.kind === 'ambient') {
    const external = getCompilerExternalBindingEvidenceCpp(type.reference.name, 'type', context.externalBindings);
    if (external) {
      const reference = external.ownership !== 'value';
      const managed = external.ownership === 'owned' || external.ownership === 'shared';
      return createCompilerCppReferenceRepresentationSuccessCpp(
        {
          identity: reference ? 'reference' : 'value',
          reason: reference ? 'declared-reference' : 'declared-value',
          schema: 'flight-compiler-type-value-identity/1',
        },
        'external',
        reference ? 'object' : 'none',
        managed ? 'runtimeManaged' : 'inlineValue',
        managed ? 'runtimeReference' : 'inlineValue',
      );
    }
  }
  const identity = context.analyzeIdentity(type, module.module);
  if (identity.identity === 'indeterminate') {
    const importedAlias = createIndeterminateImportedTypeAliasRepresentationPlanCpp(type, module, context, identity);
    if (importedAlias) return importedAlias;
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

  if (type.kind === 'array' || getIrHomogeneousTupleElementTypeCpp(type)) {
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
    if (isIrCallableOverloadIntersectionRepresentableCpp(type)) {
      return createCompilerCppReferenceRepresentationSuccessCpp(
        identity,
        'value',
        'none',
        'inlineValue',
        'inlineValue',
      );
    }
    if (isIrCallableObjectIntersectionRepresentableCpp(type, module, context)) {
      return createCompilerCppReferenceRepresentationSuccessCpp(
        identity,
        'anonymousObject',
        'object',
        'rawAnonymousObject',
        'flightReference',
      );
    }
    const properties = resolveIrTypeObjectShapeCpp(type, module, context.moduleSet, context.resolutionCache, new Set());
    if (properties) {
      return createCompilerCppReferenceRepresentationSuccessCpp(
        identity,
        'anonymousObject',
        'object',
        'rawAnonymousObject',
        'flightReference',
      );
    }
    const distributed = resolveIrTypeClosedIntersectionDistributionCpp(
      type,
      module,
      context.moduleSet,
      context.resolutionCache,
    );
    return distributed
      ? createCompilerCppReferenceRepresentationSuccessCpp(identity, 'value', 'none', 'inlineValue', 'inlineValue')
      : createCompilerCppReferenceRepresentationRefusalCpp(identity, 'compoundReference');
  }
  return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'unsupportedReferenceForm');
}

// A closed Pick of one externally represented host interface is a source-level view of that host
// value. The checker materializes the selected slots on the derived interface, but those slots do not
// become a second runtime object: WebGL2RenderingContext itself satisfies GlContext. Preserve that
// exact representation only when the declaration adds no members outside the closed key set and the
// target profile owns the projected host type.
function resolveIrExternalProjectionCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
): Readonly<IrType> | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind === 'typeParameter' ||
    type.reference.path.length > 0 ||
    type.typeArguments.length > 0
  ) {
    return undefined;
  }
  const resolution = getReferenceDeclarationResolutionCpp(
    type.reference,
    module,
    context.moduleSet,
    context.resolutionCache,
  );
  if (resolution.kind !== 'location' || resolution.location.declaration.kind !== 'interface') return undefined;
  const declaration = resolution.location.declaration;
  if (declaration.typeParameters.length > 0 || declaration.extends.length !== 1) return undefined;
  const projection = declaration.extends[0]!;
  if (
    projection.reference.kind !== 'ambient' ||
    projection.reference.name !== 'Pick' ||
    projection.typeArguments.length !== 2
  ) {
    return undefined;
  }
  const target = projection.typeArguments[0];
  const keyType = projection.typeArguments[1]!;
  const resolvedKeyType =
    resolveIrTypeAliasCpp(
      keyType,
      resolution.location.module.module,
      context.moduleSet,
      context.resolutionCache,
      new Map(),
    ) ?? keyType;
  const keys = getIrObjectProjectionKeysCpp(resolvedKeyType);
  if (
    target?.kind !== 'named' ||
    target.reference.kind !== 'ambient' ||
    target.typeArguments.length > 0 ||
    !keys ||
    !getCompilerExternalBindingEvidenceCpp(target.reference.name, 'type', context.externalBindings)
  ) {
    return undefined;
  }
  const materialized = new Set(declaration.properties.map((property) => property.name));
  if (materialized.size !== keys.size || [...keys].some((key) => !materialized.has(key))) return undefined;
  return target;
}

function isIrCallableOverloadIntersectionRepresentableCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
): boolean {
  return (
    type.types.length >= 2 &&
    type.types.every(
      (member) =>
        member.kind === 'function' &&
        member.typeParameters.length === 0 &&
        member.parameters.every((parameter) => !parameter.optional && !parameter.rest),
    )
  );
}

function isIrCallableObjectIntersectionRepresentableCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
): boolean {
  if (type.types.length !== 2) return false;
  const callable = type.types.find((member) => member.kind === 'function');
  const object = type.types.find((member) => member !== callable);
  return Boolean(
    callable?.kind === 'function' &&
    callable.typeParameters.length === 0 &&
    callable.parameters.every((parameter) => !parameter.optional && !parameter.rest) &&
    object &&
    resolveIrTypeObjectShapeCpp(object, module, context.moduleSet, context.resolutionCache, new Set()),
  );
}

// A resolved imported type alias already has one C++ representation in its defining header. Its
// source value identity may legitimately be heterogeneous (a scalar/reference union or a phantom
// brand intersection), but the alias name itself is an inline ABI type and must not be wrapped again.
function createIndeterminateImportedTypeAliasRepresentationPlanCpp(
  type: Readonly<IrType>,
  module: Readonly<ReferenceModuleRecord>,
  context: Readonly<ReferencePlanningContext>,
  identity: Readonly<CompilerTypeValueIdentityAnalysis>,
): CompilerCppReferenceRepresentationPlan | undefined {
  if (identity.reason !== 'ambiguous-compound' && identity.reason !== 'unsupported-ambient-utility') return undefined;
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.binding.kind !== 'import') {
    return undefined;
  }
  const resolution = getReferenceDeclarationResolutionCpp(
    type.reference,
    module,
    context.moduleSet,
    context.resolutionCache,
  );
  if (resolution.kind !== 'location' || resolution.location.declaration.kind !== 'typeAlias') return undefined;
  return createCompilerCppReferenceRepresentationSuccessCpp(identity, 'value', 'none', 'inlineValue', 'inlineValue');
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
  const facet = resolveIrFacetReferenceCpp(type, module, context.moduleSet, context.resolutionCache);
  if (facet) {
    const base = createIrTypeReferenceRepresentationPlanInternalCpp(facet.base, resolution.location.module, context);
    if (base.kind !== 'represented' || base.valueRepresentation !== 'flightReference') {
      return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'compoundReference');
    }
    return createCompilerCppReferenceRepresentationSuccessCpp(
      identity,
      'facet',
      'object',
      'runtimeManaged',
      'runtimeReference',
    );
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
  let substitution: ReturnType<typeof createIrTypeParameterSubstitutionPlan>;
  try {
    substitution = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
  } catch (error) {
    if (!isCompilerStructuralTypeSubstitutionFailure(error)) throw error;
    return createCompilerCppReferenceRepresentationRefusalCpp(identity, 'indeterminateIdentity');
  }
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

export function getCppRuntimeReferenceCategory(
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
  const local = module.declarations.has(binding.id) || module.importsByBindingId.has(binding.id);
  const owners = moduleSet.namedBindingOwnersByBindingId.get(binding.id) ?? [];
  const owner = local ? module : owners.length === 1 ? owners[0] : undefined;
  if (!owner) return { kind: 'indeterminate' };
  if (binding.kind !== 'import') {
    if (reference.path.length > 0) return { kind: 'indeterminate' };
    const location = owner.declarations.get(binding.id);
    return location ? { kind: 'location', location } : { kind: 'indeterminate' };
  }
  const imported = owner.importsByBindingId.get(binding.id) ?? [];
  const imports = imported.flatMap(({ imported: importedName, specifier }) => {
    if (importedName === '*' && reference.path.length === 1) {
      return [{ exportName: reference.path[0]!, specifier }];
    }
    return reference.path.length === 0 && importedName !== '*' ? [{ exportName: importedName, specifier }] : [];
  });
  const locations = deduplicateReferenceDeclarationLocationsCpp(
    imports.flatMap(({ exportName, specifier }) =>
      getReferenceSpecifierModulesCpp(owner, specifier, moduleSet, cache).flatMap((target) =>
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
  const namedBindingOwnersByBindingId = new Map<string, ReferenceModuleRecord[]>();
  const typeParameterOwnersByBindingId = new Map<string, ReferenceModuleRecord[]>();
  const valueBindingOwnersByBindingId = new Map<string, ReferenceModuleRecord[]>();
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
    for (const bindingId of new Set([...record.declarations.keys(), ...record.importsByBindingId.keys()])) {
      const owners = namedBindingOwnersByBindingId.get(bindingId) ?? [];
      owners.push(record);
      namedBindingOwnersByBindingId.set(bindingId, owners);
    }
    for (const bindingId of record.typeParameterBindingIds) {
      const owners = typeParameterOwnersByBindingId.get(bindingId) ?? [];
      owners.push(record);
      typeParameterOwnersByBindingId.set(bindingId, owners);
    }
    for (const bindingId of record.valueTypesByBindingId.keys()) {
      const owners = valueBindingOwnersByBindingId.get(bindingId) ?? [];
      owners.push(record);
      valueBindingOwnersByBindingId.set(bindingId, owners);
    }
  }
  return {
    declarationsByBindingId,
    modules: records,
    modulesByIdentity: new Map(records.map((record) => [record.identity, record])),
    modulesByPackageSource,
    namedBindingOwnersByBindingId,
    resolutionTargetsBySpecifier: createReferenceResolutionTargetsCpp(resolution),
    typeParameterOwnersByBindingId,
    valueBindingOwnersByBindingId,
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
    typeParameterBindingIds: Set<string>;
    valueTypesByBindingId: Map<string, Readonly<IrType>>;
  } & Omit<
    ReferenceModuleRecord,
    'declarations' | 'importsByBindingId' | 'typeParameterBindingIds' | 'valueTypesByBindingId'
  > = {
    declarations: new Map(),
    identity,
    importsByBindingId: new Map(),
    module,
    source,
    typeParameterBindingIds: new Set(),
    valueTypesByBindingId: new Map(),
  };
  for (const declaration of module.declarations) {
    if (declaration.kind === 'class' || declaration.kind === 'interface' || declaration.kind === 'typeAlias') {
      record.declarations.set(declaration.binding.id, {
        declaration,
        identity: `${identity}\0${declaration.binding.id}`,
        module: record,
      });
    }
    if (declaration.kind === 'variable' && 'binding' in declaration && declaration.type) {
      record.valueTypesByBindingId.set(declaration.binding.id, declaration.type);
    }
    collectReferenceDeclarationTypeParameterBindingIdsCpp(declaration, record.typeParameterBindingIds);
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

function collectReferenceDeclarationTypeParameterBindingIdsCpp(
  declaration: Readonly<IrDeclaration>,
  bindingIds: Set<string>,
): void {
  switch (declaration.kind) {
    case 'class':
      addReferenceTypeParameterBindingIdsCpp(declaration.typeParameters, bindingIds);
      declaration.methods.forEach((method) =>
        addReferenceTypeParameterBindingIdsCpp(method.typeParameters, bindingIds),
      );
      break;
    case 'function':
    case 'interface':
    case 'typeAlias':
      addReferenceTypeParameterBindingIdsCpp(declaration.typeParameters, bindingIds);
      break;
    case 'enum':
    case 'variable':
      break;
  }
}

function addReferenceTypeParameterBindingIdsCpp(
  parameters: readonly Readonly<{ binding: Readonly<{ id: string }> }>[],
  bindingIds: Set<string>,
): void {
  for (const parameter of parameters) bindingIds.add(parameter.binding.id);
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
