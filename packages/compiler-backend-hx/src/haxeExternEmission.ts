import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { createBackendEmissionFailure, createCompilerGeneratedFileHeader } from '../../compiler-emission/src/index.js';
import {
  createCompilerLoweringPassInterfaceInheritance,
  lowerIrModuleWithCompilerPasses,
} from '../../compiler-lowering/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerModuleResolutionPlan,
  CompilerModuleFacadePlan,
  CompilerLoweringPass,
  EmittedFile,
  HaxeCompilerBackendOptions,
  IrBindingIdentity,
  IrClassDeclaration,
  IrDeclaration,
  IrEnumDeclaration,
  IrFunctionDeclaration,
  IrFunctionSignature,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectTypeProperty,
  IrParameter,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrTypeReference,
  IrVariableDeclaration,
  CompilerStructuralTypeSubstitutionPlan,
} from '../../compiler-types/src/index.js';
import { convertPackageNameToHaxePackageName } from './haxeCompilerIdentity.js';
import {
  getCompilerAmbientUtilityHeritageTargetHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
  isCompilerAmbientUtilityHeritageErasableHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

interface HaxeExternEmissionContext {
  readonly ambientUtilityHeritageTargets: ReadonlyMap<string, string>;
  readonly index: HaxeExternEmissionIndex;
  readonly interfaceInheritancePass: Readonly<CompilerLoweringPass>;
  readonly module: Readonly<IrModule>;
  readonly packageFacade: Readonly<CompilerModuleFacadePlan> | undefined;
  readonly options: Readonly<HaxeCompilerBackendOptions>;
  readonly rootPackage: string;
}

interface HaxeExternExportedValue {
  readonly declaration: Readonly<IrFunctionDeclaration | IrVariableDeclaration>;
  readonly exportName: string;
  readonly module: Readonly<IrModule>;
}

interface HaxeExternTypeAliasLocation {
  readonly declaration: Readonly<IrTypeAliasDeclaration>;
  readonly module: Readonly<IrModule>;
}

interface HaxeExternInterfaceLocation {
  readonly declaration: Readonly<IrInterfaceDeclaration>;
  readonly module: Readonly<IrModule>;
}

interface HaxeExternImportRoute {
  readonly from: Readonly<IrModule>;
  readonly imported: string;
  readonly specifier: string;
}

interface HaxeExternDeclarationLocation {
  readonly declaration: Readonly<IrDeclaration & { readonly binding: IrBindingIdentity | IrTypeBindingIdentity }>;
  readonly module: Readonly<IrModule>;
}

interface HaxeExternEmissionIndex {
  readonly activeDependencyClasses: Set<string>;
  readonly declarationLocations: ReadonlyMap<string, readonly HaxeExternDeclarationLocation[]>;
  readonly dependencyClassFiles: Map<string, EmittedFile>;
  readonly emittedDependencyClassFiles: Set<string>;
  readonly exportedTypeAliases: Map<string, readonly HaxeExternTypeAliasLocation[]>;
  readonly importRoutes: ReadonlyMap<string, readonly HaxeExternImportRoute[]>;
  readonly localExportNames: Map<string, readonly string[]>;
  readonly moduleOrdinals: ReadonlyMap<string, number>;
  readonly modules: readonly Readonly<IrModule>[];
  readonly modulesByPackage: ReadonlyMap<string, readonly Readonly<IrModule>[]>;
  readonly modulesByPackageSource: ReadonlyMap<string, readonly Readonly<IrModule>[]>;
  readonly normalizedPaths: Map<string, string>;
  readonly packageOwners: ReadonlyMap<string, Readonly<IrModule>>;
  readonly resolutionExact: ReadonlyMap<string, readonly string[]>;
  readonly resolutionFallback: ReadonlyMap<string, readonly string[]>;
  readonly specifierModules: Map<string, readonly Readonly<IrModule>[]>;
  readonly typeAliasLocations: Map<string, readonly HaxeExternTypeAliasLocation[]>;
}

export function createHaxeExternEmissionIndex(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): HaxeExternEmissionIndex {
  const normalizedPaths = new Map<string, string>();
  const normalize = (source: string) => {
    const cached = normalizedPaths.get(source);
    if (cached !== undefined) return cached;
    const normalized = normalizePathPortable(source);
    normalizedPaths.set(source, normalized);
    return normalized;
  };
  const moduleKey = (module: Readonly<Pick<IrModule, 'name' | 'packageName' | 'source'>>) =>
    `${module.packageName}\0${normalize(module.source)}\0${module.name}`;
  const packageSourceKey = (packageName: string, source: string) => `${packageName}\0${normalize(source)}`;
  const append = <Value>(map: Map<string, Value[]>, key: string, value: Value) => {
    const values = map.get(key);
    if (values) values.push(value);
    else map.set(key, [value]);
  };
  const declarationLocations = new Map<string, HaxeExternDeclarationLocation[]>();
  const importRoutes = new Map<string, HaxeExternImportRoute[]>();
  const modulesByPackage = new Map<string, Readonly<IrModule>[]>();
  const modulesByPackageSource = new Map<string, Readonly<IrModule>[]>();
  const moduleOrdinals = new Map<string, number>();
  modules.forEach((module, ordinal) => {
    moduleOrdinals.set(moduleKey(module), ordinal);
    append(modulesByPackage, module.packageName, module);
    append(modulesByPackageSource, packageSourceKey(module.packageName, module.source), module);
    for (const declaration of module.declarations) {
      if ('binding' in declaration) append(declarationLocations, declaration.binding.id, { declaration, module });
    }
    for (const imported of module.imports) {
      for (const candidate of imported.bindings) {
        append(importRoutes, candidate.binding.id, {
          from: module,
          imported: candidate.imported,
          specifier: imported.specifier,
        });
      }
    }
  });
  const resolutionExact = new Map<string, string[]>();
  const resolutionFallback = new Map<string, string[]>();
  for (const edge of moduleResolution?.edges ?? []) {
    const target = packageSourceKey(edge.target.packageName, edge.target.source);
    append(
      edge.importer ? resolutionExact : resolutionFallback,
      edge.importer ? `${moduleKey(edge.importer)}\0${edge.specifier}` : edge.specifier,
      target,
    );
  }
  const packageOwners = new Map<string, Readonly<IrModule>>();
  for (const [packageName, packageModules] of modulesByPackage) {
    const owner = [...packageModules].sort(compareModulesHaxeExtern)[0];
    if (owner) packageOwners.set(packageName, owner);
  }
  return {
    activeDependencyClasses: new Set(),
    declarationLocations,
    dependencyClassFiles: new Map(),
    emittedDependencyClassFiles: new Set(),
    exportedTypeAliases: new Map(),
    importRoutes,
    localExportNames: new Map(),
    moduleOrdinals,
    modules,
    modulesByPackage,
    modulesByPackageSource,
    normalizedPaths,
    packageOwners,
    resolutionExact,
    resolutionFallback,
    specifierModules: new Map(),
    typeAliasLocations: new Map(),
  };
}

export function emitIrModuleHaxeExtern(
  module: Readonly<IrModule>,
  options: Readonly<HaxeCompilerBackendOptions> = {},
): readonly EmittedFile[] {
  return emitIrModuleHaxeExternWithContext(module, [module], undefined, options);
}

export function emitIrModuleHaxeExternWithContext(
  sourceModule: Readonly<IrModule>,
  sourceModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  options: Readonly<HaxeCompilerBackendOptions>,
  interfaceInheritancePass?: Readonly<CompilerLoweringPass> | undefined,
  packageContract?: Readonly<IrModule> | undefined,
  getModuleFacade?: ((module: Readonly<IrModule>) => CompilerModuleFacadePlan | undefined) | undefined,
  emissionIndex?: HaxeExternEmissionIndex | undefined,
): readonly EmittedFile[] {
  const ambientUtilityHeritageTargets = createAmbientUtilityHeritageTargetsHaxeExtern(sourceModule);
  const inheritancePass =
    interfaceInheritancePass ??
    createCompilerLoweringPassInterfaceInheritance(sourceModules, moduleResolution, {
      eraseAmbientHeritage: (reference, declaration) =>
        !declaration.exported &&
        reference.reference.kind === 'ambient' &&
        getCompilerRuntimeExternalSymbolTargetHaxe(reference.reference.name, 'type') !== undefined,
      eraseAmbientUtilityHeritage: (reference, declaration) =>
        ambientUtilityHeritageTargets.has(declaration.binding.id) ||
        isCompilerAmbientUtilityHeritageErasableHaxe(reference),
    });
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [inheritancePass]);
  const index = emissionIndex ?? createHaxeExternEmissionIndex(sourceModules, moduleResolution);
  const contract = packageContract
    ? isSameModuleHaxeExtern(module, packageContract, index)
      ? module
      : packageContract
    : undefined;
  const context: HaxeExternEmissionContext = {
    ambientUtilityHeritageTargets,
    index,
    interfaceInheritancePass: inheritancePass,
    module,
    options,
    packageFacade: contract && getModuleFacade ? getModuleFacade(contract) : undefined,
    rootPackage: getRootPackageHaxeExtern(module.packageName, options),
  };
  assertModuleShapeHaxeExtern(context);
  const files = module.declarations.flatMap((declaration) => {
    if (declaration.kind === 'class') return emitClassFilesHaxeExtern(declaration, context);
    if (declaration.kind === 'interface') return emitInterfaceFilesHaxeExtern(declaration, context);
    if (declaration.kind === 'enum') return emitEnumFilesHaxeExtern(declaration, context);
    if (declaration.kind === 'typeAlias') return emitTypeAliasFilesHaxeExtern(declaration, context);
    return [];
  });
  if (isPackageHolderOwnerHaxeExtern(module, index)) {
    const holder = emitPackageHolderHaxeExtern(module.packageName, context);
    if (holder) files.push(holder);
  }
  for (const [path, dependency] of index.dependencyClassFiles) {
    if (index.emittedDependencyClassFiles.has(path)) continue;
    index.emittedDependencyClassFiles.add(path);
    files.push(dependency);
  }
  return files;
}

