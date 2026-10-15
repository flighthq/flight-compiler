import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerCppCAbiDiagnostic,
  CompilerCppCAbiDiagnosticCode,
  CompilerCppCAbiFunctionPlan,
  CompilerCppCAbiHandlePlan,
  CompilerCppCAbiParameterPlan,
  CompilerCppCAbiPlan,
  CompilerCppCAbiPlanningOptions,
  CompilerCppCAbiPresence,
  CompilerCppCAbiResultPlan,
  IrDeclaration,
  IrFunctionDeclaration,
  IrModule,
  IrType,
} from '../../compiler-types/src/index.js';
import { getCppCompilerPackageIncludePrefix, getCppCompilerPackageNamespace } from './cppCompilerIdentity.js';
import { createIrTypeReferenceRepresentationPlannerCpp } from './cppReferenceRepresentationPlan.js';

type TypeDeclaration = Readonly<Extract<IrDeclaration, { kind: 'class' | 'interface' | 'typeAlias' }>>;

interface FunctionCandidate {
  readonly declaration: Readonly<IrFunctionDeclaration>;
  readonly module: Readonly<IrModule>;
}

interface FunctionDraft {
  readonly handles: readonly HandleDraft[];
  readonly ownerKey: string;
  readonly plan: CompilerCppCAbiFunctionPlan;
}

interface HandleDraft extends CompilerCppCAbiHandlePlan {
  readonly identity: string;
}

interface NamedTypeOwner {
  readonly declaration: TypeDeclaration;
  readonly module: Readonly<IrModule>;
}

interface ReferenceCarrier {
  readonly handle: HandleDraft;
  readonly kind: 'reference';
  readonly presence: Exclude<CompilerCppCAbiPresence, 'not-applicable'>;
  readonly readonly: boolean;
}

interface ScalarCarrier {
  readonly carrier: 'bool' | 'double';
  readonly kind: 'scalar';
}

type Carrier = ReferenceCarrier | ScalarCarrier | Readonly<{ kind: 'void' }>;

interface PlanningContext {
  readonly candidates: readonly FunctionCandidate[];
  readonly modules: readonly Readonly<IrModule>[];
  readonly options: Readonly<CompilerCppCAbiPlanningOptions>;
  readonly referencePlanner: ReturnType<typeof createIrTypeReferenceRepresentationPlannerCpp>;
}

interface CAbiPlanningFailure extends Error {
  readonly code: CompilerCppCAbiDiagnosticCode;
  readonly kind: 'cpp-c-abi-planning-failure';
}

function createCAbiPlanningFailure(code: CompilerCppCAbiDiagnosticCode, message: string): CAbiPlanningFailure {
  return Object.assign(new Error(message), { code, kind: 'cpp-c-abi-planning-failure' as const });
}

function isCAbiPlanningFailure(error: unknown): error is CAbiPlanningFailure {
  return error instanceof Error && 'kind' in error && error.kind === 'cpp-c-abi-planning-failure';
}

const errorPlan = {
  catchesCppExceptions: true,
  initializesOutResultBeforeValidation: true,
  lastError: 'none',
  statusCarrier: 'flight_cpp_status',
  strategy: 'status-return',
  successConstant: 'FLIGHT_CPP_STATUS_OK',
} as const;

const emptyModuleResolution = {
  edges: [],
  schema: 'flight-compiler-module-resolution/1',
} as const;

