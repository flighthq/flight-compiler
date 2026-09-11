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
  EmittedFile,
  HaxeCompilerBackendOptions,
  IrBindingIdentity,
  IrDeclaration,
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
} from '../../compiler-types/src/index.js';
import { convertPackageNameToHaxePackageName } from './haxeCompilerIdentity.js';
import {
  getCompilerAmbientUtilityHeritageTargetHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

interface HaxeExternEmissionContext {
  readonly ambientUtilityHeritageTargets: ReadonlyMap<string, string>;
  readonly module: Readonly<IrModule>;
  readonly moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined;
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
): readonly EmittedFile[] {
  const ambientUtilityHeritageTargets = createAmbientUtilityHeritageTargetsHaxeExtern(sourceModule);
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [
    createCompilerLoweringPassInterfaceInheritance(sourceModules, moduleResolution, {
      eraseAmbientUtilityHeritage: (_reference, declaration) =>
        ambientUtilityHeritageTargets.has(declaration.binding.id),
    }),
  ]);
  const modules = replaceIrModuleHaxeExtern(sourceModules, module);
  const context: HaxeExternEmissionContext = {
    ambientUtilityHeritageTargets,
    module,
    moduleResolution,
    modules,
    options,
    rootPackage: getRootPackageHaxeExtern(module.packageName, options),
  };
  assertModuleShapeHaxeExtern(context);
  const files = module.declarations.flatMap((declaration) =>
    declaration.kind === 'interface' ? emitInterfaceFilesHaxeExtern(declaration, context) : [],
  );
  if (isPackageHolderOwnerHaxeExtern(module, modules)) {
    const holder = emitPackageHolderHaxeExtern(module.packageName, context);
    if (holder) files.push(holder);
  }
  return files;
}

function assertModuleShapeHaxeExtern(context: HaxeExternEmissionContext): void {
  for (const exported of context.module.exports) {
    if (exported.kind === 'default') {
      emissionErrorHaxeExtern(context, 'default expression exports have no flight-hx extern representation');
    }
  }
  for (const declaration of context.module.declarations) {
    const exportNames = getLocalExportNamesHaxeExtern(declaration, context.module);
    if (exportNames.length === 0) continue;
    if (declaration.kind === 'class') {
      emissionErrorHaxeExtern(
        context,
        `source class ${declaration.binding.name} extern representation is not yet specified by flight-hx`,
      );
    }
    if (declaration.kind === 'enum') {
      emissionErrorHaxeExtern(
        context,
        `source enum ${declaration.binding.name} extern representation is not yet specified by flight-hx`,
      );
    }
    if (declaration.kind === 'variable' && !('binding' in declaration)) {
      emissionErrorHaxeExtern(
        context,
        'exported binding patterns require declaration splitting before extern emission',
      );
    }
  }
}

function emitInterfaceFilesHaxeExtern(
  declaration: Readonly<IrInterfaceDeclaration>,
  context: HaxeExternEmissionContext,
): EmittedFile[] {
  return getLocalExportNamesHaxeExtern(declaration, context.module).map((exportName) => {
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
      const target = getCompilerAmbientUtilityHeritageTargetHaxe(declaration);
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
  const values = collectPackageValuesHaxeExtern(packageName, context.modules);
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
  modules: readonly Readonly<IrModule>[],
): HaxeExternExportedValue[] {
  const values = modules
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
      const constraint = parameter.constraint ? `:${emitTypeHaxeExtern(parameter.constraint, context)}` : '';
      return `${safeHaxeExternTypeName(parameter.binding.name)}${constraint}`;
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
  if (!location) return undefined;
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
  if (declaration?.kind === 'class' || declaration?.kind === 'enum') {
    emissionErrorHaxeExtern(
      context,
      `source ${declaration.kind} ${declaration.binding.name} extern representation is not yet specified by flight-hx`,
    );
  }
  const localExport = declarationLocation
    ? getLocalExportNamesHaxeExtern(declarationLocation.declaration, declarationLocation.module)[0]
    : undefined;
  const importedName = getImportedTypeNameHaxeExtern(binding, context.modules);
  if (declaration && localExport === undefined && declaration.kind === 'interface') {
    emissionErrorHaxeExtern(
      context,
      `non-exported interface ${declaration.binding.name} cannot appear in a public flight-hx extern shape`,
    );
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