function assertModuleShapeHaxeExtern(context: HaxeExternEmissionContext): void {
  if (context.packageFacade) {
    if (!isPackageHolderOwnerHaxeExtern(context.module, context.index)) return;
    for (const slot of getPackageFacadeSlotsHaxeExtern(context)) {
      if (slot.route.kind === 'expression') {
        emissionErrorHaxeExtern(context, 'default expression exports have no flight-hx extern representation');
      }
      if (slot.route.kind === 'namespace') {
        emissionErrorHaxeExtern(context, 'namespace exports have no flight-hx extern representation');
      }
    }
    return;
  }
  for (const exported of context.module.exports) {
    if (exported.kind === 'default') {
      emissionErrorHaxeExtern(context, 'default expression exports have no flight-hx extern representation');
    }
  }
  for (const declaration of context.module.declarations) {
    const exportNames = getLocalExportNamesHaxeExtern(declaration, context.module, context.index);
    if (exportNames.length === 0) continue;
    if (declaration.kind === 'variable' && !('binding' in declaration)) {
      emissionErrorHaxeExtern(
        context,
        'exported binding patterns require declaration splitting before extern emission',
      );
    }
  }
}

function emitClassFilesHaxeExtern(
  declaration: Readonly<IrClassDeclaration>,
  context: HaxeExternEmissionContext,
): EmittedFile[] {
  assertClassShapeHaxeExtern(declaration, context);
  return getDeclarationExportNamesHaxeExtern(declaration, context, 'type').map((exportName) =>
    emitClassFileHaxeExtern(declaration, safeHaxeExternTypeName(exportName), context, exportName),
  );
}

function assertClassShapeHaxeExtern(
  declaration: Readonly<IrClassDeclaration>,
  context: HaxeExternEmissionContext,
): void {
  if (declaration.classConstructor && declaration.classConstructor.overloads.length > 0) {
    emissionErrorHaxeExtern(context, `class ${declaration.binding.name} constructor overloads require Haxe metadata`);
  }
  const unsupportedMethod = declaration.methods.find(
    (method) => method.visibility === 'public' && method.overloads.length > 0,
  );
  if (unsupportedMethod) {
    emissionErrorHaxeExtern(
      context,
      `class ${declaration.binding.name} method ${unsupportedMethod.name} overloads require Haxe metadata`,
    );
  }
}

