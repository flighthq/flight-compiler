import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
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
  analyzeIrTypeStructuralAssignability,
  createIrTypeParameterSubstitutionPlan,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerBackend,
  CompilerCppConditionalFacetReferencePlan,
  CompilerCppReferenceRepresentationPlanner,
  CompilerCppStructuralRowPlan,
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
  IrFunctionTypeParameter,
  IrBindingIdentity,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectMember,
  IrObjectTypeProperty,
  IrParameter,
  IrStatement,
  IrSwitchCase,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrTupleTypeElement,
  IrUnionMemberTestEvidence,
  IrValueNameReference,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { getCompilerCppAmbientMemberBinding } from './cppAmbientMemberBinding.js';
import { collectIrModuleBindingTypesCpp } from './cppBindingTypeInference.js';
import { getCompilerCallableSignatureAbiCpp } from './cppCallableSignatureAbi.js';
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
  getCompilerExternalBindingCallResultTypeCpp,
  getCompilerExternalBindingConstructionCpp,
  getCompilerExternalBindingHeadersCpp,
  getCompilerExternalBindingWeakKeyPolicyTargetCpp,
  getCompilerRuntimeExternalMemberTargetCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
} from './cppRuntimeExternalSymbolBinding.js';
import { getIrHomogeneousTupleElementTypeCpp } from './cppTupleRepresentation.js';
import { createCppUnionRepresentationPlan } from './cppUnionRepresentationPlan.js';

interface AnonymousStruct {
  base?: string;
  callables?: readonly Readonly<{
    fieldName: string;
    parameters: readonly Readonly<{ name: string; type: string }>[];
    returns: string;
  }>[];
  guard?: string;
  name: string;
  properties: readonly { name: string; optional: boolean; type: string }[];
  referenceEnabled?: boolean;
  typeParameters: readonly string[];
}

interface CppCallableObject {
  callable: Readonly<Extract<IrType, { kind: 'function' }>>;
  properties: readonly Readonly<IrObjectTypeProperty>[];
}

interface CppCallableOverloadSet {
  callables: readonly Readonly<Extract<IrType, { kind: 'function' }>>[];
}

interface CppCallableObjectIndexedProjection {
  indexedAccess: Readonly<
    Extract<IrType, { kind: 'indexedAccess' }> & {
      index: Readonly<Extract<IrType, { kind: 'literal' }> & { value: string }>;
    }
  >;
  representation: Readonly<CppCallableObject>;
}

interface CppVariantRepresentation {
  alternatives: readonly Readonly<{ members: readonly IrType[]; runtimeType: IrType; targetType: string }>[];
  direct: boolean;
}

interface CppWeakMapTypeArgumentPlan {
  readonly valueRepresentation: 'direct' | 'erased';
  readonly weakKeyPolicyTargetName?: string | undefined;
}

interface CppWeakMapViewPlan {
  readonly key: Readonly<IrType>;
  readonly value: Readonly<IrType>;
}

type CppDirectBindingOwner = Readonly<{ declaration: IrDeclaration; module: IrModule }>;
type CppImportBindingOwner = Readonly<{ imported: string; module: IrModule; specifier: string }>;

interface EmitContext {
  activeDependentCallablePackIds: ReadonlySet<string>;
  anonymousStructs: Map<string, AnonymousStruct>;
  anonymousStructTypeParameters: readonly IrTypeParameter[];
  arrayElementBindingIds: ReadonlySet<string>;
  async?: boolean | undefined;
  bindingClasses: ReadonlyMap<string, Readonly<IrClassDeclaration>>;
  bindingInitializers: ReadonlyMap<string, Readonly<IrExpression>>;
  contextualBindingStorageTargetTypes: ReadonlyMap<string, Readonly<IrType>>;
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  currentClass?: Readonly<IrClassDeclaration> | undefined;
  defaultedParameterIds: ReadonlySet<string>;
  denseArrayLengthBindingIds: ReadonlySet<string>;
  dependentCallablePacks: ReadonlyMap<string, Readonly<IrParameter>>;
  directBindingOwners: ReadonlyMap<string, CppDirectBindingOwner | null>;
  externalBindingStorageTargetTypes: ReadonlyMap<string, string>;
  importBindingOwners: ReadonlyMap<string, CppImportBindingOwner | null>;
  importedBindingTypes: Map<string, Readonly<IrType> | null>;
  indexedObjectParameterBindingIds: ReadonlySet<string>;
  finallyReturnVar?: string | undefined;
  facetTagNames: Map<string, string>;
  includes: Set<string>;
  module: Readonly<IrModule>;
  namespaceScope: boolean;
  nullableBindingIds: ReadonlySet<string>;
  narrowedBindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  options: Readonly<CppCompilerBackendOptions>;
  preservedInitializerTypes: Map<string, Readonly<IrType>>;
  referenceRepresentationPlanner: CompilerCppReferenceRepresentationPlanner;
  recursiveTypeAliasBindingIds: ReadonlySet<string>;
  resolvingInitializerBindingIds: Set<string>;
  returnsAbsent: boolean;
  sharedCaptureTargetNames: ReadonlyMap<string, string>;
  sourceModules: readonly Readonly<IrModule>[];
  structuralCastBindingRows: ReadonlyMap<string, Readonly<CompilerCppStructuralRowPlan>>;
  targetNameMaps: ReadonlyMap<string, ReadonlyMap<string, string>>;
  targetNames: ReadonlyMap<string, string>;
  uninitializedCaptureStorageBindingIds: ReadonlySet<string>;
  generatedNames: Set<string>;
  enclosingReturnType?: Readonly<IrType> | undefined;
}

export function createCppCompilerBackend(): CompilerBackend<CppCompilerBackendOptions> {
  return {
    createEmissionSession({ moduleResolution, modules, options }) {
      const referenceRepresentationPlanner = createIrTypeReferenceRepresentationPlannerCpp(
        modules,
        moduleResolution,
        options.externalBindings,
      );
      const interfaceInheritancePass = createCompilerLoweringPassInterfaceInheritanceCpp(modules, moduleResolution);
      const directBindingOwners = createCppDirectBindingOwners(modules);
      const importBindingOwners = createCppImportBindingOwners(modules);
      const targetNameMaps = createCppTargetNameMaps(modules);
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
              targetNameMaps,
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
  targetNameMaps?: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
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
      interfaceInheritancePass ?? createCompilerLoweringPassInterfaceInheritanceCpp(sourceModules, moduleResolution),
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
    targetNames = new Map(
      (targetNameMaps ?? createCppTargetNameMaps(sourceModules)).get(getCppModuleIdentityKey(module)) ?? [],
    );
    // Binding-pattern lowering introduces compiler-owned temporaries after package-wide target
    // names have been allocated from the source graph. Allocate the lowered module as well so
    // repeated destructuring in one scope cannot fall back to the same unchecked preferred name.
    for (const allocation of createIrModuleTargetNameAllocation(module, (binding) => ({
      namespace: 'identifier',
      preferredName: getCppPreferredBindingName(binding),
    }))) {
      if (!targetNames.has(allocation.identity)) targetNames.set(allocation.identity, allocation.name);
    }
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
  const externalBindingStorageTargetTypes = collectCppExternalBindingStorageTargetTypesCpp(
    module,
    bindingTypes,
    options,
  );
  const closureCapturePlan = createIrModuleClosureCapturePlanCpp(module);
  const recursiveTypeAliasBindingIds = collectCppRecursiveTypeAliasBindingIds(module);
  const sharedCaptureTargetNames = new Map<string, string>();
  const contextualBindingStorageTargetTypes = new Map<string, Readonly<IrType>>();
  const nullableBindingIds = new Set(collectIrModuleNullableBindingIds(module));
  const uninitializedCaptureStorageBindingIds = collectIrModuleUninitializedBindingIdsCpp(module);
  const preservedInitializerTypes = collectCppExplicitCollectionConstructionBindingTypesCpp(module);
  const structuralCastBindingRows = new Map<string, Readonly<CompilerCppStructuralRowPlan>>();
  const context: EmitContext = {
    activeDependentCallablePackIds: new Set(),
    anonymousStructs: new Map(),
    anonymousStructTypeParameters: [],
    arrayElementBindingIds: collectIrModuleArrayElementBindingIdsCpp(module),
    bindingClasses: collectIrModuleBindingClassesCpp(module, bindingTypes),
    bindingInitializers: collectIrModuleBindingInitializersCpp(module),
    bindingTypes,
    contextualBindingStorageTargetTypes,
    defaultedParameterIds: new Set(),
    denseArrayLengthBindingIds: collectIrModuleDenseArrayLengthBindingIdsCpp(sourceModule),
    dependentCallablePacks: collectIrModuleDependentCallablePacksCpp(module),
    directBindingOwners: directBindingOwners ?? createCppDirectBindingOwners(sourceModules),
    externalBindingStorageTargetTypes,
    facetTagNames: new Map(),
    importBindingOwners: importBindingOwners ?? createCppImportBindingOwners(sourceModules),
    importedBindingTypes: new Map(),
    indexedObjectParameterBindingIds: collectCppIndexedObjectParameterBindingIds(module, bindingTypes),
    includes: new Set<string>(),
    module,
    namespaceScope: true,
    nullableBindingIds,
    narrowedBindingTypes: new Map(),
    options,
    preservedInitializerTypes,
    referenceRepresentationPlanner:
      referenceRepresentationPlanner ??
      createIrTypeReferenceRepresentationPlannerCpp(sourceModules, moduleResolution, options.externalBindings),
    recursiveTypeAliasBindingIds,
    resolvingInitializerBindingIds: new Set(),
    returnsAbsent: false,
    sharedCaptureTargetNames,
    sourceModules,
    structuralCastBindingRows,
    targetNameMaps: targetNameMaps ?? createCppTargetNameMaps(sourceModules),
    targetNames,
    uninitializedCaptureStorageBindingIds,
    generatedNames: new Set(targetNames.values()),
  };
  for (const [bindingId, targetType] of collectCppContextualBindingStorageTargetTypesCpp(module, context)) {
    contextualBindingStorageTargetTypes.set(bindingId, targetType);
  }
  for (const [bindingId, row] of collectCppStructuralCastBindingRowsCpp(module, context)) {
    structuralCastBindingRows.set(bindingId, row);
  }
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (!('binding' in variable) || !variable.initializer) return;
      if (variable.initializer.kind === 'call' && variable.initializer.presence === 'narrowedPresent') return;
      if (hasIrTypeAbsentMember(getIrExpressionTypeEvidenceCpp(variable.initializer, context))) {
        nullableBindingIds.add(variable.binding.id);
      }
    },
  });
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
  const declarations = orderIrModuleDeclarationsCpp(module, recursiveTypeAliasBindingIds)
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
  const importedFunctionForwardDeclarations = emitCppImportedFunctionForwardDeclarations(context);
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
  const importedForwardDeclarations = emitCppImportedForwardDeclarations(context);
  if (importedForwardDeclarations.length > 0) lines.push('', ...importedForwardDeclarations);
  if (imports.length > 0) lines.push('', ...imports);
  if (importedFunctionForwardDeclarations.length > 0) {
    lines.push('', ...importedFunctionForwardDeclarations);
  }
  const namespaceName = getCppCompilerPackageNamespace(module.packageName, options.packageTargets);
  lines.push('', `namespace ${namespaceName} {`);
  const forwardDeclarations = emitCppForwardDeclarations(module, context);
  if (forwardDeclarations.length > 0) lines.push('', ...forwardDeclarations);
  if (reexports.length > 0) lines.push('', ...reexports);
  declarations.forEach((declaration) => {
    lines.push(...declaration.anonymousStructLines);
    lines.push('', ...declaration.lines);
  });
  lines.push('', `} // namespace ${namespaceName}`);
  const contents = lines.join('\n');
  if (getCppRuntimeProfile(options) === 'flight-cpp') {
    assertCppOutputHasNoUnresolvedTypePlaceholder(contents, context);
  }
  const runtimeDependency =
    options.runtimeHeader ?? (getCppRuntimeProfile(options) === 'flight-cpp' ? 'flight/runtime.hpp' : undefined);
  return {
    contents,
    dependencies: [
      ...context.includes,
      ...imports.map(getCppIncludeDirectivePath),
      ...(runtimeDependency ? [runtimeDependency] : []),
    ],
    path: getCppModuleFilePath(module, options),
  };
}

function assertCppOutputHasNoUnresolvedTypePlaceholder(contents: string, context: EmitContext): void {
  const invalid =
    contents.match(/\b[A-Za-z_][A-Za-z0-9_:]*<[^>\n]*\bauto\b/u)?.[0] ??
    contents.match(/\busing\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*auto\s*;/u)?.[0] ??
    contents.match(/^\s*auto\s+[A-Za-z_][A-Za-z0-9_]*\s*;/mu)?.[0];
  if (invalid) {
    emissionError(context, `flight-cpp type position retains unresolved auto placeholder: ${invalid.trim()}`);
  }
}

function createCompilerLoweringPassInterfaceInheritanceCpp(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): CompilerLoweringPass {
  return createCompilerLoweringPassInterfaceInheritance(modules, moduleResolution, {
    eraseAmbientUtilityHeritage: (reference) =>
      reference.reference.kind === 'ambient' && reference.reference.name === 'Pick',
  });
}

