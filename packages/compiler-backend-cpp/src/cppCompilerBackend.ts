import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  collectIrModuleNullableBindingIds,
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  getIrUnionTypeStringLiteralValues,
  hasIrTypeAbsentMember,
  indentSourceLines,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
} from '../../compiler-ir-traversal/src/index.js';
import {
  createCompilerLoweringPassAwaitConditionHoisting,
  createCompilerLoweringPassBindingPattern,
  createCompilerLoweringPassCStyleFor,
  createCompilerLoweringPassCatchAwaitHoisting,
  createCompilerLoweringPassExtraArgumentErasure,
  createCompilerLoweringPassInterfaceInheritance,
  createCompilerLoweringPassSwitchFallthrough,
  createCompilerLoweringPassSwitchSuspension,
  createCompilerLoweringPassVariableHoisting,
  lowerIrModuleWithCompilerPasses,
} from '../../compiler-lowering/src/index.js';
import {
  analyzeCompilerRuntimeExternalSymbolCompleteness,
  collectIrModulesRuntimeExternalSymbolIdentities,
} from '../../compiler-runtime-contract/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerBackend,
  CompilerCppReferenceRepresentationPlanner,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CppCompilerBackendOptions,
  CppCompilerRuntimeProfile,
  EmittedFile,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrBindingPattern,
  IrCatchClause,
  IrClassDeclaration,
  IrControlFlowLabelIdentity,
  IrDeclaration,
  IrEnumDeclaration,
  IrExpression,
  IrFunctionDeclaration,
  IrBindingIdentity,
  IrInterfaceDeclaration,
  IrModule,
  IrParameter,
  IrStatement,
  IrSwitchCase,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrUnionMemberTestEvidence,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { getCompilerCppAmbientMemberBinding } from './cppAmbientMemberBinding.js';
import { createIrModuleClosureCapturePlanCpp } from './cppClosureCapturePlan.js';
import {
  convertSourcePathToCppFileName,
  getCppCompilerPackageIncludePrefix,
  getCppCompilerPackageNamespace,
  isCppCompilerKeyword,
} from './cppCompilerIdentity.js';
import { createIrTypeReferenceRepresentationPlannerCpp } from './cppReferenceRepresentationPlan.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerExternalBindingConstructionCpp,
  getCompilerExternalBindingHeadersCpp,
  getCompilerRuntimeExternalMemberTargetCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
} from './cppRuntimeExternalSymbolBinding.js';
import { createCppUnionRepresentationPlan } from './cppUnionRepresentationPlan.js';

interface AnonymousStruct {
  name: string;
  properties: readonly { name: string; optional: boolean; type: string }[];
}

interface CppVariantRepresentation {
  alternatives: readonly Readonly<{ members: readonly IrType[]; targetType: string }>[];
  direct: boolean;
}

interface EmitContext {
  anonymousStructs: Map<string, AnonymousStruct>;
  arrayElementBindingIds: ReadonlySet<string>;
  async?: boolean | undefined;
  bindingClasses: ReadonlyMap<string, Readonly<IrClassDeclaration>>;
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  currentClass?: Readonly<IrClassDeclaration> | undefined;
  defaultedParameterIds: ReadonlySet<string>;
  finallyReturnVar?: string | undefined;
  includes: Set<string>;
  module: Readonly<IrModule>;
  moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  nullableBindingIds: ReadonlySet<string>;
  options: Readonly<CppCompilerBackendOptions>;
  referenceRepresentationPlanner: CompilerCppReferenceRepresentationPlanner;
  returnsAbsent: boolean;
  sharedCaptureTargetNames: ReadonlyMap<string, string>;
  sourceModules: readonly Readonly<IrModule>[];
  targetNames: ReadonlyMap<string, string>;
  uninitializedCaptureStorageBindingIds: ReadonlySet<string>;
  generatedNames: Set<string>;
  enclosingReturnType?: Readonly<IrType> | undefined;
}

export function createCppCompilerBackend(): CompilerBackend<CppCompilerBackendOptions> {
  return {
    createEmissionSession({ moduleResolution, modules, options }) {
      const referenceRepresentationPlanner = moduleResolution
        ? createIrTypeReferenceRepresentationPlannerCpp(modules, moduleResolution)
        : createIrTypeReferenceRepresentationPlannerCpp(modules);
      return Object.freeze({
        emitModule(module: Readonly<IrModule>) {
          return [
            emitIrModuleCppWithContext(module, options, modules, moduleResolution, referenceRepresentationPlanner),
          ];
        },
      });
    },
    emitModule(module, { moduleResolution, modules, options }) {
      return [emitIrModuleCppWithContext(module, options, modules, moduleResolution)];
    },
    name: 'cpp',
  };
}

export function emitIrModuleCpp(
  sourceModule: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions> = {},
): EmittedFile {
  return emitIrModuleCppWithContext(sourceModule, options, [sourceModule]);
}

function emitIrModuleCppWithContext(
  sourceModule: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions>,
  sourceModules: readonly Readonly<IrModule>[],
  moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined,
  referenceRepresentationPlanner?: CompilerCppReferenceRepresentationPlanner | undefined,
): EmittedFile {
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [
    createCompilerLoweringPassExtraArgumentErasure(),
    createCompilerLoweringPassAwaitConditionHoisting(),
    createCompilerLoweringPassCatchAwaitHoisting(),
    createCompilerLoweringPassBindingPattern(),
    createCompilerLoweringPassVariableHoisting(),
    createCompilerLoweringPassCStyleFor(),
    createCompilerLoweringPassInterfaceInheritance(sourceModules, moduleResolution),
    createCompilerLoweringPassSwitchFallthrough(),
    createCompilerLoweringPassSwitchSuspension(),
  ]);
  assertRuntimeExternalSymbolBindingsCpp(module, options);
  let targetNames: Map<string, string>;
  try {
    targetNames = createCppTargetNameMap(module);
  } catch (error) {
    if (isCompilerTargetNameAllocationFailure(error)) {
      throw createBackendEmissionFailure(
        'cpp',
        module,
        `public declarations share fixed C++ target name ${error.targetName}`,
      );
    }
    throw error;
  }
  const bindingTypes = collectIrModuleBindingTypesCpp(module);
  const closureCapturePlan = createIrModuleClosureCapturePlanCpp(module);
  const sharedCaptureTargetNames = new Map<string, string>();
  const uninitializedCaptureStorageBindingIds = collectIrModuleUninitializedBindingIdsCpp(module);
  const context: EmitContext = {
    anonymousStructs: new Map(),
    arrayElementBindingIds: collectIrModuleArrayElementBindingIdsCpp(module, bindingTypes),
    bindingClasses: collectIrModuleBindingClassesCpp(module, bindingTypes),
    bindingTypes,
    defaultedParameterIds: new Set(),
    includes: new Set<string>(),
    module,
    ...(moduleResolution ? { moduleResolution } : {}),
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    options,
    referenceRepresentationPlanner:
      referenceRepresentationPlanner ??
      (moduleResolution
        ? createIrTypeReferenceRepresentationPlannerCpp(sourceModules, moduleResolution)
        : createIrTypeReferenceRepresentationPlannerCpp(sourceModules)),
    returnsAbsent: false,
    sharedCaptureTargetNames,
    sourceModules,
    targetNames,
    uninitializedCaptureStorageBindingIds,
    generatedNames: new Set(targetNames.values()),
  };
  for (const bindingPlan of closureCapturePlan.bindings) {
    const bindingType = bindingTypes.get(bindingPlan.binding.id);
    if (
      bindingPlan.reasons.includes('capturedReferentMutation') &&
      (!bindingType || !hasSharedReferentRepresentationCpp(bindingType, context))
    ) {
      emissionError(
        context,
        `captured referent mutation of ${bindingPlan.binding.name} requires a shared C++ reference representation`,
      );
    }
    if (bindingPlan.representation !== 'sharedMutableCell') continue;
    if (!bindingType) {
      emissionError(
        context,
        `shared mutable capture ${bindingPlan.binding.name} requires concrete binding type evidence`,
      );
    }
    const targetName = targetNames.get(bindingPlan.binding.id) ?? safeCppName(bindingPlan.binding.name);
    sharedCaptureTargetNames.set(bindingPlan.binding.id, generateUniqueName(`${targetName}_capture`, context));
  }
  const declarations = [...module.declarations]
    .sort((left, right) => declarationPriorityCpp(left) - declarationPriorityCpp(right))
    .map((declaration) => emitDeclaration(declaration, context));
  const imports = emitImports(module, context);
  const reexports = emitReexportsCpp(module, context);
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit)];
  lines.push('#pragma once');
  const sortedIncludes = [...context.includes].sort();
  for (const include of sortedIncludes) {
    lines.push(`#include <${include}>`);
  }
  if (options.runtimeHeader) {
    lines.push(`#include "${options.runtimeHeader}"`);
  } else if (getCppRuntimeProfile(options) === 'flight-cpp') {
    lines.push('#include <flight/runtime.hpp>');
  }
  if (getCppRuntimeProfile(options) === 'flight-cpp') {
    lines.push(
      '',
      'static_assert(flight::runtime_contract.compiler_contract == "flight-runtime-contract/2", "Flight compiler/runtime contract mismatch");',
      'static_assert(flight::runtime_contract.cpp_abi == 1, "Flight C++ runtime ABI mismatch");',
    );
  }
  if (imports.length > 0) lines.push('', ...imports);
  const namespaceName = getCppCompilerPackageNamespace(module.packageName, options.packageTargets);
  lines.push('', `namespace ${namespaceName} {`);
  for (const struct of context.anonymousStructs.values()) {
    lines.push('');
    lines.push(
      `struct ${struct.name}${getCppRuntimeProfile(context.options) === 'flight-cpp' ? ' : public flight::ReferenceEnabled' : ''} {`,
    );
    for (const property of struct.properties) {
      lines.push(`  ${emitOptionalTypeCpp(property.type, property.optional, context)} ${property.name};`);
    }
    lines.push('};');
  }
  if (reexports.length > 0) lines.push('', ...reexports);
  declarations.forEach((declaration) => lines.push('', ...declaration));
  lines.push('', `} // namespace ${namespaceName}`);
  const runtimeDependency =
    options.runtimeHeader ?? (getCppRuntimeProfile(options) === 'flight-cpp' ? 'flight/runtime.hpp' : undefined);
  return {
    contents: lines.join('\n'),
    dependencies: [
      ...context.includes,
      ...imports.map(getCppIncludeDirectivePath),
      ...(runtimeDependency ? [runtimeDependency] : []),
    ],
    path: getCppModuleFilePath(module, options),
  };
}

function createCppTargetNameMap(module: Readonly<IrModule>): Map<string, string> {
  const publicNameGroups = new Map<string, (IrBindingIdentity | IrTypeBindingIdentity)[]>();
  for (const declaration of module.declarations) {
    if (!declaration.exported) continue;
    for (const binding of collectCppPublicDeclarationBindings(declaration)) {
      const preferredName = getCppPreferredBindingName(binding).normalize('NFC');
      const group = publicNameGroups.get(preferredName) ?? [];
      group.push(binding);
      publicNameGroups.set(preferredName, group);
    }
  }
  const collisionBindingIds = new Set(
    [...publicNameGroups.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) => group.map((binding) => binding.id)),
  );
  return new Map(
    createIrModuleTargetNameAllocation(module, (binding) => ({
      namespace: 'identifier',
      preferredName: collisionBindingIds.has(binding.id)
        ? createCppPublicCollisionName(binding)
        : getCppPreferredBindingName(binding),
    })).map((allocation) => [allocation.identity, allocation.name]),
  );
}

function collectCppPublicDeclarationBindings(
  declaration: Readonly<IrDeclaration>,
): readonly (IrBindingIdentity | IrTypeBindingIdentity)[] {
  return 'binding' in declaration ? [declaration.binding] : collectCppBindingPatternBindings(declaration.pattern);
}

function collectCppBindingPatternBindings(pattern: Readonly<IrBindingPattern>): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const children =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) => (element ? collectCppBindingPatternBindings(element.pattern) : []))
      : pattern.properties.flatMap((property) => collectCppBindingPatternBindings(property.pattern));
  return pattern.rest ? [...children, ...collectCppBindingPatternBindings(pattern.rest)] : children;
}

function getCppPreferredBindingName(binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>): string {
  return binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum'
    ? safeCppTypeName(binding.name)
    : safeCppName(binding.name);
}

function createCppPublicCollisionName(binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>): string {
  const identity = [binding.space, binding.kind, binding.name.normalize('NFC')]
    .map(encodeCppPublicNameComponent)
    .join('_');
  return `${getCppPreferredBindingName(binding)}_flight_${identity}`;
}

function encodeCppPublicNameComponent(value: string): string {
  return [...value]
    .map((character) =>
      /^[a-z0-9]$/u.test(character) ? character : `_u${character.codePointAt(0)!.toString(16).padStart(6, '0')}_`,
    )
    .join('');
}

function emitDeclaration(declaration: Readonly<IrDeclaration>, context: EmitContext): string[] {
  switch (declaration.kind) {
    case 'class':
      return emitClass(declaration, context);
    case 'enum':
      return emitEnum(declaration, context);
    case 'function':
      return emitFunction(declaration, context);
    case 'interface':
      return emitInterface(declaration, context);
    case 'typeAlias':
      return emitTypeAlias(declaration, context);
    case 'variable':
      return emitVariableDeclaration(declaration, context);
  }
}