function emitClassFileHaxeExtern(
  declaration: Readonly<IrClassDeclaration>,
  targetName: string,
  context: HaxeExternEmissionContext,
  publicExportName?: string | undefined,
): EmittedFile {
  const packageName = `${context.rootPackage}._js`;
  const heritage = [
    ...(declaration.extends ? [`extends ${emitTypeHaxeExtern(declaration.extends, context)}`] : []),
    ...declaration.implements.map((type) => `implements ${emitTypeHaxeExtern(type, context)}`),
  ].join(' ');
  const lines = [
    createCompilerGeneratedFileHeader(context.module, '//', context.options.upstreamCommit),
    '#if js',
    `package ${packageName};`,
    '',
    ...(publicExportName
      ? [`@:jsImport(${JSON.stringify(`${context.module.packageName}/contract`)}, ${JSON.stringify(publicExportName)})`]
      : []),
    `extern class ${targetName}${emitTypeParametersHaxeExtern(declaration.typeParameters, context)}${heritage ? ` ${heritage}` : ''} {`,
  ];
  for (const field of declaration.fields.filter((candidate) => candidate.visibility === 'public')) {
    const name = safeHaxeExternName(field.name);
    if (name !== field.name) lines.push(`  @:native(${JSON.stringify(field.name)})`);
    const optional = field.optional ? '@:optional ' : '';
    const target = field.readonly ? `${name}(default, null)` : name;
    lines.push(
      `  ${optional}public ${field.static ? 'static ' : ''}var ${target}:${emitStructureFieldTypeHaxeExtern(field.type, context)};`,
    );
  }
  const accessors = new Map<string, { get: boolean; set: boolean; static: boolean; type: Readonly<IrType> }>();
  for (const method of declaration.methods.filter(
    (candidate) => candidate.visibility === 'public' && candidate.accessor !== undefined,
  )) {
    const type = method.accessor === 'get' ? method.returns : method.parameters[0]?.type;
    if (!type) {
      emissionErrorHaxeExtern(context, `class ${declaration.binding.name} setter ${method.name} requires a value`);
    }
    const existing = accessors.get(method.name);
    if (existing && existing.static !== method.static) {
      emissionErrorHaxeExtern(
        context,
        `class ${declaration.binding.name} accessor ${method.name} has mixed static state`,
      );
    }
    accessors.set(method.name, {
      get: existing?.get === true || method.accessor === 'get',
      set: existing?.set === true || method.accessor === 'set',
      static: method.static,
      type: existing?.type ?? type,
    });
  }
  for (const [sourceName, accessor] of accessors) {
    const name = safeHaxeExternName(sourceName);
    if (name !== sourceName) lines.push(`  @:native(${JSON.stringify(sourceName)})`);
    const target =
      accessor.get && accessor.set
        ? name
        : `${name}(${accessor.get ? 'default' : 'never'}, ${accessor.set ? 'default' : 'null'})`;
    lines.push(
      `  public ${accessor.static ? 'static ' : ''}var ${target}:${emitStructureFieldTypeHaxeExtern(accessor.type, context)};`,
    );
  }
  const constructorParameters = declaration.classConstructor?.parameters ?? [];
  lines.push(`  public function new(${emitParametersHaxeExtern(constructorParameters, context)});`);
  for (const method of declaration.methods.filter(
    (candidate) => candidate.visibility === 'public' && candidate.accessor === undefined,
  )) {
    const name = safeHaxeExternName(method.name);
    if (name !== method.name) lines.push(`  @:native(${JSON.stringify(method.name)})`);
    lines.push(`  public ${method.static ? 'static ' : ''}${emitFunctionSignatureHaxeExtern(name, method, context)}`);
  }
  lines.push('}', '#end');
  return {
    contents: lines.join('\n'),
    path: `${packageName.replaceAll('.', '/')}/${targetName}.hx`,
  };
}

function emitEnumFilesHaxeExtern(
  declaration: Readonly<IrEnumDeclaration>,
  context: HaxeExternEmissionContext,
): EmittedFile[] {
  const kinds = new Set(declaration.members.map((member) => typeof member.value));
  if (kinds.size > 1) {
    emissionErrorHaxeExtern(context, `enum ${declaration.binding.name} mixes string and numeric values`);
  }
  if (declaration.members.some((member) => typeof member.value === 'number' && !Number.isFinite(member.value))) {
    emissionErrorHaxeExtern(context, `enum ${declaration.binding.name} has a non-finite numeric value`);
  }
  const underlying = kinds.has('string')
    ? 'String'
    : declaration.members.some((member) => !Number.isInteger(member.value))
      ? 'Float'
      : 'Int';
  return getDeclarationExportNamesHaxeExtern(declaration, context, 'type').map((exportName) => {
    const targetName = safeHaxeExternTypeName(exportName);
    const packageName = `${context.rootPackage}._js`;
    const namespaceFunctions = getIrEnumNamespaceFunctionsHaxeExtern(declaration, context);
    const lines = [
      createCompilerGeneratedFileHeader(context.module, '//', context.options.upstreamCommit),
      '#if js',
      `package ${packageName};`,
      '',
      `@:jsImport(${JSON.stringify(`${context.module.packageName}/contract`)}, ${JSON.stringify(exportName)})`,
      `enum abstract ${targetName}(${underlying}) from ${underlying} to ${underlying} {`,
      ...declaration.members.map(
        (member) =>
          `  var ${safeHaxeExternName(member.name)} = ${typeof member.value === 'string' ? JSON.stringify(member.value) : String(member.value)};`,
      ),
      ...namespaceFunctions.flatMap((declaration) => [
        '',
        `  public static extern ${emitFunctionSignatureHaxeExtern(safeHaxeExternName(declaration.binding.name), declaration, context)}`,
      ]),
      '}',
      '#end',
    ];
    return {
      contents: lines.join('\n'),
      path: `${packageName.replaceAll('.', '/')}/${targetName}.hx`,
    };
  });
}

function getIrEnumNamespaceFunctionsHaxeExtern(
  declaration: Readonly<IrEnumDeclaration>,
  context: HaxeExternEmissionContext,
): readonly Readonly<IrFunctionDeclaration>[] {
  return context.module.declarations.filter(
    (candidate): candidate is IrFunctionDeclaration =>
      candidate.kind === 'function' &&
      candidate.namespaceMember?.kind === 'binding' &&
      candidate.namespaceMember.binding.id === declaration.binding.id &&
      candidate.namespaceMember.path.length === 1,
  );
}

function emitInterfaceFilesHaxeExtern(
  declaration: Readonly<IrInterfaceDeclaration>,
  context: HaxeExternEmissionContext,
): EmittedFile[] {
  return getDeclarationExportNamesHaxeExtern(declaration, context, 'type').map((exportName) => {
    const targetName = safeHaxeExternTypeName(exportName);
    const packageName = `${context.rootPackage}._js`;
    const ambientTarget = context.ambientUtilityHeritageTargets.get(declaration.binding.id);
    const lines = [
      createCompilerGeneratedFileHeader(context.module, '//', context.options.upstreamCommit),
      `package ${packageName};`,
      '',
      ...(ambientTarget
        ? [
            `typedef ${targetName}${emitTypeParametersHaxeExtern(declaration.typeParameters, context)} = ${ambientTarget};`,
          ]
        : [
            `typedef ${targetName}${emitTypeParametersHaxeExtern(declaration.typeParameters, context)} = {`,
            ...declaration.properties.map((property) => `  ${emitInterfacePropertyHaxeExtern(property, context)}`),
            '};',
          ]),
    ];
    return {
      contents: lines.join('\n'),
      path: `${packageName.replaceAll('.', '/')}/${targetName}.hx`,
    };
  });
}