export function createIrModulesCAbiPlanCpp(
  sourceModules: readonly Readonly<IrModule>[],
  sourceOptions: Readonly<CompilerCppCAbiPlanningOptions> = {},
): CompilerCppCAbiPlan {
  const modules = structuredClone(sourceModules);
  const options = structuredClone(sourceOptions);
  const moduleResolution = options.moduleResolution ?? emptyModuleResolution;
  const candidates = collectFunctionCandidates(modules);
  const context: PlanningContext = {
    candidates,
    modules,
    options,
    referencePlanner: createIrTypeReferenceRepresentationPlannerCpp(modules, moduleResolution),
  };
  const diagnostics: CompilerCppCAbiDiagnostic[] = [];
  const drafts: FunctionDraft[] = [];

  for (const candidate of candidates) {
    try {
      drafts.push(createFunctionDraft(candidate, context));
    } catch (error) {
      if (!isCAbiPlanningFailure(error)) throw error;
      diagnostics.push(createDiagnostic(candidate, error.code, error.message));
    }
  }

  const collidedOwnerKeys = collectGlobalNameCollisionOwners(drafts);
  for (const draft of drafts) {
    if (!collidedOwnerKeys.has(draft.ownerKey)) continue;
    const candidate = candidates.find(
      (entry) => entry.declaration.binding.id === draft.plan.bindingId && entry.module.source === draft.plan.source,
    );
    if (!candidate) throw new TypeError(`missing C ABI candidate ${draft.plan.bindingId}`);
    diagnostics.push(
      createDiagnostic(
        candidate,
        'global-symbol-collision',
        `exported function ${draft.plan.sourceName} cannot enter the flat C ABI because one of its C names is shared by another owner`,
      ),
    );
  }

  const accepted = drafts.filter((draft) => !collidedOwnerKeys.has(draft.ownerKey));
  const handles = new Map<string, CompilerCppCAbiHandlePlan>();
  for (const draft of accepted) {
    for (const handle of draft.handles) {
      handles.set(handle.carrier, {
        carrier: handle.carrier,
        cppTarget: handle.cppTarget,
        header: handle.header,
        ownership: handle.ownership,
        releaseSymbol: handle.releaseSymbol,
        retainSymbol: handle.retainSymbol,
        sourceName: handle.sourceName,
      });
    }
  }

  return {
    diagnostics: diagnostics.sort(compareDiagnostics),
    functions: accepted.map((draft) => draft.plan).sort(compareFunctions),
    handles: [...handles.values()].sort((left, right) => compareTextCodeUnits(left.carrier, right.carrier)),
    policy: {
      error: 'status-plus-initialized-out-result',
      exportPrefix: 'flight_cpp_',
      lastError: 'none',
      lifecycle: 'type-specific-retain-release',
      references: 'incomplete-c-struct-pointers',
      visibility: 'FLIGHT_CPP_API',
    },
    schema: 'flight-compiler-cpp-c-abi-plan/1',
  };
}

function collectFunctionCandidates(modules: readonly Readonly<IrModule>[]): readonly FunctionCandidate[] {
  return modules
    .flatMap((module) => {
      const locallyExported = new Set(
        module.exports.flatMap((entry) => (entry.kind === 'local' && !entry.typeOnly ? [entry.binding.id] : [])),
      );
      return module.declarations.flatMap((declaration): FunctionCandidate[] =>
        declaration.kind === 'function' &&
        !declaration.namespaceMember &&
        (declaration.exported || locallyExported.has(declaration.binding.id))
          ? [{ declaration, module }]
          : [],
      );
    })
    .sort(compareCandidates);
}