function createCppTargetNameMaps(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const entries = modules.flatMap((module) => {
    const exportedIds = new Set([
      ...module.declarations.flatMap((declaration) =>
        declaration.exported ? collectCppPublicDeclarationBindings(declaration).map((binding) => binding.id) : [],
      ),
      ...module.exports.flatMap((exported) => (exported.kind === 'local' ? [exported.binding.id] : [])),
    ]);
    return module.declarations.flatMap((declaration) =>
      collectCppPublicDeclarationBindings(declaration).map((binding) => ({
        binding,
        exported: exportedIds.has(binding.id),
        module,
        preferredName: getCppPreferredBindingName(binding).normalize('NFC'),
      })),
    );
  });
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = `${entry.module.packageName}\0${entry.preferredName}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const collisionNames = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const publicEntries = group.filter((entry) => entry.exported);
    const crossModulePublicCollision = new Set(publicEntries.map((entry) => entry.module.source)).size > 1;
    if (publicEntries.length > 1) {
      for (const entry of publicEntries) {
        const sourceSuffix = crossModulePublicCollision
          ? `_flight_source_${getCppStableIdentifierHash(entry.module.source)}`
          : '';
        collisionNames.set(entry.binding.id, `${createCppPublicCollisionName(entry.binding)}${sourceSuffix}`);
      }
    }
    for (const entry of group.filter((candidate) => !candidate.exported)) {
      collisionNames.set(
        entry.binding.id,
        `${createCppPublicCollisionName(entry.binding)}_flight_private_${getCppStableIdentifierHash(entry.module.source)}`,
      );
    }
  }
  return new Map(
    modules.map((module) => [
      getCppModuleIdentityKey(module),
      new Map(
        createIrModuleTargetNameAllocation(module, (binding) => ({
          namespace: 'identifier',
          preferredName: collisionNames.get(binding.id) ?? getCppPreferredBindingName(binding),
        })).map((allocation) => [allocation.identity, allocation.name]),
      ),
    ]),
  );
}

function getCppModuleIdentityKey(module: Readonly<IrModule>): string {
  return `${module.packageName}\0${module.source}`;
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

function emitCppForwardDeclarations(module: Readonly<IrModule>, context: EmitContext): string[] {
  return module.declarations.flatMap((declaration): string[] => {
    if (declaration.kind !== 'class' && declaration.kind !== 'interface') return [];
    if (
      declaration.kind === 'interface' &&
      getCppRuntimeProfile(context.options) === 'flight-cpp' &&
      context.referenceRepresentationPlanner.resolveFacetReference(
        {
          kind: 'named',
          reference: { binding: declaration.binding, kind: 'binding', path: [] },
          typeArguments: declaration.typeParameters.map((parameter) => ({
            kind: 'named',
            reference: { binding: parameter.binding, kind: 'binding', path: [] },
            typeArguments: [],
          })),
        },
        context.module,
      )
    ) {
      return [];
    }
    const typeParameters = emitTypeParameters(declaration.typeParameters, context, true);
    const declarationLine = `struct ${getBindingTargetName(declaration.binding, context)};`;
    return typeParameters ? [`template ${typeParameters}`, declarationLine] : [declarationLine];
  });
}

function emitCppImportedForwardDeclarations(context: EmitContext): string[] {
  const declarations = new Map<string, { namespace: string; declaration: string }>();
  for (const importItem of context.module.imports) {
    const targetModules = getCppResolvedImportModules(importItem.specifier, context);
    for (const binding of importItem.bindings) {
      if (binding.imported === '*') continue;
      const matches = targetModules.flatMap((targetModule) =>
        targetModule.declarations.flatMap((declaration) => {
          if (
            (declaration.kind !== 'class' && declaration.kind !== 'interface') ||
            declaration.binding.name !== binding.imported ||
            !hasCppDirectExportName(targetModule, binding.imported)
          ) {
            return [];
          }
          return [{ declaration, targetModule }];
        }),
      );
      if (matches.length !== 1) continue;
      const match = matches[0]!;
      const namespace = getCppCompilerPackageNamespace(match.targetModule.packageName, context.options.packageTargets);
      const targetName =
        context.targetNameMaps.get(getCppModuleIdentityKey(match.targetModule))?.get(match.declaration.binding.id) ??
        safeCppTypeName(match.declaration.binding.name);
      const typeParameters = match.declaration.typeParameters.map((parameter) =>
        safeCppTypeName(parameter.binding.name),
      );
      const declaration = `${typeParameters.length > 0 ? `template <${typeParameters.map((name) => `typename ${name}`).join(', ')}> ` : ''}struct ${targetName};`;
      declarations.set(`${namespace}\0${declaration}`, { declaration, namespace });
    }
  }
  return [...declarations.values()]
    .sort((left, right) =>
      compareTextCodeUnits(`${left.namespace}\0${left.declaration}`, `${right.namespace}\0${right.declaration}`),
    )
    .map(({ declaration, namespace }) => `namespace ${namespace} { ${declaration} }`);
}

// A mutually importing header can reach a call before the imported header resumes far enough to
// define the callee. Declare only functions on a proven back edge; doing this for every import would
// expose arbitrary private signature dependencies and anonymous structural parameter types.
function emitCppImportedFunctionForwardDeclarations(context: EmitContext): string[] {
  const declarations = new Map<string, { namespace: string; declaration: string }>();
  for (const importItem of context.module.imports) {
    const targetModules = getCppResolvedImportModules(importItem.specifier, context).filter((targetModule) =>
      targetModule.imports.some((targetImport) =>
        context.referenceRepresentationPlanner
          .resolveModules(targetImport.specifier, targetModule)
          .some(
            (resolved) =>
              resolved.packageName === context.module.packageName && resolved.source === context.module.source,
          ),
      ),
    );
    for (const binding of importItem.bindings) {
      if (binding.imported === '*') continue;
      const matches = targetModules.flatMap((targetModule) =>
        targetModule.declarations.flatMap((declaration) =>
          declaration.kind === 'function' &&
          declaration.binding.name === binding.imported &&
          hasCppDirectExportName(targetModule, binding.imported)
            ? [{ declaration, targetModule }]
            : [],
        ),
      );
      if (matches.length !== 1) continue;
      const { declaration, targetModule } = matches[0]!;
      const namespace = getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets);
      const name =
        context.targetNameMaps.get(getCppModuleIdentityKey(targetModule))?.get(declaration.binding.id) ??
        safeCppName(declaration.binding.name);
      const functionContext: EmitContext = {
        ...context,
        activeDependentCallablePackIds: mergeCppDependentCallablePackIds(
          context.activeDependentCallablePackIds,
          declaration.parameters,
        ),
        anonymousStructTypeParameters: mergeIrTypeParametersCpp(
          context.anonymousStructTypeParameters,
          declaration.typeParameters,
        ),
      };
      const template = emitCppFunctionTemplate(declaration.typeParameters, declaration.parameters, functionContext);
      const parameters = declaration.parameters
        .map((parameter) => emitCppForwardParameterCpp(parameter, functionContext))
        .join(', ');
      const signature = `${template.parameters ? `template ${template.parameters} ` : ''}${template.requirement ? `requires ${template.requirement} ` : ''}inline ${emitType(declaration.returns, functionContext)} ${name}(${parameters});`;
      declarations.set(`${namespace}\0${signature}`, { declaration: signature, namespace });
    }
  }
  return [...declarations.values()]
    .sort((left, right) =>
      compareTextCodeUnits(`${left.namespace}\0${left.declaration}`, `${right.namespace}\0${right.declaration}`),
    )
    .map(({ declaration, namespace }) => `namespace ${namespace} { ${declaration} }`);
}

function emitCppForwardParameterCpp(parameter: Readonly<IrParameter>, context: EmitContext): string {
  const name = getBindingTargetName(parameter.binding, context);
  if (
    context.indexedObjectParameterBindingIds.has(parameter.binding.id) ||
    isCppGenericStructuralSequenceParameterCpp(parameter, context)
  ) {
    return `auto ${name}`;
  }
  if (parameter.dependentCallablePack) {
    const pack = getCppDependentCallablePack(parameter, context);
    return `${pack.typeName}&&... ${name}`;
  }
  const type = parameter.type ? emitCppParameterTypeCpp(parameter.type, parameter.rest, context) : 'auto';
  if (parameter.optional) {
    context.includes.add('optional');
    return `std::optional<${type}> ${name}`;
  }
  return `${type} ${name}`;
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
  if (struct.guard) lines.push(`#ifndef ${struct.guard}`, `#define ${struct.guard}`);
  if (struct.typeParameters.length > 0) {
    lines.push(`template <${struct.typeParameters.map((parameter) => `typename ${parameter}`).join(', ')}>`);
  }
  const base = struct.base
    ? ` : public ${struct.base}`
    : getCppRuntimeProfile(context.options) === 'flight-cpp' && struct.referenceEnabled !== false
      ? ' : public flight::ReferenceEnabled'
      : '';
  lines.push(`struct ${struct.name}${base} {`);
  if (struct.callables) {
    context.includes.add('functional');
    for (const callable of struct.callables) {
      const parameterTypes = callable.parameters.map((parameter) => parameter.type).join(', ');
      lines.push(`  std::function<${callable.returns}(${parameterTypes})> ${callable.fieldName};`);
    }
  }
  for (const property of struct.properties) {
    lines.push(`  ${emitOptionalTypeCpp(property.type, property.optional, context)} ${property.name};`);
  }
  for (const callable of struct.callables ?? []) {
    const parameters = callable.parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ');
    const arguments_ = callable.parameters.map((parameter) => parameter.name).join(', ');
    lines.push(`  ${callable.returns} operator()(${parameters}) const {`);
    lines.push(`    return ${callable.fieldName}(${arguments_});`);
    lines.push('  }');
  }
  lines.push('};');
  if (struct.guard) lines.push(`#endif // ${struct.guard}`);
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
    activeDependentCallablePackIds: mergeCppDependentCallablePackIds(
      outer.activeDependentCallablePackIds,
      declaration.parameters,
    ),
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
  const template = emitCppFunctionTemplate(declaration.typeParameters, declaration.parameters, context);
  const params = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const lines: string[] = [];
  if (template.parameters) lines.push(`template ${template.parameters}`);
  if (template.requirement) lines.push(`  requires ${template.requirement}`);
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
    activeDependentCallablePackIds: mergeCppDependentCallablePackIds(
      outer.activeDependentCallablePackIds,
      declaration.parameters,
    ),
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
  const template = emitCppFunctionTemplate(declaration.typeParameters, declaration.parameters, context);
  const params = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const name = getBindingTargetName(declaration.binding, context);
  const lines: string[] = [];
  if (template.parameters) lines.push(`template ${template.parameters}`);
  if (template.requirement) lines.push(`  requires ${template.requirement}`);
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
  const facet = context.referenceRepresentationPlanner.resolveFacetReference(
    {
      kind: 'named',
      reference: { binding: declaration.binding, kind: 'binding', path: [] },
      typeArguments: declaration.typeParameters.map((parameter) => ({
        kind: 'named',
        reference: { binding: parameter.binding, kind: 'binding', path: [] },
        typeArguments: [],
      })),
    },
    context.module,
  );
  if (facet && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    if (declaration.typeParameters.length > 0) {
      emissionError(context, `facet interface ${declaration.binding.name} must be nongeneric`);
    }
    context.includes.add('flight/conditional_facet_ref.hpp');
    const tag = getCppFacetTagNameCpp(declaration.binding, context);
    return [
      `struct ${tag} final {};`,
      `using ${name} = flight::FacetRef<${emitType(facet.base, context, 'storage')}, ${tag}>;`,
    ];
  }
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
  const structuralRow = context.referenceRepresentationPlanner.resolveStructuralRow(
    {
      kind: 'named',
      reference: { binding: declaration.binding, kind: 'binding', path: [] },
      typeArguments: declaration.typeParameters.map((parameter) => ({
        kind: 'named',
        reference: { binding: parameter.binding, kind: 'binding', path: [] },
        typeArguments: [],
      })),
    },
    context.module,
  );
  if (structuralRow && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(`using ${name} = ${emitCppStructuralRowReferenceTypeCpp(structuralRow, context)};`);
    return lines;
  }
  const conditionalFacet = context.referenceRepresentationPlanner.resolveConditionalFacetReference(
    declaration.type,
    context.module,
  );
  if (conditionalFacet && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(`using ${name} = ${emitCppConditionalFacetReferenceTypeCpp(conditionalFacet, context)};`);
    return lines;
  }
  if (context.recursiveTypeAliasBindingIds.has(declaration.binding.id)) {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
    const base = emitType(declaration.type, context);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(
      `struct ${name} : public ${base} {`,
      `  using Base = ${base};`,
      '  using Base::Base;',
      '  using Base::operator=;',
      '};',
    );
    return lines;
  }
  const stringLiterals = getIrUnionTypeStringLiteralValues(declaration.type);
  if (stringLiterals) return emitStringLiteralUnionCpp(declaration, context);
  const callableObject = getCppCallableObjectIntersectionCpp(declaration.type, context);
  if (callableObject && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const typeParameters = context.anonymousStructTypeParameters.map(
      (parameter) => context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name),
    );
    return emitAnonymousStructCpp(
      createCppCallableObjectStructCpp(
        getBindingTargetName(declaration.binding, context),
        callableObject,
        typeParameters,
        context,
      ),
      context,
    );
  }
  const callableProjection = getCppCallableObjectIndexedProjectionCpp(declaration.type, context);
  if (callableProjection && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    context.includes.add('utility');
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(`using ${name} = ${emitCppCallableObjectIndexedProjectionTypeCpp(callableProjection, context)};`);
    return lines;
  }
  const objectProperties =
    declaration.type.kind === 'object'
      ? declaration.type.properties
      : declaration.type.kind === 'intersection'
        ? context.referenceRepresentationPlanner.resolveObjectShape(declaration.type, context.module)
        : undefined;
  if (objectProperties) {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
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
  const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
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
  const externalStorageTarget = context.externalBindingStorageTargetTypes.get(declaration.binding.id);
  const contextualStorageTarget = context.contextualBindingStorageTargetTypes.get(declaration.binding.id);
  const preservedInitializerType = context.preservedInitializerTypes.get(declaration.binding.id);
  const structuralCastRow = context.structuralCastBindingRows.get(declaration.binding.id);
  const type = externalStorageTarget
    ? emitCppExternalBindingStorageTypeCpp(declaration.type, externalStorageTarget, context)
    : contextualStorageTarget
      ? emitType(contextualStorageTarget, context)
      : preservedInitializerType
        ? emitType(preservedInitializerType, context)
        : structuralCastRow
          ? emitCppStructuralRowReferenceTypeCpp(structuralCastRow, context)
          : declaration.type
            ? emitType(declaration.type, context)
            : 'auto';
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(declaration.mutable, declaration.type);
  const initializer = declaration.initializer
    ? ` = ${arrayElement ? emitOptionalExpressionCpp(declaration.initializer, context, declaration.type) : emitExpression(declaration.initializer, context, contextualStorageTarget ?? preservedInitializerType ?? declaration.type)}`
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
  const weakMapViewInitializer =
    !variable.mutable && variable.initializer?.kind === 'cast' ? variable.initializer : undefined;
  const weakMapViewPlan = weakMapViewInitializer
    ? getCppErasedWeakMapViewPlan(weakMapViewInitializer, context)
    : undefined;
  const inferredInitializerType =
    !arrayElement &&
    !variable.mutable &&
    variable.initializer &&
    (!variable.type ||
      variable.type.kind === 'unknown' ||
      (variable.type?.kind === 'array' &&
        variable.type.element.kind === 'union' &&
        variable.type.element.types.some((type) => type.kind === 'unknown')))
      ? getIrExpressionTypeEvidenceCpp(variable.initializer, context)
      : undefined;
  const preservedInitializerType = arrayElement
    ? undefined
    : (context.preservedInitializerTypes.get(variable.binding.id) ??
      getCppStructurallyEquivalentInitializerTypeCpp(variable, context) ??
      (inferredInitializerType?.kind === 'unknown' ? undefined : inferredInitializerType));
  if (preservedInitializerType) {
    context.preservedInitializerTypes.set(variable.binding.id, preservedInitializerType);
  }
  const externalStorageTarget = context.externalBindingStorageTargetTypes.get(variable.binding.id);
  const contextualStorageTarget = context.contextualBindingStorageTargetTypes.get(variable.binding.id);
  const structuralCastRow = context.structuralCastBindingRows.get(variable.binding.id);
  const type = externalStorageTarget
    ? emitCppExternalBindingStorageTypeCpp(variable.type, externalStorageTarget, context)
    : contextualStorageTarget
      ? emitType(contextualStorageTarget, context)
      : structuralCastRow
        ? emitCppStructuralRowReferenceTypeCpp(structuralCastRow, context)
      : weakMapViewPlan || !variable.type || preservedInitializerType
        ? 'auto'
        : emitType(variable.type, context);
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(variable.mutable, variable.type);
  const initializer = variable.initializer
    ? ` = ${
        weakMapViewPlan && weakMapViewInitializer
          ? emitCppErasedWeakMapViewAcquisition(weakMapViewInitializer, weakMapViewPlan, context)
          : arrayElement
            ? emitOptionalExpressionCpp(variable.initializer, context, variable.type)
            : emitExpression(
                variable.initializer,
                context,
                contextualStorageTarget ?? preservedInitializerType ?? variable.type,
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

function collectCppExplicitCollectionConstructionBindingTypesCpp(
  module: Readonly<IrModule>,
): Map<string, Readonly<IrType>> {
  const types = new Map<string, Readonly<IrType>>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (
        !('binding' in variable) ||
        variable.mutable ||
        variable.initializer?.kind !== 'new' ||
        variable.initializer.typeArguments.length === 0
      ) {
        return;
      }
      const constructorName = getIrAmbientConstructorNameCpp(variable.initializer.callee);
      const expectedArity =
        constructorName === 'Map' || constructorName === 'WeakMap' ? 2 : constructorName === 'Set' ? 1 : 0;
      if (!constructorName || expectedArity === 0 || variable.initializer.typeArguments.length !== expectedArity) {
        return;
      }
      types.set(variable.binding.id, {
        kind: 'named',
        reference: { kind: 'ambient', name: constructorName },
        typeArguments: variable.initializer.typeArguments,
      });
    },
  });
  return types;
}

function collectCppStructuralCastBindingRowsCpp(
  module: Readonly<IrModule>,
  context: EmitContext,
): ReadonlyMap<string, Readonly<CompilerCppStructuralRowPlan>> {
  const rows = new Map<string, Readonly<CompilerCppStructuralRowPlan>>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (!('binding' in variable) || variable.initializer?.kind !== 'cast') return;
      const sourceType = getIrExpressionTypeEvidenceCpp(variable.initializer.expression, context);
      if (!sourceType || !context.referenceRepresentationPlanner.resolveStructuralRow(sourceType, context.module)) {
        return;
      }
      const target = getCppStructuralProjectionRowCpp(variable.initializer.type, context);
      if (target) rows.set(variable.binding.id, target);
    },
  });
  return rows;
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
  return variableShape &&
    initializerShape &&
    areCppObjectShapesRepresentationEquivalent(variableShape, initializerShape, context)
    ? initializerType
    : undefined;
}

function areCppObjectShapesRepresentationEquivalent(
  left: readonly Readonly<IrObjectTypeProperty>[],
  right: readonly Readonly<IrObjectTypeProperty>[],
  context: EmitContext,
): boolean {
  if (left.length !== right.length) return false;
  const rightByName = new Map(right.map((property) => [property.name, property] as const));
  return left.every((property) => {
    const other = rightByName.get(property.name);
    if (
      !other ||
      property.optional !== other.optional ||
      property.readonly !== other.readonly ||
      Boolean(property.computedKey) !== Boolean(other.computedKey)
    ) {
      return false;
    }
    const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
    return emitType(property.type, isolatedContext) === emitType(other.type, isolatedContext);
  });
}

function emitExpression(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
  constructExpectedUnion = true,
  denseArrayLengthInitialized = false,
): string {
  if (expectedType && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const optionalPropertyConversion = emitCppOptionalPropertyDualSentinelConversionCpp(
      expression,
      expectedType,
      context,
    );
    if (optionalPropertyConversion) return optionalPropertyConversion;
    const structuralConversion = emitCppContextualStructuralReferenceCpp(expression, expectedType, context);
    if (structuralConversion) return structuralConversion;
  }
  if (expectedType && constructExpectedUnion) {
    const constructed = emitContextualUnionExpressionCpp(expression, expectedType, context);
    if (constructed) return constructed;
  }
  switch (expression.kind) {
    case 'array':
      return emitArrayExpressionCpp(expression, context, expectedType);
    case 'assignment': {
      const assignmentType = getIrAssignmentTargetTypeCpp(expression.left, context);
      const rightType = getIrExpressionTypeEvidenceCpp(expression.right, context);
      const exactCallableFieldAssignment =
        expression.operator === '=' &&
        assignmentType &&
        rightType &&
        isCppExactCallableObjectFieldAssignmentCpp(expression.left, rightType, assignmentType, context);
      const foreignAnonymousObject =
        expression.operator === '='
          ? emitCppForeignAnonymousPropertyObjectCpp(expression.left, expression.right, context)
          : undefined;
      const right =
        foreignAnonymousObject ??
        emitExpression(expression.right, context, exactCallableFieldAssignment ? rightType : assignmentType);
      const structuralRowAssignment =
        expression.operator === '=' && getCppRuntimeProfile(context.options) === 'flight-cpp'
          ? emitCppStructuralRowAssignment(expression.left, right, context)
          : undefined;
      if (structuralRowAssignment) return structuralRowAssignment;
      const recordIndexedAssignment =
        expression.operator === '=' && getCppRuntimeProfile(context.options) === 'flight-cpp'
          ? emitCppRecordIndexedAssignmentCpp(expression.left, right, context)
          : undefined;
      if (recordIndexedAssignment) return recordIndexedAssignment;
      const recordNullishAssignment =
        expression.operator === '??=' && getCppRuntimeProfile(context.options) === 'flight-cpp'
          ? emitCppRecordNullishAssignmentCpp(expression.left, right, context)
          : undefined;
      if (recordNullishAssignment) return recordNullishAssignment;
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
        expression.left.kind === 'property' &&
        expression.left.member?.receiver === 'array' &&
        expression.left.member.name === 'length' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        context.includes.add('cstddef');
        const receiver = emitExpression(expression.left.object, context);
        const operator = memberOp(expression.left.object, context);
        const value =
          expression.operator === '='
            ? right
            : expression.operator === '-='
              ? `static_cast<double>(assignment_receiver${operator}size()) - ${right}`
              : undefined;
        if (!value) emissionError(context, `array length ${expression.operator} requires checked resize lowering`);
        return `([&]() { auto&& assignment_receiver = ${receiver}; const auto assignment_value = ${value}; assignment_receiver${operator}resize(assignment_value); return assignment_value; }())`;
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
      const variantIndexedAssignment =
        expression.left.kind === 'element'
          ? emitCppVariantIndexedAssignmentCpp(expression.left, expression.operator, right, context)
          : undefined;
      if (variantIndexedAssignment) return variantIndexedAssignment;
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
        if (expression.operator === '??=' && assignmentType && !hasIrTypeAbsentMember(assignmentType)) return left;
        return emitLogicalAssignmentCpp(left, expression.operator, right);
      }
      return `(${left} ${emitAssignmentOperator(expression.operator)} ${right})`;
    }
    case 'await':
      return `co_await ${emitExpression(expression.expression, context)}`;
    case 'binary': {
      if (expression.semantics.unionMemberTest) {
        return emitUnionMemberTestCpp(expression.semantics.unionMemberTest, context);
      }
      const inferredPropertyTest = emitCppInferredPropertyUnionMemberTestCpp(expression, context);
      if (inferredPropertyTest) return inferredPropertyTest;
      if (expression.semantics.nullishComparison) {
        return emitNullishComparisonCpp(expression, context);
      }
      const inferredNullishComparison = emitCppInferredOptionalNullishComparison(expression, context);
      if (inferredNullishComparison) return inferredNullishComparison;
      const boundAmbientTypeof = emitBoundAmbientTypeofUndefinedComparisonCpp(expression, context);
      if (boundAmbientTypeof) return boundAmbientTypeof;
      if (expression.operator === '??') {
        const leftType =
          getIrExpressionBindingTypeCpp(expression.left, context) ??
          getIrExpressionTypeEvidenceCpp(expression.left, context);
        const union = leftType ? getIrUnionTypeCpp(leftType, context, new Set()) : undefined;
        const leftUsesOptionalStorage =
          (expression.left.kind === 'identifier' &&
            expression.left.reference.kind === 'binding' &&
            (context.nullableBindingIds.has(expression.left.reference.binding.id) ||
              context.arrayElementBindingIds.has(expression.left.reference.binding.id))) ||
          (expression.left.kind === 'element' &&
            getCppRuntimeProfile(context.options) === 'flight-cpp' &&
            (hasCppRegExpExecArrayIndexedReceiverCpp(expression.left, context) ||
              hasIndexedRuntimeReceiverCpp(expression.left, context) ||
              Boolean(
                getCppRecordTypeArgumentsCpp(
                  getIrExpressionTypeEvidenceCpp(expression.left.object, context),
                  context,
                  new Set(),
                ),
              ))) ||
          (expression.left.kind === 'property' &&
            expression.left.optional &&
            expression.left.object.kind === 'element' &&
            getCppRuntimeProfile(context.options) === 'flight-cpp' &&
            hasIndexedRuntimeReceiverCpp(expression.left.object, context));
        if (
          leftType &&
          !union &&
          !leftUsesOptionalStorage &&
          leftType.kind !== 'null' &&
          leftType.kind !== 'undefined'
        ) {
          return emitExpression(expression.left, context, leftType);
        }
        if (union && getCppUnionRepresentationPlan(union, context).kind === 'dualSentinelVariant') {
          emissionError(context, 'dual-sentinel nullish coalescing requires presence projection lowering');
        }
        const expectedUnion = expectedType ? getIrUnionTypeCpp(expectedType, context, new Set()) : undefined;
        const expectedPlan = expectedUnion ? getCppUnionRepresentationPlan(expectedUnion, context) : undefined;
        const leftRuntime = leftType ? getIrTypeRuntimeDomainCpp(leftType, context, new Set()) : undefined;
        if (
          leftUsesOptionalStorage &&
          leftRuntime &&
          expectedPlan?.kind === 'optionalSingle' &&
          expectedPlan.valueSlots[0]?.targetType === emitType(leftRuntime, context) &&
          ((expression.right.kind === 'literal' && expression.right.value === null) ||
            expression.right.kind === 'undefinedValue' ||
            (expression.right.kind === 'identifier' &&
              expression.right.reference.kind === 'ambient' &&
              expression.right.reference.name === 'undefined'))
        ) {
          return emitOptionalExpressionCpp(expression.left, context, leftType);
        }
        if (
          leftUsesOptionalStorage &&
          leftRuntime &&
          expectedUnion &&
          expectedPlan?.kind === 'optionalSingle' &&
          expectedPlan.valueSlots[0]?.targetType === emitType(leftRuntime, context)
        ) {
          const unionType = emitUnionTypeCpp(expectedUnion, context);
          const left = emitOptionalExpressionCpp(expression.left, context, leftType);
          const right = emitExpression(expression.right, context, expectedType);
          return `([&]() -> ${unionType} { auto nullish_coalesce_left = ${left}; if (nullish_coalesce_left.has_value()) return nullish_coalesce_left; return ${right}; }())`;
        }
        context.includes.add('optional');
        return `${emitOptionalExpressionCpp(expression.left, context, expectedType)}.value_or(${emitExpression(expression.right, context, expectedType, true, denseArrayLengthInitialized)})`;
      }
      const logicalOr = emitCppValueLogicalOrExpression(expression, context, expectedType);
      if (logicalOr) return logicalOr;
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
      const referenceIdentity = equality
        ? emitCppReferenceIdentityComparison(expression, leftType, rightType, context)
        : undefined;
      if (referenceIdentity) return referenceIdentity;
      const leftExpected =
        (isThisAccess(expression.left) ? rightType : undefined) ??
        getIrOperatorValueDomainTypeCpp(expression.semantics.left.flow) ??
        getIrExpressionTypeEvidenceCpp(expression.left, context) ??
        getCppClampedArrayElementNumericTypeCpp(expression.left, context);
      const rightExpected =
        (isThisAccess(expression.right) ? leftType : undefined) ??
        getIrOperatorValueDomainTypeCpp(expression.semantics.right.flow) ??
        getIrExpressionTypeEvidenceCpp(expression.right, context) ??
        getCppClampedArrayElementNumericTypeCpp(expression.right, context);
      const left = emitExpression(expression.left, context, leftExpected);
      const right = emitExpression(expression.right, context, rightExpected);
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
      if (isCppAmbientObjectMemberCallCpp(expression, 'assign')) {
        const recordAssigned = emitRecordObjectAssignCpp(expression, context);
        if (recordAssigned) return recordAssigned;
        const assigned = emitClosedCallableObjectAssignCpp(expression, context);
        if (!assigned) {
          emissionError(
            context,
            'Object.assign requires one closed callable-object target and an exact compatible object literal source',
          );
        }
        return assigned;
      }
      if (isCppAmbientObjectMemberCallCpp(expression, 'freeze') && expression.arguments.length === 1) {
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
      const typedArrayFill = emitCppTypedArrayRangeFillCpp(expression, context);
      if (typedArrayFill) return typedArrayFill;
      if (
        expression.callee.kind === 'property' &&
        expression.callee.name === 'toString' &&
        (expression.callee.member?.receiver === 'number' ||
          isIrNumberTypeEvidenceCpp(getIrExpressionTypeEvidenceCpp(expression.callee.object, context)))
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        if (expression.arguments.length === 1) {
          if (getCppRuntimeProfile(context.options) !== 'flight-cpp') {
            emissionError(context, 'radix-bearing number toString requires a downstream runtime mapping');
          }
          context.includes.add('flight/number.hpp');
          return `flight::number_to_string(${receiver}, ${emitExpression(expression.arguments[0]!, context)})`;
        }
        const value = `std::to_string(${receiver})`;
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return `flight::to_string(${receiver})`;
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
          // These mutating Array methods return the receiver itself. Carry the result context into
          // the receiver so a spread and its inferred local do not acquire distinct anonymous C++
          // element carriers for the same structural TypeScript row.
          const receiverExpectedType =
            expression.callee.member.receiver === 'array' &&
            cppArraySelfReturningMethods.has(expression.callee.member.name)
              ? expectedType
              : undefined;
          const receiver = emitExpression(
            expression.callee.object,
            context,
            receiverExpectedType,
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
            expression.presence === 'narrowedPresent' &&
            ((expression.callee.member.receiver === 'map' && expression.callee.member.name === 'get') ||
              (expression.callee.member.receiver === 'array' &&
                cppOptionalArrayMethods.has(expression.callee.member.name)))
          ) {
            return `${call}.value()`;
          }
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
        expression.callee.reference.name === 'Symbol' &&
        expression.arguments.length === 1 &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        context.includes.add('flight/symbol.hpp');
        return `flight::Symbol(${emitExpression(expression.arguments[0]!, context)})`;
      }
      if (
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'String' &&
        expression.arguments.length === 1
      ) {
        const argument = expression.arguments[0]!;
        const arg = emitExpression(argument, context);
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          const argumentType = getIrExpressionTypeEvidenceCpp(argument, context);
          const union = argumentType ? getIrUnionTypeCpp(argumentType, context, new Set()) : undefined;
          const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
          if (plan?.kind === 'multiVariant') {
            context.includes.add('variant');
            return `std::visit([](const auto& value) { return flight::to_string(value); }, ${arg})`;
          }
          return `flight::to_string(${arg})`;
        }
        context.includes.add('string');
        return `std::to_string(${arg})`;
      }
      const hasDependentCallableSpread = expression.arguments.some(
        (argument) => getCppDependentCallableSpreadParameter(argument, context) !== undefined,
      );
      const callableExpression = hasDependentCallableSpread
        ? unwrapCppAnyRestCallableCast(expression.callee)
        : expression.callee;
      const callee =
        callableExpression.kind === 'function'
          ? `(${emitExpression(callableExpression, context)})`
          : emitExpression(callableExpression, context);
      const args = appendCppOmittedInvocationArguments(
        expression,
        emitCppClosedRestCallArguments(expression, context) ??
          expression.arguments.map((argument, index) => {
            const dependentSpread = emitCppDependentCallableSpreadArgument(
              argument,
              index,
              expression.arguments.length,
              context,
            );
            if (dependentSpread) return dependentSpread;
            if (
              argument.kind === 'spread' &&
              expression.semantics.signature?.restParameter === index &&
              index === expression.arguments.length - 1
            ) {
              return emitExpression(argument.expression, context);
            }
            return emitExpression(argument, context, getIrCallArgumentExpectedTypeCpp(expression, index, context));
          }),
        context,
      );
      const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
      const calleeStorageType = getIrExpressionBindingTypeCpp(expression.callee, context) ?? calleeType;
      const calleeAlreadyUnwrapped =
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'binding' &&
        expression.callee.presence === 'narrowedPresent' &&
        context.nullableBindingIds.has(expression.callee.reference.binding.id);
      const optionalCallable = Boolean(
        calleeStorageType &&
        !calleeAlreadyUnwrapped &&
        hasIrTypeAbsentMember(calleeStorageType) &&
        getCppClosedCallableType(calleeStorageType, context, new Set()),
      );
      const callableObject = getCppCallableObjectExpressionCpp(expression.callee, context);
      const invocationTarget = callableObject
        ? optionalCallable
          ? `(*${callee}.value())`
          : `(*${callee})`
        : optionalCallable
          ? `${callee}.value()`
          : callee;
      const typeArguments =
        expression.typeArguments.length > 0
          ? expression.typeArguments
          : (getCppContextualCallTypeArgumentsCpp(expression, expectedType, context) ?? []);
      const invocation = `${invocationTarget}${emitCppTypeArguments(typeArguments, context)}(${args.join(', ')})`;
      const returnType = getIrCallReturnTypeCpp(expression, context);
      const returnUnion = returnType ? getIrUnionTypeCpp(returnType, context, new Set()) : undefined;
      const returnPlan = returnUnion ? getCppUnionRepresentationPlan(returnUnion, context) : undefined;
      return expression.presence === 'narrowedPresent' && returnPlan?.kind === 'optionalSingle'
        ? `${invocation}.value()`
        : invocation;
    }
    case 'cast': {
      if (isCppErasedWeakMapType(getIrExpressionTypeEvidenceCpp(expression.expression, context), context)) {
        if (getCppErasedWeakMapViewPlan(expression, context)) {
          emissionError(context, 'erased WeakMap assertion requires a local typed-view binding');
        }
        emissionError(context, 'erased WeakMap assertion target requires an approved typed WeakMap view');
      }
      const structuralTarget = context.referenceRepresentationPlanner.resolveStructuralRow(
        expression.type,
        context.module,
      );
      const structuralSourceType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
      const structuralSource = structuralSourceType
        ? context.referenceRepresentationPlanner.resolveStructuralRow(structuralSourceType, context.module)
        : undefined;
      const structuralProjectionTarget = structuralSource
        ? getCppStructuralProjectionRowCpp(expression.type, context)
        : undefined;
      if (
        (structuralTarget || structuralProjectionTarget) &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        if (expression.expression.kind === 'object') {
          return emitExpression(expression.expression, context, expression.type);
        }
        const structuralSourceObject = structuralSource
          ? getCppStructuralRowObjectTypeCpp(structuralSource)
          : undefined;
        if (
          structuralSourceObject &&
          emitType(structuralSourceObject, context) === emitType(expression.type, context)
        ) {
          return `flight::structural_ref_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`;
        }
        const target = structuralProjectionTarget
          ? emitCppStructuralRowReferenceTypeCpp(structuralProjectionTarget, context)
          : emitType(expression.type, context);
        return `flight::structural_ref_cast<${target}>(${emitExpression(expression.expression, context)})`;
      }
      if (
        structuralSource &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        structuralSourceType
      ) {
        const targetPlan = context.referenceRepresentationPlanner.plan(expression.type, context.module);
        if (
          targetPlan.kind !== 'represented' ||
          targetPlan.identityDomain !== 'object' ||
          targetPlan.valueRepresentation === 'inlineValue'
        ) {
          emissionError(context, 'structural-row projection requires a represented object-reference target');
        }
        context.includes.add('flight/structural_ref.hpp');
        return `flight::structural_ref_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`;
      }
      const conditionalFacet = context.referenceRepresentationPlanner.resolveConditionalFacetReference(
        expression.type,
        context.module,
      );
      if (conditionalFacet) {
        if (getCppRuntimeProfile(context.options) !== 'flight-cpp') {
          emissionError(context, 'conditional facet assertion requires the flight-cpp runtime profile');
        }
        const sourceType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
        const sourcePlan = sourceType
          ? context.referenceRepresentationPlanner.plan(sourceType, context.module)
          : undefined;
        if (
          !sourceType ||
          sourcePlan?.kind !== 'represented' ||
          sourcePlan.valueRepresentation !== 'flightReference' ||
          normalizeCompilerStructuralValueCanonical(sourceType) !==
            normalizeCompilerStructuralValueCanonical(conditionalFacet.base)
        ) {
          emissionError(context, 'conditional facet assertion requires the exact proven Flight reference base');
        }
        context.includes.add('flight/conditional_facet_ref.hpp');
        return `flight::assume_conditional_facets<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context, conditionalFacet.base)})`;
      }
      const asserted = emitUnionMemberAssertionCpp(expression.expression, expression.type, context);
      const callableTypeParameter = getCppCallableTypeParameterCpp(expression.type, context);
      if (
        callableTypeParameter &&
        expression.expression.kind === 'cast' &&
        expression.expression.type.kind === 'unknown'
      ) {
        return `${getCompilerCallableSignatureAbiCpp().bind}<${callableTypeParameter}>(${emitExpression(expression.expression.expression, context)})`;
      }
      const callableObject = getCppCallableObjectIrTypeCpp(expression.type, context, new Set());
      if (callableObject && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        if (
          expression.expression.kind !== 'function' ||
          !isCppFunctionExpressionCompatibleWithCallableObjectCpp(expression.expression, callableObject, context)
        ) {
          emissionError(context, 'callable-object construction requires one compatible nongeneric function expression');
        }
        const storageType = emitType(expression.type, context, 'storage');
        const callableFieldName = getCppCallableObjectFieldNameCpp(callableObject.properties);
        return `flight::make_ref<${storageType}>(${storageType}{.${callableFieldName} = ${emitExpression(expression.expression, context, callableObject.callable)}})`;
      }
      return (
        asserted ??
        `static_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`
      );
    }
    case 'conditional': {
      const evidence =
        expression.condition.kind === 'binary' ? expression.condition.semantics.unionMemberTest : undefined;
      const branchContext = (result: boolean): EmitContext => {
        if (!evidence) return context;
        const narrowedType =
          evidence.whenResult === result ? evidence.member : getCppUnionMemberComplementTypeCpp(evidence, context);
        return narrowedType
          ? {
              ...context,
              narrowedBindingTypes: new Map(context.narrowedBindingTypes).set(evidence.binding.id, narrowedType),
            }
          : context;
      };
      return `(${emitCppTruthinessExpression(expression.condition, context)} ? ${emitCppConditionalBranchCpp(expression.whenTrue, branchContext(true), expectedType)} : ${emitCppConditionalBranchCpp(expression.whenFalse, branchContext(false), expectedType)})`;
    }
    case 'element': {
      const narrowedPresent = emitCppNarrowedPresentAccessCpp(expression, context, expectedType);
      if (narrowedPresent) return narrowedPresent;
      if (expression.optional) return emitOptionalElementExpressionCpp(expression, context);
      const structuralRow = getCppStructuralRowExpressionPlanCpp(expression.object, context);
      if (structuralRow) {
        const valueType = getIrExpressionTypeEvidenceCpp(expression, context);
        if (!valueType) emissionError(context, 'structural-row computed access requires concrete value evidence');
        context.includes.add('flight/structural_ref.hpp');
        return `flight::row_get<${emitType(valueType, context)}>(${emitExpression(expression.object, context)}, ${emitExpression(expression.index, context)})`;
      }
      const computedProperty = emitComputedSymbolElementAccessCpp(expression, context);
      if (computedProperty) return computedProperty;
      const variantIndexedAccess = emitCppVariantIndexedElementAccessCpp(expression, context);
      if (variantIndexedAccess) return variantIndexedAccess;
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        hasCppRegExpExecArrayIndexedReceiverCpp(expression, context)
      ) {
        return `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
      }
      const elementObjectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        elementObjectType &&
        isCppStringValueTypeCpp(elementObjectType, context, new Set())
      ) {
        return `${emitExpression(expression.object, context)}.char_at(${emitExpression(expression.index, context)})`;
      }
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && hasIndexedRuntimeReceiverCpp(expression, context)) {
        const access = `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
        return expectedType?.kind === 'primitive' &&
          expectedType.name === 'number' &&
          isCppUint8ClampedArrayElementCpp(expression, context)
          ? `static_cast<double>(${access})`
          : access;
      }
      if (expression.semantics.receivers.includes('tuple')) {
        context.includes.add('tuple');
        const index = getElementAccessTupleIndexCpp(expression, context);
        return `std::get<${String(index)}>(${emitExpression(expression.object, context)})`;
      }
      const object = emitExpression(expression.object, context);
      const index = emitExpression(expression.index, context);
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      const record = getCppRecordTypeArgumentsCpp(objectType, context, new Set());
      if (record && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return `${object}.get(${emitCppRequiredRecordKeyCpp(expression.index, record.key, context)}).value()`;
      }
      return record || expression.semantics.receivers.every((receiver) => receiver === 'object')
        ? `${object}[${index}]`
        : `${object}[static_cast<size_t>(${index})]`;
    }
    case 'function': {
      if (expression.async) emissionError(context, 'async closures require C++ coroutine lowering');
      const expectedCallable =
        (expectedType ? getCppClosedCallableType(expectedType, context, new Set()) : undefined) ??
        (expectedType ? getCppCallableObjectIrTypeCpp(expectedType, context, new Set())?.callable : undefined);
      const parameters =
        expectedCallable?.parameters.length === expression.parameters.length
          ? expression.parameters.map((parameter, index) =>
              parameter.type.kind === 'unknown' && parameter.type.source === 'any'
                ? { ...parameter, type: expectedCallable.parameters[index]!.type }
                : parameter,
            )
          : expression.parameters;
      const returns = expectedCallable?.returns ?? expression.returns;
      const functionContext: EmitContext = {
        ...context,
        activeDependentCallablePackIds: mergeCppDependentCallablePackIds(
          context.activeDependentCallablePackIds,
          parameters,
        ),
        anonymousStructTypeParameters: mergeIrTypeParametersCpp(
          context.anonymousStructTypeParameters,
          expression.typeParameters,
        ),
        async: false,
        defaultedParameterIds: new Set([
          ...context.defaultedParameterIds,
          ...collectDefaultedParameterIdsCpp(parameters),
        ]),
        enclosingReturnType: returns,
        namespaceScope: false,
        returnsAbsent: hasIrTypeAbsentMember(returns),
      };
      const usesThis = irFunctionExpressionUsesThisCpp(expression);
      if (usesThis && expression.thisMode === 'dynamic') {
        emissionError(context, 'dynamic-this closures require receiver lowering');
      }
      if (usesThis && !context.currentClass) {
        emissionError(context, 'lexical-this closure requires class receiver context');
      }
      functionContext.includes.add('functional');
      const template = emitCppFunctionTemplate(expression.typeParameters, parameters, functionContext);
      const params = parameters.map((parameter) => emitParameter(parameter, functionContext));
      const capture = usesThis
        ? context.namespaceScope
          ? '[this]'
          : '[=, this]'
        : context.namespaceScope
          ? '[]'
          : '[=]';
      const lambdaTemplate = template.parameters ? template.parameters : '';
      const lambdaRequirement = template.requirement ? ` requires ${template.requirement}` : '';
      if (
        expression.expression &&
        functionContext.defaultedParameterIds.size === 0 &&
        !hasSharedCaptureParameterCpp(parameters, functionContext)
      ) {
        return `${capture}${lambdaTemplate}(${params.join(', ')})${lambdaRequirement} { return ${emitExpression(expression.expression, functionContext, returns)}; }`;
      }
      return `${capture}${lambdaTemplate}(${params.join(', ')})${lambdaRequirement} {\n${indentSourceLines([
        ...emitParameterInitializersCpp(parameters, functionContext),
        ...(expression.expression
          ? [`return ${emitExpression(expression.expression, functionContext, returns)};`]
          : [
              ...emitStatements(expression.body, functionContext),
              ...emitImplicitCompletionCpp(expression.body, functionContext),
            ]),
      ]).join('\n')}\n}`;
    }
    case 'identifier': {
      if (
        expression.reference.kind === 'binding' &&
        context.dependentCallablePacks.has(expression.reference.binding.id)
      ) {
        emissionError(
          context,
          `dependent callable parameter pack ${expression.reference.binding.name} may only be used as a terminal call spread`,
        );
      }
      if (expression.reference.kind === 'ambient' && expression.reference.name === 'undefined') {
        return emitUndefinedWithExpectedTypeCpp(expectedType, context);
      }
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.reference.kind === 'ambient' &&
        expression.reference.name === 'Proxy'
      ) {
        emissionError(context, 'Proxy values require exact structural write-proxy construction');
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
        context.defaultedParameterIds.has(expression.reference.binding.id) &&
        !context.sharedCaptureTargetNames.has(expression.reference.binding.id)
      ) {
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      if (
        expression.reference.kind === 'binding' &&
        context.arrayElementBindingIds.has(expression.reference.binding.id) &&
        expectedType &&
        !hasIrTypeAbsentMember(expectedType)
      ) {
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      if (
        expression.presence === 'narrowedPresent' &&
        expression.reference.kind === 'binding' &&
        (context.nullableBindingIds.has(expression.reference.binding.id) ||
          context.arrayElementBindingIds.has(expression.reference.binding.id))
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
        if (plan?.kind === 'optionalVariant') {
          const narrowedType = context.narrowedBindingTypes.get(expression.reference.binding.id);
          const narrowedUnion = narrowedType ? getIrUnionTypeCpp(narrowedType, context, new Set()) : undefined;
          const narrowedPresentMembers = (narrowedUnion?.types ?? (narrowedType ? [narrowedType] : [])).filter(
            (member) => member.kind !== 'null' && member.kind !== 'undefined',
          );
          if (narrowedPresentMembers.length === 1) {
            const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
            const narrowedTarget = emitType(narrowedPresentMembers[0]!, isolatedContext);
            const matchingSlots = plan.valueSlots.filter(
              (slot) =>
                slot.targetType === narrowedTarget ||
                slot.sourceAlternatives.some((member) => isDeepStrictEqual(member, narrowedPresentMembers[0]!)),
            );
            if (matchingSlots.length === 1) {
              context.includes.add('variant');
              return `std::get<${matchingSlots[0]!.targetType}>(${emitIdentifierReference(expression.reference, context)}.value())`;
            }
          }
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
      const structuralWriteProxy = emitCppStructuralWriteProxyConstructionCpp(expression, expectedType, context);
      if (structuralWriteProxy) return structuralWriteProxy;
      const ambientConstructorName = getIrAmbientConstructorNameCpp(expression.callee);
      const constructedType = getIrNewExpressionTypeEvidenceCpp(expression, context);
      const mapType =
        getCppRuntimeProfile(context.options) === 'flight-cpp' && ambientConstructorName === 'Map'
          ? getIrAmbientCollectionTypeCpp(constructedType, context, new Set())
          : undefined;
      const args = expression.arguments.map((argument, index) => {
        const mapEntries =
          index === 0 && mapType?.reference.name === 'Map'
            ? emitCppMapLiteralConstructorEntriesCpp(argument, mapType, context)
            : undefined;
        return (
          mapEntries ??
          emitExpression(
            argument,
            context,
            ambientConstructorName
              ? (getIrInvocationProvidedArgumentTypeCpp(expression, index) ??
                  getIrInvocationArgumentExpectedTypeCpp(expression, index))
              : getIrInvocationArgumentExpectedTypeCpp(expression, index),
          )
        );
      });
      if (expression.semantics.construction === 'factory' && ambientConstructorName === undefined) {
        return `${emitExpression(expression.callee, context)}.construct(${args.join(', ')})`;
      }
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
      const weakMapConstructionType =
        getCppRuntimeProfile(context.options) === 'flight-cpp' && ambientConstructorName === 'WeakMap'
          ? getIrWeakMapTypeCpp(
              expression.typeArguments.length > 0 ? constructedType : expectedType,
              context,
              new Set(),
            )
          : undefined;
      const contextualArrayTypeArguments =
        ambientConstructorName === 'Array' && expectedType?.kind === 'array' ? [expectedType.element] : [];
      const contextualConstructedType = expectedType
        ? getCppNonNullableType(expectedType, context, new Set())
        : undefined;
      const contextualNamedTypeArguments = getCppContextualAmbientConstructorTypeArgumentsCpp(
        ambientConstructorName,
        contextualConstructedType,
      );
      const eraseRuntimeTypeArguments =
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        ambientConstructorName !== undefined &&
        isCppRuntimeTypeWithErasedTypeArguments(ambientConstructorName);
      const typeArguments = emitCppTypeArguments(
        eraseRuntimeTypeArguments
          ? []
          : contextualNamedTypeArguments.length > 0
            ? contextualNamedTypeArguments
            : expression.typeArguments.length > 0
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
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && ambientConstructorName === 'WeakMap') {
        if (!weakMapConstructionType) {
          emissionError(context, 'flight-cpp WeakMap construction requires explicit or contextual type arguments');
        }
        return `${emitType(weakMapConstructionType, context)}(${args.join(', ')})`;
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
      if (expression.members.some((member) => member.kind === 'getAccessor')) {
        emissionError(context, 'object getters require target-specific accessor lowering');
      }
      const expectedPayload =
        expectedType && hasIrTypeAbsentMember(expectedType)
          ? getCppNonNullableType(expectedType, context, new Set())
          : undefined;
      const constructionType =
        expectedType &&
        (hasFlightReferenceRepresentationCpp(expectedType, context) ||
          hasFlightStructuralRowRepresentationCpp(expectedType, context))
          ? expectedType
          : expectedPayload &&
              (hasFlightReferenceRepresentationCpp(expectedPayload, context) ||
                hasFlightStructuralRowRepresentationCpp(expectedPayload, context))
            ? expectedPayload
            : expression.type;
      const record = getCppRecordTypeArgumentsCpp(constructionType, context, new Set());
      if (record) {
        if (expression.members.some((member) => member.kind !== 'property')) {
          emissionError(context, 'Record construction with spreads requires ordered entry lowering');
        }
        const entries = expression.members.map((member) => {
          if (member.kind !== 'property') throw new TypeError('expected Record property');
          const key = emitCppRecordLiteralKey(member.name, record.key, context);
          return `{${key}, ${emitExpression(member.value, context, record.value)}}`;
        });
        return `{${entries.join(', ')}}`;
      }
      const structuralRow = context.referenceRepresentationPlanner.resolveStructuralRow(
        constructionType,
        context.module,
      );
      if (structuralRow && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        const spread =
          expression.members.length === 1 && expression.members[0]?.kind === 'spread'
            ? expression.members[0]
            : undefined;
        if (spread) {
          const properties = context.referenceRepresentationPlanner.resolveObjectShape(
            constructionType,
            context.module,
          );
          const sourceType = getIrExpressionTypeEvidenceCpp(spread.expression, context);
          if (
            !properties ||
            properties.some((property) => property.computedKey) ||
            !sourceType ||
            !hasFlightStructuralRowRepresentationCpp(sourceType, context)
          ) {
            emissionError(context, 'structural-row spread construction requires one closed named structural source');
          }
          const sourceName = getGeneratedTargetName('structuralSpreadSource', context);
          const source = emitExpression(spread.expression, context, sourceType);
          const fields = properties.map(
            (property) =>
              `flight::row_field<flight::RowKey<${JSON.stringify(property.name)}>>(flight::row_get<flight::RowKey<${JSON.stringify(property.name)}>>(${sourceName}))`,
          );
          context.includes.add('flight/structural_ref.hpp');
          return `([&]() { auto&& ${sourceName} = ${source}; return flight::make_structural_ref<${emitCppStructuralRowSchemaTypeCpp(structuralRow, context)}>(${fields.join(', ')}); }())`;
        }
        if (expression.members.some((member) => member.kind !== 'property')) {
          emissionError(context, 'structural-row construction requires explicit named properties');
        }
        const fields = expression.members.map((member) => {
          if (member.kind !== 'property') throw new TypeError('expected structural-row property');
          const propertyType = getIrObjectPropertyTypeCpp(constructionType, member.name, context);
          return `flight::row_field<flight::RowKey<${JSON.stringify(member.name)}>>(${emitExpression(member.value, context, propertyType)})`;
        });
        context.includes.add('flight/structural_ref.hpp');
        return `flight::make_structural_ref<${emitCppStructuralRowSchemaTypeCpp(structuralRow, context)}>(${fields.join(', ')})`;
      }
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
      const properties = expression.members.filter(
        (member): member is typeof member & { kind: 'property' } => member.kind === 'property',
      );
      const constructionProperties = context.referenceRepresentationPlanner.resolveObjectShape(
        constructionType,
        context.module,
      );
      const propertiesByName = new Map(properties.map((property) => [property.name, property] as const));
      const orderedProperties =
        constructionProperties && propertiesByName.size === properties.length
          ? constructionProperties.flatMap((property) => {
              const member = propertiesByName.get(property.name);
              return member ? [member] : [];
            })
          : properties;
      const construction = (initializer: string): string => {
        if (
          getCppRuntimeProfile(context.options) === 'flight-cpp' &&
          hasFlightReferenceRepresentationCpp(constructionType, context)
        ) {
          const storageType =
            getCppReferenceValueAliasStorageTypeCpp(constructionType, context, new Set()) ??
            emitType(constructionType, context, 'storage');
          return `flight::make_ref<${storageType}>(${storageType}${initializer})`;
        }
        return initializer;
      };
      const reordered =
        orderedProperties.length === properties.length &&
        orderedProperties.some((property, index) => property !== properties[index]);
      if (reordered) {
        const temporaries = new Map(
          properties.map(
            (property) => [property, getGeneratedTargetName(`object_member_${property.name}`, context)] as const,
          ),
        );
        const evaluations = properties.map(
          (property) =>
            `auto ${temporaries.get(property)!} = ${emitExpression(property.value, context, getIrObjectPropertyTypeCpp(constructionType, property.name, context))};`,
        );
        const initializer = `{${orderedProperties
          .map((property) => `.${safeCppName(property.name)} = ${temporaries.get(property)!}`)
          .join(', ')}}`;
        return `(${context.namespaceScope ? '[]' : '[&]'}() { ${evaluations.join(' ')} return ${construction(initializer)}; }())`;
      }
      const initializer = `{${properties
        .map(
          (property) =>
            `.${safeCppName(property.name)} = ${emitExpression(property.value, context, getIrObjectPropertyTypeCpp(constructionType, property.name, context))}`,
        )
        .join(', ')}}`;
      return construction(initializer);
    }
    case 'property': {
      const narrowedPresent = emitCppNarrowedPresentAccessCpp(expression, context, expectedType);
      if (narrowedPresent) return narrowedPresent;
      if (expression.optional) return emitOptionalPropertyExpressionCpp(expression, context, expectedType);
      if (getCppStructuralRowExpressionPlanCpp(expression.object, context)) {
        context.includes.add('flight/structural_ref.hpp');
        return `flight::row_get<flight::RowKey<${JSON.stringify(expression.name)}>>(${emitExpression(expression.object, context)})`;
      }
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
      const nullishNegation = emitCppNullishObjectNegation(expression, context);
      if (nullishNegation) return nullishNegation;
      if (
        expression.operator === 'typeof' &&
        expression.operand.kind === 'identifier' &&
        expression.operand.reference.kind === 'binding' &&
        getIrBindingVariantUnionTypeCpp(expression.operand.reference.binding.id, context)
      ) {
        emissionError(context, 'typeof on a C++ variant requires proven union member test evidence');
      }
      if (expression.operator === 'typeof') {
        const value = getCppStaticTypeofValueCpp(expression.operand, context);
        if (!value) emissionError(context, 'typeof requires closed runtime type evidence');
        return getCppRuntimeProfile(context.options) === 'flight-cpp'
          ? `flight::String(${JSON.stringify(value)})`
          : `std::string(${JSON.stringify(value)})`;
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
      if (
        operator === '!' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        !isCppBooleanExpressionTypeCpp(expression.operand, context)
      ) {
        context.includes.add('flight/boolean.hpp');
        return `!flight::to_boolean(${operand})`;
      }
      if (!expression.postfix && (operator === '-' || operator === '+') && operand.startsWith(operator)) {
        return `${operator}(${operand})`;
      }
      return expression.postfix ? `${operand}${operator}` : `${operator}${operand}`;
    }
    case 'undefinedValue':
      return emitUndefinedWithExpectedTypeCpp(expectedType, context);
    case 'undefinedDefault': {
      context.includes.add('optional');
      return `${emitExpression(expression.value, context)}.value_or(${emitExpression(expression.fallback, context, expectedType)})`;
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

function emitCppContextualStructuralReferenceCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const sourceType = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!sourceType) return undefined;
  const sourceRow = context.referenceRepresentationPlanner.resolveStructuralRow(sourceType, context.module);
  const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(expectedType, context.module);
  if (targetRow && !sourceRow) {
    const sourceProjection = getCppStructuralProjectionRowCpp(sourceType, context);
    if (!sourceProjection) return undefined;
    const source = emitExpression(expression, context, undefined, false);
    const sourceView = `${emitCppStructuralRowReferenceTypeCpp(sourceProjection, context)}(${source})`;
    return `flight::structural_ref_cast<${emitType(expectedType, context)}>(${sourceView})`;
  }
  if (!sourceRow || targetRow) return undefined;
  const source = emitExpression(expression, context, undefined, false);
  if (expectedType.kind === 'unknown' && expectedType.source === 'object') return `${source}.shared_object()`;
  const sourceObject = getCppStructuralRowObjectTypeCpp(sourceRow);
  const targetPlan = context.referenceRepresentationPlanner.plan(expectedType, context.module);
  if (
    !sourceObject ||
    targetPlan.kind !== 'represented' ||
    targetPlan.identityDomain !== 'object' ||
    targetPlan.valueRepresentation !== 'flightReference' ||
    emitType(sourceObject, context) !== emitType(expectedType, context)
  ) {
    return undefined;
  }
  context.includes.add('flight/structural_ref.hpp');
  return `flight::structural_ref_cast<${emitType(expectedType, context)}>(${source})`;
}

function emitCppOptionalPropertyDualSentinelConversionCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  if (expression.kind !== 'property' || expression.optional || expression.optionalChain) return undefined;
  const receiverType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const property = receiverType
    ? context.referenceRepresentationPlanner
        .resolveObjectShape(receiverType, context.module)
        ?.find((candidate) => candidate.name === expression.name)
    : undefined;
  const sourceUnion = property?.optional ? getIrUnionTypeCpp(property.type, context, new Set()) : undefined;
  const expectedUnion = getIrUnionTypeCpp(expectedType, context, new Set());
  if (!property || !sourceUnion || !expectedUnion) return undefined;
  const sourceSentinels = sourceUnion.types.filter(
    (member): member is Extract<IrType, { kind: 'null' | 'undefined' }> =>
      member.kind === 'null' || member.kind === 'undefined',
  );
  const declaredSourceSentinels = sourceSentinels.filter((member) => member.kind !== 'undefined');
  const sourceValues = sourceUnion.types.filter(
    (member) => member.kind !== 'null' && member.kind !== 'undefined',
  );
  const expectedSentinels = expectedUnion.types.filter(
    (member): member is Extract<IrType, { kind: 'null' | 'undefined' }> =>
      member.kind === 'null' || member.kind === 'undefined',
  );
  const expectedValues = expectedUnion.types.filter(
    (member) => member.kind !== 'null' && member.kind !== 'undefined',
  );
  if (
    declaredSourceSentinels.length !== 1 ||
    sourceValues.length !== 1 ||
    expectedSentinels.length !== 2 ||
    expectedValues.length !== 1 ||
    !expectedSentinels.some((member) => member.kind === 'null') ||
    !expectedSentinels.some((member) => member.kind === 'undefined')
  ) {
    return undefined;
  }
  const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(
    expectedValues[0]!,
    context.module,
  );
  const targetObject = targetRow ? getCppStructuralRowObjectTypeCpp(targetRow) : undefined;
  const sourcePlan = context.referenceRepresentationPlanner.plan(
    sourceValues[0]!,
    getCppTypeReferenceOwnerModuleCpp(sourceValues[0]!, context),
  );
  const sourceTargetType = emitType(sourceValues[0]!, context);
  const expectedTargetType = emitType(expectedValues[0]!, context);
  const structuralProjection =
    targetRow &&
    targetObject &&
    sourcePlan.kind === 'represented' &&
    sourcePlan.identityDomain === 'object' &&
    sourcePlan.valueRepresentation === 'flightReference' &&
    sourceTargetType === emitType(targetObject, context);
  if (!structuralProjection && (targetRow || sourceTargetType !== expectedTargetType)) return undefined;
  const expectedPlan = getCppUnionRepresentationPlan(expectedUnion, context);
  if (expectedPlan.kind !== 'dualSentinelVariant') return undefined;
  const propertyName = getGeneratedTargetName('optionalProperty', context);
  const propertyValue = emitExpression(expression, context, undefined, false);
  const targetType = expectedTargetType;
  const presentValue = structuralProjection
    ? `${targetType}(${propertyName}.value().value())`
    : `${propertyName}.value().value()`;
  const present = emitCppUnionValueConstruction(
    presentValue,
    targetType,
    expectedUnion,
    expectedPlan.kind,
    context,
  );
  const declaredAbsence = emitCppUnionSentinelConstruction(
    declaredSourceSentinels[0]!.kind,
    expectedUnion,
    expectedPlan.kind,
    context,
  );
  const omitted = emitCppUnionSentinelConstruction('undefined', expectedUnion, expectedPlan.kind, context);
  const resultType = emitUnionTypeCpp(expectedUnion, context);
  return `([&]() -> ${resultType} { auto ${propertyName} = ${propertyValue}; if (!${propertyName}.has_value()) return ${omitted}; if (!${propertyName}.value().has_value()) return ${declaredAbsence}; return ${present}; }())`;
}

function getCppStructuralRowObjectTypeCpp(row: Readonly<CompilerCppStructuralRowPlan>): Readonly<IrType> | undefined {
  if (row.kind === 'rowOf') return row.type;
  if (row.kind !== 'merge') return getCppStructuralRowObjectTypeCpp(row.row);
  const sources = row.rows.map(getCppStructuralRowObjectTypeCpp);
  if (!sources[0] || sources.some((source) => !source)) return undefined;
  const canonical = normalizeCompilerStructuralValueCanonical(sources[0]);
  return sources.every((source) => normalizeCompilerStructuralValueCanonical(source!) === canonical)
    ? sources[0]
    : undefined;
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

function emitCppMapLiteralConstructorEntriesCpp(
  expression: Readonly<IrExpression>,
  mapType: Readonly<IrAmbientNamedTypeCpp>,
  context: EmitContext,
): string | undefined {
  const [keyType, valueType] = mapType.typeArguments;
  if (expression.kind !== 'array' || !keyType || !valueType) return undefined;
  const entries = expression.elements.map((element): string | undefined => {
    if (!element || element.kind !== 'tuple' || element.elements.length !== 2) return undefined;
    const [key, value] = element.elements;
    if (!key || !value || key.optional || value.optional) return undefined;
    return `{${emitExpression(key.expression, context, keyType)}, ${emitExpression(value.expression, context, valueType)}}`;
  });
  return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(', ')}}`;
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

function isCppStringValueTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): boolean {
  if (type.kind === 'primitive') return type.name === 'string';
  if (type.kind === 'literal') return typeof type.value === 'string';
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return false;
  const alias = resolveCppTypeAliasTarget(type, context);
  return alias ? isCppStringValueTypeCpp(alias, context, new Set(resolvingAliases).add(bindingId)) : false;
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
        `} while (${emitCppTruthinessExpression(statement.condition, context)});`,
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
      const iterableType = getIrExpressionTypeEvidenceCpp(statement.iterable, context);
      const iterableElementType = iterableType
        ? getIrIterableElementTypeCpp(iterableType, context, new Set())
        : undefined;
      if (
        iterableElementType &&
        (!statement.variable.type ||
          statement.variable.type.kind === 'unknown' ||
          (statement.variable.type.kind === 'tuple' &&
            statement.variable.type.elements.some((element) => element.type.kind === 'unknown')))
      ) {
        context.preservedInitializerTypes.set(statement.variable.binding.id, iterableElementType);
      }
      if (iterableType && isCppStringValueTypeCpp(iterableType, context, new Set())) {
        emissionError(context, 'string for-of requires a Unicode code-point iteration runtime contract');
      }
      const collectionView = getCppCollectionIterationView(statement.iterable, context);
      const iterableExpression = collectionView?.collection ?? statement.iterable;
      const literalElementType =
        !collectionView && statement.iterable.kind === 'array' && statement.variable.type
          ? ({ element: statement.variable.type, kind: 'array', readonly: false } as const)
          : undefined;
      const iterable = emitExpression(iterableExpression, context, literalElementType);
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
        `if (${emitCppTruthinessExpression(statement.condition, context)}) {`,
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
        const unionMemberTest =
          switchCase.unionMemberTest ??
          getCppSwitchCaseUnionMemberTestCpp(statement.expression, switchCase.expression!, context);
        lines.push(
          `${index > 0 ? 'else ' : ''}if (${name} == ${emitExpression(switchCase.expression!, context)}) {`,
          ...indentSourceLines(emitSwitchCaseStatementsCpp(switchCase, statement.label, context, unionMemberTest)),
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
        `while (${emitCppTruthinessExpression(statement.condition, context)}) {`,
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
  unionMemberTest: Readonly<IrUnionMemberTestEvidence> | undefined = switchCase.unionMemberTest,
): string[] {
  const last = switchCase.statements.at(-1);
  const localBreak = last?.kind === 'break' && (!last.target || (switchLabel && last.target.id === switchLabel.id));
  const caseContext = unionMemberTest
    ? {
        ...context,
        narrowedBindingTypes: new Map(context.narrowedBindingTypes).set(
          unionMemberTest.binding.id,
          unionMemberTest.member,
        ),
      }
    : context;
  return emitStatements(localBreak ? switchCase.statements.slice(0, -1) : switchCase.statements, caseContext);
}

function getCppSwitchCaseUnionMemberTestCpp(
  discriminant: Readonly<IrExpression>,
  caseExpression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrUnionMemberTestEvidence> | undefined {
  if (
    discriminant.kind !== 'property' ||
    discriminant.object.kind !== 'identifier' ||
    discriminant.object.reference.kind !== 'binding' ||
    caseExpression.kind !== 'literal'
  ) {
    return undefined;
  }
  const binding = discriminant.object.reference.binding;
  const declared = getCppBindingTypeCpp(binding.id, context);
  const union = declared ? getIrUnionTypeCpp(declared, context, new Set()) : undefined;
  if (!union) return undefined;
  const matching = getCppUnionRepresentationPlan(union, context).valueSlots.filter((slot) => {
    const property = getIrObjectPropertyTypeCpp(slot.runtimeType, discriminant.name, context);
    if (!property) return false;
    if (property.kind === 'literal') return property.value === caseExpression.value;
    return property.kind === 'union'
      ? property.types.some(
          (alternative) => alternative.kind === 'literal' && alternative.value === caseExpression.value,
        )
      : false;
  });
  return matching.length === 1 ? { binding, member: matching[0]!.runtimeType, whenResult: true } : undefined;
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

function emitCppConditionalFacetReferenceTypeCpp(
  representation: Readonly<CompilerCppConditionalFacetReferencePlan>,
  context: EmitContext,
): string {
  context.includes.add('flight/conditional_facet_ref.hpp');
  if (
    representation.check.kind !== 'named' ||
    representation.check.reference.kind !== 'binding' ||
    representation.check.reference.binding.kind !== 'typeParameter'
  ) {
    emissionError(context, 'conditional facet check requires one bare C++ type parameter');
  }
  const base = emitType(representation.base, context, 'storage');
  const check = emitType(representation.check, context, 'storage');
  const rules = representation.rules.map((rule) => {
    if (
      rule.facet.kind !== 'named' ||
      rule.facet.reference.kind !== 'binding' ||
      rule.facet.reference.binding.kind !== 'interface' ||
      rule.facet.reference.path.length > 0 ||
      rule.facet.typeArguments.length > 0
    ) {
      emissionError(context, 'conditional facet rule requires one local nongeneric facet interface');
    }
    const tag = getCppFacetTagNameCpp(rule.facet.reference.binding, context);
    const accessors = rule.path.map((segment) => {
      const member = safeCppName(segment);
      return `[]<typename Value>(Value& value) -> decltype((value.${member})) { return value.${member}; }`;
    });
    return `flight::RequiredMemberFacet<${tag}, flight::MemberPath<${accessors.join(', ')}>>`;
  });
  return `flight::ConditionalFacetRef<${base}, ${check}, ${rules.join(', ')}>`;
}

function emitCppStructuralRowReferenceTypeCpp(
  representation: Readonly<CompilerCppStructuralRowPlan>,
  context: EmitContext,
): string {
  context.includes.add('flight/structural_ref.hpp');
  return `flight::StructuralRef<${emitCppStructuralRowSchemaTypeCpp(representation, context)}>`;
}

function emitCppStructuralRowSchemaTypeCpp(
  representation: Readonly<CompilerCppStructuralRowPlan>,
  context: EmitContext,
): string {
  switch (representation.kind) {
    case 'merge':
      return `flight::RowMerge<${representation.rows.map((row) => emitCppStructuralRowSchemaTypeCpp(row, context)).join(', ')}>`;
    case 'partial':
      return `flight::RowPartial<${emitCppStructuralRowSchemaTypeCpp(representation.row, context)}>`;
    case 'readonly':
      return `flight::RowReadonly<${emitCppStructuralRowSchemaTypeCpp(representation.row, context)}>`;
    case 'rowOf':
      return `flight::RowOf<${emitType(representation.type, context)}>`;
    case 'writable':
      return `flight::RowWritable<${emitCppStructuralRowSchemaTypeCpp(representation.row, context)}>`;
  }
}

function getCppFacetTagNameCpp(binding: Readonly<IrTypeBindingIdentity>, context: EmitContext): string {
  const existing = context.facetTagNames.get(binding.id);
  if (existing) return existing;
  const base = `${getBindingTargetName(binding, context)}Facet`;
  const name = getGeneratedTargetName(base, context);
  context.facetTagNames.set(binding.id, name);
  return name;
}

function emitType(type: Readonly<IrType>, context: EmitContext, representation: 'storage' | 'value' = 'value'): string {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
    if (
      type.kind === 'named' &&
      type.reference.kind === 'binding' &&
      type.reference.binding.kind === 'typeParameter' &&
      type.reference.path.length === 0 &&
      type.typeArguments.length === 0
    ) {
      return getTypeReferenceTargetName(type, context);
    }
    if (type.kind !== 'named' || type.reference.kind === 'ambient') {
      const structuralRow = context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module);
      if (structuralRow) return emitCppStructuralRowReferenceTypeCpp(structuralRow, context);
    }
    const projection = getCppCallableObjectIndexedProjectionCpp(type, context);
    if (projection) {
      const valueType = emitCppCallableObjectIndexedProjectionTypeCpp(projection, context);
      return representation === 'value' ? valueType : `typename ${valueType}::element_type`;
    }
    if (isCppCallableObjectValueAliasCpp(type, context)) {
      const valueType = getTypeReferenceTargetName(type, context);
      return representation === 'value' ? valueType : `typename ${valueType}::element_type`;
    }
  }
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
  const importedScalarAlias = getCppImportedScalarAliasTypeCpp(type, context);
  if (importedScalarAlias) return emitType(importedScalarAlias, context, representation);
  const callableTypeParameter =
    getCppRuntimeProfile(context.options) === 'flight-cpp' ? getCppCallableTypeParameterCpp(type, context) : undefined;
  if (callableTypeParameter) return callableTypeParameter;
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
    hasFlightReferenceRepresentationCpp(type, context) &&
    !isCppReferenceValueAliasCpp(type, context)
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
    case 'conditionalFacet':
      emissionError(context, 'conditional facet must be enclosed by one proven shared-referent base');
    case 'function': {
      context.includes.add('functional');
      const parameters = type.parameters.map((parameter) =>
        emitOptionalTypeCpp(
          emitCppParameterTypeCpp(parameter.type, parameter.rest, context),
          parameter.optional,
          context,
        ),
      );
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
      const conditionalFacet = context.referenceRepresentationPlanner.resolveConditionalFacetReference(
        type,
        context.module,
      );
      if (conditionalFacet && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return emitCppConditionalFacetReferenceTypeCpp(conditionalFacet, context);
      }
      const erasedValue = getCppErasedIntersectionValueType(type, context);
      if (erasedValue) return emitType(erasedValue, context, representation);
      const callableOverloads = getCppCallableOverloadIntersectionCpp(type);
      if (callableOverloads && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return emitCppCallableOverloadStorageTypeCpp(type, callableOverloads, context);
      }
      const callableObject = getCppCallableObjectIntersectionCpp(type, context);
      if (callableObject && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return emitCppCallableObjectStorageTypeCpp(type, callableObject, context);
      }
      const properties = context.referenceRepresentationPlanner.resolveObjectShape(type, context.module);
      if (properties) {
        const nominalImplementation =
          getCppRuntimeProfile(context.options) === 'flight-cpp'
            ? emitCppNominalIntersectionImplementationTypeCpp(type, properties, context)
            : undefined;
        return nominalImplementation ?? emitType({ kind: 'object', properties }, context, representation);
      }
      const distributed = context.referenceRepresentationPlanner.resolveClosedIntersectionDistribution(
        type,
        context.module,
      );
      if (!distributed) emissionError(context, 'intersection types require C++ multiple-inheritance lowering');
      return emitType(distributed, context, representation);
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
      if (sourceName === 'Parameters' || sourceName === 'ReturnType') {
        if (type.typeArguments.length !== 1 || !type.typeArguments[0]) {
          emissionError(context, `${sourceName}<T> requires exactly one callable type argument`);
        }
        const externalCallResult =
          sourceName === 'ReturnType' ? getCppExternalCallResultTypeCpp(type.typeArguments[0], context) : undefined;
        if (externalCallResult) return externalCallResult;
        const callable = getCppClosedCallableType(type.typeArguments[0], context, new Set());
        if (!callable || callable.typeParameters.length > 0) {
          emissionError(context, `${sourceName}<T> requires a statically resolvable non-generic callable type`);
        }
        if (callable.parameters.some((parameter) => parameter.rest)) {
          emissionError(
            context,
            sourceName === 'Parameters'
              ? 'Parameters<T> with rest parameters requires variadic C++ tuple lowering'
              : 'ReturnType<T> with rest parameters is outside closed callable projection lowering',
          );
        }
        const projected: Readonly<IrType> =
          sourceName === 'ReturnType'
            ? callable.returns
            : {
                elements: callable.parameters.map((parameter) => ({
                  optional: parameter.optional,
                  rest: false,
                  type: parameter.type,
                })),
                kind: 'tuple',
                readonly: false,
              };
        const emitted = emitType(projected, context, representation);
        if (/\bauto\b/u.test(emitted)) {
          emissionError(context, `${sourceName}<T> result requires concrete C++ type evidence`);
        }
        return emitted;
      }
      if (sourceName === 'PropertyKey') {
        if (type.typeArguments.length > 0) emissionError(context, 'PropertyKey does not accept type arguments');
        return emitType(createCppPropertyKeyTypeCpp(), context, representation);
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
      const weakMapTypeArgumentPlan =
        sourceName === 'WeakMap' && getCppRuntimeProfile(context.options) === 'flight-cpp'
          ? assertWeakMapTypeArgumentsCpp(type.typeArguments, context)
          : undefined;
      const mapped = getTypeReferenceTargetName(type, context);
      const arguments_ =
        sourceName &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        isCppRuntimeTypeWithErasedTypeArguments(sourceName)
          ? []
          : type.typeArguments.map((argument, index) =>
              weakMapTypeArgumentPlan?.valueRepresentation === 'erased' && index === 1
                ? 'flight::ErasedValue'
                : emitCppTypeArgumentCpp(argument, context),
            );
      if (weakMapTypeArgumentPlan?.weakKeyPolicyTargetName) {
        arguments_.push(weakMapTypeArgumentPlan.weakKeyPolicyTargetName);
      }
      const usesDefaultArguments =
        arguments_.length === 0 &&
        type.reference.kind === 'binding' &&
        getCppTypeReferenceUsesDefaultArgumentsCpp(type, context);
      return `${mapped}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : usesDefaultArguments ? '<>' : ''}`;
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
        type: emitCppMaterializedObjectPropertyTypeCpp(property.type, context),
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
      const structuralHash = getCppStableIdentifierHash(key);
      const structName = generateAnonymousStructName(type.properties, structuralHash, context);
      context.anonymousStructs.set(key, {
        guard: getCppAnonymousStructGuard(structuralHash, context),
        name: structName,
        properties: emittedProperties,
        typeParameters,
      });
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
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::Ref<void>';
        context.includes.add('memory');
        return 'std::shared_ptr<void>';
      }
      return 'auto';
  }
}

function emitCppNominalIntersectionImplementationTypeCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  properties: readonly Readonly<IrObjectTypeProperty>[],
  context: EmitContext,
): string | undefined {
  const baseType = type.types.find((member) => {
    if (
      member.kind !== 'named' ||
      member.reference.kind !== 'binding' ||
      member.reference.binding.kind !== 'import' ||
      member.reference.path.length > 0
    ) {
      return false;
    }
    const plan = context.referenceRepresentationPlanner.plan(member, context.module);
    return plan.kind === 'represented' && plan.category === 'interface' && plan.valueRepresentation === 'flightReference';
  });
  if (!baseType) return undefined;
  const baseProperties = context.referenceRepresentationPlanner.resolveObjectShape(baseType, context.module);
  if (!baseProperties) return undefined;

  const typeParameters = context.anonymousStructTypeParameters.map(
    (parameter) => context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name),
  );
  const typeParameterKey = context.anonymousStructTypeParameters.map((parameter) => parameter.binding.id).join(',');
  const key = `${typeParameterKey}\0nominalIntersection\0${normalizeCompilerStructuralValueCanonical(type)}`;
  const existing = context.anonymousStructs.get(key);
  if (existing) return `${existing.name}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;

  const inheritedNames = new Set(baseProperties.map((property) => property.name));
  const remaining = properties.filter((property) => !inheritedNames.has(property.name));
  if (remaining.some((property) => property.optional)) context.includes.add('optional');
  const emittedProperties = remaining.map((property) => ({
    name: safeCppName(property.name),
    optional: property.optional,
    type: emitCppMaterializedObjectPropertyTypeCpp(property.type, context),
  }));
  if (emittedProperties.some((property) => /\bauto\b/u.test(property.type))) return undefined;

  const structuralHash = getCppStableIdentifierHash(key);
  const structName = generateAnonymousStructName(properties, structuralHash, context);
  context.anonymousStructs.set(key, {
    base: emitType(baseType, context, 'storage'),
    guard: getCppAnonymousStructGuard(structuralHash, context),
    name: structName,
    properties: emittedProperties,
    typeParameters,
  });
  return `${structName}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
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
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'PropertyKey' &&
    type.typeArguments.length === 0
  ) {
    return getCppClosedTypeMembers(createCppPropertyKeyTypeCpp(), context, resolvingAliases);
  }
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