function createAmbientUtilityHeritageTargetsHaxeExtern(module: Readonly<IrModule>): ReadonlyMap<string, string> {
  return new Map(
    module.declarations.flatMap((declaration) => {
      if (declaration.kind !== 'interface') return [];
      const target = getCompilerAmbientUtilityHeritageTargetHaxe(declaration, module);
      return target ? [[declaration.binding.id, target] as const] : [];
    }),
  );
}

function emitInterfacePropertyHaxeExtern(
  property: Readonly<IrObjectTypeProperty>,
  context: HaxeExternEmissionContext,
): string {
  const optional = property.optional ? '@:optional ' : '';
  const name = safeHaxeExternName(property.name);
  const native = name === property.name ? '' : `@:native(${JSON.stringify(property.name)}) `;
  if (property.type.kind !== 'function') {
    return `${optional}${native}var ${name}:${emitStructureFieldTypeHaxeExtern(property.type, context)};`;
  }
  const parameters = property.type.parameters
    .map((parameter, index) => {
      const name = safeHaxeExternName(parameter.name ?? `argument${String(index)}`);
      const type = parameter.rest && parameter.type.kind === 'array' ? parameter.type.element : parameter.type;
      return `${parameter.rest ? '...' : parameter.optional ? '?' : ''}${name}:${emitTypeHaxeExtern(type, context)}`;
    })
    .join(', ');
  return `${optional}${native}function ${name}(${parameters}):${emitTypeHaxeExtern(property.type.returns, context)};`;
}

function emitPackageHolderHaxeExtern(packageName: string, context: HaxeExternEmissionContext): EmittedFile | undefined {
  const values = collectPackageValuesHaxeExtern(packageName, context);
  if (values.length === 0) return undefined;
  assertPackageValueNamesHaxeExtern(values, context);
  const holderName = getPackageHolderNameHaxeExtern(packageName, context.options);
  const targetPackage = `${context.rootPackage}._js._fn`;
  const lines = [
    createCompilerGeneratedFileHeader(context.module, '//', context.options.upstreamCommit),
    '#if js',
    `package ${targetPackage};`,
    '',
    `@:jsImport(${JSON.stringify(`${packageName}/contract`)})`,
    `extern class ${holderName} {`,
  ];
  for (const value of values) {
    const valueContext = replaceHaxeExternEmissionModule(context, value.module);
    const targetName = safeHaxeExternName(value.exportName);
    if (targetName !== value.exportName) lines.push(`  @:native(${JSON.stringify(value.exportName)})`);
    if (value.declaration.kind === 'function') {
      lines.push(`  static ${emitFunctionSignatureHaxeExtern(targetName, value.declaration, valueContext)}`);
    } else {
      if (!('binding' in value.declaration)) {
        emissionErrorHaxeExtern(
          valueContext,
          'exported binding patterns require declaration splitting before extern emission',
        );
      }
      const type = value.declaration.type ? emitTypeHaxeExtern(value.declaration.type, valueContext) : 'Dynamic';
      lines.push(`  static var ${targetName}:${type};`);
    }
  }
  lines.push('}', '#end');
  return {
    contents: lines.join('\n'),
    path: `${targetPackage.replaceAll('.', '/')}/${holderName}.hx`,
  };
}

function collectPackageValuesHaxeExtern(
  packageName: string,
  context: HaxeExternEmissionContext,
): HaxeExternExportedValue[] {
  const slots = context.packageFacade ? getPackageFacadeSlotsHaxeExtern(context) : undefined;
  const values = slots
    ? slots.flatMap((slot) => {
        if (slot.lane !== 'value' || slot.route.kind !== 'binding') return [];
        const location = getFacadeDeclarationLocationHaxeExtern(slot.route, context);
        if (!location || (location.declaration.kind !== 'function' && location.declaration.kind !== 'variable')) {
          return [];
        }
        return [{ declaration: location.declaration, exportName: slot.exportName, module: location.module }];
      })
    : (context.index.modulesByPackage.get(packageName) ?? []).flatMap((module) =>
        module.declarations.flatMap((declaration) => {
          if (declaration.kind !== 'function' && declaration.kind !== 'variable') return [];
          return getLocalExportNamesHaxeExtern(declaration, module, context.index).map((exportName) => ({
            declaration,
            exportName,
            module,
          }));
        }),
      );
  return values.sort(
    (left, right) =>
      compareTextCodeUnits(left.exportName, right.exportName) ||
      compareTextCodeUnits(left.module.source, right.module.source) ||
      compareTextCodeUnits(
        getDeclarationIdentityHaxeExtern(left.declaration),
        getDeclarationIdentityHaxeExtern(right.declaration),
      ),
  );
}

function getDeclarationExportNamesHaxeExtern(
  declaration: Readonly<IrDeclaration>,
  context: HaxeExternEmissionContext,
  lane: 'type' | 'value',
): readonly string[] {
  if (!context.packageFacade || !('binding' in declaration)) {
    return getLocalExportNamesHaxeExtern(declaration, context.module, context.index);
  }
  return getPackageFacadeSlotsHaxeExtern(context)
    .filter(
      (slot) =>
        slot.lane === lane &&
        slot.route.kind === 'binding' &&
        slot.route.binding.id === declaration.binding.id &&
        isSameModuleHaxeExtern(slot.route.module, context.module, context.index),
    )
    .map((slot) => slot.exportName)
    .sort(compareTextCodeUnits);
}

function getPackageFacadeSlotsHaxeExtern(context: HaxeExternEmissionContext) {
  return context.packageFacade?.modules[0]?.slots ?? [];
}

function getFacadeDeclarationLocationHaxeExtern(
  route: Extract<CompilerModuleFacadePlan['modules'][number]['slots'][number]['route'], { kind: 'binding' }>,
  context: HaxeExternEmissionContext,
): { declaration: Readonly<IrDeclaration>; module: Readonly<IrModule> } | undefined {
  return context.index.declarationLocations
    .get(route.binding.id)
    ?.find((location) => isSameModuleHaxeExtern(location.module, route.module, context.index));
}

function assertPackageValueNamesHaxeExtern(
  values: readonly Readonly<HaxeExternExportedValue>[],
  context: HaxeExternEmissionContext,
): void {
  const occupied = new Map<string, string>();
  for (const value of values) {
    const targetName = safeHaxeExternName(value.exportName);
    const prior = occupied.get(targetName);
    if (prior !== undefined) {
      emissionErrorHaxeExtern(
        context,
        `package exports ${prior} and ${value.exportName} share Haxe holder member ${targetName}`,
      );
    }
    occupied.set(targetName, value.exportName);
  }
}

function emitFunctionSignatureHaxeExtern(
  name: string,
  signature: Readonly<IrFunctionSignature>,
  context: HaxeExternEmissionContext,
): string {
  const typeParameters = emitTypeParametersHaxeExtern(signature.typeParameters, context, false);
  const parameters = emitParametersHaxeExtern(signature.parameters, context);
  const returns = emitTypeHaxeExtern(signature.returns, context);
  return `function ${name}${typeParameters}(${parameters}):${returns};`;
}

