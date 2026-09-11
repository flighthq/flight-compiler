import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { normalizeCompilerStructuralValueCanonical } from '../../compiler-canonical-form/src/index.js';
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
  isCompilerLoweringFailure,
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
  CompilerLoweringPass,
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
  IrObjectTypeProperty,
  IrParameter,
  IrStatement,
  IrSwitchCase,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrUnionMemberTestEvidence,
  IrValueNameReference,
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
import { getIrHomogeneousTupleElementTypeCpp } from './cppTupleRepresentation.js';
import { createCppUnionRepresentationPlan } from './cppUnionRepresentationPlan.js';

interface AnonymousStruct {
  name: string;
  properties: readonly { name: string; optional: boolean; type: string }[];
  typeParameters: readonly string[];
}

interface CppVariantRepresentation {
  alternatives: readonly Readonly<{ members: readonly IrType[]; runtimeType: IrType; targetType: string }>[];
  direct: boolean;
}

type CppDirectBindingOwner = Readonly<{ declaration: IrDeclaration; module: IrModule }>;
type CppImportBindingOwner = Readonly<{ imported: string; module: IrModule; specifier: string }>;

interface EmitContext {
  anonymousStructs: Map<string, AnonymousStruct>;
  anonymousStructTypeParameters: readonly IrTypeParameter[];
  arrayElementBindingIds: ReadonlySet<string>;
  async?: boolean | undefined;
  bindingClasses: ReadonlyMap<string, Readonly<IrClassDeclaration>>;
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  currentClass?: Readonly<IrClassDeclaration> | undefined;
  defaultedParameterIds: ReadonlySet<string>;
  denseArrayLengthBindingIds: ReadonlySet<string>;
  directBindingOwners: ReadonlyMap<string, CppDirectBindingOwner | null>;
  importBindingOwners: ReadonlyMap<string, CppImportBindingOwner | null>;
  finallyReturnVar?: string | undefined;
  includes: Set<string>;
  module: Readonly<IrModule>;
  namespaceScope: boolean;
  nullableBindingIds: ReadonlySet<string>;
  narrowedBindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  options: Readonly<CppCompilerBackendOptions>;
  preservedInitializerTypes: Map<string, Readonly<IrType>>;
  referenceRepresentationPlanner: CompilerCppReferenceRepresentationPlanner;
  returnsAbsent: boolean;
  sharedCaptureTargetNames: ReadonlyMap<string, string>;
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
      const interfaceInheritancePass = createCompilerLoweringPassInterfaceInheritance(modules, moduleResolution);
      const directBindingOwners = createCppDirectBindingOwners(modules);
      const importBindingOwners = createCppImportBindingOwners(modules);
      return Object.freeze({
        emitModule(module: Readonly<IrModule>) {
          return [
            emitIrModuleCppWithContext(
              module,
              options,
              modules,
              moduleResolution,
              referenceRepresentationPlanner,
              interfaceInheritancePass,
              directBindingOwners,
              importBindingOwners,
            ),
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
  interfaceInheritancePass?: Readonly<CompilerLoweringPass> | undefined,
  directBindingOwners?: ReadonlyMap<string, CppDirectBindingOwner | null> | undefined,
  importBindingOwners?: ReadonlyMap<string, CppImportBindingOwner | null> | undefined,
): EmittedFile {
  let module: IrModule;
  try {
    module = lowerIrModuleWithCompilerPasses(sourceModule, [
      createCompilerLoweringPassExtraArgumentErasure(),
      createCompilerLoweringPassAwaitConditionHoisting(),
      createCompilerLoweringPassCatchAwaitHoisting(),
      createCompilerLoweringPassBindingPattern(),
      createCompilerLoweringPassVariableHoisting(),
      createCompilerLoweringPassCStyleFor(),
      interfaceInheritancePass ?? createCompilerLoweringPassInterfaceInheritance(sourceModules, moduleResolution),
      createCompilerLoweringPassSwitchFallthrough(),
      createCompilerLoweringPassSwitchSuspension(),
    ]);
  } catch (error) {
    if (isCompilerLoweringFailure(error) && error.code === 'unsupported-ir') {
      throw createBackendEmissionFailure('cpp', sourceModule, error.message);
    }
    throw error;
  }
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
    anonymousStructTypeParameters: [],
    arrayElementBindingIds: collectIrModuleArrayElementBindingIdsCpp(module, bindingTypes),
    bindingClasses: collectIrModuleBindingClassesCpp(module, bindingTypes),
    bindingTypes,
    defaultedParameterIds: new Set(),
    denseArrayLengthBindingIds: collectIrModuleDenseArrayLengthBindingIdsCpp(sourceModule),
    directBindingOwners: directBindingOwners ?? createCppDirectBindingOwners(sourceModules),
    importBindingOwners: importBindingOwners ?? createCppImportBindingOwners(sourceModules),
    includes: new Set<string>(),
    module,
    namespaceScope: true,
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    narrowedBindingTypes: new Map(),
    options,
    preservedInitializerTypes: new Map(),
    referenceRepresentationPlanner:
      referenceRepresentationPlanner ??
      (moduleResolution
        ? createIrTypeReferenceRepresentationPlannerCpp(sourceModules, moduleResolution)
        : createIrTypeReferenceRepresentationPlannerCpp(sourceModules)),
    returnsAbsent: false,
    sharedCaptureTargetNames,
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
  const declarations = orderIrModuleDeclarationsCpp(module)
    .filter((declaration) => declaration.kind !== 'function' || !declaration.namespaceMember)
    .map((declaration) => {
      const existingAnonymousStructs = new Set(context.anonymousStructs.keys());
      const lines = emitDeclaration(declaration, context);
      const anonymousStructs = [...context.anonymousStructs]
        .filter(([key]) => !existingAnonymousStructs.has(key))
        .map(([, struct]) => struct);
      const anonymousStructLines = anonymousStructs.flatMap((struct) => [
        '',
        ...emitAnonymousStructCpp(struct, context),
      ]);
      return { anonymousStructLines, lines };
    });
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
  if (reexports.length > 0) lines.push('', ...reexports);
  declarations.forEach((declaration) => {
    lines.push(...declaration.anonymousStructLines);
    lines.push('', ...declaration.lines);
  });
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

function emitAnonymousStructCpp(struct: Readonly<AnonymousStruct>, context: EmitContext): string[] {
  const lines: string[] = [];
  if (struct.typeParameters.length > 0) {
    lines.push(`template <${struct.typeParameters.map((parameter) => `typename ${parameter}`).join(', ')}>`);
  }
  lines.push(
    `struct ${struct.name}${getCppRuntimeProfile(context.options) === 'flight-cpp' ? ' : public flight::ReferenceEnabled' : ''} {`,
  );
  for (const property of struct.properties) {
    lines.push(`  ${emitOptionalTypeCpp(property.type, property.optional, context)} ${property.name};`);
  }
  lines.push('};');
  return lines;
}

function emitClass(declaration: Readonly<IrClassDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    anonymousStructTypeParameters: mergeIrTypeParametersCpp(
      outer.anonymousStructTypeParameters,
      declaration.typeParameters,
    ),
    currentClass: declaration,
  };
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
      namespaceScope: false,
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
      anonymousStructTypeParameters: mergeIrTypeParametersCpp(
        context.anonymousStructTypeParameters,
        method.typeParameters,
      ),
      async: method.async,
      defaultedParameterIds: collectDefaultedParameterIdsCpp(method.parameters),
      enclosingReturnType: method.returns,
      namespaceScope: false,
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
  const namespaceFunctions = getIrEnumNamespaceFunctionsCpp(declaration, context);
  if (namespaceFunctions.length > 0) {
    if (allStringValues) {
      emissionError(context, `string enum ${declaration.binding.name} value namespace requires wrapper lowering`);
    }
    return emitNumericEnumNamespaceWrapperCpp(declaration, namespaceFunctions, context);
  }
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

function getIrEnumNamespaceFunctionsCpp(
  declaration: Readonly<IrEnumDeclaration>,
  context: EmitContext,
): readonly Readonly<IrFunctionDeclaration>[] {
  return context.module.declarations.filter(
    (candidate): candidate is IrFunctionDeclaration =>
      candidate.kind === 'function' &&
      candidate.namespaceMember?.kind === 'binding' &&
      candidate.namespaceMember.binding.id === declaration.binding.id &&
      candidate.namespaceMember.path.length === 1,
  );
}

function emitNumericEnumNamespaceWrapperCpp(
  declaration: Readonly<IrEnumDeclaration>,
  namespaceFunctions: readonly Readonly<IrFunctionDeclaration>[],
  context: EmitContext,
): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const lines = [
    `struct ${name} {`,
    '  double value;',
    `  constexpr ${name}() : value(0.0) {}`,
    `  constexpr ${name}(double source) : value(source) {}`,
    '  constexpr operator double() const noexcept { return value; }',
  ];
  for (const member of declaration.members) {
    if (typeof member.value !== 'number' || !Number.isSafeInteger(member.value)) {
      emissionError(
        context,
        `numeric enum member ${declaration.binding.name}.${member.name} requires an integer value`,
      );
    }
    lines.push(`  inline static constexpr double ${safeCppTypeName(member.name)} = ${String(member.value)}.0;`);
  }
  for (const namespaceFunction of namespaceFunctions) {
    lines.push(...indentSourceLines(emitEnumNamespaceFunctionCpp(namespaceFunction, context)));
  }
  lines.push('};');
  return lines;
}

function emitEnumNamespaceFunctionCpp(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    anonymousStructTypeParameters: mergeIrTypeParametersCpp(
      outer.anonymousStructTypeParameters,
      declaration.typeParameters,
    ),
    async: declaration.async,
    defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.parameters),
    enclosingReturnType: declaration.returns,
    namespaceScope: false,
    returnsAbsent: hasIrTypeAbsentMember(declaration.returns),
  };
  if (declaration.async) context.includes.add('coroutine');
  const returnType = emitType(declaration.returns, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const params = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`static ${returnType} ${safeCppName(declaration.binding.name)}(${params}) {`);
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
    anonymousStructTypeParameters: mergeIrTypeParametersCpp(
      outer.anonymousStructTypeParameters,
      declaration.typeParameters,
    ),
    async: declaration.async,
    defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.parameters),
    enclosingReturnType: declaration.returns,
    namespaceScope: false,
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

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    anonymousStructTypeParameters: mergeIrTypeParametersCpp(
      outer.anonymousStructTypeParameters,
      declaration.typeParameters,
    ),
  };
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

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    anonymousStructTypeParameters: mergeIrTypeParametersCpp(
      outer.anonymousStructTypeParameters,
      declaration.typeParameters,
    ),
  };
  const stringLiterals = getIrUnionTypeStringLiteralValues(declaration.type);
  if (stringLiterals) return emitStringLiteralUnionCpp(declaration, context);
  const objectProperties =
    declaration.type.kind === 'object'
      ? declaration.type.properties
      : declaration.type.kind === 'intersection'
        ? context.referenceRepresentationPlanner.resolveObjectShape(declaration.type, context.module)
        : undefined;
  if (objectProperties) {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(
      `struct ${name}${getCppRuntimeProfile(context.options) === 'flight-cpp' ? ' : public flight::ReferenceEnabled' : ''} {`,
    );
    for (const property of objectProperties) {
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
  const inferredInitializerType =
    !arrayElement &&
    !variable.mutable &&
    variable.initializer &&
    (variable.type?.kind === 'unknown' ||
      (variable.type?.kind === 'array' &&
        variable.type.element.kind === 'union' &&
        variable.type.element.types.some((type) => type.kind === 'unknown')))
      ? getIrExpressionTypeEvidenceCpp(variable.initializer, context)
      : undefined;
  const preservedInitializerType = arrayElement
    ? undefined
    : (getCppStructurallyEquivalentInitializerTypeCpp(variable, context) ??
      (inferredInitializerType?.kind === 'unknown' ? undefined : inferredInitializerType));
  if (preservedInitializerType) {
    context.preservedInitializerTypes.set(variable.binding.id, preservedInitializerType);
  }
  const type = variable.type && !preservedInitializerType ? emitType(variable.type, context) : 'auto';
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(variable.mutable, variable.type);
  const initializer = variable.initializer
    ? ` = ${
        arrayElement
          ? emitOptionalExpressionCpp(variable.initializer, context, variable.type)
          : emitExpression(
              variable.initializer,
              context,
              preservedInitializerType ?? variable.type,
              true,
              context.denseArrayLengthBindingIds.has(variable.binding.id),
            )
      }`
    : '';
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(variable.binding.id);
  if (sharedCaptureTargetName) {
    if (!variable.initializer) {
      if (variable.initialValue === 'uninitialized') {
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
    const tuple = variable.type ? getIrTupleTypeCpp(variable.type, context, new Set()) : undefined;
    const runtimeArrayInitializer =
      getCppRuntimeProfile(context.options) === 'flight-cpp' &&
      (getIrArrayTypeCpp(variable.type, context, new Set()) !== undefined ||
        (tuple !== undefined && getIrHomogeneousTupleElementTypeCpp(tuple) !== undefined));
    return `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(sharedType, sharedInitializer, context, runtimeArrayInitializer)};`;
  }
  return `${constness}${emittedType} ${name}${initializer};`;
}

function getCppStructurallyEquivalentInitializerTypeCpp(
  variable: Readonly<IrVariable>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (
    'pattern' in variable ||
    variable.mutable ||
    !variable.type ||
    !variable.initializer ||
    context.sharedCaptureTargetNames.has(variable.binding.id)
  ) {
    return undefined;
  }
  const initializerType = getIrExpressionTypeEvidenceCpp(variable.initializer, context);
  if (!initializerType) return undefined;
  const variableUnion = getIrUnionTypeCpp(variable.type, context, new Set());
  const initializerUnion = getIrUnionTypeCpp(initializerType, context, new Set());
  if (!variableUnion || !initializerUnion) return undefined;
  const variableAbsence = variableUnion.types
    .filter((member) => member.kind === 'null' || member.kind === 'undefined')
    .map((member) => member.kind)
    .sort();
  const initializerAbsence = initializerUnion.types
    .filter((member) => member.kind === 'null' || member.kind === 'undefined')
    .map((member) => member.kind)
    .sort();
  if (!isDeepStrictEqual(variableAbsence, initializerAbsence) || variableAbsence.length === 0) return undefined;
  const variableValues = variableUnion.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  const initializerValues = initializerUnion.types.filter(
    (member) => member.kind !== 'null' && member.kind !== 'undefined',
  );
  if (variableValues.length !== 1 || initializerValues.length !== 1) return undefined;
  const variablePlan = context.referenceRepresentationPlanner.plan(variableValues[0]!, context.module);
  const initializerPlan = context.referenceRepresentationPlanner.plan(initializerValues[0]!, context.module);
  if (
    variablePlan.kind !== 'represented' ||
    variablePlan.valueRepresentation !== 'flightReference' ||
    initializerPlan.kind !== 'represented' ||
    initializerPlan.valueRepresentation !== 'flightReference'
  ) {
    return undefined;
  }
  const variableShape = context.referenceRepresentationPlanner.resolveObjectShape(variableValues[0]!, context.module);
  const initializerShape = context.referenceRepresentationPlanner.resolveObjectShape(
    initializerValues[0]!,
    context.module,
  );
  return variableShape && initializerShape && isDeepStrictEqual(variableShape, initializerShape)
    ? initializerType
    : undefined;
}

function emitExpression(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
  constructExpectedUnion = true,
  denseArrayLengthInitialized = false,
): string {
  if (expectedType && constructExpectedUnion) {
    const constructed = emitContextualUnionExpressionCpp(expression, expectedType, context);
    if (constructed) return constructed;
  }
  switch (expression.kind) {
    case 'array':
      return emitArrayExpressionCpp(expression, context, expectedType);
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
      if (
        expression.operator === '=' &&
        expression.left.kind === 'property' &&
        expression.left.member?.receiver === 'array' &&
        expression.left.member.name === 'length' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        const receiver = emitExpression(expression.left.object, context);
        const operator = memberOp(expression.left.object, context);
        return `([&]() { auto&& assignment_receiver = ${receiver}; const auto assignment_value = ${right}; assignment_receiver${operator}resize(assignment_value); return assignment_value; }())`;
      }
      if (
        expression.operator === '=' &&
        expression.left.kind === 'property' &&
        expression.left.member?.receiver === 'typedArray' &&
        expression.left.member.name === 'length' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        emissionError(context, 'typed-array length is read-only and cannot be resized');
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
      const boundAmbientTypeof = emitBoundAmbientTypeofUndefinedComparisonCpp(expression, context);
      if (boundAmbientTypeof) return boundAmbientTypeof;
      if (expression.operator === '??') {
        const leftType = getIrExpressionBindingTypeCpp(expression.left, context);
        const union = leftType ? getIrUnionTypeCpp(leftType, context, new Set()) : undefined;
        if (union && getCppUnionRepresentationPlan(union, context).kind === 'dualSentinelVariant') {
          emissionError(context, 'dual-sentinel nullish coalescing requires presence projection lowering');
        }
        context.includes.add('optional');
        return `${emitOptionalExpressionCpp(expression.left, context, expectedType)}.value_or(${emitExpression(expression.right, context, expectedType, true, denseArrayLengthInitialized)})`;
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
      if (expression.operator === '>>>') {
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
      const optionalPropertyCall = emitOptionalPropertyCallExpressionCpp(expression, context);
      if (optionalPropertyCall) return optionalPropertyCall;
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Object' &&
        expression.callee.name === 'freeze' &&
        expression.arguments.length === 1
      ) {
        return emitExpression(expression.arguments[0]!, context, expectedType);
      }
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.callee.kind === 'property' &&
        expression.callee.name === 'fill' &&
        expression.callee.object.kind === 'new' &&
        expression.callee.object.callee.kind === 'identifier' &&
        expression.callee.object.callee.reference.kind === 'ambient' &&
        expression.callee.object.callee.reference.name === 'Array' &&
        expression.arguments.length === 1
      ) {
        const receiver = emitExpression(expression.callee.object, context, undefined, true, true);
        return `${receiver}.fill(${emitExpression(expression.arguments[0]!, context)})`;
      }
      const arrayFromMapKeys = emitArrayFromMapKeysCpp(expression, expectedType, context);
      if (arrayFromMapKeys) return arrayFromMapKeys;
      const arrayPushSpread = emitArrayPushSpreadCallCpp(expression, context);
      if (arrayPushSpread) return arrayPushSpread;
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
          const receiver = emitExpression(
            expression.callee.object,
            context,
            undefined,
            true,
            binding.targetName === 'fill' &&
              expression.callee.member.receiver === 'array' &&
              expression.arguments.length === 1,
          );
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
      if (
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'String' &&
        expression.arguments.length === 1
      ) {
        const arg = emitExpression(expression.arguments[0]!, context);
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return `flight::to_string(${arg})`;
        }
        context.includes.add('string');
        return `std::to_string(${arg})`;
      }
      const callee =
        expression.callee.kind === 'function'
          ? `(${emitExpression(expression.callee, context)})`
          : emitExpression(expression.callee, context);
      const args = expression.arguments.map((argument, index) => {
        if (
          argument.kind === 'spread' &&
          expression.semantics.signature?.restParameter === index &&
          index === expression.arguments.length - 1
        ) {
          return emitExpression(argument.expression, context);
        }
        return emitExpression(argument, context, getIrCallArgumentExpectedTypeCpp(expression, index, context));
      });
      return `${callee}${emitCppTypeArguments(expression.typeArguments, context)}(${args.join(', ')})`;
    }
    case 'cast': {
      const asserted = emitUnionMemberAssertionCpp(expression.expression, expression.type, context);
      return (
        asserted ??
        `static_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`
      );
    }
    case 'conditional': {
      const evidence =
        expression.condition.kind === 'binary' ? expression.condition.semantics.unionMemberTest : undefined;
      const branchContext = (result: boolean): EmitContext =>
        evidence?.whenResult === result
          ? {
              ...context,
              narrowedBindingTypes: new Map(context.narrowedBindingTypes).set(evidence.binding.id, evidence.member),
            }
          : context;
      return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, branchContext(true), expectedType)} : ${emitExpression(expression.whenFalse, branchContext(false), expectedType)})`;
    }
    case 'element': {
      if (expression.optional) return emitOptionalElementExpressionCpp(expression, context);
      const computedProperty = emitComputedSymbolElementAccessCpp(expression, context);
      if (computedProperty) return computedProperty;
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && hasIndexedRuntimeReceiverCpp(expression, context)) {
        return `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
      }
      if (expression.semantics.receivers.includes('tuple')) {
        context.includes.add('tuple');
        const index = getElementAccessTupleIndexCpp(expression, context);
        return `std::get<${String(index)}>(${emitExpression(expression.object, context)})`;
      }
      const object = emitExpression(expression.object, context);
      const index = emitExpression(expression.index, context);
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      const record =
        objectType?.kind === 'named' &&
        objectType.reference.kind === 'ambient' &&
        objectType.reference.name === 'Record';
      return record || expression.semantics.receivers.every((receiver) => receiver === 'object')
        ? `${object}[${index}]`
        : `${object}[static_cast<size_t>(${index})]`;
    }
    case 'function': {
      if (expression.async) emissionError(context, 'async closures require C++ coroutine lowering');
      const functionContext: EmitContext = {
        ...context,
        anonymousStructTypeParameters: mergeIrTypeParametersCpp(
          context.anonymousStructTypeParameters,
          expression.typeParameters,
        ),
        async: false,
        defaultedParameterIds: collectDefaultedParameterIdsCpp(expression.parameters),
        enclosingReturnType: expression.returns,
        namespaceScope: false,
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
      const capture = usesThis
        ? context.namespaceScope
          ? '[this]'
          : '[=, this]'
        : context.namespaceScope
          ? '[]'
          : '[=]';
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
      if (expression.reference.kind === 'ambient' && expression.reference.name === 'undefined') {
        return emitUndefinedWithExpectedTypeCpp(expectedType, context);
      }
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
        const bindingType = getCppBindingTypeCpp(expression.reference.binding.id, context);
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
      if (
        expression.reference.kind === 'binding' &&
        (expression.narrowedMember || context.narrowedBindingTypes.has(expression.reference.binding.id))
      ) {
        const narrowed = emitNarrowedUnionMemberCpp(expression, context);
        if (narrowed) return narrowed;
      }
      return emitIdentifierReference(expression.reference, context);
    }
    case 'literal':
      return emitLiteralWithExpectedTypeCpp(expression.value, expectedType, context);
    case 'new': {
      const args = expression.arguments.map((argument, index) =>
        emitExpression(argument, context, getIrInvocationArgumentExpectedTypeCpp(expression, index)),
      );
      if (expression.semantics.construction === 'factory') {
        return `${emitExpression(expression.callee, context)}.construct(${args.join(', ')})`;
      }
      const ambientConstructorName = getIrAmbientConstructorNameCpp(expression.callee);
      if (
        expression.callee.kind !== 'identifier' &&
        !(
          expression.callee.kind === 'property' &&
          expression.callee.object.kind === 'identifier' &&
          expression.callee.object.reference.kind === 'ambient'
        )
      ) {
        emissionError(context, 'qualified constructors require C++ type-path lowering');
      }
      const typeName =
        expression.callee.kind === 'identifier'
          ? emitIdentifierReference(expression.callee.reference, context)
          : emitExpression(expression.callee, context);
      const externalConstruction =
        ambientConstructorName === undefined
          ? undefined
          : getCompilerExternalBindingConstructionCpp(ambientConstructorName, context.options.externalBindings);
      if (ambientConstructorName?.includes('.')) {
        addCppExternalBindingHeaders(ambientConstructorName, 'value', context);
      }
      if (typeName === 'std::runtime_error' || typeName === 'std::range_error') {
        context.includes.add('stdexcept');
      }
      const constructedType = getIrNewExpressionTypeEvidenceCpp(expression, context);
      const contextualArrayTypeArguments =
        ambientConstructorName === 'Array' && expectedType?.kind === 'array' ? [expectedType.element] : [];
      const typeArguments = emitCppTypeArguments(
        expression.typeArguments.length > 0
          ? expression.typeArguments
          : constructedType && constructedType.typeArguments.length > 0
            ? constructedType.typeArguments
            : contextualArrayTypeArguments,
        context,
      );
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        ambientConstructorName === 'Array' &&
        args.length > 0 &&
        !denseArrayLengthInitialized
      ) {
        emissionError(context, 'Array length construction is outside the dense flight-cpp array profile');
      }
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && ambientConstructorName === 'Promise') {
        if (expression.typeArguments.length !== 1) {
          emissionError(context, 'flight-cpp Promise construction requires one explicit type argument');
        }
        return `${typeName}${typeArguments}::create(${args.join(', ')})`;
      }
      if (
        getCppRuntimeProfile(context.options) !== 'flight-cpp' &&
        ambientConstructorName === 'Set' &&
        args.length === 1 &&
        constructedType?.typeArguments.length === 1
      ) {
        const valuesName = getGeneratedTargetName('setConstructorValues', context);
        return `([&]() { auto&& ${valuesName} = ${args[0]}; return ${typeName}${typeArguments}(${valuesName}.begin(), ${valuesName}.end()); }())`;
      }
      if (externalConstruction) {
        return `${externalConstruction.targetName}${typeArguments}(${args.join(', ')})`;
      }
      if (
        (typeName === 'std::runtime_error' || typeName === 'std::range_error') &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        args.length > 0
      ) {
        return `${typeName}(${args[0]}.to_utf8())`;
      }
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
      const spread =
        expression.members.length === 1 && expression.members[0]?.kind === 'spread' ? expression.members[0] : undefined;
      if (spread) {
        const spreadType =
          constructionType.kind === 'unknown'
            ? getIrExpressionTypeEvidenceCpp(spread.expression, context)
            : constructionType;
        const value = emitExpression(spread.expression, context, spreadType);
        if (spreadType && hasFlightReferenceRepresentationCpp(spreadType, context)) {
          const storageType = emitType(spreadType, context, 'storage');
          return `flight::make_ref<${storageType}>(*${value})`;
        }
        return value;
      }
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
      const namespaceMember = getCppNamespaceImportMemberTargetNameCpp(expression, context);
      if (namespaceMember) return namespaceMember;
      const commonVariantProperty = emitCppVariantCommonPropertyExpression(expression, context);
      if (commonVariantProperty) return commonVariantProperty;
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'ambient') {
        addCppExternalBindingHeaders(expression.object.reference.name, 'value', context);
        const member = getCompilerRuntimeExternalMemberTargetCpp(
          expression.object.reference.name,
          expression.name,
          getCppRuntimeProfile(context.options),
          context.options.externalBindings,
        );
        if (member) {
          if (expression.object.reference.name === 'Number') {
            context.includes.add('cmath');
            context.includes.add('limits');
          }
          return member;
        }
        emissionError(
          context,
          `ambient value ${expression.object.reference.name} member ${expression.name} has no C++ binding`,
        );
      }
      if (expression.namespaceMember) {
        return `${emitExpression(expression.object, context)}::${safeCppName(expression.name)}`;
      }
      if (
        expression.object.kind === 'identifier' &&
        expression.object.reference.kind === 'binding' &&
        !expression.object.narrowedMember &&
        !context.narrowedBindingTypes.has(expression.object.reference.binding.id) &&
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
      if (getCppRuntimeProfile(context.options) !== 'flight-cpp') {
        emissionError(context, 'regular expressions require a downstream standard-library mapping');
      }
      context.includes.add('flight/regexp.hpp');
      return `flight::RegExp(flight::String(${JSON.stringify(expression.pattern)}), flight::String(${JSON.stringify(expression.flags)}))`;
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
      const expectedTuple = expectedType ? getIrTupleTypeCpp(expectedType, context, new Set()) : undefined;
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
      return expectedTuple
        ? emitCppTupleConstructionCpp(expectedTuple, elements, context)
        : emitCppInlineTupleConstructionCpp(elements, context);
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
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      const tuple = objectType ? getIrTupleTypeCpp(objectType, context, new Set()) : undefined;
      if (
        tuple &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        getIrHomogeneousTupleElementTypeCpp(tuple)
      ) {
        return emitCppTupleSliceExpressionCpp(
          expression.object,
          tuple,
          expression.start,
          tuple.elements.length,
          context,
        );
      }
      context.includes.add('tuple');
      return `std::get<${String(expression.start)}>(${emitExpression(expression.object, context)})`;
    }
    case 'tupleSpread':
      return emitTupleSpreadExpressionCpp(expression, context);
    case 'tupleSuffix': {
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      const tuple = objectType ? getIrTupleTypeCpp(objectType, context, new Set()) : undefined;
      if (
        tuple &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        getIrHomogeneousTupleElementTypeCpp(tuple)
      ) {
        return emitCppTupleSliceExpressionCpp(
          expression.object,
          tuple,
          expression.start,
          expression.start + expression.width,
          context,
        );
      }
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

function emitArrayExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'array' }>>,
  context: EmitContext,
  expectedType: Readonly<IrType> | undefined,
): string {
  const expectedArray = getIrArrayTypeCpp(expectedType, context, new Set());
  if (
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    expression.elements.some((element) => element === undefined)
  ) {
    emissionError(context, 'sparse array literals are outside the dense flight-cpp array profile');
  }
  if (!expression.elements.some((element) => element?.kind === 'spread')) {
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

  const inferredSpreadElements = expression.elements.flatMap((element): readonly IrType[] => {
    if (element?.kind !== 'spread') return [];
    const view = getCppCollectionIterationView(element.expression, context);
    if (view) return [view.elementType];
    const operandType = getIrExpressionTypeEvidenceCpp(element.expression, context);
    const iterableElement = operandType ? getIrIterableElementTypeCpp(operandType, context, new Set()) : undefined;
    return iterableElement && iterableElement.kind !== 'unknown' ? [iterableElement] : [];
  });
  const elementType =
    expectedArray && expectedArray.element.kind !== 'unknown' ? expectedArray.element : inferredSpreadElements[0];
  if (!elementType) {
    emissionError(context, 'array spread requires contextual or iterable element type evidence');
  }

  const flightRuntime = getCppRuntimeProfile(context.options) === 'flight-cpp';
  if (!flightRuntime) context.includes.add('vector');
  const target = flightRuntime
    ? `flight::Array<${emitType(elementType, context)}>`
    : `std::vector<${emitType(elementType, context)}>`;
  const resultName = getGeneratedTargetName('arraySpreadResult', context);
  const itemName = getGeneratedTargetName('arraySpreadItem', context);
  const append = flightRuntime ? 'push' : 'push_back';
  const statements = expression.elements.map((element): string => {
    if (!element) return `${resultName}.${append}({});`;
    if (element.kind !== 'spread') {
      return `${resultName}.${append}(${emitExpression(element, context, elementType)});`;
    }
    const view = getCppCollectionIterationView(element.expression, context);
    if (view) return emitCppCollectionViewArraySpread(view, resultName, append, context);
    const operandType = getIrExpressionTypeEvidenceCpp(element.expression, context);
    const tuple = operandType ? getIrTupleTypeCpp(operandType, context, new Set()) : undefined;
    if (tuple) {
      const operandName = getGeneratedTargetName('arraySpreadTuple', context);
      const tupleAppends = tuple.elements.map((tupleElement, index) =>
        tupleElement.rest
          ? `for (const auto& ${itemName} : ${emitCppTupleElementAccessCpp(operandName, tuple, index, context)}) { ${resultName}.${append}(${itemName}); }`
          : `${resultName}.${append}(${emitCppTupleElementAccessCpp(operandName, tuple, index, context)});`,
      );
      return `{ auto&& ${operandName} = ${emitExpression(element.expression, context)}; ${tupleAppends.join(' ')} }`;
    }
    return `for (const auto& ${itemName} : ${emitExpression(element.expression, context)}) { ${resultName}.${append}(${itemName}); }`;
  });
  return `([&]() { ${target} ${resultName}; ${statements.join(' ')} return ${resultName}; }())`;
}

function emitArrayPushSpreadCallCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  if (
    expression.callee.kind !== 'property' ||
    expression.callee.member?.receiver !== 'array' ||
    expression.callee.member.name !== 'push' ||
    !expression.arguments.some((argument) => argument.kind === 'spread')
  ) {
    return undefined;
  }
  const receiverName = getGeneratedTargetName('arrayPushReceiver', context);
  const argumentsName = getGeneratedTargetName('arrayPushArguments', context);
  const itemName = getGeneratedTargetName('arrayPushItem', context);
  const receiverType = getIrExpressionTypeEvidenceCpp(expression.callee.object, context);
  const arguments_ = emitArrayExpressionCpp({ elements: expression.arguments, kind: 'array' }, context, receiverType);
  const append = getCppRuntimeProfile(context.options) === 'flight-cpp' ? 'push' : 'push_back';
  return `([&]() { auto&& ${receiverName} = ${emitExpression(expression.callee.object, context)}; const auto ${argumentsName} = ${arguments_}; for (const auto& ${itemName} : ${argumentsName}) { ${receiverName}.${append}(${itemName}); } return static_cast<double>(${receiverName}.size()); }())`;
}