function createCppPropertyKeyTypeCpp(): Extract<IrType, { kind: 'union' }> {
  return {
    kind: 'union',
    types: [
      { kind: 'primitive', name: 'string' },
      { kind: 'primitive', name: 'number' },
      { kind: 'primitive', name: 'symbol' },
    ],
  };
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
  const functionDeclaration = getCppFunctionDeclarationForBindingCpp(type.reference.binding.id, context);
  let valueType =
    getCppBindingTypeCpp(type.reference.binding.id, context) ??
    (functionDeclaration
      ? {
          kind: 'function' as const,
          parameters: functionDeclaration.parameters.map((parameter) => {
            const value = { name: parameter.binding.name, type: parameter.type };
            if (parameter.rest) return { ...value, optional: false as const, rest: true as const };
            return parameter.optional
              ? { ...value, optional: true as const, rest: false as const }
              : { ...value, optional: false as const, rest: false as const };
          }),
          returns: functionDeclaration.returns,
          typeParameters: functionDeclaration.typeParameters,
        }
      : undefined);
  for (const segment of type.reference.path) {
    if (!valueType) return undefined;
    valueType = getIrObjectPropertyTypeCpp(valueType, segment, context);
  }
  return valueType;
}

function assertWeakMapTypeArgumentsCpp(
  typeArguments: readonly IrType[],
  context: EmitContext,
): Readonly<CppWeakMapTypeArgumentPlan> {
  if (typeArguments.length !== 2 || !typeArguments[0] || !typeArguments[1]) {
    emissionError(context, 'flight-cpp WeakMap requires explicit key and value type arguments');
  }
  const key = getWeakMapKeyRepresentationCpp(typeArguments[0], context, new Set());
  if (!key) {
    emissionError(context, 'flight-cpp WeakMap key requires a proven Flight reference or external weak-key policy');
  }
  if (typeArguments[1].kind === 'unknown' && typeArguments[1].source === 'unknown') {
    if (typeArguments[0].kind !== 'unknown' || typeArguments[0].source !== 'object') {
      emissionError(context, 'flight-cpp erased WeakMap value requires the exact object key type');
    }
    return { valueRepresentation: 'erased' };
  }
  const value = context.referenceRepresentationPlanner.plan(typeArguments[1], context.module);
  if (value.kind !== 'represented') {
    emissionError(context, 'flight-cpp WeakMap value requires a proven C++ representation');
  }
  return {
    valueRepresentation: 'direct',
    ...(key.weakKeyPolicyTargetName ? { weakKeyPolicyTargetName: key.weakKeyPolicyTargetName } : {}),
  };
}

function getIrWeakMapTypeCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<Extract<IrType, { kind: 'named' }>> | undefined {
  if (!type || type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient' && type.reference.name === 'WeakMap') return type;
  if (type.reference.kind !== 'binding' || resolvingAliases.has(type.reference.binding.id)) return undefined;
  const alias = context.referenceRepresentationPlanner.resolveAlias(type, context.module);
  if (!alias) return undefined;
  return getIrWeakMapTypeCpp(alias, context, new Set(resolvingAliases).add(type.reference.binding.id));
}

function getCppErasedWeakMapViewPlan(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): Readonly<CppWeakMapViewPlan> | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  const sourceType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
  if (!isCppErasedWeakMapType(sourceType, context)) return undefined;
  const target = getIrWeakMapTypeCpp(expression.type, context, new Set());
  if (!target || target.typeArguments.length !== 2 || !target.typeArguments[0] || !target.typeArguments[1]) {
    return undefined;
  }
  if (
    target.typeArguments[0].kind === 'unknown' &&
    target.typeArguments[0].source === 'object' &&
    target.typeArguments[1].kind === 'unknown' &&
    target.typeArguments[1].source === 'unknown'
  ) {
    return undefined;
  }
  const key = context.referenceRepresentationPlanner.plan(target.typeArguments[0], context.module);
  if (key.kind !== 'represented' || key.valueRepresentation !== 'flightReference') {
    emissionError(context, 'erased WeakMap typed view requires a proven Flight reference key');
  }
  const value = context.referenceRepresentationPlanner.plan(target.typeArguments[1], context.module);
  if (value.kind !== 'represented') {
    emissionError(context, 'erased WeakMap typed view requires a represented value type');
  }
  return { key: target.typeArguments[0], value: target.typeArguments[1] };
}

function isCppErasedWeakMapType(type: Readonly<IrType> | undefined, context: EmitContext): boolean {
  const resolved = getIrWeakMapTypeCpp(type, context, new Set());
  return (
    resolved?.typeArguments.length === 2 &&
    resolved.typeArguments[0]?.kind === 'unknown' &&
    resolved.typeArguments[0].source === 'object' &&
    resolved.typeArguments[1]?.kind === 'unknown' &&
    resolved.typeArguments[1].source === 'unknown'
  );
}

function emitCppErasedWeakMapViewAcquisition(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  plan: Readonly<CppWeakMapViewPlan>,
  context: EmitContext,
): string {
  context.includes.add('flight/weak_map.hpp');
  return `flight::checked_weak_map_view<${emitType(plan.key, context)}, ${emitType(plan.value, context)}>(${emitExpression(expression.expression, context)})`;
}

function getWeakMapKeyRepresentationCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<{ weakKeyPolicyTargetName?: string | undefined }> | undefined {
  if (type.kind === 'unknown' && type.source === 'object') return {};
  if (type.kind === 'union') {
    const members = type.types.map((member) => getWeakMapKeyRepresentationCpp(member, context, resolvingAliases));
    if (members.some((member) => member === undefined)) return undefined;
    const policies = new Set(members.map((member) => member?.weakKeyPolicyTargetName));
    if (policies.size !== 1) return undefined;
    const weakKeyPolicyTargetName = members[0]?.weakKeyPolicyTargetName;
    return weakKeyPolicyTargetName ? { weakKeyPolicyTargetName } : {};
  }
  if (type.kind === 'named' && type.reference.kind === 'ambient' && type.typeArguments.length === 0) {
    const weakKeyPolicyTargetName = getCompilerExternalBindingWeakKeyPolicyTargetCpp(
      type.reference.name,
      context.options.externalBindings,
    );
    if (weakKeyPolicyTargetName) return { weakKeyPolicyTargetName };
  }
  const plan = context.referenceRepresentationPlanner.plan(type, context.module);
  if (plan.kind === 'represented' && plan.valueRepresentation === 'flightReference') return {};
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
  if (resolvingAliases.has(key)) return undefined;
  const alias = context.referenceRepresentationPlanner.resolveAlias(type, context.module);
  if (!alias) return undefined;
  return getWeakMapKeyRepresentationCpp(alias, context, new Set(resolvingAliases).add(key));
}

function getCppNonNullableType(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  if (identityPreserving) return getCppNonNullableType(identityPreserving, context, resolvingAliases);
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

function getCppCallableObjectIntersectionCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<CppCallableObject> | undefined {
  if (type.kind !== 'intersection' || type.types.length !== 2) return undefined;
  const callables = type.types.filter(
    (member): member is Extract<IrType, { kind: 'function' }> => member.kind === 'function',
  );
  if (callables.length !== 1) return undefined;
  const callable = callables[0]!;
  if (
    callable.typeParameters.length > 0 ||
    callable.parameters.some((parameter) => parameter.optional || parameter.rest)
  ) {
    return undefined;
  }
  const object = type.types.find((member) => member !== callable);
  if (!object) return undefined;
  const properties = context.referenceRepresentationPlanner.resolveObjectShape(object, context.module);
  if (
    !properties ||
    properties.some((property) => property.computedKey) ||
    new Set(properties.map((property) => safeCppName(property.name))).size !== properties.length
  ) {
    return undefined;
  }
  return { callable, properties };
}

function getCppCallableOverloadIntersectionCpp(type: Readonly<IrType>): Readonly<CppCallableOverloadSet> | undefined {
  if (type.kind !== 'intersection' || type.types.length < 2) return undefined;
  const callables = type.types.filter(
    (member): member is Extract<IrType, { kind: 'function' }> => member.kind === 'function',
  );
  if (
    callables.length !== type.types.length ||
    callables.some(
      (callable) =>
        callable.typeParameters.length > 0 ||
        callable.parameters.some((parameter) => parameter.optional || parameter.rest),
    )
  ) {
    return undefined;
  }
  return { callables };
}

function getCppCallableObjectIrTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<CppCallableObject> | undefined {
  const direct = getCppCallableObjectIntersectionCpp(type, context);
  if (direct) return direct;
  if (type.kind === 'union') {
    const present = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    return present.length === 1 ? getCppCallableObjectIrTypeCpp(present[0]!, context, resolvingAliases) : undefined;
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'NonNullable' &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    const present = getCppNonNullableType(type.typeArguments[0], context, resolvingAliases);
    return present ? getCppCallableObjectIrTypeCpp(present, context, resolvingAliases) : undefined;
  }
  if (type.kind === 'indexedAccess') {
    const indexed = getCppIndexedAccessType(type, context);
    return indexed ? getCppCallableObjectIrTypeCpp(indexed, context, resolvingAliases) : undefined;
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
  if (resolvingAliases.has(key)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  return alias ? getCppCallableObjectIrTypeCpp(alias, context, new Set(resolvingAliases).add(key)) : undefined;
}

function getCppCallableObjectExpressionCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<CppCallableObject> | undefined {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  return type ? getCppCallableObjectIrTypeCpp(type, context, new Set()) : undefined;
}

function getCppCallableObjectIndexedProjectionCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<CppCallableObjectIndexedProjection> | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'ambient' ||
    type.reference.name !== 'NonNullable' ||
    type.typeArguments.length !== 1
  ) {
    return undefined;
  }
  const indexedAccess = type.typeArguments[0];
  if (
    indexedAccess?.kind !== 'indexedAccess' ||
    indexedAccess.index.kind !== 'literal' ||
    typeof indexedAccess.index.value !== 'string' ||
    indexedAccess.object.kind !== 'named'
  ) {
    return undefined;
  }
  const indexed = getCppIndexedAccessType(indexedAccess, context);
  if (!indexed || !hasIrTypeAbsentMember(indexed)) return undefined;
  const present = getCppNonNullableType(indexed, context, new Set());
  const representation = present ? getCppCallableObjectIrTypeCpp(present, context, new Set()) : undefined;
  return representation
    ? {
        indexedAccess: { ...indexedAccess, index: { ...indexedAccess.index, value: indexedAccess.index.value } },
        representation,
      }
    : undefined;
}

function emitCppCallableObjectIndexedProjectionTypeCpp(
  projection: Readonly<CppCallableObjectIndexedProjection>,
  context: EmitContext,
): string {
  context.includes.add('utility');
  const objectType = emitType(projection.indexedAccess.object, context, 'storage');
  const propertyName = safeCppName(String(projection.indexedAccess.index.value));
  return `typename decltype(std::declval<${objectType}&>().${propertyName})::value_type`;
}

function isCppCallableObjectValueAliasCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): type is Readonly<Extract<IrType, { kind: 'named' }>> {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
  const alias = resolveCppTypeAliasTarget(type, context);
  return Boolean(alias && getCppCallableObjectIndexedProjectionCpp(alias, context));
}

function isCppExactCallableObjectFieldAssignmentCpp(
  target: Readonly<IrExpression>,
  sourceType: Readonly<IrType>,
  targetType: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (target.kind !== 'property' || !getCppCallableObjectIrTypeCpp(targetType, context, new Set())) return false;
  if (sourceType.kind !== 'named' || sourceType.reference.kind !== 'binding') return false;
  const alias = resolveCppTypeAliasTarget(sourceType, context);
  const projection = alias ? getCppCallableObjectIndexedProjectionCpp(alias, context) : undefined;
  const receiverType = getIrExpressionTypeEvidenceCpp(target.object, context);
  return Boolean(
    projection &&
    receiverType &&
    projection.indexedAccess.index.value === target.name &&
    normalizeCompilerStructuralValueCanonical(projection.indexedAccess.object) ===
      normalizeCompilerStructuralValueCanonical(receiverType),
  );
}

function emitCppCallableObjectStorageTypeCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  representation: Readonly<CppCallableObject>,
  context: EmitContext,
): string {
  const typeParameters = context.anonymousStructTypeParameters.map(
    (parameter) => context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name),
  );
  const typeParameterKey = context.anonymousStructTypeParameters.map((parameter) => parameter.binding.id).join(',');
  const key = `${typeParameterKey}\0callable\0${normalizeCompilerStructuralValueCanonical(type)}`;
  const existing = context.anonymousStructs.get(key);
  if (existing) return `${existing.name}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
  const structuralHash = getCppStableIdentifierHash(key);
  const structName = generateAnonymousStructName(
    [{ name: 'callable' }, ...representation.properties],
    structuralHash,
    context,
  );
  context.anonymousStructs.set(key, {
    ...createCppCallableObjectStructCpp(structName, representation, typeParameters, context),
    guard: getCppAnonymousStructGuard(structuralHash, context),
  });
  return `${structName}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
}

function emitCppCallableOverloadStorageTypeCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  representation: Readonly<CppCallableOverloadSet>,
  context: EmitContext,
): string {
  const typeParameters = context.anonymousStructTypeParameters.map(
    (parameter) => context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name),
  );
  const typeParameterKey = context.anonymousStructTypeParameters.map((parameter) => parameter.binding.id).join(',');
  const key = `${typeParameterKey}\0callable-overloads\0${normalizeCompilerStructuralValueCanonical(type)}`;
  const existing = context.anonymousStructs.get(key);
  if (existing) return `${existing.name}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
  const structuralHash = getCppStableIdentifierHash(key);
  const structName = generateAnonymousStructName([{ name: 'callableOverloads' }], structuralHash, context);
  context.anonymousStructs.set(key, {
    ...createCppCallableOverloadStructCpp(structName, representation, typeParameters, context),
    guard: getCppAnonymousStructGuard(structuralHash, context),
  });
  return `${structName}${typeParameters.length > 0 ? `<${typeParameters.join(', ')}>` : ''}`;
}

function createCppCallableOverloadStructCpp(
  name: string,
  representation: Readonly<CppCallableOverloadSet>,
  typeParameters: readonly string[],
  context: EmitContext,
): AnonymousStruct {
  const callables = representation.callables.map((callable, overloadIndex) => ({
    fieldName: `overload_${String(overloadIndex)}`,
    parameters: callable.parameters.map((parameter, parameterIndex) => ({
      name: `argument_${String(parameterIndex)}`,
      type: emitCppParameterTypeCpp(parameter.type, parameter.rest, context),
    })),
    returns: emitType(callable.returns, context),
  }));
  if (
    callables.some((callable) =>
      [callable.returns, ...callable.parameters.map((parameter) => parameter.type)].some((emitted) =>
        /\bauto\b/u.test(emitted),
      ),
    )
  ) {
    emissionError(context, 'overloaded callable intersection requires concrete C++ type evidence');
  }
  const callSurfaces = callables.map((callable) => callable.parameters.map((parameter) => parameter.type).join('\0'));
  if (new Set(callSurfaces).size !== callSurfaces.length) {
    emissionError(context, 'overloaded callable intersection has incompatible C++ call surfaces');
  }
  return { callables, name, properties: [], referenceEnabled: false, typeParameters };
}

function createCppCallableObjectStructCpp(
  name: string,
  representation: Readonly<CppCallableObject>,
  typeParameters: readonly string[],
  context: EmitContext,
): AnonymousStruct {
  const properties = representation.properties.map((property) => ({
    name: safeCppName(property.name),
    optional: property.optional,
    type: emitType(property.type, context),
  }));
  const parameters = representation.callable.parameters.map((parameter, index) => ({
    name: `argument_${String(index)}`,
    type: emitCppParameterTypeCpp(parameter.type, parameter.rest, context),
  }));
  const returns = emitType(representation.callable.returns, context);
  if (
    [returns, ...parameters.map((parameter) => parameter.type), ...properties.map((property) => property.type)].some(
      (emitted) => /\bauto\b/u.test(emitted),
    )
  ) {
    emissionError(context, 'callable-object representation requires concrete C++ member type evidence');
  }
  return {
    callables: [
      {
        fieldName: getCppCallableObjectFieldNameCpp(representation.properties),
        parameters,
        returns,
      },
    ],
    name,
    properties,
    typeParameters,
  };
}

function getCppCallableObjectFieldNameCpp(properties: readonly Readonly<IrObjectTypeProperty>[]): string {
  const propertyNames = new Set(properties.map((property) => safeCppName(property.name)));
  let name = 'callable';
  while (propertyNames.has(name)) name += '_target';
  return name;
}

function isCppAmbientObjectMemberCallCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  member: string,
): boolean {
  return (
    expression.callee.kind === 'property' &&
    expression.callee.object.kind === 'identifier' &&
    expression.callee.object.reference.kind === 'ambient' &&
    expression.callee.object.reference.name === 'Object' &&
    expression.callee.name === member
  );
}

function emitClosedCallableObjectAssignCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp' || expression.arguments.length !== 2) return undefined;
  const target = expression.arguments[0]!;
  const source = expression.arguments[1]!;
  if (source.kind !== 'object' || source.members.some((member) => member.kind !== 'property')) return undefined;
  const targetType = getIrExpressionTypeEvidenceCpp(target, context);
  if (!targetType || !hasFlightReferenceRepresentationCpp(targetType, context)) return undefined;
  const representation = getCppCallableObjectIrTypeCpp(targetType, context, new Set());
  if (!representation || source.members.length !== representation.properties.length) return undefined;
  const sourceByName = new Map(
    source.members.map((member) => [member.kind === 'property' ? member.name : '', member] as const),
  );
  if (sourceByName.size !== source.members.length) return undefined;
  const assignments = representation.properties.flatMap((property) => {
    const member = sourceByName.get(property.name);
    if (
      member?.kind !== 'property' ||
      !isCppExpressionExactlyRepresentableAsTypeCpp(member.value, property.type, context)
    ) {
      return [];
    }
    return [{ property, value: member.value }];
  });
  if (assignments.length !== representation.properties.length) return undefined;
  const targetName = getGeneratedTargetName('object_assign_target', context);
  const targetExpression = emitExpression(target, context, targetType);
  const writes = assignments.map(
    ({ property, value }) =>
      `${targetName}->${safeCppName(property.name)} = ${emitExpression(value, context, property.type)};`,
  );
  return `([&]() { auto ${targetName} = ${targetExpression}; ${writes.join(' ')} return ${targetName}; }())`;
}

function emitRecordObjectAssignCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  const [target, ...sources] = expression.arguments;
  if (!target || sources.length === 0) return undefined;
  const targetRecord = getCppRecordTypeArgumentsCpp(
    getIrExpressionTypeEvidenceCpp(target, context),
    context,
    new Set(),
  );
  if (!targetRecord) return undefined;
  const sourceRecords = sources.map((source) =>
    getCppRecordTypeArgumentsCpp(getIrExpressionTypeEvidenceCpp(source, context), context, new Set()),
  );
  if (
    sourceRecords.some(
      (record) =>
        !record ||
        normalizeCompilerStructuralValueCanonical(record.key) !==
          normalizeCompilerStructuralValueCanonical(targetRecord.key) ||
        normalizeCompilerStructuralValueCanonical(record.value) !==
          normalizeCompilerStructuralValueCanonical(targetRecord.value),
    )
  ) {
    return undefined;
  }
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
    addCppExternalBindingHeaders('Object', 'value', context);
    return `flight::object_assign(${[target, ...sources].map((argument) => emitExpression(argument, context)).join(', ')})`;
  }
  const targetName = getGeneratedTargetName('object_assign_target', context);
  const writes = sources.map((source) => {
    const sourceName = getGeneratedTargetName('object_assign_source', context);
    const entryName = getGeneratedTargetName('object_assign_entry', context);
    return `const auto& ${sourceName} = ${emitExpression(source, context)}; for (const auto& ${entryName} : ${sourceName}) { ${targetName}[${entryName}.first] = ${entryName}.second; }`;
  });
  return `([&]() -> decltype(auto) { auto&& ${targetName} = ${emitExpression(target, context)}; ${writes.join(' ')} return (${targetName}); }())`;
}

function getCppRecordTypeArgumentsCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<{ key: IrType; value: IrType }> | undefined {
  if (!type || type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') {
    if (type.reference.name === 'Record' && type.typeArguments[0] && type.typeArguments[1]) {
      return { key: type.typeArguments[0], value: type.typeArguments[1] };
    }
    if (type.reference.name === 'Readonly' && type.typeArguments.length === 1) {
      return getCppRecordTypeArgumentsCpp(type.typeArguments[0], context, resolvingAliases);
    }
    return undefined;
  }
  if (resolvingAliases.has(type.reference.binding.id)) return undefined;
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases).add(type.reference.binding.id);
  return getCppRecordTypeArgumentsCpp(alias, context, nextResolvingAliases);
}

function emitCppRecordLiteralKey(name: string, keyType: Readonly<IrType>, context: EmitContext): string {
  const keyUnion = getIrUnionTypeCpp(keyType, context, new Set());
  const keyPlan = keyUnion ? getCppUnionRepresentationPlan(keyUnion, context) : undefined;
  const runtimeType =
    keyPlan &&
    keyPlan.valueSlots.length === 1 &&
    keyPlan.sentinels.null === 'absent' &&
    keyPlan.sentinels.undefined === 'absent'
      ? keyPlan.valueSlots[0]!.runtimeType
      : getIrTypeRuntimeDomainCpp(keyType, context, new Set());
  if (runtimeType?.kind !== 'primitive') {
    emissionError(context, `Record literal key ${name} requires a single string or number runtime domain`);
  }
  if (runtimeType.name === 'string') {
    return emitExpression({ kind: 'literal', value: name }, context, runtimeType);
  }
  if (runtimeType.name !== 'number') {
    emissionError(context, `Record literal key ${name} requires a string or number runtime domain`);
  }
  const numeric = Number(name);
  if (!Number.isFinite(numeric)) {
    emissionError(context, `Record literal key ${name} is not a finite numeric key`);
  }
  return emitExpression({ kind: 'literal', value: numeric }, context, runtimeType);
}

function isCppFunctionExpressionCompatibleWithCallableObjectCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'function' }>>,
  representation: Readonly<CppCallableObject>,
  context: EmitContext,
): boolean {
  return isCppFunctionExpressionCompatibleWithCallableCpp(expression, representation.callable, context);
}

function isCppFunctionExpressionCompatibleWithCallableCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'function' }>>,
  callable: Readonly<Extract<IrType, { kind: 'function' }>>,
  context: EmitContext,
): boolean {
  return (
    expression.typeParameters.length === 0 &&
    expression.parameters.every((parameter) => !parameter.optional && !parameter.rest) &&
    expression.parameters.length === callable.parameters.length &&
    expression.parameters.every(
      (parameter, index) =>
        (parameter.type.kind === 'unknown' && parameter.type.source === 'any') ||
        emitCppParameterTypeCpp(parameter.type, parameter.rest, context) ===
        emitCppParameterTypeCpp(callable.parameters[index]!.type, callable.parameters[index]!.rest, context),
    ) &&
    isCppFunctionExpressionReturnCompatibleCpp(expression, callable.returns, context)
  );
}

function isCppFunctionExpressionReturnCompatibleCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'function' }>>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (emitType(expression.returns, context) === emitType(target, context)) return true;
  if (expression.returns.kind !== 'unknown' || expression.returns.source !== 'any' || !expression.expression) {
    return false;
  }
  const expressionType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
  return Boolean(expressionType && emitType(expressionType, context) === emitType(target, context));
}

function isCppExpressionExactlyRepresentableAsTypeCpp(
  expression: Readonly<IrExpression>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const callable = getCppClosedCallableType(target, context, new Set());
  if (expression.kind === 'function' && callable) {
    return isCppFunctionExpressionCompatibleWithCallableCpp(expression, callable, context);
  }
  const source = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!source) return false;
  if (analyzeIrTypeStructuralAssignability(source, target).status === 'compatible') return true;
  return emitType(source, context) === emitType(target, context);
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
  return `${negated ? '' : '!'}${emitOptionalExpressionCpp(operand, context, operandType)}.has_value()`;
}

function emitCppInferredOptionalNullishComparison(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): string | undefined {
  if (!['==', '===', '!=', '!=='].includes(expression.operator)) return undefined;
  const leftSentinel = getCppNullishLiteralKind(expression.left);
  const rightSentinel = getCppNullishLiteralKind(expression.right);
  if ((leftSentinel ? 1 : 0) + (rightSentinel ? 1 : 0) !== 1) return undefined;
  const sentinel = leftSentinel ?? rightSentinel!;
  const operand = leftSentinel ? expression.right : expression.left;
  const operandType = getIrExpressionTypeEvidenceCpp(operand, context);
  const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  if (!union) return undefined;
  const plan = getCppUnionRepresentationPlan(union, context);
  if (plan.kind !== 'optionalSingle' && plan.kind !== 'optionalVariant') return undefined;
  const strict = expression.operator === '===' || expression.operator === '!==';
  if (strict && !union.types.some((member) => member.kind === sentinel)) return undefined;
  context.includes.add('optional');
  const present = expression.operator === '!=' || expression.operator === '!==';
  return `${present ? '' : '!'}${emitOptionalExpressionCpp(operand, context, operandType)}.has_value()`;
}

function getCppNullishLiteralKind(expression: Readonly<IrExpression>): 'null' | 'undefined' | undefined {
  if (expression.kind === 'literal' && expression.value === null) return 'null';
  if (expression.kind === 'undefinedValue') return 'undefined';
  return expression.kind === 'identifier' &&
    expression.reference.kind === 'ambient' &&
    expression.reference.name === 'undefined'
    ? 'undefined'
    : undefined;
}

function emitUnionMemberAssertionCpp(
  expression: Readonly<IrExpression>,
  assertedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const sourceType =
    expression.kind === 'identifier' && expression.reference.kind === 'binding'
      ? getCppBindingTypeCpp(expression.reference.binding.id, context)
      : getIrExpressionTypeEvidenceCpp(expression, context);
  const union = sourceType ? getIrUnionTypeCpp(sourceType, context, new Set()) : undefined;
  if (!union) return undefined;
  const plan = getCppUnionRepresentationPlan(union, context);
  const assertedTarget = emitType(assertedType, {
    ...context,
    anonymousStructs: new Map(),
    includes: new Set(),
  });
  const alternatives = plan.valueSlots.filter(
    (slot) =>
      slot.targetType === assertedTarget ||
      slot.sourceAlternatives.some((member) => isDeepStrictEqual(member, assertedType)),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'type assertion target must identify exactly one C++ variant alternative');
  }
  const value = emitExpression(expression, context);
  if (plan.kind === 'singleValue') return value;
  context.includes.add(plan.kind === 'optionalSingle' ? 'optional' : 'variant');
  if (plan.kind === 'optionalSingle') return `${value}.value()`;
  if (plan.kind === 'optionalVariant') return `std::get<${alternatives[0]!.targetType}>(${value}.value())`;
  return `std::get<${alternatives[0]!.targetType}>(${value})`;
}

function emitUnionMemberTestCpp(evidence: Readonly<IrUnionMemberTestEvidence>, context: EmitContext): string {
  const bindingType = getCppBindingTypeCpp(evidence.binding.id, context);
  const union = bindingType ? getIrUnionTypeCpp(bindingType, context, new Set()) : undefined;
  if (!union) emissionError(context, 'union member test requires a C++ variant binding');
  const plan = getCppUnionRepresentationPlan(union, context);
  if (plan.kind === 'optionalSingle' || plan.kind === 'optionalVariant') {
    const alternatives = plan.valueSlots.filter((slot) =>
      slot.sourceAlternatives.some(
        (member) =>
          isDeepStrictEqual(member, evidence.member) ||
          slot.targetType ===
            emitType(evidence.member, { ...context, anonymousStructs: new Map(), includes: new Set() }),
      ),
    );
    if (alternatives.length !== 1) {
      emissionError(context, 'union member test must identify exactly one C++ optional value alternative');
    }
    const binding = emitBindingValueCpp(evidence.binding, context);
    const present =
      plan.kind === 'optionalSingle'
        ? `${binding}.has_value()`
        : `(${binding}.has_value() && ${binding}.value().index() == ${String(plan.valueSlots.indexOf(alternatives[0]!))})`;
    return evidence.whenResult ? present : `!(${present})`;
  }
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

function getCppUnionMemberComplementTypeCpp(
  evidence: Readonly<IrUnionMemberTestEvidence>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const bindingType = getCppBindingTypeCpp(evidence.binding.id, context);
  const union = bindingType ? getIrUnionTypeCpp(bindingType, context, new Set()) : undefined;
  if (!union) return undefined;
  const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
  const plan = getCppUnionRepresentationPlan(union, isolatedContext);
  const hasSentinel = plan.sentinels.null !== 'absent' || plan.sentinels.undefined !== 'absent';
  if (hasSentinel && plan.kind !== 'optionalSingle' && plan.kind !== 'optionalVariant') return undefined;
  const evidenceTarget = emitType(evidence.member, isolatedContext);
  const selected = plan.valueSlots.filter(
    (slot) =>
      slot.targetType === evidenceTarget ||
      slot.sourceAlternatives.some((member) => isDeepStrictEqual(member, evidence.member)),
  );
  if (selected.length !== 1) return undefined;
  const remaining: Readonly<IrType>[] = plan.valueSlots
    .filter((slot) => slot !== selected[0])
    .flatMap((slot) => slot.sourceAlternatives);
  return createIrTypeEvidenceUnionCpp([
    ...remaining,
    ...union.types.filter((member) => member.kind === 'null' || member.kind === 'undefined'),
  ]);
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
    expression.object.kind === 'identifier' &&
    expression.object.reference.kind === 'binding' &&
    (expression.object.narrowedMember || context.narrowedBindingTypes.has(expression.object.reference.binding.id))
  ) {
    return undefined;
  }
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const union = objectType ? getIrVariantUnionTypeCpp(objectType, context, new Set()) : undefined;
  if (!union) return undefined;
  const representation = getCppVariantRepresentationForInspection(union, context);
  if (representation.direct) return undefined;
  const propertyTypes = representation.alternatives.map((alternative) =>
    getIrObjectPropertyTypeCpp(alternative.runtimeType, expression.name, context),
  );
  if (propertyTypes.length === 0 || propertyTypes.some((type) => !type)) return undefined;
  const emittedTypes = new Set(
    propertyTypes.map((type) => emitType(getIrTypeRuntimeDomainCpp(type!, context, new Set()) ?? type!, context)),
  );
  if (emittedTypes.size !== 1) return undefined;
  const referenceModes = new Set(
    representation.alternatives.map((alternative) =>
      hasFlightReferenceRepresentationCpp(alternative.runtimeType, context) ? 'reference' : 'value',
    ),
  );
  if (referenceModes.size !== 1) return undefined;
  context.includes.add('variant');
  const operator = referenceModes.has('reference') ? '->' : '.';
  return `std::visit([](const auto& value) { return value${operator}${safeCppName(expression.name)}; }, ${emitExpression(expression.object, context)})`;
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
  const narrowedUnion = narrowedType ? getIrUnionTypeCpp(narrowedType, context, new Set()) : undefined;
  if (narrowedUnion) {
    const narrowedPlan = getCppUnionRepresentationPlan(narrowedUnion, context);
    const mapped = narrowedPlan.valueSlots.map((slot) => ({
      sourceIndex: representation.alternatives.findIndex((alternative) => alternative.targetType === slot.targetType),
      slot,
    }));
    if (
      narrowedPlan.kind === 'multiVariant' &&
      mapped.length < representation.alternatives.length &&
      mapped.every(({ sourceIndex }) => sourceIndex >= 0)
    ) {
      const binding = emitIdentifierReference(expression.reference, context);
      const expressions = mapped.map(({ slot, sourceIndex }) =>
        emitCppUnionValueConstruction(
          `std::get<${String(sourceIndex)}>(${binding})`,
          slot.targetType,
          narrowedUnion,
          narrowedPlan.kind,
          context,
        ),
      );
      let emitted = expressions.at(-1)!;
      for (let index = mapped.length - 2; index >= 0; index -= 1) {
        emitted = `(${binding}.index() == ${String(mapped[index]!.sourceIndex)} ? ${expressions[index]!} : ${emitted})`;
      }
      return emitted;
    }
  }
  const sourceAlternatives = representation.alternatives.flatMap((alternative) =>
    alternative.members.map((member) => ({ alternative, member })),
  );
  const exactMatches = narrowedType
    ? sourceAlternatives.filter(({ member }) => isDeepStrictEqual(member, narrowedType))
    : [];
  const narrowedTargetType =
    narrowedType && exactMatches.length === 0
      ? emitType(narrowedType, { ...context, anonymousStructs: new Map(), includes: new Set() })
      : undefined;
  const targetMatches = narrowedTargetType
    ? sourceAlternatives.filter(({ alternative }) => alternative.targetType === narrowedTargetType)
    : [];
  const namedMatches = expression.narrowedMember
    ? sourceAlternatives.filter(({ member }) => getIrUnionMemberNameCpp(member) === expression.narrowedMember)
    : [];
  const discriminantMatches = narrowedType
    ? sourceAlternatives.filter(({ alternative }) =>
        areCppUnionMemberDiscriminantsEquivalent(alternative.runtimeType, narrowedType, context),
      )
    : [];
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : targetMatches.length > 0
        ? targetMatches
        : namedMatches.length > 0
          ? namedMatches
          : discriminantMatches;
  if (matches.length !== 1) {
    emissionError(
      context,
      `narrowed member ${expression.narrowedMember ?? 'structural switch case'} must identify one C++ variant alternative`,
    );
  }
  if (representation.direct) return emitIdentifierReference(expression.reference, context);
  return `std::get<${String(representation.alternatives.indexOf(matches[0]!.alternative))}>(${emitIdentifierReference(expression.reference, context)})`;
}

function areCppUnionMemberDiscriminantsEquivalent(
  left: Readonly<IrType>,
  right: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const leftProperties = context.referenceRepresentationPlanner.resolveObjectShape(left, context.module);
  const rightProperties = context.referenceRepresentationPlanner.resolveObjectShape(right, context.module);
  if (!leftProperties || !rightProperties) return false;
  return leftProperties.some((property) => {
    if (property.type.kind !== 'literal') return false;
    const candidate = rightProperties.find((rightProperty) => rightProperty.name === property.name);
    return candidate?.type.kind === 'literal' && candidate.type.value === property.type.value;
  });
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
      if (hasEquivalentCppOptionalUnionRepresentation(plan, leftPlan)) {
        const unionType = emitUnionTypeCpp(union, context);
        const left = emitExpression(expression.left, context, leftType);
        const right = emitExpression(expression.right, context, expectedType);
        return `([&]() -> ${unionType} { auto nullish_coalesce_left = ${left}; if (nullish_coalesce_left.has_value()) return nullish_coalesce_left; return ${right}; }())`;
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
  const externalCallResult = getCppExternalCallResultTargetCpp(expression, context);
  if (externalCallResult) {
    const targetSlots = plan.valueSlots.filter((slot) => slot.targetType === externalCallResult);
    const unresolvedTargetSlot =
      targetSlots.length === 0 &&
      plan.valueSlots.length === 1 &&
      plan.valueSlots[0]!.sourceAlternatives.every((alternative) => alternative.kind === 'unknown');
    if (targetSlots.length !== 1 && !unresolvedTargetSlot) {
      emissionError(
        context,
        `external call result type ${externalCallResult} is not one represented contextual runtime domain`,
      );
    }
    return emitCppUnionValueConstruction(
      emitExpression(expression, context, undefined, false),
      externalCallResult,
      union,
      plan.kind,
      context,
    );
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
  if (!semantics) return undefined;
  const valueType =
    semantics.valueType.kind === 'unknown'
      ? getIrOptionalChainValueTypeEvidenceCpp(expression, context)
      : semantics.valueType;
  if (!valueType) return undefined;
  const valueUnion = getIrUnionTypeCpp(valueType, context, new Set());
  const present = (valueUnion?.types ?? [valueType]).filter(
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
    case 'await':
      return getIrExpressionTypeEvidenceCpp(expression, context);
    case 'binary':
      return (
        getIrOperatorValueDomainTypeCpp(expression.semantics.result) ??
        getIrNullishCoalesceTypeEvidenceCpp(expression, context)
      );
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
      return getIrNewExpressionTypeEvidenceCpp(expression, context);
    case 'object':
      return getCppContextualObjectUnionRuntimeTypeCpp(expression, valueSlots, context) ?? expression.type;
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

function getCppContextualObjectUnionRuntimeTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  valueSlots: readonly Readonly<{
    representationKey?: string;
    runtimeType: IrType;
    sourceAlternatives?: readonly IrType[];
  }>[],
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.members.some((member) => member.kind !== 'property')) return undefined;
  const members = expression.members as readonly Readonly<
    Extract<(typeof expression.members)[number], { kind: 'property' }>
  >[];
  const byName = new Map(members.map((member) => [member.name, member] as const));
  if (byName.size !== members.length) return undefined;
  const matches = valueSlots.filter((slot) => {
    const sourceAlternatives = (slot.sourceAlternatives ?? [slot.runtimeType]).flatMap((alternative) =>
      getCppExpandedUnionSourceAlternativesCpp(alternative, context, new Set()),
    );
    const alternatives = slot.representationKey
      ? sourceAlternatives.filter((alternative) => {
          const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
          const candidatePlan = getCppUnionRepresentationPlan(
            { kind: 'union', types: [alternative, { kind: 'null' }] },
            isolatedContext,
          );
          return candidatePlan.valueSlots[0]?.representationKey === slot.representationKey;
        })
      : sourceAlternatives;
    return alternatives.some((alternative) => {
      const properties = context.referenceRepresentationPlanner.resolveObjectShape(alternative, context.module);
      if (!properties) return false;
      const targetByName = new Map(properties.map((property) => [property.name, property] as const));
      if (members.some((member) => !targetByName.has(member.name))) return false;
      if (properties.some((property) => !property.optional && !byName.has(property.name))) return false;
      const discriminants = members.map((member) =>
        getCppLiteralDiscriminantMatchCpp(member.value, targetByName.get(member.name)!.type, context),
      );
      if (discriminants.some((match) => match === false)) return false;
      if (discriminants.some((match) => match === true)) return true;
      return members.every((member) =>
        isCppExpressionRepresentableAsRuntimeTypeCpp(member.value, targetByName.get(member.name)!.type, context),
      );
    });
  });
  return matches.length === 1 ? matches[0]!.runtimeType : undefined;
}

function getCppExpandedUnionSourceAlternativesCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): readonly Readonly<IrType>[] {
  if (type.kind === 'union') {
    return type.types.flatMap((member) => getCppExpandedUnionSourceAlternativesCpp(member, context, resolvingAliases));
  }
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.typeArguments.length > 0 ||
    resolvingAliases.has(type.reference.binding.id)
  ) {
    return [type];
  }
  const alias = resolveCppTypeAliasTarget(type, context);
  if (!alias) return [type];
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(type.reference.binding.id);
  return getCppExpandedUnionSourceAlternativesCpp(alias, context, nextResolvingAliases);
}

function getCppLiteralDiscriminantMatchCpp(
  expression: Readonly<IrExpression>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean | undefined {
  if (expression.kind !== 'literal') return undefined;
  if (target.kind === 'literal') return target.value === expression.value;
  const union = getIrUnionTypeCpp(target, context, new Set());
  if (!union || !union.types.every((member) => member.kind === 'literal')) return undefined;
  return union.types.some((member) => member.kind === 'literal' && member.value === expression.value);
}

function isCppExpressionRepresentableAsRuntimeTypeCpp(
  expression: Readonly<IrExpression>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (expression.kind === 'new' && expression.arguments.length === 0 && expression.typeArguments.length === 0) {
    const ambientConstructorName = getIrAmbientConstructorNameCpp(expression.callee);
    const contextualType = getCppNonNullableType(target, context, new Set());
    if (
      ambientConstructorName !== undefined &&
      contextualType?.kind === 'named' &&
      contextualType.reference.kind === 'ambient' &&
      contextualType.reference.name === ambientConstructorName &&
      contextualType.typeArguments.length > 0
    ) {
      return true;
    }
  }
  if (expression.kind !== 'literal') {
    if (isCppExpressionExactlyRepresentableAsTypeCpp(expression, target, context)) return true;
    const source = getIrExpressionTypeEvidenceCpp(expression, context);
    if (!source) return false;
    const sourceUnion = getIrUnionTypeCpp(source, context, new Set());
    const targetUnion = getIrUnionTypeCpp(target, context, new Set());
    if (!sourceUnion || !targetUnion) return false;
    const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
    const sourcePlan = getCppUnionRepresentationPlan(sourceUnion, isolatedContext);
    const targetPlan = getCppUnionRepresentationPlan(targetUnion, isolatedContext);
    return (
      sourcePlan.valueSlots.length === 1 &&
      targetPlan.valueSlots.length === 1 &&
      sourcePlan.valueSlots[0]!.representationKey === targetPlan.valueSlots[0]!.representationKey
    );
  }
  if (target.kind === 'literal') return target.value === expression.value;
  const union = getIrUnionTypeCpp(target, context, new Set());
  if (union?.types.every((member) => member.kind === 'literal')) {
    return union.types.some((member) => member.kind === 'literal' && member.value === expression.value);
  }
  const runtimeMembers = (union?.types ?? [target]).map((member) =>
    getIrTypeRuntimeDomainCpp(member, context, new Set()),
  );
  const firstRuntime = runtimeMembers[0];
  const runtime =
    firstRuntime &&
    runtimeMembers.every(
      (member) =>
        member &&
        normalizeCompilerStructuralValueCanonical(member) === normalizeCompilerStructuralValueCanonical(firstRuntime),
    )
      ? firstRuntime
      : undefined;
  if (expression.value === null) return runtime?.kind === 'null';
  if (runtime?.kind !== 'primitive') return false;
  return runtime.name === (typeof expression.value === 'number' ? 'number' : typeof expression.value);
}

function emitCppInferredPropertyUnionMemberTestCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): string | undefined {
  if (
    expression.operator !== 'in' ||
    expression.left.kind !== 'literal' ||
    typeof expression.left.value !== 'string' ||
    expression.right.kind !== 'identifier' ||
    expression.right.reference.kind !== 'binding'
  ) {
    return undefined;
  }
  const propertyName = expression.left.value;
  const type = getIrExpressionTypeEvidenceCpp(expression.right, context);
  const union = type ? getIrVariantUnionTypeCpp(type, context, new Set()) : undefined;
  if (!union) return undefined;
  const representation = getCppVariantRepresentation(union, context);
  if (representation.direct) return undefined;
  const matches = representation.alternatives.flatMap((alternative, index) => {
    const properties = context.referenceRepresentationPlanner.resolveObjectShape(
      alternative.runtimeType,
      context.module,
    );
    return properties?.some((property) => property.name === propertyName) ? [index] : [];
  });
  if (matches.length === 0 || matches.length === representation.alternatives.length) return undefined;
  const value = emitExpression(expression.right, context);
  return matches.map((index) => `${value}.index() == ${String(index)}`).join(' || ');
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
    if (erasedValue) return getIrTypeRuntimeDomainCpp(erasedValue, context, resolvingAliases);
    const distributed = context.referenceRepresentationPlanner.resolveClosedIntersectionDistribution(
      type,
      context.module,
    );
    return distributed ? getIrTypeRuntimeDomainCpp(distributed, context, resolvingAliases) : type;
  }
  if (type.kind === 'keyof') {
    const keyType = getCppKeyofType(type.type, context);
    return keyType ? getIrTypeRuntimeDomainCpp(keyType, context, resolvingAliases) : undefined;
  }
  if (type.kind === 'typeOf') {
    const valueType = getCppTypeOfValueType(type, context);
    return valueType ? getIrTypeRuntimeDomainCpp(valueType, context, resolvingAliases) : undefined;
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'PropertyKey' &&
    type.typeArguments.length === 0
  ) {
    return createCppPropertyKeyTypeCpp();
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

function getIrNullishCoalesceTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.operator !== '??') return undefined;
  const left = getIrExpressionTypeEvidenceCpp(expression.left, context);
  const right =
    getIrExpressionTypeEvidenceCpp(expression.right, context) ??
    getIrExpressionTypeForUnionConstructionCpp(expression.right, [], context);
  if (!left || !right || left.kind === 'unknown' || right.kind === 'unknown') return undefined;
  const leftUnion = getIrUnionTypeCpp(left, context, new Set());
  const rightUnion = getIrUnionTypeCpp(right, context, new Set());
  return createIrTypeEvidenceUnionCpp([
    ...(leftUnion?.types ?? [left]).filter((member) => member.kind !== 'null' && member.kind !== 'undefined'),
    ...(rightUnion?.types ?? [right]),
  ]);
}

function createIrTypeEvidenceUnionCpp(types: readonly Readonly<IrType>[]): Readonly<IrType> | undefined {
  const unique = [
    ...new Map(types.map((type) => [normalizeCompilerStructuralValueCanonical(type), type] as const)).values(),
  ];
  if (!unique[0]) return undefined;
  return unique.length === 1 ? unique[0] : { kind: 'union', types: [unique[0], unique[1]!, ...unique.slice(2)] };
}

function getIrCallReturnTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.callee.kind === 'function') return expression.callee.returns;
  const objectProjection = getCppObjectProjectionCallResultTypeCpp(expression, context);
  if (objectProjection) return objectProjection;
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
  const runtimeResult = getCppRuntimeMemberCallResultTypeEvidence(expression, context);
  if (runtimeResult) return runtimeResult;
  const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
  return calleeType ? getCppCallableReturnType(calleeType, context, new Set()) : undefined;
}

function isIrNumberTypeEvidenceCpp(type: Readonly<IrType> | undefined): boolean {
  return type?.kind === 'primitive' && type.name === 'number';
}

// C++ cannot infer a function template parameter which appears only in the return type. TypeScript
// can accept such a call from its contextual destination, however, and call-result semantics retain
// the checker's instantiated type. Recover only a complete, structurally aligned substitution: an
// incomplete result is left to ordinary C++ argument deduction instead of manufacturing `auto` or
// choosing a constraint as a runtime type.
function getCppContextualCallTypeArgumentsCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
): readonly Readonly<IrType>[] | undefined {
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') return undefined;
  const declaration = getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context);
  if (!declaration || declaration.typeParameters.length === 0) return undefined;
  const parameterIds = new Set(declaration.typeParameters.map((parameter) => parameter.binding.id));
  let argumentSubstitutions = new Map<string, Readonly<IrType>>();
  expression.arguments.forEach((argument, index) => {
    const parameter = declaration.parameters[index];
    const argumentType = getIrExpressionTypeEvidenceCpp(argument, context);
    if (!parameter?.type || !argumentType || argumentType.kind === 'unknown') return;
    const candidateSubstitutions = new Map(argumentSubstitutions);
    if (
      collectCppResultTypeSubstitutionsCpp(parameter.type, argumentType, parameterIds, candidateSubstitutions, context)
    ) {
      argumentSubstitutions = candidateSubstitutions;
    }
  });
  const candidates = [expectedType, expression.semantics.resultType].flatMap((candidate) =>
    candidate && candidate.kind !== 'unknown' ? [candidate] : [],
  );
  for (const candidate of candidates) {
    const substitutions = new Map(argumentSubstitutions);
    if (!collectCppResultTypeSubstitutionsCpp(declaration.returns, candidate, parameterIds, substitutions, context)) {
      continue;
    }
    const arguments_ = declaration.typeParameters.map(
      (parameter) => substitutions.get(parameter.binding.id) ?? parameter.default,
    );
    if (arguments_.every((argument): argument is Readonly<IrType> => argument !== undefined)) return arguments_;
  }
  const arguments_ = declaration.typeParameters.map(
    (parameter) => argumentSubstitutions.get(parameter.binding.id) ?? parameter.default,
  );
  return arguments_.every((argument): argument is Readonly<IrType> => argument !== undefined) ? arguments_ : undefined;
}

function collectCppResultTypeSubstitutionsCpp(
  pattern: Readonly<IrType>,
  candidate: Readonly<IrType>,
  parameterIds: ReadonlySet<string>,
  substitutions: Map<string, Readonly<IrType>>,
  context: EmitContext,
): boolean {
  if (
    pattern.kind === 'named' &&
    pattern.reference.kind === 'binding' &&
    pattern.reference.binding.kind === 'typeParameter' &&
    pattern.reference.path.length === 0 &&
    pattern.typeArguments.length === 0 &&
    parameterIds.has(pattern.reference.binding.id)
  ) {
    const previous = substitutions.get(pattern.reference.binding.id);
    if (!previous) {
      substitutions.set(pattern.reference.binding.id, candidate);
      return true;
    }
    return normalizeCompilerStructuralValueCanonical(previous) === normalizeCompilerStructuralValueCanonical(candidate);
  }
  if (pattern.kind === 'named' && candidate.kind === 'named') {
    if (
      pattern.typeArguments.length !== candidate.typeArguments.length ||
      getTypeReferenceTargetName(pattern, context) !== getTypeReferenceTargetName(candidate, context)
    ) {
      return false;
    }
    return pattern.typeArguments.every((argument, index) =>
      collectCppResultTypeSubstitutionsCpp(
        argument,
        candidate.typeArguments[index]!,
        parameterIds,
        substitutions,
        context,
      ),
    );
  }
  if (pattern.kind === 'array' && candidate.kind === 'array') {
    return collectCppResultTypeSubstitutionsCpp(
      pattern.element,
      candidate.element,
      parameterIds,
      substitutions,
      context,
    );
  }
  if (pattern.kind === 'tuple' && candidate.kind === 'tuple' && pattern.elements.length === candidate.elements.length) {
    return pattern.elements.every(
      (element, index) =>
        element.optional === candidate.elements[index]!.optional &&
        element.rest === candidate.elements[index]!.rest &&
        collectCppResultTypeSubstitutionsCpp(
          element.type,
          candidate.elements[index]!.type,
          parameterIds,
          substitutions,
          context,
        ),
    );
  }
  if (
    pattern.kind === 'function' &&
    candidate.kind === 'function' &&
    pattern.typeParameters.length === 0 &&
    candidate.typeParameters.length === 0 &&
    pattern.parameters.length === candidate.parameters.length
  ) {
    return (
      pattern.parameters.every(
        (parameter, index) =>
          parameter.optional === candidate.parameters[index]!.optional &&
          parameter.rest === candidate.parameters[index]!.rest &&
          collectCppResultTypeSubstitutionsCpp(
            parameter.type,
            candidate.parameters[index]!.type,
            parameterIds,
            substitutions,
            context,
          ),
      ) &&
      collectCppResultTypeSubstitutionsCpp(pattern.returns, candidate.returns, parameterIds, substitutions, context)
    );
  }
  return normalizeCompilerStructuralValueCanonical(pattern) === normalizeCompilerStructuralValueCanonical(candidate);
}

// The package-graph source program deliberately does not make a host TypeScript library part of
// module identity. Consequently the checker may report `any` for a standard runtime member even
// though semantic lowering retained its resolved receiver. Preserve the small, versioned
// flight-cpp runtime contract here instead of treating an `any` result as evidence or guessing for
// lookalike user methods.
function getCppRuntimeMemberCallResultTypeEvidence(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.optional || expression.semantics.optionalChain || expression.callee.kind !== 'property') {
    return undefined;
  }
  const callee = expression.callee;
  if (callee.object.kind === 'identifier' && callee.object.reference.kind === 'ambient') {
    if (callee.object.reference.name === 'Math' && cppNumericMathCallNames.has(callee.name)) {
      return { kind: 'primitive', name: 'number' };
    }
  }
  const receiver = callee.member?.receiver;
  if (receiver === 'string') {
    if (callee.name === 'match') {
      return createIrTypeEvidenceUnionCpp([
        {
          kind: 'named',
          reference: { kind: 'ambient', name: 'RegExpExecArray' },
          typeArguments: [],
        },
        { kind: 'null' },
      ]);
    }
    if (cppStringReturningCallNames.has(callee.name)) return { kind: 'primitive', name: 'string' };
    if (cppNumberReturningStringCallNames.has(callee.name)) return { kind: 'primitive', name: 'number' };
    if (cppBooleanReturningStringCallNames.has(callee.name)) return { kind: 'primitive', name: 'boolean' };
    if (callee.name === 'split')
      return { element: { kind: 'primitive', name: 'string' }, kind: 'array', readonly: false };
    return undefined;
  }
  if (receiver === 'array') {
    const array = getIrExpressionTypeEvidenceCpp(callee.object, context);
    const element = array ? getIrIterableElementTypeCpp(array, context, new Set()) : undefined;
    if (element && (callee.name === 'pop' || callee.name === 'shift' || callee.name === 'find')) {
      return createIrTypeEvidenceUnionCpp([element, { kind: 'undefined' }]);
    }
    if (array && cppArrayReturningCallNames.has(callee.name)) return array;
    if (cppBooleanReturningArrayCallNames.has(callee.name)) return { kind: 'primitive', name: 'boolean' };
    if (cppNumberReturningArrayCallNames.has(callee.name)) return { kind: 'primitive', name: 'number' };
    if (callee.name === 'join') return { kind: 'primitive', name: 'string' };
    if (callee.name === 'forEach') return { kind: 'primitive', name: 'void' };
    return undefined;
  }
  if (receiver === 'typedArray' && cppTypedArrayReturningCallNames.has(callee.name)) {
    return getIrExpressionTypeEvidenceCpp(callee.object, context);
  }
  if (receiver === 'regexp') {
    if (callee.name === 'exec') {
      return createIrTypeEvidenceUnionCpp([
        {
          kind: 'named',
          reference: { kind: 'ambient', name: 'RegExpExecArray' },
          typeArguments: [],
        },
        { kind: 'null' },
      ]);
    }
    if (callee.name === 'test') return { kind: 'primitive', name: 'boolean' };
  }
  return undefined;
}

const cppNumericMathCallNames = new Set([
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'random',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
]);
const cppStringReturningCallNames = new Set([
  'charAt',
  'concat',
  'padStart',
  'repeat',
  'replace',
  'slice',
  'substring',
  'toLowerCase',
  'toUpperCase',
  'trim',
]);
const cppNumberReturningStringCallNames = new Set(['charCodeAt', 'indexOf', 'lastIndexOf']);
const cppBooleanReturningStringCallNames = new Set(['endsWith', 'includes', 'startsWith']);
const cppArrayReturningCallNames = new Set(['concat', 'fill', 'filter', 'reverse', 'slice', 'sort']);
const cppBooleanReturningArrayCallNames = new Set(['every', 'includes', 'some']);
const cppNumberReturningArrayCallNames = new Set(['findIndex', 'indexOf', 'lastIndexOf', 'push', 'unshift']);
const cppTypedArrayReturningCallNames = new Set(['fill', 'slice', 'subarray']);

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

function emitCppTypedArrayRangeFillCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  if (
    getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
    expression.callee.kind !== 'property' ||
    expression.callee.name !== 'fill' ||
    expression.arguments.length < 2 ||
    expression.arguments.length > 3
  ) {
    return undefined;
  }
  const receiverType = getIrExpressionTypeEvidenceCpp(expression.callee.object, context);
  const receiverPlan = receiverType
    ? context.referenceRepresentationPlanner.plan(
        getCppNonNullableType(receiverType, context, new Set()) ?? receiverType,
        context.module,
      )
    : undefined;
  if (
    expression.callee.member?.receiver !== 'typedArray' &&
    (receiverPlan?.kind !== 'represented' || receiverPlan.category !== 'typedArray')
  ) {
    return undefined;
  }
  const receiverName = getGeneratedTargetName('typedArrayFillReceiver', context);
  const valueName = getGeneratedTargetName('typedArrayFillValue', context);
  const beginName = getGeneratedTargetName('typedArrayFillBegin', context);
  const endName = expression.arguments[2] ? getGeneratedTargetName('typedArrayFillEnd', context) : undefined;
  const receiver = emitExpression(expression.callee.object, context);
  const value = emitExpression(
    expression.arguments[0]!,
    context,
    getIrCallArgumentExpectedTypeCpp(expression, 0, context),
  );
  const begin = emitExpression(
    expression.arguments[1]!,
    context,
    getIrCallArgumentExpectedTypeCpp(expression, 1, context),
  );
  const end = expression.arguments[2]
    ? emitExpression(expression.arguments[2], context, getIrCallArgumentExpectedTypeCpp(expression, 2, context))
    : undefined;
  return `([&]() { auto&& ${receiverName} = ${receiver}; const auto ${valueName} = ${value}; const auto ${beginName} = ${begin};${endName && end ? ` const auto ${endName} = ${end};` : ''} ${receiverName}.subarray(${beginName}${endName ? `, ${endName}` : ''}).fill(${valueName}); return ${receiverName}; }())`;
}

function getCppCallableReturnType(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  return getCppClosedCallableType(type, context, resolvingAliases)?.returns;
}

function getCppClosedCallableType(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<Extract<IrType, { kind: 'function' }>> | undefined {
  if (type.kind === 'function') return type;
  if (type.kind === 'union') {
    const callable = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    return callable.length === 1 ? getCppClosedCallableType(callable[0]!, context, resolvingAliases) : undefined;
  }
  if (type.kind === 'typeOf') {
    const valueType = getCppTypeOfValueType(type, context);
    return valueType ? getCppClosedCallableType(valueType, context, resolvingAliases) : undefined;
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return undefined;
  const target = resolveCppTypeAliasTarget(type, context);
  if (!target) return undefined;
  const nextResolvingAliases = new Set(resolvingAliases);
  nextResolvingAliases.add(bindingId);
  return getCppClosedCallableType(target, context, nextResolvingAliases);
}

function getCppExternalCallResultTypeCpp(type: Readonly<IrType>, context: EmitContext): string | undefined {
  if (type.kind !== 'typeOf' || type.reference.kind !== 'ambient') return undefined;
  const result = getCompilerExternalBindingCallResultTypeCpp(type.reference.name, context.options.externalBindings);
  if (result) addCppExternalBindingHeaders(type.reference.name, 'value', context);
  return result;
}

function getCppExternalCallResultTargetCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  if (
    expression.kind !== 'call' ||
    expression.optional ||
    expression.semantics.optionalChain ||
    expression.callee.kind !== 'identifier' ||
    expression.callee.reference.kind !== 'ambient'
  ) {
    return undefined;
  }
  return getCompilerExternalBindingCallResultTypeCpp(
    expression.callee.reference.name,
    context.options.externalBindings,
  );
}

function collectCppExternalBindingStorageTargetTypesCpp(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
  options: Readonly<CppCompilerBackendOptions>,
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>();
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (
        expression.kind !== 'assignment' ||
        expression.operator !== '=' ||
        expression.left.kind !== 'identifier' ||
        expression.left.reference.kind !== 'binding' ||
        expression.right.kind !== 'call' ||
        expression.right.optional ||
        expression.right.semantics.optionalChain ||
        expression.right.callee.kind !== 'identifier' ||
        expression.right.callee.reference.kind !== 'ambient'
      ) {
        return;
      }
      const bindingId = expression.left.reference.binding.id;
      const declaredType = bindingTypes.get(bindingId);
      if (!declaredType || !isCppUnresolvedExternalStorageTypeCpp(declaredType)) return;
      const targetType = getCompilerExternalBindingCallResultTypeCpp(
        expression.right.callee.reference.name,
        options.externalBindings,
      );
      if (!targetType) return;
      const targets = candidates.get(bindingId) ?? new Set<string>();
      targets.add(targetType);
      candidates.set(bindingId, targets);
    },
  });
  return new Map(
    [...candidates].flatMap(([bindingId, targets]) =>
      targets.size === 1 ? ([[bindingId, [...targets][0]!] as const] as const) : [],
    ),
  );
}

function collectCppContextualBindingStorageTargetTypesCpp(
  module: Readonly<IrModule>,
  context: EmitContext,
): ReadonlyMap<string, Readonly<IrType>> {
  const candidates = new Map<string, Map<string, Readonly<IrType>>>();
  const eligible = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && !variable.mutable && variable.initializer) {
        const runtimeMemberType = getCppRuntimeMemberStorageTypeCpp(variable.initializer, context);
        if (runtimeMemberType) {
          candidates.set(
            variable.binding.id,
            new Map([[normalizeCompilerStructuralValueCanonical(runtimeMemberType), runtimeMemberType]]),
          );
        }
      }
      if (
        'binding' in variable &&
        !variable.mutable &&
        variable.initializer?.kind === 'object' &&
        variable.type &&
        hasFlightReferenceRepresentationCpp(variable.type, context)
      ) {
        eligible.add(variable.binding.id);
      }
      if (
        'binding' in variable &&
        !variable.mutable &&
        variable.initializer?.kind === 'new' &&
        getIrAmbientConstructorNameCpp(variable.initializer.callee) === 'Map'
      ) {
        eligible.add(variable.binding.id);
      }
    },
  });
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'function') continue;
    const returnType = getCppNonNullableType(declaration.returns, context, new Set()) ?? declaration.returns;
    for (const statement of declaration.body) {
      if (statement.kind !== 'return' || statement.expression?.kind !== 'object') continue;
      collectCppObjectContextualStorageTargetsCpp(
        statement.expression,
        returnType,
        eligible,
        candidates,
        context,
      );
    }
  }
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (expression.kind === 'object') {
        collectCppObjectContextualStorageTargetsCpp(
          expression,
          expression.type,
          eligible,
          candidates,
          context,
        );
      }
      if (expression.kind !== 'call') return;
      expression.arguments.forEach((argument, index) => {
        if (
          argument.kind !== 'identifier' ||
          argument.reference.kind !== 'binding' ||
          !eligible.has(argument.reference.binding.id)
        ) {
          return;
        }
        const bindingId = argument.reference.binding.id;
        const sourceType = context.bindingTypes.get(bindingId);
        const expectedType = getIrCallArgumentExpectedTypeCpp(expression, index, context);
        const targetType = expectedType ? getCppNonNullableType(expectedType, context, new Set()) : undefined;
        if (
          !sourceType ||
          !targetType ||
          !hasFlightReferenceRepresentationCpp(targetType, context) ||
          hasFlightStructuralRowRepresentationCpp(targetType, context)
        ) {
          return;
        }
        const sourceShape = context.referenceRepresentationPlanner.resolveObjectShape(sourceType, context.module);
        const targetShape = context.referenceRepresentationPlanner.resolveObjectShape(targetType, context.module);
        if (
          !sourceShape ||
          !targetShape ||
          !areCppObjectShapesRepresentationEquivalent(sourceShape, targetShape, context)
        ) {
          return;
        }
        const targets = candidates.get(bindingId) ?? new Map<string, Readonly<IrType>>();
        targets.set(normalizeCompilerStructuralValueCanonical(targetType), targetType);
        candidates.set(bindingId, targets);
      });
    },
  });
  return new Map(
    [...candidates].flatMap(([bindingId, targets]) =>
      targets.size === 1 ? ([[bindingId, [...targets.values()][0]!] as const] as const) : [],
    ),
  );
}

function collectCppObjectContextualStorageTargetsCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  contextualType: Readonly<IrType>,
  eligible: ReadonlySet<string>,
  candidates: Map<string, Map<string, Readonly<IrType>>>,
  context: EmitContext,
): void {
  for (const member of expression.members) {
    if (
      member.kind !== 'property' ||
      member.value.kind !== 'identifier' ||
      member.value.reference.kind !== 'binding' ||
      !eligible.has(member.value.reference.binding.id)
    ) {
      continue;
    }
    const bindingId = member.value.reference.binding.id;
    const sourceType = context.bindingTypes.get(bindingId);
    const targetType = getIrObjectPropertyTypeCpp(contextualType, member.name, context);
    if (!sourceType || !targetType || !isCppReadonlyCollectionProjectionCpp(sourceType, targetType, context)) {
      continue;
    }
    const targets = candidates.get(bindingId) ?? new Map<string, Readonly<IrType>>();
    targets.set(normalizeCompilerStructuralValueCanonical(targetType), targetType);
    candidates.set(bindingId, targets);
  }
}

function isCppReadonlyCollectionProjectionCpp(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const sourceCollection = getIrAmbientCollectionTypeCpp(source, context, new Set());
  const targetCollection = getIrAmbientCollectionTypeCpp(target, context, new Set());
  if (!sourceCollection || !targetCollection) return false;
  return (
    (sourceCollection.reference.name === 'Map' && targetCollection.reference.name === 'ReadonlyMap') ||
    (sourceCollection.reference.name === 'Set' && targetCollection.reference.name === 'ReadonlySet')
  );
}

function getCppRuntimeMemberStorageTypeCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (
    getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
    expression.kind !== 'property' ||
    expression.optional ||
    expression.member?.receiver !== 'typedArray' ||
    expression.member.name !== 'buffer'
  ) {
    return undefined;
  }
  return {
    kind: 'named',
    reference: { kind: 'ambient', name: 'ArrayBufferLike' },
    typeArguments: [],
  };
}

function isCppUnresolvedExternalStorageTypeCpp(type: Readonly<IrType>): boolean {
  if (type.kind === 'unknown') return true;
  if (type.kind !== 'union') return false;
  const present = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  return present.length === 1 && present[0]!.kind === 'unknown';
}

function emitCppExternalBindingStorageTypeCpp(
  type: Readonly<IrType> | undefined,
  targetType: string,
  context: EmitContext,
): string {
  if (!type || type.kind === 'unknown') return targetType;
  if (type.kind !== 'union') {
    emissionError(context, `external binding storage ${targetType} requires unresolved source type evidence`);
  }
  const present = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  const absent = type.types.filter((member) => member.kind === 'null' || member.kind === 'undefined');
  if (present.length !== 1 || present[0]!.kind !== 'unknown' || absent.length !== 1) {
    emissionError(context, `external binding storage ${targetType} requires one unresolved optional value domain`);
  }
  context.includes.add('optional');
  return `std::optional<${targetType}>`;
}

function getIrCallArgumentExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const collectionType = getCppCollectionCallArgumentExpectedTypeCpp(expression, index, context);
  if (collectionType) return collectionType;
  if (expression.callee.kind === 'property' && expression.callee.member) {
    const argument = expression.arguments[index];
    if (argument?.kind === 'function') {
      const callable = getIrExpressionTypeEvidenceCpp(argument, context);
      if (callable) return callable;
    }
    const provided = getIrInvocationProvidedArgumentTypeCpp(expression, index);
    if (provided) return provided;
  }
  const semanticType = getIrInvocationArgumentExpectedTypeCpp(expression, index);
  if (semanticType) return semanticType;
  if (expression.callee.kind === 'function') return expression.callee.parameters[index]?.type;
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') return undefined;
  return getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context)?.parameters[index]
    ?.type;
}

function getCppCollectionCallArgumentExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.callee.kind !== 'property') return undefined;
  const { member, name, object } = expression.callee;
  const objectType = getIrExpressionTypeEvidenceCpp(object, context);
  if (index === 0 && name === 'sort' && getIrArrayTypeCpp(objectType, context, new Set())) {
    const expected = getIrInvocationArgumentExpectedTypeCpp(expression, index);
    return expected ? (getCppNonNullableType(expected, context, new Set()) ?? expected) : undefined;
  }
  const weakMap = getIrWeakMapTypeCpp(objectType, context, new Set());
  if (weakMap && weakMap.typeArguments.length === 2) {
    if (index === 0 && ['delete', 'get', 'has', 'set'].includes(name)) return weakMap.typeArguments[0];
    if (index === 1 && name === 'set') return weakMap.typeArguments[1];
  }
  if (!member) return undefined;
  const collection = getIrAmbientCollectionTypeCpp(objectType, context, new Set());
  if (!collection) return undefined;
  if (member.receiver === 'map') {
    if (index === 0 && ['delete', 'get', 'has', 'set'].includes(name)) return collection.typeArguments[0];
    if (index === 1 && name === 'set') return collection.typeArguments[1];
  }
  if (member.receiver === 'set' && index === 0 && ['add', 'delete', 'has'].includes(name)) {
    return collection.typeArguments[0];
  }
  return undefined;
}

function getIrInvocationProvidedArgumentTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' | 'new' }>>,
  index: number,
): Readonly<IrType> | undefined {
  const provided = [
    ...(expression.semantics.defaultParameters?.provided ?? []),
    ...(expression.semantics.optionalParameters?.provided ?? []),
  ].find((argument) => argument.position === index);
  return provided?.argumentType.kind === 'unknown' ? undefined : provided?.argumentType;
}

function appendCppOmittedInvocationArguments(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  emitted: readonly string[],
  context: EmitContext,
): readonly string[] {
  const defaults = expression.semantics.defaultParameters;
  const optionals = expression.semantics.optionalParameters;
  const plan = defaults ?? optionals;
  if (!plan || emitted.length >= plan.parameterCount) return emitted;
  if (expression.callee.kind === 'property') {
    const receiverType = getIrExpressionTypeEvidenceCpp(expression.callee.object, context);
    const standardRuntimeReceiver =
      expression.callee.member !== undefined ||
      getIrArrayTypeCpp(receiverType, context, new Set()) !== undefined ||
      (receiverType !== undefined && isCppStringValueTypeCpp(receiverType, context, new Set())) ||
      (receiverType?.kind === 'named' && receiverType.reference.kind === 'ambient');
    if (standardRuntimeReceiver) return emitted;
  }
  const declaration =
    expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
      ? getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context)
      : undefined;
  if (!declaration && !optionals) return emitted;
  if (plan.providedArgumentCount === 'dynamic') {
    emissionError(context, 'spread calls into optional or default parameters require ABI expansion lowering');
  }
  const omitted = new Set([...(declaration ? (defaults?.omitted ?? []) : []), ...(optionals?.omitted ?? [])]);
  const result = [...emitted];
  for (let index = emitted.length; index < plan.parameterCount; index += 1) {
    if (!omitted.has(index)) emissionError(context, `missing required call argument at position ${String(index)}`);
    result.push('std::nullopt');
  }
  context.includes.add('optional');
  return result;
}

function emitCppClosedRestCallArguments(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): readonly string[] | undefined {
  const restIndex = expression.semantics.signature?.restParameter;
  if (restIndex === undefined) return undefined;
  const parameter = getCppClosedRestCallParameterCpp(expression, restIndex, context);
  if (!parameter?.rest || parameter.type.kind !== 'array') return undefined;
  if ('dependentCallablePack' in parameter && parameter.dependentCallablePack) return undefined;
  const restType = parameter.type;
  const trailing = expression.arguments.slice(restIndex);
  if (trailing.some((argument) => argument.kind === 'spread')) return undefined;
  const fixed = expression.arguments
    .slice(0, restIndex)
    .map((argument, index) =>
      emitExpression(argument, context, getIrCallArgumentExpectedTypeCpp(expression, index, context)),
    );
  const values = trailing.map((argument) => emitExpression(argument, context, restType.element));
  return [...fixed, `${emitType(restType, context)}{${values.join(', ')}}`];
}

function getCppClosedRestCallParameterCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  restIndex: number,
  context: EmitContext,
): Readonly<IrParameter> | Readonly<IrFunctionTypeParameter> | undefined {
  if (expression.callee.kind === 'function') return expression.callee.parameters[restIndex];
  if (expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding') {
    const declaration = getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context);
    if (declaration) return declaration.parameters[restIndex];
  }
  const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
  return calleeType ? getCppClosedCallableType(calleeType, context, new Set())?.parameters[restIndex] : undefined;
}

function getCppDependentCallableSpreadParameter(
  argument: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrParameter> | undefined {
  if (
    argument.kind !== 'spread' ||
    argument.expression.kind !== 'identifier' ||
    argument.expression.reference.kind !== 'binding'
  ) {
    return undefined;
  }
  return context.dependentCallablePacks.get(argument.expression.reference.binding.id);
}

function emitCppDependentCallableSpreadArgument(
  argument: Readonly<IrExpression>,
  index: number,
  argumentCount: number,
  context: EmitContext,
): string | undefined {
  const parameter = getCppDependentCallableSpreadParameter(argument, context);
  if (!parameter) return undefined;
  if (!context.activeDependentCallablePackIds.has(parameter.binding.id)) {
    emissionError(context, 'dependent callable pack expansion escaped its declaring function boundary');
  }
  if (index !== argumentCount - 1) {
    emissionError(context, 'dependent callable parameter packs require terminal call expansion');
  }
  const pack = getCppDependentCallablePack(parameter, context);
  context.includes.add('utility');
  return `std::forward<${pack.typeName}>(${getBindingTargetName(parameter.binding, context)})...`;
}

function unwrapCppAnyRestCallableCast(expression: Readonly<IrExpression>): Readonly<IrExpression> {
  if (expression.kind !== 'cast' || !isCppAnyRestCallableType(expression.type)) return expression;
  return expression.expression;
}

function isCppAnyRestCallableType(type: Readonly<IrType>): boolean {
  if (type.kind !== 'function' || type.typeParameters.length > 0 || type.parameters.length !== 1) return false;
  const parameter = type.parameters[0]!;
  return (
    parameter.rest &&
    parameter.type.kind === 'array' &&
    parameter.type.element.kind === 'unknown' &&
    parameter.type.element.source === 'any'
  );
}

function getCppCallableTypeParameterCpp(type: Readonly<IrType>, context: EmitContext): string | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length !== 0 ||
    type.reference.binding.kind !== 'typeParameter'
  ) {
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  const declaration = context.anonymousStructTypeParameters.find((parameter) => parameter.binding.id === bindingId);
  if (declaration?.constraint?.kind !== 'function' || declaration.constraint.typeParameters.length > 0) {
    return undefined;
  }
  return context.targetNames.get(declaration.binding.id) ?? pascalCase(declaration.binding.name);
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
  const union = getIrUnionTypeCpp(type, context, new Set());
  if (union) {
    const memberTypes = union.types.map((member) => getIrObjectPropertyTypeCpp(member, propertyName, context));
    if (memberTypes.some((member) => !member)) return undefined;
    return createIrTypeEvidenceUnionCpp(memberTypes.map((member) => member!));
  }
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
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Readonly' &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    return getIrObjectPropertyTypeCpp(type.typeArguments[0], propertyName, context);
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Omit' &&
    type.typeArguments.length === 2 &&
    type.typeArguments[0] &&
    type.typeArguments[1]
  ) {
    const excluded = isCppObjectProjectionPropertyExcluded(type.typeArguments[1], propertyName);
    if (excluded === true) return undefined;
    if (excluded === false) return getIrObjectPropertyTypeCpp(type.typeArguments[0], propertyName, context);
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

function isCppObjectProjectionPropertyExcluded(type: Readonly<IrType>, propertyName: string): boolean | undefined {
  if (type.kind === 'literal' && (typeof type.value === 'number' || typeof type.value === 'string')) {
    return String(type.value) === propertyName;
  }
  if (type.kind === 'primitive' && type.name === 'symbol') return false;
  if (type.kind !== 'union') return undefined;
  const members = type.types.map((member) => isCppObjectProjectionPropertyExcluded(member, propertyName));
  if (members.includes(true)) return true;
  return members.every((member) => member === false) ? false : undefined;
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
  return (
    context.contextualBindingStorageTargetTypes.get(bindingId) ??
    context.preservedInitializerTypes.get(bindingId) ??
    context.bindingTypes.get(bindingId) ??
    getCppImportedBindingTypeCpp(bindingId, context)
  );
}

function getCppImportedBindingTypeCpp(bindingId: string, context: EmitContext): Readonly<IrType> | undefined {
  const cached = context.importedBindingTypes.get(bindingId);
  if (cached !== undefined) return cached ?? undefined;
  const importItem = context.module.imports.find((candidate) =>
    candidate.bindings.some((binding) => binding.binding.id === bindingId),
  );
  const importedBinding = importItem?.bindings.find((binding) => binding.binding.id === bindingId);
  if (!importItem || !importedBinding || importedBinding.imported === '*') {
    context.importedBindingTypes.set(bindingId, null);
    return undefined;
  }
  const candidates = getCppResolvedImportModules(importItem.specifier, context).flatMap((targetModule) => {
    const direct = targetModule.declarations.find(
      (declaration) =>
        'binding' in declaration && declaration.exported && declaration.binding.name === importedBinding.imported,
    );
    const local = targetModule.exports.find(
      (exported) => exported.kind === 'local' && !exported.typeOnly && exported.exported === importedBinding.imported,
    );
    const targetBindingId =
      direct && 'binding' in direct ? direct.binding.id : local?.kind === 'local' ? local.binding.id : undefined;
    const type = targetBindingId ? collectIrModuleBindingTypesCpp(targetModule).get(targetBindingId) : undefined;
    return type ? [type] : [];
  });
  const canonical = new Map(
    candidates.map((candidate) => [normalizeCompilerStructuralValueCanonical(candidate), candidate]),
  );
  const resolved = canonical.size === 1 ? [...canonical.values()][0]! : null;
  context.importedBindingTypes.set(bindingId, resolved);
  return resolved ?? undefined;
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

function getCppContextualAmbientConstructorTypeArgumentsCpp(
  constructorName: string | undefined,
  contextualType: Readonly<IrType> | undefined,
): readonly Readonly<IrType>[] {
  if (
    constructorName === undefined ||
    contextualType?.kind !== 'named' ||
    contextualType.reference.kind !== 'ambient'
  ) {
    return [];
  }
  const contextualName = contextualType.reference.name;
  if (
    contextualName === constructorName ||
    (constructorName === 'Map' && contextualName === 'ReadonlyMap') ||
    (constructorName === 'Set' && contextualName === 'ReadonlySet')
  ) {
    return contextualType.typeArguments;
  }
  return [];
}

function getCppObjectProjectionCallResultTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<Extract<IrType, { kind: 'array' }>> | undefined {
  if (
    expression.callee.kind !== 'property' ||
    expression.callee.object.kind !== 'identifier' ||
    expression.callee.object.reference.kind !== 'ambient' ||
    expression.callee.object.reference.name !== 'Object' ||
    !['entries', 'keys', 'values'].includes(expression.callee.name)
  ) {
    return undefined;
  }
  const argument = expression.arguments[0];
  const record = argument
    ? getCppRecordTypeArgumentsCpp(getIrExpressionTypeEvidenceCpp(argument, context), context, new Set())
    : undefined;
  if (!record) return undefined;
  const element =
    expression.callee.name === 'keys'
      ? record.key
      : expression.callee.name === 'values'
        ? record.value
        : ({
            elements: [record.key, record.value].map((type) => ({
              optional: false as const,
              rest: false as const,
              type,
            })),
            kind: 'tuple',
            readonly: true,
          } as const);
  return { element, kind: 'array', readonly: false };
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
    case 'binary':
      return (
        getIrOperatorValueDomainTypeCpp(expression.semantics.result) ??
        getIrNullishCoalesceTypeEvidenceCpp(expression, context)
      );
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
      if (computedSymbol) {
        return expression.presence === 'narrowedPresent'
          ? (getCppNonNullableType(computedSymbol.type, context, new Set()) ?? computedSymbol.type)
          : computedSymbol.type;
      }
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      const elementType = objectType
        ? getIrIndexedElementTypeCpp(objectType, expression, context, new Set())
        : undefined;
      return elementType && expression.presence === 'narrowedPresent'
        ? (getCppNonNullableType(elementType, context, new Set()) ?? elementType)
        : elementType;
    }
    case 'property': {
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'this') {
        const memberType =
          context.currentClass?.fields.find((field) => field.name === expression.name)?.type ??
          context.currentClass?.methods.find((method) => method.name === expression.name && method.accessor === 'get')
            ?.returns;
        if (memberType) {
          return expression.presence === 'narrowedPresent'
            ? (getCppNonNullableType(memberType, context, new Set()) ?? memberType)
            : memberType;
        }
      }
      const propertyType = getIrPropertyExpressionTypeEvidenceCpp(expression, context);
      return propertyType && expression.presence === 'narrowedPresent'
        ? (getCppNonNullableType(propertyType, context, new Set()) ?? propertyType)
        : propertyType;
    }
    case 'tuple': {
      const elements = expression.elements.map((element) => {
        if (!element.expression) return undefined;
        const type = getIrExpressionTypeEvidenceCpp(element.expression, context);
        return type ? { optional: element.optional, rest: false as const, type } : undefined;
      });
      if (elements.some((element) => !element)) return undefined;
      return {
        elements: elements as readonly IrTupleTypeElement[],
        kind: 'tuple',
        readonly: false,
      };
    }
    case 'literal':
    case 'objectRest':
    case 'regexp':
    case 'spread':
    case 'template':
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
  if (!declaredType || declaredType.kind === 'unknown') {
    const initializer = context.bindingInitializers.get(bindingId);
    let inferred: Readonly<IrType> | undefined;
    if (
      initializer?.kind === 'binary' &&
      initializer.operator === '??' &&
      !context.resolvingInitializerBindingIds.has(bindingId)
    ) {
      context.resolvingInitializerBindingIds.add(bindingId);
      try {
        inferred = getIrNullishCoalesceTypeEvidenceCpp(initializer, context);
      } finally {
        context.resolvingInitializerBindingIds.delete(bindingId);
      }
    }
    if (inferred) return inferred;
    if (!declaredType) return undefined;
  }
  const union = getIrUnionTypeCpp(declaredType, context, new Set());
  if (expression.presence === 'narrowedPresent' && union) {
    const present = union.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    if (present.length === 1) return present[0];
  }
  if (!expression.narrowedMember) return declaredType;
  return union?.types.find((member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember) ?? declaredType;
}

function getIrPropertyExpressionTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const valueType = expression.optional
    ? getIrOptionalChainValueTypeEvidenceCpp(expression, context)
    : (() => {
        const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
        return objectType ? getIrObjectPropertyTypeCpp(objectType, expression.name, context) : undefined;
      })();
  if (!valueType || !expression.optional || expression.optionalChain?.receiverNullish !== 'possible') return valueType;
  return createIrTypeEvidenceUnionCpp([valueType, { kind: 'undefined' }]);
}

function getIrOptionalChainValueTypeEvidenceCpp(
  expression: Readonly<IrExpression>,
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
  if (!semantics) return undefined;
  if (semantics.valueType.kind !== 'unknown') return semantics.valueType;
  if (expression.kind !== 'property') return undefined;
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const presentObjectType = objectType ? getCppNonNullableType(objectType, context, new Set()) : undefined;
  return presentObjectType ? getIrObjectPropertyTypeCpp(presentObjectType, expression.name, context) : undefined;
}

function getIrIndexedElementTypeCpp(
  type: Readonly<IrType>,
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<IrType> | undefined {
  if (type.kind === 'union') {
    const members = type.types.map((member) =>
      getIrIndexedElementTypeCpp(member, expression, context, resolvingAliases),
    );
    if (members.some((member) => !member)) return undefined;
    return createIrTypeEvidenceUnionCpp(members.map((member) => member!));
  }
  if (type.kind === 'array') return type.element;
  if (type.kind === 'tuple') {
    if (expression.index.kind !== 'literal' || typeof expression.index.value !== 'number') return undefined;
    return type.elements[expression.index.value]?.type;
  }
  if (type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') {
    if (/^(?:Float32|Float64|Int16|Int32|Int8|Uint16|Uint32|Uint8|Uint8Clamped)Array$/u.test(type.reference.name)) {
      return { kind: 'primitive', name: 'number' };
    }
    if (type.reference.name === 'BigInt64Array' || type.reference.name === 'BigUint64Array') {
      return { kind: 'primitive', name: 'bigint' };
    }
    if (type.reference.name === 'RegExpExecArray') return { kind: 'primitive', name: 'string' };
    if (
      (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
      type.typeArguments.length === 1 &&
      type.typeArguments[0]
    ) {
      return getIrIndexedElementTypeCpp(type.typeArguments[0], expression, context, resolvingAliases);
    }
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
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    return getIrUnionTypeCpp(type.typeArguments[0], context, seen);
  }
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

function collectIrModuleDeclarationDependenciesCpp(
  module: Readonly<IrModule>,
): ReadonlyMap<Readonly<IrDeclaration>, ReadonlySet<Readonly<IrDeclaration>>> {
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
      if (dependency) referenced.add(dependency);
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
  return dependencies;
}

function collectCppRecursiveTypeAliasBindingIds(module: Readonly<IrModule>): ReadonlySet<string> {
  const dependencies = collectIrModuleDeclarationDependenciesCpp(module);
  const recursive = new Set<string>();
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'typeAlias' || declaration.type.kind !== 'union') continue;
    const seen = new Set<Readonly<IrDeclaration>>();
    const reachesAlias = (current: Readonly<IrDeclaration>): boolean => {
      for (const dependency of dependencies.get(current) ?? []) {
        if (dependency === declaration) return true;
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        if (reachesAlias(dependency)) return true;
      }
      return false;
    };
    if (reachesAlias(declaration)) recursive.add(declaration.binding.id);
  }
  return recursive;
}

function orderIrModuleDeclarationsCpp(
  module: Readonly<IrModule>,
  recursiveTypeAliasBindingIds: ReadonlySet<string>,
): readonly Readonly<IrDeclaration>[] {
  // Source order is the module-evaluation order for variables, classes, enums, and side-effect
  // carriers. Move a later declaration only when an earlier declaration actually depends on it.
  const ranked = [...module.declarations];
  const dependencies = collectIrModuleDeclarationDependenciesCpp(module);

  const pending = new Set(ranked);
  const ordered: Readonly<IrDeclaration>[] = [];
  while (pending.size > 0) {
    const next =
      ranked.find(
        (declaration) =>
          pending.has(declaration) &&
          [...(dependencies.get(declaration) ?? [])].every(
            (dependency) => dependency === declaration || !pending.has(dependency),
          ),
      ) ??
      ranked.find(
        (declaration) =>
          pending.has(declaration) &&
          declaration.kind === 'typeAlias' &&
          recursiveTypeAliasBindingIds.has(declaration.binding.id),
      ) ??
      ranked.find((declaration) => pending.has(declaration));
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

function collectIrModuleBindingInitializersCpp(
  module: Readonly<IrModule>,
): ReadonlyMap<string, Readonly<IrExpression>> {
  const result = new Map<string, Readonly<IrExpression>>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && variable.initializer) result.set(variable.binding.id, variable.initializer);
    },
  });
  return result;
}

// TypeScript index signatures are intentionally erased from closed object shapes in neutral IR.
// An otherwise-empty object parameter that is actually indexed therefore cannot be materialized as
// an empty nominal C++ struct. Keep the structural call boundary as an abbreviated function
// template: arrays, typed arrays, and host-provided indexable carriers then retain their own storage
// and identity while the generated body uses the proven indexed operations directly.
function collectCppIndexedObjectParameterBindingIds(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): ReadonlySet<string> {
  const eligible = new Set<string>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      const type = bindingTypes.get(parameter.binding.id) ?? parameter.type;
      if (type.kind === 'object' && type.properties.length === 0) eligible.add(parameter.binding.id);
    },
  });
  const indexed = new Set<string>();
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (
        expression.kind === 'element' &&
        expression.object.kind === 'identifier' &&
        expression.object.reference.kind === 'binding' &&
        eligible.has(expression.object.reference.binding.id)
      ) {
        indexed.add(expression.object.reference.binding.id);
      }
    },
  });
  return indexed;
}

function collectIrModuleArrayElementBindingIdsCpp(module: Readonly<IrModule>): ReadonlySet<string> {
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
      candidates.add(variable.binding.id);
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

function getCppVariantIndexedReceiverCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  const apparentType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const storageType = getIrExpressionBindingTypeCpp(expression.object, context) ?? apparentType;
  const storageUnion = storageType ? getIrUnionTypeCpp(storageType, context, new Set()) : undefined;
  const storagePlan = storageUnion ? getCppUnionRepresentationPlan(storageUnion, context) : undefined;
  const type =
    storagePlan?.kind === 'optionalVariant' ? getCppNonNullableType(storageType!, context, new Set()) : apparentType;
  const union = type ? getIrUnionTypeCpp(type, context, new Set()) : undefined;
  if (!union) return undefined;
  const plan = getCppUnionRepresentationPlan(union, context);
  const compatible =
    plan.kind === 'multiVariant' &&
    plan.valueSlots.length > 1 &&
    plan.valueSlots.every((slot) => {
      const representation = context.referenceRepresentationPlanner.plan(slot.runtimeType, context.module);
      return (
        representation.kind === 'represented' &&
        (representation.category === 'array' || representation.category === 'typedArray')
      );
    });
  if (!compatible) return undefined;
  const receiver = emitExpression(expression.object, context);
  const underlyingOptionalAutomaticallyUnwrapped =
    expression.object.kind === 'identifier' &&
    expression.object.reference.kind === 'binding' &&
    !context.defaultedParameterIds.has(expression.object.reference.binding.id) &&
    expression.object.presence === 'narrowedPresent' &&
    (context.nullableBindingIds.has(expression.object.reference.binding.id) ||
      context.arrayElementBindingIds.has(expression.object.reference.binding.id));
  return storagePlan?.kind === 'optionalVariant' && !underlyingOptionalAutomaticallyUnwrapped
    ? `${receiver}.value()`
    : receiver;
}

function emitCppVariantIndexedElementAccessCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string | undefined {
  const source = getCppVariantIndexedReceiverCpp(expression, context);
  if (!source) return undefined;
  const valueType =
    getIrExpressionTypeEvidenceCpp(expression, context) ?? getCppVariantIndexedElementTypeCpp(expression, context);
  if (!valueType || valueType.kind === 'unknown') {
    emissionError(context, 'variant indexed access requires concrete common element type evidence');
  }
  context.includes.add('variant');
  const receiver = getGeneratedTargetName('indexedReceiver', context);
  return `std::visit([&](const auto& ${receiver}) -> ${emitType(valueType, context)} { return ${receiver}.element(${emitExpression(expression.index, context)}); }, ${source})`;
}

function getCppVariantIndexedElementTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const storageType =
    getIrExpressionBindingTypeCpp(expression.object, context) ??
    getIrExpressionTypeEvidenceCpp(expression.object, context);
  if (!storageType) return undefined;
  const type = getCppNonNullableType(storageType, context, new Set()) ?? storageType;
  const union = getIrUnionTypeCpp(type, context, new Set());
  if (!union) return undefined;
  const elements = union.types.map((member) => getIrIndexedElementTypeCpp(member, expression, context, new Set()));
  const first = elements[0];
  if (
    !first ||
    elements.some(
      (element) =>
        !element ||
        normalizeCompilerStructuralValueCanonical(element) !== normalizeCompilerStructuralValueCanonical(first),
    )
  ) {
    return undefined;
  }
  return first;
}

function emitCppVariantIndexedAssignmentCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  operator: string,
  right: string,
  context: EmitContext,
): string | undefined {
  const receiverSource = getCppVariantIndexedReceiverCpp(expression, context);
  if (!receiverSource) return undefined;
  if (operator !== '=') {
    emissionError(context, 'compound assignment through a variant indexed receiver requires coercion-aware lowering');
  }
  context.includes.add('variant');
  const source = getGeneratedTargetName('indexedSource', context);
  const index = getGeneratedTargetName('indexedIndex', context);
  const value = getGeneratedTargetName('indexedValue', context);
  const receiver = getGeneratedTargetName('indexedReceiver', context);
  return `([&]() { auto&& ${source} = ${receiverSource}; const auto ${index} = ${emitExpression(expression.index, context)}; const auto ${value} = ${right}; std::visit([&](auto& ${receiver}) { ${receiver}.element(${index}) = ${value}; }, ${source}); return ${value}; }())`;
}

function emitCppStructuralWriteProxyConstructionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
): string | undefined {
  if (
    expression.callee.kind !== 'identifier' ||
    expression.callee.reference.kind !== 'ambient' ||
    expression.callee.reference.name !== 'Proxy'
  ) {
    return undefined;
  }
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') {
    emissionError(context, 'Proxy construction requires flight-cpp structural write-proxy lowering');
  }
  const plan = getCppStructuralWriteProxyConstructionPlanCpp(expression, expectedType, context);
  if (!plan) {
    emissionError(context, 'Proxy construction requires an exact structural write-forwarding handler');
  }
  context.includes.add('flight/structural_ref.hpp');
  const schema = emitCppStructuralRowSchemaTypeCpp(plan.row, context);
  const target = emitExpression(plan.target, context, plan.type);
  const key = emitExpression(plan.key, context);
  const enabled = emitExpression(plan.enabled, context);
  const report = emitExpression(plan.report, context);
  return `flight::make_structural_write_proxy<${schema}>(${target}, ${key}, [=]() { if (${enabled}) { ${report}; } })`;
}

function getCppStructuralWriteProxyConstructionPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
):
  | Readonly<{
      enabled: IrExpression;
      key: IrExpression;
      report: Extract<IrExpression, { kind: 'call' }>;
      row: CompilerCppStructuralRowPlan;
      target: IrExpression;
      type: IrType;
    }>
  | undefined {
  if (expression.typeArguments.length !== 0 || expression.arguments.length !== 2 || !expectedType) return undefined;
  const target = expression.arguments[0]!;
  const handler = expression.arguments[1]!;
  const type = getIrExpressionTypeEvidenceCpp(target, context);
  if (!type) return undefined;
  const row = context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module);
  const resultRow = context.referenceRepresentationPlanner.resolveStructuralRow(expectedType, context.module);
  if (
    !row ||
    !resultRow ||
    normalizeCompilerStructuralValueCanonical(row) !== normalizeCompilerStructuralValueCanonical(resultRow) ||
    handler.kind !== 'object' ||
    handler.members.length !== 1
  ) {
    return undefined;
  }
  const setMember = handler.members[0];
  if (
    setMember?.kind !== 'property' ||
    setMember.name !== 'set' ||
    setMember.value.kind !== 'function' ||
    setMember.value.async ||
    setMember.value.thisMode !== 'dynamic' ||
    setMember.value.typeParameters.length !== 0 ||
    setMember.value.parameters.length !== 3 ||
    setMember.value.parameters.some((parameter) => parameter.optional || parameter.rest) ||
    setMember.value.expression ||
    setMember.value.body.length !== 3
  ) {
    return undefined;
  }
  const [targetParameter, keyParameter, valueParameter] = setMember.value.parameters;
  const [guardStatement, forwardStatement, returnStatement] = setMember.value.body;
  if (
    !targetParameter ||
    !keyParameter ||
    !valueParameter ||
    guardStatement?.kind !== 'if' ||
    guardStatement.otherwise ||
    guardStatement.condition.kind !== 'binary' ||
    guardStatement.condition.operator !== '&&' ||
    guardStatement.condition.left.kind !== 'binary' ||
    guardStatement.condition.left.operator !== '===' ||
    !isIrBindingIdentifierCpp(guardStatement.condition.left.left, keyParameter.binding.id) ||
    guardStatement.condition.right.kind !== 'identifier' ||
    guardStatement.condition.right.reference.kind !== 'binding' ||
    guardStatement.condition.right.reference.binding.kind !== 'variable' ||
    guardStatement.condition.right.reference.binding.scope !== 'module' ||
    !isCppBooleanExpressionTypeCpp(guardStatement.condition.right, context) ||
    guardStatement.consequent.kind !== 'block' ||
    guardStatement.consequent.statements.length !== 1
  ) {
    return undefined;
  }
  const key = guardStatement.condition.left.right;
  const reportStatement = guardStatement.consequent.statements[0];
  if (
    !isCppStructuralWriteProxyComputedKeyCpp(type, key, context) ||
    reportStatement?.kind !== 'expression' ||
    reportStatement.expression.kind !== 'call' ||
    !reportStatement.expression.optional ||
    reportStatement.expression.callee.kind !== 'identifier' ||
    reportStatement.expression.callee.reference.kind !== 'binding' ||
    reportStatement.expression.callee.reference.binding.kind !== 'variable' ||
    reportStatement.expression.callee.reference.binding.scope !== 'module' ||
    reportStatement.expression.typeArguments.length !== 0 ||
    reportStatement.expression.arguments.length !== 1 ||
    reportStatement.expression.arguments[0]?.kind !== 'literal' ||
    reportStatement.expression.arguments[0].value !== 'runtime-slot' ||
    forwardStatement?.kind !== 'expression' ||
    forwardStatement.expression.kind !== 'assignment' ||
    forwardStatement.expression.operator !== '=' ||
    forwardStatement.expression.left.kind !== 'element' ||
    forwardStatement.expression.left.optional ||
    !isCppStructuralWriteProxyForwardTargetCpp(forwardStatement.expression.left.object, targetParameter.binding.id) ||
    !isIrBindingIdentifierCpp(forwardStatement.expression.left.index, keyParameter.binding.id) ||
    !isIrBindingIdentifierCpp(forwardStatement.expression.right, valueParameter.binding.id) ||
    returnStatement?.kind !== 'return' ||
    returnStatement.expression?.kind !== 'literal' ||
    returnStatement.expression.value !== true
  ) {
    return undefined;
  }
  return {
    enabled: guardStatement.condition.right,
    key,
    report: reportStatement.expression,
    row,
    target,
    type,
  };
}

function isCppBooleanExpressionTypeCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  return type?.kind === 'primitive' && type.name === 'boolean';
}

function emitCppTruthinessExpression(expression: Readonly<IrExpression>, context: EmitContext): string {
  const emitted = emitExpression(expression, context);
  if (
    getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
    isCppBooleanExpressionTypeCpp(expression, context) ||
    (expression.kind === 'unary' && expression.operator === '!')
  ) {
    return emitted;
  }
  context.includes.add('flight/boolean.hpp');
  return `flight::to_boolean(${emitted})`;
}

function isCppStructuralWriteProxyComputedKeyCpp(
  type: Readonly<IrType>,
  key: Readonly<IrExpression>,
  context: EmitContext,
): boolean {
  const keyReference = getIrExpressionValueNameReferenceCpp(key);
  if (!keyReference) return false;
  const keyName = getCppComputedPropertySourceName(keyReference, context);
  const members = type.kind === 'intersection' ? type.types : [type];
  const matches = members.flatMap(
    (member) =>
      context.referenceRepresentationPlanner
        .resolveObjectShape(member, context.module)
        ?.filter(
          (property) =>
            property.computedKey && getCppComputedPropertySourceName(property.computedKey, context) === keyName,
        ) ?? [],
  );
  return matches.length === 1;
}

function isCppStructuralWriteProxyForwardTargetCpp(
  expression: Readonly<IrExpression>,
  targetBindingId: string,
): boolean {
  if (
    expression.kind !== 'cast' ||
    expression.type.kind !== 'named' ||
    expression.type.reference.kind !== 'ambient' ||
    expression.type.reference.name !== 'Record' ||
    expression.type.typeArguments.length !== 2 ||
    expression.type.typeArguments[0]?.kind !== 'named' ||
    expression.type.typeArguments[0].reference.kind !== 'ambient' ||
    expression.type.typeArguments[0].reference.name !== 'PropertyKey' ||
    expression.type.typeArguments[0].typeArguments.length !== 0 ||
    expression.type.typeArguments[1]?.kind !== 'unknown' ||
    expression.type.typeArguments[1].source !== 'unknown'
  ) {
    return false;
  }
  const unknownTarget = expression.expression;
  return (
    unknownTarget.kind === 'cast' &&
    unknownTarget.type.kind === 'unknown' &&
    unknownTarget.type.source === 'unknown' &&
    isIrBindingIdentifierCpp(unknownTarget.expression, targetBindingId)
  );
}

function emitCppStructuralRowAssignment(
  target: Readonly<IrExpression>,
  value: string,
  context: EmitContext,
): string | undefined {
  if (target.kind === 'property' && getCppStructuralRowExpressionPlanCpp(target.object, context)) {
    context.includes.add('flight/structural_ref.hpp');
    return `flight::row_set<flight::RowKey<${JSON.stringify(target.name)}>>(${emitExpression(target.object, context)}, ${value})`;
  }
  if (target.kind === 'element' && getCppStructuralRowExpressionPlanCpp(target.object, context)) {
    context.includes.add('flight/structural_ref.hpp');
    return `flight::row_set(${emitExpression(target.object, context)}, ${emitExpression(target.index, context)}, ${value})`;
  }
  return undefined;
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

function emitCppValueLogicalOrExpression(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
  expectedType: Readonly<IrType> | undefined,
): string | undefined {
  if (
    expression.operator !== '||' ||
    expression.semantics.result === 'boolean' ||
    getCppRuntimeProfile(context.options) !== 'flight-cpp'
  ) {
    return undefined;
  }
  const resultType =
    expectedType ??
    getIrOperatorValueDomainTypeCpp(expression.semantics.result) ??
    getIrExpressionTypeEvidenceCpp(expression.right, context);
  if (!resultType || resultType.kind === 'unknown') return undefined;
  const operands: IrExpression[] = [];
  const collect = (candidate: Readonly<IrExpression>): void => {
    if (candidate.kind === 'binary' && candidate.operator === '||') {
      collect(candidate.left);
      collect(candidate.right);
      return;
    }
    operands.push(candidate);
  };
  collect(expression);
  if (operands.length < 2) return undefined;
  const lines: string[] = [];
  for (const operand of operands.slice(0, -1)) {
    const name = getGeneratedTargetName('logicalOrValue', context);
    const type = getIrExpressionTypeEvidenceCpp(operand, context);
    const union = type ? getIrUnionTypeCpp(type, context, new Set()) : undefined;
    const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
    const value = emitExpression(operand, context, type);
    const returned = plan?.kind === 'optionalSingle' ? `${name}.value()` : name;
    lines.push(`auto ${name} = ${value};`, `if (flight::to_boolean(${name})) return ${returned};`);
  }
  const last = emitExpression(operands.at(-1)!, context, resultType);
  context.includes.add('flight/boolean.hpp');
  return `([&]() -> ${emitType(resultType, context)} { ${lines.join(' ')} return ${last}; }())`;
}

function emitCppForeignAnonymousPropertyObjectCpp(
  target: Readonly<IrExpression>,
  value: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  if (target.kind !== 'property' || value.kind !== 'object') return undefined;
  const receiverType = getIrExpressionTypeEvidenceCpp(target.object, context);
  if (!receiverType) return undefined;
  const owner = getCppTypeReferenceOwnerModuleCpp(receiverType, context);
  if (owner.packageName === context.module.packageName) return undefined;
  const property = context.referenceRepresentationPlanner
    .resolveObjectShape(receiverType, context.module)
    ?.find((candidate) => candidate.name === target.name);
  const objectType = property ? getCppNonNullableType(property.type, context, new Set()) : undefined;
  if (objectType?.kind !== 'object' || value.members.some((member) => member.kind !== 'property')) {
    return undefined;
  }
  const members = value.members as readonly Readonly<Extract<IrObjectMember, { kind: 'property' }>>[];
  const byName = new Map(members.map((member) => [member.name, member] as const));
  const ordered = objectType.properties.flatMap((expected) => {
    const member = byName.get(expected.name);
    return member ? [{ expected, member }] : [];
  });
  if (ordered.length !== members.length) return undefined;
  // The embedded object type is copied from the defining module into cross-module property
  // evidence. Its canonical shape therefore produces the same stable helper name as the defining
  // header, while the receiver's resolved owner supplies the namespace that must qualify it.
  const key = `\0${normalizeCompilerStructuralValueCanonical(objectType)}`;
  const name = getCppAnonymousStructBaseName(objectType.properties, getCppStableIdentifierHash(key));
  const qualified = `${getCppCompilerPackageNamespace(owner.packageName, context.options.packageTargets)}::${name}`;
  const sourceOrder = members.map((member) => member.name);
  const targetOrder = ordered.map(({ member }) => member.name);
  const reordered = sourceOrder.some((name, index) => name !== targetOrder[index]);
  if (reordered) {
    const temporaries = new Map(
      members.map((member) => [member, getGeneratedTargetName(`object_member_${member.name}`, context)] as const),
    );
    const evaluations = members.map(
      (member) =>
        `auto ${temporaries.get(member)!} = ${emitExpression(member.value, context, objectType.properties.find((property) => property.name === member.name)?.type)};`,
    );
    const initializer = ordered
      .map(({ member }) => `.${safeCppName(member.name)} = ${temporaries.get(member)!}`)
      .join(', ');
    return `([&]() { ${evaluations.join(' ')} return flight::make_ref<${qualified}>(${qualified}{${initializer}}); }())`;
  }
  const initializer = ordered
    .map(
      ({ expected, member }) =>
        `.${safeCppName(member.name)} = ${emitExpression(member.value, context, expected.type)}`,
    )
    .join(', ');
  return `flight::make_ref<${qualified}>(${qualified}{${initializer}})`;
}

function emitCppRecordIndexedAssignmentCpp(
  target: Readonly<IrExpression>,
  value: string,
  context: EmitContext,
): string | undefined {
  if (target.kind !== 'element') return undefined;
  const receiverType = getIrExpressionTypeEvidenceCpp(target.object, context);
  const record = getCppRecordTypeArgumentsCpp(receiverType, context, new Set());
  if (!record) return undefined;
  const receiver = emitExpression(target.object, context);
  const key = emitCppRequiredRecordKeyCpp(target.index, record.key, context);
  return `([&]() { auto assignment_value = ${value}; ${receiver}.set(${key}, assignment_value); return assignment_value; }())`;
}

function emitCppRecordNullishAssignmentCpp(
  target: Readonly<IrExpression>,
  value: string,
  context: EmitContext,
): string | undefined {
  if (target.kind !== 'element') return undefined;
  const receiverType = getIrExpressionTypeEvidenceCpp(target.object, context);
  const record = getCppRecordTypeArgumentsCpp(receiverType, context, new Set());
  const valueUnion = record ? getIrUnionTypeCpp(record.value, context, new Set()) : undefined;
  const valuePlan = valueUnion ? getCppUnionRepresentationPlan(valueUnion, context) : undefined;
  if (!record || valuePlan?.kind !== 'optionalSingle') return undefined;
  const receiver = getGeneratedTargetName('assignmentReceiver', context);
  const key = getGeneratedTargetName('assignmentKey', context);
  const existing = getGeneratedTargetName('assignmentExisting', context);
  const assigned = getGeneratedTargetName('assignmentValue', context);
  return `([&]() { auto&& ${receiver} = ${emitExpression(target.object, context)}; const auto ${key} = ${emitCppRequiredRecordKeyCpp(target.index, record.key, context)}; auto ${existing} = ${receiver}.get(${key}); if (${existing}.has_value() && ${existing}.value().has_value()) return ${existing}.value().value(); auto ${assigned} = ${value}; ${receiver}.set(${key}, ${assigned}); return ${assigned}.value(); }())`;
}

function emitCppRequiredRecordKeyCpp(
  expression: Readonly<IrExpression>,
  targetType: Readonly<IrType>,
  context: EmitContext,
): string {
  const sourceType =
    getIrExpressionBindingTypeCpp(expression, context) ?? getIrExpressionTypeEvidenceCpp(expression, context);
  const sourceUnion = sourceType ? getIrUnionTypeCpp(sourceType, context, new Set()) : undefined;
  const sourcePlan = sourceUnion ? getCppUnionRepresentationPlan(sourceUnion, context) : undefined;
  const presentSource = sourceType ? getCppNonNullableType(sourceType, context, new Set()) : undefined;
  const target = emitType(targetType, context);
  if (
    sourcePlan?.kind === 'optionalSingle' &&
    presentSource &&
    emitType(presentSource, context) === target &&
    !hasIrTypeAbsentMember(targetType)
  ) {
    return `${emitExpression(expression, context, sourceType)}.value()`;
  }
  return emitExpression(expression, context, targetType);
}

function emitCppConditionalBranchCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType: Readonly<IrType> | undefined,
): string {
  const union = expectedType ? getIrUnionTypeCpp(expectedType, context, new Set()) : undefined;
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  if (expression.kind !== 'object' || plan?.kind !== 'optionalSingle' || !plan.valueSlots[0]) {
    return emitExpression(expression, context, expectedType);
  }
  const slot = plan.valueSlots[0];
  return emitCppUnionValueConstruction(
    emitExpression(expression, context, slot.runtimeType, false),
    slot.targetType,
    union!,
    plan.kind,
    context,
  );
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
    hasCppRegExpExecArrayIndexedReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.capture(${emitExpression(expression.index, context)})`;
  }
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.get(${emitExpression(expression.index, context)})`;
  }
  if (expression.kind === 'element' && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
    const record = getCppRecordTypeArgumentsCpp(objectType, context, new Set());
    if (record) {
      return `${emitExpression(expression.object, context)}.get(${emitCppRequiredRecordKeyCpp(expression.index, record.key, context)})`;
    }
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
  const receiverType = emitOptionalChainPayloadIrTypeCpp(semantics.receiverType, context);
  const invocation = getCppCallableObjectIrTypeCpp(receiverType, context, new Set())
    ? `(*optional_chain_receiver.value())(${arguments_})`
    : `optional_chain_receiver.value()(${arguments_})`;
  context.includes.add('optional');
  if (valueType.kind === 'primitive' && valueType.name === 'void') {
    return `([&]() { auto optional_chain_receiver = ${callee}; if (!optional_chain_receiver.has_value()) return; ${invocation}; }())`;
  }
  const payload = emitType(valueType, context);
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${callee}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${invocation}; }())`;
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
  expectedType?: Readonly<IrType> | undefined,
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
  const receiverEvidence = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const receiverType = emitOptionalChainPayloadIrTypeCpp(
    semantics.receiverType.kind === 'unknown' ? (receiverEvidence ?? semantics.receiverType) : semantics.receiverType,
    context,
  );
  const resolvedPropertyType = getIrObjectPropertyTypeCpp(receiverType, expression.name, context);
  const contextualValueType = expectedType ? getCppNonNullableType(expectedType, context, new Set()) : undefined;
  const valueType =
    semantics.valueType.kind === 'unknown'
      ? (resolvedPropertyType ?? contextualValueType ?? semantics.valueType)
      : semantics.valueType;
  const payload = emitOptionalChainPayloadTypeCpp(valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  const memberOperator = hasFlightReferenceRepresentationCpp(receiverType, context) ? '->' : '.';
  let projected: string;
  const structuralReceiver = context.referenceRepresentationPlanner.resolveStructuralRow(
    receiverType,
    context.module,
  );
  if (structuralReceiver) {
    context.includes.add('flight/structural_ref.hpp');
    projected = `flight::row_get<flight::RowKey<${JSON.stringify(expression.name)}>>(optional_chain_receiver.value())`;
  } else if (expression.member) {
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
  const declaredProperty = context.referenceRepresentationPlanner
    .resolveObjectShape(receiverType, context.module)
    ?.find((property) => property.name === expression.name);
  const projectedStorageType = declaredProperty
    ? emitOptionalTypeCpp(
        emitCppMaterializedObjectPropertyTypeCpp(declaredProperty.type, context),
        declaredProperty.optional,
        context,
      )
    : undefined;
  const resultType = `std::optional<${payload}>`;
  const declaredUnion = declaredProperty ? getIrUnionTypeCpp(declaredProperty.type, context, new Set()) : undefined;
  const declaredUnionPlan = declaredUnion ? getCppUnionRepresentationPlan(declaredUnion, context) : undefined;
  const nestedOptionalStorage =
    declaredProperty?.optional === true &&
    (declaredUnionPlan?.kind === 'optionalSingle' || declaredUnionPlan?.kind === 'optionalVariant');
  const returned =
    !structuralReceiver &&
    (nestedOptionalStorage || projectedStorageType === `std::optional<${resultType}>`)
      ? `${projected}.value_or(std::nullopt)`
      : projected;
  context.includes.add('optional');
  return `([&]() -> ${resultType} { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${returned}; }())`;
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

function emitCppNarrowedPresentAccessCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' | 'property' }>>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
): string | undefined {
  if (expression.presence !== 'narrowedPresent') return undefined;
  const unnarrowed = { ...expression, presence: undefined };
  const sourceType = getIrExpressionTypeEvidenceCpp(unnarrowed, context);
  if (!sourceType || !hasIrTypeAbsentMember(sourceType)) return undefined;
  const presentType = getCppNonNullableType(sourceType, context, new Set());
  if (!presentType) {
    emissionError(context, 'present access requires one concrete non-nullish C++ value domain');
  }
  const union = getIrUnionTypeCpp(sourceType, context, new Set());
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  if (plan?.kind !== 'optionalSingle') {
    emissionError(context, 'present access requires optional C++ storage with one value domain');
  }
  context.includes.add('optional');
  const unwrapped = `${emitExpression(unnarrowed, context, presentType)}.value()`;
  if (expectedType && context.referenceRepresentationPlanner.resolveStructuralRow(expectedType, context.module)) {
    const sourcePlan = context.referenceRepresentationPlanner.plan(presentType, context.module);
    if (
      sourcePlan.kind !== 'represented' ||
      sourcePlan.identityDomain !== 'object' ||
      sourcePlan.valueRepresentation === 'inlineValue'
    ) {
      emissionError(context, 'present structural-row projection requires a represented object-reference source');
    }
    context.includes.add('flight/structural_ref.hpp');
    const target = emitType(expectedType, context);
    return sourcePlan.valueRepresentation === 'flightReference'
      ? `${target}(${unwrapped})`
      : `flight::structural_ref_cast<${target}>(${unwrapped})`;
  }
  return unwrapped;
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

// Partial<T> and other structural utilities materialize a new anonymous object. If one of its
// properties adds a nullish sentinel around an imported union alias, retain the defining alias as
// the payload. Re-expanding that alias here creates package-local anonymous alternatives with a
// distinct C++ identity even though the source property still names the upstream ABI type.
function emitCppMaterializedObjectPropertyTypeCpp(type: Readonly<IrType>, context: EmitContext): string {
  if (type.kind !== 'union') return emitType(type, context);
  const sentinels = type.types.filter((member) => member.kind === 'null' || member.kind === 'undefined');
  const values = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  const value = values.length === 1 ? values[0] : undefined;
  if (
    sentinels.length === 1 &&
    value?.kind === 'named' &&
    value.reference.kind === 'binding' &&
    value.reference.binding.kind === 'import' &&
    resolveCppTypeAliasTarget(value, context)?.kind === 'union'
  ) {
    context.includes.add('optional');
    return `std::optional<${emitType(value, context)}>`;
  }
  return emitType(type, context);
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

function hasCppRegExpExecArrayIndexedReceiverCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): boolean {
  const type = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const receiver = type ? getCppNonNullableType(type, context, new Set()) : undefined;
  return (
    receiver?.kind === 'named' && receiver.reference.kind === 'ambient' && receiver.reference.name === 'RegExpExecArray'
  );
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
  if (getCppCallableObjectIrTypeCpp(type, context, new Set())) return true;
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  if (identityPreserving) return hasFlightReferenceRepresentationCpp(identityPreserving, context);
  const owner = getCppDirectBindingOwner(type, context);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return plan.kind === 'represented' && plan.valueRepresentation === 'flightReference';
}

function hasFlightStructuralRowRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  return (
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    Boolean(context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module))
  );
}

function getCppStructuralRowExpressionPlanCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<CompilerCppStructuralRowPlan> | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    const bindingRow = context.structuralCastBindingRows.get(expression.reference.binding.id);
    if (bindingRow) return bindingRow;
  }
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  const row = type ? context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module) : undefined;
  if (row || expression.kind !== 'cast') return row;
  const sourceType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
  const sourceRow = sourceType
    ? context.referenceRepresentationPlanner.resolveStructuralRow(sourceType, context.module)
    : undefined;
  return sourceRow ? getCppStructuralProjectionRowCpp(expression.type, context) : undefined;
}

function getCppStructuralProjectionRowCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<CompilerCppStructuralRowPlan> | undefined {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0] &&
    (type.reference.name === 'NoInfer' || type.reference.name === 'Readonly')
  ) {
    const row = getCppStructuralProjectionRowCpp(type.typeArguments[0], context);
    if (!row) return undefined;
    return type.reference.name === 'Readonly' ? { kind: 'readonly', row } : row;
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Partial' &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    const object = type.typeArguments[0];
    const plan = context.referenceRepresentationPlanner.plan(object, context.module);
    if (
      !context.referenceRepresentationPlanner.resolveObjectShape(object, context.module) ||
      plan.kind !== 'represented' ||
      plan.identityDomain !== 'object' ||
      plan.valueRepresentation !== 'flightReference'
    ) {
      return undefined;
    }
    return { kind: 'partial', row: { kind: 'rowOf', type: object } };
  }
  const owner = getCppDirectBindingOwner(type, context);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  if (
    !context.referenceRepresentationPlanner.resolveObjectShape(type, context.module) ||
    plan.kind !== 'represented' ||
    plan.identityDomain !== 'object' ||
    plan.valueRepresentation !== 'flightReference'
  ) {
    return undefined;
  }
  return { kind: 'writable', row: { kind: 'rowOf', type } };
}

function hasFlightFacetReferenceRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const owner = getCppDirectBindingOwner(type, context);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return plan.kind === 'represented' && plan.category === 'facet' && plan.valueRepresentation === 'runtimeReference';
}

function getCppIdentityPreservingUtilityArgument(type: Readonly<IrType>): Readonly<IrType> | undefined {
  return type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1
    ? type.typeArguments[0]
    : undefined;
}

function isCppReferenceValueAliasCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
  if (context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module)) return true;
  const target = resolveCppTypeAliasTarget(type, context);
  if (!target || target.kind === 'object' || target.kind === 'intersection') return false;
  return hasFlightReferenceRepresentationCpp(target, context);
}

function getCppReferenceValueAliasStorageTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): string | undefined {
  if (!isCppReferenceValueAliasCpp(type, context) || type.kind !== 'named' || type.reference.kind !== 'binding') {
    return undefined;
  }
  const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
  if (resolvingAliases.has(key)) return undefined;
  const target = resolveCppTypeAliasTarget(type, context);
  if (!target) return undefined;
  const nested = getCppReferenceValueAliasStorageTypeCpp(target, context, new Set(resolvingAliases).add(key));
  return nested ?? emitType(target, context, 'storage');
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
    const parameterType = emitCppParameterTypeCpp(parameter.type, parameter.rest, context);
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
  if (
    context.indexedObjectParameterBindingIds.has(parameter.binding.id) ||
    isCppGenericStructuralSequenceParameterCpp(parameter, context)
  ) {
    return `auto ${name}`;
  }
  if (parameter.dependentCallablePack) {
    if (!context.activeDependentCallablePackIds.has(parameter.binding.id)) {
      emissionError(context, 'dependent callable parameter packs require a generic function or closure boundary');
    }
    const pack = getCppDependentCallablePack(parameter, context);
    return `${pack.typeName}&&... ${name}`;
  }
  const type = parameter.type ? emitCppParameterTypeCpp(parameter.type, parameter.rest, context) : 'auto';
  if (parameter.optional) {
    context.includes.add('optional');
    return `std::optional<${type}> ${name} = std::nullopt`;
  }
  if (parameter.rest) {
    return `${type} ${name}`;
  }
  return `${type} ${name}`;
}