function emitClass(declaration: Readonly<IrClassDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = { ...outer, currentClass: declaration };
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const extendsClause = declaration.extends
    ? ` : public ${emitType(declaration.extends, context, 'storage')}`
    : getCppRuntimeProfile(context.options) === 'flight-cpp'
      ? ' : public flight::ReferenceEnabled'
      : '';
  const overriddenMethods = getIrClassInheritedMethodNamesCpp(declaration, context);
  const inheritedAbstractFields = getIrClassInheritedAbstractFieldNamesCpp(declaration, context);
  const hasSubclass = hasIrModuleSubclassCpp(declaration, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`struct ${name}${extendsClause} {`);
  const baseFieldInits: string[] = [];
  for (const field of declaration.fields) {
    if (!field.static && inheritedAbstractFields.has(field.name)) {
      if (field.initializer) {
        baseFieldInits.push(
          `    this->${safeCppName(field.name)} = ${emitExpression(field.initializer, context, field.type)};`,
        );
      }
      continue;
    }
    const fieldType = emitOptionalTypeCpp(emitType(field.type, context), field.optional, context);
    const initializer = field.initializer ? ` = ${emitExpression(field.initializer, context, field.type)}` : '';
    const staticPrefix = field.static ? 'inline static ' : '';
    const constPrefix = field.static && field.readonly ? 'const ' : '';
    lines.push(`  ${staticPrefix}${constPrefix}${fieldType} ${safeCppName(field.name)}${initializer};`);
  }
  if (declaration.classConstructor) {
    if (
      declaration.extends &&
      declaration.classConstructor.parameters.some((parameter) => parameter.initializer !== undefined)
    ) {
      emissionError(context, 'derived constructor default parameters require pre-base-initializer lowering');
    }
    const constructorContext: EmitContext = {
      ...context,
      defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.classConstructor.parameters),
    };
    const params = declaration.classConstructor.parameters
      .map((parameter) => emitParameter(parameter, constructorContext))
      .join(', ');
    const constructorParameterBindingIds = new Set(
      declaration.classConstructor.parameters.map((parameter) => parameter.binding.id),
    );
    const superContext: EmitContext = {
      ...constructorContext,
      sharedCaptureTargetNames: new Map(
        [...constructorContext.sharedCaptureTargetNames].filter(
          ([bindingId]) => !constructorParameterBindingIds.has(bindingId),
        ),
      ),
    };
    const superCall = declaration.extends
      ? extractSuperCallCpp(declaration.classConstructor.body, superContext)
      : undefined;
    const initList = superCall ? ` : ${superCall}` : '';
    const body = superCall
      ? declaration.classConstructor.body.filter((statement) => !isSuperCallStatement(statement))
      : declaration.classConstructor.body;
    lines.push(`  ${name}(${params})${initList} {`);
    lines.push(...baseFieldInits);
    lines.push(
      ...indentSourceLines(
        [
          ...emitParameterInitializersCpp(declaration.classConstructor.parameters, constructorContext),
          ...emitStatements(body, constructorContext),
        ],
        2,
      ),
    );
    lines.push('  }');
  } else if (baseFieldInits.length > 0) {
    lines.push(`  ${name}() {`);
    lines.push(...baseFieldInits);
    lines.push('  }');
  }
  if (hasSubclass || declaration.abstract) {
    lines.push(`  virtual ~${name}() = default;`);
  }
  for (const method of declaration.methods) {
    const methodContext: EmitContext = {
      ...context,
      async: method.async,
      defaultedParameterIds: collectDefaultedParameterIdsCpp(method.parameters),
      enclosingReturnType: method.returns,
      returnsAbsent: hasIrTypeAbsentMember(method.returns),
    };
    if (method.async) methodContext.includes.add('coroutine');
    const returnType = method.accessor === 'set' ? 'void' : emitType(method.returns, methodContext);
    const params = method.parameters.map((parameter) => emitParameter(parameter, methodContext)).join(', ');
    const methodName = safeCppName(method.name);
    if (method.abstract) {
      lines.push(`  virtual ${returnType} ${methodName}(${params}) = 0;`);
      continue;
    }
    const needsVirtual = !method.static && (hasSubclass || declaration.abstract || overriddenMethods.has(method.name));
    const virtual = needsVirtual && !overriddenMethods.has(method.name) ? 'virtual ' : '';
    const override = overriddenMethods.has(method.name) ? ' override' : '';
    const staticPrefix = method.static ? 'static ' : '';
    lines.push(`  ${staticPrefix}${virtual}${returnType} ${methodName}(${params})${override} {`);
    lines.push(
      ...indentSourceLines(
        [
          ...emitParameterInitializersCpp(method.parameters, methodContext),
          ...emitStatements(method.body, methodContext),
          ...(method.accessor === 'set' ? [] : emitImplicitCompletionCpp(method.body, methodContext)),
        ],
        2,
      ),
    );
    lines.push('  }');
  }
  lines.push('};');
  return lines;
}

function emitEnum(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const allStringValues = declaration.members.every((member) => typeof member.value === 'string');
  if (allStringValues) return emitStringEnumCpp(declaration, context);
  const lines: string[] = [`enum class ${name} {`];
  for (const member of declaration.members) {
    if (typeof member.value !== 'number' || !Number.isSafeInteger(member.value)) {
      emissionError(
        context,
        `numeric enum member ${declaration.binding.name}.${member.name} requires an integer value`,
      );
    }
    const value = ` = ${String(member.value)}`;
    lines.push(`  ${safeCppTypeName(member.name)}${value},`);
  }
  lines.push('};');
  return lines;
}

function emitStringEnumCpp(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const stringType = emitCppStringType(context);
  context.includes.add('utility');
  return [
    `struct ${name} {`,
    `  ${stringType} value;`,
    `  ${name}(${stringType} source) : value(std::move(source)) {}`,
    `  operator const ${stringType}&() const noexcept { return value; }`,
    `  friend bool operator==(const ${name}&, const ${name}&) noexcept = default;`,
    ...declaration.members.map((member) => `  static const ${name} ${safeCppTypeName(member.name)};`),
    '};',
    ...declaration.members.map(
      (member) =>
        `inline const ${name} ${name}::${safeCppTypeName(member.name)}{${stringType}(${JSON.stringify(member.value)})};`,
    ),
  ];
}

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    async: declaration.async,
    defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.parameters),
    enclosingReturnType: declaration.returns,
    returnsAbsent: hasIrTypeAbsentMember(declaration.returns),
  };
  if (declaration.async) context.includes.add('coroutine');
  const returnType = emitType(declaration.returns, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const params = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const name = getBindingTargetName(declaration.binding, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`inline ${returnType} ${name}(${params}) {`);
  lines.push(
    ...indentSourceLines([
      ...emitParameterInitializersCpp(declaration.parameters, context),
      ...emitStatements(declaration.body, context),
      ...emitImplicitCompletionCpp(declaration.body, context),
    ]),
  );
  lines.push('}');
  return lines;
}

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(
    `struct ${name}${getCppRuntimeProfile(context.options) === 'flight-cpp' ? ' : public flight::ReferenceEnabled' : ''} {`,
  );
  for (const property of declaration.properties) {
    const propType = emitOptionalTypeCpp(emitType(property.type, context), property.optional, context);
    lines.push(`  ${propType} ${safeCppName(property.name)};`);
  }
  lines.push('};');
  return lines;
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  const stringLiterals = getIrUnionTypeStringLiteralValues(declaration.type);
  if (stringLiterals) return emitStringLiteralUnionCpp(declaration, context);
  if (declaration.type.kind === 'object') {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(
      `struct ${name}${getCppRuntimeProfile(context.options) === 'flight-cpp' ? ' : public flight::ReferenceEnabled' : ''} {`,
    );
    for (const property of declaration.type.properties) {
      const propertyType = emitOptionalTypeCpp(emitType(property.type, context), property.optional, context);
      lines.push(`  ${propertyType} ${safeCppName(property.name)};`);
    }
    lines.push('};');
    return lines;
  }
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`using ${name} = ${emitType(declaration.type, context)};`);
  return lines;
}

function emitStringLiteralUnionCpp(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  return [`using ${getBindingTargetName(declaration.binding, context)} = ${emitCppStringType(context)};`];
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  if (!declaration.type && !declaration.initializer) {
    emissionError(context, `uninitialized variable ${declaration.binding.name} requires inferred type evidence`);
  }
  const name = getBindingTargetName(declaration.binding, context);
  const arrayElement = context.arrayElementBindingIds.has(declaration.binding.id);
  const type = declaration.type ? emitType(declaration.type, context) : 'auto';
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(declaration.mutable, declaration.type);
  const initializer = declaration.initializer
    ? ` = ${arrayElement ? emitOptionalExpressionCpp(declaration.initializer, context, declaration.type) : emitExpression(declaration.initializer, context, declaration.type)}`
    : '';
  return [`inline ${constness}${emittedType} ${name}${initializer};`];
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  if (!variable.type && !variable.initializer) {
    emissionError(context, `uninitialized variable ${variable.binding.name} requires inferred type evidence`);
  }
  const name = getBindingTargetName(variable.binding, context);
  const arrayElement = context.arrayElementBindingIds.has(variable.binding.id);
  const type = variable.type ? emitType(variable.type, context) : 'auto';
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(variable.mutable, variable.type);
  const initializer = variable.initializer
    ? ` = ${arrayElement ? emitOptionalExpressionCpp(variable.initializer, context, variable.type) : emitExpression(variable.initializer, context, variable.type)}`
    : '';
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(variable.binding.id);
  if (sharedCaptureTargetName) {
    if (!variable.initializer) {
      if (variable.initialValue === 'uninitialized' && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        const storageType = emitOptionalTypeCpp(type, true, context);
        return `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(storageType, 'std::nullopt', context)};`;
      }
      if (variable.initialValue === 'undefined') {
        return `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(type, 'std::nullopt', context)};`;
      }
      emissionError(context, `shared mutable capture ${variable.binding.name} requires explicit initial storage`);
    }
    const sharedType = emitOptionalTypeCpp(type, arrayElement, context);
    const sharedInitializer = arrayElement
      ? emitOptionalExpressionCpp(variable.initializer, context, variable.type)
      : emitExpression(variable.initializer, context, variable.type);
    return `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(sharedType, sharedInitializer, context)};`;
  }
  return `${constness}${emittedType} ${name}${initializer};`;
}