interface CppCollectionIterationView {
  readonly collection: Readonly<IrExpression>;
  readonly collectionKind: 'map' | 'set';
  readonly elementType: Readonly<IrType>;
  readonly projection: 'entry' | 'key' | 'value';
}

type IrAmbientNamedTypeCpp = Readonly<
  Extract<IrType, { kind: 'named' }> & { reference: Readonly<{ kind: 'ambient'; name: string }> }
>;

function getCppCollectionIterationView(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): CppCollectionIterationView | undefined {
  if (
    expression.kind !== 'call' ||
    expression.optional ||
    expression.arguments.length !== 0 ||
    expression.callee.kind !== 'property' ||
    expression.callee.optional ||
    (expression.callee.member?.receiver !== 'map' && expression.callee.member?.receiver !== 'set') ||
    !['entries', 'keys', 'values'].includes(expression.callee.name)
  ) {
    return undefined;
  }
  const collectionType = getIrAmbientCollectionTypeCpp(
    getIrExpressionTypeEvidenceCpp(expression.callee.object, context),
    context,
    new Set(),
  );
  if (!collectionType) return undefined;
  const collectionKind = ['Map', 'ReadonlyMap'].includes(collectionType.reference.name) ? 'map' : 'set';
  const projection =
    expression.callee.name === 'entries' ? 'entry' : expression.callee.name === 'keys' ? 'key' : 'value';
  if (collectionKind === 'map') {
    const [key, value] = collectionType.typeArguments;
    if (!key || !value) return undefined;
    return {
      collection: expression.callee.object,
      collectionKind,
      elementType:
        projection === 'entry'
          ? {
              elements: [key, value].map((type) => ({ optional: false, rest: false, type })),
              kind: 'tuple',
              readonly: true,
            }
          : projection === 'key'
            ? key
            : value,
      projection,
    };
  }
  const value = collectionType.typeArguments[0];
  if (!value) return undefined;
  return {
    collection: expression.callee.object,
    collectionKind,
    elementType:
      projection === 'entry'
        ? {
            elements: [value, value].map((type) => ({ optional: false, rest: false, type })),
            kind: 'tuple',
            readonly: true,
          }
        : value,
    projection,
  };
}

function getIrAmbientCollectionTypeCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): IrAmbientNamedTypeCpp | undefined {
  if (!type || type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient' && ['Map', 'ReadonlyMap', 'ReadonlySet', 'Set'].includes(type.reference.name)) {
    return type as IrAmbientNamedTypeCpp;
  }
  if (type.reference.kind !== 'binding' || resolvingAliases.has(type.reference.binding.id)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(type.reference.binding.id);
  return getIrAmbientCollectionTypeCpp(alias, context, nextResolvingAliases);
}

function emitCppCollectionViewArraySpread(
  view: Readonly<CppCollectionIterationView>,
  resultName: string,
  append: string,
  context: EmitContext,
): string {
  const collectionName = getGeneratedTargetName('arraySpreadCollection', context);
  const valueName = getGeneratedTargetName('arraySpreadValue', context);
  if (view.collectionKind === 'set' && view.projection !== 'entry') {
    return `{ auto&& ${collectionName} = ${emitExpression(view.collection, context)}; for (const auto& ${valueName} : ${collectionName}) { ${resultName}.${append}(${valueName}); } }`;
  }
  if (view.collectionKind === 'set') {
    const tuple = view.elementType.kind === 'tuple' ? view.elementType : undefined;
    const projected = tuple
      ? emitCppTupleConstructionCpp(tuple, [valueName, valueName], context)
      : emitCppInlineTupleConstructionCpp([valueName, valueName], context);
    return `{ auto&& ${collectionName} = ${emitExpression(view.collection, context)}; for (const auto& ${valueName} : ${collectionName}) { ${resultName}.${append}(${projected}); } }`;
  }
  const keyName = getGeneratedTargetName('arraySpreadKey', context);
  const itemName = getGeneratedTargetName('arraySpreadMappedValue', context);
  const projected =
    view.projection === 'entry' && view.elementType.kind === 'tuple'
      ? emitCppTupleConstructionCpp(view.elementType, [keyName, itemName], context)
      : view.projection === 'key'
        ? keyName
        : itemName;
  const unused =
    view.projection === 'key'
      ? ` static_cast<void>(${itemName});`
      : view.projection === 'value'
        ? ` static_cast<void>(${keyName});`
        : '';
  return `{ auto&& ${collectionName} = ${emitExpression(view.collection, context)}; for (const auto& [${keyName}, ${itemName}] : ${collectionName}) {${unused} ${resultName}.${append}(${projected}); } }`;
}

function getIrArrayTypeCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<Extract<IrType, { kind: 'array' }>> | undefined {
  if (!type) return undefined;
  if (type.kind === 'array') return type;
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Array' || type.reference.name === 'ReadonlyArray') &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    return {
      element: type.typeArguments[0],
      kind: 'array',
      readonly: type.reference.name === 'ReadonlyArray',
    };
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getIrArrayTypeCpp(alias, context, nextResolvingAliases);
}

function getIrTupleTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<Extract<IrType, { kind: 'tuple' }>> | undefined {
  if (type.kind === 'tuple') return type;
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getIrTupleTypeCpp(alias, context, nextResolvingAliases);
}

function getIrIterableElementTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  const array = getIrArrayTypeCpp(type, context, resolvingAliases);
  if (array) return array.element;
  if (type.kind === 'primitive' && type.name === 'string') return type;
  if (type.kind === 'tuple') {
    const elements = type.elements.flatMap((element): readonly IrType[] => {
      if (!element.rest) return [element.type];
      const restElement = getIrIterableElementTypeCpp(element.type, context, resolvingAliases);
      return restElement ? [restElement] : [];
    });
    if (elements.length !== type.elements.length) return undefined;
    if (elements.length === 0) return undefined;
    const unique = new Map(elements.map((element) => [JSON.stringify(element), element]));
    const values = [...unique.values()];
    return values.length === 1
      ? values[0]
      : values.length > 1
        ? { kind: 'union', types: [values[0]!, values[1]!, ...values.slice(2)] }
        : undefined;
  }
  if (type.kind === 'union') {
    const elements = type.types.flatMap((member): readonly IrType[] => {
      const element = getIrIterableElementTypeCpp(member, context, resolvingAliases);
      return element ? [element] : [];
    });
    if (elements.length !== type.types.length || !elements[0]) return undefined;
    const unique = new Map(elements.map((element) => [JSON.stringify(element), element]));
    const values = [...unique.values()];
    return values.length === 1 ? values[0] : { kind: 'union', types: [values[0]!, values[1]!, ...values.slice(2)] };
  }
  if (type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') {
    if (
      ['Iterable', 'IterableIterator', 'ReadonlySet', 'Set'].includes(type.reference.name) &&
      type.typeArguments.length === 1
    ) {
      return type.typeArguments[0];
    }
    if (type.reference.name === 'Map' && type.typeArguments.length === 2) {
      return {
        elements: type.typeArguments.map((element) => ({ optional: false, rest: false, type: element })),
        kind: 'tuple',
        readonly: true,
      };
    }
    if (
      /^(?:BigInt64|BigUint64|Float32|Float64|Int16|Int32|Int8|Uint16|Uint32|Uint8|Uint8Clamped)Array$/u.test(
        type.reference.name,
      )
    ) {
      return { kind: 'primitive', name: 'number' };
    }
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getIrIterableElementTypeCpp(alias, context, nextResolvingAliases);
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
      const collectionView = getCppCollectionIterationView(statement.iterable, context);
      const iterable = emitExpression(collectionView?.collection ?? statement.iterable, context);
      const variableName = getBindingTargetName(statement.variable.binding, context);
      const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(statement.variable.binding.id);
      if (collectionView && !(collectionView.collectionKind === 'set' && collectionView.projection !== 'entry')) {
        if (sharedCaptureTargetName && !statement.variable.type) {
          emissionError(
            context,
            `shared mutable capture ${statement.variable.binding.name} requires concrete binding type evidence`,
          );
        }
        const keyName = getGeneratedTargetName('forOfKey', context);
        const valueName = getGeneratedTargetName('forOfValue', context);
        const projected =
          collectionView.collectionKind === 'set' && collectionView.elementType.kind === 'tuple'
            ? emitCppTupleConstructionCpp(collectionView.elementType, [valueName, valueName], context)
            : collectionView.projection === 'entry' && collectionView.elementType.kind === 'tuple'
              ? emitCppTupleConstructionCpp(collectionView.elementType, [keyName, valueName], context)
              : collectionView.projection === 'key'
                ? keyName
                : valueName;
        const iterationValueName = sharedCaptureTargetName
          ? generateUniqueName(`${variableName}_iteration_value`, context)
          : variableName;
        const binding = `auto ${iterationValueName} = ${projected};`;
        const body = sharedCaptureTargetName
          ? [
              binding,
              `const auto ${sharedCaptureTargetName} = ${emitSharedCaptureCellConstructionCpp(emitType(statement.variable.type!, context), iterationValueName, context)};`,
              ...emitStatementBody(statement.body, context),
            ]
          : [binding, ...emitStatementBody(statement.body, context)];
        if (collectionView.collectionKind === 'set') {
          return [`for (const auto& ${valueName} : ${iterable}) {`, ...indentSourceLines(body), '}'];
        }
        const unused =
          collectionView.projection === 'key'
            ? `static_cast<void>(${valueName});`
            : collectionView.projection === 'value'
              ? `static_cast<void>(${keyName});`
              : undefined;
        return [
          `for (const auto& [${keyName}, ${valueName}] : ${iterable}) {`,
          ...indentSourceLines(unused ? [unused, ...body] : body),
          '}',
        ];
      }
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
          const expression =
            emitAsyncTaskAdoptionCpp(statement.expression, context) ??
            emitExpression(statement.expression, context, getExpectedReturnTypeCpp(context));
          lines.push(`${context.finallyReturnVar} = ${expression};`);
        }
        return lines;
      }
      const keyword = context.async ? 'co_return' : 'return';
      const expression = statement.expression
        ? (emitAsyncTaskAdoptionCpp(statement.expression, context) ??
          emitExpression(statement.expression, context, getExpectedReturnTypeCpp(context)))
        : undefined;
      return [`${keyword}${expression ? ` ${expression}` : ''};`];
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
  const caseContext = switchCase.unionMemberTest
    ? {
        ...context,
        narrowedBindingTypes: new Map(context.narrowedBindingTypes).set(
          switchCase.unionMemberTest.binding.id,
          switchCase.unionMemberTest.member,
        ),
      }
    : context;
  return emitStatements(localBreak ? switchCase.statements.slice(0, -1) : switchCase.statements, caseContext);
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
    type.reference.name === 'NonNullable' &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    const present = getCppNonNullableType(type.typeArguments[0], context, new Set());
    if (!present) emissionError(context, 'NonNullable<T> requires a statically resolvable present type');
    return emitType(present, context, representation);
  }
  const rebound = getCppEquivalentImportedTypeCpp(type, context);
  if (rebound) return emitType(rebound, context, representation);
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments[0]
  ) {
    return emitType(type.typeArguments[0], context, representation);
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Omit' &&
    type.typeArguments.length === 2 &&
    type.typeArguments[0]
  ) {
    const subject = context.referenceRepresentationPlanner.plan(type.typeArguments[0], context.module);
    if (
      getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
      subject.kind !== 'represented' ||
      subject.valueRepresentation !== 'flightReference'
    ) {
      emissionError(context, 'Omit<T, K> requires a proven reference-preserving flight-cpp representation');
    }
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
    case 'indexedAccess': {
      const indexed = getCppIndexedAccessType(type, context);
      if (!indexed) emissionError(context, 'indexedAccess types require C++ type computation lowering');
      return emitType(indexed, context, representation);
    }
    case 'keyof': {
      const keyType = getCppKeyofType(type.type, context);
      if (!keyType) emissionError(context, 'keyof types require C++ type computation lowering');
      return emitType(keyType, context, representation);
    }
    case 'typeOf': {
      const valueType = getCppTypeOfValueType(type, context);
      if (!valueType) emissionError(context, 'typeOf types require C++ type computation lowering');
      return emitType(valueType, context, representation);
    }
    case 'intersection': {
      const erasedValue = getCppErasedIntersectionValueType(type, context);
      if (erasedValue) return emitType(erasedValue, context, representation);
      const properties = context.referenceRepresentationPlanner.resolveObjectShape(type, context.module);
      if (!properties) emissionError(context, 'intersection types require C++ multiple-inheritance lowering');
      return emitType({ kind: 'object', properties }, context, representation);
    }
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
      if (sourceName === 'Exclude') {
        const excluded = getCppExcludedType(type.typeArguments, context);
        if (!excluded) emissionError(context, 'Exclude types require closed C++ type computation lowering');
        return emitType(excluded, context, representation);
      }
      if (sourceName === 'Partial' && type.typeArguments[0]) {
        const properties = context.referenceRepresentationPlanner.resolveObjectShape(
          type.typeArguments[0],
          context.module,
        );
        if (!properties) {
          emissionError(context, 'Partial<T> requires a statically resolvable C++ object shape');
        }
        return emitType(
          { kind: 'object', properties: properties.map((property) => ({ ...property, optional: true })) },
          context,
          representation,
        );
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
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::Null';
      context.includes.add('cstddef');
      return 'std::nullptr_t';
    case 'undefined':
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::Undefined';
      context.includes.add('variant');
      return 'std::monostate';
    case 'object': {
      const typeParameters = context.anonymousStructTypeParameters.map(
        (parameter) => context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name),
      );
      if (type.properties.some((property) => property.optional)) context.includes.add('optional');
      const emittedProperties = type.properties.map((property) => ({
        name: safeCppName(property.name),
        optional: property.optional,
        type: emitType(property.type, context),
      }));
      const unresolved = emittedProperties.find((property) => /\bauto\b/u.test(property.type));
      if (unresolved) {
        emissionError(context, `anonymous object property ${unresolved.name} requires concrete C++ type evidence`);
      }
      // Literal discriminants can erase to one target scalar type while still requiring distinct
      // variant alternatives. Key helpers by neutral structure, not only their emitted field types.
      const typeParameterKey = context.anonymousStructTypeParameters.map((parameter) => parameter.binding.id).join(',');
      const key = `${typeParameterKey}\0${normalizeCompilerStructuralValueCanonical(type)}`;
      const existing = context.anonymousStructs.get(key);
      if (existing) {
        return `${existing.name}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
      }
      const structName = generateAnonymousStructName(type.properties, context);
      context.anonymousStructs.set(key, { name: structName, properties: emittedProperties, typeParameters });
      return `${structName}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
    }
    case 'primitive':
      if (type.name === 'string') return emitCppStringType(context);
      if (type.name === 'symbol' && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        context.includes.add('flight/symbol.hpp');
        return 'flight::Symbol';
      }
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
      const homogeneousElement = getIrHomogeneousTupleElementTypeCpp(type);
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && homogeneousElement) {
        return `flight::Array<${emitType(homogeneousElement, context)}>`;
      }
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
      if (type.source === 'object') {
        context.includes.add('memory');
        return 'std::shared_ptr<void>';
      }
      return 'auto';
  }
}