function createFunctionDraft(candidate: FunctionCandidate, context: PlanningContext): FunctionDraft {
  const { declaration, module } = candidate;
  if (declaration.overloads.length > 0) {
    throw createCAbiPlanningFailure(
      'overloaded-function',
      `exported function ${declaration.binding.name} has overloads, which ABI v1 does not elect`,
    );
  }
  if (declaration.typeParameters.length > 0) {
    throw createCAbiPlanningFailure(
      'generic-surface',
      `exported function ${declaration.binding.name} is generic, which ABI v1 does not monomorphize`,
    );
  }
  if (declaration.async) {
    throw createCAbiPlanningFailure(
      'unsupported-carrier',
      `exported function ${declaration.binding.name} is async, but ABI v1 has no task carrier`,
    );
  }
  assertExactCppFunctionTarget(candidate, context);

  const handles = new Map<string, HandleDraft>();
  const parameterNames = new Set<string>();
  const parameters = declaration.parameters.map((parameter, position): CompilerCppCAbiParameterPlan => {
    if (parameter.rest) {
      throw createCAbiPlanningFailure(
        'unsupported-parameter',
        `parameter ${parameter.binding.name} is variadic, which ABI v1 does not flatten`,
      );
    }
    const name = safeCIdentifier(parameter.binding.name);
    if (parameterNames.has(name) || name === 'out_result') {
      throw createCAbiPlanningFailure(
        'unsupported-parameter',
        `parameter ${parameter.binding.name} does not have a unique C spelling`,
      );
    }
    parameterNames.add(name);
    const carrier = planCarrier(parameter.type, module, context, false, new Set());
    if (carrier.kind === 'void') {
      throw createCAbiPlanningFailure('unsupported-parameter', `parameter ${parameter.binding.name} has type void`);
    }
    if (carrier.kind === 'scalar') {
      if (parameter.optional) {
        throw createCAbiPlanningFailure(
          'unsupported-parameter',
          `optional scalar parameter ${parameter.binding.name} needs a presence carrier that ABI v1 does not define`,
        );
      }
      return {
        adapter: 'copy-scalar-from-c',
        carrier: carrier.carrier,
        name,
        ownership: 'value',
        position,
        presence: 'required',
      };
    }
    let presence = carrier.presence;
    if (parameter.optional) {
      if (presence === 'nullable-null') {
        throw createCAbiPlanningFailure(
          'dual-sentinel-union',
          `optional parameter ${parameter.binding.name} also admits null, but one C pointer cannot preserve both sentinels`,
        );
      }
      presence = 'nullable-undefined';
    }
    handles.set(carrier.handle.identity, carrier.handle);
    return {
      adapter: carrier.readonly ? 'borrow-readonly-handle' : 'borrow-handle',
      carrier: `${carrier.readonly ? 'const ' : ''}${carrier.handle.carrier}*`,
      name,
      ownership: 'borrowed',
      position,
      presence,
    };
  });

  const resultCarrier = planCarrier(declaration.returns, module, context, false, new Set());
  const result = createResultPlan(resultCarrier, handles);
  const packageNamespace = getCppCompilerPackageNamespace(module.packageName, optionsPackageTargets(context));
  const sourceName = declaration.binding.name;
  const symbol = `flight_cpp_${snakeCase(sourceName)}`;
  return {
    handles: [...handles.values()],
    ownerKey: functionOwnerKey(candidate),
    plan: {
      bindingId: declaration.binding.id,
      cppTarget: `${packageNamespace}::${safeCppValueName(sourceName)}`,
      error: errorPlan,
      header: getPackageHeader(module.packageName, context),
      packageName: module.packageName,
      parameters,
      result,
      source: module.source,
      sourceName,
      symbol,
      visibility: 'FLIGHT_CPP_API',
    },
  };
}

function createResultPlan(carrier: Carrier, handles: Map<string, HandleDraft>): CompilerCppCAbiResultPlan {
  if (carrier.kind === 'void') {
    return { adapter: 'none', kind: 'void', ownership: 'none', presence: 'not-applicable' };
  }
  if (carrier.kind === 'scalar') {
    return {
      adapter: 'copy-scalar-to-out',
      carrier: `${carrier.carrier}*`,
      initialization: 'zero',
      kind: 'out',
      name: 'out_result',
      ownership: 'value',
      presence: 'required',
    };
  }
  handles.set(carrier.handle.identity, carrier.handle);
  return {
    adapter: 'transfer-owned-handle-to-out',
    carrier: `${carrier.handle.carrier}**`,
    initialization: 'null',
    kind: 'out',
    name: 'out_result',
    ownership: 'owned',
    presence: carrier.presence,
  };
}