function emitParametersHaxeExtern(
  parameters: readonly Readonly<IrParameter>[],
  context: HaxeExternEmissionContext,
): string {
  const occupied = new Set<string>();
  return parameters
    .map((parameter) => {
      const name = safeHaxeExternName(parameter.binding.name);
      if (occupied.has(name)) {
        emissionErrorHaxeExtern(context, `function parameters share Haxe name ${name}`);
      }
      occupied.add(name);
      const type = parameter.rest && parameter.type.kind === 'array' ? parameter.type.element : parameter.type;
      const prefix = parameter.rest ? '...' : parameter.optional || parameter.initializer ? '?' : '';
      return `${prefix}${name}:${emitTypeHaxeExtern(type, context)}`;
    })
    .join(', ');
}

function emitTypeParametersHaxeExtern(
  parameters: readonly Readonly<IrTypeParameter>[],
  context: HaxeExternEmissionContext,
  includeDefaults = true,
): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map((parameter) => {
      const constraint =
        parameter.constraint &&
        parameter.constraint.kind !== 'function' &&
        !isEntityConstraintHaxeExtern(parameter.constraint, context)
          ? `:${emitTypeHaxeExtern(parameter.constraint, context)}`
          : '';
      const default_ =
        includeDefaults && parameter.default ? ` = ${emitTypeHaxeExtern(parameter.default, context)}` : '';
      return `${safeHaxeExternTypeName(parameter.binding.name)}${constraint}${default_}`;
    })
    .join(', ')}>`;
}

function isEntityConstraintHaxeExtern(type: Readonly<IrType>, context: HaxeExternEmissionContext): boolean {
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.path.length > 0) return false;
  if (type.reference.binding.name === 'Entity') return true;
  if (type.reference.binding.kind !== 'import') return false;
  return (context.index.importRoutes.get(type.reference.binding.id) ?? []).some((route) => route.imported === 'Entity');
}

function emitStructureFieldTypeHaxeExtern(type: Readonly<IrType>, context: HaxeExternEmissionContext): string {
  return type.kind === 'primitive' && type.name === 'void' ? 'Dynamic' : emitTypeHaxeExtern(type, context);
}

function emitTypeHaxeExtern(
  type: Readonly<IrType>,
  context: HaxeExternEmissionContext,
  activeAliases: ReadonlySet<string> = new Set(),
): string {
  return emitIrTypeHaxe(type, {
    fail: (message) => emissionErrorHaxeExtern(context, message),
    getBindingName: (binding) => getTypeBindingTargetHaxeExtern(binding, context),
    getExternalTypeName: (name) =>
      getCompilerRuntimeExternalSymbolTargetHaxe(name, 'type', context.options.runtimeModule),
    getMemberName: safeHaxeExternName,
    getTypeName: safeHaxeExternTypeName,
    resolveNamedType: (reference) =>
      emitTypeAliasReferenceHaxeExtern(reference, context, activeAliases) ??
      emitPrivateClassReferenceHaxeExtern(reference, context),
  });
}

function emitTypeAliasReferenceHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
  activeAliases: ReadonlySet<string>,
): string | undefined {
  const location = getTypeAliasLocationHaxeExtern(reference, context);
  if (!location) return emitPrivateInterfaceReferenceHaxeExtern(reference, context, activeAliases);
  if (reference.reference.kind !== 'binding' || reference.reference.path.length > 0) {
    emissionErrorHaxeExtern(context, 'qualified type alias references cannot be inlined into Haxe externs');
  }
  const identity = [
    location.module.packageName,
    normalizePathPortable(location.module.source),
    location.declaration.binding.id,
  ].join('\0');
  if (activeAliases.has(identity)) {
    emissionErrorHaxeExtern(context, `type alias ${location.declaration.binding.name} is cyclic`);
  }
  if (isTypeAliasPublicHaxeExtern(location, context)) {
    createTypeAliasSubstitutionPlanHaxeExtern(location, reference, context);
    return undefined;
  }
  const plan = createTypeAliasSubstitutionPlanHaxeExtern(location, reference, context);
  const substituted: IrType = resolveIrTypeStructuralSubstitution(location.declaration.type, plan);
  return emitTypeHaxeExtern(
    substituted,
    replaceHaxeExternEmissionModule(context, location.module),
    new Set(activeAliases).add(identity),
  );
}

function emitTypeAliasFilesHaxeExtern(
  declaration: Readonly<IrTypeAliasDeclaration>,
  context: HaxeExternEmissionContext,
): EmittedFile[] {
  return getDeclarationExportNamesHaxeExtern(declaration, context, 'type').map((exportName) => {
    const targetName = safeHaxeExternTypeName(exportName);
    const packageName = `${context.rootPackage}._js`;
    const identity = [
      context.module.packageName,
      normalizePathPortable(context.module.source),
      declaration.binding.id,
    ].join('\0');
    const lines = [
      createCompilerGeneratedFileHeader(context.module, '//', context.options.upstreamCommit),
      `package ${packageName};`,
      '',
      `typedef ${targetName}${emitTypeParametersHaxeExtern(declaration.typeParameters, context)} = ${emitTypeHaxeExtern(
        declaration.type,
        context,
        new Set([identity]),
      )};`,
    ];
    return {
      contents: lines.join('\n'),
      path: `${packageName.replaceAll('.', '/')}/${targetName}.hx`,
    };
  });
}

function emitPrivateInterfaceReferenceHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
  activeDeclarations: ReadonlySet<string>,
): string | undefined {
  const location = getInterfaceLocationHaxeExtern(reference, context);
  if (!location || isInterfacePublicHaxeExtern(location, context)) return undefined;
  if (reference.reference.kind !== 'binding' || reference.reference.path.length > 0) {
    emissionErrorHaxeExtern(context, 'qualified private interface references cannot be inlined into Haxe externs');
  }
  const identity = [
    location.module.packageName,
    normalizePathPortable(location.module.source),
    location.declaration.binding.id,
  ].join('\0');
  if (activeDeclarations.has(identity)) {
    emissionErrorHaxeExtern(context, `private interface ${location.declaration.binding.name} is cyclic`);
  }
  const loweredModule = lowerIrModuleWithCompilerPasses(location.module, [context.interfaceInheritancePass]);
  const declaration = loweredModule.declarations.find(
    (candidate): candidate is IrInterfaceDeclaration =>
      candidate.kind === 'interface' && candidate.binding.id === location.declaration.binding.id,
  );
  if (!declaration) {
    emissionErrorHaxeExtern(
      context,
      `private interface ${location.declaration.binding.name} disappeared during lowering`,
    );
  }
  let plan: CompilerStructuralTypeSubstitutionPlan;
  try {
    plan = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, reference.typeArguments);
  } catch (error) {
    emissionErrorHaxeExtern(
      context,
      `private interface ${declaration.binding.name} cannot be inlined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return emitTypeHaxeExtern(
    {
      kind: 'object',
      properties: declaration.properties.map((property) => ({
        ...property,
        type: resolveIrTypeStructuralSubstitution(property.type, plan),
      })),
    },
    replaceHaxeExternEmissionModule(context, loweredModule),
    new Set(activeDeclarations).add(identity),
  );
}

function emitPrivateClassReferenceHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): string | undefined {
  const location = getClassLocationHaxeExtern(reference, context);
  if (!location || isClassPublicHaxeExtern(location, context)) return undefined;
  if (!location.declaration.exported) {
    emissionErrorHaxeExtern(
      context,
      `private source class ${location.declaration.binding.name} has no public Haxe extern`,
    );
  }
  const targetName = safeHaxeExternTypeName(location.declaration.binding.name);
  const packageName = `${getRootPackageHaxeExtern(location.module.packageName, context.options)}._js`;
  const path = `${packageName.replaceAll('.', '/')}/${targetName}.hx`;
  const identity = [
    location.module.packageName,
    normalizePathPortable(location.module.source),
    location.declaration.binding.id,
  ].join('\0');
  if (!context.index.dependencyClassFiles.has(path) && !context.index.activeDependencyClasses.has(identity)) {
    context.index.activeDependencyClasses.add(identity);
    const loweredModule = lowerIrModuleWithCompilerPasses(location.module, [context.interfaceInheritancePass]);
    const declaration = loweredModule.declarations.find(
      (candidate): candidate is IrClassDeclaration =>
        candidate.kind === 'class' && candidate.binding.id === location.declaration.binding.id,
    );
    if (!declaration) {
      emissionErrorHaxeExtern(
        context,
        `dependency class ${location.declaration.binding.name} disappeared during lowering`,
      );
    }
    const dependencyContext = {
      ...context,
      ambientUtilityHeritageTargets: createAmbientUtilityHeritageTargetsHaxeExtern(loweredModule),
      module: loweredModule,
      rootPackage: getRootPackageHaxeExtern(loweredModule.packageName, context.options),
    };
    assertClassShapeHaxeExtern(declaration, dependencyContext);
    context.index.dependencyClassFiles.set(path, emitClassFileHaxeExtern(declaration, targetName, dependencyContext));
    context.index.activeDependencyClasses.delete(identity);
  }
  return `${packageName}.${targetName}`;
}

function getClassLocationHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): HaxeExternDeclarationLocation | undefined {
  if (reference.reference.kind !== 'binding' || reference.reference.path.length > 0) return undefined;
  const binding = reference.reference.binding;
  if (binding.kind === 'class') {
    return context.index.declarationLocations
      .get(binding.id)
      ?.find((location) => location.declaration.kind === 'class');
  }
  if (binding.kind !== 'import') return undefined;
  const locations = (context.index.importRoutes.get(binding.id) ?? []).flatMap((route) =>
    getSpecifierModulesHaxeExtern(route.from, route.specifier, context).flatMap((module) =>
      module.declarations.flatMap((declaration) =>
        declaration.kind === 'class' &&
        getLocalExportNamesHaxeExtern(declaration, module, context.index).includes(route.imported)
          ? [{ declaration, module }]
          : [],
      ),
    ),
  );
  const unique = [
    ...new Map(
      locations.map((location) => [
        `${location.module.packageName}\0${normalizePathPortable(location.module.source)}\0${location.declaration.binding.id}`,
        location,
      ]),
    ).values(),
  ];
  if (unique.length > 1) {
    emissionErrorHaxeExtern(context, `imported class ${binding.name} resolves ambiguously`);
  }
  return unique[0];
}

function isClassPublicHaxeExtern(
  location: Readonly<HaxeExternDeclarationLocation>,
  context: HaxeExternEmissionContext,
): boolean {
  if (location.declaration.kind !== 'class') return false;
  const facadePackageName = context.packageFacade?.modules[0]?.module.packageName;
  if (!context.packageFacade || location.module.packageName !== facadePackageName) {
    return getLocalExportNamesHaxeExtern(location.declaration, location.module, context.index).length > 0;
  }
  return getPackageFacadeSlotsHaxeExtern(context).some(
    (slot) =>
      slot.lane === 'type' &&
      slot.route.kind === 'binding' &&
      slot.route.binding.id === location.declaration.binding.id &&
      isSameModuleHaxeExtern(slot.route.module, location.module, context.index),
  );
}

function getInterfaceLocationHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): HaxeExternInterfaceLocation | undefined {
  if (reference.reference.kind !== 'binding' || reference.reference.binding.kind === 'import') return undefined;
  const binding = reference.reference.binding;
  return context.index.declarationLocations
    .get(binding.id)
    ?.find((location): location is HaxeExternInterfaceLocation => location.declaration.kind === 'interface');
}

function isInterfacePublicHaxeExtern(
  location: Readonly<HaxeExternInterfaceLocation>,
  context: HaxeExternEmissionContext,
): boolean {
  const facadePackageName = context.packageFacade?.modules[0]?.module.packageName;
  if (!context.packageFacade || location.module.packageName !== facadePackageName) {
    return getLocalExportNamesHaxeExtern(location.declaration, location.module, context.index).length > 0;
  }
  return getPackageFacadeSlotsHaxeExtern(context).some(
    (slot) =>
      slot.lane === 'type' &&
      slot.route.kind === 'binding' &&
      slot.route.binding.id === location.declaration.binding.id &&
      isSameModuleHaxeExtern(slot.route.module, location.module, context.index),
  );
}

function isTypeAliasPublicHaxeExtern(
  location: Readonly<HaxeExternTypeAliasLocation>,
  context: HaxeExternEmissionContext,
): boolean {
  const facadePackageName = context.packageFacade?.modules[0]?.module.packageName;
  if (!context.packageFacade || location.module.packageName !== facadePackageName) {
    return getLocalExportNamesHaxeExtern(location.declaration, location.module, context.index).length > 0;
  }
  return getPackageFacadeSlotsHaxeExtern(context).some(
    (slot) =>
      slot.lane === 'type' &&
      slot.route.kind === 'binding' &&
      slot.route.binding.id === location.declaration.binding.id &&
      isSameModuleHaxeExtern(slot.route.module, location.module, context.index),
  );
}