function getCppIndexedAccessType(
  type: Readonly<Extract<IrType, { kind: 'indexedAccess' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const properties = context.referenceRepresentationPlanner.resolveObjectShape(type.object, context.module);
  if (!properties) return undefined;
  const names = getCppIndexedAccessPropertyNames(type.index, type.object, properties);
  if (!names || names.length === 0) return undefined;
  const selected = names.flatMap((name) => {
    const property = properties.find((candidate) => candidate.name === name);
    if (!property) return [];
    return property.optional ? [property.type, { kind: 'undefined' } as const] : [property.type];
  });
  if (selected.length === 0) return undefined;
  const unique = [...new Map(selected.map((candidate) => [JSON.stringify(candidate), candidate])).values()];
  return unique.length === 1 ? unique[0] : { kind: 'union', types: [unique[0]!, unique[1]!, ...unique.slice(2)] };
}

function getCppKeyofType(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> | undefined {
  const properties = context.referenceRepresentationPlanner.resolveObjectShape(type, context.module);
  if (!properties || properties.length === 0) return undefined;
  const keyTypes: IrType[] = [];
  if (properties.some((property) => !property.computedKey)) {
    keyTypes.push({ kind: 'primitive', name: 'string' });
  }
  if (properties.some((property) => property.computedKey)) {
    keyTypes.push({ kind: 'primitive', name: 'symbol' });
  }
  return createCppClosedTypeUnion(keyTypes);
}

function getCppExcludedType(
  typeArguments: readonly Readonly<IrType>[],
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (typeArguments.length !== 2 || !typeArguments[0] || !typeArguments[1]) return undefined;
  const included = getCppClosedTypeMembers(typeArguments[0], context);
  const excluded = getCppClosedTypeMembers(typeArguments[1], context);
  if (!included || !excluded) return undefined;
  return createCppClosedTypeUnion(
    included.filter((member) => !excluded.some((candidate) => isCppClosedTypeAssignable(member, candidate))),
  );
}

function getCppClosedTypeMembers(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string> = new Set(),
): readonly Readonly<IrType>[] | undefined {
  if (type.kind === 'keyof' || type.kind === 'typeOf') {
    const resolved = type.kind === 'keyof' ? getCppKeyofType(type.type, context) : getCppTypeOfValueType(type, context);
    return resolved ? getCppClosedTypeMembers(resolved, context, resolvingAliases) : undefined;
  }
  if (type.kind === 'named' && type.reference.kind === 'binding') {
    const bindingId = type.reference.binding.id;
    if (resolvingAliases.has(bindingId)) return undefined;
    const alias = resolveCppTypeAliasTarget(type, context);
    if (alias) {
      const nextResolvingAliases = new Set(resolvingAliases);
      nextResolvingAliases.add(bindingId);
      return getCppClosedTypeMembers(alias, context, nextResolvingAliases);
    }
  }
  if (type.kind === 'never') return [];
  if (type.kind === 'union') {
    const members = type.types.map((member) => getCppClosedTypeMembers(member, context, resolvingAliases));
    return members.some((member) => !member) ? undefined : members.flatMap((member) => member!);
  }
  return type.kind === 'literal' || type.kind === 'null' || type.kind === 'primitive' || type.kind === 'undefined'
    ? [type]
    : undefined;
}

function isCppClosedTypeAssignable(source: Readonly<IrType>, target: Readonly<IrType>): boolean {
  if (target.kind === 'primitive') {
    if (source.kind === 'primitive') return source.name === target.name;
    if (source.kind !== 'literal') return false;
    return typeof source.value === target.name;
  }
  if (target.kind === 'literal') return source.kind === 'literal' && Object.is(source.value, target.value);
  return source.kind === target.kind;
}

function createCppClosedTypeUnion(types: readonly Readonly<IrType>[]): Readonly<IrType> {
  const unique = [...new Map(types.map((type) => [JSON.stringify(type), type])).values()];
  if (unique.length === 0) return { kind: 'never' };
  if (unique.length === 1) return unique[0]!;
  return { kind: 'union', types: [unique[0]!, unique[1]!, ...unique.slice(2)] };
}

function getCppErasedIntersectionValueType(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  let sharedDomains: Map<string, IrType> | undefined;
  for (const member of type.types) {
    if (
      member.kind === 'object' ||
      (member.kind === 'named' &&
        member.reference.kind === 'ambient' &&
        member.reference.name === 'Record' &&
        member.typeArguments[0]?.kind === 'never')
    ) {
      continue;
    }
    const runtimeDomain = getIrTypeRuntimeDomainCpp(member, context, new Set());
    const candidates = runtimeDomain ? getCppIntersectionScalarDomains(runtimeDomain) : undefined;
    if (!candidates) return undefined;
    const candidateDomains = new Map(
      candidates.map((domain) => [normalizeCompilerStructuralValueCanonical(domain), domain] as const),
    );
    sharedDomains = sharedDomains
      ? new Map([...sharedDomains].filter(([key]) => candidateDomains.has(key)))
      : candidateDomains;
  }
  return sharedDomains?.size === 1 ? [...sharedDomains.values()][0] : undefined;
}

function getCppIntersectionScalarDomains(type: Readonly<IrType>): readonly IrType[] | undefined {
  if (type.kind === 'primitive') return [type];
  if (type.kind !== 'union') return undefined;
  const domains = type.types.flatMap((member) => (member.kind === 'primitive' ? [member] : []));
  return domains.length === type.types.length ? domains : undefined;
}

function getCppIndexedAccessPropertyNames(
  index: Readonly<IrType>,
  object: Readonly<IrType>,
  properties: readonly Readonly<IrObjectTypeProperty>[],
): readonly string[] | undefined {
  if (index.kind === 'literal' && typeof index.value === 'string') return [index.value];
  if (
    index.kind === 'keyof' &&
    JSON.stringify(index.type) === JSON.stringify(object) &&
    properties.every((property) => !property.computedKey)
  ) {
    return properties.map((property) => property.name);
  }
  if (index.kind !== 'union') return undefined;
  const names = index.types.flatMap((member) =>
    member.kind === 'literal' && typeof member.value === 'string' ? [member.value] : [],
  );
  return names.length === index.types.length ? names : undefined;
}

function getCppTypeOfValueType(
  type: Readonly<Extract<IrType, { kind: 'typeOf' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (type.reference.kind !== 'binding') return undefined;
  let valueType = getCppBindingTypeCpp(type.reference.binding.id, context);
  for (const segment of type.reference.path) {
    if (!valueType) return undefined;
    valueType = getIrObjectPropertyTypeCpp(valueType, segment, context);
  }
  return valueType;
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

function getCppNonNullableType(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  if (type.kind === 'indexedAccess') {
    if (type.index.kind !== 'literal' || typeof type.index.value !== 'string') return undefined;
    const propertyName = type.index.value;
    const properties = context.referenceRepresentationPlanner.resolveObjectShape(type.object, context.module);
    const property = properties?.find((candidate) => candidate.name === propertyName);
    return property ? getCppNonNullableType(property.type, context, resolvingAliases) : undefined;
  }
  if (type.kind === 'union') {
    const present = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    if (present.length === 0) return undefined;
    if (present.length === 1) return getCppNonNullableType(present[0]!, context, resolvingAliases);
    return { kind: 'union', types: [present[0]!, present[1]!, ...present.slice(2)] };
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return type;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return type;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return type;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getCppNonNullableType(alias, context, nextResolvingAliases);
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
      ? getCppBindingTypeCpp(operand.reference.binding.id, context)
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
  const representation = getCppVariantRepresentationForInspection(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    alternative.members.some((member) => isDeepStrictEqual(member, assertedType)),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'type assertion target must identify exactly one C++ variant alternative');
  }
  if (representation.direct) return emitIdentifierReference(expression.reference, context);
  return `std::get<${String(representation.alternatives.indexOf(alternatives[0]!))}>(${emitIdentifierReference(expression.reference, context)})`;
}

function emitUnionMemberTestCpp(evidence: Readonly<IrUnionMemberTestEvidence>, context: EmitContext): string {
  const union = getIrBindingVariantUnionTypeCpp(evidence.binding.id, context);
  if (!union) emissionError(context, 'union member test requires a C++ variant binding');
  const representation = getCppVariantRepresentationForInspection(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    doesCppVariantAlternativeMatchType(alternative, evidence.member, context),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'union member test must identify exactly one C++ variant alternative');
  }
  const alternativeIndex = representation.alternatives.indexOf(alternatives[0]!);
  const test = representation.direct
    ? 'true'
    : `${emitBindingValueCpp(evidence.binding, context)}.index() == ${String(alternativeIndex)}`;
  return evidence.whenResult ? test : `!(${test})`;
}

function doesCppVariantAlternativeMatchType(
  alternative: CppVariantRepresentation['alternatives'][number],
  type: Readonly<IrType>,
  context: EmitContext,
): boolean {
  return (
    alternative.members.some((member) => isDeepStrictEqual(member, type)) ||
    alternative.targetType ===
      emitType(type, {
        ...context,
        anonymousStructs: new Map(),
        includes: new Set(),
      })
  );
}

function emitCppVariantCommonPropertyExpression(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  if (
    expression.object.kind !== 'identifier' ||
    expression.object.reference.kind !== 'binding' ||
    expression.object.narrowedMember ||
    context.narrowedBindingTypes.has(expression.object.reference.binding.id)
  ) {
    return undefined;
  }
  const union = getIrBindingVariantUnionTypeCpp(expression.object.reference.binding.id, context);
  if (!union) return undefined;
  const representation = getCppVariantRepresentationForInspection(union, context);
  if (representation.direct) return undefined;
  const propertyTypes = representation.alternatives.flatMap((alternative) =>
    alternative.members.map((member) => getIrObjectPropertyTypeCpp(member, expression.name, context)),
  );
  if (propertyTypes.length === 0 || propertyTypes.some((type) => !type)) return undefined;
  const emittedTypes = new Set(propertyTypes.map((type) => emitType(type!, context)));
  if (emittedTypes.size !== 1) return undefined;
  const referenceModes = new Set(
    representation.alternatives.map((alternative) =>
      hasFlightReferenceRepresentationCpp(alternative.runtimeType, context) ? 'reference' : 'value',
    ),
  );
  if (referenceModes.size !== 1) return undefined;
  context.includes.add('variant');
  const operator = referenceModes.has('reference') ? '->' : '.';
  return `std::visit([](const auto& value) { return value${operator}${safeCppName(expression.name)}; }, ${emitIdentifierReference(expression.object.reference, context)})`;
}

function emitNarrowedUnionMemberCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  context: EmitContext,
): string | undefined {
  if (expression.reference.kind !== 'binding') return undefined;
  const narrowedType = context.narrowedBindingTypes.get(expression.reference.binding.id);
  if (!expression.narrowedMember && !narrowedType) return undefined;
  const union = getIrBindingVariantUnionTypeCpp(expression.reference.binding.id, context);
  if (!union) return undefined;
  const representation = getCppVariantRepresentationForInspection(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    narrowedType
      ? doesCppVariantAlternativeMatchType(alternative, narrowedType, context)
      : alternative.members.some((member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember),
  );
  if (alternatives.length !== 1) {
    emissionError(
      context,
      `narrowed member ${expression.narrowedMember ?? 'structural switch case'} must identify one C++ variant alternative`,
    );
  }
  if (representation.direct) return emitIdentifierReference(expression.reference, context);
  return `std::get<${String(representation.alternatives.indexOf(alternatives[0]!))}>(${emitIdentifierReference(expression.reference, context)})`;
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
      runtimeType: slot.runtimeType,
      targetType: slot.targetType,
    })),
    direct: plan.kind === 'singleValue',
  };
}

function getCppVariantRepresentationForInspection(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): CppVariantRepresentation {
  return getCppVariantRepresentation(type, {
    ...context,
    anonymousStructs: new Map(),
    includes: new Set(),
  });
}