function planCarrier(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: PlanningContext,
  readonly: boolean,
  visitedAliases: Set<string>,
): Carrier {
  switch (type.kind) {
    case 'primitive':
      if (type.name === 'boolean') return { carrier: 'bool', kind: 'scalar' };
      if (type.name === 'number') return { carrier: 'double', kind: 'scalar' };
      if (type.name === 'void') return { kind: 'void' };
      throw createCAbiPlanningFailure('unsupported-carrier', `primitive ${type.name} has no ABI v1 C carrier`);
    case 'literal':
      if (typeof type.value === 'boolean') return { carrier: 'bool', kind: 'scalar' };
      if (typeof type.value === 'number') return { carrier: 'double', kind: 'scalar' };
      throw createCAbiPlanningFailure('unsupported-carrier', 'string literal values have no ABI v1 C carrier');
    case 'function':
      throw createCAbiPlanningFailure('callable-value', 'callable values have no ABI v1 C carrier');
    case 'object':
      throw createCAbiPlanningFailure(
        'open-structural-type',
        'structural object values have no named, closed ABI v1 owner',
      );
    case 'unknown':
      throw createCAbiPlanningFailure('open-structural-type', `${type.source} values have no closed ABI v1 carrier`);
    case 'union':
      return planUnionCarrier(type, module, context, readonly, visitedAliases);
    case 'named':
      return planNamedCarrier(type, module, context, readonly, visitedAliases);
    case 'array':
    case 'conditionalFacet':
    case 'indexedAccess':
    case 'intersection':
    case 'keyof':
    case 'never':
    case 'null':
    case 'tuple':
    case 'typeOf':
    case 'undefined':
      throw createCAbiPlanningFailure('unsupported-carrier', `${type.kind} has no ABI v1 C carrier`);
  }
}

function planUnionCarrier(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  module: Readonly<IrModule>,
  context: PlanningContext,
  readonly: boolean,
  visitedAliases: Set<string>,
): Carrier {
  const hasNull = type.types.some((alternative) => alternative.kind === 'null');
  const hasUndefined = type.types.some((alternative) => alternative.kind === 'undefined');
  if (hasNull && hasUndefined) {
    throw createCAbiPlanningFailure(
      'dual-sentinel-union',
      'a C pointer cannot preserve distinct null and undefined alternatives',
    );
  }
  const values = type.types.filter((alternative) => alternative.kind !== 'null' && alternative.kind !== 'undefined');
  if ((hasNull || hasUndefined) && values.length === 1) {
    const value = planCarrier(values[0]!, module, context, readonly, visitedAliases);
    if (value.kind !== 'reference') {
      throw createCAbiPlanningFailure(
        'unsupported-carrier',
        'nullable ABI v1 carriers must be opaque references represented by pointers',
      );
    }
    return { ...value, presence: hasNull ? 'nullable-null' : 'nullable-undefined' };
  }
  throw createCAbiPlanningFailure('unsupported-carrier', 'multi-value unions have no ABI v1 C carrier');
}

function planNamedCarrier(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  module: Readonly<IrModule>,
  context: PlanningContext,
  readonly: boolean,
  visitedAliases: Set<string>,
): Carrier {
  if (type.reference.kind === 'ambient') {
    if (type.reference.name === 'Readonly' && type.typeArguments.length === 1) {
      return planCarrier(type.typeArguments[0]!, module, context, true, visitedAliases);
    }
    if (type.reference.name === 'Readonly') {
      throw createCAbiPlanningFailure('generic-surface', 'Readonly must have exactly one closed type argument');
    }
    throw createCAbiPlanningFailure(
      type.reference.name === 'Function' ? 'callable-value' : 'unsupported-carrier',
      `ambient type ${type.reference.name} has no ABI v1 C carrier`,
    );
  }
  if (type.reference.path.length > 0) {
    throw createCAbiPlanningFailure('ambiguous-owner', 'qualified named types do not identify one ABI v1 owner');
  }
  if (type.reference.binding.kind === 'typeParameter' || type.typeArguments.length > 0) {
    throw createCAbiPlanningFailure('generic-surface', 'generic types are not monomorphized by ABI v1');
  }
  const owner = resolveNamedTypeOwner(type, module, context);
  if (!owner) {
    throw createCAbiPlanningFailure(
      'ambiguous-owner',
      `named type ${type.reference.binding.name} does not resolve to exactly one declaration owner`,
    );
  }
  const { declaration, module: ownerModule } = owner;
  if (declaration.typeParameters.length > 0) {
    throw createCAbiPlanningFailure(
      'generic-surface',
      `named type ${declaration.binding.name} is generic, which ABI v1 does not monomorphize`,
    );
  }
  if (declaration.kind === 'typeAlias') {
    const identity = typeOwnerKey(owner);
    if (visitedAliases.has(identity)) {
      throw createCAbiPlanningFailure('ambiguous-owner', `type alias ${declaration.binding.name} is cyclic`);
    }
    const nextVisited = new Set(visitedAliases);
    nextVisited.add(identity);
    const resolved = context.referencePlanner.resolveAlias(type, module);
    if (!resolved) {
      throw createCAbiPlanningFailure(
        'ambiguous-owner',
        `type alias ${declaration.binding.name} does not resolve to one ABI v1 carrier`,
      );
    }
    return planCarrier(resolved, ownerModule, context, readonly, nextVisited);
  }
  if (declaration.kind === 'interface' && declaration.indexSignature) {
    throw createCAbiPlanningFailure(
      'open-structural-type',
      `interface ${declaration.binding.name} admits an open indexed member set`,
    );
  }
  assertExactCppTypeTarget(owner, context);
  const carrier = `flight_cpp_${snakeCase(declaration.binding.name)}`;
  const header = getPackageHeader(ownerModule.packageName, context);
  const namespace = getCppCompilerPackageNamespace(ownerModule.packageName, optionsPackageTargets(context));
  const typeName = safeCppTypeName(declaration.binding.name);
  return {
    handle: {
      carrier,
      cppTarget: `${namespace}::${typeName}`,
      header,
      identity: typeOwnerKey(owner),
      ownership: 'opaque-reference',
      releaseSymbol: `${carrier}_release`,
      retainSymbol: `${carrier}_retain`,
      sourceName: declaration.binding.name,
    },
    kind: 'reference',
    presence: 'required',
    readonly,
  };
}