function emitExpression(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
  constructExpectedUnion = true,
): string {
  if (expectedType && constructExpectedUnion) {
    const constructed = emitContextualUnionExpressionCpp(expression, expectedType, context);
    if (constructed) return constructed;
  }
  switch (expression.kind) {
    case 'array': {
      const expectedArray = expectedType?.kind === 'array' ? expectedType : undefined;
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.elements.some((element) => element === undefined)
      ) {
        emissionError(context, 'sparse array literals are outside the dense flight-cpp array profile');
      }
      const elements = expression.elements.map((element) =>
        element ? emitExpression(element, context, expectedArray?.element) : '{}',
      );
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
        if (elements.length === 0 && !expectedArray) {
          emissionError(context, 'an empty array requires contextual element type in C++ emission');
        }
        const target = expectedArray ? `flight::Array<${emitType(expectedArray.element, context)}>` : 'flight::Array';
        return `${target}{${elements.join(', ')}}`;
      }
      context.includes.add('vector');
      return `std::vector{${elements.join(', ')}}`;
    }
    case 'assignment': {
      const assignmentType = getIrAssignmentTargetTypeCpp(expression.left, context);
      const right = emitExpression(expression.right, context, assignmentType);
      const sharedCaptureTargetName = getSharedCaptureTargetNameCpp(expression.left, context);
      if (sharedCaptureTargetName && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return emitSharedCaptureAssignmentCpp(
          sharedCaptureTargetName,
          expression.operator,
          right,
          context.uninitializedCaptureStorageBindingIds.has(
            expression.left.kind === 'identifier' && expression.left.reference.kind === 'binding'
              ? expression.left.reference.binding.id
              : '',
          ),
          context,
        );
      }
      if (expression.operator === '=' && expression.left.kind === 'property') {
        const setter = getIrExpressionClassAccessorCpp(expression.left.object, expression.left.name, 'set', context);
        if (setter) {
          return `${emitExpression(expression.left.object, context)}${memberOp(expression.left.object, context)}${safeCppName(expression.left.name)}(${right})`;
        }
      }
      const left = emitAssignmentTargetCpp(expression.left, context);
      if (expression.operator === '**=') {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return emitExpandedAssignmentCpp(left, `flight::power(assignment_target, ${right})`);
        }
        context.includes.add('cmath');
        return emitExpandedAssignmentCpp(left, `std::pow(assignment_target, ${right})`);
      }
      if (expression.operator === '%=') {
        context.includes.add('cmath');
        return emitExpandedAssignmentCpp(left, `std::fmod(assignment_target, ${right})`);
      }
      if (expression.operator === '>>>=') {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return emitExpandedAssignmentCpp(left, `flight::unsigned_right_shift(assignment_target, ${right})`);
        }
        context.includes.add('cstdint');
        return emitExpandedAssignmentCpp(
          left,
          `static_cast<double>(static_cast<uint32_t>(static_cast<int32_t>(assignment_target)) >> static_cast<uint32_t>(${right}))`,
        );
      }
      const bitwiseOperator = getCppBitwiseAssignmentOperator(expression.operator);
      if (bitwiseOperator) {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return emitExpandedAssignmentCpp(left, emitBitwiseOperationCpp(bitwiseOperator, 'assignment_target', right));
        }
        context.includes.add('cstdint');
        return emitExpandedAssignmentCpp(
          left,
          `static_cast<double>(static_cast<int32_t>(assignment_target) ${bitwiseOperator} static_cast<int32_t>(${right}))`,
        );
      }
      if (expression.operator === '&&=' || expression.operator === '||=' || expression.operator === '??=') {
        return emitLogicalAssignmentCpp(left, expression.operator, right);
      }
      return `${left} ${emitAssignmentOperator(expression.operator)} ${right}`;
    }
    case 'await':
      return `co_await ${emitExpression(expression.expression, context)}`;
    case 'binary': {
      if (expression.semantics.unionMemberTest) {
        return emitUnionMemberTestCpp(expression.semantics.unionMemberTest, context);
      }
      if (expression.semantics.nullishComparison) {
        return emitNullishComparisonCpp(expression, context);
      }
      if (expression.operator === '??') {
        const leftType = getIrExpressionBindingTypeCpp(expression.left, context);
        const union = leftType ? getIrUnionTypeCpp(leftType, context, new Set()) : undefined;
        if (union && getCppUnionRepresentationPlan(union, context).kind === 'dualSentinelVariant') {
          emissionError(context, 'dual-sentinel nullish coalescing requires presence projection lowering');
        }
        context.includes.add('optional');
        return `${emitOptionalExpressionCpp(expression.left, context, expectedType)}.value_or(${emitExpression(expression.right, context, expectedType)})`;
      }
      if (
        expression.operator === '+' &&
        expression.semantics.left.flow === 'string' &&
        expression.semantics.right.flow === 'string'
      ) {
        return emitStringConcatenation(expression, context);
      }
      if (
        expression.operator === '**' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return `flight::power(${emitExpression(expression.left, context)}, ${emitExpression(expression.right, context)})`;
        }
        context.includes.add('cmath');
        return `std::pow(${emitExpression(expression.left, context)}, ${emitExpression(expression.right, context)})`;
      }
      if (
        expression.operator === '>>>' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return `flight::unsigned_right_shift(${emitExpression(expression.left, context)}, ${emitExpression(expression.right, context)})`;
        }
        context.includes.add('cstdint');
        return `static_cast<double>(static_cast<uint32_t>(static_cast<int32_t>(${emitExpression(expression.left, context)})) >> static_cast<uint32_t>(${emitExpression(expression.right, context)}))`;
      }
      if (expression.operator === '%') {
        context.includes.add('cmath');
        return `std::fmod(${emitExpression(expression.left, context)}, ${emitExpression(expression.right, context)})`;
      }
      const op = emitBinaryOperator(expression.operator, expression.semantics, context);
      const bitwise =
        expression.operator === '&' ||
        expression.operator === '|' ||
        expression.operator === '^' ||
        expression.operator === '<<' ||
        expression.operator === '>>';
      const equality =
        expression.operator === '==' ||
        expression.operator === '===' ||
        expression.operator === '!=' ||
        expression.operator === '!==';
      const leftType = equality ? getIrExpressionTypeEvidenceCpp(expression.left, context) : undefined;
      const rightType = equality ? getIrExpressionTypeEvidenceCpp(expression.right, context) : undefined;
      const left = emitExpression(expression.left, context, isThisAccess(expression.left) ? rightType : undefined);
      const right = emitExpression(expression.right, context, isThisAccess(expression.right) ? leftType : undefined);
      if (bitwise) {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return emitBitwiseOperationCpp(expression.operator, left, right);
        }
        context.includes.add('cstdint');
        return `static_cast<double>(static_cast<int32_t>(${left}) ${op} static_cast<int32_t>(${right}))`;
      }
      return `(${left} ${op} ${right})`;
    }
    case 'call': {
      if (expression.optional) return emitOptionalCallExpressionCpp(expression, context);
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'number' &&
        expression.callee.member.name === 'toString'
      ) {
        const value = `std::to_string(${emitExpression(expression.callee.object, context)})`;
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return `flight::to_string(${emitExpression(expression.callee.object, context)})`;
        }
        context.includes.add('string');
        return value;
      }
      if (expression.callee.kind === 'property' && expression.callee.member) {
        const binding = getCompilerCppAmbientMemberBinding(
          expression.callee.member,
          getCppRuntimeProfile(context.options),
        );
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.callee.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.callee.object, context)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'method') {
          const receiver = emitExpression(expression.callee.object, context);
          const args = expression.arguments.map((argument, index) =>
            emitExpression(argument, context, getIrCallArgumentExpectedTypeCpp(expression, index, context)),
          );
          const call = `${receiver}${memberOp(expression.callee.object, context)}${binding.targetName}${emitCppTypeArguments(expression.typeArguments, context)}(${args.join(', ')})`;
          if (
            getCppRuntimeProfile(context.options) === 'flight-cpp' &&
            cppOptionalArrayMethods.has(expression.callee.member.name) &&
            expression.callee.member.receiver === 'array' &&
            expectedType &&
            !irTypeIncludesUndefinedCpp(expectedType)
          ) {
            return `${call}.value()`;
          }
          return call;
        }
      }
      if (
        expression.arguments.length === 1 &&
        expression.arguments[0]!.kind === 'spread' &&
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Math'
      ) {
        const spreadOperand = emitExpression(expression.arguments[0]!.expression, context);
        const foldTarget = cppMathSpreadFoldTargets[expression.callee.name];
        if (foldTarget) {
          if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
            return `${foldTarget.runtime}(${spreadOperand})`;
          }
          context.includes.add('algorithm');
          context.includes.add('limits');
          return `${spreadOperand}.empty() ? ${foldTarget.identity} : *${foldTarget.algorithm}(${spreadOperand}.begin(), ${spreadOperand}.end())`;
        }
      }
      const callee =
        expression.callee.kind === 'function'
          ? `(${emitExpression(expression.callee, context)})`
          : emitExpression(expression.callee, context);
      const args = expression.arguments.map((argument, index) =>
        emitExpression(argument, context, getIrCallArgumentExpectedTypeCpp(expression, index, context)),
      );
      return `${callee}${emitCppTypeArguments(expression.typeArguments, context)}(${args.join(', ')})`;
    }
    case 'cast': {
      const asserted = emitUnionMemberAssertionCpp(expression.expression, expression.type, context);
      return (
        asserted ??
        `static_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`
      );
    }
    case 'conditional':
      return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, context, expectedType)} : ${emitExpression(expression.whenFalse, context, expectedType)})`;
    case 'element': {
      if (expression.optional) return emitOptionalElementExpressionCpp(expression, context);
      if (expression.semantics.receivers.includes('tuple')) {
        context.includes.add('tuple');
        const index = getElementAccessTupleIndexCpp(expression, context);
        return `std::get<${String(index)}>(${emitExpression(expression.object, context)})`;
      }
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && hasIndexedRuntimeReceiverCpp(expression, context)) {
        return `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
      }
      return `${emitExpression(expression.object, context)}[static_cast<size_t>(${emitExpression(expression.index, context)})]`;
    }
    case 'function': {
      if (expression.async) emissionError(context, 'async closures require C++ coroutine lowering');
      const functionContext: EmitContext = {
        ...context,
        async: false,
        defaultedParameterIds: collectDefaultedParameterIdsCpp(expression.parameters),
        enclosingReturnType: expression.returns,
        returnsAbsent: hasIrTypeAbsentMember(expression.returns),
      };
      const usesThis = irFunctionExpressionUsesThisCpp(expression);
      if (usesThis && expression.thisMode === 'dynamic') {
        emissionError(context, 'dynamic-this closures require receiver lowering');
      }
      if (usesThis && !context.currentClass) {
        emissionError(context, 'lexical-this closure requires class receiver context');
      }
      functionContext.includes.add('functional');
      const params = expression.parameters.map((parameter) => emitParameter(parameter, functionContext));
      const capture = usesThis ? '[=, this]' : '[=]';
      if (
        expression.expression &&
        functionContext.defaultedParameterIds.size === 0 &&
        !hasSharedCaptureParameterCpp(expression.parameters, functionContext)
      ) {
        return `${capture}(${params.join(', ')}) { return ${emitExpression(expression.expression, functionContext, expression.returns)}; }`;
      }
      return `${capture}(${params.join(', ')}) {\n${indentSourceLines([
        ...emitParameterInitializersCpp(expression.parameters, functionContext),
        ...(expression.expression
          ? [`return ${emitExpression(expression.expression, functionContext, expression.returns)};`]
          : [
              ...emitStatements(expression.body, functionContext),
              ...emitImplicitCompletionCpp(expression.body, functionContext),
            ]),
      ]).join('\n')}\n}`;
    }
    case 'identifier': {
      if (
        expression.reference.kind === 'this' &&
        expectedType &&
        hasFlightReferenceRepresentationCpp(expectedType, context)
      ) {
        return 'flight::ref_from_this(*this)';
      }
      if (
        expression.reference.kind === 'binding' &&
        context.defaultedParameterIds.has(expression.reference.binding.id)
      ) {
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      if (
        expression.presence === 'narrowedPresent' &&
        expression.reference.kind === 'binding' &&
        context.nullableBindingIds.has(expression.reference.binding.id)
      ) {
        const bindingType = context.bindingTypes.get(expression.reference.binding.id);
        const union = bindingType ? getIrUnionTypeCpp(bindingType, context, new Set()) : undefined;
        const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
        if (plan?.kind === 'dualSentinelVariant') {
          if (plan.valueSlots.length !== 1) {
            emissionError(context, 'dual-sentinel presence narrowing requires one remaining C++ value domain');
          }
          context.includes.add('variant');
          return `std::get<${plan.valueSlots[0]!.targetType}>(${emitIdentifierReference(expression.reference, context)})`;
        }
        context.includes.add('optional');
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      if (expression.narrowedMember && expression.reference.kind === 'binding') {
        const narrowed = emitNarrowedUnionMemberCpp(expression, context);
        if (narrowed) return narrowed;
      }
      return emitIdentifierReference(expression.reference, context);
    }
    case 'literal':
      return emitLiteralWithExpectedTypeCpp(expression.value, expectedType, context);
    case 'new': {
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require C++ type-path lowering');
      }
      const typeName = emitIdentifierReference(expression.callee.reference, context);
      const externalConstruction =
        expression.callee.reference.kind === 'ambient'
          ? getCompilerExternalBindingConstructionCpp(
              expression.callee.reference.name,
              context.options.externalBindings,
            )
          : undefined;
      if (typeName === 'std::runtime_error') context.includes.add('stdexcept');
      const args = expression.arguments.map((argument, index) =>
        emitExpression(argument, context, getIrInvocationArgumentExpectedTypeCpp(expression, index)),
      );
      const typeArguments = emitCppTypeArguments(expression.typeArguments, context);
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'Array' &&
        args.length > 0
      ) {
        emissionError(context, 'Array length construction is outside the dense flight-cpp array profile');
      }
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'Promise'
      ) {
        if (expression.typeArguments.length !== 1) {
          emissionError(context, 'flight-cpp Promise construction requires one explicit type argument');
        }
        return `${typeName}${typeArguments}::create(${args.join(', ')})`;
      }
      if (externalConstruction) {
        return `${externalConstruction.targetName}${typeArguments}(${args.join(', ')})`;
      }
      const constructedType: IrType | undefined =
        expression.callee.reference.kind === 'binding'
          ? {
              kind: 'named',
              reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
              typeArguments: expression.typeArguments,
            }
          : undefined;
      if (
        constructedType &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        hasFlightReferenceRepresentationCpp(constructedType, context)
      ) {
        return `flight::make_ref<${typeName}${typeArguments}>(${args.join(', ')})`;
      }
      return `${typeName}${typeArguments}(${args.join(', ')})`;
    }
    case 'object': {
      const constructionType =
        expectedType && hasFlightReferenceRepresentationCpp(expectedType, context) ? expectedType : expression.type;
      const members = expression.members
        .filter((member): member is typeof member & { kind: 'property' } => member.kind === 'property')
        .map(
          (member) =>
            `.${safeCppName(member.name)} = ${emitExpression(member.value, context, getIrObjectPropertyTypeCpp(constructionType, member.name, context))}`,
        );
      const initializer = `{${members.join(', ')}}`;
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        hasFlightReferenceRepresentationCpp(constructionType, context)
      ) {
        const storageType = emitType(constructionType, context, 'storage');
        return `flight::make_ref<${storageType}>(${storageType}${initializer})`;
      }
      return initializer;
    }
    case 'property': {
      if (expression.optional) return emitOptionalPropertyExpressionCpp(expression, context);
      if (expression.member) {
        const binding = getCompilerCppAmbientMemberBinding(expression.member, getCppRuntimeProfile(context.options));
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.object, context)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'property') {
          return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${binding.targetName}`;
        }
      }
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'ambient') {
        addCppExternalBindingHeaders(expression.object.reference.name, 'value', context);
        const member = getCompilerRuntimeExternalMemberTargetCpp(
          expression.object.reference.name,
          expression.name,
          getCppRuntimeProfile(context.options),
          context.options.externalBindings,
        );
        if (member) return member;
      }
      if (
        expression.object.kind === 'identifier' &&
        expression.object.reference.kind === 'binding' &&
        !expression.object.narrowedMember &&
        getIrBindingVariantUnionTypeCpp(expression.object.reference.binding.id, context)
      ) {
        emissionError(context, `property ${expression.name} on a C++ variant requires proven union member access`);
      }
      const classDeclaration = getIrExpressionClassDeclarationCpp(expression.object, context);
      if (classDeclaration) {
        const staticMember =
          classDeclaration.fields.some((field) => field.static && field.name === expression.name) ||
          classDeclaration.methods.some((method) => method.static && method.name === expression.name);
        if (staticMember) {
          return `${getBindingTargetName(classDeclaration.binding, context)}::${safeCppName(expression.name)}`;
        }
      }
      const enumeration = getIrExpressionEnumDeclaration(expression.object, context);
      if (enumeration) {
        return `${getBindingTargetName(enumeration.binding, context)}::${safeCppTypeName(expression.name)}`;
      }
      if (getIrExpressionClassAccessorCpp(expression.object, expression.name, 'get', context)) {
        return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${safeCppName(expression.name)}()`;
      }
      return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${safeCppName(expression.name)}`;
    }
    case 'regexp':
      emissionError(context, 'regular expressions require a downstream standard-library mapping');
    case 'spread':
      emissionError(context, 'spreading an unbounded collection requires a fold or a variadic target');
    case 'template': {
      const flightRuntime = getCppRuntimeProfile(context.options) === 'flight-cpp';
      if (!flightRuntime) context.includes.add('string');
      const parts = expression.parts.map((part) =>
        typeof part === 'string'
          ? flightRuntime
            ? `flight::String(${JSON.stringify(part)})`
            : `std::string(${JSON.stringify(part)})`
          : flightRuntime
            ? `flight::to_string(${emitExpression(part, context)})`
            : `std::to_string(${emitExpression(part, context)})`,
      );
      return parts.length === 0 ? (flightRuntime ? 'flight::String()' : 'std::string()') : parts.join(' + ');
    }
    case 'tuple': {
      context.includes.add('tuple');
      const expectedTuple = expectedType?.kind === 'tuple' ? expectedType : undefined;
      const elements = expression.elements.map((element, index) => {
        if (!element.expression) {
          context.includes.add('optional');
          return 'std::nullopt';
        }
        const emitted = emitExpression(element.expression, context, expectedTuple?.elements[index]?.type);
        if (element.optional) {
          context.includes.add('optional');
          return `std::make_optional(${emitted})`;
        }
        return emitted;
      });
      return `std::make_tuple(${elements.join(', ')})`;
    }
    case 'unary': {
      if (
        expression.operator === 'typeof' &&
        expression.operand.kind === 'identifier' &&
        expression.operand.reference.kind === 'binding' &&
        getIrBindingVariantUnionTypeCpp(expression.operand.reference.binding.id, context)
      ) {
        emissionError(context, 'typeof on a C++ variant requires proven union member test evidence');
      }
      const sharedCaptureTargetName = getSharedCaptureTargetNameCpp(expression.operand, context);
      if (
        sharedCaptureTargetName &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        (expression.operator === '++' || expression.operator === '--')
      ) {
        const bindingValue =
          expression.operand.kind === 'identifier' &&
          expression.operand.reference.kind === 'binding' &&
          context.uninitializedCaptureStorageBindingIds.has(expression.operand.reference.binding.id)
            ? 'binding_value.value()'
            : 'binding_value';
        const mutation = expression.postfix
          ? `return ${bindingValue}${expression.operator};`
          : `${expression.operator}${bindingValue}; return ${bindingValue};`;
        return `${sharedCaptureTargetName}.update_binding([&](auto& binding_value) { ${mutation} })`;
      }
      const operand = emitExpression(expression.operand, context);
      if (expression.operator === '~') {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') return `flight::bitwise_not(${operand})`;
        context.includes.add('cstdint');
        return `static_cast<double>(~static_cast<int32_t>(${operand}))`;
      }
      if (expression.operator === '+' && expression.semantics.operand.flow === 'number') return operand;
      const operator = expression.postfix
        ? emitPostfixUnaryOperator(expression.operator)
        : emitPrefixUnaryOperator(expression.operator);
      if (!expression.postfix && (operator === '-' || operator === '+') && operand.startsWith(operator)) {
        return `${operator}(${operand})`;
      }
      return expression.postfix ? `${operand}${operator}` : `${operator}${operand}`;
    }
    case 'undefinedValue':
      return emitUndefinedWithExpectedTypeCpp(expectedType, context);
    case 'undefinedDefault': {
      context.includes.add('optional');
      return `${emitExpression(expression.value, context)}.value_or(${emitExpression(expression.fallback, context)})`;
    }
    case 'tupleRest': {
      context.includes.add('tuple');
      return `std::get<${String(expression.start)}>(${emitExpression(expression.object, context)})`;
    }
    case 'tupleSpread':
      return emitTupleSpreadExpressionCpp(expression, context);
    case 'tupleSuffix': {
      context.includes.add('tuple');
      const object = emitExpression(expression.object, context);
      const elements = Array.from(
        { length: expression.width },
        (_, offset) => `std::get<${String(expression.start + offset)}>(${object})`,
      );
      return `std::make_tuple(${elements.join(', ')})`;
    }
    case 'objectRest':
      emissionError(context, `${expression.kind} expressions require C++ structured binding lowering`);
  }
}

function emitStatement(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  switch (statement.kind) {
    case 'block':
      return ['{', ...indentSourceLines(emitStatements(statement.statements, context)), '}'];
    case 'break':
      return ['break;'];
    case 'continue':
      return ['continue;'];
    case 'do':
      return [
        'do {',
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        `} while (${emitExpression(statement.condition, context)});`,
      ];
    case 'expression':
      return [`${emitExpression(statement.expression, context)};`];
    case 'for':
      emissionError(context, 'C-style for loops require control-flow lowering before C++ emission');
    case 'forIn': {
      if ('pattern' in statement.variable) {
        emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
      }
      if (!statement.keyPlan) {
        emissionError(context, 'object key iteration requires closed key evidence');
      }
      if (statement.variable.type?.kind !== 'primitive' || statement.variable.type.name !== 'string') {
        emissionError(context, 'for-in binding requires primitive string type evidence');
      }
      const flightRuntime = getCppRuntimeProfile(context.options) === 'flight-cpp';
      const keyType = emitType(statement.variable.type, context);
      const keyValues = statement.keyPlan.keys
        .map((key) => (flightRuntime ? `flight::String(${JSON.stringify(key)})` : JSON.stringify(key)))
        .join(', ');
      const keyCollection = flightRuntime ? `flight::Array<${keyType}>` : `std::vector<${keyType}>`;
      const variableName = getBindingTargetName(statement.variable.binding, context);
      const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(statement.variable.binding.id);
      const iterationName = sharedCaptureTargetName
        ? generateUniqueName(`${variableName}_iteration_value`, context)
        : variableName;
      const loopBody = sharedCaptureTargetName
        ? [
            `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(keyType, iterationName, context)};`,
            ...emitStatements([statement.body], context),
          ]
        : emitStatements([statement.body], context);
      if (statement.keyPlan.evaluation === 'preserve') {
        const objectName = generateUniqueName('for_in_object', context);
        if (!flightRuntime) context.includes.add('vector');
        return [
          '{',
          `  auto ${objectName} = ${emitExpression(statement.object, context)};`,
          `  static_cast<void>(${objectName});`,
          `  for (const ${keyType}& ${iterationName} : ${keyCollection}{${keyValues}}) {`,
          ...indentSourceLines(loopBody, 2),
          '  }',
          '}',
        ];
      }
      if (!flightRuntime) context.includes.add('vector');
      return [
        ...(statement.keyPlan.evaluation === 'alreadyEvaluated'
          ? [`static_cast<void>(${emitExpression(statement.object, context)});`]
          : []),
        `for (const ${keyType}& ${iterationName} : ${keyCollection}{${keyValues}}) {`,
        ...indentSourceLines(loopBody),
        '}',
      ];
    }
    case 'forOf': {
      if (statement.await) emissionError(context, 'async iteration requires C++ coroutine lowering');
      if ('pattern' in statement.variable) {
        emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
      }
      const iterable = emitExpression(statement.iterable, context);
      const variableName = getBindingTargetName(statement.variable.binding, context);
      const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(statement.variable.binding.id);
      if (sharedCaptureTargetName) {
        if (!statement.variable.type) {
          emissionError(
            context,
            `shared mutable capture ${statement.variable.binding.name} requires concrete binding type evidence`,
          );
        }
        const iterationValueName = generateUniqueName(`${variableName}_iteration_value`, context);
        return [
          `for (auto ${iterationValueName} : ${iterable}) {`,
          ...indentSourceLines([
            `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(emitType(statement.variable.type, context), iterationValueName, context)};`,
            ...emitStatementBody(statement.body, context),
          ]),
          '}',
        ];
      }
      return [
        `for (auto ${variableName} : ${iterable}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
    }
    case 'if': {
      const lines = [
        `if (${emitExpression(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.consequent, context)),
        '}',
      ];
      if (statement.otherwise)
        lines.push('else {', ...indentSourceLines(emitStatementBody(statement.otherwise, context)), '}');
      return lines;
    }
    case 'return': {
      if (context.finallyReturnVar) {
        const lines: string[] = [];
        if (statement.expression) {
          lines.push(
            `${context.finallyReturnVar} = ${emitExpression(statement.expression, context, getExpectedReturnTypeCpp(context))};`,
          );
        }
        return lines;
      }
      const keyword = context.async ? 'co_return' : 'return';
      return [
        `${keyword}${statement.expression ? ` ${emitExpression(statement.expression, context, getExpectedReturnTypeCpp(context))}` : ''};`,
      ];
    }
    case 'switch': {
      const name = getGeneratedTargetName('switch_value', context);
      const cases = statement.cases.filter((switchCase) => switchCase.expression);
      const otherwise = statement.cases.find((switchCase) => !switchCase.expression);
      const lines = [`auto ${name} = ${emitExpression(statement.expression, context)};`];
      cases.forEach((switchCase, index) => {
        lines.push(
          `${index > 0 ? 'else ' : ''}if (${name} == ${emitExpression(switchCase.expression!, context)}) {`,
          ...indentSourceLines(emitSwitchCaseStatementsCpp(switchCase, statement.label, context)),
          '}',
        );
      });
      if (otherwise) {
        if (cases.length > 0) lines.push('else {');
        lines.push(
          ...indentSourceLines(
            emitSwitchCaseStatementsCpp(otherwise, statement.label, context),
            cases.length > 0 ? 1 : 0,
          ),
        );
        if (cases.length > 0) lines.push('}');
      }
      return ['{', ...indentSourceLines(lines), '}'];
    }
    case 'throw':
      return [`throw ${emitExpression(statement.expression, context)};`];
    case 'try': {
      if (statement.finallyBody)
        return emitTryFinallyCpp(statement as typeof statement & { finallyBody: IrStatement }, context);
      if (statement.catchClause && containsAwaitExpressionCpp(statement.catchClause.body)) {
        return emitTryCatchAwaitCpp(statement, statement.catchClause, context);
      }
      const lines = ['try {', ...indentSourceLines(emitStatementBody(statement.tryBody, context)), '}'];
      if (statement.catchClause) {
        lines.push(...emitCatchClauseCpp(statement.catchClause, context));
      }
      return lines;
    }
    case 'variable':
      return statement.declarations.map((variable) => emitVariable(variable, context));
    case 'while':
      return [
        `while (${emitExpression(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
  }
}

function emitCatchClauseCpp(
  catchClause: NonNullable<Extract<IrStatement, { kind: 'try' }>['catchClause']>,
  context: EmitContext,
): string[] {
  if (catchClause.binding) context.includes.add('stdexcept');
  const catchVar = catchClause.binding ? `const std::exception& ${safeCppName(catchClause.binding.name)}` : '...';
  return [`catch (${catchVar}) {`, ...indentSourceLines(emitStatementBody(catchClause.body, context)), '}'];
}

function emitTryCatchAwaitCpp(
  statement: Readonly<Extract<IrStatement, { kind: 'try' }>>,
  catchClause: Readonly<IrCatchClause>,
  context: EmitContext,
): string[] {
  if (catchClause.binding) {
    emissionError(context, 'C++ coroutines forbid co_await in catch handlers with an exception binding');
  }
  const caughtVar = getGeneratedTargetName('caught', context);
  const lines: string[] = [];
  lines.push(`bool ${caughtVar} = false;`);
  lines.push('try {', ...indentSourceLines(emitStatementBody(statement.tryBody, context)), '}');
  lines.push('catch (...) {', ...indentSourceLines([`${caughtVar} = true;`]), '}');
  lines.push(`if (${caughtVar}) {`, ...indentSourceLines(emitStatementBody(catchClause.body, context)), '}');
  return lines;
}

function emitSwitchCaseStatementsCpp(
  switchCase: Readonly<IrSwitchCase>,
  switchLabel: Readonly<IrControlFlowLabelIdentity> | undefined,
  context: EmitContext,
): string[] {
  const last = switchCase.statements.at(-1);
  const localBreak = last?.kind === 'break' && (!last.target || (switchLabel && last.target.id === switchLabel.id));
  return emitStatements(localBreak ? switchCase.statements.slice(0, -1) : switchCase.statements, context);
}

function emitStatementBody(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  return statement.kind === 'block'
    ? emitStatements(statement.statements, context)
    : emitStatements([statement], context);
}

function emitStatements(statements: readonly IrStatement[], context: EmitContext): string[] {
  return statements.flatMap((statement) => emitStatement(statement, context));
}

function containsAwaitExpressionCpp(statement: Readonly<IrStatement>): boolean {
  let found = false;
  analyzeIrStatementSubtreeTraversal(statement, {
    expression(expression) {
      if (expression.kind !== 'await') return;
      found = true;
      return false;
    },
  });
  return found;
}

function containsReturnStatementCpp(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'return':
      return true;
    case 'block':
      return statement.statements.some(containsReturnStatementCpp);
    case 'if':
      return (
        containsReturnStatementCpp(statement.consequent) ||
        (statement.otherwise ? containsReturnStatementCpp(statement.otherwise) : false)
      );
    case 'try':
      return (
        containsReturnStatementCpp(statement.tryBody) ||
        (statement.catchClause ? containsReturnStatementCpp(statement.catchClause.body) : false) ||
        (statement.finallyBody ? containsReturnStatementCpp(statement.finallyBody) : false)
      );
    default:
      return false;
  }
}

function emitTryFinallyCpp(
  statement: Readonly<Extract<IrStatement, { kind: 'try' }>> & { finallyBody: IrStatement },
  context: EmitContext,
): string[] {
  context.includes.add('exception');
  const exceptionVar = getGeneratedTargetName('finally_exception', context);
  const lines: string[] = [];
  const hasReturn =
    containsReturnStatementCpp(statement.tryBody) ||
    (statement.catchClause ? containsReturnStatementCpp(statement.catchClause.body) : false);
  let returnVar: string | undefined;
  if (hasReturn && context.enclosingReturnType) {
    context.includes.add('optional');
    returnVar = getGeneratedTargetName('finally_return', context);
    const returnValueType = context.async
      ? getIrTaskAwaitedTypeCpp(context.enclosingReturnType, context)
      : context.enclosingReturnType;
    lines.push(`std::optional<${emitType(returnValueType, context)}> ${returnVar};`);
  }
  lines.push(`std::exception_ptr ${exceptionVar};`);
  const innerContext: EmitContext = returnVar ? { ...context, finallyReturnVar: returnVar } : context;
  lines.push('try {');
  if (statement.catchClause && containsAwaitExpressionCpp(statement.catchClause.body)) {
    lines.push(...indentSourceLines(emitTryCatchAwaitCpp(statement, statement.catchClause, innerContext)));
  } else if (statement.catchClause) {
    lines.push(
      ...indentSourceLines([
        'try {',
        ...indentSourceLines(emitStatementBody(statement.tryBody, innerContext)),
        '}',
        ...emitCatchClauseCpp(statement.catchClause, innerContext),
      ]),
    );
  } else {
    lines.push(...indentSourceLines(emitStatementBody(statement.tryBody, innerContext)));
  }
  lines.push('}');
  lines.push('catch (...) {');
  lines.push(...indentSourceLines([`${exceptionVar} = std::current_exception();`]));
  lines.push('}');
  lines.push(...emitStatementBody(statement.finallyBody, context));
  lines.push(`if (${exceptionVar}) std::rethrow_exception(${exceptionVar});`);
  if (returnVar) {
    const keyword = context.async ? 'co_return' : 'return';
    lines.push(`if (${returnVar}.has_value()) ${keyword} ${returnVar}.value();`);
  }
  return lines;
}

function emitType(type: Readonly<IrType>, context: EmitContext, representation: 'storage' | 'value' = 'value'): string {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments[0]
  ) {
    return emitType(type.typeArguments[0], context, representation);
  }
  if (
    representation === 'value' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasFlightReferenceRepresentationCpp(type, context)
  ) {
    return `flight::Ref<${emitType(type, context, 'storage')}>`;
  }
  switch (type.kind) {
    case 'array':
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return `flight::Array<${emitType(type.element, context)}>`;
      }
      context.includes.add('vector');
      return `std::vector<${emitType(type.element, context)}>`;
    case 'function': {
      context.includes.add('functional');
      const parameters = type.parameters.map((parameter) => emitType(parameter.type, context));
      const returns = emitType(type.returns, context);
      return `std::function<${returns}(${parameters.join(', ')})>`;
    }
    case 'indexedAccess':
    case 'keyof':
    case 'typeOf':
      emissionError(context, `${type.kind} types require C++ type computation lowering`);
    case 'intersection':
      emissionError(context, 'intersection types require C++ multiple-inheritance lowering');
    case 'literal':
      return typeof type.value === 'boolean'
        ? 'bool'
        : typeof type.value === 'number'
          ? 'double'
          : emitCppStringType(context);
    case 'named': {
      const sourceName = type.reference.kind === 'ambient' ? type.reference.name : undefined;
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        type.reference.kind === 'binding' &&
        type.reference.binding.kind === 'import'
      ) {
        const plan = context.referenceRepresentationPlanner.plan(type, context.module);
        if (plan.kind === 'refused') {
          emissionError(context, `imported type ${type.reference.binding.name} has ${plan.reason}`);
        }
      }
      if (sourceName === 'Partial' && type.typeArguments[0]) {
        emissionError(context, 'Partial<T> requires C++ optional-field lowering');
      }
      if (sourceName === 'WeakMap' && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        assertWeakMapTypeArgumentsCpp(type.typeArguments, context);
      }
      const mapped = getTypeReferenceTargetName(type, context);
      const arguments_ = type.typeArguments.map((argument) => emitType(argument, context));
      return `${mapped}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : ''}`;
    }
    case 'never':
      return 'void';
    case 'null':
    case 'undefined':
      return 'void';
    case 'object': {
      const emittedProperties = type.properties.map((property) => ({
        name: safeCppName(property.name),
        optional: property.optional,
        type: emitType(property.type, context),
      }));
      const key = emittedProperties
        .map((property) => `${property.optional ? '?' : ''}${property.type} ${property.name}`)
        .join('; ');
      const existing = context.anonymousStructs.get(key);
      if (existing) return existing.name;
      const structName = generateAnonymousStructName(type.properties, context);
      context.anonymousStructs.set(key, { name: structName, properties: emittedProperties });
      return structName;
    }
    case 'primitive':
      if (type.name === 'string') return emitCppStringType(context);
      if (type.name === 'void') return 'void';
      return {
        bigint: 'int64_t',
        boolean: 'bool',
        number: 'double',
        string: 'std::string',
        symbol: 'int',
        void: 'void',
      }[type.name];
    case 'tuple': {
      context.includes.add('tuple');
      const elements = type.elements.map((element) => {
        const emitted = emitType(element.type, context);
        if (element.optional) {
          context.includes.add('optional');
          return `std::optional<${emitted}>`;
        }
        return emitted;
      });
      return `std::tuple<${elements.join(', ')}>`;
    }
    case 'union':
      return emitUnionTypeCpp(type, context);
    case 'unknown':
      if (type.source === 'this' && context.currentClass) {
        return getBindingTargetName(context.currentClass.binding, context);
      }
      return 'auto';
  }
}

function assertWeakMapTypeArgumentsCpp(typeArguments: readonly IrType[], context: EmitContext): void {
  if (typeArguments.length !== 2 || !typeArguments[0] || !typeArguments[1]) {
    emissionError(context, 'flight-cpp WeakMap requires explicit key and value type arguments');
  }
  const key = context.referenceRepresentationPlanner.plan(typeArguments[0], context.module);
  if (key.kind !== 'represented' || key.valueRepresentation !== 'flightReference') {
    emissionError(context, 'flight-cpp WeakMap key requires a proven flight reference representation');
  }
  const value = context.referenceRepresentationPlanner.plan(typeArguments[1], context.module);
  if (value.kind !== 'represented' || value.identity.identity !== 'value') {
    emissionError(context, 'flight-cpp WeakMap value requires a proven reference-free representation');
  }
}

function emitUnionTypeCpp(type: Readonly<Extract<IrType, { kind: 'union' }>>, context: EmitContext): string {
  const plan = getCppUnionRepresentationPlan(type, context);
  const valueTypes = plan.valueSlots.map((slot) => slot.targetType);
  switch (plan.kind) {
    case 'singleValue':
      return valueTypes[0]!;
    case 'optionalSingle':
      context.includes.add('optional');
      return `std::optional<${valueTypes[0]!}>`;
    case 'multiVariant':
      context.includes.add('variant');
      return `std::variant<${valueTypes.join(', ')}>`;
    case 'optionalVariant':
      context.includes.add('optional');
      context.includes.add('variant');
      return `std::optional<std::variant<${valueTypes.join(', ')}>>`;
    case 'dualSentinelVariant': {
      context.includes.add('variant');
      const sentinels = getCppDualSentinelTargetTypes(context);
      return `std::variant<${[...valueTypes, sentinels.null, sentinels.undefined].join(', ')}>`;
    }
  }
}

function getCppDualSentinelTargetTypes(context: EmitContext): Readonly<{ null: string; undefined: string }> {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
    return { null: 'flight::Null', undefined: 'flight::Undefined' };
  }
  context.includes.add('cstddef');
  return { null: 'std::nullptr_t', undefined: 'std::monostate' };
}

function emitNullishComparisonCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): string {
  const evidence = expression.semantics.nullishComparison;
  if (!evidence) emissionError(context, 'nullish comparison requires semantic evidence');
  const operand =
    expression.left.kind === 'identifier' && expression.left.reference.kind === 'ambient'
      ? expression.right
      : expression.left;
  const operandType =
    operand.kind === 'identifier' && operand.reference.kind === 'binding'
      ? context.bindingTypes.get(operand.reference.binding.id)
      : undefined;
  const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  if (evidence.admitsNull && evidence.admitsUndefined) {
    if (!plan || plan.kind !== 'dualSentinelVariant') {
      emissionError(context, 'nullish comparison admitting null and undefined requires dual-sentinel union evidence');
    }
    context.includes.add('variant');
    const sentinels = getCppDualSentinelTargetTypes(context);
    const value = emitExpression(operand, context);
    const selected = evidence.literal === 'null' ? sentinels.null : sentinels.undefined;
    const strict = expression.operator === '===' || expression.operator === '!==';
    const test = strict
      ? `std::holds_alternative<${selected}>(${value})`
      : `(std::holds_alternative<${sentinels.null}>(${value}) || std::holds_alternative<${sentinels.undefined}>(${value}))`;
    return expression.operator === '!=' || expression.operator === '!==' ? `!(${test})` : test;
  }
  context.includes.add('optional');
  const negated = expression.operator === '!=' || expression.operator === '!==';
  return `${negated ? '' : '!'}${emitExpression(operand, context)}.has_value()`;
}