function getCppUnionRepresentationPlan(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): Exclude<ReturnType<typeof createCppUnionRepresentationPlan>, { kind: 'refused' }> {
  const plan = createCppUnionRepresentationPlan(type, {
    resolveAliasTarget(typeReference) {
      return resolveCppTypeAliasTarget(typeReference, context);
    },
    resolveRuntimeDomain(runtimeType) {
      return getIrTypeRuntimeDomainCpp(runtimeType, context, new Set());
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
  if (
    expression.kind === 'undefinedValue' ||
    (expression.kind === 'identifier' &&
      expression.reference.kind === 'ambient' &&
      expression.reference.name === 'undefined')
  ) {
    return emitCppUnionSentinelConstruction('undefined', union, plan.kind, context);
  }
  if (expression.kind === 'literal' && expression.value === null) {
    return emitCppUnionSentinelConstruction('null', union, plan.kind, context);
  }
  if (expression.kind === 'binary' && expression.operator === '??') {
    const fallback =
      expression.right.kind === 'literal' && expression.right.value === null
        ? ('null' as const)
        : expression.right.kind === 'undefinedValue' ||
            (expression.right.kind === 'identifier' &&
              expression.right.reference.kind === 'ambient' &&
              expression.right.reference.name === 'undefined')
          ? ('undefined' as const)
          : undefined;
    const leftType =
      (fallback ? getIrOptionalChainCoalescedTypeEvidenceCpp(expression.left, fallback, context) : undefined) ??
      getIrExpressionTypeEvidenceCpp(expression.left, context);
    const leftUnion = leftType ? getIrUnionTypeCpp(leftType, context, new Set()) : undefined;
    if (leftUnion) {
      const leftPlan = getCppUnionRepresentationPlan(leftUnion, context);
      if (
        hasEquivalentCppOptionalUnionRepresentation(plan, leftPlan) &&
        ((expression.right.kind === 'literal' && expression.right.value === null) ||
          expression.right.kind === 'undefinedValue')
      ) {
        return emitExpression(expression.left, context, leftType);
      }
      const rightType = getIrExpressionTypeEvidenceCpp(expression.right, context);
      const rightUnion = rightType ? getIrUnionTypeCpp(rightType, context, new Set()) : undefined;
      if (rightUnion) {
        const rightPlan = getCppUnionRepresentationPlan(rightUnion, context);
        if (
          hasEquivalentCppOptionalUnionRepresentation(plan, leftPlan) &&
          hasEquivalentCppOptionalUnionRepresentation(plan, rightPlan)
        ) {
          const unionType = emitUnionTypeCpp(union, context);
          const left = emitExpression(expression.left, context, leftType);
          const right = emitExpression(expression.right, context, rightType);
          return `([&]() -> ${unionType} { auto nullish_coalesce_left = ${left}; if (nullish_coalesce_left.has_value()) return nullish_coalesce_left; return ${right}; }())`;
        }
      }
    }
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
    const expressionPlan = getCppUnionRepresentationPlan(expressionUnion, context);
    if (hasEquivalentCppUnionRepresentation(expressionPlan, plan)) {
      return undefined;
    }
    if (expressionPlan.kind === 'singleValue' && expressionPlan.valueSlots[0]) {
      const targetSlot = plan.valueSlots.find(
        (slot) => slot.representationKey === expressionPlan.valueSlots[0]!.representationKey,
      );
      if (targetSlot) {
        return emitCppUnionValueConstruction(
          emitExpression(expression, context, expressionType, false),
          targetSlot.targetType,
          union,
          plan.kind,
          context,
        );
      }
    }
    emissionError(context, 'contextual C++ union conversion requires equivalent source union evidence');
  }
  if (expressionType.kind === 'null' || expressionType.kind === 'undefined') {
    const sentinel = expressionType.kind;
    const emitted = emitExpression(expression, context, expressionType, false);
    const absence = emitCppUnionSentinelConstruction(sentinel, union, plan.kind, context);
    const unionType = emitUnionTypeCpp(union, context);
    return `([&]() -> ${unionType} { (void)${emitted}; return ${absence}; }())`;
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
  return emitCppUnionValueConstruction(emitted, targetType, union, plan.kind, context);
}

// Optional-chain IR records the member/call value before the receiver's undefined short circuit.
// When `??` replaces that short circuit with the same literal sentinel as the contextual target,
// that value type plus the fallback is exact evidence for the coalesced representation. This lets
// nullable members such as `config?.curve ?? null` reuse the optional storage the chain already emits
// without pretending an arbitrary optional chain has lost its distinct undefined result.
function getIrOptionalChainCoalescedTypeEvidenceCpp(
  expression: Readonly<IrExpression>,
  fallback: 'null' | 'undefined',
  context: EmitContext,
): Readonly<IrType> | undefined {
  const semantics =
    expression.kind === 'call'
      ? expression.semantics.optionalChain
      : expression.kind === 'element'
        ? expression.semantics.optionalChain
        : expression.kind === 'property'
          ? expression.optionalChain
          : undefined;
  if (!semantics || semantics.valueType.kind === 'unknown') return undefined;
  const valueUnion = getIrUnionTypeCpp(semantics.valueType, context, new Set());
  const present = (valueUnion?.types ?? [semantics.valueType]).filter(
    (member) => member.kind !== 'null' && member.kind !== 'undefined',
  );
  if (!present[0]) return undefined;
  return { kind: 'union', types: [{ kind: fallback }, present[0], ...present.slice(1)] };
}

function emitCppUnionValueConstruction(
  emitted: string,
  targetType: string,
  union: Readonly<Extract<IrType, { kind: 'union' }>>,
  planKind: ReturnType<typeof getCppUnionRepresentationPlan>['kind'],
  context: EmitContext,
): string {
  if (planKind === 'singleValue') return emitted;
  if (planKind === 'optionalSingle') {
    context.includes.add('optional');
    return `std::optional<${targetType}>{${emitted}}`;
  }
  const unionType = emitUnionTypeCpp(union, context);
  if (planKind === 'optionalVariant') {
    return `${unionType}{std::in_place, std::in_place_type<${targetType}>, ${emitted}}`;
  }
  return `${unionType}{std::in_place_type<${targetType}>, ${emitted}}`;
}

function emitAsyncTaskAdoptionCpp(expression: Readonly<IrExpression>, context: EmitContext): string | undefined {
  if (!context.async) return undefined;
  const expressionType = getIrExpressionTypeEvidenceCpp(expression, context);
  if (
    expressionType?.kind !== 'named' ||
    expressionType.reference.kind !== 'ambient' ||
    expressionType.reference.name !== 'Promise'
  ) {
    return undefined;
  }
  const awaitedType = getIrTaskAwaitedTypeCpp(expressionType, context);
  const awaited = `co_await ${emitExpression(expression, context, expressionType)}`;
  const expectedType = getExpectedReturnTypeCpp(context);
  if (!expectedType) return awaited;
  const union = getIrUnionTypeCpp(expectedType, context, new Set());
  if (!union) return awaited;
  const plan = getCppUnionRepresentationPlan(union, context);
  const sourceUnion = getIrUnionTypeCpp(awaitedType, context, new Set());
  if (sourceUnion) {
    const sourcePlan = getCppUnionRepresentationPlan(sourceUnion, context);
    if (hasEquivalentCppUnionRepresentation(sourcePlan, plan)) return awaited;
    if (sourcePlan.kind === 'singleValue' && sourcePlan.valueSlots[0]) {
      const targetSlot = plan.valueSlots.find(
        (slot) => slot.representationKey === sourcePlan.valueSlots[0]!.representationKey,
      );
      if (targetSlot) {
        return emitCppUnionValueConstruction(awaited, targetSlot.targetType, union, plan.kind, context);
      }
    }
    emissionError(context, 'async task adoption requires a represented awaited union conversion');
  }
  const runtimeType = getIrTypeRuntimeDomainCpp(awaitedType, context, new Set());
  if (!runtimeType) emissionError(context, 'async task adoption requires an awaited runtime value domain');
  const targetType = emitType(runtimeType, context);
  if (!plan.valueSlots.some((slot) => slot.targetType === targetType)) {
    emissionError(context, `async task adoption value type ${targetType} is not a represented runtime domain`);
  }
  return emitCppUnionValueConstruction(awaited, targetType, union, plan.kind, context);
}

function hasEquivalentCppOptionalUnionRepresentation(
  left: ReturnType<typeof getCppUnionRepresentationPlan>,
  right: ReturnType<typeof getCppUnionRepresentationPlan>,
): boolean {
  return (
    (left.kind === 'optionalSingle' || left.kind === 'optionalVariant') &&
    hasEquivalentCppUnionRepresentation(left, right)
  );
}

function hasEquivalentCppUnionRepresentation(
  left: ReturnType<typeof getCppUnionRepresentationPlan>,
  right: ReturnType<typeof getCppUnionRepresentationPlan>,
): boolean {
  return (
    left.kind === right.kind &&
    left.valueSlots.length === right.valueSlots.length &&
    left.valueSlots.every((slot, index) => slot.representationKey === right.valueSlots[index]?.representationKey)
  );
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
    case 'element':
      return getIrExpressionTypeEvidenceCpp(expression, context);
    case 'property':
      return getIrExpressionTypeEvidenceCpp(expression, context);
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
      return getIrIdentifierTypeEvidenceCpp(expression, context);
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
  if (type.kind === 'intersection') {
    const erasedValue = getCppErasedIntersectionValueType(type, context);
    return erasedValue ? getIrTypeRuntimeDomainCpp(erasedValue, context, resolvingAliases) : type;
  }
  if (type.kind === 'keyof') {
    const keyType = getCppKeyofType(type.type, context);
    return keyType ? getIrTypeRuntimeDomainCpp(keyType, context, resolvingAliases) : undefined;
  }
  if (type.kind === 'typeOf') {
    const valueType = getCppTypeOfValueType(type, context);
    return valueType ? getIrTypeRuntimeDomainCpp(valueType, context, resolvingAliases) : undefined;
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.typeArguments.length > 0) return type;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return type;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return type;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getIrTypeRuntimeDomainCpp(alias, context, nextResolvingAliases);
}

function resolveCppTypeAliasTarget(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return context.referenceRepresentationPlanner.resolveAlias(type, context.module);
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
  if (expression.callee.kind === 'function') return expression.callee.returns;
  if (expression.callee.kind === 'property' && expression.callee.optionalChain) {
    const returns = getCppCallableReturnType(expression.callee.optionalChain.valueType, context, new Set());
    if (returns) {
      return expression.callee.optionalChain.receiverNullish === 'possible'
        ? { kind: 'union', types: [returns, { kind: 'undefined' }] }
        : returns;
    }
  }
  if (expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding') {
    const declaration = getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context);
    if (declaration) {
      if (declaration.typeParameters.length === 0) return declaration.returns;
      if (declaration.typeParameters.length === expression.typeArguments.length) {
        return resolveIrTypeStructuralSubstitution(
          declaration.returns,
          createIrTypeParameterSubstitutionPlan(declaration.typeParameters, expression.typeArguments),
        );
      }
    }
  }
  if (expression.semantics.resultType.kind !== 'unknown') return expression.semantics.resultType;
  const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
  return calleeType ? getCppCallableReturnType(calleeType, context, new Set()) : undefined;
}

function getCppFunctionDeclarationForBindingCpp(
  bindingId: string,
  context: EmitContext,
): Readonly<IrFunctionDeclaration> | undefined {
  const local = context.module.declarations.find(
    (candidate): candidate is IrFunctionDeclaration =>
      candidate.kind === 'function' && candidate.binding.id === bindingId,
  );
  if (local) return local;
  const imported = context.module.imports.flatMap((importItem) => {
    const binding = importItem.bindings.find(
      (candidate) => candidate.binding.id === bindingId && candidate.imported !== '*',
    );
    if (!binding || binding.imported === '*') return [];
    return getCppResolvedImportModules(importItem.specifier, context).flatMap((module) => {
      const directBindingIds = new Set([
        ...module.declarations.flatMap((declaration) =>
          'binding' in declaration && declaration.exported && declaration.binding.name === binding.imported
            ? [declaration.binding.id]
            : [],
        ),
        ...module.exports.flatMap((exported) =>
          exported.kind === 'local' && exported.exported === binding.imported ? [exported.binding.id] : [],
        ),
      ]);
      return module.declarations.filter(
        (declaration): declaration is IrFunctionDeclaration =>
          declaration.kind === 'function' && directBindingIds.has(declaration.binding.id),
      );
    });
  });
  const unique = new Map(imported.map((declaration) => [declaration.binding.id, declaration]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function emitArrayFromMapKeysCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
): string | undefined {
  if (
    getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
    expression.callee.kind !== 'property' ||
    expression.callee.object.kind !== 'identifier' ||
    expression.callee.object.reference.kind !== 'ambient' ||
    expression.callee.object.reference.name !== 'Array' ||
    expression.callee.name !== 'from' ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  const keysCall = expression.arguments[0];
  if (
    keysCall?.kind !== 'call' ||
    keysCall.arguments.length !== 0 ||
    keysCall.callee.kind !== 'property' ||
    keysCall.callee.name !== 'keys'
  ) {
    return undefined;
  }
  const mapType = getIrExpressionTypeEvidenceCpp(keysCall.callee.object, context);
  if (
    mapType?.kind !== 'named' ||
    mapType.reference.kind !== 'ambient' ||
    (mapType.reference.name !== 'Map' && mapType.reference.name !== 'ReadonlyMap') ||
    !mapType.typeArguments[0]
  ) {
    return undefined;
  }
  const elementType = expectedType?.kind === 'array' ? expectedType.element : mapType.typeArguments[0];
  const arrayType = `flight::Array<${emitType(elementType, context)}>`;
  const result = getGeneratedTargetName('array_from_result', context);
  const key = getGeneratedTargetName('array_from_key', context);
  const value = getGeneratedTargetName('array_from_value', context);
  const map = emitExpression(keysCall.callee.object, context);
  return `([&]() { ${arrayType} ${result}; for (const auto& [${key}, ${value}] : ${map}) { static_cast<void>(${value}); ${result}.push(${key}); } return ${result}; }())`;
}

function getCppCallableReturnType(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  if (type.kind === 'function') return type.returns;
  if (type.kind === 'union') {
    const callable = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    return callable.length === 1 ? getCppCallableReturnType(callable[0]!, context, resolvingAliases) : undefined;
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return undefined;
  const target = resolveCppTypeAliasTarget(type, context);
  if (!target) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getCppCallableReturnType(target, context, nextResolvingAliases);
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
  if (type.kind === 'object') {
    return getIrObjectPropertyReadTypeCpp(type.properties.find((property) => property.name === propertyName));
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Record' &&
    type.typeArguments.length === 2
  ) {
    return type.typeArguments[1];
  }
  const objectShape = context.referenceRepresentationPlanner.resolveObjectShape(type, context.module);
  if (objectShape) {
    return getIrObjectPropertyReadTypeCpp(objectShape.find((property) => property.name === propertyName));
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const bindingId = type.reference.binding.id;
  const declaration = context.module.declarations.find(
    (candidate) =>
      (candidate.kind === 'class' || candidate.kind === 'interface' || candidate.kind === 'typeAlias') &&
      candidate.binding.id === bindingId,
  );
  if (declaration?.kind === 'class') {
    const field = declaration.fields.find((candidate) => candidate.name === propertyName);
    const propertyType = field
      ? getIrObjectPropertyReadTypeCpp(field)
      : declaration.methods.find((candidate) => candidate.name === propertyName && candidate.accessor === 'get')
          ?.returns;
    return propertyType
      ? resolveIrTypeStructuralSubstitution(
          propertyType,
          createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments),
        )
      : undefined;
  }
  if (declaration?.kind === 'interface') {
    const propertyType = getIrObjectPropertyReadTypeCpp(
      declaration.properties.find((property) => property.name === propertyName),
    );
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

function getIrObjectPropertyReadTypeCpp(
  property: Readonly<{ optional: boolean; type: IrType }> | undefined,
): Readonly<IrType> | undefined {
  if (!property) return undefined;
  if (!property.optional) return property.type;
  if (
    property.type.kind === 'undefined' ||
    (property.type.kind === 'union' && property.type.types.some((member) => member.kind === 'undefined'))
  ) {
    return property.type;
  }
  return property.type.kind === 'union'
    ? {
        kind: 'union',
        types: [property.type.types[0], property.type.types[1], ...property.type.types.slice(2), { kind: 'undefined' }],
      }
    : { kind: 'union', types: [property.type, { kind: 'undefined' }] };
}

function emitComputedSymbolElementAccessCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string | undefined {
  const property = getComputedSymbolElementPropertyCpp(expression, context);
  return property
    ? `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${safeCppName(property.name)}`
    : undefined;
}

function getComputedSymbolElementPropertyCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): Readonly<IrObjectTypeProperty> | undefined {
  if (expression.semantics.key !== 'symbol') return undefined;
  const key = getIrExpressionValueNameReferenceCpp(expression.index);
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  if (!key || !objectType) return undefined;
  const properties =
    objectType.kind === 'object'
      ? objectType.properties
      : context.referenceRepresentationPlanner.resolveObjectShape(objectType, context.module);
  if (!properties) return undefined;
  const keyName = getCppComputedPropertySourceName(key, context);
  const matches = properties.filter(
    (property) => property.computedKey && getCppComputedPropertySourceName(property.computedKey, context) === keyName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function getIrExpressionValueNameReferenceCpp(
  expression: Readonly<IrExpression>,
): Readonly<IrValueNameReference> | undefined {
  if (expression.kind === 'identifier') {
    if (expression.reference.kind === 'binding') {
      return { binding: expression.reference.binding, kind: 'binding', path: [] };
    }
    if (expression.reference.kind === 'ambient') return expression.reference;
  }
  return expression.kind === 'property' ? expression.namespaceMember : undefined;
}

function getCppComputedPropertySourceName(reference: Readonly<IrValueNameReference>, context: EmitContext): string {
  if (reference.kind === 'ambient') return reference.name;
  if (reference.binding.kind === 'import') {
    for (const importItem of context.module.imports) {
      const imported = importItem.bindings.find((candidate) => candidate.binding.id === reference.binding.id);
      if (imported && imported.imported !== '*') return [imported.imported, ...reference.path].join('.');
    }
  }
  return [reference.binding.name, ...reference.path].join('.');
}

function getCppBindingTypeCpp(bindingId: string, context: EmitContext): Readonly<IrType> | undefined {
  return context.preservedInitializerTypes.get(bindingId) ?? context.bindingTypes.get(bindingId);
}

function getIrNewExpressionTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  context: EmitContext,
): Readonly<Extract<IrType, { kind: 'named' }>> | undefined {
  if (expression.callee.kind !== 'identifier') return undefined;
  if (expression.callee.reference.kind === 'binding') {
    return {
      kind: 'named',
      reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
      typeArguments: expression.typeArguments,
    };
  }
  if (expression.callee.reference.kind !== 'ambient') return undefined;
  const name = expression.callee.reference.name;
  if (expression.typeArguments.length > 0) {
    return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments: expression.typeArguments };
  }
  const argumentType = expression.arguments[0]
    ? getIrExpressionTypeEvidenceCpp(expression.arguments[0], context)
    : undefined;
  const elementType = argumentType ? getIrIterableElementTypeCpp(argumentType, context, new Set()) : undefined;
  if (name === 'Set' && elementType) {
    return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments: [elementType] };
  }
  const tuple = elementType ? getIrTupleTypeCpp(elementType, context, new Set()) : undefined;
  if (name === 'Map' && tuple?.elements.length === 2) {
    return {
      kind: 'named',
      reference: { kind: 'ambient', name },
      typeArguments: [tuple.elements[0]!.type, tuple.elements[1]!.type],
    };
  }
  return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments: [] };
}

function getIrExpressionTypeEvidenceCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'array': {
      const spreadElement = expression.elements.flatMap((element): readonly IrType[] => {
        if (element?.kind !== 'spread') return [];
        const view = getCppCollectionIterationView(element.expression, context);
        if (view) return [view.elementType];
        const operandType = getIrExpressionTypeEvidenceCpp(element.expression, context);
        const iterableElement = operandType ? getIrIterableElementTypeCpp(operandType, context, new Set()) : undefined;
        return iterableElement ? [iterableElement] : [];
      })[0];
      if (spreadElement) return { element: spreadElement, kind: 'array', readonly: false };
      const elementTypes = expression.elements.flatMap((element): readonly IrType[] => {
        if (!element) return [];
        const type = getIrExpressionTypeForUnionConstructionCpp(element, [], context);
        return type ? [type] : [];
      });
      if (elementTypes.length !== expression.elements.length || !elementTypes[0]) return undefined;
      const runtimeTypes = elementTypes.map((type) => getIrTypeRuntimeDomainCpp(type, context, new Set()));
      const first = runtimeTypes[0];
      if (
        !first ||
        runtimeTypes.some(
          (type) =>
            !type ||
            normalizeCompilerStructuralValueCanonical(type) !== normalizeCompilerStructuralValueCanonical(first),
        )
      ) {
        return undefined;
      }
      return { element: first, kind: 'array', readonly: false };
    }
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
          typeArguments: context.currentClass.typeParameters.map((parameter) => ({
            kind: 'named',
            reference: { binding: parameter.binding, kind: 'binding', path: [] },
            typeArguments: [],
          })),
        };
      }
      return getIrIdentifierTypeEvidenceCpp(expression, context);
    }
    case 'new':
      return getIrNewExpressionTypeEvidenceCpp(expression, context);
    case 'object': {
      if (expression.type.kind === 'unknown' && expression.members.length === 1) {
        const member = expression.members[0];
        if (member?.kind === 'spread') {
          const spreadType = getIrExpressionTypeEvidenceCpp(member.expression, context);
          if (spreadType) return spreadType;
        }
      }
      return expression.type;
    }
    case 'element': {
      const computedSymbol = getComputedSymbolElementPropertyCpp(expression, context);
      if (computedSymbol) return computedSymbol.type;
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      return objectType ? getIrIndexedElementTypeCpp(objectType, expression, context, new Set()) : undefined;
    }
    case 'property': {
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'this') {
        const memberType =
          context.currentClass?.fields.find((field) => field.name === expression.name)?.type ??
          context.currentClass?.methods.find((method) => method.name === expression.name && method.accessor === 'get')
            ?.returns;
        if (memberType) return memberType;
      }
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      return objectType ? getIrObjectPropertyTypeCpp(objectType, expression.name, context) : undefined;
    }
    case 'binary':
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

function getIrIdentifierTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.reference.kind !== 'binding') return undefined;
  const bindingId = expression.reference.binding.id;
  const declaredType = getCppBindingTypeCpp(bindingId, context);
  const narrowedType = context.narrowedBindingTypes.get(bindingId);
  if (narrowedType) return narrowedType;
  if (!declaredType) return undefined;
  const union = getIrUnionTypeCpp(declaredType, context, new Set());
  if (expression.presence === 'narrowedPresent' && union) {
    const present = union.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    if (present.length === 1) return present[0];
  }
  if (!expression.narrowedMember) return declaredType;
  return union?.types.find((member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember) ?? declaredType;
}

function getIrIndexedElementTypeCpp(
  type: Readonly<IrType>,
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  if (type.kind === 'array') return type.element;
  if (type.kind === 'tuple') {
    if (expression.index.kind !== 'literal' || typeof expression.index.value !== 'number') return undefined;
    return type.elements[expression.index.value]?.type;
  }
  if (type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') {
    if (
      (type.reference.name === 'Array' || type.reference.name === 'ReadonlyArray') &&
      type.typeArguments.length === 1
    ) {
      return type.typeArguments[0];
    }
    if (type.reference.name === 'Record' && type.typeArguments.length === 2) return type.typeArguments[1];
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getIrIndexedElementTypeCpp(alias, expression, context, nextResolvingAliases);
}

function getIrBindingVariantUnionTypeCpp(
  bindingId: string,
  context: EmitContext,
): Extract<IrType, { kind: 'union' }> | undefined {
  const type = getCppBindingTypeCpp(bindingId, context);
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
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
  if (seen.has(key)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  return getIrUnionTypeCpp(alias, context, nextSeen);
}

function getIrUnionMemberNameCpp(type: Readonly<IrType>): string | undefined {
  if (type.kind === 'primitive') return type.name;
  if (type.kind !== 'named') return undefined;
  return type.reference.kind === 'binding' ? type.reference.binding.name : type.reference.name;
}

function orderIrModuleDeclarationsCpp(module: Readonly<IrModule>): readonly Readonly<IrDeclaration>[] {
  // Source order is the module-evaluation order for variables, classes, enums, and side-effect
  // carriers. Move a later declaration only when an earlier declaration actually depends on it.
  const ranked = [...module.declarations];
  const declarationsByBindingId = new Map(
    module.declarations.flatMap((declaration) =>
      'binding' in declaration ? [[declaration.binding.id, declaration] as const] : [],
    ),
  );
  const dependencies = new Map<Readonly<IrDeclaration>, ReadonlySet<Readonly<IrDeclaration>>>();
  for (const declaration of module.declarations) {
    const referenced = new Set<Readonly<IrDeclaration>>();
    const addBindingDependency = (bindingId: string) => {
      const dependency = declarationsByBindingId.get(bindingId);
      if (dependency && dependency !== declaration) referenced.add(dependency);
    };
    analyzeIrModuleTraversal(
      { ...module, declarations: [declaration], exports: [] },
      {
        expression(expression) {
          if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
            addBindingDependency(expression.reference.binding.id);
          }
        },
        type(type) {
          if (type.kind === 'named' && type.reference.kind === 'binding') {
            addBindingDependency(type.reference.binding.id);
          }
        },
      },
    );
    dependencies.set(declaration, referenced);
  }

  const pending = new Set(ranked);
  const ordered: Readonly<IrDeclaration>[] = [];
  while (pending.size > 0) {
    const next =
      ranked.find(
        (declaration) =>
          pending.has(declaration) &&
          [...(dependencies.get(declaration) ?? [])].every((dependency) => !pending.has(dependency)),
      ) ?? ranked.find((declaration) => pending.has(declaration));
    if (!next) break;
    pending.delete(next);
    ordered.push(next);
  }
  return ordered;
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
      if (!type || type.kind === 'unknown') continue;
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

// A sized JavaScript Array begins sparse, while flight::Array is dense. Permit the sized form only
// when the source itself proves that every slot is overwritten by contiguous writes before the array
// can be observed. The proof is intentionally narrow: it covers lookup-table builders without turning
// an arbitrary sparse allocation into a default-filled array.
function collectIrModuleDenseArrayLengthBindingIdsCpp(module: Readonly<IrModule>): ReadonlySet<string> {
  const immutableBindingIds = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && !variable.mutable) immutableBindingIds.add(variable.binding.id);
    },
  });
  const result = new Set<string>();
  const inspectStatements = (statements: readonly Readonly<IrStatement>[]): void => {
    statements.forEach((statement, statementIndex) => {
      if (statement.kind === 'variable') {
        for (const variable of statement.declarations) {
          if ('binding' in variable && variable.initializer) {
            const length = getDenseArrayLengthExpressionCpp(variable.initializer);
            if (
              length &&
              hasCompleteDenseArrayWritesCpp(
                variable.binding.id,
                length,
                immutableBindingIds,
                statements.slice(statementIndex + 1),
              )
            ) {
              result.add(variable.binding.id);
            }
          }
        }
      }
      switch (statement.kind) {
        case 'block':
          inspectStatements(statement.statements);
          break;
        case 'do':
        case 'for':
        case 'forIn':
        case 'forOf':
        case 'while':
          inspectStatements(statement.body.kind === 'block' ? statement.body.statements : [statement.body]);
          break;
        case 'if':
          inspectStatements(
            statement.consequent.kind === 'block' ? statement.consequent.statements : [statement.consequent],
          );
          if (statement.otherwise) {
            inspectStatements(
              statement.otherwise.kind === 'block' ? statement.otherwise.statements : [statement.otherwise],
            );
          }
          break;
        case 'switch':
          for (const switchCase of statement.cases) inspectStatements(switchCase.statements);
          break;
        case 'try':
          inspectStatements(statement.tryBody.kind === 'block' ? statement.tryBody.statements : [statement.tryBody]);
          if (statement.catchClause) {
            inspectStatements(
              statement.catchClause.body.kind === 'block'
                ? statement.catchClause.body.statements
                : [statement.catchClause.body],
            );
          }
          if (statement.finallyBody) {
            inspectStatements(
              statement.finallyBody.kind === 'block' ? statement.finallyBody.statements : [statement.finallyBody],
            );
          }
          break;
        case 'break':
        case 'continue':
        case 'expression':
        case 'return':
        case 'throw':
          break;
      }
    });
  };
  for (const declaration of module.declarations) {
    if (declaration.kind === 'function') inspectStatements(declaration.body);
    if (declaration.kind === 'class') {
      if (declaration.classConstructor) inspectStatements(declaration.classConstructor.body);
      for (const method of declaration.methods) inspectStatements(method.body);
    }
  }
  return result;
}

