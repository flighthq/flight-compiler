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
  canEraseCompilerAmbientUtilityHeritageHaxe,
  getCompilerAmbientUtilityHeritageTargetHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

interface HaxeExternEmissionContext {
  readonly ambientUtilityHeritageTargets: ReadonlyMap<string, string>;
  readonly interfaceInheritancePass: Readonly<CompilerLoweringPass>;
  readonly module: Readonly<IrModule>;
  readonly moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly packageFacade: Readonly<CompilerModuleFacadePlan> | undefined;
  readonly modules: readonly Readonly<IrModule>[];
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
        canEraseCompilerAmbientUtilityHeritageHaxe(reference),
    });
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [inheritancePass]);
  const modules = replaceIrModuleHaxeExtern(sourceModules, module);
  const contract = packageContract
    ? (modules.find((candidate) => isSameModuleHaxeExtern(candidate, packageContract)) ?? packageContract)
    : undefined;
  const context: HaxeExternEmissionContext = {
    ambientUtilityHeritageTargets,
    interfaceInheritancePass: inheritancePass,
    module,
    moduleResolution,
    modules,
    options,
    packageFacade: contract && getModuleFacade ? getModuleFacade(contract) : undefined,
    rootPackage: getRootPackageHaxeExtern(module.packageName, options),
  };
  assertModuleShapeHaxeExtern(context);
  const files = module.declarations.flatMap((declaration) => {
    if (declaration.kind === 'class') return emitClassFilesHaxeExtern(declaration, context);
    if (declaration.kind === 'interface') return emitInterfaceFilesHaxeExtern(declaration, context);
    if (declaration.kind === 'enum') return emitEnumFilesHaxeExtern(declaration, context);
    return [];
  });
  if (isPackageHolderOwnerHaxeExtern(module, modules)) {
    const holder = emitPackageHolderHaxeExtern(module.packageName, context);
    if (holder) files.push(holder);
  }
  return files;
}