function emitUnionMemberAssertionCpp(
  expression: Readonly<IrExpression>,
  assertedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  const union = getIrBindingVariantUnionTypeCpp(expression.reference.binding.id, context);
  if (!union) return undefined;
  const representation = getCppVariantRepresentation(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    alternative.members.some((member) => isDeepStrictEqual(member, assertedType)),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'type assertion target must identify exactly one C++ variant alternative');
  }
  if (representation.direct) return emitIdentifierReference(expression.reference, context);
  return `std::get<${alternatives[0]!.targetType}>(${emitIdentifierReference(expression.reference, context)})`;
}

function emitUnionMemberTestCpp(evidence: Readonly<IrUnionMemberTestEvidence>, context: EmitContext): string {
  const union = getIrBindingVariantUnionTypeCpp(evidence.binding.id, context);
  if (!union) emissionError(context, 'union member test requires a C++ variant binding');
  const representation = getCppVariantRepresentation(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    alternative.members.some((member) => isDeepStrictEqual(member, evidence.member)),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'union member test must identify exactly one C++ variant alternative');
  }
  const test = representation.direct
    ? 'true'
    : `std::holds_alternative<${alternatives[0]!.targetType}>(${emitBindingValueCpp(evidence.binding, context)})`;
  return evidence.whenResult ? test : `!${test}`;
}

function emitNarrowedUnionMemberCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  context: EmitContext,
): string | undefined {
  if (!expression.narrowedMember || expression.reference.kind !== 'binding') return undefined;
  const union = getIrBindingVariantUnionTypeCpp(expression.reference.binding.id, context);
  if (!union) return undefined;
  const representation = getCppVariantRepresentation(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    alternative.members.some((member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember),
  );
  if (alternatives.length !== 1) {
    emissionError(context, `narrowed member ${expression.narrowedMember} must identify one C++ variant alternative`);
  }
  if (representation.direct) return emitIdentifierReference(expression.reference, context);
  return `std::get<${alternatives[0]!.targetType}>(${emitIdentifierReference(expression.reference, context)})`;
}

function getCppVariantRepresentation(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): CppVariantRepresentation {
  const plan = getCppUnionRepresentationPlan(type, context);
  if (plan.kind === 'optionalSingle' || plan.kind === 'optionalVariant' || plan.kind === 'dualSentinelVariant') {
    emissionError(context, 'nullable union member access requires presence-aware C++ narrowing');
  }
  if (plan.kind === 'multiVariant') context.includes.add('variant');
  return {
    alternatives: plan.valueSlots.map((slot) => ({
      members: slot.sourceAlternatives,
      targetType: slot.targetType,
    })),
    direct: plan.kind === 'singleValue',
  };
}

function getCppUnionRepresentationPlan(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): Exclude<ReturnType<typeof createCppUnionRepresentationPlan>, { kind: 'refused' }> {
  const plan = createCppUnionRepresentationPlan(type, {
    resolveAliasTarget(typeReference) {
      if (typeReference.reference.kind !== 'binding' || typeReference.typeArguments.length > 0) return undefined;
      const bindingId = typeReference.reference.binding.id;
      const alias = context.module.declarations.find(
        (declaration) => declaration.kind === 'typeAlias' && declaration.binding.id === bindingId,
      );
      return alias?.kind === 'typeAlias' ? alias.type : undefined;
    },
    resolveTargetType(runtimeType) {
      return emitType(runtimeType, context);
    },
  });
  if (plan.kind === 'refused') {
    const targetTypes = plan.collisions.map((collision) => collision.targetType).join(', ');
    emissionError(context, `union has distinct runtime domains erased by C++ target type ${targetTypes}`);
  }
  return plan;
}

function emitContextualUnionExpressionCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const union = getIrUnionTypeCpp(expectedType, context, new Set());
  if (!union || expression.kind === 'conditional') return undefined;
  const plan = getCppUnionRepresentationPlan(union, context);
  if (expression.kind === 'undefinedValue') {
    return emitCppUnionSentinelConstruction('undefined', union, plan.kind, context);
  }
  if (expression.kind === 'literal' && expression.value === null) {
    return emitCppUnionSentinelConstruction('null', union, plan.kind, context);
  }
  assertIrExpressionHasNoDualSentinelOptionalChainCpp(expression, context);
  if (
    (expression.kind === 'call' && (expression.optional || expression.semantics.optionalChain)) ||
    (expression.kind === 'element' && (expression.optional || expression.semantics.optionalChain)) ||
    (expression.kind === 'property' && (expression.optional || expression.optionalChain))
  ) {
    return undefined;
  }
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return undefined;
  }
  const expressionType = getIrExpressionTypeForUnionConstructionCpp(expression, plan.valueSlots, context);
  if (!expressionType) {
    if (plan.kind === 'singleValue') return undefined;
    emissionError(context, `contextual ${plan.kind} construction requires expression type evidence`);
  }
  const expressionUnion = getIrUnionTypeCpp(expressionType, context, new Set());
  if (expressionUnion) {
    if (isDeepStrictEqual(getCppUnionRepresentationPlan(expressionUnion, context), plan)) return undefined;
    emissionError(context, 'contextual C++ union conversion requires equivalent source union evidence');
  }
  const runtimeType = getIrTypeRuntimeDomainCpp(expressionType, context, new Set());
  if (!runtimeType) {
    emissionError(context, `contextual ${plan.kind} construction requires one runtime value domain`);
  }
  const targetType = emitType(runtimeType, context);
  const valueSlot = plan.valueSlots.findIndex((slot) => slot.targetType === targetType);
  if (valueSlot < 0) {
    emissionError(context, `contextual union value type ${targetType} is not a represented runtime domain`);
  }
  const emitted = emitExpression(expression, context, runtimeType, false);
  if (plan.kind === 'singleValue') return emitted;
  if (plan.kind === 'optionalSingle') {
    context.includes.add('optional');
    return `std::optional<${targetType}>{${emitted}}`;
  }
  const unionType = emitUnionTypeCpp(union, context);
  if (plan.kind === 'optionalVariant') {
    return `${unionType}{std::in_place, std::in_place_type<${targetType}>, ${emitted}}`;
  }
  return `${unionType}{std::in_place_type<${targetType}>, ${emitted}}`;
}

function emitCppUnionSentinelConstruction(
  sentinel: 'null' | 'undefined',
  union: Readonly<Extract<IrType, { kind: 'union' }>>,
  planKind: Exclude<ReturnType<typeof createCppUnionRepresentationPlan>, { kind: 'refused' }>['kind'],
  context: EmitContext,
): string {
  if (planKind === 'optionalSingle' || planKind === 'optionalVariant') {
    context.includes.add('optional');
    return 'std::nullopt';
  }
  if (planKind !== 'dualSentinelVariant') {
    emissionError(context, `${sentinel} is not represented by the contextual C++ union`);
  }
  const sentinels = getCppDualSentinelTargetTypes(context);
  const targetType = sentinels[sentinel];
  const value =
    getCppRuntimeProfile(context.options) === 'flight-cpp'
      ? `flight::${sentinel}`
      : sentinel === 'null'
        ? 'nullptr'
        : 'std::monostate{}';
  return `${emitUnionTypeCpp(union, context)}{std::in_place_type<${targetType}>, ${value}}`;
}

function getIrExpressionTypeForUnionConstructionCpp(
  expression: Readonly<IrExpression>,
  valueSlots: readonly Readonly<{ runtimeType: IrType }>[],
  context: EmitContext,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'array':
      return getSingleIrTypeKindCpp(valueSlots, 'array');
    case 'assignment':
      return getIrAssignmentTargetTypeCpp(expression.left, context);
    case 'binary':
      return getIrOperatorValueDomainTypeCpp(expression.semantics.result);
    case 'call':
      return getIrCallReturnTypeCpp(expression, context);
    case 'cast':
      return expression.type;
    case 'function':
      return {
        kind: 'function',
        parameters: expression.parameters.map((parameter) => {
          const common = { name: parameter.binding.name, type: parameter.type };
          if (parameter.optional) return { ...common, optional: true, rest: false } as const;
          if (parameter.rest) return { ...common, optional: false, rest: true } as const;
          return { ...common, optional: false, rest: false } as const;
        }),
        returns: expression.returns,
        typeParameters: expression.typeParameters,
      };
    case 'identifier': {
      if (expression.reference.kind !== 'binding') return undefined;
      const declaredType = context.bindingTypes.get(expression.reference.binding.id);
      if (!declaredType || !expression.narrowedMember) return declaredType;
      const union = getIrUnionTypeCpp(declaredType, context, new Set());
      return (
        union?.types.find((member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember) ?? declaredType
      );
    }
    case 'literal':
      return typeof expression.value === 'boolean'
        ? { kind: 'primitive', name: 'boolean' }
        : typeof expression.value === 'number'
          ? { kind: 'primitive', name: 'number' }
          : typeof expression.value === 'string'
            ? { kind: 'primitive', name: 'string' }
            : { kind: 'null' };
    case 'new':
      return expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
        ? {
            kind: 'named',
            reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
            typeArguments: expression.typeArguments,
          }
        : undefined;
    case 'object':
      return expression.type;
    case 'tuple':
      return getSingleIrTypeKindCpp(valueSlots, 'tuple');
    case 'unary':
      return getIrOperatorValueDomainTypeCpp(expression.semantics.result);
    case 'undefinedValue':
      return { kind: 'undefined' };
    default:
      return undefined;
  }
}

function getIrTypeRuntimeDomainCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  if (type.kind === 'literal') {
    return {
      kind: 'primitive',
      name: typeof type.value === 'boolean' ? 'boolean' : typeof type.value === 'number' ? 'number' : 'string',
    };
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.typeArguments.length > 0) return type;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return type;
  const alias = context.module.declarations.find(
    (declaration) => declaration.kind === 'typeAlias' && declaration.binding.id === bindingId,
  );
  if (alias?.kind !== 'typeAlias') return type;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getIrTypeRuntimeDomainCpp(alias.type, context, nextResolvingAliases);
}

function getSingleIrTypeKindCpp<Kind extends IrType['kind']>(
  valueSlots: readonly Readonly<{ runtimeType: IrType }>[],
  kind: Kind,
): Readonly<Extract<IrType, { kind: Kind }>> | undefined {
  const matches = valueSlots.map((slot) => slot.runtimeType).filter((type) => type.kind === kind);
  return matches.length === 1 ? (matches[0] as Readonly<Extract<IrType, { kind: Kind }>>) : undefined;
}

function getIrOperatorValueDomainTypeCpp(domain: IrBinaryOperatorSemantics['result']): Readonly<IrType> | undefined {
  return domain === 'bigint' ||
    domain === 'boolean' ||
    domain === 'number' ||
    domain === 'string' ||
    domain === 'symbol'
    ? { kind: 'primitive', name: domain }
    : domain === 'null' || domain === 'undefined'
      ? { kind: domain }
      : undefined;
}

function getIrCallReturnTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.semantics.resultType.kind !== 'unknown') return expression.semantics.resultType;
  if (expression.callee.kind === 'function') return expression.callee.returns;
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') return undefined;
  const bindingId = expression.callee.reference.binding.id;
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'function' && candidate.binding.id === bindingId,
  );
  return declaration?.kind === 'function' ? declaration.returns : undefined;
}

function getIrCallArgumentExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const semanticType = getIrInvocationArgumentExpectedTypeCpp(expression, index);
  if (semanticType) return semanticType;
  if (expression.callee.kind === 'function') return expression.callee.parameters[index]?.type;
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') return undefined;
  const bindingId = expression.callee.reference.binding.id;
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'function' && candidate.binding.id === bindingId,
  );
  return declaration?.kind === 'function' ? declaration.parameters[index]?.type : undefined;
}

function getIrInvocationArgumentExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' | 'new' }>>,
  index: number,
): Readonly<IrType> | undefined {
  const provided = [
    ...(expression.semantics.defaultParameters?.provided ?? []),
    ...(expression.semantics.optionalParameters?.provided ?? []),
  ].find((argument) => argument.position === index);
  return provided?.parameterType;
}

function getIrObjectPropertyTypeCpp(
  type: Readonly<IrType>,
  propertyName: string,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (type.kind === 'object') return type.properties.find((property) => property.name === propertyName)?.type;
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const bindingId = type.reference.binding.id;
  const declaration = context.module.declarations.find(
    (candidate) =>
      (candidate.kind === 'class' || candidate.kind === 'interface' || candidate.kind === 'typeAlias') &&
      candidate.binding.id === bindingId,
  );
  if (declaration?.kind === 'class') {
    const field = declaration.fields.find((candidate) => candidate.name === propertyName);
    const propertyType =
      field?.type ??
      declaration.methods.find((candidate) => candidate.name === propertyName && candidate.accessor === 'get')?.returns;
    return propertyType
      ? resolveIrTypeStructuralSubstitution(
          propertyType,
          createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments),
        )
      : undefined;
  }
  if (declaration?.kind === 'interface') {
    const propertyType = declaration.properties.find((property) => property.name === propertyName)?.type;
    return propertyType
      ? resolveIrTypeStructuralSubstitution(
          propertyType,
          createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments),
        )
      : undefined;
  }
  return declaration?.kind === 'typeAlias'
    ? getIrObjectPropertyTypeCpp(
        resolveIrTypeStructuralSubstitution(
          declaration.type,
          createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments),
        ),
        propertyName,
        context,
      )
    : undefined;
}

function getIrExpressionTypeEvidenceCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'array':
      return undefined;
    case 'assignment':
      return getIrAssignmentTargetTypeCpp(expression.left, context);
    case 'await': {
      const operandType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
      return operandType?.kind === 'named' &&
        operandType.reference.kind === 'ambient' &&
        operandType.reference.name === 'Promise'
        ? getIrTaskAwaitedTypeCpp(operandType, context)
        : undefined;
    }
    case 'call':
      return getIrCallReturnTypeCpp(expression, context);
    case 'cast':
      return expression.type;
    case 'conditional':
      return (
        getIrExpressionTypeEvidenceCpp(expression.whenTrue, context) ??
        getIrExpressionTypeEvidenceCpp(expression.whenFalse, context)
      );
    case 'function':
      return {
        kind: 'function',
        parameters: expression.parameters.map((parameter) => {
          const common = { name: parameter.binding.name, type: parameter.type };
          if (parameter.optional) return { ...common, optional: true, rest: false } as const;
          if (parameter.rest) return { ...common, optional: false, rest: true } as const;
          return { ...common, optional: false, rest: false } as const;
        }),
        returns: expression.returns,
        typeParameters: expression.typeParameters,
      };
    case 'identifier': {
      if (expression.reference.kind === 'this' && context.currentClass) {
        return {
          kind: 'named',
          reference: { binding: context.currentClass.binding, kind: 'binding', path: [] },
          typeArguments: [],
        };
      }
      if (expression.reference.kind !== 'binding') return undefined;
      const declaredType = context.bindingTypes.get(expression.reference.binding.id);
      if (!declaredType || !expression.narrowedMember) return declaredType;
      return (
        getIrUnionTypeCpp(declaredType, context, new Set())?.types.find(
          (member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember,
        ) ?? declaredType
      );
    }
    case 'new':
      return expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
        ? {
            kind: 'named',
            reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
            typeArguments: expression.typeArguments,
          }
        : undefined;
    case 'object':
      return expression.type;
    case 'property': {
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      return objectType ? getIrObjectPropertyTypeCpp(objectType, expression.name, context) : undefined;
    }
    case 'binary':
    case 'element':
    case 'literal':
    case 'objectRest':
    case 'regexp':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'unary':
    case 'undefinedDefault':
    case 'undefinedValue':
      return undefined;
  }
}

function getIrBindingVariantUnionTypeCpp(
  bindingId: string,
  context: EmitContext,
): Extract<IrType, { kind: 'union' }> | undefined {
  const type = context.bindingTypes.get(bindingId);
  return type ? getIrVariantUnionTypeCpp(type, context, new Set()) : undefined;
}

function getIrVariantUnionTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string>,
): Extract<IrType, { kind: 'union' }> | undefined {
  const union = getIrUnionTypeCpp(type, context, seen);
  return union?.types.some((member) => member.kind === 'null' || member.kind === 'undefined') ? undefined : union;
}

function getIrUnionTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string>,
): Extract<IrType, { kind: 'union' }> | undefined {
  if (type.kind === 'union') return type;
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.typeArguments.length > 0) return undefined;
  const bindingId = type.reference.binding.id;
  if (seen.has(bindingId)) return undefined;
  const alias = context.module.declarations.find(
    (declaration) => declaration.kind === 'typeAlias' && declaration.binding.id === bindingId,
  );
  if (alias?.kind !== 'typeAlias') return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(bindingId);
  return getIrUnionTypeCpp(alias.type, context, nextSeen);
}

function getIrUnionMemberNameCpp(type: Readonly<IrType>): string | undefined {
  if (type.kind === 'primitive') return type.name;
  if (type.kind !== 'named') return undefined;
  return type.reference.kind === 'binding' ? type.reference.binding.name : type.reference.name;
}

function declarationPriorityCpp(declaration: Readonly<IrDeclaration>): number {
  return declaration.kind === 'class' ||
    declaration.kind === 'typeAlias' ||
    declaration.kind === 'interface' ||
    declaration.kind === 'enum'
    ? 0
    : 1;
}

function emitBindingConstnessCpp(mutable: boolean, type: Readonly<IrType> | undefined): string {
  return !mutable && type && isCppScalarValueType(type) ? 'const ' : '';
}

function isCppScalarValueType(type: Readonly<IrType>): boolean {
  if (type.kind === 'primitive' || type.kind === 'literal') return true;
  if (type.kind === 'union') {
    return type.types.every(
      (member) => member.kind === 'null' || member.kind === 'undefined' || isCppScalarValueType(member),
    );
  }
  return false;
}

function collectIrModuleBindingClassesCpp(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): ReadonlyMap<string, Readonly<IrClassDeclaration>> {
  const classesByIdentity = new Map(
    module.declarations
      .filter((declaration): declaration is IrClassDeclaration => declaration.kind === 'class')
      .map((declaration) => [declaration.binding.id, declaration] as const),
  );
  const result = new Map(classesByIdentity);
  for (const [bindingId, type] of bindingTypes) {
    if (type.kind !== 'named' || type.reference.kind !== 'binding') continue;
    const declaration = classesByIdentity.get(type.reference.binding.id);
    if (declaration) result.set(bindingId, declaration);
  }
  return result;
}

function collectIrModuleBindingTypesCpp(module: Readonly<IrModule>): ReadonlyMap<string, Readonly<IrType>> {
  const result = new Map<string, Readonly<IrType>>();
  const inferred = new Map<string, Readonly<IrExpression>>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      result.set(parameter.binding.id, parameter.type);
    },
    variable(variable) {
      if (!('binding' in variable)) return;
      if (variable.type) result.set(variable.binding.id, variable.type);
      if (variable.initializer) inferred.set(variable.binding.id, variable.initializer);
    },
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const [bindingId, initializer] of inferred) {
      const existing = result.get(bindingId);
      if (existing && existing.kind !== 'unknown') continue;
      const type = inferIrExpressionTypeCpp(initializer, result);
      if (!type) continue;
      result.set(bindingId, type);
      changed = true;
    }
  }
  return result;
}

function inferIrExpressionTypeCpp(
  expression: Readonly<IrExpression>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'assignment':
      return expression.left.kind === 'identifier' && expression.left.reference.kind === 'binding'
        ? bindingTypes.get(expression.left.reference.binding.id)
        : undefined;
    case 'call':
      return expression.semantics.resultType.kind === 'unknown' ? undefined : expression.semantics.resultType;
    case 'cast':
      return expression.type;
    case 'conditional':
      return (
        inferIrExpressionTypeCpp(expression.whenTrue, bindingTypes) ??
        inferIrExpressionTypeCpp(expression.whenFalse, bindingTypes)
      );
    case 'identifier':
      return expression.reference.kind === 'binding' ? bindingTypes.get(expression.reference.binding.id) : undefined;
    case 'new':
      return expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
        ? {
            kind: 'named',
            reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
            typeArguments: expression.typeArguments,
          }
        : undefined;
    case 'object':
      return expression.type;
    case 'undefinedValue':
      return expression.type;
    case 'array':
    case 'await':
    case 'binary':
    case 'element':
    case 'function':
    case 'literal':
    case 'objectRest':
    case 'property':
    case 'regexp':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'unary':
    case 'undefinedDefault':
      return undefined;
  }
}

function collectIrModuleArrayElementBindingIdsCpp(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): ReadonlySet<string> {
  const candidates = new Set<string>();
  const nullishUsed = new Set<string>();
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (expression.kind === 'binary' && (expression.operator === '??' || expression.semantics.nullishComparison)) {
        const operand =
          expression.left.kind === 'identifier' && expression.left.reference.kind === 'binding'
            ? expression.left
            : expression.right.kind === 'identifier' && expression.right.reference.kind === 'binding'
              ? expression.right
              : undefined;
        if (operand) {
          const ref = operand.reference;
          if (ref.kind === 'binding') nullishUsed.add(ref.binding.id);
        }
      }
      return undefined;
    },
    variable(variable) {
      if (!('binding' in variable) || variable.initializer?.kind !== 'element') return;
      const initializer = variable.initializer;
      const resolvedReceiver = initializer.semantics.receivers.some(
        (receiver) => receiver === 'array' || receiver.endsWith('Array'),
      );
      const inferredReceiver =
        initializer.object.kind === 'identifier' &&
        initializer.object.reference.kind === 'binding' &&
        bindingTypes.get(initializer.object.reference.binding.id)?.kind === 'array';
      if (resolvedReceiver || inferredReceiver) candidates.add(variable.binding.id);
    },
  });
  const result = new Set<string>();
  for (const id of candidates) {
    if (nullishUsed.has(id)) result.add(id);
  }
  return result;
}

function irTypeIncludesUndefinedCpp(type: Readonly<IrType>): boolean {
  if (type.kind === 'undefined') return true;
  if (type.kind === 'union') return type.types.some((member) => member.kind === 'undefined');
  return false;
}

function irFunctionExpressionUsesThisCpp(expression: Readonly<Extract<IrExpression, { kind: 'function' }>>): boolean {
  let usesThis = false;
  const observer = {
    expression(candidate: Readonly<IrExpression>) {
      if (candidate.kind === 'identifier' && candidate.reference.kind === 'this') {
        usesThis = true;
        return false;
      }
      return undefined;
    },
  };
  if (expression.expression) analyzeIrExpressionSubtreeTraversal(expression.expression, observer);
  for (const statement of expression.body) analyzeIrStatementSubtreeTraversal(statement, observer);
  return usesThis;
}

function getIrExpressionClassDeclarationCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrClassDeclaration> | undefined {
  if (expression.kind === 'identifier') {
    if (expression.reference.kind === 'this') return context.currentClass;
    if (expression.reference.kind === 'binding') return context.bindingClasses.get(expression.reference.binding.id);
  }
  if (
    expression.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding'
  ) {
    return context.bindingClasses.get(expression.callee.reference.binding.id);
  }
  return undefined;
}

function getIrExpressionClassAccessorCpp(
  expression: Readonly<IrExpression>,
  name: string,
  accessor: 'get' | 'set',
  context: EmitContext,
): boolean {
  const declaration = getIrExpressionClassDeclarationCpp(expression, context);
  return declaration?.methods.some((method) => method.accessor === accessor && method.name === name) ?? false;
}

function emitAssignmentTargetCpp(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
  }
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    (context.nullableBindingIds.has(expression.reference.binding.id) ||
      context.defaultedParameterIds.has(expression.reference.binding.id))
  ) {
    return emitIdentifierReference(expression.reference, context);
  }
  return emitExpression(expression, context);
}

function getSharedCaptureTargetNameCpp(expression: Readonly<IrExpression>, context: EmitContext): string | undefined {
  return expression.kind === 'identifier' && expression.reference.kind === 'binding'
    ? context.sharedCaptureTargetNames.get(expression.reference.binding.id)
    : undefined;
}

function emitSharedCaptureCellConstructionCpp(type: string, initial: string, context: EmitContext): string {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
    return `flight::make_binding_cell(${type}{${initial}})`;
  }
  context.includes.add('memory');
  return `std::make_shared<${type}>(${initial})`;
}

function emitSharedCaptureAssignmentCpp(
  target: string,
  operator: Extract<IrExpression, { kind: 'assignment' }>['operator'],
  right: string,
  optionalStorage: boolean,
  context: EmitContext,
): string {
  if (operator === '=') {
    return optionalStorage
      ? emitSharedCaptureUpdateCpp(target, `binding_value = ${right};`, 'binding_value.value()')
      : `${target}.rebind(${right})`;
  }
  const bindingValue = optionalStorage ? 'binding_value.value()' : 'binding_value';
  if (operator === '**=') {
    return emitSharedCaptureUpdateCpp(target, `${bindingValue} = flight::power(${bindingValue}, ${right});`);
  }
  if (operator === '>>>=') {
    if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
      return emitSharedCaptureUpdateCpp(
        target,
        `${bindingValue} = flight::unsigned_right_shift(${bindingValue}, ${right});`,
      );
    }
    context.includes.add('cstdint');
    return emitSharedCaptureUpdateCpp(
      target,
      `${bindingValue} = static_cast<double>(static_cast<uint32_t>(static_cast<int32_t>(${bindingValue})) >> static_cast<uint32_t>(${right}));`,
    );
  }
  const bitwiseOperator = getCppBitwiseAssignmentOperator(operator);
  if (bitwiseOperator && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    return emitSharedCaptureUpdateCpp(
      target,
      `${bindingValue} = ${emitBitwiseOperationCpp(bitwiseOperator, bindingValue, right)};`,
    );
  }
  if (operator === '&&=') {
    return emitSharedCaptureUpdateCpp(target, `if (${bindingValue}) ${bindingValue} = ${right};`);
  }
  if (operator === '||=') {
    return emitSharedCaptureUpdateCpp(target, `if (!${bindingValue}) ${bindingValue} = ${right};`);
  }
  if (operator === '??=') {
    return emitSharedCaptureUpdateCpp(
      target,
      `if (!binding_value.has_value()) binding_value = ${right};`,
      'binding_value.value()',
    );
  }
  return emitSharedCaptureUpdateCpp(target, `${bindingValue} ${operator} ${right};`);
}

function emitSharedCaptureUpdateCpp(target: string, mutation: string, returnExpression = 'binding_value'): string {
  return `${target}.update_binding([&](auto& binding_value) { ${mutation} return ${returnExpression}; })`;
}

function emitExpandedAssignmentCpp(left: string, value: string): string {
  return `([&]() { auto&& assignment_target = ${left}; assignment_target = ${value}; return assignment_target; }())`;
}

function emitBitwiseOperationCpp(
  operator: Extract<IrBinaryOperator, '&' | '<<' | '>>' | '^' | '|'>,
  left: string,
  right: string,
): string {
  const functionName =
    operator === '&'
      ? 'bitwise_and'
      : operator === '|'
        ? 'bitwise_or'
        : operator === '^'
          ? 'bitwise_xor'
          : operator === '<<'
            ? 'left_shift'
            : 'signed_right_shift';
  return `flight::${functionName}(${left}, ${right})`;
}

function getCppBitwiseAssignmentOperator(
  operator: Extract<IrExpression, { kind: 'assignment' }>['operator'],
): Extract<IrBinaryOperator, '&' | '<<' | '>>' | '^' | '|'> | undefined {
  if (operator === '&=') return '&';
  if (operator === '|=') return '|';
  if (operator === '^=') return '^';
  if (operator === '<<=') return '<<';
  if (operator === '>>=') return '>>';
  return undefined;
}

function emitLogicalAssignmentCpp(
  left: string,
  operator: Extract<Extract<IrExpression, { kind: 'assignment' }>['operator'], '&&=' | '??=' | '||='>,
  right: string,
): string {
  const condition =
    operator === '&&='
      ? 'assignment_target'
      : operator === '||='
        ? '!assignment_target'
        : '!assignment_target.has_value()';
  const result = operator === '??=' ? 'assignment_target.value()' : 'assignment_target';
  return `([&]() { auto&& assignment_target = ${left}; if (${condition}) assignment_target = ${right}; return ${result}; }())`;
}

function getIrAssignmentTargetTypeCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return getIrExpressionBindingTypeCpp(expression, context);
}

function getIrExpressionBindingTypeCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return expression.kind === 'identifier' && expression.reference.kind === 'binding'
    ? context.bindingTypes.get(expression.reference.binding.id)
    : undefined;
}

function emitOptionalExpressionCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType: Readonly<IrType> | undefined,
): string {
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.get(${emitExpression(expression.index, context)})`;
  }
  if (
    expression.kind === 'property' &&
    expression.absent === 'optionalMember' &&
    expression.object.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression.object, context)
  ) {
    if (!expectedType) {
      emissionError(context, 'an optional indexed member requires contextual result type in C++ emission');
    }
    const payload = emitType(expectedType, context);
    const receiver = `${emitExpression(expression.object.object, context)}.get(${emitExpression(expression.object.index, context)})`;
    context.includes.add('optional');
    return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${receiver}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().${safeCppName(expression.name)}; }())`;
  }
  return emitExpression(expression, context);
}

function assertIrOptionalChainReceiverIsSingleSentinelCpp(type: Readonly<IrType>, context: EmitContext): void {
  const union = getIrUnionTypeCpp(type, context, new Set());
  if (union && getCppUnionRepresentationPlan(union, context).kind === 'dualSentinelVariant') {
    emissionError(context, 'dual-sentinel optional chaining requires presence projection lowering');
  }
}