function createTypeAliasSubstitutionPlanHaxeExtern(
  location: Readonly<HaxeExternTypeAliasLocation>,
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): CompilerStructuralTypeSubstitutionPlan {
  try {
    return createIrTypeParameterSubstitutionPlan(location.declaration.typeParameters, reference.typeArguments);
  } catch (error) {
    emissionErrorHaxeExtern(
      context,
      `type alias ${location.declaration.binding.name} cannot be inlined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getTypeAliasLocationHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): HaxeExternTypeAliasLocation | undefined {
  if (reference.reference.kind !== 'binding') return undefined;
  const nameReference = reference.reference;
  const binding = nameReference.binding;
  const cacheKey = `${binding.id}\0${nameReference.path.join('\0')}`;
  const cached = context.index.typeAliasLocations.get(cacheKey);
  if (cached) return assertUniqueTypeAliasLocationHaxeExtern(binding.name, cached, context);
  if (binding.kind === 'typeAlias') {
    const locations =
      context.index.declarationLocations
        .get(binding.id)
        ?.filter((location): location is HaxeExternTypeAliasLocation => location.declaration.kind === 'typeAlias') ??
      [];
    context.index.typeAliasLocations.set(cacheKey, locations);
    return assertUniqueTypeAliasLocationHaxeExtern(binding.name, locations, context);
  }
  if (binding.kind !== 'import') return undefined;
  const imported = (context.index.importRoutes.get(binding.id) ?? []).flatMap((route) => {
    const exportName = route.imported === '*' ? nameReference.path[0] : route.imported;
    return exportName ? [{ exportName, from: route.from, specifier: route.specifier }] : [];
  });
  const locations = imported.flatMap(({ exportName, from, specifier }) =>
    getSpecifierModulesHaxeExtern(from, specifier, context).flatMap((module) =>
      getExportedTypeAliasesHaxeExtern(module, exportName, context, new Set()),
    ),
  );
  const unique = [
    ...new Map(
      locations.map((location) => [
        [
          location.module.packageName,
          normalizePathPortable(location.module.source),
          location.declaration.binding.id,
        ].join('\0'),
        location,
      ]),
    ).values(),
  ];
  context.index.typeAliasLocations.set(cacheKey, unique);
  return assertUniqueTypeAliasLocationHaxeExtern(binding.name, unique, context);
}

function assertUniqueTypeAliasLocationHaxeExtern(
  bindingName: string,
  locations: readonly HaxeExternTypeAliasLocation[],
  context: HaxeExternEmissionContext,
): HaxeExternTypeAliasLocation | undefined {
  if (locations.length > 1) {
    emissionErrorHaxeExtern(context, `imported type alias ${bindingName} resolves ambiguously`);
  }
  return locations[0];
}

function getExportedTypeAliasesHaxeExtern(
  module: Readonly<IrModule>,
  exportName: string,
  context: HaxeExternEmissionContext,
  seen: ReadonlySet<string>,
): HaxeExternTypeAliasLocation[] {
  const query = `${getModuleIdentityHaxeExtern(module, context.index)}\0${exportName}`;
  const cached = seen.size === 0 ? context.index.exportedTypeAliases.get(query) : undefined;
  if (cached) return [...cached];
  if (seen.has(query)) return [];
  const nextSeen = new Set(seen).add(query);
  const locations: HaxeExternTypeAliasLocation[] = module.declarations.flatMap((declaration) =>
    declaration.kind === 'typeAlias' && declaration.exported && declaration.binding.name === exportName
      ? [{ declaration, module }]
      : [],
  );
  for (const exported of module.exports) {
    if (exported.kind === 'local' && exported.exported === exportName) {
      const declaration = module.declarations.find(
        (candidate): candidate is IrTypeAliasDeclaration =>
          candidate.kind === 'typeAlias' && candidate.binding.id === exported.binding.id,
      );
      if (declaration) locations.push({ declaration, module });
    } else if (exported.kind === 'reexport' && exported.exported === exportName) {
      for (const target of getSpecifierModulesHaxeExtern(module, exported.specifier, context)) {
        locations.push(...getExportedTypeAliasesHaxeExtern(target, exported.imported, context, nextSeen));
      }
    } else if (exported.kind === 'all' && exportName !== 'default') {
      for (const target of getSpecifierModulesHaxeExtern(module, exported.specifier, context)) {
        locations.push(...getExportedTypeAliasesHaxeExtern(target, exportName, context, nextSeen));
      }
    }
  }
  if (seen.size === 0) context.index.exportedTypeAliases.set(query, locations);
  return locations;
}

function getTypeBindingTargetHaxeExtern(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: HaxeExternEmissionContext,
): string {
  if (binding.kind === 'typeParameter') return safeHaxeExternTypeName(binding.name);
  const declarationLocation = context.index.declarationLocations.get(binding.id)?.[0];
  const declaration = declarationLocation?.declaration;
  const localExport = declarationLocation
    ? context.packageFacade &&
      declarationLocation.module.packageName === context.packageFacade.modules[0]?.module.packageName
      ? getPackageFacadeSlotsHaxeExtern(context).find(
          (slot) =>
            slot.lane === 'type' &&
            slot.route.kind === 'binding' &&
            slot.route.binding.id === declarationLocation.declaration.binding.id &&
            isSameModuleHaxeExtern(slot.route.module, declarationLocation.module, context.index),
        )?.exportName
      : getLocalExportNamesHaxeExtern(declarationLocation.declaration, declarationLocation.module, context.index)[0]
    : undefined;
  const importedName = getImportedTypeNameHaxeExtern(binding, context.index);
  if (declaration && localExport === undefined && declaration.kind === 'interface') {
    emissionErrorHaxeExtern(context, `private interface ${declaration.binding.name} was not structurally inlined`);
  }
  if (declaration && localExport === undefined && declaration.kind === 'class') {
    emissionErrorHaxeExtern(context, `private source class ${declaration.binding.name} has no public Haxe extern`);
  }
  return `${context.rootPackage}.${safeHaxeExternTypeName(localExport ?? importedName ?? binding.name)}`;
}

function getImportedTypeNameHaxeExtern(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  index: Readonly<HaxeExternEmissionIndex>,
): string | undefined {
  if (binding.kind !== 'import') return undefined;
  return index.importRoutes.get(binding.id)?.find((route) => route.imported !== '*')?.imported;
}

function getLocalExportNamesHaxeExtern(
  declaration: Readonly<IrDeclaration>,
  module: Readonly<IrModule>,
  index: Readonly<HaxeExternEmissionIndex>,
): readonly string[] {
  if (!('binding' in declaration)) return declaration.exported ? ['default'] : [];
  const cacheKey = `${getModuleIdentityHaxeExtern(module, index)}\0${declaration.binding.id}`;
  const cached = index.localExportNames.get(cacheKey);
  if (cached) return cached;
  const names = module.exports.flatMap((exported) =>
    exported.kind === 'local' && exported.binding.id === declaration.binding.id ? [exported.exported] : [],
  );
  if (names.length === 0 && declaration.exported) names.push(declaration.binding.name);
  const result = [...new Set(names)].sort(compareTextCodeUnits);
  index.localExportNames.set(cacheKey, result);
  return result;
}

function getSpecifierModulesHaxeExtern(
  from: Readonly<IrModule>,
  specifier: string,
  context: HaxeExternEmissionContext,
): readonly Readonly<IrModule>[] {
  const cacheKey = `${getModuleIdentityHaxeExtern(from, context.index)}\0${specifier}`;
  const cached = context.index.specifierModules.get(cacheKey);
  if (cached) return cached;
  const candidates = getSpecifierSourceCandidatesHaxeExtern(from.source, specifier);
  const exact = context.index.resolutionExact.get(cacheKey) ?? [];
  const targets = exact.length > 0 ? exact : (context.index.resolutionFallback.get(specifier) ?? []);
  const resolved = new Map<string, Readonly<IrModule>>();
  for (const candidate of candidates) {
    for (const module of context.index.modulesByPackageSource.get(
      getPackageSourceIdentityHaxeExtern(from.packageName, candidate, context.index),
    ) ?? []) {
      resolved.set(getModuleIdentityHaxeExtern(module, context.index), module);
    }
  }
  for (const target of targets) {
    for (const module of context.index.modulesByPackageSource.get(target) ?? []) {
      resolved.set(getModuleIdentityHaxeExtern(module, context.index), module);
    }
  }
  const result = [...resolved]
    .sort(
      (left, right) =>
        (context.index.moduleOrdinals.get(left[0]) ?? 0) - (context.index.moduleOrdinals.get(right[0]) ?? 0),
    )
    .map(([, module]) => module);
  context.index.specifierModules.set(cacheKey, result);
  return result;
}

function getSpecifierSourceCandidatesHaxeExtern(source: string, specifier: string): ReadonlySet<string> {
  const normalized = normalizePathPortable(specifier);
  if (normalized !== '.' && normalized !== '..' && !normalized.startsWith('./') && !normalized.startsWith('../')) {
    return new Set();
  }
  const parts = normalizePathPortable(source).split('/');
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
  for (const [emitted, sourceExtension] of [
    ['.cjs', '.cts'],
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
  ] as const) {
    if (resolved.endsWith(emitted)) candidates.add(`${resolved.slice(0, -emitted.length)}${sourceExtension}`);
  }
  if (!/\.[^/]+$/u.test(resolved)) {
    candidates.add(`${resolved}.ts`);
    candidates.add(`${resolved}/index.ts`);
  }
  return candidates;
}

function getRootPackageHaxeExtern(packageName: string, options: Readonly<HaxeCompilerBackendOptions>): string {
  const converted = convertPackageNameToHaxePackageName(packageName, options.rootPackage);
  return converted.slice(0, converted.lastIndexOf('.'));
}

function getPackageHolderNameHaxeExtern(packageName: string, options: Readonly<HaxeCompilerBackendOptions>): string {
  const packageSegment = convertPackageNameToHaxePackageName(packageName, options.rootPackage).split('.').at(-1)!;
  return safeHaxeExternTypeName(packageSegment);
}

function isPackageHolderOwnerHaxeExtern(module: Readonly<IrModule>, index: Readonly<HaxeExternEmissionIndex>): boolean {
  const owner = index.packageOwners.get(module.packageName);
  return owner !== undefined && isSameModuleHaxeExtern(owner, module, index);
}

function replaceHaxeExternEmissionModule(
  context: HaxeExternEmissionContext,
  module: Readonly<IrModule>,
): HaxeExternEmissionContext {
  return { ...context, module };
}

function compareModulesHaxeExtern(left: Readonly<IrModule>, right: Readonly<IrModule>): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(normalizePathPortable(left.source), normalizePathPortable(right.source)) ||
    compareTextCodeUnits(left.name, right.name)
  );
}

function isSameModuleHaxeExtern(
  left: Readonly<Pick<IrModule, 'name' | 'packageName' | 'source'>>,
  right: Readonly<Pick<IrModule, 'name' | 'packageName' | 'source'>>,
  index: Readonly<HaxeExternEmissionIndex>,
): boolean {
  return getModuleIdentityHaxeExtern(left, index) === getModuleIdentityHaxeExtern(right, index);
}

function getModuleIdentityHaxeExtern(
  module: Readonly<Pick<IrModule, 'name' | 'packageName' | 'source'>>,
  index: Readonly<HaxeExternEmissionIndex>,
): string {
  return `${getPackageSourceIdentityHaxeExtern(module.packageName, module.source, index)}\0${module.name}`;
}

function getPackageSourceIdentityHaxeExtern(
  packageName: string,
  source: string,
  index: Readonly<HaxeExternEmissionIndex>,
): string {
  let normalized = index.normalizedPaths.get(source);
  if (normalized === undefined) {
    normalized = normalizePathPortable(source);
    index.normalizedPaths.set(source, normalized);
  }
  return `${packageName}\0${normalized}`;
}

function getDeclarationIdentityHaxeExtern(
  declaration: Readonly<IrFunctionDeclaration | IrVariableDeclaration>,
): string {
  return 'binding' in declaration ? declaration.binding.id : declaration.origin.fingerprint;
}

function emissionErrorHaxeExtern(context: HaxeExternEmissionContext, message: string): never {
  throw createBackendEmissionFailure('haxe', context.module, message);
}

function pascalCaseHaxeExtern(value: string): string {
  const match = /^(?<prefix>_*)(?<name>.*)$/u.exec(value);
  const prefix = match?.groups?.prefix ?? '';
  const name = match?.groups?.name ?? value;
  return `${prefix}${name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('')}`;
}

function safeHaxeExternName(name: string): string {
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const escaped = [...stripped]
    .map((character, index) =>
      (index === 0 ? /[A-Za-z_]/u : /[A-Za-z0-9_]/u).test(character)
        ? character
        : `_u${character.codePointAt(0)!.toString(16).padStart(4, '0')}_`,
    )
    .join('');
  const identifier = escaped || '_';
  return haxeExternKeywords.has(identifier) ? `${identifier}_` : identifier;
}

function safeHaxeExternTypeName(name: string): string {
  return safeHaxeExternName(pascalCaseHaxeExtern(name));
}

const haxeExternKeywords = new Set([
  'abstract',
  'break',
  'case',
  'cast',
  'catch',
  'class',
  'continue',
  'default',
  'do',
  'dynamic',
  'else',
  'enum',
  'extends',
  'extern',
  'false',
  'final',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'inline',
  'interface',
  'macro',
  'new',
  'null',
  'operator',
  'overload',
  'override',
  'package',
  'private',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'trace',
  'true',
  'try',
  'typedef',
  'untyped',
  'using',
  'var',
  'while',
]);