function resolveNamedTypeOwner(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  module: Readonly<IrModule>,
  context: PlanningContext,
): NamedTypeOwner | undefined {
  if (type.reference.kind !== 'binding') return undefined;
  const binding = type.reference.binding;
  const direct = context.modules.flatMap((candidateModule) =>
    candidateModule.declarations.flatMap((declaration): NamedTypeOwner[] =>
      isTypeDeclaration(declaration) && declaration.binding.id === binding.id
        ? [{ declaration, module: candidateModule }]
        : [],
    ),
  );
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;

  const imports = module.imports.flatMap((importItem) =>
    importItem.bindings.flatMap((imported) =>
      imported.binding.id === binding.id ? [{ imported: imported.imported, specifier: importItem.specifier }] : [],
    ),
  );
  const owners = imports.flatMap((imported) =>
    context.referencePlanner
      .resolveModules(imported.specifier, module)
      .flatMap((target) => resolveExportedTypeOwners(target, imported.imported, context, new Set())),
  );
  const unique = dedupeTypeOwners(owners);
  return unique.length === 1 ? unique[0] : undefined;
}

function resolveExportedTypeOwners(
  module: Readonly<IrModule>,
  exportedName: string,
  context: PlanningContext,
  visited: Set<string>,
): readonly NamedTypeOwner[] {
  const visitKey = `${module.packageName}\0${module.source}\0${exportedName}`;
  if (visited.has(visitKey)) return [];
  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);
  const direct = module.declarations.flatMap((declaration): NamedTypeOwner[] =>
    isTypeDeclaration(declaration) && declaration.exported && declaration.binding.name === exportedName
      ? [{ declaration, module }]
      : [],
  );
  const routed = module.exports.flatMap((exported): NamedTypeOwner[] => {
    if (exported.kind === 'local' && exported.typeOnly && exported.exported === exportedName) {
      return module.declarations.flatMap((declaration) =>
        isTypeDeclaration(declaration) && declaration.binding.id === exported.binding.id
          ? [{ declaration, module }]
          : [],
      );
    }
    if (exported.kind === 'reexport' && exported.exported === exportedName) {
      return context.referencePlanner
        .resolveModules(exported.specifier, module)
        .flatMap((target) => resolveExportedTypeOwners(target, exported.imported, context, nextVisited));
    }
    if (exported.kind === 'all') {
      return context.referencePlanner
        .resolveModules(exported.specifier, module)
        .flatMap((target) => resolveExportedTypeOwners(target, exportedName, context, nextVisited));
    }
    return [];
  });
  return dedupeTypeOwners([...direct, ...routed]);
}