function emitCppParameterTypeCpp(type: Readonly<IrType>, rest: boolean, context: EmitContext): string {
  const array = rest ? undefined : getIrArrayTypeCpp(type, context, new Set());
  if (
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    array?.readonly === true &&
    context.referenceRepresentationPlanner.resolveStructuralRow(array.element, context.module)
  ) {
    context.includes.add('flight/sequence_view.hpp');
    return `flight::SequenceView<${emitType(array.element, context)}>`;
  }
  return emitType(type, context);
}

function isCppGenericStructuralSequenceParameterCpp(
  parameter: Readonly<IrParameter>,
  context: EmitContext,
): boolean {
  if (parameter.rest || getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const array = getIrArrayTypeCpp(parameter.type, context, new Set());
  return Boolean(array?.readonly && array.element.kind === 'object');
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
      ? getCppResolvedExportTargetName(targetModule, exported.imported, exported.typeOnly ? 'type' : 'value', context)
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

function emitTypeParameters(
  parameters: readonly IrTypeParameter[],
  context: EmitContext,
  includeDefaults = false,
): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map((parameter) => {
      const name = context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name);
      const defaultType =
        includeDefaults && parameter.default
          ? ` = ${emitCppTemplateDefaultTypeArgumentCpp(parameter.default, context)}`
          : '';
      return `typename ${name}${defaultType}`;
    })
    .join(', ')}>`;
}

function emitCppTemplateDefaultTypeArgumentCpp(type: Readonly<IrType>, context: EmitContext): string {
  if (type.kind === 'named' && type.reference.kind === 'binding') {
    const resolved = resolveCppTypeAliasTarget(type, context);
    if (resolved) return emitCppTypeArgumentCpp(resolved, context);
  }
  return emitCppTypeArgumentCpp(type, context);
}

interface CppDependentCallablePack {
  readonly callableTypeName: string;
  readonly typeName: string;
}

interface CppFunctionTemplate {
  readonly parameters: string;
  readonly requirement: string;
}

function emitCppFunctionTemplate(
  typeParameters: readonly IrTypeParameter[],
  parameters: readonly Readonly<IrParameter>[],
  context: EmitContext,
): CppFunctionTemplate {
  const declared = typeParameters.map(
    (parameter) => `typename ${context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name)}`,
  );
  const packs = parameters.flatMap((parameter) =>
    parameter.dependentCallablePack ? [getCppDependentCallablePack(parameter, context)] : [],
  );
  const names = [
    ...declared.map((parameter) => parameter.replace(/^typename /u, '')),
    ...packs.map((pack) => pack.typeName),
  ];
  if (new Set(names).size !== names.length) {
    emissionError(context, 'dependent callable parameter-pack type names must be unique within their function');
  }
  return {
    parameters:
      declared.length + packs.length > 0
        ? `<${[...declared, ...packs.map((pack) => `typename... ${pack.typeName}`)].join(', ')}>`
        : '',
    requirement: packs
      .map(
        (pack) =>
          `${getCompilerCallableSignatureAbiCpp().trait}<${pack.callableTypeName}>::template accepts<${pack.typeName}...>`,
      )
      .join(' && '),
  };
}

function getCppDependentCallablePack(parameter: Readonly<IrParameter>, context: EmitContext): CppDependentCallablePack {
  const evidence = parameter.dependentCallablePack;
  const projection = parameter.type;
  const projectedCallable =
    projection.kind === 'named' &&
    projection.reference.kind === 'ambient' &&
    projection.reference.name === 'Parameters' &&
    projection.typeArguments.length === 1
      ? projection.typeArguments[0]
      : undefined;
  const declaredCallable = evidence
    ? context.anonymousStructTypeParameters.find((candidate) => candidate.binding.id === evidence.callable.id)
    : undefined;
  if (
    !parameter.rest ||
    !evidence ||
    (evidence.kind !== 'parameters' && evidence.kind !== 'implementation') ||
    evidence.schema !== 'flight-compiler-dependent-callable-pack/1' ||
    (evidence.kind === 'parameters'
      ? projectedCallable?.kind !== 'named' ||
        projectedCallable.reference.kind !== 'binding' ||
        projectedCallable.reference.path.length !== 0 ||
        projectedCallable.reference.binding.id !== evidence.callable.id
      : projection.kind !== 'array' || projection.element.kind !== 'unknown' || projection.element.source !== 'any') ||
    !declaredCallable?.constraint ||
    declaredCallable.constraint.kind !== 'function' ||
    declaredCallable.constraint.typeParameters.length > 0 ||
    !isDeepStrictEqual(declaredCallable.constraint, evidence.constraint)
  ) {
    emissionError(
      context,
      'dependent Parameters<T> requires coherent evidence for one in-scope nongeneric callable type parameter',
    );
  }
  return {
    callableTypeName: context.targetNames.get(evidence.callable.id) ?? pascalCase(evidence.callable.name),
    typeName: safeCppTypeName(`${parameter.binding.name} pack`),
  };
}

function mergeCppDependentCallablePackIds(
  inherited: ReadonlySet<string>,
  parameters: readonly Readonly<IrParameter>[],
): ReadonlySet<string> {
  return new Set([
    ...inherited,
    ...parameters.flatMap((parameter) => (parameter.dependentCallablePack ? [parameter.binding.id] : [])),
  ]);
}

function collectIrModuleDependentCallablePacksCpp(
  module: Readonly<IrModule>,
): ReadonlyMap<string, Readonly<IrParameter>> {
  const packs = new Map<string, Readonly<IrParameter>>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      if (parameter.dependentCallablePack) packs.set(parameter.binding.id, parameter);
    },
  });
  return packs;
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
      if (target === 'std::range_error' || target === 'std::runtime_error') context.includes.add('stdexcept');
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
  const imported = getCppImportedBindingTargetName(reference.binding.id, [], 'value', context);
  if (imported) return imported;
  return emitBindingValueCpp(reference.binding, context);
}

function getCppClampedArrayElementNumericTypeCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return expression.kind === 'element' && isCppUint8ClampedArrayElementCpp(expression, context)
    ? { kind: 'primitive', name: 'number' }
    : undefined;
}

function isCppUint8ClampedArrayElementCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): boolean {
  if (expression.semantics.receivers.includes('uint8ClampedArray')) return true;
  const resolve = (type: Readonly<IrType> | undefined, seen: ReadonlySet<string>): boolean => {
    if (!type) return false;
    if (type.kind === 'named' && type.reference.kind === 'ambient') {
      if (type.reference.name === 'Uint8ClampedArray') return true;
      if (
        (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
        type.typeArguments.length === 1
      ) {
        return resolve(type.typeArguments[0], seen);
      }
      return false;
    }
    if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
    const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
    if (seen.has(key)) return false;
    return resolve(resolveCppTypeAliasTarget(type, context), new Set(seen).add(key));
  };
  return resolve(getIrExpressionTypeEvidenceCpp(expression.object, context), new Set());
}

function emitCppReferenceIdentityComparison(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  leftType: Readonly<IrType> | undefined,
  rightType: Readonly<IrType> | undefined,
  context: EmitContext,
): string | undefined {
  if (!leftType || !rightType) return undefined;
  const leftStructural = context.referenceRepresentationPlanner.resolveStructuralRow(leftType, context.module);
  const rightStructural = context.referenceRepresentationPlanner.resolveStructuralRow(rightType, context.module);
  if (Boolean(leftStructural) === Boolean(rightStructural)) return undefined;
  const structuralType = leftStructural ? leftType : rightType;
  const referenceType = leftStructural ? rightType : leftType;
  if (!hasFlightReferenceRepresentationCpp(referenceType, context)) return undefined;
  const structuralExpression = leftStructural ? expression.left : expression.right;
  const referenceExpression = leftStructural ? expression.right : expression.left;
  const structural = emitExpression(structuralExpression, context);
  const referenceAsStructural = `${emitType(structuralType, context)}(${emitExpression(referenceExpression, context)})`;
  const left = leftStructural ? structural : referenceAsStructural;
  const right = leftStructural ? referenceAsStructural : structural;
  return `(${left} ${emitBinaryOperator(expression.operator, expression.semantics, context)} ${right})`;
}

function emitCppNullishObjectNegation(
  expression: Readonly<Extract<IrExpression, { kind: 'unary' }>>,
  context: EmitContext,
): string | undefined {
  if (expression.postfix || expression.operator !== '!') return undefined;
  const operandType = getIrExpressionTypeEvidenceCpp(expression.operand, context);
  const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  if (!union) return undefined;
  const plan = getCppUnionRepresentationPlan(union, context);
  if (
    (plan.kind !== 'optionalSingle' && plan.kind !== 'optionalVariant' && plan.kind !== 'dualSentinelVariant') ||
    !plan.valueSlots.every((slot) => isCppAlwaysTruthySourceType(slot.runtimeType, context, new Set()))
  ) {
    return undefined;
  }
  const operand = emitExpression(expression.operand, context);
  if (plan.kind === 'optionalSingle' || plan.kind === 'optionalVariant') return `!${operand}.has_value()`;
  context.includes.add('variant');
  const sentinels = getCppDualSentinelTargetTypes(context);
  return `(std::holds_alternative<${sentinels.null}>(${operand}) || std::holds_alternative<${sentinels.undefined}>(${operand}))`;
}

function isCppAlwaysTruthySourceType(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): boolean {
  if (type.kind === 'array' || type.kind === 'function' || type.kind === 'object' || type.kind === 'tuple') return true;
  if (type.kind !== 'named') return false;
  if (type.reference.kind === 'ambient') {
    return !['ArrayLike', 'PropertyKey'].includes(type.reference.name);
  }
  const plan = context.referenceRepresentationPlanner.plan(type, context.module);
  if (plan.kind === 'represented' && plan.identityDomain === 'object') return true;
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return false;
  const alias = resolveCppTypeAliasTarget(type, context);
  return alias ? isCppAlwaysTruthySourceType(alias, context, new Set(resolvingAliases).add(bindingId)) : false;
}

function emitBindingValueCpp(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(binding.id);
  if (sharedCaptureTargetName) {
    const value =
      getCppRuntimeProfile(context.options) === 'flight-cpp'
        ? `${sharedCaptureTargetName}.read_binding()`
        : `(*${sharedCaptureTargetName})`;
    return context.uninitializedCaptureStorageBindingIds.has(binding.id) ||
      context.defaultedParameterIds.has(binding.id)
      ? `${value}.value()`
      : value;
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
  if (
    object.kind === 'identifier' &&
    object.reference.kind === 'binding' &&
    object.presence !== 'narrowedPresent' &&
    (context.arrayElementBindingIds.has(object.reference.binding.id) ||
      context.nullableBindingIds.has(object.reference.binding.id)) &&
    type &&
    (hasFlightReferenceRepresentationCpp(type, context) || hasFlightFacetReferenceRepresentationCpp(type, context))
  ) {
    return '.value()->';
  }
  if (type && hasIrTypeAbsentMember(type)) {
    const presentType = getCppNonNullableType(type, context, new Set());
    const union = getIrUnionTypeCpp(type, context, new Set());
    const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
    if (
      presentType &&
      plan?.kind === 'optionalSingle' &&
      (getCppCallableObjectIrTypeCpp(presentType, context, new Set()) ||
        hasFlightReferenceRepresentationCpp(presentType, context) ||
        hasFlightFacetReferenceRepresentationCpp(presentType, context))
    ) {
      return '.value()->';
    }
  }
  return type &&
    (hasFlightReferenceRepresentationCpp(type, context) || hasFlightFacetReferenceRepresentationCpp(type, context))
    ? '->'
    : '.';
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
  return types.length === 0 ? '' : `<${types.map((type) => emitCppTypeArgumentCpp(type, context)).join(', ')}>`;
}

function emitCppTypeArgumentCpp(type: Readonly<IrType>, context: EmitContext): string {
  if (type.kind !== 'never') return emitType(type, context);
  context.includes.add('variant');
  return 'std::monostate';
}

function getCppTypeReferenceUsesDefaultArgumentsCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): boolean {
  if (type.reference.kind !== 'binding') return false;
  const declaration = getCppDirectBindingOwner(type, context)?.declaration;
  if (
    !declaration ||
    (declaration.kind !== 'class' && declaration.kind !== 'interface' && declaration.kind !== 'typeAlias') ||
    declaration.typeParameters.length === 0
  ) {
    return false;
  }
  return declaration.typeParameters.every((parameter) => parameter.default !== undefined);
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
  if (operator === 'void') return '(void)';
  return operator;
}

function getCppStaticTypeofValueCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): 'bigint' | 'boolean' | 'function' | 'number' | 'object' | 'string' | 'symbol' | 'undefined' | undefined {
  if (expression.kind === 'literal') {
    if (expression.value === null) return 'object';
    return typeof expression.value;
  }
  if (expression.kind === 'undefinedValue' || expression.kind === 'undefinedDefault') return 'undefined';
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  return type ? getCppStaticTypeofTypeCpp(type, context, new Set()) : undefined;
}

function getCppStaticTypeofTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): 'bigint' | 'boolean' | 'function' | 'number' | 'object' | 'string' | 'symbol' | 'undefined' | undefined {
  if (type.kind === 'primitive') return type.name === 'void' ? 'undefined' : type.name;
  if (type.kind === 'literal') return typeof type.value;
  if (type.kind === 'undefined') return 'undefined';
  if (type.kind === 'function') return 'function';
  if (
    type.kind === 'array' ||
    type.kind === 'intersection' ||
    type.kind === 'null' ||
    type.kind === 'object' ||
    type.kind === 'tuple'
  ) {
    return 'object';
  }
  if (type.kind === 'union') {
    const values = new Set(type.types.map((member) => getCppStaticTypeofTypeCpp(member, context, resolvingAliases)));
    return values.size === 1 ? [...values][0] : undefined;
  }
  if (type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient') return 'object';
  const bindingId = type.reference.binding.id;
  if (resolvingAliases.has(bindingId)) return 'object';
  const alias = resolveCppTypeAliasTarget(type, context);
  if (alias) return getCppStaticTypeofTypeCpp(alias, context, new Set(resolvingAliases).add(bindingId));
  return 'object';
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
  const imported = getCppImportedBindingTargetName(type.reference.binding.id, type.reference.path, 'type', context);
  if (imported) return imported;
  const foreignImported = getCppForeignImportedBindingTargetNameCpp(type, context);
  if (foreignImported) return foreignImported;
  const owner = getCppDirectBindingOwner(type, context);
  if (owner && owner.module.packageName !== context.module.packageName) {
    const targetName =
      context.targetNameMaps.get(getCppModuleIdentityKey(owner.module))?.get(type.reference.binding.id) ??
      pascalCase(type.reference.binding.name);
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

function getCppTypeReferenceOwnerModuleCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrModule> {
  const direct = getCppDirectBindingOwner(type, context);
  if (direct) return direct.module;
  if (type.kind === 'named' && type.reference.kind === 'binding' && type.reference.binding.kind === 'import') {
    const owner = context.importBindingOwners.get(type.reference.binding.id);
    if (!owner) return context.module;
    const resolutionContext = owner.module === context.module ? context : { ...context, module: owner.module };
    const directTargets = getCppResolvedImportModules(owner.specifier, resolutionContext).filter((candidate) =>
      hasCppDirectExportName(candidate, owner.imported),
    );
    return directTargets.length === 1
      ? directTargets[0]!
      : (getCppResolvedImportModule(owner.specifier, resolutionContext) ?? context.module);
  }
  return context.module;
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
  const targetName = getCppResolvedExportTargetName(targetModule, importedName, 'type', context);
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

function getCppImportedScalarAliasTypeCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> | undefined {
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.binding.kind !== 'import') {
    return undefined;
  }
  const alias = resolveCppTypeAliasTarget(type, context);
  return alias?.kind === 'literal' || alias?.kind === 'primitive' ? alias : undefined;
}

function getCppImportedBindingTargetName(
  bindingId: string,
  referencePath: readonly string[],
  space: 'type' | 'value',
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
    const targetName = getCppResolvedExportTargetName(targetModule, importedName, space, context);
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
    const targetName = getCppResolvedExportTargetName(targetModule, expression.name, 'value', context);
    const namespaceName = getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets);
    return `${namespaceName}::${targetName}`;
  }
  return undefined;
}

function getCppResolvedExportTargetName(
  module: Readonly<IrModule>,
  exportedName: string,
  space: 'type' | 'value',
  context: EmitContext,
): string {
  const directBindingId = module.declarations.flatMap((declaration) =>
    'binding' in declaration &&
    declaration.exported &&
    declaration.binding.name === exportedName &&
    (space === 'type'
      ? declaration.kind === 'class' ||
        declaration.kind === 'enum' ||
        declaration.kind === 'interface' ||
        declaration.kind === 'typeAlias'
      : declaration.kind === 'class' ||
        declaration.kind === 'enum' ||
        declaration.kind === 'function' ||
        declaration.kind === 'variable')
      ? [declaration.binding.id]
      : [],
  )[0];
  const local = module.exports.find(
    (exported) =>
      exported.kind === 'local' &&
      exported.exported === exportedName &&
      (space === 'value'
        ? !exported.typeOnly
        : exported.typeOnly ||
          module.declarations.some(
            (declaration) =>
              'binding' in declaration &&
              declaration.binding.id === exported.binding.id &&
              (declaration.kind === 'class' || declaration.kind === 'enum'),
          )),
  );
  const bindingId = directBindingId ?? (local?.kind === 'local' ? local.binding.id : undefined);
  if (!bindingId) return pascalCase(exportedName);
  return context.targetNameMaps.get(getCppModuleIdentityKey(module))?.get(bindingId) ?? pascalCase(exportedName);
}

function isCppConcreteTypedArraySourceName(sourceName: string): boolean {
  return /^(?:Float32|Float64|Int16|Int32|Int8|Uint16|Uint32|Uint8|Uint8Clamped)Array$/u.test(sourceName);
}

function isCppRuntimeTypeWithErasedTypeArguments(sourceName: string): boolean {
  // ECMAScript's resizable-buffer declarations parameterize DataView and typed arrays by their
  // backing-buffer carrier. flight-cpp owns that storage internally, so the parameter is type-only
  // evidence and must not be applied to its intentionally non-template public carrier.
  return sourceName === 'DataView' || isCppConcreteTypedArraySourceName(sourceName);
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

function generateAnonymousStructName(
  properties: readonly { readonly name: string }[],
  structuralHash: string,
  context: EmitContext,
): string {
  const base = getCppAnonymousStructBaseName(properties, structuralHash);
  let candidate = base;
  let suffix = 0;
  while (context.generatedNames.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function getCppAnonymousStructBaseName(
  properties: readonly { readonly name: string }[],
  structuralHash: string,
): string {
  const propertyStem = properties.map((property) => snakeCase(property.name)).join('_') || 'anonymous';
  return `${propertyStem}_${structuralHash}`;
}

function getCppAnonymousStructGuard(structuralHash: string, context: EmitContext): string {
  const packageIdentity = context.module.packageName.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase();
  return `FLIGHT_COMPILER_ANONYMOUS_${packageIdentity}_${structuralHash.toUpperCase()}`;
}

function getCppStableIdentifierHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function safeCppName(name: string): string {
  // TypeScript permits bindings made entirely from underscores. Trimming punctuation is useful
  // for ordinary source names, but it must not leave the target-name allocator with an empty C++
  // identifier. Allocation will deterministically suffix multiple fallback names in one scope.
  const snake = snakeCase(name) || 'value';
  return isCppCompilerKeyword(snake) ? `${snake}_` : snake;
}

function safeCppTypeName(name: string): string {
  return pascalCase(name) || 'Type';
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

const cppOptionalArrayMethods = new Set(['find', 'shift', 'pop']);

const cppArraySelfReturningMethods = new Set(['fill', 'reverse', 'sort']);

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