function assertIrExpressionHasNoDualSentinelOptionalChainCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): void {
  if (expression.kind === 'call') {
    if (expression.semantics.optionalChain) {
      assertIrOptionalChainReceiverIsSingleSentinelCpp(expression.semantics.optionalChain.receiverType, context);
    }
    assertIrExpressionHasNoDualSentinelOptionalChainCpp(expression.callee, context);
    return;
  }
  if (expression.kind === 'element' && expression.semantics.optionalChain) {
    assertIrOptionalChainReceiverIsSingleSentinelCpp(expression.semantics.optionalChain.receiverType, context);
    return;
  }
  if (expression.kind === 'property' && expression.optionalChain) {
    assertIrOptionalChainReceiverIsSingleSentinelCpp(expression.optionalChain.receiverType, context);
  }
}

function emitOptionalCallExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  const semantics = expression.semantics.optionalChain;
  if (!semantics) emissionError(context, 'optional call lacks neutral optional-chain evidence');
  assertIrOptionalChainReceiverIsSingleSentinelCpp(semantics.receiverType, context);
  if (semantics.receiverNullish === 'excluded') {
    return emitExpression({ ...expression, optional: false }, context);
  }
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const callee = emitOptionalChainReceiverCpp(expression.callee, context);
  const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context)).join(', ');
  context.includes.add('optional');
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${callee}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value()(${arguments_}); }())`;
}

function emitOptionalElementExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string {
  const semantics = expression.semantics.optionalChain;
  if (!semantics) emissionError(context, 'optional element access lacks neutral optional-chain evidence');
  assertIrOptionalChainReceiverIsSingleSentinelCpp(semantics.receiverType, context);
  if (semantics.receiverNullish === 'excluded') {
    return emitExpression({ ...expression, optional: false }, context);
  }
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  const index = emitExpression(expression.index, context);
  context.includes.add('optional');
  if (semantics.receiverType.kind === 'union') {
    const receiver = getOptionalPayloadTypeCpp(semantics.receiverType, context);
    if (receiver.kind === 'tuple') {
      const tupleIndex = getElementAccessTupleIndexCpp(expression, context);
      return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return std::get<${String(tupleIndex)}>(optional_chain_receiver.value()); }())`;
    }
    if (receiver.kind === 'array') {
      return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().get(${index}); }())`;
    }
  }
  emissionError(context, 'optional element access requires nullable array or fixed-tuple receiver evidence');
}

function emitOptionalPropertyExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string {
  const semantics = expression.optionalChain;
  if (!semantics) emissionError(context, 'optional property access lacks neutral optional-chain evidence');
  assertIrOptionalChainReceiverIsSingleSentinelCpp(semantics.receiverType, context);
  const indexesRuntimeCollection =
    expression.object.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression.object, context);
  if (semantics.receiverNullish === 'excluded' && !indexesRuntimeCollection) {
    return emitExpression({ ...expression, optional: false }, context);
  }
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  const memberOperator = hasFlightReferenceRepresentationCpp(
    emitOptionalChainPayloadIrTypeCpp(semantics.receiverType, context),
    context,
  )
    ? '->'
    : '.';
  let projected: string;
  if (expression.member) {
    const binding = getCompilerCppAmbientMemberBinding(expression.member, getCppRuntimeProfile(context.options));
    if (binding?.kind === 'sizeMethod') {
      projected = `static_cast<double>(optional_chain_receiver.value()${memberOperator}size())`;
    } else if (binding?.kind === 'property') {
      projected = `optional_chain_receiver.value()${memberOperator}${binding.targetName}`;
    } else {
      projected = `optional_chain_receiver.value()${memberOperator}${safeCppName(expression.name)}`;
    }
  } else if (getIrExpressionClassAccessorCpp(expression.object, expression.name, 'get', context)) {
    projected = `optional_chain_receiver.value()${memberOperator}${safeCppName(expression.name)}()`;
  } else {
    projected = `optional_chain_receiver.value()${memberOperator}${safeCppName(expression.name)}`;
  }
  context.includes.add('optional');
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${projected}; }())`;
}

function emitOptionalChainReceiverCpp(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.get(${emitExpression(expression.index, context)})`;
  }
  return emitExpression(expression, context);
}

function emitOptionalChainPayloadTypeCpp(type: Readonly<IrType>, context: EmitContext): string {
  return emitType(emitOptionalChainPayloadIrTypeCpp(type, context), context);
}

function emitOptionalChainPayloadIrTypeCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> {
  return hasIrTypeAbsentMember(type) ? getOptionalPayloadTypeCpp(type, context) : type;
}

function getOptionalPayloadTypeCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> {
  if (type.kind !== 'union') emissionError(context, 'optional chain receiver requires a nullable union type');
  const concrete = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  if (concrete.length !== 1) {
    emissionError(context, 'optional chain receiver requires one concrete nullable union member');
  }
  return concrete[0]!;
}

function emitOptionalTypeCpp(type: string, optional: boolean, context: EmitContext): string {
  if (!optional) return type;
  context.includes.add('optional');
  return `std::optional<${type}>`;
}

function hasIndexedRuntimeReceiverCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): boolean {
  if (expression.semantics.receivers.some((receiver) => receiver === 'array' || receiver.endsWith('Array'))) {
    return true;
  }
  if (expression.object.kind !== 'identifier' || expression.object.reference.kind !== 'binding') return false;
  const type = context.bindingTypes.get(expression.object.reference.binding.id);
  return type?.kind === 'array';
}

function hasSharedReferentRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const plan = context.referenceRepresentationPlanner.plan(type, context.module);
  return plan.kind === 'represented' && plan.identity.identity === 'reference';
}

function hasFlightReferenceRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const plan = context.referenceRepresentationPlanner.plan(type, context.module);
  return plan.kind === 'represented' && plan.valueRepresentation === 'flightReference';
}

function getExpectedReturnTypeCpp(context: EmitContext): Readonly<IrType> | undefined {
  if (!context.enclosingReturnType) return undefined;
  return context.async ? getIrTaskAwaitedTypeCpp(context.enclosingReturnType, context) : context.enclosingReturnType;
}

function collectDefaultedParameterIdsCpp(parameters: readonly IrParameter[]): ReadonlySet<string> {
  return new Set(parameters.filter((parameter) => parameter.initializer).map((parameter) => parameter.binding.id));
}

function emitParameterInitializersCpp(parameters: readonly IrParameter[], context: EmitContext): string[] {
  const parameterBindingIds = new Set(parameters.map((parameter) => parameter.binding.id));
  const initializedSharedCaptureTargetNames = new Map(
    [...context.sharedCaptureTargetNames].filter(([bindingId]) => !parameterBindingIds.has(bindingId)),
  );
  const lines: string[] = [];
  for (const parameter of parameters) {
    const parameterTargetName = getBindingTargetName(parameter.binding, context);
    if (parameter.initializer) {
      lines.push(
        `${parameterTargetName} = ${parameterTargetName}.value_or(${emitExpression(parameter.initializer, { ...context, sharedCaptureTargetNames: initializedSharedCaptureTargetNames }, parameter.type)});`,
      );
    }
    const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(parameter.binding.id);
    if (!sharedCaptureTargetName) continue;
    const parameterType = emitType(parameter.type, context);
    const sharedType = emitOptionalTypeCpp(parameterType, parameter.optional, context);
    lines.push(
      `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(sharedType, parameterTargetName, context)};`,
    );
    initializedSharedCaptureTargetNames.set(parameter.binding.id, sharedCaptureTargetName);
  }
  return lines;
}

function hasSharedCaptureParameterCpp(parameters: readonly IrParameter[], context: EmitContext): boolean {
  return parameters.some((parameter) => context.sharedCaptureTargetNames.has(parameter.binding.id));
}

function emitImplicitCompletionCpp(statements: readonly IrStatement[], context: EmitContext): string[] {
  if (statementsDefinitelyCompleteCpp(statements)) return [];
  const returnType = getExpectedReturnTypeCpp(context);
  if (!returnType) return [];
  const voidReturn = returnType.kind === 'primitive' && returnType.name === 'void';
  if (!context.async && voidReturn) return [];
  if (hasIrTypeAbsentMember(returnType)) {
    return [`${context.async ? 'co_return' : 'return'} ${emitUndefinedWithExpectedTypeCpp(returnType, context)};`];
  }
  if (context.async && voidReturn) return ['co_return;'];
  context.includes.add('stdexcept');
  return context.async
    ? ['co_await std::suspend_never{};', 'throw std::logic_error("Flight async function completed without a value");']
    : ['throw std::logic_error("Flight function completed without a value");'];
}

function statementsDefinitelyCompleteCpp(statements: readonly IrStatement[]): boolean {
  return statements.some(statementDefinitelyCompletesCpp);
}

function statementDefinitelyCompletesCpp(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'return':
    case 'throw':
      return true;
    case 'block':
      return statementsDefinitelyCompleteCpp(statement.statements);
    case 'if':
      return Boolean(
        statement.otherwise &&
        statementDefinitelyCompletesCpp(statement.consequent) &&
        statementDefinitelyCompletesCpp(statement.otherwise),
      );
    case 'try':
      if (statement.finallyBody && statementDefinitelyCompletesCpp(statement.finallyBody)) return true;
      return Boolean(
        statement.catchClause &&
        statementDefinitelyCompletesCpp(statement.tryBody) &&
        statementDefinitelyCompletesCpp(statement.catchClause.body),
      );
    default:
      return false;
  }
}

function emitParameter(parameter: Readonly<IrParameter>, context: EmitContext): string {
  const name = getBindingTargetName(parameter.binding, context);
  const type = parameter.type ? emitType(parameter.type, context) : 'auto';
  if (parameter.optional) {
    context.includes.add('optional');
    return `std::optional<${type}> ${name} = std::nullopt`;
  }
  if (parameter.rest) {
    return `${type} ${name}`;
  }
  return `${type} ${name}`;
}

function emitImports(module: Readonly<IrModule>, context: EmitContext): string[] {
  const specifiers = [
    ...module.imports.map((item) => item.specifier),
    ...module.exports.flatMap((item) =>
      item.kind === 'all' || item.kind === 'namespace' || item.kind === 'reexport' ? [item.specifier] : [],
    ),
  ];
  return [...new Set(specifiers)].flatMap((specifier) => {
    const targetModule = getCppResolvedImportModule(specifier, context);
    if (targetModule) return [getCppModuleIncludeDirective(targetModule, context.options)];
    if (!specifier.startsWith('.')) return [];
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(context.module.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
    );
    const resolved = /\.tsx?$/u.test(target) ? target : `${target}.ts`;
    const fileName = convertSourcePathToCppFileName(resolved);
    if (!fileName) return [];
    return [`#include "${fileName}.hpp"`];
  });
}

function getCppModuleFileName(module: Readonly<IrModule>): string {
  return convertSourcePathToCppFileName(module.source) ?? `_internal_${snakeCase(module.name)}`;
}

function getCppModuleFilePath(module: Readonly<IrModule>, options: Readonly<CppCompilerBackendOptions>): string {
  const fileName = `${getCppModuleFileName(module)}.hpp`;
  const includePrefix = getCppCompilerPackageIncludePrefix(module.packageName, options.packageTargets);
  return includePrefix ? `${includePrefix}/${fileName}` : fileName;
}

function getCppModuleIncludeDirective(
  module: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions>,
): string {
  const includePrefix = getCppCompilerPackageIncludePrefix(module.packageName, options.packageTargets);
  const path = `${includePrefix ? `${includePrefix}/` : ''}${getCppModuleFileName(module)}.hpp`;
  return includePrefix ? `#include <${path}>` : `#include "${path}"`;
}

function getCppIncludeDirectivePath(directive: string): string {
  return directive.slice('#include '.length + 1, -1);
}

function getCppResolvedImportModule(specifier: string, context: EmitContext): Readonly<IrModule> | undefined {
  const matching = context.moduleResolution?.edges.filter((edge) => edge.specifier === specifier) ?? [];
  const exact = matching.filter(
    (edge) => edge.importer && isCppCompilerModuleIdentityEqual(edge.importer, context.module),
  );
  const targets = exact.length > 0 ? exact : matching.filter((edge) => !edge.importer);
  if (targets.length === 1) {
    const target = targets[0]!.target;
    return context.sourceModules.find(
      (module) =>
        module.packageName === target.packageName &&
        path.posix.normalize(module.source) === path.posix.normalize(target.source),
    );
  }
  if (!specifier.startsWith('.')) return undefined;
  const source = path.posix.normalize(
    path.posix.join(path.posix.dirname(context.module.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
  );
  const candidates = new Set([source, `${source}.ts`, `${source}/index.ts`]);
  return context.sourceModules.find(
    (module) =>
      module.packageName === context.module.packageName && candidates.has(path.posix.normalize(module.source)),
  );
}

function isCppCompilerModuleIdentityEqual(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): boolean {
  return (
    left.packageName === right.packageName &&
    path.posix.normalize(left.source) === path.posix.normalize(right.source) &&
    left.name === right.name
  );
}

function emitReexportsCpp(module: Readonly<IrModule>, context: EmitContext): string[] {
  return module.exports.flatMap((exported) => {
    if (exported.kind === 'namespace') {
      const targetModule = getCppResolvedImportModule(exported.specifier, context);
      if (!targetModule) emissionError(context, `namespace reexport ${exported.exported} requires module resolution`);
      return [
        `namespace ${safeCppName(exported.exported)} = ${getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets)};`,
      ];
    }
    if (exported.kind === 'all') {
      const targetModule = getCppResolvedImportModule(exported.specifier, context);
      if (targetModule && targetModule.packageName !== module.packageName) {
        emissionError(context, 'cross-package export-all requires explicit named reexports for C++');
      }
      return [];
    }
    if (exported.kind !== 'reexport') return [];
    const targetModule = getCppResolvedImportModule(exported.specifier, context);
    const targetName = targetModule
      ? getCppResolvedExportTargetName(targetModule, exported.imported)
      : pascalCase(exported.imported);
    const qualified =
      targetModule && targetModule.packageName !== module.packageName
        ? `${getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets)}::${targetName}`
        : targetName;
    if (exported.typeOnly) {
      return exported.exported === exported.imported && targetModule?.packageName === module.packageName
        ? []
        : [`using ${safeCppTypeName(exported.exported)} = ${qualified};`];
    }
    if (exported.exported !== exported.imported) {
      emissionError(context, `renamed value reexport ${exported.exported} requires callable or storage alias lowering`);
    }
    return targetModule && targetModule.packageName !== module.packageName ? [`using ${qualified};`] : [];
  });
}

function emitTypeParameters(parameters: readonly IrTypeParameter[], context: EmitContext): string {
  if (parameters.length === 0) return '';
  return `<${parameters.map((parameter) => `typename ${context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name)}`).join(', ')}>`;
}

function emitIdentifierReference(
  reference: Readonly<IrExpression & { kind: 'identifier' }>['reference'],
  context: EmitContext,
): string {
  if (reference.kind === 'ambient') {
    addCppExternalBindingHeaders(reference.name, 'value', context);
    const target = getCompilerRuntimeExternalSymbolTargetCpp(
      reference.name,
      'value',
      getCppRuntimeProfile(context.options),
      context.options.externalBindings,
    );
    if (target) return target;
    return reference.name;
  }
  if (reference.kind === 'this') return 'this';
  if (reference.kind === 'super') {
    const base = context.currentClass?.extends;
    if (base && base.kind === 'named' && base.reference.kind === 'binding') {
      return context.targetNames.get(base.reference.binding.id) ?? safeCppName(base.reference.binding.name);
    }
    return 'super';
  }
  const imported = getCppImportedBindingTargetName(reference.binding.id, [], context);
  if (imported) return imported;
  return emitBindingValueCpp(reference.binding, context);
}

function emitBindingValueCpp(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(binding.id);
  if (sharedCaptureTargetName) {
    const value =
      getCppRuntimeProfile(context.options) === 'flight-cpp'
        ? `${sharedCaptureTargetName}.read_binding()`
        : `(*${sharedCaptureTargetName})`;
    return context.uninitializedCaptureStorageBindingIds.has(binding.id) ? `${value}.value()` : value;
  }
  return context.targetNames.get(binding.id) ?? safeCppName(binding.name);
}

function collectIrModuleUninitializedBindingIdsCpp(module: Readonly<IrModule>): ReadonlySet<string> {
  const bindingIds = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && variable.initialValue === 'uninitialized') {
        bindingIds.add(variable.binding.id);
      }
    },
  });
  return bindingIds;
}