function getDenseArrayLengthExpressionCpp(expression: Readonly<IrExpression>): Readonly<IrExpression> | undefined {
  const candidate = expression.kind === 'binary' && expression.operator === '??' ? expression.right : expression;
  return candidate.kind === 'new' &&
    candidate.callee.kind === 'identifier' &&
    candidate.callee.reference.kind === 'ambient' &&
    candidate.callee.reference.name === 'Array' &&
    candidate.arguments.length === 1
    ? candidate.arguments[0]
    : undefined;
}

function hasCompleteDenseArrayWritesCpp(
  arrayBindingId: string,
  length: Readonly<IrExpression>,
  immutableBindingIds: ReadonlySet<string>,
  statements: readonly Readonly<IrStatement>[],
): boolean {
  const literalLength = getNonnegativeIntegerLiteralCpp(length);
  if (literalLength === undefined) {
    const first = statements[0];
    return Boolean(
      (first &&
        getDenseArrayWholeWriteLoopStrideCpp(first, arrayBindingId, length, immutableBindingIds) !== undefined) ||
      hasDenseArrayNestedSequentialWritesCpp(arrayBindingId, length, immutableBindingIds, statements),
    );
  }
  let nextIndex = 0;
  for (const statement of statements) {
    const directIndex = getDenseArrayDirectWriteIndexCpp(statement, arrayBindingId);
    if (directIndex !== undefined) {
      if (directIndex !== nextIndex) return false;
      nextIndex += 1;
    } else {
      const range = getDenseArrayWriteLoopRangeCpp(statement, arrayBindingId);
      if (!range || range.start !== nextIndex || range.end > literalLength) return false;
      nextIndex = range.end;
    }
    if (nextIndex === literalLength) return true;
  }
  return false;
}

interface DenseArrayNestedSequentialWriteProof {
  readonly bounds: readonly IrExpression[];
  readonly writesPerIteration: number;
}