function dedupeTypeOwners(owners: readonly NamedTypeOwner[]): readonly NamedTypeOwner[] {
  const unique = new Map<string, NamedTypeOwner>();
  for (const owner of owners) unique.set(typeOwnerKey(owner), owner);
  return [...unique.values()].sort((left, right) => compareTextCodeUnits(typeOwnerKey(left), typeOwnerKey(right)));
}

function assertExactCppFunctionTarget(candidate: FunctionCandidate, context: PlanningContext): void {
  const target = safeCppValueName(candidate.declaration.binding.name);
  const owners = context.modules.flatMap((module) => {
    if (module.packageName !== candidate.module.packageName) return [];
    const localExports = new Set(module.exports.flatMap((entry) => (entry.kind === 'local' ? [entry.binding.id] : [])));
    return module.declarations.flatMap((declaration) => {
      if (!('binding' in declaration) || (!declaration.exported && !localExports.has(declaration.binding.id)))
        return [];
      const name =
        declaration.binding.space === 'type' || declaration.kind === 'class' || declaration.kind === 'enum'
          ? safeCppTypeName(declaration.binding.name)
          : safeCppValueName(declaration.binding.name);
      return name === target ? [declaration.binding.id] : [];
    });
  });
  if (new Set(owners).size !== 1) {
    throw createCAbiPlanningFailure(
      'ambiguous-owner',
      `exported function ${candidate.declaration.binding.name} does not have one unambiguous C++ target`,
    );
  }
}

function assertExactCppTypeTarget(owner: NamedTypeOwner, context: PlanningContext): void {
  const target = safeCppTypeName(owner.declaration.binding.name);
  const owners = context.modules.flatMap((module) => {
    if (module.packageName !== owner.module.packageName) return [];
    const localExports = new Set(module.exports.flatMap((entry) => (entry.kind === 'local' ? [entry.binding.id] : [])));
    return module.declarations.flatMap((declaration) => {
      if (
        !isTypeDeclaration(declaration) ||
        (!declaration.exported && !localExports.has(declaration.binding.id)) ||
        safeCppTypeName(declaration.binding.name) !== target
      ) {
        return [];
      }
      return [declaration.binding.id];
    });
  });
  if (!owners.includes(owner.declaration.binding.id) || new Set(owners).size !== 1) {
    throw createCAbiPlanningFailure(
      'ambiguous-owner',
      `named type ${owner.declaration.binding.name} does not have one exported C++ target`,
    );
  }
}

function collectGlobalNameCollisionOwners(drafts: readonly FunctionDraft[]): ReadonlySet<string> {
  const names = new Map<string, Map<string, Set<string>>>();
  const add = (name: string, entity: string, ownerKey: string): void => {
    const entities = names.get(name) ?? new Map<string, Set<string>>();
    const owners = entities.get(entity) ?? new Set<string>();
    owners.add(ownerKey);
    entities.set(entity, owners);
    names.set(name, entities);
  };
  for (const draft of drafts) {
    add(draft.plan.symbol, `function:${draft.ownerKey}`, draft.ownerKey);
    for (const handle of draft.handles) {
      const entity = `handle:${handle.identity}`;
      add(`tag:${handle.carrier}`, entity, draft.ownerKey);
      add(handle.retainSymbol, entity, draft.ownerKey);
      add(handle.releaseSymbol, entity, draft.ownerKey);
    }
  }
  const collided = new Set<string>();
  for (const entities of names.values()) {
    if (entities.size < 2) continue;
    for (const owners of entities.values()) {
      for (const owner of owners) collided.add(owner);
    }
  }
  return collided;
}

function getPackageHeader(packageName: string, context: PlanningContext): string {
  const configured = getCppCompilerPackageIncludePrefix(packageName, optionsPackageTargets(context));
  const prefix =
    configured ??
    `flight/${getBarePackageName(packageName)
      .replace(/[^A-Za-z0-9]+/gu, '_')
      .toLowerCase()}`;
  return `${prefix}.h`;
}