function assertModuleShapeHaxeExtern(context: HaxeExternEmissionContext): void {
  if (context.packageFacade) {
    if (!isPackageHolderOwnerHaxeExtern(context.module, context.modules)) return;
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
    const exportNames = getLocalExportNamesHaxeExtern(declaration, context.module);
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
  return getDeclarationExportNamesHaxeExtern(declaration, context, 'type').map((exportName) => {
    const targetName = safeHaxeExternTypeName(exportName);
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
      `@:jsImport(${JSON.stringify(`${context.module.packageName}/contract`)}, ${JSON.stringify(exportName)})`,
      `extern class ${targetName}${emitTypeParametersHaxeExtern(declaration.typeParameters, context)}${heritage ? ` ${heritage}` : ''} {`,
    ];
    for (const field of declaration.fields.filter((candidate) => candidate.visibility === 'public')) {
      const name = safeHaxeExternName(field.name);
      if (name !== field.name) lines.push(`  @:native(${JSON.stringify(field.name)})`);
      const optional = field.optional ? '@:optional ' : '';
      const target = field.readonly ? `${name}(default, null)` : name;
      lines.push(
        `  ${optional}public ${field.static ? 'static ' : ''}var ${target}:${emitTypeHaxeExtern(field.type, context)};`,
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
        `  public ${accessor.static ? 'static ' : ''}var ${target}:${emitTypeHaxeExtern(accessor.type, context)};`,
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
  });
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
  if (property.type.kind !== 'function') {
    return `${optional}var ${safeHaxeExternName(property.name)}:${emitTypeHaxeExtern(property.type, context)};`;
  }
  const parameters = property.type.parameters
    .map((parameter, index) => {
      const name = safeHaxeExternName(parameter.name ?? `argument${String(index)}`);
      const type = parameter.rest && parameter.type.kind === 'array' ? parameter.type.element : parameter.type;
      return `${parameter.rest ? '...' : parameter.optional ? '?' : ''}${name}:${emitTypeHaxeExtern(type, context)}`;
    })
    .join(', ');
  return `${optional}function ${safeHaxeExternName(property.name)}(${parameters}):${emitTypeHaxeExtern(
    property.type.returns,
    context,
  )};`;
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
    : context.modules
        .filter((module) => module.packageName === packageName)
        .flatMap((module) =>
          module.declarations.flatMap((declaration) => {
            if (declaration.kind !== 'function' && declaration.kind !== 'variable') return [];
            return getLocalExportNamesHaxeExtern(declaration, module).map((exportName) => ({
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
    return getLocalExportNamesHaxeExtern(declaration, context.module);
  }
  return getPackageFacadeSlotsHaxeExtern(context)
    .filter(
      (slot) =>
        slot.lane === lane &&
        slot.route.kind === 'binding' &&
        slot.route.binding.id === declaration.binding.id &&
        isSameModuleHaxeExtern(slot.route.module, context.module),
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
  const module = context.modules.find((candidate) => isSameModuleHaxeExtern(candidate, route.module));
  const declaration = module?.declarations.find(
    (candidate) => 'binding' in candidate && candidate.binding.id === route.binding.id,
  );
  return module && declaration ? { declaration, module } : undefined;
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
  const typeParameters = emitTypeParametersHaxeExtern(signature.typeParameters, context);
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
): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map((parameter) => {
      const constraint =
        parameter.constraint && parameter.constraint.kind !== 'function'
          ? `:${emitTypeHaxeExtern(parameter.constraint, context)}`
          : '';
      const default_ = parameter.default ? ` = ${emitTypeHaxeExtern(parameter.default, context)}` : '';
      return `${safeHaxeExternTypeName(parameter.binding.name)}${constraint}${default_}`;
    })
    .join(', ')}>`;
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
    resolveNamedType: (reference) => emitTypeAliasReferenceHaxeExtern(reference, context, activeAliases),
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
  let substituted: IrType;
  try {
    const plan = createIrTypeParameterSubstitutionPlan(location.declaration.typeParameters, reference.typeArguments);
    substituted = resolveIrTypeStructuralSubstitution(location.declaration.type, plan);
  } catch (error) {
    emissionErrorHaxeExtern(
      context,
      `type alias ${location.declaration.binding.name} cannot be inlined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return emitTypeHaxeExtern(
    substituted,
    replaceHaxeExternEmissionModule(context, location.module),
    new Set(activeAliases).add(identity),
  );
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

function getInterfaceLocationHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): HaxeExternInterfaceLocation | undefined {
  if (reference.reference.kind !== 'binding' || reference.reference.binding.kind === 'import') return undefined;
  const binding = reference.reference.binding;
  return context.modules
    .flatMap((module) =>
      module.declarations.flatMap((declaration) =>
        declaration.kind === 'interface' && declaration.binding.id === binding.id ? [{ declaration, module }] : [],
      ),
    )
    .at(0);
}

function isInterfacePublicHaxeExtern(
  location: Readonly<HaxeExternInterfaceLocation>,
  context: HaxeExternEmissionContext,
): boolean {
  const facadePackageName = context.packageFacade?.modules[0]?.module.packageName;
  if (!context.packageFacade || location.module.packageName !== facadePackageName) {
    return getLocalExportNamesHaxeExtern(location.declaration, location.module).length > 0;
  }
  return getPackageFacadeSlotsHaxeExtern(context).some(
    (slot) =>
      slot.lane === 'type' &&
      slot.route.kind === 'binding' &&
      slot.route.binding.id === location.declaration.binding.id &&
      isSameModuleHaxeExtern(slot.route.module, location.module),
  );
}

function getTypeAliasLocationHaxeExtern(
  reference: Readonly<IrTypeReference>,
  context: HaxeExternEmissionContext,
): HaxeExternTypeAliasLocation | undefined {
  if (reference.reference.kind !== 'binding') return undefined;
  const binding = reference.reference.binding;
  if (binding.kind === 'typeAlias') {
    return context.modules
      .flatMap((module) =>
        module.declarations.flatMap((declaration) =>
          declaration.kind === 'typeAlias' && declaration.binding.id === binding.id ? [{ declaration, module }] : [],
        ),
      )
      .at(0);
  }
  if (binding.kind !== 'import') return undefined;
  const imported = context.modules.flatMap((module) =>
    module.imports.flatMap((entry) =>
      entry.bindings.flatMap((candidate) => {
        if (candidate.binding.id !== binding.id) return [];
        if (
          candidate.imported === '*' &&
          reference.reference.kind === 'binding' &&
          reference.reference.path.length > 0
        ) {
          return [{ exportName: reference.reference.path[0]!, from: module, specifier: entry.specifier }];
        }
        return candidate.imported === '*'
          ? []
          : [{ exportName: candidate.imported, from: module, specifier: entry.specifier }];
      }),
    ),
  );
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
  if (unique.length > 1) {
    emissionErrorHaxeExtern(context, `imported type alias ${binding.name} resolves ambiguously`);
  }
  return unique[0];
}

function getExportedTypeAliasesHaxeExtern(
  module: Readonly<IrModule>,
  exportName: string,
  context: HaxeExternEmissionContext,
  seen: ReadonlySet<string>,
): HaxeExternTypeAliasLocation[] {
  const query = `${module.packageName}\0${normalizePathPortable(module.source)}\0${exportName}`;
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
  return locations;
}

function getTypeBindingTargetHaxeExtern(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: HaxeExternEmissionContext,
): string {
  if (binding.kind === 'typeParameter') return safeHaxeExternTypeName(binding.name);
  const declarationLocation = context.modules
    .flatMap((module) =>
      module.declarations.flatMap((declaration) =>
        'binding' in declaration && declaration.binding.id === binding.id ? [{ declaration, module }] : [],
      ),
    )
    .at(0);
  const declaration = declarationLocation?.declaration;
  const localExport = declarationLocation
    ? context.packageFacade &&
      declarationLocation.module.packageName === context.packageFacade.modules[0]?.module.packageName
      ? getPackageFacadeSlotsHaxeExtern(context).find(
          (slot) =>
            slot.lane === 'type' &&
            slot.route.kind === 'binding' &&
            slot.route.binding.id === declarationLocation.declaration.binding.id &&
            isSameModuleHaxeExtern(slot.route.module, declarationLocation.module),
        )?.exportName
      : getLocalExportNamesHaxeExtern(declarationLocation.declaration, declarationLocation.module)[0]
    : undefined;
  const importedName = getImportedTypeNameHaxeExtern(binding, context.modules);
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
  modules: readonly Readonly<IrModule>[],
): string | undefined {
  if (binding.kind !== 'import') return undefined;
  for (const module of modules) {
    for (const imported of module.imports) {
      for (const candidate of imported.bindings) {
        if (candidate.binding.id !== binding.id || candidate.imported === '*') continue;
        return candidate.imported;
      }
    }
  }
  return undefined;
}

function getLocalExportNamesHaxeExtern(
  declaration: Readonly<IrDeclaration>,
  module: Readonly<IrModule>,
): readonly string[] {
  if (!('binding' in declaration)) return declaration.exported ? ['default'] : [];
  const names = module.exports.flatMap((exported) =>
    exported.kind === 'local' && exported.binding.id === declaration.binding.id ? [exported.exported] : [],
  );
  if (names.length === 0 && declaration.exported) names.push(declaration.binding.name);
  return [...new Set(names)].sort(compareTextCodeUnits);
}

function getSpecifierModulesHaxeExtern(
  from: Readonly<IrModule>,
  specifier: string,
  context: HaxeExternEmissionContext,
): readonly Readonly<IrModule>[] {
  const candidates = getSpecifierSourceCandidatesHaxeExtern(from.source, specifier);
  const matching = context.moduleResolution?.edges.filter((edge) => edge.specifier === specifier) ?? [];
  const exact = matching.filter((edge) => edge.importer && isSameModuleHaxeExtern(edge.importer, from));
  const targets = (exact.length > 0 ? exact : matching.filter((edge) => !edge.importer)).map(
    (edge) => `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`,
  );
  return context.modules.filter(
    (module) =>
      (module.packageName === from.packageName && candidates.has(normalizePathPortable(module.source))) ||
      targets.includes(`${module.packageName}\0${normalizePathPortable(module.source)}`),
  );
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

function isPackageHolderOwnerHaxeExtern(module: Readonly<IrModule>, modules: readonly Readonly<IrModule>[]): boolean {
  const owner = modules
    .filter((candidate) => candidate.packageName === module.packageName)
    .sort(compareModulesHaxeExtern)[0];
  return owner !== undefined && isSameModuleHaxeExtern(owner, module);
}

function replaceIrModuleHaxeExtern(
  modules: readonly Readonly<IrModule>[],
  replacement: Readonly<IrModule>,
): readonly Readonly<IrModule>[] {
  return [...modules.filter((module) => !isSameModuleHaxeExtern(module, replacement)), replacement].sort(
    compareModulesHaxeExtern,
  );
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
): boolean {
  return (
    left.packageName === right.packageName &&
    normalizePathPortable(left.source) === normalizePathPortable(right.source) &&
    left.name === right.name
  );
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
  return haxeExternKeywords.has(stripped) ? `${stripped}_` : stripped;
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