function hasDenseArrayNestedSequentialWritesCpp(
  arrayBindingId: string,
  length: Readonly<IrExpression>,
  immutableBindingIds: ReadonlySet<string>,
  statements: readonly Readonly<IrStatement>[],
): boolean {
  for (const [counterStatementIndex, counterStatement] of statements.entries()) {
    if (doesIrStatementReferenceBindingCpp(counterStatement, arrayBindingId)) return false;
    if (counterStatement.kind !== 'variable') continue;
    const counters = counterStatement.declarations.filter(
      (variable) =>
        'binding' in variable &&
        variable.mutable &&
        variable.initializer !== undefined &&
        getNonnegativeIntegerLiteralCpp(variable.initializer) === 0,
    );
    for (const counter of counters) {
      if (!('binding' in counter)) continue;
      for (const statement of statements.slice(counterStatementIndex + 1)) {
        const proof = getDenseArrayNestedSequentialWriteProofCpp(
          statement,
          arrayBindingId,
          counter.binding.id,
          immutableBindingIds,
        );
        if (proof) return hasEquivalentDenseArrayProductCpp(length, proof.bounds, proof.writesPerIteration);
        if (
          doesIrStatementReferenceBindingCpp(statement, arrayBindingId) ||
          doesIrStatementReferenceBindingCpp(statement, counter.binding.id)
        ) {
          break;
        }
      }
    }
  }
  return false;
}

function getDenseArrayNestedSequentialWriteProofCpp(
  statement: Readonly<IrStatement>,
  arrayBindingId: string,
  counterBindingId: string,
  immutableBindingIds: ReadonlySet<string>,
): DenseArrayNestedSequentialWriteProof | undefined {
  const loop = getDenseArrayCanonicalLoopCpp(statement, immutableBindingIds);
  if (!loop) return undefined;
  const body = statement.kind === 'for' && statement.body.kind === 'block' ? statement.body.statements : [loop.body];
  let nested: DenseArrayNestedSequentialWriteProof | undefined;
  let writesPerIteration = 0;
  for (const bodyStatement of body) {
    if (isDenseArraySequentialWriteCpp(bodyStatement, arrayBindingId, counterBindingId)) {
      if (nested) return undefined;
      writesPerIteration += 1;
      continue;
    }
    const referencesArray = doesIrStatementReferenceBindingCpp(bodyStatement, arrayBindingId);
    const referencesCounter = doesIrStatementReferenceBindingCpp(bodyStatement, counterBindingId);
    if (!referencesArray && !referencesCounter) {
      if (doesIrStatementContainLoopControlCpp(bodyStatement)) return undefined;
      continue;
    }
    if (nested || writesPerIteration > 0) return undefined;
    nested = getDenseArrayNestedSequentialWriteProofCpp(
      bodyStatement,
      arrayBindingId,
      counterBindingId,
      immutableBindingIds,
    );
    if (!nested) return undefined;
  }
  if (nested)
    return {
      bounds: [loop.bound, ...nested.bounds],
      writesPerIteration: nested.writesPerIteration,
    };
  return writesPerIteration > 0 ? { bounds: [loop.bound], writesPerIteration } : undefined;
}

function getDenseArrayCanonicalLoopCpp(
  statement: Readonly<IrStatement>,
  immutableBindingIds: ReadonlySet<string>,
): Readonly<{ body: IrStatement; bound: IrExpression }> | undefined {
  if (statement.kind !== 'for' || !Array.isArray(statement.initializer) || statement.initializer.length !== 1) {
    return undefined;
  }
  const index = statement.initializer[0]!;
  const condition = statement.condition;
  const increment = statement.increment;
  if (
    !('binding' in index) ||
    !index.initializer ||
    getNonnegativeIntegerLiteralCpp(index.initializer) !== 0 ||
    !condition ||
    condition.kind !== 'binary' ||
    condition.operator !== '<' ||
    !isIrBindingIdentifierCpp(condition.left, index.binding.id) ||
    !isStableDenseArrayBoundCpp(condition.right, immutableBindingIds) ||
    !increment ||
    increment.kind !== 'unary' ||
    increment.operator !== '++' ||
    !isIrBindingIdentifierCpp(increment.operand, index.binding.id)
  ) {
    return undefined;
  }
  return { body: statement.body, bound: condition.right };
}

function isDenseArraySequentialWriteCpp(
  statement: Readonly<IrStatement>,
  arrayBindingId: string,
  counterBindingId: string,
): boolean {
  if (
    statement.kind !== 'expression' ||
    statement.expression.kind !== 'assignment' ||
    statement.expression.operator !== '=' ||
    statement.expression.left.kind !== 'element' ||
    !isIrBindingIdentifierCpp(statement.expression.left.object, arrayBindingId)
  ) {
    return false;
  }
  const index = statement.expression.left.index;
  return (
    index.kind === 'unary' &&
    index.operator === '++' &&
    index.postfix &&
    isIrBindingIdentifierCpp(index.operand, counterBindingId) &&
    !doesIrExpressionReferenceBindingCpp(statement.expression.right, arrayBindingId) &&
    !doesIrExpressionReferenceBindingCpp(statement.expression.right, counterBindingId)
  );
}

function hasEquivalentDenseArrayProductCpp(
  length: Readonly<IrExpression>,
  bounds: readonly Readonly<IrExpression>[],
  writesPerIteration: number,
): boolean {
  const split = (expression: Readonly<IrExpression>): readonly Readonly<IrExpression>[] =>
    expression.kind === 'binary' && expression.operator === '*'
      ? [...split(expression.left), ...split(expression.right)]
      : [expression];
  const normalize = (factors: readonly Readonly<IrExpression>[], scalar: number) => {
    let literal = scalar;
    const dynamic: Readonly<IrExpression>[] = [];
    for (const factor of factors) {
      const value = getNonnegativeIntegerLiteralCpp(factor);
      if (value === undefined) dynamic.push(factor);
      else literal *= value;
    }
    return { dynamic, literal };
  };
  const actual = normalize(split(length), 1);
  const expected = normalize(bounds, writesPerIteration);
  if (actual.literal !== expected.literal || actual.dynamic.length !== expected.dynamic.length) return false;
  const unmatched = [...actual.dynamic];
  for (const factor of expected.dynamic) {
    const index = unmatched.findIndex((candidate) => isEquivalentDenseArrayBoundCpp(candidate, factor));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function getDenseArrayDirectWriteIndexCpp(
  statement: Readonly<IrStatement>,
  arrayBindingId: string,
): number | undefined {
  if (
    statement.kind !== 'expression' ||
    statement.expression.kind !== 'assignment' ||
    statement.expression.operator !== '=' ||
    statement.expression.left.kind !== 'element' ||
    !isIrBindingIdentifierCpp(statement.expression.left.object, arrayBindingId) ||
    doesIrExpressionReferenceBindingCpp(statement.expression.right, arrayBindingId)
  ) {
    return undefined;
  }
  return getNonnegativeIntegerLiteralCpp(statement.expression.left.index);
}

function getDenseArrayWriteLoopRangeCpp(
  statement: Readonly<IrStatement>,
  arrayBindingId: string,
): Readonly<{ end: number; start: number }> | undefined {
  if (statement.kind !== 'for' || !Array.isArray(statement.initializer) || statement.initializer.length !== 1) {
    return undefined;
  }
  const index = statement.initializer[0]!;
  if (!('binding' in index) || !index.initializer) return undefined;
  const start = getNonnegativeIntegerLiteralCpp(index.initializer);
  const condition = statement.condition;
  const increment = statement.increment;
  if (
    start === undefined ||
    !condition ||
    condition.kind !== 'binary' ||
    condition.operator !== '<' ||
    !isIrBindingIdentifierCpp(condition.left, index.binding.id) ||
    !increment ||
    increment.kind !== 'unary' ||
    increment.operator !== '++' ||
    !isIrBindingIdentifierCpp(increment.operand, index.binding.id)
  ) {
    return undefined;
  }
  const end = getNonnegativeIntegerLiteralCpp(condition.right);
  const body =
    statement.body.kind === 'block' && statement.body.statements.length === 1
      ? statement.body.statements[0]!
      : statement.body;
  if (
    end === undefined ||
    body.kind !== 'expression' ||
    body.expression.kind !== 'assignment' ||
    body.expression.operator !== '=' ||
    body.expression.left.kind !== 'element' ||
    !isIrBindingIdentifierCpp(body.expression.left.object, arrayBindingId) ||
    !isIrBindingIdentifierCpp(body.expression.left.index, index.binding.id) ||
    doesIrExpressionReferenceBindingCpp(body.expression.right, arrayBindingId)
  ) {
    return undefined;
  }
  return { end, start };
}

function getDenseArrayWholeWriteLoopStrideCpp(
  statement: Readonly<IrStatement>,
  arrayBindingId: string,
  length: Readonly<IrExpression>,
  immutableBindingIds: ReadonlySet<string>,
): number | undefined {
  if (statement.kind !== 'for' || !Array.isArray(statement.initializer) || statement.initializer.length !== 1) {
    return undefined;
  }
  const index = statement.initializer[0]!;
  const condition = statement.condition;
  const increment = statement.increment;
  if (
    !('binding' in index) ||
    !index.initializer ||
    getNonnegativeIntegerLiteralCpp(index.initializer) !== 0 ||
    !condition ||
    condition.kind !== 'binary' ||
    condition.operator !== '<' ||
    !isIrBindingIdentifierCpp(condition.left, index.binding.id) ||
    !increment ||
    increment.kind !== 'unary' ||
    increment.operator !== '++' ||
    !isIrBindingIdentifierCpp(increment.operand, index.binding.id)
  ) {
    return undefined;
  }
  const stride = getDenseArrayLengthStrideCpp(length, condition.right, immutableBindingIds);
  if (stride === undefined) return undefined;
  const offsets = new Set<number>();
  const body = statement.body.kind === 'block' ? statement.body.statements : [statement.body];
  for (const bodyStatement of body) {
    if (
      bodyStatement.kind === 'expression' &&
      bodyStatement.expression.kind === 'assignment' &&
      bodyStatement.expression.operator === '=' &&
      bodyStatement.expression.left.kind === 'element' &&
      isIrBindingIdentifierCpp(bodyStatement.expression.left.object, arrayBindingId) &&
      !doesIrExpressionReferenceBindingCpp(bodyStatement.expression.right, arrayBindingId)
    ) {
      const offset = getDenseArrayWriteOffsetCpp(bodyStatement.expression.left.index, index.binding.id, stride);
      if (offset === undefined || offsets.has(offset)) return undefined;
      offsets.add(offset);
      continue;
    }
    if (!isDenseArrayWholeWriteLoopPreludeCpp(bodyStatement, arrayBindingId)) {
      return undefined;
    }
  }
  return offsets.size === stride ? stride : undefined;
}

function isDenseArrayWholeWriteLoopPreludeCpp(statement: Readonly<IrStatement>, arrayBindingId: string): boolean {
  return (
    statement.kind === 'variable' &&
    statement.declarations.every(
      (variable) =>
        'pattern' in variable &&
        variable.initializer?.kind === 'call' &&
        variable.initializer.callee.kind === 'identifier' &&
        variable.initializer.callee.reference.kind === 'binding' &&
        variable.initializer.callee.reference.binding.kind === 'parameter' &&
        !doesIrStatementReferenceBindingCpp(statement, arrayBindingId),
    )
  );
}

function getDenseArrayLengthStrideCpp(
  length: Readonly<IrExpression>,
  bound: Readonly<IrExpression>,
  immutableBindingIds: ReadonlySet<string>,
): number | undefined {
  if (!isStableDenseArrayBoundCpp(bound, immutableBindingIds)) return undefined;
  if (isEquivalentDenseArrayBoundCpp(length, bound)) return 1;
  if (length.kind !== 'binary' || length.operator !== '*') return undefined;
  const leftStride = getPositiveIntegerLiteralCpp(length.left);
  if (leftStride !== undefined && isEquivalentDenseArrayBoundCpp(length.right, bound)) return leftStride;
  const rightStride = getPositiveIntegerLiteralCpp(length.right);
  return rightStride !== undefined && isEquivalentDenseArrayBoundCpp(length.left, bound) ? rightStride : undefined;
}

function getDenseArrayWriteOffsetCpp(
  expression: Readonly<IrExpression>,
  indexBindingId: string,
  stride: number,
): number | undefined {
  if (stride === 1 && isIrBindingIdentifierCpp(expression, indexBindingId)) return 0;
  const base = expression.kind === 'binary' && expression.operator === '+' ? expression.left : expression;
  const offset =
    expression.kind === 'binary' && expression.operator === '+' ? getNonnegativeIntegerLiteralCpp(expression.right) : 0;
  if (
    offset === undefined ||
    offset >= stride ||
    base.kind !== 'binary' ||
    base.operator !== '*' ||
    !isIrBindingIdentifierCpp(base.left, indexBindingId) ||
    getPositiveIntegerLiteralCpp(base.right) !== stride
  ) {
    return undefined;
  }
  return offset;
}

function isStableDenseArrayBoundCpp(
  expression: Readonly<IrExpression>,
  immutableBindingIds: ReadonlySet<string>,
): boolean {
  return (
    getNonnegativeIntegerLiteralCpp(expression) !== undefined ||
    (expression.kind === 'identifier' &&
      expression.reference.kind === 'binding' &&
      immutableBindingIds.has(expression.reference.binding.id))
  );
}

function isEquivalentDenseArrayBoundCpp(left: Readonly<IrExpression>, right: Readonly<IrExpression>): boolean {
  const leftLiteral = getNonnegativeIntegerLiteralCpp(left);
  const rightLiteral = getNonnegativeIntegerLiteralCpp(right);
  if (leftLiteral !== undefined || rightLiteral !== undefined) return leftLiteral === rightLiteral;
  return (
    left.kind === 'identifier' &&
    left.reference.kind === 'binding' &&
    right.kind === 'identifier' &&
    right.reference.kind === 'binding' &&
    left.reference.binding.id === right.reference.binding.id
  );
}

function doesIrExpressionReferenceBindingCpp(expression: Readonly<IrExpression>, bindingId: string): boolean {
  let referencesBinding = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (isIrBindingIdentifierCpp(candidate, bindingId)) referencesBinding = true;
      return referencesBinding ? false : undefined;
    },
  });
  return referencesBinding;
}

function doesIrStatementReferenceBindingCpp(statement: Readonly<IrStatement>, bindingId: string): boolean {
  let referencesBinding = false;
  analyzeIrStatementSubtreeTraversal(statement, {
    expression(candidate) {
      if (isIrBindingIdentifierCpp(candidate, bindingId)) referencesBinding = true;
      return referencesBinding ? false : undefined;
    },
  });
  return referencesBinding;
}

function doesIrStatementContainLoopControlCpp(statement: Readonly<IrStatement>): boolean {
  let containsLoopControl = false;
  analyzeIrStatementSubtreeTraversal(statement, {
    statement(candidate) {
      if (candidate.kind === 'break' || candidate.kind === 'continue') containsLoopControl = true;
      return containsLoopControl ? false : undefined;
    },
  });
  return containsLoopControl;
}

function getPositiveIntegerLiteralCpp(expression: Readonly<IrExpression>): number | undefined {
  const value = getNonnegativeIntegerLiteralCpp(expression);
  return value !== undefined && value > 0 ? value : undefined;
}

function getNonnegativeIntegerLiteralCpp(expression: Readonly<IrExpression>): number | undefined {
  return expression.kind === 'literal' &&
    typeof expression.value === 'number' &&
    Number.isSafeInteger(expression.value) &&
    expression.value >= 0
    ? expression.value
    : undefined;
}