function getBarePackageName(packageName: string): string {
  const separator = packageName.indexOf('/');
  const bare = packageName.startsWith('@') && separator > 1 ? packageName.slice(separator + 1) : packageName;
  if (bare.length === 0 || bare.includes('/'))
    throw new TypeError(`Cannot map invalid npm package name: ${packageName}`);
  return bare;
}

function optionsPackageTargets(
  context: PlanningContext,
): Readonly<Record<string, Readonly<{ includePrefix: string; namespace: string }>>> {
  return context.options.packageTargets ?? {};
}

function createDiagnostic(
  candidate: FunctionCandidate,
  code: CompilerCppCAbiDiagnosticCode,
  message: string,
): CompilerCppCAbiDiagnostic {
  return {
    bindingId: candidate.declaration.binding.id,
    classification: 'compiler-restriction',
    code,
    kind: 'cpp-c-abi',
    message,
    packageName: candidate.module.packageName,
    source: candidate.module.source,
    sourceName: candidate.declaration.binding.name,
    target: 'cpp',
  };
}

function functionOwnerKey(candidate: FunctionCandidate): string {
  return `${candidate.module.packageName}\0${candidate.module.source}\0${candidate.declaration.binding.id}`;
}

function typeOwnerKey(owner: NamedTypeOwner): string {
  return `${owner.module.packageName}\0${owner.module.source}\0${owner.declaration.binding.id}`;
}

function isTypeDeclaration(declaration: Readonly<IrDeclaration>): declaration is TypeDeclaration {
  return declaration.kind === 'class' || declaration.kind === 'interface' || declaration.kind === 'typeAlias';
}

function compareCandidates(left: FunctionCandidate, right: FunctionCandidate): number {
  return compareTextCodeUnits(functionOwnerKey(left), functionOwnerKey(right));
}

function compareFunctions(left: CompilerCppCAbiFunctionPlan, right: CompilerCppCAbiFunctionPlan): number {
  return compareTextCodeUnits(
    `${left.symbol}\0${left.packageName}\0${left.source}\0${left.bindingId}`,
    `${right.symbol}\0${right.packageName}\0${right.source}\0${right.bindingId}`,
  );
}

function compareDiagnostics(left: CompilerCppCAbiDiagnostic, right: CompilerCppCAbiDiagnostic): number {
  return compareTextCodeUnits(
    `${left.packageName}\0${left.source}\0${left.bindingId}\0${left.code}`,
    `${right.packageName}\0${right.source}\0${right.bindingId}\0${right.code}`,
  );
}

function safeCIdentifier(value: string): string {
  const snake = snakeCase(value) || 'value';
  return cKeywords.has(snake) ? `${snake}_` : snake;
}

function safeCppValueName(value: string): string {
  const snake = snakeCase(value) || 'value';
  return cppKeywords.has(snake) ? `${snake}_` : snake;
}

function safeCppTypeName(value: string): string {
  return (
    value
      .replace(/(?:^|[_\-\s])([a-zA-Z])/gu, (_, letter: string) => letter.toUpperCase())
      .replace(/[^A-Za-z0-9]/gu, '') || 'Type'
  );
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

const cKeywords = new Set([
  'auto',
  'break',
  'case',
  'char',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'float',
  'for',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'register',
  'restrict',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'typedef',
  'union',
  'unsigned',
  'void',
  'volatile',
  'while',
]);

const cppKeywords = new Set([
  ...cKeywords,
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'bitand',
  'bitor',
  'bool',
  'catch',
  'class',
  'compl',
  'concept',
  'const_cast',
  'consteval',
  'constexpr',
  'constinit',
  'co_await',
  'co_return',
  'co_yield',
  'decltype',
  'delete',
  'dynamic_cast',
  'explicit',
  'export',
  'false',
  'friend',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'reinterpret_cast',
  'requires',
  'static_assert',
  'static_cast',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typeid',
  'typename',
  'using',
  'virtual',
  'wchar_t',
  'xor',
  'xor_eq',
]);