function isSuperAccess(expression: Readonly<IrExpression>): boolean {
  return expression.kind === 'identifier' && expression.reference.kind === 'super';
}

function isThisAccess(expression: Readonly<IrExpression>): boolean {
  return expression.kind === 'identifier' && expression.reference.kind === 'this';
}

function memberOp(object: Readonly<IrExpression>, context: EmitContext): string {
  if (isSuperAccess(object)) return '::';
  if (isThisAccess(object)) return '->';
  const type = getIrExpressionTypeEvidenceCpp(object, context);
  return type && hasFlightReferenceRepresentationCpp(type, context) ? '->' : '.';
}

function emitLiteralWithExpectedTypeCpp(
  value: boolean | null | number | string,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
): string {
  if (value !== null) return emitLiteral(value, context);
  const union = expectedType ? getIrUnionTypeCpp(expectedType, context, new Set()) : undefined;
  if (!union) return emitLiteral(value, context);
  const plan = getCppUnionRepresentationPlan(union, context);
  if (plan.kind === 'dualSentinelVariant') {
    if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::null';
    context.includes.add('cstddef');
    return 'nullptr';
  }
  if (plan.sentinels.null === 'optionalAbsence') {
    context.includes.add('optional');
    return 'std::nullopt';
  }
  return emitLiteral(value, context);
}

function emitLiteral(value: boolean | null | number | string, context: EmitContext): string {
  if (value === null) return 'nullptr';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'std::numeric_limits<double>::quiet_NaN()';
    if (!Number.isFinite(value))
      return value > 0 ? 'std::numeric_limits<double>::infinity()' : '-std::numeric_limits<double>::infinity()';
    const text = String(value);
    return /[.eE]/u.test(text) ? text : `${text}.0`;
  }
  const literal = JSON.stringify(value);
  return getCppRuntimeProfile(context.options) === 'flight-cpp' ? `flight::String(${literal})` : literal;
}

function emitUndefinedWithExpectedTypeCpp(expectedType: Readonly<IrType> | undefined, context: EmitContext): string {
  const union = expectedType ? getIrUnionTypeCpp(expectedType, context, new Set()) : undefined;
  if (union) {
    const plan = getCppUnionRepresentationPlan(union, context);
    if (plan.kind === 'dualSentinelVariant') {
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::undefined';
      context.includes.add('variant');
      return 'std::monostate{}';
    }
  }
  context.includes.add('optional');
  return 'std::nullopt';
}

function emitStringConcatenation(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') context.includes.add('string');
  const parts = collectStringParts(expression, context);
  return parts.join(' + ');
}

function emitCppStringType(context: EmitContext): string {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::String';
  context.includes.add('string');
  return 'std::string';
}

function emitCppTypeArguments(types: readonly Readonly<IrType>[], context: EmitContext): string {
  return types.length === 0 ? '' : `<${types.map((type) => emitType(type, context)).join(', ')}>`;
}

function collectStringParts(expression: Readonly<IrExpression>, context: EmitContext): string[] {
  if (
    expression.kind === 'binary' &&
    expression.operator === '+' &&
    expression.semantics.left.flow === 'string' &&
    expression.semantics.right.flow === 'string'
  ) {
    return [...collectStringParts(expression.left, context), ...collectStringParts(expression.right, context)];
  }
  return [emitExpression(expression, context)];
}

function emitTupleSpreadExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'tupleSpread' }>>,
  context: EmitContext,
): string {
  context.includes.add('tuple');
  const declarations: string[] = [];
  const elements: string[] = [];
  let resultIndex = 0;
  for (const segment of expression.segments) {
    if (segment.kind === 'element') {
      const target = expression.type.elements[resultIndex]!;
      if (!segment.element.expression) {
        context.includes.add('optional');
        elements.push('std::nullopt');
      } else {
        const name = getGeneratedTargetName('tuple_spread_element', context);
        declarations.push(`auto ${name} = ${emitExpression(segment.element.expression, context)};`);
        if (target.optional) {
          context.includes.add('optional');
          elements.push(`std::make_optional(${name})`);
        } else {
          elements.push(name);
        }
      }
      resultIndex += 1;
      continue;
    }
    const name = getGeneratedTargetName('tuple_spread_value', context);
    declarations.push(`auto ${name} = ${emitExpression(segment.expression, context)};`);
    segment.type.elements.forEach((element, offset) => {
      const value = `std::get<${String(offset)}>(${name})`;
      const target = expression.type.elements[resultIndex + offset]!;
      if (target.optional && !element.optional) {
        context.includes.add('optional');
        elements.push(`std::make_optional(${value})`);
      } else {
        elements.push(value);
      }
    });
    resultIndex += segment.type.elements.length;
  }
  const tuple = `std::make_tuple(${elements.join(', ')})`;
  return `([&]() { ${declarations.join(' ')} return ${tuple}; })()`;
}

function emitAssignmentOperator(operator: string): string {
  if (operator === '**=') return '=';
  if (operator === '>>>=') return '=';
  return operator;
}

function emitBinaryOperator(
  operator: IrBinaryOperator,
  _semantics: Readonly<IrBinaryOperatorSemantics>,
  _context: EmitContext,
): string {
  if (operator === '===' || operator === '==') return '==';
  if (operator === '!==' || operator === '!=') return '!=';
  if (operator === '&&') return '&&';
  if (operator === '||') return '||';
  return operator;
}

function emitPrefixUnaryOperator(operator: string): string {
  if (operator === 'typeof') return 'typeid';
  if (operator === 'void') return '(void)';
  return operator;
}

function emitPostfixUnaryOperator(operator: string): string {
  return operator;
}

function getTypeReferenceTargetName(type: Readonly<IrType & { kind: 'named' }>, context: EmitContext): string {
  if (type.reference.kind === 'ambient') {
    addCppExternalBindingHeaders(type.reference.name, 'type', context);
    const target = getCompilerRuntimeExternalSymbolTargetCpp(
      type.reference.name,
      'type',
      getCppRuntimeProfile(context.options),
      context.options.externalBindings,
    );
    if (target) return target;
    return type.reference.name;
  }
  const imported = getCppImportedBindingTargetName(type.reference.binding.id, type.reference.path, context);
  if (imported) return imported;
  return context.targetNames.get(type.reference.binding.id) ?? pascalCase(type.reference.binding.name);
}

function getCppImportedBindingTargetName(
  bindingId: string,
  referencePath: readonly string[],
  context: EmitContext,
): string | undefined {
  for (const importItem of context.module.imports) {
    const importedBinding = importItem.bindings.find((candidate) => candidate.binding.id === bindingId);
    if (!importedBinding) continue;
    const importedName = importedBinding.imported === '*' ? referencePath[0] : importedBinding.imported;
    if (!importedName) return undefined;
    const targetModule = getCppResolvedImportModule(importItem.specifier, context);
    if (!targetModule) {
      return context.targetNames.get(bindingId) ?? safeCppName(importedBinding.binding.name);
    }
    const targetName = getCppResolvedExportTargetName(targetModule, importedName);
    if (targetModule.packageName === context.module.packageName) return targetName;
    return `${getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets)}::${targetName}`;
  }
  return undefined;
}

function getCppResolvedExportTargetName(module: Readonly<IrModule>, exportedName: string): string {
  const directBindingId = module.declarations.flatMap((declaration) =>
    'binding' in declaration && declaration.exported && declaration.binding.name === exportedName
      ? [declaration.binding.id]
      : [],
  )[0];
  const local = module.exports.find((exported) => exported.kind === 'local' && exported.exported === exportedName);
  const bindingId = directBindingId ?? (local?.kind === 'local' ? local.binding.id : undefined);
  if (!bindingId) return pascalCase(exportedName);
  return createCppTargetNameMap(module).get(bindingId) ?? pascalCase(exportedName);
}

function getBindingTargetName(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  return context.targetNames.get(binding.id) ?? safeCppName(binding.name);
}

function getCppRuntimeProfile(options: Readonly<CppCompilerBackendOptions>): CppCompilerRuntimeProfile {
  return options.runtimeProfile ?? 'standard-library';
}

function getIrTaskAwaitedTypeCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> {
  if (type.kind !== 'named' || type.reference.kind !== 'ambient' || type.reference.name !== 'Promise') {
    emissionError(context, 'an async function must return a task type');
  }
  const awaited = type.typeArguments[0];
  if (type.typeArguments.length !== 1 || !awaited) {
    emissionError(context, 'a task type requires one awaited type argument');
  }
  return awaited;
}

function getElementAccessTupleIndexCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): number {
  if (
    expression.semantics.receivers.length !== 1 ||
    expression.index.kind !== 'literal' ||
    typeof expression.index.value !== 'number' ||
    !Number.isSafeInteger(expression.index.value) ||
    expression.index.value < 0
  ) {
    emissionError(context, 'tuple projection requires one statically known nonnegative integer index');
  }
  return expression.index.value;
}

function getGeneratedTargetName(base: string, context: EmitContext): string {
  let candidate = safeCppName(base);
  let counter = 2;
  while (context.generatedNames.has(candidate)) {
    candidate = `${safeCppName(base)}_${String(counter)}`;
    counter += 1;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function getIrExpressionEnumDeclaration(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrEnumDeclaration> | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  return context.module.declarations.find(
    (candidate) =>
      candidate.kind === 'enum' &&
      expression.reference.kind === 'binding' &&
      candidate.binding.id === expression.reference.binding.id,
  ) as IrEnumDeclaration | undefined;
}

function assertRuntimeExternalSymbolBindingsCpp(
  module: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions> = {},
): void {
  const completeness = analyzeCompilerRuntimeExternalSymbolCompleteness(
    collectIrModulesRuntimeExternalSymbolIdentities([module]),
    createCompilerRuntimeExternalSymbolBindingPlanCpp(getCppRuntimeProfile(options), options.externalBindings),
  );
  if (completeness.kind === 'complete') return;
  const problems = [
    completeness.missingExternalSymbols.length > 0
      ? `missing: ${completeness.missingExternalSymbols.map((identity) => `${identity.sourceName}[${identity.space}]`).join(', ')}`
      : undefined,
    completeness.duplicateExternalSymbols.length > 0
      ? `duplicate: ${completeness.duplicateExternalSymbols.map((identity) => `${identity.sourceName}[${identity.space}]`).join(', ')}`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  throw createBackendEmissionFailure(
    'cpp',
    module,
    `runtime external symbol binding plan is incomplete (${problems.join('; ')})`,
  );
}

function addCppExternalBindingHeaders(sourceName: string, space: 'type' | 'value', context: EmitContext): void {
  for (const header of getCompilerExternalBindingHeadersCpp(sourceName, space, context.options.externalBindings)) {
    context.includes.add(header);
  }
}

function generateUniqueName(base: string, context: EmitContext): string {
  let candidate = base;
  let suffix = 0;
  while (context.generatedNames.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function generateAnonymousStructName(properties: readonly { readonly name: string }[], context: EmitContext): string {
  const base = properties.map((property) => snakeCase(property.name)).join('_');
  let candidate = base || 'anonymous';
  let suffix = 0;
  while (context.generatedNames.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function safeCppName(name: string): string {
  const snake = snakeCase(name);
  return isCppCompilerKeyword(snake) ? `${snake}_` : snake;
}

function safeCppTypeName(name: string): string {
  return pascalCase(name);
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

function pascalCase(value: string): string {
  return value
    .replace(/(?:^|[_\-\s])([a-zA-Z])/gu, (_, letter: string) => letter.toUpperCase())
    .replace(/[^A-Za-z0-9]/gu, '');
}

function extractSuperCallCpp(body: readonly Readonly<IrStatement>[], context: EmitContext): string | undefined {
  for (const statement of body) {
    if (
      statement.kind !== 'expression' ||
      statement.expression.kind !== 'call' ||
      statement.expression.callee.kind !== 'identifier' ||
      statement.expression.callee.reference.kind !== 'super'
    ) {
      continue;
    }
    const callee = statement.expression.callee;
    const baseName = emitIdentifierReference(callee.reference, context);
    const args = statement.expression.arguments.map((argument: Readonly<IrExpression>) =>
      emitExpression(argument, context),
    );
    return `${baseName}(${args.join(', ')})`;
  }
  return undefined;
}

function getIrClassInheritedMethodNamesCpp(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): ReadonlySet<string> {
  const names = new Set<string>();
  let base = declaration.extends;
  const visited = new Set<string>();
  while (
    base &&
    base.kind === 'named' &&
    base.reference.kind === 'binding' &&
    !visited.has(base.reference.binding.id)
  ) {
    visited.add(base.reference.binding.id);
    const reference = base.reference;
    const target = context.module.declarations.find(
      (candidate) => candidate.kind === 'class' && candidate.binding.id === reference.binding.id,
    );
    if (target?.kind !== 'class') break;
    for (const method of target.methods) {
      names.add(method.name);
    }
    base = target.extends;
  }
  return names;
}

function getIrClassInheritedAbstractFieldNamesCpp(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): ReadonlySet<string> {
  const names = new Set<string>();
  let base = declaration.extends;
  const visited = new Set<string>();
  while (
    base &&
    base.kind === 'named' &&
    base.reference.kind === 'binding' &&
    !visited.has(base.reference.binding.id)
  ) {
    visited.add(base.reference.binding.id);
    const reference = base.reference;
    const target = context.module.declarations.find(
      (candidate) => candidate.kind === 'class' && candidate.binding.id === reference.binding.id,
    );
    if (target?.kind !== 'class') break;
    for (const field of target.fields) {
      if (field.abstract) names.add(field.name);
    }
    base = target.extends;
  }
  return names;
}

function hasIrModuleSubclassCpp(declaration: Readonly<IrClassDeclaration>, context: EmitContext): boolean {
  return context.module.declarations.some(
    (candidate) =>
      candidate.kind === 'class' &&
      candidate.extends?.kind === 'named' &&
      candidate.extends.reference.kind === 'binding' &&
      candidate.extends.reference.binding.id === declaration.binding.id,
  );
}

function isSuperCallStatement(statement: Readonly<IrStatement>): boolean {
  return (
    statement.kind === 'expression' &&
    statement.expression.kind === 'call' &&
    statement.expression.callee.kind === 'identifier' &&
    statement.expression.callee.reference.kind === 'super'
  );
}

function emissionError(context: EmitContext, message: string): never {
  throw createBackendEmissionFailure('cpp', context.module, message);
}

const cppOptionalArrayMethods = new Set(['shift', 'pop']);

const cppMathSpreadFoldTargets: Readonly<Record<string, { algorithm: string; identity: string; runtime: string }>> = {
  max: {
    algorithm: 'std::max_element',
    identity: '-std::numeric_limits<double>::infinity()',
    runtime: 'flight::maximum',
  },
  min: {
    algorithm: 'std::min_element',
    identity: 'std::numeric_limits<double>::infinity()',
    runtime: 'flight::minimum',
  },
};