function isIrBindingIdentifierCpp(expression: Readonly<IrExpression>, bindingId: string): boolean {
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    expression.reference.binding.id === bindingId
  );
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

function emitSharedCaptureCellConstructionCpp(
  type: string,
  initial: string,
  context: EmitContext,
  initializedRuntimeValue = false,
): string {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
    return `flight::make_binding_cell(${initializedRuntimeValue ? initial : `${type}{${initial}}`})`;
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
  return getIrExpressionBindingTypeCpp(expression, context) ?? getIrExpressionTypeEvidenceCpp(expression, context);
}

function getIrExpressionBindingTypeCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return expression.kind === 'identifier' && expression.reference.kind === 'binding'
    ? getCppBindingTypeCpp(expression.reference.binding.id, context)
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
  const valueType = emitOptionalChainPayloadIrTypeCpp(semantics.valueType, context);
  const callee = emitOptionalChainReceiverCpp(expression.callee, context);
  const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context)).join(', ');
  context.includes.add('optional');
  if (valueType.kind === 'primitive' && valueType.name === 'void') {
    return `([&]() { auto optional_chain_receiver = ${callee}; if (!optional_chain_receiver.has_value()) return; optional_chain_receiver.value()(${arguments_}); }())`;
  }
  const payload = emitType(valueType, context);
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${callee}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value()(${arguments_}); }())`;
}

function emitOptionalPropertyCallExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  const callee = expression.callee;
  if (callee.kind !== 'property' || !callee.optional) return undefined;
  const semantics = callee.optionalChain;
  if (!semantics) return undefined;
  assertIrOptionalChainReceiverIsSingleSentinelCpp(semantics.receiverType, context);
  if (semantics.receiverNullish === 'excluded') {
    return emitExpression({ ...expression, callee: { ...callee, optional: false } }, context);
  }
  const receiverType = emitOptionalChainPayloadIrTypeCpp(semantics.receiverType, context);
  const returns = getCppCallableReturnType(semantics.valueType, context, new Set());
  if (!returns) emissionError(context, `optional property call ${callee.name} requires callable result evidence`);
  const receiver = emitOptionalChainReceiverCpp(callee.object, context);
  const memberOperator = hasFlightReferenceRepresentationCpp(receiverType, context) ? '->' : '.';
  const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context)).join(', ');
  const invocation = `optional_chain_receiver.value()${memberOperator}${safeCppName(callee.name)}(${arguments_})`;
  context.includes.add('optional');
  if (returns.kind === 'primitive' && returns.name === 'void') {
    return `([&]() { auto optional_chain_receiver = ${receiver}; if (!optional_chain_receiver.has_value()) return; ${invocation}; }())`;
  }
  const payload = emitType(returns, context);
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${receiver}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${invocation}; }())`;
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
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && getIrHomogeneousTupleElementTypeCpp(receiver)) {
        return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().get(${index}); }())`;
      }
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
  const receiverType = emitOptionalChainPayloadIrTypeCpp(semantics.receiverType, context);
  const resolvedPropertyType = getIrObjectPropertyTypeCpp(receiverType, expression.name, context);
  const valueType =
    semantics.valueType.kind === 'unknown' ? (resolvedPropertyType ?? semantics.valueType) : semantics.valueType;
  const payload = emitOptionalChainPayloadTypeCpp(valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  const memberOperator = hasFlightReferenceRepresentationCpp(receiverType, context) ? '->' : '.';
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
  if (expression.kind === 'identifier' && expression.presence === 'narrowedPresent') {
    return emitExpression({ ...expression, presence: undefined }, context);
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
  const type = getIrExpressionTypeEvidenceCpp(expression.object, context);
  if (!type) return false;
  const plan = context.referenceRepresentationPlanner.plan(type, context.module);
  return plan.kind === 'represented' && (plan.category === 'array' || plan.category === 'typedArray');
}

function hasSharedReferentRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  if (identityPreserving) return hasSharedReferentRepresentationCpp(identityPreserving, context);
  const owner = getCppDirectBindingOwner(type, context);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return plan.kind === 'represented' && plan.valueRepresentation !== 'inlineValue';
}

function hasFlightReferenceRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  if (identityPreserving) return hasFlightReferenceRepresentationCpp(identityPreserving, context);
  const owner = getCppDirectBindingOwner(type, context);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return plan.kind === 'represented' && plan.valueRepresentation === 'flightReference';
}

function getCppIdentityPreservingUtilityArgument(type: Readonly<IrType>): Readonly<IrType> | undefined {
  return type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1
    ? type.typeArguments[0]
    : undefined;
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
    const targetModules = getCppResolvedImportModules(specifier, context);
    if (targetModules.length > 0) {
      return targetModules.map((targetModule) => getCppModuleIncludeDirective(targetModule, context.options));
    }
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
  return context.referenceRepresentationPlanner.resolveModule(specifier, context.module);
}

function getCppResolvedImportModules(specifier: string, context: EmitContext): readonly Readonly<IrModule>[] {
  return context.referenceRepresentationPlanner.resolveModules(specifier, context.module);
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
      return exported.exported === exported.imported &&
        (!targetModule || targetModule.packageName === module.packageName)
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

function mergeIrTypeParametersCpp(
  outer: readonly IrTypeParameter[],
  inner: readonly IrTypeParameter[],
): readonly IrTypeParameter[] {
  return [...new Map([...outer, ...inner].map((parameter) => [parameter.binding.id, parameter])).values()];
}

function getIrAmbientConstructorNameCpp(expression: Readonly<IrExpression>): string | undefined {
  if (expression.kind === 'identifier' && expression.reference.kind === 'ambient') {
    return expression.reference.name;
  }
  if (
    expression.kind === 'property' &&
    expression.object.kind === 'identifier' &&
    expression.object.reference.kind === 'ambient'
  ) {
    return `${expression.object.reference.name}.${expression.name}`;
  }
  return undefined;
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
    if (target) {
      if (reference.name === 'Infinity' || reference.name === 'NaN' || reference.name === 'Number') {
        context.includes.add('limits');
      }
      if (reference.name === 'Number') context.includes.add('cmath');
      if (reference.name === 'RangeError' || reference.name === 'TypeError') context.includes.add('stdexcept');
      return target;
    }
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
  const namespaceFunction = context.module.declarations.find(
    (declaration) =>
      declaration.kind === 'function' && declaration.namespaceMember && declaration.binding.id === reference.binding.id,
  );
  if (namespaceFunction?.kind === 'function') return safeCppName(namespaceFunction.binding.name);
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
  if (expectedType?.kind === 'null' && getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::null';
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
  if (expectedType?.kind === 'undefined') {
    if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::undefined';
    context.includes.add('variant');
    return 'std::monostate{}';
  }
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
      const value = emitCppTupleElementAccessCpp(name, segment.type, offset, context);
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
  const tuple = emitCppTupleConstructionCpp(expression.type, elements, context);
  return `([&]() { ${declarations.join(' ')} return ${tuple}; })()`;
}

function emitCppInlineTupleConstructionCpp(elements: readonly string[], context: EmitContext): string {
  context.includes.add('tuple');
  return `std::make_tuple(${elements.join(', ')})`;
}

function emitCppTupleConstructionCpp(
  type: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  elements: readonly string[],
  context: EmitContext,
): string {
  const homogeneousElement = getIrHomogeneousTupleElementTypeCpp(type);
  if (getCppRuntimeProfile(context.options) === 'flight-cpp' && homogeneousElement) {
    return `flight::Array<${emitType(homogeneousElement, context)}>{${elements.join(', ')}}`;
  }
  return emitCppInlineTupleConstructionCpp(elements, context);
}

function emitCppTupleElementAccessCpp(
  object: string,
  type: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  index: number,
  context: EmitContext,
): string {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp' && getIrHomogeneousTupleElementTypeCpp(type)) {
    return `${object}.element(${String(index)}.0)`;
  }
  context.includes.add('tuple');
  return `std::get<${String(index)}>(${object})`;
}

function emitCppTupleSliceExpressionCpp(
  expression: Readonly<IrExpression>,
  type: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  start: number,
  end: number,
  context: EmitContext,
): string {
  const source = getGeneratedTargetName('tupleSliceSource', context);
  const resultType: Extract<IrType, { kind: 'tuple' }> = {
    elements: type.elements.slice(start, end),
    kind: 'tuple',
    readonly: false,
  };
  const elements = resultType.elements.map((_, offset) =>
    emitCppTupleElementAccessCpp(source, type, start + offset, context),
  );
  return `([&]() { auto&& ${source} = ${emitExpression(expression, context)}; return ${emitCppTupleConstructionCpp(resultType, elements, context)}; }())`;
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

function emitBoundAmbientTypeofUndefinedComparisonCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): string | undefined {
  if (
    expression.operator !== '==' &&
    expression.operator !== '===' &&
    expression.operator !== '!=' &&
    expression.operator !== '!=='
  ) {
    return undefined;
  }
  const operands = [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ] as const;
  const ambient = operands.find(
    ([typeQuery, undefinedLiteral]) =>
      typeQuery.kind === 'unary' &&
      typeQuery.operator === 'typeof' &&
      typeQuery.operand.kind === 'identifier' &&
      typeQuery.operand.reference.kind === 'ambient' &&
      undefinedLiteral.kind === 'literal' &&
      undefinedLiteral.value === 'undefined',
  )?.[0];
  if (
    ambient?.kind !== 'unary' ||
    ambient.operand.kind !== 'identifier' ||
    ambient.operand.reference.kind !== 'ambient' ||
    !getCompilerRuntimeExternalSymbolTargetCpp(
      ambient.operand.reference.name,
      'value',
      getCppRuntimeProfile(context.options),
      context.options.externalBindings,
    )
  ) {
    return undefined;
  }
  return expression.operator === '!=' || expression.operator === '!==' ? 'true' : 'false';
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
  const foreignImported = getCppForeignImportedBindingTargetNameCpp(type, context);
  if (foreignImported) return foreignImported;
  const owner = getCppDirectBindingOwner(type, context);
  if (owner && owner.module.packageName !== context.module.packageName) {
    const targetName =
      createCppTargetNameMap(owner.module).get(type.reference.binding.id) ?? pascalCase(type.reference.binding.name);
    return `${getCppCompilerPackageNamespace(owner.module.packageName, context.options.packageTargets)}::${targetName}`;
  }
  return context.targetNames.get(type.reference.binding.id) ?? pascalCase(type.reference.binding.name);
}

function getCppDirectBindingOwner(type: Readonly<IrType>, context: EmitContext): CppDirectBindingOwner | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.binding.kind === 'import') {
    return undefined;
  }
  return context.directBindingOwners.get(type.reference.binding.id) ?? undefined;
}

function createCppDirectBindingOwners(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, CppDirectBindingOwner | null> {
  const owners = new Map<string, CppDirectBindingOwner | null>();
  for (const module of modules) {
    for (const declaration of module.declarations) {
      if (!('binding' in declaration)) continue;
      const bindingId = declaration.binding.id;
      owners.set(bindingId, owners.has(bindingId) ? null : { declaration, module });
    }
  }
  return owners;
}

function createCppImportBindingOwners(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, CppImportBindingOwner | null> {
  const owners = new Map<string, CppImportBindingOwner | null>();
  for (const module of modules) {
    for (const importItem of module.imports) {
      for (const binding of importItem.bindings) {
        const bindingId = binding.binding.id;
        owners.set(
          bindingId,
          owners.has(bindingId) ? null : { imported: binding.imported, module, specifier: importItem.specifier },
        );
      }
    }
  }
  return owners;
}

function getCppForeignImportedBindingTargetNameCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): string | undefined {
  if (type.reference.kind !== 'binding' || type.reference.binding.kind !== 'import') return undefined;
  const owner = context.importBindingOwners.get(type.reference.binding.id);
  if (
    !owner ||
    (owner.module.packageName === context.module.packageName && owner.module.source === context.module.source)
  ) {
    return undefined;
  }
  const importedName = owner.imported === '*' ? type.reference.path[0] : owner.imported;
  if (!importedName) return undefined;
  const targetModules = context.referenceRepresentationPlanner.resolveModules(owner.specifier, owner.module);
  const directTargets = targetModules.filter((target) => hasCppDirectExportName(target, importedName));
  const targetModule =
    directTargets.length === 1
      ? directTargets[0]!
      : context.referenceRepresentationPlanner.resolveModule(owner.specifier, owner.module);
  if (!targetModule) return undefined;
  const targetName = getCppResolvedExportTargetName(targetModule, importedName);
  return `${getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets)}::${targetName}`;
}

function getCppEquivalentImportedTypeCpp(type: Readonly<IrType>, context: EmitContext): IrType | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind === 'import' ||
    context.targetNames.has(type.reference.binding.id)
  ) {
    return undefined;
  }
  const bindingName = type.reference.binding.name;
  const equivalentImports = context.module.imports.flatMap((importItem) =>
    importItem.bindings.filter((binding) => binding.imported === bindingName),
  );
  if (equivalentImports.length !== 1) return undefined;
  return {
    ...type,
    reference: { ...type.reference, binding: equivalentImports[0]!.binding },
  };
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
    const targetModules = getCppResolvedImportModules(importItem.specifier, context);
    if (targetModules.length === 0) {
      return context.targetNames.get(bindingId) ?? safeCppName(importedBinding.binding.name);
    }
    const directTargets = targetModules.filter((target) => hasCppDirectExportName(target, importedName));
    const targetModule =
      directTargets.length === 1 ? directTargets[0]! : getCppResolvedImportModule(importItem.specifier, context);
    if (!targetModule) {
      emissionError(context, `imported binding ${importedName} requires one module export target`);
    }
    const targetName = getCppResolvedExportTargetName(targetModule, importedName);
    return `${getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets)}::${targetName}`;
  }
  return undefined;
}

function hasCppDirectExportName(module: Readonly<IrModule>, exportedName: string): boolean {
  return (
    module.exports.some(
      (exported) =>
        (exported.kind === 'default' && exportedName === 'default') ||
        (exported.kind !== 'all' && exported.kind !== 'default' && exported.exported === exportedName),
    ) ||
    module.declarations.some(
      (declaration) => 'binding' in declaration && declaration.exported && declaration.binding.name === exportedName,
    )
  );
}

function getCppNamespaceImportMemberTargetNameCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  if (expression.object.kind !== 'identifier' || expression.object.reference.kind !== 'binding') return undefined;
  const namespaceBindingId = expression.object.reference.binding.id;
  for (const importItem of context.module.imports) {
    const importedBinding = importItem.bindings.find(
      (candidate) => candidate.binding.id === namespaceBindingId && candidate.imported === '*',
    );
    if (!importedBinding) continue;
    const targetModule = getCppResolvedImportModule(importItem.specifier, context);
    if (!targetModule) {
      emissionError(context, `namespace import ${importedBinding.binding.name} requires module resolution`);
    }
    const targetName = getCppResolvedExportTargetName(targetModule, expression.name);
    const namespaceName = getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets);
    return `${namespaceName}::${targetName}`;
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
  for (const header of getCompilerExternalBindingHeadersCpp(
    sourceName,
    space,
    context.options.externalBindings,
    getCppRuntimeProfile(context.options),
  )) {
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
