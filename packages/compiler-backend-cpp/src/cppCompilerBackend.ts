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
  CompilerCppAmbientMemberBinding,
  CompilerCppConditionalFacetReferencePlan,
  CompilerCppReferenceRepresentationPlanner,
  CompilerCppStructuralRowPlan,
  CompilerLoweringPass,
  CompilerModuleResolutionPlan,
  IrResolvedMemberReceiver,
  CppCompilerBackendOptions,
  CppCompilerExternalBindingManifest,
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
import {
  createIrTypeReferenceRepresentationPlannerCpp,
  getCppRuntimeReferenceCategory,
} from './cppReferenceRepresentationPlan.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerExternalBindingCallResultTypeCpp,
  getCompilerExternalBindingConstructionCpp,
  getCompilerExternalBindingEvidenceCpp,
  getCompilerExternalBindingHeadersCpp,
  getCompilerExternalBindingNumericPropertyViewCpp,
  getCompilerExternalBindingObjectConstructionCpp,
  getCompilerExternalBindingWeakKeyPolicyTargetCpp,
  getCompilerRuntimeExternalInstanceMemberCallResultTypeCpp,
  getCompilerRuntimeExternalInstanceMemberParameterTypeCpp,
  getCompilerRuntimeExternalInstanceMemberTargetCpp,
  getCompilerRuntimeExternalMemberCallResultTypeCpp,
  getCompilerRuntimeExternalMemberTargetCpp,
  getCompilerRuntimeExternalSymbolCallResultTypeCpp,
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

interface CppMutuallyRecursiveFunctionGroup {
  readonly declarations: readonly Readonly<IrFunctionDeclaration>[];
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
  readonly erasedValue: 'reference' | 'value';
  readonly key: Readonly<IrType>;
  readonly value: Readonly<IrType>;
}

interface CppNullableErasedRefWeakMapViewPlan {
  readonly backing: Readonly<Extract<IrExpression, { kind: 'property' }>>;
  readonly view: Readonly<CppWeakMapViewPlan>;
}

const cppErasedRefWeakMapViewRuntimeDependency =
  'flight::checked_weak_map_view<Key, Value>(flight::WeakMap<flight::Ref<void>, flight::ErasedRef>&)';

interface CppStructuralCloneRecordViewPlan {
  readonly row: Readonly<CompilerCppStructuralRowPlan>;
  readonly source: Readonly<IrExpression>;
  readonly sourceType: Readonly<IrType>;
  readonly typeParameter: Readonly<IrType>;
}

interface CppStructuralOpenRowConstructionField {
  readonly member: Readonly<Extract<IrObjectMember, { kind: 'computedProperty' | 'property' }>>;
  readonly property: Readonly<IrObjectTypeProperty>;
}

interface CppStructuralOpenRowConstructionPlan {
  readonly fields: readonly CppStructuralOpenRowConstructionField[];
}

interface CppDenseArraySequentialAppendPlan {
  readonly indexBindingId: string;
  readonly offsets: ReadonlySet<number>;
}

interface CppStructuralClosedRowSpreadConstructionPlan {
  readonly fields: readonly Readonly<
    | {
        kind: 'property';
        member: Readonly<Extract<IrObjectMember, { kind: 'property' }>>;
        property: Readonly<IrObjectTypeProperty>;
      }
    | {
        kind: 'overriddenSpread';
        member: Readonly<Extract<IrObjectMember, { kind: 'property' }>>;
        property: Readonly<IrObjectTypeProperty>;
        sourceProperty: Readonly<IrObjectTypeProperty>;
      }
    | { kind: 'spread'; property: Readonly<IrObjectTypeProperty> }
  >[];
  readonly source: Readonly<IrExpression>;
  readonly sourceKind: 'reference' | 'structuralRow';
  readonly sourceMayBeAbsent: boolean;
  readonly sourceType: Readonly<IrType>;
}

type CppDirectBindingOwner = Readonly<{ declaration: IrDeclaration; module: IrModule }>;
type CppImportBindingOwner = Readonly<{ imported: string; module: IrModule; specifier: string }>;
type CppTypeDeclarationOwner = Readonly<{
  declaration: Extract<IrDeclaration, { kind: 'class' | 'enum' | 'interface' | 'typeAlias' }>;
  module: IrModule;
}>;
type CppValueBindingOwner = Readonly<{
  binding: IrBindingIdentity | IrTypeBindingIdentity;
  module: IrModule;
}>;

interface EmitContext {
  activeDependentCallablePackIds: ReadonlySet<string>;
  anonymousStructs: Map<string, AnonymousStruct>;
  anonymousStructTypeParameters: readonly IrTypeParameter[];
  arrayElementBindingIds: ReadonlySet<string>;
  async?: boolean | undefined;
  bindingClasses: ReadonlyMap<string, Readonly<IrClassDeclaration>>;
  bindingInitializers: ReadonlyMap<string, Readonly<IrExpression>>;
  contextualBindingStorageTargetTypes: Map<string, Readonly<IrType>>;
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  // Every type parameter the module declares, by binding identity, wherever it is declared. An index
  // rather than a lookup at the use site because the constraint is what proves a dependent member read,
  // and the parameter being read belongs to a declaration that may be nowhere near the read.
  typeParameterConstraints: ReadonlyMap<string, Readonly<IrType>>;
  currentClass?: Readonly<IrClassDeclaration> | undefined;
  // The declaration being emitted, so a refusal can name where in the module it is. A backend emits
  // whole declarations and a refusal names one of them; without this a refused module is a message
  // with no position at all, and 649 of them are otherwise indistinguishable.
  currentOrigin?: Readonly<{ column: number; line: number }> | undefined;
  expandAliasesForEarlyPublication?: boolean | undefined;
  earlyPublicationResolvingAliases?: ReadonlySet<string> | undefined;
  // Opening an imported alias can expose anonymous alternatives that are defined by another
  // module. Their resolved declaration owners, rather than their generated spellings, decide
  // whether the alias can appear before that module's header.
  earlyPublicationMaterializedOwners?: Set<string> | undefined;
  capturedReferentOnlyBindingIds: ReadonlySet<string>;
  defaultedParameterIds: ReadonlySet<string>;
  denseArrayLengthBindingIds: ReadonlySet<string>;
  denseArraySequentialAppendPlans: ReadonlyMap<string, Readonly<CppDenseArraySequentialAppendPlan>>;
  dependentCallablePacks: ReadonlyMap<string, Readonly<IrParameter>>;
  exceptionPointerBindingIds: ReadonlySet<string>;
  directBindingOwners: ReadonlyMap<string, CppDirectBindingOwner | null>;
  // The bindings whose declaration elected the erased dynamic value as its storage. A presence test
  // asks this rather than the declared type, because the two disagree in both directions and each
  // direction is a shape the SDK writes.
  erasedDynamicStorageBindingIds: ReadonlySet<string>;
  // A bare `object` parameter normally carries identity only, which is the ABI used by WeakMap
  // keys and attached Record views. Parameters in this set cross a storage boundary that later
  // recovers their concrete type, so they must retain the type tag carried by `ErasedRef`.
  erasedObjectParameterBindingIds: ReadonlySet<string>;
  externalBindingStorageTargetTypes: ReadonlyMap<string, string>;
  // C++ default arguments belong on the prototype or the definition, never both.
  forwardDeclaredFunctionBindingIds: ReadonlySet<string>;
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
  // `Object.entries` physically returns std::tuple rows even when both slots have the same type.
  // Keep that runtime representation attached to immutable array storage, callback parameters, and
  // destructuring bindings, since the ordinary homogeneous TypeScript tuple is a flight::Array.
  objectEntriesTupleArrayBindingIds: Set<string>;
  objectEntriesTupleBindingIds: Set<string>;
  optionalParameterBindingIds: ReadonlySet<string>;
  structuralCloneRecordBindingIds: ReadonlySet<string>;
  structuralOpenRowConstructionAssignments: ReadonlyMap<
    Readonly<Extract<IrExpression, { kind: 'object' }>>,
    ReadonlySet<string>
  >;
  targetNameMaps: ReadonlyMap<string, ReadonlyMap<string, string>>;
  targetNames: ReadonlyMap<string, string>;
  uninitializedCaptureStorageBindingIds: ReadonlySet<string>;
  generatedNames: Set<string>;
  // Anonymous structural type naming, shared by every module of one emission so a shape names the
  // same type wherever it is written. See `generateAnonymousStructName`.
  anonymousStructNaming: AnonymousStructNaming;
  // Every union arm in the emission, keyed by the identity it holds: the declaration its nominal
  // member names, plus the structure of the rest of it. Built once, on the first emission, and shared
  // by every module, because the question it answers -- is this intersection an arm some module
  // already declares -- is about the whole program rather than about one module.
  unionArmIdentities: Map<string, CppUnionArmIdentity[]>;
  enclosingReturnType?: Readonly<IrType> | undefined;
}

// Anonymous structural type naming, held across the modules of one emission rather than per module.
//
// One structural shape is one C++ type, so every module that writes it must spell it the same way, and
// a per-module allocator cannot promise that. It could not before: the name was resolved against the
// module's own `generatedNames`, which a probe emission into a throwaway context also feeds, so the
// same shape could come out `kind_<hash>` in one module and `kind_<hash>_1` in another. Both were then
// emitted under a guard derived from the hash alone, so including the first suppressed the second and
// the second's uses had no definition at all.
//
// The taken set is seeded from the package-wide declared names, which every module sees identically,
// and each resolved name is memoized, so the second module reaches the first module's answer.
interface AnonymousStructNaming {
  readonly names: Map<string, string>;
  readonly taken: Set<string>;
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
      const anonymousStructNaming = createCppAnonymousStructNaming(targetNameMaps);
      const unionArmIdentities = new Map<string, CppUnionArmIdentity[]>();
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
              anonymousStructNaming,
              unionArmIdentities,
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
  anonymousStructNaming?: AnonymousStructNaming | undefined,
  unionArmIdentities?: Map<string, CppUnionArmIdentity[]> | undefined,
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
      throw createBackendEmissionFailure('cpp', sourceModule, error.message, 'cpp-lowering-pass-refused');
    }
    throw error;
  }
  assertRuntimeExternalSymbolBindingsCpp(module, options);
  const resolvedTargetNameMaps = targetNameMaps ?? createCppTargetNameMaps(sourceModules);
  let targetNames: Map<string, string>;
  try {
    targetNames = new Map(resolvedTargetNameMaps.get(getCppModuleIdentityKey(module)) ?? []);
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
        'cpp-fixed-target-name-collision',
      );
    }
    throw error;
  }
  const bindingTypes = collectIrModuleBindingTypesCpp(module);
  const externalBindingStorageTargetTypes = new Map<string, string>();
  const typeParameterConstraints = collectCppTypeParameterConstraintsCpp(module);
  const closureCapturePlan = createIrModuleClosureCapturePlanCpp(module);
  const capturedReferentOnlyBindingIds = new Set<string>();
  const declarationDependencies = collectIrModuleDeclarationDependenciesCpp(module);
  const recursiveTypeAliasBindingIds = collectCppRecursiveTypeAliasBindingIds(module, declarationDependencies);
  const mutuallyRecursiveFunctionGroups = collectCppMutuallyRecursiveFunctionGroups(module, declarationDependencies);
  const forwardDeclaredFunctionBindingIds = new Set(
    mutuallyRecursiveFunctionGroups.flatMap((group) => group.declarations.map((declaration) => declaration.binding.id)),
  );
  const sharedCaptureTargetNames = new Map<string, string>();
  const contextualBindingStorageTargetTypes = new Map<string, Readonly<IrType>>();
  const nullableBindingIds = new Set(collectIrModuleNullableBindingIds(module));
  const uninitializedCaptureStorageBindingIds = collectIrModuleUninitializedBindingIdsCpp(module);
  const preservedInitializerTypes = collectCppExplicitCollectionConstructionBindingTypesCpp(module);
  const structuralCastBindingRows = new Map<string, Readonly<CompilerCppStructuralRowPlan>>();
  const structuralCloneRecordBindingIds = new Set<string>();
  const erasedDynamicStorageBindingIds = new Set<string>();
  const erasedObjectParameterBindingIds = new Set<string>();
  const arrayElementBindingIds = new Set<string>();
  const denseArrayLengthBindingIds = collectIrModuleDenseArrayLengthBindingIdsCpp(sourceModule);
  const denseArraySequentialAppendPlans = new Map(
    [...collectIrModuleDenseArraySequentialAppendPlansCpp(sourceModule)].filter(
      ([bindingId]) => !denseArrayLengthBindingIds.has(bindingId),
    ),
  );
  const context: EmitContext = {
    activeDependentCallablePackIds: new Set(),
    anonymousStructs: new Map(),
    anonymousStructTypeParameters: [],
    arrayElementBindingIds,
    bindingClasses: collectIrModuleBindingClassesCpp(module, bindingTypes),
    bindingInitializers: collectIrModuleBindingInitializersCpp(module),
    bindingTypes,
    capturedReferentOnlyBindingIds,
    contextualBindingStorageTargetTypes,
    defaultedParameterIds: new Set(),
    denseArrayLengthBindingIds: new Set([...denseArrayLengthBindingIds, ...denseArraySequentialAppendPlans.keys()]),
    denseArraySequentialAppendPlans,
    dependentCallablePacks: collectIrModuleDependentCallablePacksCpp(module),
    directBindingOwners: directBindingOwners ?? createCppDirectBindingOwners(sourceModules),
    erasedDynamicStorageBindingIds,
    erasedObjectParameterBindingIds,
    exceptionPointerBindingIds: collectCppExceptionPointerBindingIdsCpp(module, bindingTypes),
    externalBindingStorageTargetTypes,
    forwardDeclaredFunctionBindingIds,
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
    objectEntriesTupleArrayBindingIds: new Set(),
    objectEntriesTupleBindingIds: new Set(),
    optionalParameterBindingIds: collectCppOptionalParameterBindingIds(module),
    structuralCloneRecordBindingIds,
    structuralOpenRowConstructionAssignments: collectCppStructuralOpenRowConstructionAssignmentsCpp(module),
    targetNameMaps: resolvedTargetNameMaps,
    targetNames,
    typeParameterConstraints,
    uninitializedCaptureStorageBindingIds,
    generatedNames: new Set(targetNames.values()),
    anonymousStructNaming: anonymousStructNaming ?? createCppAnonymousStructNaming(resolvedTargetNameMaps),
    unionArmIdentities: unionArmIdentities ?? new Map(),
  };
  for (const [bindingId, targetType] of collectCppExternalBindingStorageTargetTypesCpp(module, context)) {
    externalBindingStorageTargetTypes.set(bindingId, targetType);
  }
  for (const bindingId of collectIrModuleArrayElementBindingIdsCpp(module, context)) {
    arrayElementBindingIds.add(bindingId);
  }
  for (const [bindingId, targetType] of collectCppContextualBindingStorageTargetTypesCpp(module, context)) {
    contextualBindingStorageTargetTypes.set(bindingId, targetType);
  }
  for (const [bindingId, row] of collectCppStructuralCastBindingRowsCpp(
    module,
    context,
    structuralCloneRecordBindingIds,
  )) {
    structuralCastBindingRows.set(bindingId, row);
  }
  for (const bindingId of collectCppErasedObjectParameterBindingIds(module, context)) {
    erasedObjectParameterBindingIds.add(bindingId);
  }
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      if (hasCppErasedDynamicStorageCpp({ binding: parameter.binding, mutable: true, type: parameter.type }, context)) {
        erasedDynamicStorageBindingIds.add(parameter.binding.id);
      }
    },
    variable(variable) {
      if ('binding' in variable && hasCppErasedDynamicStorageCpp(variable, context)) {
        erasedDynamicStorageBindingIds.add(variable.binding.id);
      }
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
    if (
      bindingType &&
      bindingPlan.reasons.includes('capturedReferentMutation') &&
      !bindingPlan.reasons.some((reason) =>
        ['capturedBindingMutation', 'capturedMutableBinding', 'outsideMutation'].includes(reason),
      ) &&
      hasSharedReferentRepresentationCpp(bindingType, context)
    ) {
      capturedReferentOnlyBindingIds.add(bindingPlan.binding.id);
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
  const declarations = orderIrModuleDeclarationsCpp(
    module,
    recursiveTypeAliasBindingIds,
    mutuallyRecursiveFunctionGroups,
    declarationDependencies,
  )
    .filter((declaration) => declaration.kind !== 'function' || !declaration.namespaceMember)
    .map((declaration) => {
      const existingAnonymousStructs = new Set(context.anonymousStructs.keys());
      const earlyPublicationMaterializedOwners = new Set<string>();
      const lines = emitDeclaration(declaration, {
        ...context,
        currentOrigin: { column: declaration.origin.column, line: declaration.origin.line },
        earlyPublicationMaterializedOwners,
      });
      const anonymousStructs = [...context.anonymousStructs]
        .filter(([key]) => !existingAnonymousStructs.has(key))
        .map(([, struct]) => struct);
      const anonymousStructLines = anonymousStructs.flatMap((struct) => [
        '',
        ...emitAnonymousStructCpp(struct, context),
      ]);
      return { anonymousStructLines, declaration, earlyPublicationMaterializedOwners, lines };
    });
  const mutuallyRecursiveFunctionForwardDeclarations = emitCppMutuallyRecursiveFunctionForwardDeclarations(
    mutuallyRecursiveFunctionGroups,
    declarations,
    context,
  );
  // Emitted before the include list is read: a forward declaration spells a default type argument
  // out, and that names a type whose module has to be included. Collected any later and the include
  // is dropped on the floor while the declaration that needed it is still emitted.
  const forwardDeclarations = emitCppForwardDeclarations(module, context);
  const imports = emitImports(module, context);
  const importedFunctionForwardDeclarations = emitCppImportedFunctionForwardDeclarations(context);
  const reexports = emitReexportsCpp(module, context);
  const namespaceName = getCppCompilerPackageNamespace(module.packageName, options.packageTargets);
  const importedForwardDeclarations = emitCppImportedForwardDeclarations(context);
  const earlyPublication =
    imports.length > 0
      ? planCppEarlyPublicationCpp(declarations, forwardDeclarations, importedForwardDeclarations, context)
      : { bindingIds: new Set<string>(), lines: [] };
  const earlyLines =
    imports.length > 0
      ? [
          ...forwardDeclarations,
          ...collectCppMaterializedTypeForwardDeclarationsCpp(declarations),
          ...earlyPublication.lines,
        ]
      : [];
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
  // Only a module include can close a cycle, so a module that includes none keeps its usual layout
  // and publishes nothing early.
  // The early region declares what a cyclic consumer may name, so it precedes this module's
  // includes. It follows the imported forward declarations because a published alias may name
  // another module's type, and only those declarations make it nameable this early.
  if (importedForwardDeclarations.length > 0) lines.push('', ...importedForwardDeclarations);
  if (earlyLines.length > 0) {
    lines.push('', `namespace ${namespaceName} {`, ...earlyLines, `} // namespace ${namespaceName}`);
  }
  if (imports.length > 0) lines.push('', ...imports);
  if (importedFunctionForwardDeclarations.length > 0) {
    lines.push('', ...importedFunctionForwardDeclarations);
  }
  lines.push('', `namespace ${namespaceName} {`);
  if (earlyLines.length === 0 && forwardDeclarations.length > 0) lines.push('', ...forwardDeclarations);
  if (reexports.length > 0) lines.push('', ...reexports);
  declarations.forEach((declaration) => {
    if (
      declaration.declaration.kind === 'typeAlias' &&
      earlyPublication.bindingIds.has(declaration.declaration.binding.id)
    ) {
      return;
    }
    const recursiveForwardDeclarations =
      declaration.declaration.kind === 'function'
        ? mutuallyRecursiveFunctionForwardDeclarations.get(declaration.declaration.binding.id)
        : undefined;
    if (recursiveForwardDeclarations) lines.push(...recursiveForwardDeclarations);
    if (
      declaration.declaration.kind !== 'function' ||
      !forwardDeclaredFunctionBindingIds.has(declaration.declaration.binding.id)
    ) {
      lines.push(...declaration.anonymousStructLines);
    }
    lines.push('', ...declaration.lines);
  });
  lines.push('', `} // namespace ${namespaceName}`);
  const contents = lines.join('\n');
  if (getCppRuntimeProfile(options) === 'flight-cpp') {
    // This guard reads the assembled module, so it cannot say which declaration left the placeholder
    // in it. Carrying the last declaration's position here would name an innocent one.
    assertCppOutputHasNoUnresolvedTypePlaceholder(contents, { ...context, currentOrigin: undefined });
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
    emissionError(
      context,
      `flight-cpp type position retains unresolved auto placeholder: ${invalid.trim()}`,
      'cpp-unresolved-type-placeholder',
    );
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

// A cyclically including consumer is processed while this header is still above its own namespace
// body, so anything it can name must already be declared when this module's includes are read. The
// decision is made over the WHOLE planned module — anonymous structural objects are materialized
// during planning, not discovered while emitting — because whether a name is available early depends
// on what the rest of the module turns out to declare. A name is available early only when this
// header forward-declares it, or when an alias already published in the same region introduces it.
// An alias reaching anything else, including an anonymous struct defined in the body, stays where it
// is: publishing it would place a use above its definition, which fails silently at the C++ compiler
// rather than refusing here.
function planCppEarlyPublicationCpp(
  declarations: readonly Readonly<{
    anonymousStructLines: readonly string[];
    declaration: Readonly<IrDeclaration>;
    earlyPublicationMaterializedOwners: ReadonlySet<string>;
    lines: readonly string[];
  }>[],
  forwardDeclarations: readonly string[],
  importedForwardDeclarations: readonly string[],
  context: EmitContext,
): Readonly<{ bindingIds: ReadonlySet<string>; lines: readonly string[] }> {
  const declaredNames = new Set<string>();
  for (const text of [
    ...declarations.flatMap((entry) => [...entry.anonymousStructLines, ...entry.lines]),
    ...forwardDeclarations,
  ]) {
    for (const match of text.matchAll(/(?:^|\s)(?:class|struct|using)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) {
      declaredNames.add(match[1]!);
    }
  }
  const forwardDeclaredNames = new Set<string>();
  for (const line of [...forwardDeclarations, ...importedForwardDeclarations]) {
    for (const match of line.matchAll(/struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gu)) forwardDeclaredNames.add(match[1]!);
  }
  const importedAliasNames = new Set<string>();
  for (const importItem of context.module.imports) {
    for (const binding of importItem.bindings) {
      if (binding.imported === '*') continue;
      const reference: Extract<IrType, { kind: 'named' }> = {
        kind: 'named',
        reference: { binding: binding.binding, kind: 'binding', path: [] },
        typeArguments: [],
      };
      if (getCppImportedBindingDeclarationCpp(reference, context)?.declaration.kind !== 'typeAlias') continue;
      const target = getCppImportedBindingTargetName(binding.binding.id, [], 'type', context);
      const name = target?.split('::').at(-1);
      if (name) importedAliasNames.add(name);
    }
  }
  const candidates = declarations.filter(
    (entry) => entry.declaration.kind === 'typeAlias' && entry.declaration.exported,
  );
  const publishedNames = new Set<string>();
  const published = new Map<string, readonly string[]>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const entry of candidates) {
      if (entry.declaration.kind !== 'typeAlias') continue;
      const bindingId = entry.declaration.binding.id;
      if (published.has(bindingId)) continue;
      // An alias whose emitted form defines a struct carries its members' dependencies with it, and a
      // member is expanded from the type it was built on rather than named by the source — so the
      // module may reach a type it never imports and the IR never mentions. Those names cannot be
      // read from the IR, so they are checked in the emitted member text, where the distinguishing
      // signal is that runtime types arrive qualified while the ones that go wrong arrive bare.
      if (
        [...entry.lines, ...entry.anonymousStructLines].some((line) =>
          /^\s*(?:template <[^>]*>\s*)?(?:class|struct)\s+[A-Za-z_][A-Za-z0-9_]*\s*(?::|\{)/u.test(line),
        )
      ) {
        const members = [...entry.lines, ...entry.anonymousStructLines].join('\n');
        const unordered = [...members.matchAll(/[<,]\s*((?:[A-Za-z_][A-Za-z0-9_]*::)*)([A-Za-z_][A-Za-z0-9_]*)/gu)]
          // A single qualifier segment names the runtime, whose headers precede the early region. A
          // package-qualified name is another module's type and must be declared here; a bare one may
          // name this module's type, so it must be declared here too.
          .filter((match) => (match[1]!.match(/::/gu) ?? []).length !== 1)
          .map((match) => match[2]!)
          .some(
            (name) => !cppPrimitiveTypeNames.has(name) && !forwardDeclaredNames.has(name) && !publishedNames.has(name),
          );
        if (unordered) continue;
      }
      const ownName = getBindingTargetName(entry.declaration.binding, context);
      const isUnschedulable = (lines: readonly string[], materializedOwners?: ReadonlySet<string>): boolean => {
        if (materializedOwners && materializedOwners.size > 0) return true;
        const text = lines.join('\n');
        return [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu)].some((match) => {
          const name = match[1]!;
          if (name === ownName) return false;
          // Another module's nominal type is nameable here only through this header's forward
          // declaration. An imported alias has no such declaration in C++, so it remains blocked
          // until the alias-expansion retry below. Names outside these planned sets belong to the
          // standard/runtime headers that already precede the early region.
          if (!declaredNames.has(name) && !forwardDeclaredNames.has(name) && !importedAliasNames.has(name)) {
            return false;
          }
          if (importedAliasNames.has(name)) return true;
          if (!forwardDeclaredNames.has(name) && !publishedNames.has(name)) return true;
          // A forward declaration makes a name usable, not complete. Only a reference-like wrapper
          // stays complete for an incomplete argument, so a scheduled type reached any other way —
          // bare, or under a value container such as optional, variant, tuple, or array — would be
          // used where its definition is required, and cannot be published.
          return !isCppReferenceLikeTypeArgumentCpp(text, match.index);
        });
      };
      let publicationLines = entry.lines;
      if (isUnschedulable(publicationLines, entry.earlyPublicationMaterializedOwners)) {
        const expanded = emitCppExpandedEarlyPublicationAliasCpp(entry.declaration, entry.lines, context);
        if (!expanded || isUnschedulable(expanded)) continue;
        publicationLines = expanded;
      }
      published.set(bindingId, publicationLines);
      publishedNames.add(ownName);
      progressed = true;
    }
  }
  return {
    bindingIds: new Set(published.keys()),
    lines: candidates.flatMap((entry) =>
      entry.declaration.kind === 'typeAlias' ? (published.get(entry.declaration.binding.id) ?? []) : [],
    ),
  };
}

// An imported alias cannot be forward-declared. If an exported alias's emitted representation reaches
// one, open the alias chain and try the early declaration again. This includes a local alias which the
// ordinary type emitter already opens on the way to that imported dependency; ambient utilities keep
// their normal target lowering because they have no declaration to open. This turns
// `Readonly<NodeAny>` into its reference row over a forward-declared `Node`, which is safe to publish,
// without flattening every named type in the module.
function emitCppExpandedEarlyPublicationAliasCpp(
  declaration: Readonly<IrTypeAliasDeclaration>,
  emittedLines: readonly string[],
  outer: EmitContext,
): readonly string[] | undefined {
  const name = getBindingTargetName(declaration.binding, outer);
  if (!emittedLines.some((line) => line.startsWith(`using ${name} = `))) return undefined;
  const anonymousStructs = new Map(outer.anonymousStructs);
  const materializedOwners = new Set<string>();
  const context: EmitContext = {
    ...outer,
    anonymousStructs,
    anonymousStructTypeParameters: mergeIrTypeParametersCpp(
      outer.anonymousStructTypeParameters,
      declaration.typeParameters,
    ),
    earlyPublicationResolvingAliases: new Set(),
    earlyPublicationMaterializedOwners: materializedOwners,
    expandAliasesForEarlyPublication: true,
  };
  const type = emitType(declaration.type, context);
  if (anonymousStructs.size !== outer.anonymousStructs.size || materializedOwners.size > 0) return undefined;
  const typeParameters = emitTypeParameters(declaration.typeParameters, context, true);
  return [...(typeParameters ? [`template ${typeParameters}`] : []), `using ${name} = ${type};`];
}

// A reference-like wrapper stays complete for an incomplete argument, so a type reached through one
// needs only a declaration. Every other position — bare, or under a value container such as optional,
// variant, tuple, or array — requires that the type be defined, which a forward declaration cannot do.
function isCppReferenceLikeTypeArgumentCpp(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const qualifier = /([A-Za-z_][A-Za-z0-9_:]*::)?$/u.exec(before)?.[1] ?? '';
  const enclosing = before.slice(0, before.length - qualifier.length);
  if (!enclosing.endsWith('<')) return false;
  const wrapper = /([A-Za-z_][A-Za-z0-9_:]*)<$/u.exec(enclosing)?.[1]?.replace(/^flight::/u, '');
  return wrapper !== undefined && cppReferenceLikeWrapperNames.has(wrapper);
}

const cppPrimitiveTypeNames = new Set(['bool', 'char', 'double', 'float', 'int', 'long', 'short', 'unsigned', 'void']);

// Two source member names can normalize to one C++ name: `WebGL2RenderingContext` holds both the
// `ACTIVE_TEXTURE` constant and the `activeTexture` method, and both spell `active_texture` here. A
// struct cannot declare one name twice, and every access site resolves through the same spelling, so
// the first declaration owns the member and a later one is that same member said again. The later
// property's TYPE is still emitted before this is asked, so a member with no C++ evidence refuses
// rather than disappearing.
function isCppDuplicateStructMemberCpp(seen: Set<string>, name: string): boolean {
  const targetName = safeCppName(name);
  if (seen.has(targetName)) return true;
  seen.add(targetName);
  return false;
}

// A `void`-typed property is a brand, not storage. `readonly [ButtonControllerTypeKey]?: void` gives
// an interface a nominal identity; there is no value it can hold, and `std::optional<void>` is not a
// type C++ can form. The member is therefore left out of the emitted struct — but only out of the
// struct: the property stays in the declared shape, which is what key projections read, so `Omit`
// over a brand key still removes it. Nothing in generated code can read a value from it, because
// there is none to read.
function isCppValuelessStructMemberCpp(type: Readonly<IrType>): boolean {
  return type.kind === 'primitive' && type.name === 'void';
}

const cppReferenceLikeWrapperNames = new Set([
  'Ref',
  'RowKey',
  'RowMerge',
  'RowOf',
  'RowPartial',
  'RowReadonly',
  'RowWritable',
  'StructuralRef',
]);

// A source alias that materializes to a nominal C++ type is a name a consumer may reach before this
// module's includes, exactly as a class or interface is. `Node2D` is an intersection alias that emits
// a struct definition; the module's own forward declarations skip it because the source spells it
// `type`, so a cyclic consumer finds `Node2DTraits` and `Node2DData` there but not `Node2D` itself.
// What decides the set is that the emitted declaration is a named type, not the source-level kind
// that happened to stand in for that question. Only the NAME is made available early; the definition
// keeps its place, because a definition still has to respect C++ dependency ordering.
function collectCppMaterializedTypeForwardDeclarationsCpp(
  declarations: readonly Readonly<{ declaration: Readonly<IrDeclaration>; lines: readonly string[] }>[],
): string[] {
  const found = new Map<string, string>();
  for (const entry of declarations) {
    if (entry.declaration.kind !== 'typeAlias') continue;
    for (const [index, line] of entry.lines.entries()) {
      const match = /^\s*(?:template <([^>]*)>\s*)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::|\{)/u.exec(line);
      if (!match) continue;
      const name = match[2]!;
      // The template parameter list is emitted on the line ABOVE the definition, so a walk that reads
      // one line at a time loses it and declares the name as a non-template -- contradicting the
      // templated definition in the same header, which the declaration then makes unnameable. Take it
      // from the line above when the definition line does not carry it itself.
      const parameters = match[1] ?? /^\s*template <([^>]*)>\s*$/u.exec(entry.lines[index - 1] ?? '')?.[1];
      found.set(name, `${parameters ? `template <${parameters}> ` : ''}struct ${name};`);
      break;
    }
  }
  return [...found.values()];
}

function getCppInterfaceDeclarationTypeCpp(declaration: Readonly<IrInterfaceDeclaration>): IrType {
  return {
    kind: 'named',
    reference: { binding: declaration.binding, kind: 'binding', path: [] },
    typeArguments: declaration.typeParameters.map((parameter) => ({
      kind: 'named',
      reference: { binding: parameter.binding, kind: 'binding', path: [] },
      typeArguments: [],
    })),
  };
}

function isCppInterfaceRepresentationAliasCpp(
  declaration: Readonly<IrInterfaceDeclaration>,
  module: Readonly<IrModule>,
  context: EmitContext,
): boolean {
  const type = getCppInterfaceDeclarationTypeCpp(declaration);
  return Boolean(
    context.referenceRepresentationPlanner.resolveStructuralRow(type, module) ??
    context.referenceRepresentationPlanner.resolveFacetReference(type, module) ??
    context.referenceRepresentationPlanner.resolveExternalProjection(type, module),
  );
}

function emitCppForwardDeclarations(module: Readonly<IrModule>, context: EmitContext): string[] {
  return module.declarations.flatMap((declaration): string[] => {
    if (declaration.kind !== 'class' && declaration.kind !== 'interface') return [];
    if (
      declaration.kind === 'interface' &&
      getCppRuntimeProfile(context.options) === 'flight-cpp' &&
      isCppInterfaceRepresentationAliasCpp(declaration, context.module, context)
    ) {
      return [];
    }
    const typeParameters = emitTypeParameters(declaration.typeParameters, context, true);
    const declarationLine = `struct ${getBindingTargetName(declaration.binding, context)};`;
    return typeParameters ? [`template ${typeParameters}`, declarationLine] : [declarationLine];
  });
}

// A published declaration can reach a type this module never imports. A member of a published struct
// definition is one way; an alias expanded at emission is another, and it is the one this walk has to
// follow: `NodeOf<Traits>` lowers to `Node<Traits> & NoInfer<Traits>`, so `Node` arrives in the
// emitted text while the module imports only `NodeOf`, and no import could name it. The walk
// therefore follows alias declarations into what they name and recurses through every compound type,
// rather than reading only the references this module's own IR spells out.
function getCppImportedBindingDeclarationCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): Readonly<{ declaration: Readonly<IrDeclaration>; module: Readonly<IrModule> }> | undefined {
  const reference = type.reference;
  if (reference.kind !== 'binding' || reference.binding.kind !== 'import') return undefined;
  const bindingId = reference.binding.id;
  for (const importItem of context.module.imports) {
    const binding = importItem.bindings.find((candidate) => candidate.binding.id === bindingId);
    if (!binding) continue;
    const importedName = binding.imported === '*' ? reference.path[0] : binding.imported;
    if (!importedName) return undefined;
    const matches = getCppResolvedImportModules(importItem.specifier, context).flatMap((targetModule) =>
      targetModule.declarations.flatMap((declaration) => {
        if (!('binding' in declaration) || declaration.binding.name !== importedName) return [];
        if (!hasCppDirectExportName(targetModule, importedName)) return [];
        return [{ declaration, module: targetModule }];
      }),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

function collectCppEarlyForwardDeclarationCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  declarations: Map<string, { namespace: string; declaration: string }>,
  visited: Set<string>,
): void {
  switch (type.kind) {
    case 'array':
      collectCppEarlyForwardDeclarationCpp(type.element, context, declarations, visited);
      return;
    case 'function':
      type.parameters.forEach((parameter) =>
        collectCppEarlyForwardDeclarationCpp(parameter.type, context, declarations, visited),
      );
      collectCppEarlyForwardDeclarationCpp(type.returns, context, declarations, visited);
      return;
    case 'intersection':
    case 'union':
      type.types.forEach((member) => collectCppEarlyForwardDeclarationCpp(member, context, declarations, visited));
      return;
    case 'tuple':
      type.elements.forEach((element) =>
        collectCppEarlyForwardDeclarationCpp(element.type, context, declarations, visited),
      );
      return;
    case 'named':
      break;
    default:
      return;
  }
  // `getCppDirectBindingOwner` deliberately excludes import bindings, and an imported alias is
  // exactly the case this walk exists for, so an import resolves through its own owner index.
  const owner = getCppDirectBindingOwner(type, context) ?? getCppImportedBindingDeclarationCpp(type, context);
  if (owner && getCppModuleIdentityKey(owner.module) !== getCppModuleIdentityKey(context.module)) {
    if (owner.declaration.kind === 'typeAlias') {
      const key = `${getCppModuleIdentityKey(owner.module)}\0${owner.declaration.binding.id}`;
      if (!visited.has(key)) {
        visited.add(key);
        collectCppEarlyForwardDeclarationCpp(owner.declaration.type, context, declarations, visited);
      }
    } else if (
      (owner.declaration.kind === 'class' || owner.declaration.kind === 'interface') &&
      !(
        owner.declaration.kind === 'interface' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        isCppInterfaceRepresentationAliasCpp(owner.declaration, owner.module, context)
      )
    ) {
      const namespace = getCppCompilerPackageNamespace(owner.module.packageName, context.options.packageTargets);
      const targetName =
        context.targetNameMaps.get(getCppModuleIdentityKey(owner.module))?.get(owner.declaration.binding.id) ??
        safeCppTypeName(owner.declaration.binding.name);
      const typeParameters = owner.declaration.typeParameters.map((parameter) =>
        safeCppTypeName(parameter.binding.name),
      );
      const declaration = `${typeParameters.length > 0 ? `template <${typeParameters.map((name) => `typename ${name}`).join(', ')}> ` : ''}struct ${targetName};`;
      declarations.set(`${namespace}\0${declaration}`, { declaration, namespace });
    }
  }
  type.typeArguments.forEach((argument) =>
    collectCppEarlyForwardDeclarationCpp(argument, context, declarations, visited),
  );
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
      // An interface the facet representation elects is emitted as an alias in its own header, so a
      // forward declaration of it here would conflict with that alias. The declaring module already
      // skips these; a consumer declaring them on the module's behalf has to skip them as well.
      if (
        match.declaration.kind === 'interface' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        isCppInterfaceRepresentationAliasCpp(match.declaration, match.targetModule, context)
      ) {
        continue;
      }
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
  // A declaration published above the includes can reach a type this module never imports — a
  // member of a published struct definition, say — and the source names no module that owns it. So
  // the set is not the import list alone: every reference the module's own types make is considered
  // too, which is what lets such a declaration have its types declared this early.
  analyzeIrModuleTraversal(context.module, {
    type(type) {
      collectCppEarlyForwardDeclarationCpp(type, context, declarations, new Set());
    },
  });
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

function emitCppMutuallyRecursiveFunctionForwardDeclaration(
  declaration: Readonly<IrFunctionDeclaration>,
  outer: EmitContext,
): string[] {
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
    currentOrigin: { column: declaration.origin.column, line: declaration.origin.line },
    defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.parameters),
    enclosingReturnType: declaration.returns,
    namespaceScope: false,
    returnsAbsent: hasIrTypeAbsentMember(declaration.returns),
  };
  const template = emitCppFunctionTemplate(declaration.typeParameters, declaration.parameters, context);
  const parameters = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const lines: string[] = [];
  if (template.parameters) lines.push(`template ${template.parameters}`);
  if (template.requirement) lines.push(`  requires ${template.requirement}`);
  lines.push(
    `inline ${emitType(declaration.returns, context)} ${getBindingTargetName(declaration.binding, context)}(${parameters});`,
  );
  return lines;
}

function emitCppMutuallyRecursiveFunctionForwardDeclarations(
  groups: readonly Readonly<CppMutuallyRecursiveFunctionGroup>[],
  declarations: readonly Readonly<{
    anonymousStructLines: readonly string[];
    declaration: Readonly<IrDeclaration>;
    lines: readonly string[];
  }>[],
  context: EmitContext,
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const group of groups) {
    const bindingIds = new Set(group.declarations.map((declaration) => declaration.binding.id));
    const entries = declarations.filter(
      (entry) => entry.declaration.kind === 'function' && bindingIds.has(entry.declaration.binding.id),
    );
    const first = entries[0];
    if (!first || first.declaration.kind !== 'function') continue;
    result.set(first.declaration.binding.id, [
      ...entries.flatMap((entry) => entry.anonymousStructLines),
      '',
      ...entries.flatMap((entry) =>
        entry.declaration.kind === 'function'
          ? [...emitCppMutuallyRecursiveFunctionForwardDeclaration(entry.declaration, context), '']
          : [],
      ),
    ]);
  }
  return result;
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
  const type = parameter.type
    ? getCppRuntimeProfile(context.options) === 'flight-cpp' &&
      isCppBareObjectTypeCpp(parameter.type) &&
      !context.erasedObjectParameterBindingIds.has(parameter.binding.id)
      ? 'flight::Ref<void>'
      : emitCppParameterTypeCpp(parameter.type, parameter.rest, context)
    : 'auto';
  if (parameter.optional) {
    context.includes.add('optional');
    return `std::optional<${type}> ${name}`;
  }
  return `${type} ${name}`;
}

function emitCppStdTupleTypeCpp(type: Readonly<Extract<IrType, { kind: 'tuple' }>>, context: EmitContext): string {
  context.includes.add('tuple');
  const elements = type.elements.map((element) => {
    const emitted = emitType(element.type, context);
    if (!element.optional) return emitted;
    context.includes.add('optional');
    return `std::optional<${emitted}>`;
  });
  return `std::tuple<${elements.join(', ')}>`;
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
    const fieldType = emitCppObjectPropertyStorageCpp(
      field,
      emitOptionalTypeCpp(emitType(field.type, context), field.optional, context),
      context,
    ).type;
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
      emissionError(
        context,
        `string enum ${declaration.binding.name} value namespace requires wrapper lowering`,
        'cpp-string-enum-value-namespace-wrapper',
      );
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
  // A mutually recursive group publishes its defaults on the prototypes that make the cycle
  // callable. Repeating either parameter or template defaults on the definitions is ill-formed C++.
  const includeDefaults = !context.forwardDeclaredFunctionBindingIds.has(declaration.binding.id);
  const returnType = emitType(declaration.returns, context);
  const template = emitCppFunctionTemplate(
    declaration.typeParameters,
    declaration.parameters,
    context,
    includeDefaults,
  );
  const params = declaration.parameters
    .map((parameter) => emitParameter(parameter, context, includeDefaults))
    .join(', ');
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
  const interfaceType = getCppInterfaceDeclarationTypeCpp(declaration);
  const structuralRow = context.referenceRepresentationPlanner.resolveStructuralRow(interfaceType, context.module);
  if (structuralRow && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(`using ${name} = ${emitCppStructuralRowReferenceTypeCpp(structuralRow, context)};`);
    return lines;
  }
  const externalProjection = context.referenceRepresentationPlanner.resolveExternalProjection(
    interfaceType,
    context.module,
  );
  if (externalProjection && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    return [`using ${name} = ${emitType(externalProjection, context)};`];
  }
  const facet = context.referenceRepresentationPlanner.resolveFacetReference(interfaceType, context.module);
  if (facet && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    if (declaration.typeParameters.length > 0) {
      emissionError(
        context,
        `facet interface ${declaration.binding.name} must be nongeneric`,
        'cpp-facet-interface-generic',
      );
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
  const emittedMemberNames = new Set<string>();
  for (const property of declaration.properties) {
    if (isCppValuelessStructMemberCpp(property.type)) continue;
    const propType = emitCppObjectPropertyStorageCpp(
      property,
      emitOptionalTypeCpp(emitType(property.type, context), property.optional, context),
      context,
    ).type;
    if (isCppDuplicateStructMemberCpp(emittedMemberNames, property.name)) continue;
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
  const nominalIdentity =
    declaration.type.kind === 'intersection' && getCppRuntimeProfile(context.options) === 'flight-cpp'
      ? getCppRedundantNominalIntersectionIdentityCpp(declaration.type, context)
      : undefined;
  if (nominalIdentity) {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context, true);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(`using ${name} = ${emitType(nominalIdentity, context)};`);
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
    const emittedMemberNames = new Set<string>();
    for (const property of objectProperties) {
      if (isCppValuelessStructMemberCpp(property.type)) continue;
      const propertyType = emitCppObjectPropertyStorageCpp(
        property,
        emitOptionalTypeCpp(emitType(property.type, context), property.optional, context),
        context,
      ).type;
      if (isCppDuplicateStructMemberCpp(emittedMemberNames, property.name)) continue;
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

// A `const` whose recorded type is unconstrained still has a type at this point: its initializer's.
// The emitted C++ deduces it, and deduction is never wider than the erased value, so a const with an
// initializer keeps `auto` rather than erasing a type the initializer already states — `const rows =
// grid.length` is a `double`, not a value of no stated type. A mutable binding does not, because it
// can be reassigned to a different alternative and the erased value is the only storage that accepts
// both. This is deliberately narrower than the `unknown` arm of `emitType`, which serves the positions
// that have no initializer to deduce from: fields, parameters, and type aliases.
function isCppDeducibleUnknownStorageCpp(
  mutable: boolean,
  initializer: Readonly<IrExpression> | undefined,
  type: Readonly<IrType> | undefined,
): boolean {
  return !mutable && initializer !== undefined && type?.kind === 'unknown';
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  if (!declaration.type && !declaration.initializer) {
    emissionError(
      context,
      `uninitialized variable ${declaration.binding.name} requires inferred type evidence`,
      'cpp-uninitialized-variable-missing-type-evidence',
    );
  }
  const name = getBindingTargetName(declaration.binding, context);
  const arrayElement = context.arrayElementBindingIds.has(declaration.binding.id);
  const externalStorageTarget = context.externalBindingStorageTargetTypes.get(declaration.binding.id);
  const contextualStorageTarget = context.contextualBindingStorageTargetTypes.get(declaration.binding.id);
  const preservedInitializerType = context.preservedInitializerTypes.get(declaration.binding.id);
  const structuralCastRow = context.structuralCastBindingRows.get(declaration.binding.id);
  const exceptionPointer = context.exceptionPointerBindingIds.has(declaration.binding.id);
  if (exceptionPointer) context.includes.add('exception');
  const type =
    (exceptionPointer ? 'std::exception_ptr' : undefined) ??
    getCppNamedPropertiesStorageTypeCpp(declaration.initializer, context) ??
    (externalStorageTarget
      ? emitCppExternalBindingStorageTypeCpp(declaration.type, externalStorageTarget, context)
      : contextualStorageTarget
        ? emitType(contextualStorageTarget, context)
        : preservedInitializerType
          ? emitType(preservedInitializerType, context)
          : structuralCastRow
            ? emitCppStructuralRowReferenceTypeCpp(structuralCastRow, context)
            : declaration.type &&
                !isCppDeducibleUnknownStorageCpp(declaration.mutable, declaration.initializer, declaration.type)
              ? emitType(declaration.type, context)
              : 'auto');
  // An `auto` storage cannot be wrapped: `std::optional<auto>` is not a type, and a module that
  // emitted one never compiled. Skipping the wrap therefore cannot regress a working shape, and an
  // element whose type is still unspecified is better spelled by deduction than by a wrapper that has
  // nothing to wrap.
  const emittedType = arrayElement && type !== 'auto' ? emitOptionalTypeCpp(type, true, context) : type;
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
    emissionError(
      context,
      `uninitialized variable ${variable.binding.name} requires inferred type evidence`,
      'cpp-uninitialized-variable-missing-type-evidence',
    );
  }
  const name = getBindingTargetName(variable.binding, context);
  const arrayElement = context.arrayElementBindingIds.has(variable.binding.id);
  const weakMapViewInitializer =
    !variable.mutable && variable.initializer?.kind === 'cast' ? variable.initializer : undefined;
  const weakMapViewPlan = weakMapViewInitializer ? getCppWeakMapViewPlan(weakMapViewInitializer, context) : undefined;
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
  const invariantCollectionInitializerType =
    !arrayElement && !variable.mutable && variable.type && variable.initializer?.kind === 'call'
      ? getCppRuntimeCollectionResultRefinementCpp(variable.initializer, variable.type, context)
      : undefined;
  const preservedInitializerType = arrayElement
    ? undefined
    : (context.preservedInitializerTypes.get(variable.binding.id) ??
      invariantCollectionInitializerType ??
      getCppStructurallyEquivalentInitializerTypeCpp(variable, context) ??
      (inferredInitializerType?.kind === 'unknown' ? undefined : inferredInitializerType));
  if (preservedInitializerType) {
    context.preservedInitializerTypes.set(variable.binding.id, preservedInitializerType);
  }
  if (
    !variable.mutable &&
    variable.initializer &&
    isCppObjectEntriesTupleArrayExpressionCpp(variable.initializer, context)
  ) {
    context.objectEntriesTupleArrayBindingIds.add(variable.binding.id);
  }
  const externalStorageTarget = context.externalBindingStorageTargetTypes.get(variable.binding.id);
  const contextualStorageTarget = context.contextualBindingStorageTargetTypes.get(variable.binding.id);
  const structuralCastRow = context.structuralCastBindingRows.get(variable.binding.id);
  const denseArraySequentialAppendPlan = context.denseArraySequentialAppendPlans.get(variable.binding.id);
  const exceptionPointer = context.exceptionPointerBindingIds.has(variable.binding.id);
  if (exceptionPointer) context.includes.add('exception');
  const type =
    (exceptionPointer ? 'std::exception_ptr' : undefined) ??
    getCppNamedPropertiesStorageTypeCpp(variable.initializer, context) ??
    (externalStorageTarget
      ? emitCppExternalBindingStorageTypeCpp(variable.type, externalStorageTarget, context)
      : contextualStorageTarget
        ? emitType(contextualStorageTarget, context)
        : structuralCastRow
          ? emitCppStructuralRowReferenceTypeCpp(structuralCastRow, context)
          : weakMapViewPlan ||
              !variable.type ||
              preservedInitializerType ||
              isCppDeducibleUnknownStorageCpp(variable.mutable, variable.initializer, variable.type)
            ? 'auto'
            : emitType(variable.type, context));
  const emittedType = arrayElement && type !== 'auto' ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(variable.mutable, variable.type);
  const initializerValue = variable.initializer
    ? weakMapViewPlan && weakMapViewInitializer
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
    : undefined;
  const initializer = initializerValue
    ? ` = ${
        denseArraySequentialAppendPlan
          ? emitCppDenseArraySequentialAppendConstructionCpp(initializerValue, context)
          : initializerValue
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
      emissionError(
        context,
        `shared mutable capture ${variable.binding.name} requires explicit initial storage`,
        'cpp-shared-mutable-capture-missing-initial-storage',
      );
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

function emitCppDenseArraySequentialAppendConstructionCpp(initializer: string, context: EmitContext): string {
  const storage = getGeneratedTargetName('sequentialAppendArray', context);
  return `([&]() { auto ${storage} = ${initializer}; ${storage}.clear(); return ${storage}; }())`;
}

// Every type parameter the module declares, by binding identity. The traversal observer is used rather
// than a list of declaration kinds, because the parameter being read belongs to whichever declaration
// owns it -- a function, a method, a function type, an interface, a class, an alias, or an anonymous
// struct -- and an index built from a hand-written list would answer for the cases someone remembered.
// Identity is the binding, never the spelling: two declarations may both name a parameter `T`.
function collectCppTypeParameterConstraintsCpp(module: Readonly<IrModule>): Map<string, Readonly<IrType>> {
  const constraints = new Map<string, Readonly<IrType>>();
  analyzeIrModuleTraversal(module, {
    typeParameter(parameter) {
      if (parameter.constraint && !constraints.has(parameter.binding.id)) {
        constraints.set(parameter.binding.id, parameter.constraint);
      }
    },
  });
  return constraints;
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
  structuralCloneRecordBindingIds: Set<string>,
): ReadonlyMap<string, Readonly<CompilerCppStructuralRowPlan>> {
  const rows = new Map<string, Readonly<CompilerCppStructuralRowPlan>>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (!('binding' in variable) || variable.initializer?.kind !== 'cast') return;
      const structuralCloneRecordView = getCppStructuralCloneRecordViewPlanCpp(variable.initializer, context);
      if (structuralCloneRecordView) {
        rows.set(variable.binding.id, structuralCloneRecordView.row);
        structuralCloneRecordBindingIds.add(variable.binding.id);
        return;
      }
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

function collectCppStructuralOpenRowConstructionAssignmentsCpp(
  module: Readonly<IrModule>,
): ReadonlyMap<Readonly<Extract<IrExpression, { kind: 'object' }>>, ReadonlySet<string>> {
  const assignments = new Map<Readonly<Extract<IrExpression, { kind: 'object' }>>, ReadonlySet<string>>();
  const collectStatements = (statements: readonly IrStatement[]): void => {
    for (const [index, statement] of statements.entries()) {
      if (statement.kind === 'variable') {
        for (const variable of statement.declarations) {
          if (
            !('binding' in variable) ||
            variable.initializer?.kind !== 'cast' ||
            variable.initializer.expression.kind !== 'object'
          ) {
            continue;
          }
          const initialized = new Set<string>();
          for (const following of statements.slice(index + 1)) {
            const property = getCppStraightLineBindingPropertyAssignmentCpp(following, variable.binding.id);
            if (!property) break;
            initialized.add(property);
          }
          assignments.set(variable.initializer.expression, initialized);
        }
      }
      collectCppNestedStatementListsCpp(statement, collectStatements);
    }
  };
  for (const declaration of module.declarations) {
    if (declaration.kind === 'function') collectStatements(declaration.body);
    if (declaration.kind !== 'class') continue;
    if (declaration.classConstructor) collectStatements(declaration.classConstructor.body);
    for (const method of declaration.methods) collectStatements(method.body);
  }
  return assignments;
}

function collectCppNestedStatementListsCpp(
  statement: Readonly<IrStatement>,
  collect: (statements: readonly IrStatement[]) => void,
): void {
  switch (statement.kind) {
    case 'block':
      collect(statement.statements);
      return;
    case 'do':
    case 'for':
    case 'forIn':
    case 'forOf':
    case 'while':
      collect(statement.body.kind === 'block' ? statement.body.statements : [statement.body]);
      return;
    case 'if':
      collect(statement.consequent.kind === 'block' ? statement.consequent.statements : [statement.consequent]);
      if (statement.otherwise) {
        collect(statement.otherwise.kind === 'block' ? statement.otherwise.statements : [statement.otherwise]);
      }
      return;
    case 'switch':
      for (const switchCase of statement.cases) collect(switchCase.statements);
      return;
    case 'try':
      collect(statement.tryBody.kind === 'block' ? statement.tryBody.statements : [statement.tryBody]);
      if (statement.catchClause) {
        const body = statement.catchClause.body;
        collect(body.kind === 'block' ? body.statements : [body]);
      }
      if (statement.finallyBody) {
        collect(statement.finallyBody.kind === 'block' ? statement.finallyBody.statements : [statement.finallyBody]);
      }
      return;
    default:
      return;
  }
}

function getCppStraightLineBindingPropertyAssignmentCpp(
  statement: Readonly<IrStatement>,
  bindingId: string,
): string | undefined {
  if (
    statement.kind !== 'expression' ||
    statement.expression.kind !== 'assignment' ||
    statement.expression.operator !== '=' ||
    statement.expression.left.kind !== 'property' ||
    statement.expression.left.object.kind !== 'identifier' ||
    statement.expression.left.object.reference.kind !== 'binding' ||
    statement.expression.left.object.reference.binding.id !== bindingId
  ) {
    return undefined;
  }
  return statement.expression.left.name;
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
  // TypeScript may expand an inferred local to an anonymous object even when its initializer still
  // retains the named declaration returned by a call. Preserve that source identity only after the
  // two complete object layouts prove representation-equivalent; the same proof also covers the
  // existing nullable lane below without granting a conversion between unrelated rows.
  let variableValue = variable.type;
  let initializerValue = initializerType;
  if (variableUnion || initializerUnion) {
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
    const variableValues = variableUnion.types.filter(
      (member) => member.kind !== 'null' && member.kind !== 'undefined',
    );
    const initializerValues = initializerUnion.types.filter(
      (member) => member.kind !== 'null' && member.kind !== 'undefined',
    );
    if (variableValues.length !== 1 || initializerValues.length !== 1) return undefined;
    variableValue = variableValues[0]!;
    initializerValue = initializerValues[0]!;
  }
  const variablePlan = context.referenceRepresentationPlanner.plan(variableValue, context.module);
  const initializerPlan = context.referenceRepresentationPlanner.plan(initializerValue, context.module);
  if (
    variablePlan.kind !== 'represented' ||
    variablePlan.valueRepresentation !== 'flightReference' ||
    initializerPlan.kind !== 'represented' ||
    initializerPlan.valueRepresentation !== 'flightReference'
  ) {
    return undefined;
  }
  const variableShape = context.referenceRepresentationPlanner.resolveObjectShape(variableValue, context.module);
  const initializerShape = context.referenceRepresentationPlanner.resolveObjectShape(initializerValue, context.module);
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
  // Readonly controls source writes but does not change a field's emitted C++ storage, so otherwise
  // identical readonly and mutable records can share one contextual reference representation.
  if (left.length !== right.length) return false;
  const rightByName = new Map(right.map((property) => [property.name, property] as const));
  return left.every((property) => {
    const other = rightByName.get(property.name);
    if (
      !other ||
      property.optional !== other.optional ||
      Boolean(property.computedKey) !== Boolean(other.computedKey)
    ) {
      return false;
    }
    return areCppTypesRepresentationEquivalent(property.type, other.type, context);
  });
}

function areCppTypesRepresentationEquivalent(
  left: Readonly<IrType>,
  right: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
  if (
    emitCppAliasResolvedValueTypeCpp(left, isolatedContext) === emitCppAliasResolvedValueTypeCpp(right, isolatedContext)
  ) {
    return true;
  }
  const leftUnion = getIrUnionTypeCpp(left, context, new Set());
  const rightUnion = getIrUnionTypeCpp(right, context, new Set());
  return Boolean(
    leftUnion &&
    rightUnion &&
    hasEquivalentCppUnionRepresentation(
      getCppUnionRepresentationPlan(leftUnion, isolatedContext),
      getCppUnionRepresentationPlan(rightUnion, isolatedContext),
    ),
  );
}

// A TypeScript alias does not introduce a distinct value representation. The generated C++ keeps
// aliases as names for readability, however, so comparing the surface spelling would call
// `using BackendReason = String` and `using BlockReason = String` different field types. Open only
// compiler-known aliases and compare the type their values actually use. Interfaces and classes do
// not resolve through this path, and a recursive alias is left at its last stable spelling.
function emitCppAliasResolvedValueTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string> = new Set(),
): string {
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.binding.kind === 'typeParameter') {
    return emitType(type, context);
  }
  const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
  if (resolvingAliases.has(key)) return emitType(type, context);
  const target = resolveCppTypeAliasTarget(type, context);
  return target
    ? emitCppAliasResolvedValueTypeCpp(target, context, new Set(resolvingAliases).add(key))
    : emitType(type, context);
}

function emitExpression(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
  constructExpectedUnion = true,
  denseArrayLengthInitialized = false,
): string {
  if (expectedType && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const voidValueConversion = emitCppContextualVoidValueCpp(expression, expectedType, context);
    if (voidValueConversion) return voidValueConversion;
    const erasedDynamicConversion = emitCppContextualErasedDynamicValueCpp(expression, expectedType, context);
    if (erasedDynamicConversion) return erasedDynamicConversion;
    refuseCppContextualStructuralArrayNominalRecoveryCpp(expression, expectedType, context);
    const optionalPropertyConversion = emitCppOptionalPropertyDualSentinelConversionCpp(
      expression,
      expectedType,
      context,
    );
    if (optionalPropertyConversion) return optionalPropertyConversion;
    const structuralConversion = emitCppContextualStructuralReferenceCpp(expression, expectedType, context);
    if (structuralConversion) return structuralConversion;
    const recordConversion = emitCppContextualStructuralRecordConversionCpp(expression, expectedType, context);
    if (recordConversion) return recordConversion;
  }
  if (expectedType && constructExpectedUnion) {
    const constructed = emitContextualUnionExpressionCpp(expression, expectedType, context);
    if (constructed) return constructed;
  }
  switch (expression.kind) {
    case 'array':
      return emitArrayExpressionCpp(expression, context, expectedType);
    case 'assignment': {
      if (
        (expression.left.kind === 'property' || expression.left.kind === 'element') &&
        getCppExternalNumericPropertyViewAccessPlanCpp(expression.left, context)
      ) {
        emissionError(
          context,
          'an external numeric-property view is read-only',
          'cpp-external-numeric-property-view-write',
        );
      }
      // The named-property view is the read side only, and that is the point of it: a name that was
      // never declared cannot become a way to mutate the object behind it. A write through the view is
      // refused here rather than emitted as a `get` on the left of an assignment, which would be an
      // rvalue and would not compile anyway.
      // The double cast is the view idiom the source writes to make a dynamic named read type-check;
      // a single cast of an object spread is the clone lane's, and its refusals are its own.
      if (
        expression.left.kind === 'element' &&
        isCppNamedPropertiesErasedMarkerViewCpp(expression.left.object, context)
      ) {
        emissionError(
          context,
          'a dynamic named view is read-only, so it cannot be an assignment target',
          'cpp-named-properties-write-unsupported',
        );
      }
      if (
        expression.operator === '=' &&
        expression.left.kind === 'identifier' &&
        expression.left.reference.kind === 'binding' &&
        context.exceptionPointerBindingIds.has(expression.left.reference.binding.id) &&
        expression.right.kind === 'identifier' &&
        expression.right.reference.kind === 'binding' &&
        expression.right.reference.binding.kind === 'catch'
      ) {
        context.includes.add('exception');
        return `${emitExpression(expression.left, context)} = std::current_exception()`;
      }
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
      const denseArraySequentialAppendAssignment =
        expression.operator === '='
          ? emitCppDenseArraySequentialAppendAssignmentCpp(expression.left, right, context)
          : undefined;
      if (denseArraySequentialAppendAssignment) return denseArraySequentialAppendAssignment;
      const capturedRuntimeReferentAssignment = emitCppCapturedRuntimeReferentPropertyAssignmentCpp(
        expression,
        right,
        context,
      );
      if (capturedRuntimeReferentAssignment) return capturedRuntimeReferentAssignment;
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
        if (!value)
          emissionError(
            context,
            `array length ${expression.operator} requires checked resize lowering`,
            'cpp-array-length-assignment-unsupported',
          );
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
      const ambientTypeofComparison = emitAmbientTypeofUndefinedComparisonCpp(expression, context);
      if (ambientTypeofComparison) return ambientTypeofComparison;
      const typeofTagComparison = emitCppInferredOptionalTypeofTagComparisonCpp(expression, context);
      if (typeofTagComparison) return typeofTagComparison;
      const typeofFunctionComparison = emitCppInferredOptionalTypeofFunctionComparisonCpp(expression, context);
      if (typeofFunctionComparison) return typeofFunctionComparison;
      if (expression.operator === '??') {
        const leftType =
          getIrExpressionBindingTypeCpp(expression.left, context) ??
          getIrExpressionTypeEvidenceCpp(expression.left, context);
        const union = leftType ? getIrUnionTypeCpp(leftType, context, new Set()) : undefined;
        const leftUsesOptionalStorage = hasCppAbsenceStorageCpp(expression.left, context);
        // A left whose type excludes absence answers the test at compile time, so the coalesce is the
        // tautology the source wrote and the fallback is unreachable. An OPTIONAL CALL is the exception:
        // `f?.()` is `undefined` when the callee is missing whatever the callee's return says, and the
        // call's type evidence reports only that return. Treating it as absence-free dropped the fallback
        // and left `optional<double>` where the source has a `number` — so the default is kept, and the
        // optional-call result is defaulted below like any other absent-capable left.
        const leftIsOptionalCall =
          expression.left.kind === 'call' &&
          (expression.left.optional === true || expression.left.semantics.optionalChain !== undefined);
        if (
          leftType &&
          !union &&
          !leftUsesOptionalStorage &&
          !leftIsOptionalCall &&
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
        const optionalSingle = emitCppOptionalSingleNullishCoalesceCpp(
          expression,
          leftType,
          leftUsesOptionalStorage,
          expectedType,
          context,
          denseArrayLengthInitialized,
        );
        if (optionalSingle) return optionalSingle;
        context.includes.add('optional');
        return `${emitOptionalExpressionCpp(expression.left, context, leftType)}.value_or(${emitExpression(expression.right, context, expectedType, true, denseArrayLengthInitialized)})`;
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
      const mathHypot = emitCppMathHypotCallCpp(expression, context);
      if (mathHypot) return mathHypot;
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
      const namedPropertiesEnumeration = emitCppNamedPropertiesEnumerationCpp(expression, context);
      if (namedPropertiesEnumeration) return namedPropertiesEnumeration;
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
        expression.callee.name === 'toFixed' &&
        (expression.callee.member?.receiver === 'number' ||
          isIrNumberTypeEvidenceCpp(getIrExpressionTypeEvidenceCpp(expression.callee.object, context)))
      ) {
        if (getCppRuntimeProfile(context.options) !== 'flight-cpp') {
          emissionError(
            context,
            'Number.toFixed requires a JavaScript-compatible downstream runtime helper',
            'cpp-number-to-fixed-runtime-helper-required',
          );
        }
        // The flight-cpp contract owns ECMAScript formatting and digit normalization. Keeping this
        // a free helper prevents primitive `double` from acquiring a coincidentally named method.
        context.includes.add('flight/number.hpp');
        const arguments_ = expression.arguments.map((argument) =>
          emitExpression(argument, context, { kind: 'primitive', name: 'number' }),
        );
        return `flight::number_to_fixed(${[
          emitExpression(expression.callee.object, context, { kind: 'primitive', name: 'number' }),
          ...arguments_,
        ].join(', ')})`;
      }
      // `value.toString()` on a primitive variant is the runtime's own string conversion rather than a
      // member of the alternatives' C++ types, and the conversion of a variant is one visit over
      // `flight::to_string` -- the same body the explicit `String(value)` operation emits. It is proven by
      // the runtime defining the conversion for every alternative, which is the condition asked here. The
      // call is the conversion, so the callee is not emitted as a member the runtime does not have.
      if (
        expression.callee.kind === 'property' &&
        isCppVariantPrimitiveStringConversionCpp(expression.callee, context)
      ) {
        return emitCppExplicitStringConversionCpp(expression.callee.object, context);
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.name === 'toString' &&
        (expression.callee.member?.receiver === 'number' ||
          isIrNumberTypeEvidenceCpp(getIrExpressionTypeEvidenceCpp(expression.callee.object, context)) ||
          // A string receiver answers itself, and the runtime spells that as the free
          // `flight::to_string` rather than a member: `flight::String` has no `to_string`, so the
          // member spelling a general name map produces (`text.to_string()`) names nothing.
          isIrStringTypeEvidenceCpp(getIrExpressionTypeEvidenceCpp(expression.callee.object, context)))
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
          assertCppPresentOptionalStorageMemberReceiverCpp(expression.callee, context);
          const receiver = emitExpression(expression.callee.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.callee.object, context)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'method') {
          assertCppPresentOptionalStorageMemberReceiverCpp(expression.callee, context);
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
          const args = expression.arguments.map((argument, index) => {
            const argumentExpectedType =
              getCppContextualArrayCallbackTypeCpp(expression, expectedType, index, context) ??
              getIrCallArgumentExpectedTypeCpp(expression, index, context);
            assertCppPresentOptionalCollectionArgumentCpp(expression, argument, index, argumentExpectedType, context);
            return emitExpression(argument, context, argumentExpectedType);
          });
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
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return emitCppExplicitStringConversionCpp(argument, context);
        }
        context.includes.add('string');
        return `std::to_string(${emitExpression(argument, context)})`;
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
      const sourceTypeArguments =
        expression.typeArguments.length > 0
          ? expression.typeArguments
          : (getCppContextualCallTypeArgumentsCpp(expression, expectedType, context) ?? []);
      const typeArguments = getCppValueRepresentedCallTypeArgumentsCpp(expression, sourceTypeArguments, context);
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
            const argumentExpectedType = getIrCallArgumentExpectedTypeCpp(
              expression,
              index,
              context,
              expectedType,
              typeArguments,
            );
            assertCppPresentOptionalCollectionArgumentCpp(expression, argument, index, argumentExpectedType, context);
            return emitExpression(argument, context, argumentExpectedType);
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
      const calleeHasOptionalStorage =
        (expression.callee.kind === 'identifier' &&
          expression.callee.reference.kind === 'binding' &&
          context.nullableBindingIds.has(expression.callee.reference.binding.id)) ||
        hasIrTypeAbsentMember(calleeStorageType);
      const optionalCallable = Boolean(
        calleeStorageType &&
        !calleeAlreadyUnwrapped &&
        calleeHasOptionalStorage &&
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
      const invocation = `${invocationTarget}${emitCppTypeArguments(typeArguments, context)}(${args.join(', ')})`;
      const returnType = getIrCallReturnTypeCpp(expression, context);
      const returnUnion = returnType ? getIrUnionTypeCpp(returnType, context, new Set()) : undefined;
      const returnPlan = returnUnion ? getCppUnionRepresentationPlan(returnUnion, context) : undefined;
      return expression.presence === 'narrowedPresent' && returnPlan?.kind === 'optionalSingle'
        ? `${invocation}.value()`
        : invocation;
    }
    case 'cast': {
      if (getCppErasedRefWeakMapViewPlan(expression, context)) {
        refuseCppErasedRefWeakMapView(context);
      }
      if (isCppErasedWeakMapType(getIrExpressionTypeEvidenceCpp(expression.expression, context), context)) {
        if (getCppErasedWeakMapViewPlan(expression, context)) {
          emissionError(context, 'erased WeakMap assertion requires a local typed-view binding');
        }
        emissionError(context, 'erased WeakMap assertion target requires an approved typed WeakMap view');
      }
      const erasedDynamicConversion = emitCppContextualErasedDynamicValueCpp(
        expression.expression,
        expression.type,
        context,
      );
      if (erasedDynamicConversion) return erasedDynamicConversion;
      const namedPropertiesSource = getCppNamedPropertiesViewSourceCpp(expression, context);
      if (
        isCppUnknownRecordTypeCpp(expression.type, 'PropertyKey') &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        const inner = expression.expression;
        const keyedSource =
          inner.kind === 'cast' && inner.type.kind === 'unknown' && inner.type.source === 'unknown'
            ? inner.expression
            : inner;
        // The view reports own enumerable STRING keys and nothing else, so a `PropertyKey`-keyed view
        // over one has no symbol property to reach. This is the negative side of the same invariant the
        // runtime states: a name and a symbol of the same spelling are two properties and neither view
        // sees the other.
        if (getCppNamedPropertiesViewExpressionCpp(keyedSource, context)) {
          emissionError(
            context,
            'a dynamic named view reports own string keys only, so a PropertyKey-keyed view over one has no symbol property to read',
            'cpp-named-properties-symbol-key-unsupported',
          );
        }
      }
      if (namedPropertiesSource) {
        // The view IS the value of the cast: `Record<string, unknown>` here names a set of properties to
        // read by name, and `flight::NamedProperties` is the runtime's handle on exactly that. Keys come
        // back in source declaration order from the primitive itself, so the emitter adds no ordering.
        context.includes.add('flight/structural_ref.hpp');
        return `flight::named_properties(${emitExpression(namedPropertiesSource, context)})`;
      }
      const structuralCloneRecordView = getCppStructuralCloneRecordViewPlanCpp(expression, context);
      if (structuralCloneRecordView) {
        const typeParameter = emitType(structuralCloneRecordView.typeParameter, context);
        const source = emitExpression(structuralCloneRecordView.source, context, structuralCloneRecordView.sourceType);
        context.includes.add('flight/structural_ref.hpp');
        return `${emitCppStructuralRowReferenceTypeCpp(structuralCloneRecordView.row, context)}(flight::make_ref<typename ${typeParameter}::element_type>(*flight::structural_ref_cast<${typeParameter}>(${source})))`;
      }
      const structuralCloneRecovery = emitCppStructuralCloneRecordRecoveryCpp(expression, context);
      if (structuralCloneRecovery) return structuralCloneRecovery;
      if (
        !namedPropertiesSource &&
        isCppUnknownRecordTypeCpp(expression.type, 'string') &&
        getCppRuntimeProfile(context.options) === 'flight-cpp'
      ) {
        // The view idiom over something that is neither a `Record` nor an object the runtime can
        // enumerate. An erased value is the case that matters: it holds an object, but the type it was
        // stored as is not recoverable from it, and `named_properties` takes a typed reference or a row
        // and has no overload for the erased value. Refusing keeps the read honest rather than emitting
        // a cast that cannot compile.
        const inner = expression.expression;
        const refusedSource =
          inner.kind === 'cast' && inner.type.kind === 'unknown' && inner.type.source === 'unknown'
            ? inner.expression
            : inner;
        const refusedType = getIrExpressionTypeEvidenceCpp(refusedSource, context);
        const refusedRuntime = refusedType ? getIrTypeRuntimeDomainCpp(refusedType, context, new Set()) : undefined;
        // Only the erased value is claimed here. Other unenumerable sources reach lanes of their own --
        // a clone projection among them -- and a refusal from this lane would take their question away
        // from them.
        if (
          refusedRuntime &&
          isCppErasedDynamicValueTypeCpp(refusedRuntime) &&
          !getCppRecordTypeArgumentsCpp(refusedType, context, new Set())
        ) {
          emissionError(
            context,
            'a dynamic named view needs an object whose properties the runtime can enumerate, and an erased value has no recoverable property set',
            'cpp-named-properties-source-unproven',
          );
        }
      }

      if (isCppUnprovenGenericRecordAssertionCpp(expression, context)) {
        emissionError(
          context,
          'generic Record assertion requires a proven cloned structural-row identity',
          'cpp-generic-record-assertion-unproven',
        );
      }
      const structuralTarget = context.referenceRepresentationPlanner.resolveStructuralRow(
        expression.type,
        context.module,
      );
      if (
        expression.expression.kind === 'object' &&
        hasCppOpenStructuralRowTypeParameterCpp(expression.type, context) &&
        !getCppStructuralOpenRowConstructionPlanCpp(expression.expression, expression.type, context)
      ) {
        emissionError(
          context,
          'open structural-row construction requires a complete fixed row and one proven computed symbol member',
          'cpp-structural-open-row-construction-unproven',
        );
      }
      const structuralSourceType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
      const structuralSource =
        getCppStructuralRowExpressionPlanCpp(expression.expression, context) ??
        (structuralSourceType
          ? context.referenceRepresentationPlanner.resolveStructuralRow(structuralSourceType, context.module)
          : undefined);
      const structuralProjectionTarget = structuralSource
        ? getCppStructuralProjectionRowCpp(expression.type, context)
        : undefined;
      if ((structuralTarget || structuralProjectionTarget) && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        if (expression.expression.kind === 'object') {
          return emitExpression(expression.expression, context, expression.type);
        }
        const subject = emitCppAssertionSubjectCpp(expression.expression, context);
        const structuralSourceObject = structuralSource
          ? getCppStructuralRowObjectTypeCpp(structuralSource)
          : undefined;
        if (
          structuralSourceObject &&
          emitType(structuralSourceObject, context) === emitType(expression.type, context)
        ) {
          return `flight::structural_ref_cast<${emitType(expression.type, context)}>(${subject})`;
        }
        const target = structuralProjectionTarget
          ? emitCppStructuralRowReferenceTypeCpp(structuralProjectionTarget, context)
          : emitType(expression.type, context);
        // `structural_ref_cast` takes a structural reference, and a cast can only view a value that is one.
        // A source that is not itself a structural row is a native reference -- a declared interface whose
        // C++ storage is the runtime's `Ref` -- and the subject alone is then no argument that overload
        // accepts. The source's own projection view is built from that owner first, exactly as a value
        // conversion between the same pair of types does, so the cast views the same object the source
        // named rather than a carrier built around it.
        //
        // That view is built from the source's STATIC type, and a structural owner's cells are bound from
        // that type once, when the object is first reached (`owner_for<Object>` ->
        // `bind_generated_row_members`). A base-typed source viewed as a derived row therefore binds only
        // the base's cells, and the first read of a derived-only member throws at run time, far from here,
        // with nothing naming the assertion that asked for it. The view is emitted only when the source's
        // shape carries every member the asserted row reads -- the same widening proof the value
        // conversion lane requires. Identical nominal types hold, and so does a derived source viewed as
        // a base row, because the derived type declares everything the base does; a base source viewed as
        // a derived row does not, and is refused rather than emitted. A source whose flow evidence proves
        // the exact derived referent already IS that derived type here, so it takes the same proof as any
        // other derived source instead of a rule of its own.
        const sourceProjection =
          !structuralSource && structuralSourceType
            ? getCppStructuralProjectionRowCpp(structuralSourceType, context)
            : undefined;
        if (sourceProjection) {
          const projectionSource = getCppStructuralRowObjectTypeCpp(sourceProjection);
          const projectionTargetObject = getCppStructuralRowObjectTypeCpp(
            structuralProjectionTarget ?? structuralTarget!,
          );
          if (
            !projectionSource ||
            !projectionTargetObject ||
            getCppStructuralRowObjectWideningProofCpp(projectionSource, projectionTargetObject, context) !== 'proven'
          ) {
            emissionError(
              context,
              'the asserted row reads members the source type does not declare, and a structural owner binds the members of the type the object was first reached as, so a derived-only read has no cell to answer it',
              'cpp-structural-assertion-owner-unproven',
            );
          }
          return `flight::structural_ref_cast<${target}>(${emitCppStructuralRowReferenceTypeCpp(sourceProjection, context)}(${subject}))`;
        }
        return `flight::structural_ref_cast<${target}>(${subject})`;
      }
      if (structuralSource && getCppRuntimeProfile(context.options) === 'flight-cpp' && structuralSourceType) {
        const targetPlan = context.referenceRepresentationPlanner.plan(expression.type, context.module);
        if (
          targetPlan.kind !== 'represented' ||
          targetPlan.identityDomain !== 'object' ||
          targetPlan.valueRepresentation === 'inlineValue'
        ) {
          emissionError(context, 'structural-row projection requires a represented object-reference target');
        }
        context.includes.add('flight/structural_ref.hpp');
        return `flight::structural_ref_cast<${emitType(expression.type, context)}>(${emitCppAssertionSubjectCpp(expression.expression, context)})`;
      }
      // A fresh literal has no runtime identity before this assertion: the asserted reference type is
      // the storage it is being constructed as. Emitting the literal without that context first gives
      // it a generated anonymous referent and leaves C++ trying to cast an unrelated `Ref<anonymous>`
      // to the declared interface. Nonliteral assertions are projections of an existing identity and
      // deliberately stay on the cast paths above/below; structural literals have already taken the row
      // construction path above.
      if (
        expression.expression.kind === 'object' &&
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        hasFlightReferenceRepresentationCpp(expression.type, context)
      ) {
        return emitExpression(expression.expression, context, expression.type);
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
      const asserted =
        emitCppErasedRefAssertionCpp(expression.expression, expression.type, context) ??
        emitUnionMemberAssertionCpp(expression.expression, expression.type, context);
      const assertedGenericFactory = emitCppUnknownBridgedGenericFactoryAssertionCpp(expression, context);
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
      const sourceEvidence = getIrExpressionTypeEvidenceCpp(expression.expression, context);
      const assertedExpression =
        asserted ??
        assertedGenericFactory ??
        getCppErasedValueAssertionCpp(expression.type, sourceEvidence, expression.expression, context);
      if (assertedExpression) return assertedExpression;
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        isCppErasedDynamicValueTypeCpp(sourceEvidence) &&
        hasCppExternalRuntimeReferenceRepresentationCpp(expression.type, context)
      ) {
        emissionError(
          context,
          'an erased dynamic value cannot be asserted to a host reference without a proven exact external extraction',
          'cpp-erased-external-reference-assertion-unrepresented',
        );
      }
      // An erased value answers only what the runtime can read out of it honestly: the primitives, a
      // reference it can identify, and a callable. `flight::Array` is not one of them, by the runtime's own
      // contract — an array cannot be handed to `flight::Any` without inventing an identity or reinterpreting
      // storage, and an element read back out of one is the same value. Emitting a `static_cast` there is a
      // call to a conversion that does not exist, so the assertion is refused and named instead.
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.type.kind === 'array' &&
        isCppErasedDynamicValueTypeCpp(sourceEvidence)
      ) {
        emissionError(
          context,
          `an erased C++ value has no honest reading of ${emitType(expression.type, context)}; the runtime reports what it cannot carry rather than reinterpreting storage`,
          'cpp-erased-value-assertion-unrepresented',
        );
      }
      return `static_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`;
    }
    case 'conditional': {
      const erasedTypeof = emitCppErasedTypeofConditionalCpp(expression, context, expectedType);
      if (erasedTypeof) return erasedTypeof;
      const evidence =
        expression.condition.kind === 'binary' ? expression.condition.semantics.unionMemberTest : undefined;
      return `(${emitCppTruthinessExpression(expression.condition, context)} ? ${emitCppConditionalBranchCpp(expression.whenTrue, getCppUnionMemberTestBranchContextCpp(evidence, true, context), expectedType)} : ${emitCppConditionalBranchCpp(expression.whenFalse, getCppUnionMemberTestBranchContextCpp(evidence, false, context), expectedType)})`;
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
      const externalNumericProperty = emitCppExternalNumericPropertyViewElementCpp(expression, context);
      if (externalNumericProperty) return externalNumericProperty;
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
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        !isCppObjectEntriesTupleStorageExpressionCpp(expression.object, context) &&
        hasIndexedRuntimeReceiverCpp(expression, context)
      ) {
        const access = `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
        return expectedType?.kind === 'primitive' &&
          expectedType.name === 'number' &&
          isCppUint8ClampedArrayElementCpp(expression, context)
          ? `static_cast<double>(${access})`
          : access;
      }
      if (expression.semantics.receivers.includes('tuple')) {
        context.includes.add('tuple');
        const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
        const tuple = objectType ? getIrTupleTypeCpp(objectType, context, new Set()) : undefined;
        const index = getElementAccessTupleIndexCpp(expression, context, tuple);
        return `std::get<${String(index)}>(${emitExpression(expression.object, context)})`;
      }
      const object = emitExpression(expression.object, context);
      const index = emitExpression(expression.index, context);
      const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
      // A dynamic named view reads through the runtime's own `get`, which answers `flight::Any` and reads
      // an absent key as `undefined`. This is checked before the `Record` path because the view's
      // declared type IS `Record<string, unknown>`, and only the storage tells the two apart.
      if (getCppNamedPropertiesViewExpressionCpp(expression.object, context)) {
        if (!isCppStringKeyIndexCpp(expression.index, context)) {
          emissionError(
            context,
            'a dynamic named view reads only own string keys, so a symbol or computed key has no property this view can report',
            'cpp-named-properties-key-not-a-string',
          );
        }
        context.includes.add('flight/structural_ref.hpp');
        return `${object}.get(${index})`;
      }
      const record = getCppRecordTypeArgumentsCpp(objectType, context, new Set());
      if (record && getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return `${object}.get(${emitCppRequiredRecordKeyCpp(expression.index, record.key, context)}).value()`;
      }
      const closedKeys = getCppClosedElementKeyNamesCpp(expression, context);
      if (closedKeys) return emitCppClosedKeyElementSelectionCpp(expression, closedKeys, context);
      // An object held by reference as a set of named members has no subscript at all, and the row
      // mechanism has no string-keyed form, so an index the compiler cannot resolve to a member would
      // reach the target as an operator it does not define. A closed union of string literals is the
      // only shape that establishes which members the index can name, so anything else here is refused
      // rather than emitted as a subscript that cannot compile.
      //
      // The member requirement is what keeps this off an index-signature carrier: `{ [index: number]:
      // number }` is also reference-represented, but it is erased to a generic parameter precisely so
      // it can stand for any carrier that does subscript, and `out[offset]` is the whole point of it.
      const referenceReceiver = objectType ? getIrTypeRuntimeDomainCpp(objectType, context, new Set()) : undefined;
      const referenceMembers = referenceReceiver
        ? context.referenceRepresentationPlanner.resolveObjectShape(referenceReceiver, context.module)
        : undefined;
      if (
        referenceReceiver &&
        referenceMembers?.some((property) => !isCppValuelessStructMemberCpp(property.type)) &&
        hasFlightReferenceRepresentationCpp(referenceReceiver, context)
      ) {
        emissionError(
          context,
          'indexed access on a reference-represented object requires a closed set of string-literal keys',
          'cpp-object-index-without-closed-key-set',
        );
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
        expectedCallable && expectedCallable.parameters.length >= expression.parameters.length
          ? expression.parameters.map((parameter, index) =>
              parameter.type.kind === 'unknown' && parameter.type.source === 'any'
                ? { ...parameter, type: expectedCallable.parameters[index]!.type }
                : (() => {
                    const refined = getCppInvariantCollectionEvidenceRefinementCpp(
                      parameter.type,
                      expectedCallable.parameters[index]!.type,
                    );
                    return refined ? { ...parameter, type: refined } : parameter;
                  })(),
            )
          : expression.parameters;
      const returns = expectedCallable?.returns ?? expression.returns;
      // Contextual parameter recovery changes the lambda ABI, so member access inside the body must
      // consult those same recovered types rather than the original unresolved parameter bindings.
      const bindingTypes = new Map(context.bindingTypes);
      parameters.forEach((parameter) => bindingTypes.set(parameter.binding.id, parameter.type));
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
        bindingTypes,
        defaultedParameterIds: new Set([
          ...context.defaultedParameterIds,
          ...collectDefaultedParameterIdsCpp(parameters),
        ]),
        enclosingReturnType: returns,
        namespaceScope: false,
        returnsAbsent: hasIrTypeAbsentMember(returns),
      };
      refineCppObjectEntriesDestructuringBindingsCpp(expression.body, functionContext);
      const usesThis = irFunctionExpressionUsesThisCpp(expression);
      if (usesThis && expression.thisMode === 'dynamic') {
        emissionError(context, 'dynamic-this closures require receiver lowering');
      }
      if (usesThis && !context.currentClass) {
        emissionError(context, 'lexical-this closure requires class receiver context');
      }
      functionContext.includes.add('functional');
      const template = emitCppFunctionTemplate(expression.typeParameters, parameters, functionContext);
      const ignoredContextualParameters =
        expectedCallable &&
        expectedCallable.parameters.length > parameters.length &&
        !parameters.some((parameter) => parameter.rest) &&
        expectedCallable.parameters.slice(parameters.length).every((parameter) => !parameter.rest)
          ? expectedCallable.parameters.slice(parameters.length).map((parameter) => {
              const name = getGeneratedTargetName('ignoredCallbackArgument', functionContext);
              const type = emitOptionalTypeCpp(
                emitCppParameterTypeCpp(parameter.type, parameter.rest, functionContext),
                parameter.optional,
                functionContext,
              );
              return { declaration: `${type} ${name}`, discard: `(void)${name};` };
            })
          : [];
      const params = [
        ...parameters.map((parameter) => emitParameter(parameter, functionContext)),
        ...ignoredContextualParameters.map((parameter) => parameter.declaration),
      ];
      const ignoredContextualParameterDiscards = ignoredContextualParameters.map((parameter) => parameter.discard);
      const capture = usesThis
        ? context.namespaceScope
          ? '[this]'
          : '[=, this]'
        : context.namespaceScope
          ? '[]'
          : '[=]';
      const lambdaTemplate = template.parameters ? template.parameters : '';
      const lambdaRequirement = template.requirement ? ` requires ${template.requirement}` : '';
      // C++ return deduction compares the branch expressions themselves. A source union instead has
      // one representation selected for every branch: `T | null` is `optional<T>`, for example, even
      // when one return is a constructed optional and another is `nullopt`. State that proven ABI on
      // the lambda so deduction cannot split the shared carrier back into its branch-local spellings.
      const returnUnion = getIrUnionTypeCpp(returns, functionContext, new Set());
      const lambdaReturn = returnUnion ? ` -> ${emitUnionTypeCpp(returnUnion, functionContext)}` : '';
      if (
        expression.expression &&
        functionContext.defaultedParameterIds.size === 0 &&
        !hasSharedCaptureParameterCpp(parameters, functionContext)
      ) {
        return `${capture}${lambdaTemplate}(${params.join(', ')})${lambdaReturn}${lambdaRequirement} { ${ignoredContextualParameterDiscards.join(' ')}${ignoredContextualParameterDiscards.length > 0 ? ' ' : ''}return ${emitExpression(expression.expression, functionContext, returns)}; }`;
      }
      return `${capture}${lambdaTemplate}(${params.join(', ')})${lambdaReturn}${lambdaRequirement} {\n${indentSourceLines(
        [
          ...ignoredContextualParameterDiscards,
          ...emitParameterInitializersCpp(parameters, functionContext),
          ...(expression.expression
            ? [`return ${emitExpression(expression.expression, functionContext, returns)};`]
            : [
                ...emitStatements(expression.body, functionContext),
                ...emitImplicitCompletionCpp(expression.body, functionContext),
              ]),
        ],
      ).join('\n')}\n}`;
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
        !context.sharedCaptureTargetNames.has(expression.reference.binding.id) &&
        !expression.narrowedMember &&
        !context.narrowedBindingTypes.has(expression.reference.binding.id)
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
        expression.reference.kind === 'binding' &&
        (expression.presence === 'narrowedPresent' ||
          (context.capturedReferentOnlyBindingIds.has(expression.reference.binding.id) &&
            context.narrowedBindingTypes.has(expression.reference.binding.id))) &&
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
      const contextualConstructedType = expectedType
        ? getCppNonNullableType(expectedType, context, new Set())
        : undefined;
      const constructedType = getIrNewExpressionTypeEvidenceCpp(expression, context, contextualConstructedType);
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
        !denseArrayLengthInitialized &&
        !(expression.arguments.length === 1 && getNonnegativeIntegerLiteralCpp(expression.arguments[0]!) === 0)
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
      const expectedExternalObject = getCppExternalValueObjectSourceNameCpp(expectedType, context);
      const expectedExternalPayload = getCppExternalValueObjectSourceNameCpp(expectedPayload, context);
      const constructionType =
        expectedType && expectedExternalObject
          ? expectedType
          : expectedPayload && expectedExternalPayload
            ? expectedPayload
            : expectedType &&
                (hasFlightReferenceRepresentationCpp(expectedType, context) ||
                  hasFlightStructuralRowRepresentationCpp(expectedType, context))
              ? expectedType
              : expectedPayload &&
                  (hasFlightReferenceRepresentationCpp(expectedPayload, context) ||
                    hasFlightStructuralRowRepresentationCpp(expectedPayload, context))
                ? expectedPayload
                : expression.type;
      const externalObjectSourceName = getCppExternalValueObjectSourceNameCpp(constructionType, context);
      if (externalObjectSourceName) {
        return emitCppExternalObjectConstructionCpp(expression, externalObjectSourceName, context);
      }
      const record = getCppRecordTypeArgumentsCpp(constructionType, context, new Set());
      if (record) {
        if (expression.members.length === 0) return `${emitType(constructionType, context)}{}`;
        if (expression.members.some((member) => member.kind !== 'property')) {
          return emitCppOrderedRecordConstructionCpp(expression, constructionType, record, context);
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
        const openRowConstruction = getCppStructuralOpenRowConstructionPlanCpp(expression, constructionType, context);
        if (openRowConstruction) {
          const fields = openRowConstruction.fields.map(({ member, property }) => {
            const value = emitExpression(member.value, context, property.type);
            return member.kind === 'computedProperty'
              ? `flight::row_field(${emitExpression(member.key, context)}, ${value})`
              : `flight::row_field<flight::RowKey<${JSON.stringify(member.name)}>>(${value})`;
          });
          context.includes.add('flight/structural_ref.hpp');
          return `flight::make_structural_ref<${emitCppStructuralRowSchemaTypeCpp(structuralRow, context)}>(${fields.join(', ')})`;
        }
        if (hasCppOpenStructuralRowTypeParameterCpp(constructionType, context)) {
          emissionError(
            context,
            'open structural-row construction requires a complete fixed row and one proven computed symbol member',
            'cpp-structural-open-row-construction-unproven',
          );
        }
        const closedSpreadConstruction = getCppStructuralClosedRowSpreadConstructionPlanCpp(
          expression,
          constructionType,
          structuralRow,
          context,
        );
        if (closedSpreadConstruction) {
          const sourceName = getGeneratedTargetName('structuralSpreadSource', context);
          const source = emitExpression(closedSpreadConstruction.source, context, closedSpreadConstruction.sourceType);
          const evaluations: string[] = [];
          const valueNames = new Map<string, string>();
          for (const field of closedSpreadConstruction.fields) {
            if (field.kind === 'property') continue;
            const sourceProperty = field.kind === 'spread' ? field.property : field.sourceProperty;
            const sourceValue = closedSpreadConstruction.sourceMayBeAbsent ? `${sourceName}.value()` : sourceName;
            const value =
              closedSpreadConstruction.sourceKind === 'structuralRow'
                ? `flight::row_get<flight::RowKey<${JSON.stringify(sourceProperty.name)}>>(${sourceValue})`
                : `${sourceValue}->${safeCppName(sourceProperty.name)}`;
            if (field.kind === 'overriddenSpread') {
              // Object spread still performs Get on a source property whose value a later member
              // replaces. Keep that observation in source order even though the value is discarded.
              evaluations.push(
                closedSpreadConstruction.sourceMayBeAbsent
                  ? `if (${sourceName}.has_value()) static_cast<void>(${value});`
                  : `static_cast<void>(${value});`,
              );
              continue;
            }
            const valueName = getGeneratedTargetName(`structuralSpreadField_${sourceProperty.name}`, context);
            if (closedSpreadConstruction.sourceMayBeAbsent) {
              const valueType = emitOptionalTypeCpp(
                getCppStructuralClosedRowCellStorageTypeCpp(sourceProperty.type, context),
                true,
                context,
              );
              evaluations.push(`${valueType} ${valueName}; if (${sourceName}.has_value()) ${valueName} = ${value};`);
            } else {
              evaluations.push(`auto ${valueName} = ${value};`);
            }
            valueNames.set(sourceProperty.name, valueName);
          }
          for (const member of expression.members) {
            if (member.kind !== 'property') continue;
            const field = closedSpreadConstruction.fields.find(
              (candidate) => candidate.kind !== 'spread' && candidate.member === member,
            );
            if (!field) throw new TypeError(`expected structural spread member ${member.name}`);
            const propertyName = member.name;
            const valueName = getGeneratedTargetName(`structuralSpreadField_${propertyName}`, context);
            // The member is present by construction. Its declared value domain is therefore the
            // contextual type; the optional marker belongs to the row cell and is added by
            // RowPartial when row_field initializes it.
            evaluations.push(`auto ${valueName} = ${emitExpression(member.value, context, field.property.type)};`);
            valueNames.set(propertyName, valueName);
          }
          const fields = closedSpreadConstruction.fields.map((field) => {
            const propertyName = field.kind === 'property' ? field.member.name : field.property.name;
            const valueName = valueNames.get(propertyName);
            if (!valueName) throw new TypeError(`expected structural spread field ${propertyName}`);
            return `flight::row_field<flight::RowKey<${JSON.stringify(propertyName)}>>(std::move(${valueName}))`;
          });
          context.includes.add('flight/structural_ref.hpp');
          context.includes.add('utility');
          return `([&]() { auto&& ${sourceName} = ${source}; ${evaluations.join(' ')} return flight::make_structural_ref<${emitCppStructuralRowSchemaTypeCpp(structuralRow, context)}>(${fields.join(', ')}); }())`;
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
      const constructionOwner = getCppTypeReferenceOwnerModuleCpp(constructionType, context);
      const emitPropertyValue = (property: (typeof properties)[number]): string => {
        const propertyType = getIrObjectPropertyTypeCpp(constructionType, property.name, context);
        return (
          (constructionOwner.packageName !== context.module.packageName && propertyType
            ? emitCppForeignAnonymousObjectValueCpp(property.value, propertyType, constructionOwner, context)
            : undefined) ?? emitExpression(property.value, context, propertyType)
        );
      };
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
      // A nominal-intersection implementation INHERITS the imported base's members rather than declaring them,
      // and a C++ designated initializer may name only direct non-static data members — naming an inherited
      // one is "no non-static data member named 'x'". The initializer therefore carries the struct's own
      // members and the inherited ones are assigned onto the constructed value. A base initializer cannot be
      // designated alongside the members either: C++ rejects a list that mixes an undesignated base clause
      // with designated member clauses.
      const nominalBase =
        constructionType.kind === 'intersection'
          ? getCppNominalIntersectionBaseCpp(constructionType, context)
          : undefined;
      const inheritedNames = new Set(nominalBase?.properties.map((property) => property.name) ?? []);
      const inheritedProperties = properties.filter((property) => inheritedNames.has(property.name));
      const reordered =
        orderedProperties.length === properties.length &&
        orderedProperties.some((property, index) => property !== properties[index]);
      if (reordered || inheritedProperties.length > 0) {
        const temporaries = new Map(
          properties.map(
            (property) => [property, getGeneratedTargetName(`object_member_${property.name}`, context)] as const,
          ),
        );
        const evaluations = properties.map(
          (property) => `auto ${temporaries.get(property)!} = ${emitPropertyValue(property)};`,
        );
        const initializer = `{${orderedProperties
          .filter((property) => !inheritedNames.has(property.name))
          .map((property) => `.${safeCppName(property.name)} = ${temporaries.get(property)!}`)
          .join(', ')}}`;
        if (inheritedProperties.length === 0) {
          return `(${context.namespaceScope ? '[]' : '[&]'}() { ${evaluations.join(' ')} return ${construction(initializer)}; }())`;
        }
        const constructed = getGeneratedTargetName('intersection_value', context);
        const assigned = inheritedProperties.map(
          (property) => `${constructed}->${safeCppName(property.name)} = ${temporaries.get(property)!};`,
        );
        return `(${context.namespaceScope ? '[]' : '[&]'}() { ${evaluations.join(' ')} auto ${constructed} = ${construction(initializer)}; ${assigned.join(' ')} return ${constructed}; }())`;
      }
      const initializer = `{${properties
        .map((property) => `.${safeCppName(property.name)} = ${emitPropertyValue(property)}`)
        .join(', ')}}`;
      return construction(initializer);
    }
    case 'property': {
      const enumMember = emitCppEnumMemberReferenceCpp(expression, context);
      if (enumMember) return enumMember;
      const narrowedPresent = emitCppNarrowedPresentAccessCpp(expression, context, expectedType);
      if (narrowedPresent) return narrowedPresent;
      if (expression.optional) return emitOptionalPropertyExpressionCpp(expression, context, expectedType);
      if (expression.member) assertCppPresentOptionalStorageMemberReceiverCpp(expression, context);
      if (getCppStructuralRowExpressionPlanCpp(expression.object, context)) {
        context.includes.add('flight/structural_ref.hpp');
        return `flight::row_get<flight::RowKey<${JSON.stringify(expression.name)}>>(${emitExpression(expression.object, context)})`;
      }
      // A resolved member names ONE receiver kind, and the analysis will resolve one across a union
      // whose alternatives agree on it -- `Float32Array | Uint8Array` both answer `length` as a typed
      // array's size method. Applying that spelling to the variant itself is what emitted
      // `out.size()` on a `std::variant`, which no variant has: the resolved member is evidence about
      // the alternatives, not about the storage they share. A variant receiver therefore goes to the
      // variant proof below, which is the only path that can spell an access reaching every
      // alternative -- or refuse when it cannot.
      const memberEvidence =
        expression.member ??
        (() => {
          const receiver = getCppExpressionMemberReceiverCpp(expression.object, context);
          return receiver ? ({ name: expression.name, receiver } as const) : undefined;
        })();
      if (memberEvidence && !isCppExpressionVariantUnionCpp(expression.object, context)) {
        const binding = getCompilerCppAmbientMemberBinding(memberEvidence, getCppRuntimeProfile(context.options));
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.object, context)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'sizeProperty') {
          return `static_cast<double>(${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${binding.targetName})`;
        }
        if (binding && binding.kind === 'property') {
          return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${binding.targetName}`;
        }
      }
      const namespaceMember = getCppNamespaceImportMemberTargetNameCpp(expression, context);
      if (namespaceMember) return namespaceMember;
      const commonVariantProperty = emitCppVariantCommonPropertyExpression(expression, context);
      if (commonVariantProperty) return commonVariantProperty;
      // The visitor above is the only spelling that reaches every alternative, so a read it could not
      // prove has no spelling at all: the alternatives are what the value could be, and the member
      // belongs to them rather than to the variant. Falling through here is what emitted `value.tag` on a
      // `std::variant` -- through a property, a call, or a type parameter's constraint -- so the refusal
      // is asked of the storage the read is taken from, not of how the receiver was written.
      if (isCppExpressionVariantStorageCpp(expression.object, context)) {
        // The receiver's own lanes answer first, in a context whose registrations are discarded: a
        // narrowed union member that cannot identify one alternative refuses with that message, which
        // names the narrowing the read depends on rather than the read itself.
        emitExpression(expression.object, { ...context, anonymousStructs: new Map(), includes: new Set() });
        emissionError(
          context,
          `property ${expression.name} on a C++ variant requires proven union member access`,
          'cpp-union-member-access-unguarded',
        );
      }
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
      const externalInstanceMember = getCppExternalInstanceMemberBindingCpp(expression, context);
      if (externalInstanceMember) {
        addCppExternalBindingHeaders(externalInstanceMember.sourceName, 'type', context);
        return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${externalInstanceMember.targetName}`;
      }
      const externalNumericProperty = emitCppExternalNumericPropertyViewPropertyCpp(expression, context);
      if (externalNumericProperty) return externalNumericProperty;
      if (expression.namespaceMember) {
        return `${emitExpression(expression.object, context)}::${safeCppName(expression.name)}`;
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
      // Storage that can be absent holds the value, and the member belongs to the value rather than to the
      // optional (or variant carrying absence) that stores it -- `texture.create_view()` names a member
      // `std::optional<...>` does not have. Every lane above either proved the read present or spelled it,
      // so reaching here means nothing did: the read refuses rather than being emitted against the
      // storage. A narrowing, an optional chain, or a visit is what proves it, and each has its own lane.
      if (
        expression.object.kind === 'identifier' &&
        expression.object.reference.kind === 'binding' &&
        isCppAbsenceCarryingExpressionCpp(expression.object, context)
      ) {
        emissionError(
          context,
          `property ${expression.name} on C++ absence-carrying storage requires narrowed access`,
          'cpp-optional-member-access-unproven',
        );
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
            ? emitCppExplicitStringConversionCpp(part, context)
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
        (expression.operator === '++' || expression.operator === '--' || expression.operator === 'delete') &&
        (expression.operand.kind === 'property' || expression.operand.kind === 'element') &&
        getCppExternalNumericPropertyViewAccessPlanCpp(expression.operand, context)
      ) {
        emissionError(
          context,
          'an external numeric-property view is read-only',
          'cpp-external-numeric-property-view-write',
        );
      }
      const structuralRowDelete = emitCppStructuralRowDeleteCpp(expression, context);
      if (structuralRowDelete) return structuralRowDelete;
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
        const closedKeyTypeof = emitCppClosedKeyElementTypeofCpp(expression.operand, context);
        if (closedKeyTypeof) return closedKeyTypeof;
        const value = getCppStaticTypeofValueCpp(expression.operand, context);
        if (value) {
          return getCppRuntimeProfile(context.options) === 'flight-cpp'
            ? `flight::String(${JSON.stringify(value)})`
            : `std::string(${JSON.stringify(value)})`;
        }
        // An erased dynamic value has no static type to fold, and it does not need one: the runtime
        // names the operation, and `Any::type_of` is ECMAScript `typeof` including the `null` that
        // reports `object`. Answering it at run time is what the value is for; folding it would be
        // claiming a shape the source did not state.
        const typeofOperandType = getCppNullishComparisonOperandTypeCpp(expression.operand, context);
        if (hasCppErasedDynamicTestOperandCpp(expression.operand, typeofOperandType, context)) {
          context.includes.add('flight/any.hpp');
          return `${emitExpression(expression.operand, context)}.type_of()`;
        }
        emissionError(context, 'typeof requires closed runtime type evidence');
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
      emissionError(
        context,
        `${expression.kind} expressions require C++ structured binding lowering`,
        `cpp-structured-binding-unsupported:${expression.kind}`,
      );
  }
}

// Template substitutions and the global String function perform JavaScript ToString conversion.
// A single-sentinel union uses std::optional for storage, but its representation plan still records
// whether absence came from null or undefined; that source distinction determines the text. Keep
// this conversion at the explicit source operation rather than teaching arbitrary optionals to
// stringify, and evaluate the substituted expression once before testing its presence.
function emitCppExplicitStringConversionCpp(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (expression.kind === 'literal' && expression.value === null) return 'flight::String("null")';
  if (
    expression.kind === 'undefinedValue' ||
    (expression.kind === 'identifier' &&
      expression.reference.kind === 'ambient' &&
      expression.reference.name === 'undefined')
  ) {
    return 'flight::String("undefined")';
  }
  const emitted = emitExpression(expression, context);
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  const union = type ? getIrUnionTypeCpp(type, context, new Set()) : undefined;
  if (!union) return `flight::to_string(${emitted})`;
  const plan = getCppUnionRepresentationPlan(union, context);
  if (plan.kind === 'singleValue') return `flight::to_string(${emitted})`;
  if (plan.kind === 'multiVariant') {
    context.includes.add('variant');
    return `std::visit([](const auto& value) { return flight::to_string(value); }, ${emitted})`;
  }
  if (plan.kind === 'dualSentinelVariant') {
    context.includes.add('flight/presence.hpp');
    context.includes.add('type_traits');
    context.includes.add('variant');
    return `std::visit([](const auto& value) -> flight::String { using Value = std::remove_cvref_t<decltype(value)>; if constexpr (std::is_same_v<Value, flight::Null>) return flight::String("null"); else if constexpr (std::is_same_v<Value, flight::Undefined>) return flight::String("undefined"); else return flight::to_string(value); }, ${emitted})`;
  }
  const absence = plan.sentinels.null === 'optionalAbsence' ? 'null' : 'undefined';
  context.includes.add('optional');
  if (plan.kind === 'optionalSingle') {
    return `([&]() { const auto& string_conversion_value = ${emitted}; return string_conversion_value.has_value() ? flight::to_string(string_conversion_value.value()) : flight::String("${absence}"); }())`;
  }
  context.includes.add('variant');
  return `([&]() -> flight::String { const auto& string_conversion_value = ${emitted}; if (!string_conversion_value.has_value()) return flight::String("${absence}"); return std::visit([](const auto& value) { return flight::to_string(value); }, string_conversion_value.value()); }())`;
}

function emitCppContextualStructuralReferenceCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const sourceType = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!sourceType) return undefined;
  const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
  if (!emitCppStructuralReferenceValueConversionCpp('source', sourceType, expectedType, isolatedContext)) {
    return undefined;
  }
  const source = emitExpression(expression, context, undefined, false);
  return emitCppStructuralReferenceValueConversionCpp(source, sourceType, expectedType, context);
}

function emitCppContextualVoidValueCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  if (expectedType.kind !== 'undefined') return undefined;
  const sourceType = getIrExpressionTypeEvidenceCpp(expression, context);
  if (sourceType?.kind !== 'primitive' || sourceType.name !== 'void') return undefined;
  // A JavaScript call declared `void` still produces the `undefined` value. C++ has no value of type
  // `void`, so materialize that sentinel only when a proven value position asks for it, after the
  // source expression has run and preserved its side effects.
  context.includes.add('flight/presence.hpp');
  return `(${emitExpression(expression, context)}, ${emitUndefinedWithExpectedTypeCpp(expectedType, context)})`;
}

function emitCppStructuralReferenceValueConversionCpp(
  source: string,
  sourceType: Readonly<IrType>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const preservesInterfaceStorage = isCppStructuralInterfaceStorageAliasCpp(sourceType, expectedType, context);
  if (preservesInterfaceStorage) return source;
  if (
    isCppStructuralInterfaceRepresentationAliasTypeCpp(sourceType, context) ||
    isCppStructuralInterfaceRepresentationAliasTypeCpp(expectedType, context)
  ) {
    return undefined;
  }
  const sourceRow = context.referenceRepresentationPlanner.resolveStructuralRow(sourceType, context.module);
  const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(expectedType, context.module);
  if (targetRow && !sourceRow) {
    const sourceProjection = getCppStructuralProjectionRowCpp(sourceType, context);
    if (!sourceProjection) return undefined;
    const sourceView = `${emitCppStructuralRowReferenceTypeCpp(sourceProjection, context)}(${source})`;
    return `flight::structural_ref_cast<${emitType(expectedType, context)}>(${sourceView})`;
  }
  if (sourceRow && targetRow) {
    if (normalizeCompilerStructuralValueCanonical(sourceRow) === normalizeCompilerStructuralValueCanonical(targetRow)) {
      return undefined;
    }
    const sourceObject = getCppStructuralRowObjectTypeCpp(sourceRow);
    const targetObject = getCppStructuralRowObjectTypeCpp(targetRow);
    if (
      !sourceObject ||
      !targetObject ||
      getCppOpenTypeParameterName(sourceObject) ||
      getCppOpenTypeParameterName(targetObject)
    ) {
      return undefined;
    }
    if (
      normalizeCompilerStructuralValueCanonical(sourceObject) ===
      normalizeCompilerStructuralValueCanonical(targetObject)
    ) {
      if (isCppStructuralRowReadonlyCpp(sourceRow) && !isCppStructuralRowReadonlyCpp(targetRow)) {
        emissionError(
          context,
          'a readonly structural row cannot be converted to a writable structural row',
          'cpp-structural-row-widening-unproven',
        );
      }
      return undefined;
    }
    const wideningProof = getCppStructuralRowObjectWideningProofCpp(sourceObject, targetObject, context);
    if (!wideningProof) return undefined;
    if (isCppStructuralRowReadonlyCpp(sourceRow) && !isCppStructuralRowReadonlyCpp(targetRow)) {
      emissionError(
        context,
        'a readonly structural row cannot be converted to a writable structural row',
        'cpp-structural-row-widening-unproven',
      );
    }
    if (wideningProof === 'unproven') {
      emissionError(
        context,
        'structural row conversion requires a resolved source shape that contains every target member',
        'cpp-structural-row-widening-unproven',
      );
    }
    context.includes.add('flight/structural_ref.hpp');
    return `flight::structural_ref_cast<${emitType(expectedType, context)}>(${source})`;
  }
  if (!sourceRow) return undefined;
  if (expectedType.kind === 'unknown' && expectedType.source === 'object') return `${source}.shared_object()`;
  const sourceObject = getCppStructuralRowObjectTypeCpp(sourceRow);
  // The callable may be declared in another package. Plan its parameter against the declaration
  // owner so an imported nominal reference retains the exact native identity carried by RowOf.
  const targetOwner =
    getCppDirectBindingOwner(expectedType, context) ??
    (expectedType.kind === 'named' ? getCppImportedBindingDeclarationCpp(expectedType, context) : undefined);
  const targetPlan = context.referenceRepresentationPlanner.plan(expectedType, targetOwner?.module ?? context.module);
  const projectsTarget =
    (sourceObject !== undefined && emitType(sourceObject, context) === emitType(expectedType, context)) ||
    hasCppStructuralRowObjectProjectionCpp(sourceRow, expectedType, context);
  if (
    targetPlan.kind !== 'represented' ||
    targetPlan.identityDomain !== 'object' ||
    targetPlan.valueRepresentation !== 'flightReference' ||
    !projectsTarget
  ) {
    return undefined;
  }
  context.includes.add('flight/structural_ref.hpp');
  return `flight::structural_ref_cast<${emitType(expectedType, context)}>(${source})`;
}

function isCppStructuralRowReadonlyCpp(row: Readonly<CompilerCppStructuralRowPlan>): boolean {
  switch (row.kind) {
    case 'readonly':
      return true;
    case 'partial':
    case 'required':
      return isCppStructuralRowReadonlyCpp(row.row);
    case 'merge':
    case 'rowOf':
    case 'writable':
      return false;
  }
}

// The runtime keeps the source object and owner when one structural row is read through a base row.
// That is safe only when the compiler can resolve both subjects and every target field is represented
// by the same C++ storage in the source. The shared structural analyzer supplies the source-language
// direction check; the exact field check mirrors the runtime member-table proof used by StructuralRef.
// An absent result leaves an incompatible, indeterminate, or empty pair to its established emission
// lane. Unproven is reserved for a compatible row conversion whose C++ storage cannot implement it.
function getCppStructuralRowObjectWideningProofCpp(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  context: EmitContext,
): 'proven' | 'unproven' | undefined {
  const sourceProperties = context.referenceRepresentationPlanner.resolveObjectShape(source, context.module);
  const targetProperties = context.referenceRepresentationPlanner.resolveObjectShape(target, context.module);
  if (!sourceProperties || !targetProperties) return undefined;
  if (
    analyzeIrTypeStructuralAssignability(
      { kind: 'object', properties: sourceProperties },
      { kind: 'object', properties: targetProperties },
    ).status !== 'compatible'
  ) {
    return undefined;
  }
  const sourceFields = new Map(
    sourceProperties
      .filter((property) => !property.phantom)
      .map((property) => [getCppStructuralRowPropertyIdentityCpp(property, context), property]),
  );
  const targetFields = targetProperties.filter((property) => !property.phantom);
  if (targetFields.length === 0) return undefined;
  return targetFields.every((property) => {
    const sourceProperty = sourceFields.get(getCppStructuralRowPropertyIdentityCpp(property, context));
    return (
      sourceProperty !== undefined &&
      sourceProperty.optional === property.optional &&
      emitType(sourceProperty.type, context) === emitType(property.type, context)
    );
  })
    ? 'proven'
    : 'unproven';
}

function getCppStructuralRowPropertyIdentityCpp(
  property: Readonly<IrObjectTypeProperty>,
  context: EmitContext,
): string {
  return property.computedKey
    ? `computed:${getCppComputedPropertySourceName(property.computedKey, context)}`
    : `named:${property.name}`;
}

// A record written into a slot that declares a DIFFERENT record of the same shape. TypeScript records
// are structural, so `readBitmap` returning one interface where another is declared is an ordinary
// assignment there; C++ makes those two structs distinct types and rejects it, however identical their
// members are. The conversion is member-wise and only where the members agree exactly: same names, same
// optionality, and the same emitted member type. That is the condition under which the source program
// was well typed, so nothing is bridged that the source would have refused.
//
// The source is materialized once rather than read per member, because the expression is arbitrary --
// a call, in every case this was written for -- and naming its members would evaluate it once per field.
function emitCppContextualStructuralRecordConversionCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const sourceType = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!sourceType) return undefined;
  // The probe emits into a context that keeps neither includes nor generated names, so a case this
  // function ends up declining leaves no trace of having been considered.
  const members = getCppStructuralRecordConversionMembersCpp(sourceType, expectedType, {
    ...context,
    anonymousStructs: new Map(),
    includes: new Set<string>(),
  });
  if (!members) return undefined;
  const source = emitExpression(expression, context, undefined, false);
  return createCppStructuralRecordConversionCpp(source, expectedType, members, context);
}

// The member names a conversion copies, in the order the TARGET declares them, or undefined when the two
// shapes are not the same record. Order is the target's because the initializer that consumes this list
// is a designated initializer, which C++ requires in declaration order.
function getCppStructuralRecordConversionMembersCpp(
  sourceType: Readonly<IrType>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): readonly string[] | undefined {
  if (!isCppRecordReferenceTypeCpp(sourceType) || !isCppRecordReferenceTypeCpp(expectedType)) return undefined;
  // Identity here is the TYPE each side is emitted as, not the binding each side was reached through. An
  // imported binding is a distinct binding from the declaring module's, so the same interface named in
  // two modules has two binding ids and one C++ type; comparing bindings would convert a value into the
  // type it already has. What is being bridged is precisely the case where the two spellings differ.
  const sourceTarget = emitType(sourceType, context);
  const expectedTarget = emitType(expectedType, context);
  if (sourceTarget === expectedTarget) return undefined;
  if (!getCppReferenceElementTypeNameCpp(expectedTarget)) return undefined;
  const sourceProperties = context.referenceRepresentationPlanner.resolveObjectShape(sourceType, context.module);
  const targetProperties = context.referenceRepresentationPlanner.resolveObjectShape(expectedType, context.module);
  if (!sourceProperties || !targetProperties || targetProperties.length === 0) return undefined;
  if (sourceProperties.length !== targetProperties.length) return undefined;
  const sourceByName = new Map(sourceProperties.map((property) => [property.name, property]));
  if (targetProperties.some((property) => !sourceByName.has(property.name))) return undefined;
  const equivalent = targetProperties.every((property) => {
    const source = sourceByName.get(property.name)!;
    return (
      source.optional === property.optional &&
      emitCppAliasResolvedValueTypeCpp(source.type, context) ===
        emitCppAliasResolvedValueTypeCpp(property.type, context)
    );
  });
  return equivalent ? targetProperties.map((property) => property.name) : undefined;
}

// A named reference to a declaration a module wrote -- an interface, a class, an alias, or an import of
// one -- with nothing applied to it. This is the narrowest spelling that admits a record and it is stated
// first because emitting is not total over IrType: an ambient name like `WeakMap` reaches a type the
// emitter can only spell with arguments it does not carry here, and the question being asked of the type
// is one the emitter would never ask of that slot.
function isCppRecordReferenceTypeCpp(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'named' &&
    type.reference.kind === 'binding' &&
    type.reference.binding.kind !== 'typeParameter' &&
    type.reference.path.length === 0 &&
    type.typeArguments.length === 0
  );
}

function createCppStructuralRecordConversionCpp(
  source: string,
  expectedType: Readonly<IrType>,
  members: readonly string[],
  context: EmitContext,
): string | undefined {
  const target = emitType(expectedType, context);
  const element = getCppReferenceElementTypeNameCpp(target);
  if (!element) return undefined;
  const sourceName = getGeneratedTargetName('structural_record_source', context);
  const initializers = members.map((member) => `.${member} = ${sourceName}->${member}`).join(', ');
  return `([&]() -> ${target} { const auto ${sourceName} = ${source}; return flight::make_ref<${element}>(${element}{${initializers}}); }())`;
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
  const sourceValues = sourceUnion.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  const expectedSentinels = expectedUnion.types.filter(
    (member): member is Extract<IrType, { kind: 'null' | 'undefined' }> =>
      member.kind === 'null' || member.kind === 'undefined',
  );
  const expectedValues = expectedUnion.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
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
  const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(expectedValues[0]!, context.module);
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
  // The property is `?`-marked and its own type carries one sentinel, so its STORAGE answers the same
  // three-state question the target asks: absent, null, and present. Reading it through `has_value()`
  // described the nested optional this representation replaced, and a variant has no such member — the
  // expression is emitted as a variant, so the read has to be the variant's own. The storage's plan is
  // therefore derived from the property's *effective* type, with the `?` marker contributing its absence
  // exactly as it does for the declaration; deriving it from the declared type alone is what lost it.
  const sourceReadUnion = getIrUnionTypeCpp(
    getIrObjectPropertyReadTypeCpp(property) ?? property.type,
    context,
    new Set(),
  );
  const sourceReadPlan = sourceReadUnion ? getCppUnionRepresentationPlan(sourceReadUnion, context) : undefined;
  if (sourceReadPlan?.kind !== 'dualSentinelVariant' || sourceReadPlan.valueSlots.length !== 1) return undefined;
  const propertyName = getGeneratedTargetName('optionalProperty', context);
  const propertyValue = emitExpression(expression, context, undefined, false);
  const targetType = expectedTargetType;
  const sourceValue = `std::get<${sourceReadPlan.valueSlots[0]!.targetType}>(${propertyName})`;
  const presentValue = structuralProjection ? `${targetType}(${sourceValue})` : sourceValue;
  const present = emitCppUnionValueConstruction(presentValue, targetType, expectedUnion, expectedPlan.kind, context);
  const declaredAbsence = emitCppUnionSentinelConstruction(
    declaredSourceSentinels[0]!.kind,
    expectedUnion,
    expectedPlan.kind,
    context,
  );
  const omitted = emitCppUnionSentinelConstruction('undefined', expectedUnion, expectedPlan.kind, context);
  const resultType = emitUnionTypeCpp(expectedUnion, context);
  const sentinels = getCppDualSentinelTargetTypes(context);
  context.includes.add('variant');
  return `([&]() -> ${resultType} { auto ${propertyName} = ${propertyValue}; if (std::holds_alternative<${sentinels.undefined}>(${propertyName})) return ${omitted}; if (std::holds_alternative<${sentinels.null}>(${propertyName})) return ${declaredAbsence}; return ${present}; }())`;
}

// An assertion is about the value its own type describes, so the subject it casts is that value. When a
// local's storage over-allocated absence — the source's guard narrowed the initializer, so the binding's
// evidence carries no absent member while the elected storage is an optional — the emitted binding IS the
// optional, and casting it hands `structural_ref_cast` a carrier no structural ref can be built from. The
// present value is the subject, and the evidence is what proves it is present: an evidence type with no
// absent member is the source saying this is not nullish here. A subject that genuinely admits absence is
// left alone, so an unproven access still refuses or reports rather than reading through `.value()`.
function emitCppAssertionSubjectCpp(expression: Readonly<IrExpression>, context: EmitContext): string {
  const emitted = emitExpression(expression, context);
  if (!hasCppAbsenceStorageCpp(expression, context)) return emitted;
  const storageType =
    expression.kind === 'identifier' && expression.reference.kind === 'binding'
      ? getCppBindingTypeCpp(expression.reference.binding.id, context)
      : undefined;
  const union = storageType ? getIrUnionTypeCpp(storageType, context, new Set()) : undefined;
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  if (plan?.kind !== 'optionalSingle') return emitted;
  context.includes.add('optional');
  return `${emitted}.value()`;
}

// `Math.hypot` is variadic in JavaScript: the square root of the sum of the squares of every argument, with
// no arguments the source's own zero and one argument the absolute value. `std::hypot` answers only the two-
// and three-argument forms, so every other arity needs composing rather than passing through — four arguments
// emitted as `std::hypot(x, y, z, w)` is a call to no overload at all. A left fold over the supported forms is
// exact: `hypot(hypot(a, b), c)` is `sqrt(hypot(a, b)^2 + c^2)`, which is `sqrt(a^2 + b^2 + c^2)`, and hypot's
// internal scaling keeps each intermediate finite for the same inputs the direct form would, so an infinity
// or a NaN propagates exactly as the source language does.
function emitCppMathHypotCallCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  const callee = expression.callee;
  if (
    callee.kind !== 'property' ||
    callee.object.kind !== 'identifier' ||
    callee.object.reference.kind !== 'ambient' ||
    callee.object.reference.name !== 'Math' ||
    callee.name !== 'hypot' ||
    expression.arguments.some((argument) => argument.kind === 'spread')
  ) {
    return undefined;
  }
  context.includes.add('cmath');
  const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context));
  if (arguments_.length === 0) return '0.0';
  if (arguments_.length === 1) return `std::abs(${arguments_[0]!})`;
  let folded = `std::hypot(${arguments_.slice(0, 3).join(', ')})`;
  for (const argument of arguments_.slice(3)) folded = `std::hypot(${folded}, ${argument})`;
  return folded;
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

function getCppStructuralOpenRowConstructionPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<CppStructuralOpenRowConstructionPlan> | undefined {
  if (expression.copySemantics || type.kind !== 'intersection') return undefined;
  const openRows = type.types.filter((member) => isCppOpenStructuralRowTypeParameterCpp(member, context));
  if (openRows.length !== 1) return undefined;
  const fixedRows = type.types.filter((member) => member !== openRows[0]);
  const fixedShapes = fixedRows.map((member) =>
    context.referenceRepresentationPlanner.resolveObjectShape(member, context.module),
  );
  if (fixedShapes.length === 0 || fixedShapes.some((shape) => !shape)) return undefined;
  const fixedProperties = fixedShapes.flatMap((shape) => shape!);
  const propertiesByName = new Map<string, Readonly<IrObjectTypeProperty>>();
  const computedProperties = new Map<string, Readonly<IrObjectTypeProperty>>();
  for (const property of fixedProperties) {
    if (property.phantom) continue;
    if (property.computedKey) {
      const key = getCppComputedPropertySourceName(property.computedKey, context);
      if (computedProperties.has(key)) return undefined;
      computedProperties.set(key, property);
      continue;
    }
    if (propertiesByName.has(property.name)) return undefined;
    propertiesByName.set(property.name, property);
  }
  // The runtime symbol slot is the evidence that this is the entity-style allocation boundary. A
  // plain `{ fixed } as Fixed & T` assertion says nothing about how the unknown row would be stored.
  if (computedProperties.size === 0) return undefined;
  const fields: CppStructuralOpenRowConstructionField[] = [];
  const constructedProperties = new Set<Readonly<IrObjectTypeProperty>>();
  for (const member of expression.members) {
    if (member.kind !== 'property' && member.kind !== 'computedProperty') return undefined;
    let property: Readonly<IrObjectTypeProperty> | undefined;
    if (member.kind === 'property') {
      property = propertiesByName.get(member.name);
    } else if (member.kind === 'computedProperty') {
      const key = getIrExpressionValueNameReferenceCpp(member.key);
      property = key ? computedProperties.get(getCppComputedPropertySourceName(key, context)) : undefined;
    }
    if (!property || constructedProperties.has(property)) return undefined;
    constructedProperties.add(property);
    fields.push({ member, property });
  }
  const straightLineAssignments = context.structuralOpenRowConstructionAssignments.get(expression) ?? new Set();
  for (const property of [...propertiesByName.values(), ...computedProperties.values()]) {
    if (property.optional || constructedProperties.has(property)) continue;
    if (!property.computedKey && straightLineAssignments.has(property.name)) continue;
    return undefined;
  }
  return { fields };
}

// A spread object names runtime copy semantics, but a closed structural row can implement the common
// construction form without cloning either reference: read each proven source cell once and place that
// value in the new target row. Keep the accepted form deliberately narrow. One leading spread followed
// by distinct named properties has a complete source shape proving that no enumerable field is silently
// dropped. A named property may replace a source cell, but emission must still read that source cell
// before evaluating the replacement. Every value is bound in source order because C++ function-argument
// evaluation order cannot carry the source language's ordering guarantee.
function getCppStructuralClosedRowSpreadConstructionPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  type: Readonly<IrType>,
  row: Readonly<CompilerCppStructuralRowPlan>,
  context: EmitContext,
): Readonly<CppStructuralClosedRowSpreadConstructionPlan> | undefined {
  if (!expression.copySemantics || expression.members.length < 2) return undefined;
  const [spread, ...members] = expression.members;
  if (spread?.kind !== 'spread' || members.some((member) => member.kind !== 'property')) return undefined;

  const targetObject = getCppStructuralRowObjectTypeCpp(row);
  if (
    !targetObject ||
    (!getCppNominalTypeDeclarationOwnerCpp(targetObject, context.module, context) &&
      !(targetObject.kind === 'object' && getCppStructuralRowOverrideAliasOwnerCpp(type, context.module, context)))
  ) {
    return undefined;
  }
  const targetPlan = context.referenceRepresentationPlanner.plan(targetObject, context.module);
  if (
    targetPlan.kind !== 'represented' ||
    targetPlan.identity.identity !== 'reference' ||
    targetPlan.identityDomain !== 'object' ||
    targetPlan.valueRepresentation !== 'flightReference'
  ) {
    return undefined;
  }

  const targetProperties = context.referenceRepresentationPlanner.resolveObjectShape(type, context.module);
  const sourceType = getIrExpressionTypeEvidenceCpp(spread.expression, context);
  const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
  const sourceUnion = sourceType ? getIrUnionTypeCpp(sourceType, context, new Set()) : undefined;
  const sourceUnionPlan = sourceUnion ? getCppUnionRepresentationPlan(sourceUnion, isolatedContext) : undefined;
  const sourceMayBeAbsent = sourceUnionPlan?.kind === 'optionalSingle';
  const sourceObjectType = sourceMayBeAbsent
    ? getCppNonNullableType(sourceType!, context, new Set())
    : sourceUnion
      ? undefined
      : sourceType;
  const sourceProperties = sourceObjectType
    ? context.referenceRepresentationPlanner.resolveObjectShape(sourceObjectType, context.module)
    : undefined;
  if (!targetProperties || !sourceType || !sourceObjectType || !sourceProperties) return undefined;
  if (sourceProperties.some((property) => property.computedKey || property.phantom)) return undefined;

  const targetByName = new Map(
    targetProperties
      .filter((property) => !property.computedKey && !property.phantom)
      .map((property) => [property.name, property] as const),
  );
  const explicitByName = new Map<
    string,
    Readonly<{
      member: Readonly<Extract<IrObjectMember, { kind: 'property' }>>;
      property: Readonly<IrObjectTypeProperty>;
    }>
  >();
  for (const member of members) {
    if (member.kind !== 'property') return undefined;
    const property = targetByName.get(member.name);
    if (!property || explicitByName.has(member.name)) return undefined;
    explicitByName.set(member.name, { member, property });
  }
  const sourceKind = context.referenceRepresentationPlanner.resolveStructuralRow(sourceObjectType, context.module)
    ? ('structuralRow' as const)
    : hasFlightReferenceRepresentationCpp(sourceObjectType, context)
      ? ('reference' as const)
      : undefined;
  if (!sourceKind) return undefined;

  const fields: CppStructuralClosedRowSpreadConstructionPlan['fields'][number][] = [];
  const supplied = new Set<string>();
  const overridden = new Set<string>();
  for (const sourceProperty of sourceProperties) {
    const targetProperty = targetByName.get(sourceProperty.name);
    const explicit = explicitByName.get(sourceProperty.name);
    if (
      !targetProperty ||
      supplied.has(sourceProperty.name) ||
      (!explicit &&
        (Boolean(sourceMayBeAbsent && !sourceProperty.optional) ||
          sourceProperty.role !== targetProperty.role ||
          (sourceProperty.optional && !targetProperty.optional) ||
          !context.referenceRepresentationPlanner.isStructurallyAssignable(
            sourceProperty.type,
            targetProperty.type,
            context.module,
          ) ||
          getCppStructuralClosedRowCellStorageTypeCpp(sourceProperty.type, isolatedContext) !==
            getCppStructuralClosedRowCellStorageTypeCpp(targetProperty.type, isolatedContext)))
    ) {
      return undefined;
    }
    supplied.add(sourceProperty.name);
    if (explicit) {
      overridden.add(sourceProperty.name);
      fields.push({ kind: 'overriddenSpread', sourceProperty, ...explicit });
    } else {
      fields.push({ kind: 'spread', property: sourceProperty });
    }
  }
  for (const member of members) {
    if (member.kind !== 'property') return undefined;
    if (overridden.has(member.name)) continue;
    const property = targetByName.get(member.name);
    if (!property || supplied.has(member.name)) return undefined;
    supplied.add(member.name);
    fields.push({ kind: 'property', member, property });
  }
  if (
    targetProperties.some(
      (property) => !property.phantom && !property.optional && (property.computedKey || !supplied.has(property.name)),
    )
  ) {
    return undefined;
  }
  return { fields, source: spread.expression, sourceKind, sourceMayBeAbsent, sourceType };
}

function getCppStructuralClosedRowCellStorageTypeCpp(type: Readonly<IrType>, context: EmitContext): string {
  let resolved = type;
  const aliases = new Set<string>();
  for (;;) {
    const key = normalizeCompilerStructuralValueCanonical(resolved);
    if (aliases.has(key)) break;
    aliases.add(key);
    const alias = context.referenceRepresentationPlanner.resolveAlias(resolved, context.module);
    if (!alias) break;
    resolved = alias;
  }
  return emitType(resolved, context);
}

function hasCppOpenStructuralRowTypeParameterCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  return (
    type.kind === 'intersection' && type.types.some((member) => isCppOpenStructuralRowTypeParameterCpp(member, context))
  );
}

function isCppOpenStructuralRowTypeParameterCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  const declaration = getCppTypeParameterDeclarationCpp(type, context);
  return declaration?.constraint?.kind === 'unknown' && declaration.constraint.source === 'object';
}

function getCppStructuralCloneRecordViewPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): CppStructuralCloneRecordViewPlan | undefined {
  // A generic object spread has one representation proof a plain Record does not: a constrained
  // Flight reference names the concrete C++ referent at template instantiation. Copy that referent
  // into fresh ownership and retain its row; do not turn arbitrary Record assertions into this path.
  if (
    getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
    !isCppUnknownRecordTypeCpp(expression.type, 'PropertyKey') ||
    expression.expression.kind !== 'object' ||
    expression.expression.members.length !== 1 ||
    expression.expression.members[0]?.kind !== 'spread'
  ) {
    return undefined;
  }
  const source = expression.expression.members[0].expression;
  const sourceType = getIrExpressionTypeEvidenceCpp(source, context);
  const typeParameter = getCppReadonlyBareTypeParameterCpp(sourceType);
  const sourceRow = sourceType
    ? context.referenceRepresentationPlanner.resolveStructuralRow(sourceType, context.module)
    : undefined;
  const sourceObject = sourceRow ? getCppStructuralRowObjectTypeCpp(sourceRow) : undefined;
  const declaration = typeParameter ? getCppTypeParameterDeclarationCpp(typeParameter, context) : undefined;
  const constraintProperties = declaration?.constraint
    ? context.referenceRepresentationPlanner.resolveObjectShape(declaration.constraint, context.module)
    : undefined;
  if (
    !sourceType ||
    !typeParameter ||
    !sourceRow ||
    !sourceObject ||
    normalizeCompilerStructuralValueCanonical(sourceObject) !==
      normalizeCompilerStructuralValueCanonical(typeParameter) ||
    !declaration?.constraint ||
    !hasFlightReferenceRepresentationCpp(declaration.constraint, context) ||
    !constraintProperties?.some(
      (property) => property.computedKey && (property.optional || hasIrTypeAbsentMember(property.type)),
    )
  ) {
    return undefined;
  }
  return {
    row: { kind: 'writable', row: { kind: 'rowOf', type: typeParameter } },
    source,
    sourceType,
    typeParameter,
  };
}

function emitCppStructuralCloneRecordRecoveryCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): string | undefined {
  // Only the binding recorded by the clone construction above may recover its original generic
  // identity. Matching row spellings alone would make an unrelated `as Type` assertion a cast rule.
  const source =
    expression.expression.kind === 'cast' &&
    expression.expression.type.kind === 'unknown' &&
    expression.expression.type.source === 'unknown'
      ? expression.expression.expression
      : expression.expression;
  if (source.kind !== 'identifier' || source.reference.kind !== 'binding') return undefined;
  if (!context.structuralCloneRecordBindingIds.has(source.reference.binding.id)) return undefined;
  const row = context.structuralCastBindingRows.get(source.reference.binding.id);
  const sourceObject = row ? getCppStructuralRowObjectTypeCpp(row) : undefined;
  const targetObject = getCppReferencePreservingProjectionSubjectCpp(expression.type, context);
  if (
    !row ||
    !sourceObject ||
    !targetObject ||
    normalizeCompilerStructuralValueCanonical(sourceObject) !== normalizeCompilerStructuralValueCanonical(targetObject)
  ) {
    return undefined;
  }
  context.includes.add('flight/structural_ref.hpp');
  return `flight::structural_ref_cast<${emitType(expression.type, context)}>(${emitExpression(source, context)})`;
}

function getCppReferencePreservingProjectionSubjectCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'binding' &&
    type.reference.binding.kind === 'typeParameter' &&
    type.reference.path.length === 0 &&
    type.typeArguments.length === 0
  ) {
    return type;
  }
  const target =
    type.kind === 'named' && type.reference.kind === 'binding' ? resolveCppTypeAliasTarget(type, context) : type;
  if (
    target?.kind !== 'named' ||
    target.reference.kind !== 'ambient' ||
    target.reference.name !== 'Omit' ||
    target.typeArguments.length !== 2 ||
    !target.typeArguments[0]
  ) {
    return undefined;
  }
  return hasFlightReferenceRepresentationCpp(target.typeArguments[0], context) ? target.typeArguments[0] : undefined;
}

function isCppUnprovenGenericRecordAssertionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): boolean {
  if (
    expression.type.kind !== 'named' ||
    expression.type.reference.kind !== 'binding' ||
    expression.type.reference.binding.kind !== 'typeParameter' ||
    expression.type.reference.path.length !== 0 ||
    expression.type.typeArguments.length !== 0
  ) {
    return false;
  }
  const source =
    expression.expression.kind === 'cast' &&
    expression.expression.type.kind === 'unknown' &&
    expression.expression.type.source === 'unknown'
      ? expression.expression.expression
      : expression.expression;
  const sourceType = getIrExpressionTypeEvidenceCpp(source, context);
  return Boolean(getCppRecordTypeArgumentsCpp(sourceType, context, new Set()));
}

function isCppUnknownRecordTypeCpp(type: Readonly<IrType>, key: 'PropertyKey' | 'string'): boolean {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'ambient' ||
    type.reference.name !== 'Record' ||
    type.typeArguments.length !== 2 ||
    type.typeArguments[1]?.kind !== 'unknown' ||
    type.typeArguments[1].source !== 'unknown'
  ) {
    return false;
  }
  const keyType = type.typeArguments[0];
  return key === 'string'
    ? keyType?.kind === 'primitive' && keyType.name === 'string'
    : keyType?.kind === 'named' &&
        keyType.reference.kind === 'ambient' &&
        keyType.reference.name === 'PropertyKey' &&
        keyType.typeArguments.length === 0;
}

// Whether a type is one whose named properties the runtime can enumerate and read: a generated object
// held by reference, or a structural row. It is the same question `flight::named_properties` answers,
// asked before emitting so an unproven receiver is refused rather than handed to an overload that will
// not accept it.
function isCppNamedPropertiesSourceCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module)) return true;
  const runtime = getIrTypeRuntimeDomainCpp(type, context, new Set());
  return Boolean(runtime && hasFlightReferenceRepresentationCpp(runtime, context));
}

// The object a `value as unknown as Record<string, unknown>` dynamic view reads through, or undefined
// when the expression is not that view.
//
// The cast is how the SDK makes a dynamic named read type-check, and the inner `as unknown` is the
// compiler's own erased marker rather than something the source wrote, so both are seen through. The
// result is the view the runtime builds, not a `Record`: `Record<string, unknown>` here names a set of
// properties to read by name, and only a structural object has those.
function getCppNamedPropertiesViewSourceCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrExpression> | undefined {
  if (expression.kind !== 'cast' || getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  if (!isCppUnknownRecordTypeCpp(expression.type, 'string')) return undefined;
  // A constructed object is not what this view is for. `Object.keys(host)` enumerates the properties an
  // object was GIVEN, and an object literal's properties are the ones the compiler just wrote -- its
  // shape is already known, so a dynamic view over it would be asking the runtime a question the
  // emitter can answer. Letting the literal through here would also take it from the lane that owns it.
  if (expression.expression.kind === 'object') return undefined;
  const inner = expression.expression;
  const source =
    inner.kind === 'cast' && inner.type.kind === 'unknown' && inner.type.source === 'unknown'
      ? inner.expression
      : inner;
  const sourceType = getIrExpressionTypeEvidenceCpp(source, context);
  return sourceType && isCppNamedPropertiesSourceCpp(sourceType, context) ? source : undefined;
}

// Whether an expression holds a dynamic named view, which is what makes `view[name]` a `get` rather
// than a subscript. A binding is asked for its recorded INITIALIZER rather than its declared type,
// because `Record<string, unknown>` is also the declared type of a real `flight::Record`, and only the
// initializer says which storage the declaration elected.
// `Object.keys` and `Object.entries` over an object whose properties the runtime enumerates by name.
//
// The generic binding for these is an external profile symbol, and it cannot serve this case: the
// runtime's `object_keys`/`object_entries` take a `Record` or a container with `begin()`/`end()`, and a
// structural object is neither. The runtime's named-property view is, and it hands the keys back in
// source declaration order, so the emitter adds no ordering of its own.
function emitCppNamedPropertiesEnumerationCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  if (expression.arguments.length !== 1) return undefined;
  if (expression.callee.kind !== 'property' || expression.callee.optional) return undefined;
  const member = expression.callee.name;
  if (member !== 'keys' && member !== 'entries') return undefined;
  if (!isCppAmbientObjectMemberCallCpp(expression, member)) return undefined;
  const argument = expression.arguments[0]!;
  // An argument that already IS a view is the view; one that is an object is enumerated by asking the
  // runtime for its view. Wrapping a view in `named_properties` again would be a call the runtime has no
  // overload for, because a view is not an object with properties -- it is the handle on one.
  const argumentIsView = getCppNamedPropertiesViewExpressionCpp(argument, context);
  if (!argumentIsView) {
    const sourceType = getIrExpressionTypeEvidenceCpp(argument, context);
    if (!sourceType || !isCppNamedPropertiesSourceCpp(sourceType, context)) return undefined;
  }
  context.includes.add('flight/structural_ref.hpp');
  const source = emitExpression(argument, context);
  const viewExpression = argumentIsView ? source : `flight::named_properties(${source})`;
  const viewName = getGeneratedTargetName('named_view', context);
  if (member === 'keys') {
    const keysName = getGeneratedTargetName('named_keys', context);
    return `([&]() { const auto ${viewName} = ${viewExpression}; const auto ${keysName} = ${viewName}.keys(); return flight::Array<flight::String>(${keysName}.begin(), ${keysName}.end()); }())`;
  }
  context.includes.add('tuple');
  const entriesName = getGeneratedTargetName('named_entries', context);
  const keyName = getGeneratedTargetName('named_key', context);
  return `([&]() { const auto ${viewName} = ${viewExpression}; flight::Array<std::tuple<flight::String, flight::Any>> ${entriesName}; for (const auto& ${keyName} : ${viewName}.keys()) { ${entriesName}.push(std::tuple<flight::String, flight::Any>(${keyName}, ${viewName}.get(${keyName}))); } return ${entriesName}; }())`;
}

// The storage a declaration elected for a dynamic named view is the runtime's view itself, not the
// `Record` its declared type names. `flight::Record` and `flight::NamedProperties` are different things
// with different operations: one is storage the program owns, the other is a handle on properties that
// already exist on an object. The declared type cannot tell them apart, so the initializer decides.
function getCppNamedPropertiesStorageTypeCpp(
  initializer: Readonly<IrExpression> | undefined,
  context: EmitContext,
): string | undefined {
  if (!initializer || !getCppNamedPropertiesViewSourceCpp(initializer, context)) return undefined;
  context.includes.add('flight/structural_ref.hpp');
  return 'flight::NamedProperties';
}

function getCppNamedPropertiesViewExpressionCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (getCppNamedPropertiesViewSourceCpp(expression, context)) return true;
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return false;
  // A clone projection is a structural row reference, not a view. It is reached through the same
  // object-spread-to-`Record` cast syntax, and the clone lane owns what it means, so this lane must not
  // claim it -- a write to a clone projection is the clone lane's own refusal to give.
  if (context.structuralCloneRecordBindingIds.has(expression.reference.binding.id)) return false;
  const initializer = context.bindingInitializers.get(expression.reference.binding.id);
  return initializer !== undefined && getCppNamedPropertiesViewSourceCpp(initializer, context) !== undefined;
}

// Whether an index names a string key. The view reports own enumerable STRING keys, so a symbol key is a
// different property that this view cannot see and a number would have to be coerced to a spelling the
// compiler would be choosing on the source's behalf. Both are refused rather than guessed at.
function isCppStringKeyIndexCpp(index: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeEvidenceCpp(index, context);
  if (!type) return false;
  if (type.kind === 'literal') return typeof type.value === 'string';
  return type.kind === 'primitive' && type.name === 'string';
}

// Whether an expression is bound to the `value as unknown as Record<string, unknown>` view the source
// writes to reach a dynamic read. Narrower than the view test on purpose: the write refusal must catch
// only the view, and an object spread cast reaches a different lane whose refusals are its own.
function isCppNamedPropertiesErasedMarkerViewCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return false;
  const initializer = context.bindingInitializers.get(expression.reference.binding.id);
  if (!initializer || initializer.kind !== 'cast') return false;
  const inner = initializer.expression;
  return (
    inner.kind === 'cast' &&
    inner.type.kind === 'unknown' &&
    inner.type.source === 'unknown' &&
    getCppNamedPropertiesViewSourceCpp(initializer, context) !== undefined
  );
}

function getCppReadonlyBareTypeParameterCpp(type: Readonly<IrType> | undefined): Readonly<IrType> | undefined {
  if (
    type?.kind !== 'named' ||
    type.reference.kind !== 'ambient' ||
    type.reference.name !== 'Readonly' ||
    type.typeArguments.length !== 1
  ) {
    return undefined;
  }
  const argument = type.typeArguments[0];
  return argument?.kind === 'named' &&
    argument.reference.kind === 'binding' &&
    argument.reference.binding.kind === 'typeParameter' &&
    argument.reference.path.length === 0 &&
    argument.typeArguments.length === 0
    ? argument
    : undefined;
}

function getCppTypeParameterDeclarationCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<IrTypeParameter> | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind !== 'typeParameter' ||
    type.reference.path.length !== 0 ||
    type.typeArguments.length !== 0
  ) {
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  const active = context.anonymousStructTypeParameters.find((parameter) => parameter.binding.id === bindingId);
  if (active) return active;
  for (const declaration of context.module.declarations) {
    if (!('typeParameters' in declaration)) continue;
    const parameter = declaration.typeParameters.find((candidate) => candidate.binding.id === bindingId);
    if (parameter) return parameter;
  }
  return undefined;
}

function hasCppStructuralRowObjectProjectionCpp(
  row: Readonly<CompilerCppStructuralRowPlan>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  // A merged row can recover only an object explicitly carried by one of its RowOf branches. A
  // target that merely happens to compile to a reference spelling is not projection evidence.
  if (row.kind === 'rowOf') return emitType(row.type, context) === emitType(target, context);
  if (row.kind === 'merge')
    return row.rows.some((member) => hasCppStructuralRowObjectProjectionCpp(member, target, context));
  return hasCppStructuralRowObjectProjectionCpp(row.row, target, context);
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

// A for-of binding is stored as the collection's element type, but TypeScript can report a flow-expanded
// anonymous object for the binding while retaining the named declaration on the iterable. Keep that
// source identity only when the two complete, non-nullable unions have a one-to-one runtime-shape
// mapping. The later narrowing rule still has to identify one source alternative by name; this proof
// only prevents the loop boundary from discarding the names that the collection actually stores.
function hasUniqueCppForOfSourceAlternativeMapping(
  bindingType: Readonly<IrType>,
  sourceType: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const bindingUnion = getIrUnionTypeCpp(bindingType, context, new Set());
  const sourceUnion = getIrUnionTypeCpp(sourceType, context, new Set());
  if (!bindingUnion || !sourceUnion) return false;
  if (
    bindingUnion.types.some((member) => member.kind === 'null' || member.kind === 'undefined') ||
    sourceUnion.types.some((member) => member.kind === 'null' || member.kind === 'undefined')
  ) {
    return false;
  }
  const inspectionContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
  const bindingPlan = getCppUnionRepresentationPlan(bindingUnion, inspectionContext);
  const sourcePlan = getCppUnionRepresentationPlan(sourceUnion, inspectionContext);
  if (
    bindingPlan.kind !== 'multiVariant' ||
    sourcePlan.kind !== 'multiVariant' ||
    bindingPlan.valueSlots.length !== sourcePlan.valueSlots.length
  ) {
    return false;
  }
  const unmatchedBindingSlots = new Set(bindingPlan.valueSlots.keys());
  for (const sourceSlot of sourcePlan.valueSlots) {
    const matches = [...unmatchedBindingSlots].filter((index) =>
      areCppForOfSourceAlternativeShapesEquivalent(
        sourceSlot.runtimeType,
        bindingPlan.valueSlots[index]!.runtimeType,
        context,
      ),
    );
    if (matches.length !== 1) return false;
    unmatchedBindingSlots.delete(matches[0]!);
  }
  return unmatchedBindingSlots.size === 0;
}

function areCppForOfSourceAlternativeShapesEquivalent(
  left: Readonly<IrType>,
  right: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  const leftShape = context.referenceRepresentationPlanner.resolveObjectShape(left, context.module);
  const rightShape = context.referenceRepresentationPlanner.resolveObjectShape(right, context.module);
  return Boolean(leftShape && rightShape && areCppObjectShapesRepresentationEquivalent(leftShape, rightShape, context));
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
            statement.variable.type.elements.some((element) => element.type.kind === 'unknown')) ||
          hasUniqueCppForOfSourceAlternativeMapping(statement.variable.type, iterableElementType, context))
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
      const narrowedIndexedStorageType =
        iterableExpression.kind === 'identifier' &&
        iterableExpression.reference.kind === 'binding' &&
        // An indexed Record read has optional C++ storage even though its source type names only the
        // value. A preceding terminating nullish guard records the present payload in this context.
        context.arrayElementBindingIds.has(iterableExpression.reference.binding.id) &&
        context.narrowedBindingTypes.has(iterableExpression.reference.binding.id)
          ? iterableType
          : undefined;
      const iterable = emitExpression(iterableExpression, context, literalElementType ?? narrowedIndexedStorageType);
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
      const evidence =
        statement.condition.kind === 'binary' ? statement.condition.semantics.unionMemberTest : undefined;
      const lines = [
        `if (${emitCppTruthinessExpression(statement.condition, context)}) {`,
        ...indentSourceLines(
          emitStatementBody(statement.consequent, getCppUnionMemberTestBranchContextCpp(evidence, true, context)),
        ),
        '}',
      ];
      if (statement.otherwise)
        lines.push(
          'else {',
          ...indentSourceLines(
            emitStatementBody(statement.otherwise, getCppUnionMemberTestBranchContextCpp(evidence, false, context)),
          ),
          '}',
        );
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
      if (
        statement.expression.kind === 'identifier' &&
        statement.expression.reference.kind === 'binding' &&
        context.exceptionPointerBindingIds.has(statement.expression.reference.binding.id)
      ) {
        context.includes.add('exception');
        return [`std::rethrow_exception(${emitExpression(statement.expression, context)});`];
      }
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
  const emitted: string[] = [];
  let statementContext = context;
  for (const [index, statement] of statements.entries()) {
    // The nullable source local changes representation across its guard: before the guard it denotes
    // absence or erased backing storage, and afterwards it denotes a typed view. Recognize that whole
    // prologue before emitting its first declaration so the view can never bind to the fresh typed map.
    const nullableWeakMapView = getCppNullableErasedRefWeakMapViewPlan(
      statement,
      statements[index + 1],
      statementContext,
    );
    if (nullableWeakMapView) refuseCppErasedRefWeakMapView(statementContext, true);
    emitted.push(...emitStatement(statement, statementContext));
    const narrowing = getCppOptionalStoragePresentGuardNarrowingCpp(statement, statementContext);
    if (narrowing) {
      statementContext = {
        ...statementContext,
        narrowedBindingTypes: new Map(statementContext.narrowedBindingTypes).set(narrowing.bindingId, narrowing.type),
      };
    }
    statementContext = withdrawCppAssignedNarrowingsCpp(statement, statementContext);
  }
  return emitted;
}

// A statement that writes a narrowed binding withdraws the narrowing for the statements after it. The
// proof the guard carried was about the value it tested, and a write is a value the guard said nothing
// about: `if (texture === null) return; texture = null; texture.create_view()` reads a proof that is no
// longer true, and the read after the write has to resolve without one -- which either finds its own
// proof or refuses.
function withdrawCppAssignedNarrowingsCpp(statement: Readonly<IrStatement>, context: EmitContext): EmitContext {
  if (context.narrowedBindingTypes.size === 0) return context;
  const withdrawn = collectCppAssignedBindingIdsCpp(statement).filter((bindingId) =>
    context.narrowedBindingTypes.has(bindingId),
  );
  if (withdrawn.length === 0) return context;
  const narrowedBindingTypes = new Map(context.narrowedBindingTypes);
  for (const bindingId of withdrawn) narrowedBindingTypes.delete(bindingId);
  return { ...context, narrowedBindingTypes };
}

function collectCppAssignedBindingIdsCpp(statement: Readonly<IrStatement>): readonly string[] {
  const bindingIds = new Set<string>();
  analyzeIrStatementSubtreeTraversal(statement, {
    expression(expression) {
      if (
        expression.kind === 'assignment' &&
        expression.left.kind === 'identifier' &&
        expression.left.reference.kind === 'binding'
      ) {
        bindingIds.add(expression.left.reference.binding.id);
      }
    },
  });
  return [...bindingIds];
}

// A terminating nullish guard proves subsequent statements see the present payload. Most such reads
// carry checker narrowing on each identifier. Backend-elected optional storage for an indexed read is
// different: its source type already excludes absence, so there is no source union for the checker to
// narrow. Retain the guard in the statement context for that storage boundary and for closures whose
// capture evidence likewise does not carry target-specific flow.
function getCppOptionalStoragePresentGuardNarrowingCpp(
  statement: Readonly<IrStatement>,
  context: EmitContext,
): Readonly<{ bindingId: string; type: Readonly<IrType> }> | undefined {
  if (
    statement.kind !== 'if' ||
    statement.otherwise ||
    !isCppAbruptCompletionStatement(statement.consequent) ||
    statement.condition.kind !== 'binary' ||
    !['==', '==='].includes(statement.condition.operator) ||
    !statement.condition.semantics.nullishComparison
  ) {
    return undefined;
  }
  const leftSentinel = getCppNullishLiteralKind(statement.condition.left);
  const rightSentinel = getCppNullishLiteralKind(statement.condition.right);
  if ((leftSentinel ? 1 : 0) + (rightSentinel ? 1 : 0) !== 1) return undefined;
  const operand = leftSentinel ? statement.condition.right : statement.condition.left;
  if (operand.kind !== 'identifier' || operand.reference.kind !== 'binding') return undefined;
  const bindingId = operand.reference.binding.id;
  if (
    !context.capturedReferentOnlyBindingIds.has(bindingId) &&
    !context.nullableBindingIds.has(bindingId) &&
    !context.arrayElementBindingIds.has(bindingId)
  ) {
    return undefined;
  }
  const evidence = statement.condition.semantics.nullishComparison;
  const testsEveryAbsentMember =
    statement.condition.operator === '==' ||
    (evidence.literal === 'null' ? !evidence.admitsUndefined : !evidence.admitsNull);
  if (!testsEveryAbsentMember) return undefined;
  const bindingType = getCppBindingTypeCpp(bindingId, context);
  const present = bindingType ? getCppNonNullableType(bindingType, context, new Set()) : undefined;
  return present ? { bindingId, type: present } : undefined;
}

function isCppAbruptCompletionStatement(statement: Readonly<IrStatement>): boolean {
  if (statement.kind === 'return' || statement.kind === 'throw') return true;
  return statement.kind === 'block' && Boolean(statement.statements.at(-1))
    ? isCppAbruptCompletionStatement(statement.statements.at(-1)!)
    : false;
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

// The member type of a dependent parameter, spelled the way the runtime already spells it. `remove_cvref_t`
// makes an optional member and a plain one agree, because an optional member's C++ storage is the target's
// spelling of `U | undefined` rather than `U`.
//
// The dependent form is emitted only where the member is PROVEN on every inhabited branch of the
// parameter's constraint, because the instantiation is not visible here. An unproven key does not fail
// while emitting -- it produces a template that fails inside whichever module first instantiates it,
// naming no declaration and pointing at no source, so the refusal has to happen while the declaration is
// still in hand. The gate keeps the dependent spelling rather than rewriting it to the constraint's
// member type: a constraint says the member exists, not what it is, and an instantiation may narrow it
// to a literal or to a subtype that the constraint's own spelling would have widened away.
function emitCppDependentIndexedAccessCpp(
  type: Readonly<Extract<IrType, { kind: 'indexedAccess' }>>,
  context: EmitContext,
): string | undefined {
  const reference = type.object.kind === 'named' ? type.object.reference : undefined;
  if (reference?.kind !== 'binding' || reference.binding.kind !== 'typeParameter') return undefined;
  const index = type.index;
  if (index.kind !== 'literal' || typeof index.value !== 'string') {
    emissionError(
      context,
      `indexedAccess types require C++ type computation lowering: a member read on ${describeIrTypeForDiagnosticCpp(type.object)} needs a literal key, and the index is ${describeIrTypeForDiagnosticCpp(index)}`,
      'cpp-dependent-indexed-access-unproven',
    );
  }
  const key = index.value;
  const constraint = getCppDependentTypeParameterConstraintCpp(reference.binding.id, context);
  if (!constraint || !isCppDependentMemberProvenCpp(constraint, key, context, new Set([reference.binding.id]))) {
    emissionError(
      context,
      `indexedAccess types require C++ type computation lowering: '${key}' is not a member of every inhabited constraint branch of ${describeIrTypeForDiagnosticCpp(type.object)}, whose constraint is ${constraint ? describeIrTypeForDiagnosticCpp(constraint) : 'absent'}`,
      'cpp-dependent-indexed-access-unproven',
    );
  }
  const objectType = emitType(type.object, context);
  context.includes.add('type_traits');
  context.includes.add('utility');
  return `std::remove_cvref_t<decltype(std::declval<${objectType}&>().${safeCppName(key)})>`;
}

// Whether every value the constraint admits has the literal member `key`, so that a dependent member read
// is a thing C++ can spell for every instantiation rather than for the ones that happen to be present.
//
// `never` is uninhabited and so contradicts nothing. A union is inhabited through each member it lists,
// which is why `every` is the rule there; an intersection is inhabited through all of them at once, and
// has the member when ANY side supplies it, which is why the two arms differ rather than sharing a merge.
//
// The proof resolves aliases, interfaces, classes, and inherited members through the planner, so what it
// answers for is the declaration a reader would name rather than the spelling of the constraint. An alias
// is expanded BEFORE the kind is dispatched on, because `type TextureLike = Texture2D | Texture3D` makes
// the constraint a union of two members while the constraint itself is a single name -- the union rule is
// the answer, and it is only reachable once the name is gone.
//
// Type parameters are followed to their own constraints, because `Type extends Other` is a question about
// `Other`. The visited set is what stops a cycle, and it is copied rather than extended in place so that
// two branches of one union cannot answer for each other.
function isCppDependentMemberProvenCpp(
  type: Readonly<IrType>,
  key: string,
  context: EmitContext,
  visitedBindingIds: ReadonlySet<string>,
): boolean {
  switch (type.kind) {
    case 'never':
      return true;
    case 'object':
      return type.properties.some((property) => property.name === key);
    case 'union':
      return type.types.every((member) => isCppDependentMemberProvenCpp(member, key, context, visitedBindingIds));
    case 'intersection':
      return type.types.some((member) => isCppDependentMemberProvenCpp(member, key, context, visitedBindingIds));
    case 'named': {
      if (type.reference.kind === 'binding') {
        const bindingId = type.reference.binding.id;
        if (visitedBindingIds.has(bindingId)) return false;
        const nextVisited = new Set(visitedBindingIds).add(bindingId);
        if (type.reference.binding.kind === 'typeParameter') {
          const constraint = getCppDependentTypeParameterConstraintCpp(bindingId, context);
          return constraint !== undefined && isCppDependentMemberProvenCpp(constraint, key, context, nextVisited);
        }
        const expanded = context.referenceRepresentationPlanner.resolveAlias(type, context.module);
        if (expanded !== undefined) return isCppDependentMemberProvenCpp(expanded, key, context, nextVisited);
      }
      if (
        type.reference.kind === 'ambient' &&
        cppDependentMemberPreservingAmbientWrappers.has(type.reference.name) &&
        type.typeArguments.length === 1 &&
        type.typeArguments[0]
      ) {
        return isCppDependentMemberProvenCpp(type.typeArguments[0], key, context, visitedBindingIds);
      }
      const properties = context.referenceRepresentationPlanner.resolveObjectShape(type, context.module);
      return properties !== undefined && properties.some((property) => property.name === key);
    }
    default:
      return false;
  }
}

// The module-wide constraint of a type parameter, in the innermost declaration that names it. A parameter
// declared inside an anonymous struct shadows the module's index because that is the nearest binding, and
// a constraint that cannot be found is not the same answer as a constraint that permits nothing.
function getCppDependentTypeParameterConstraintCpp(
  bindingId: string,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return (
    context.anonymousStructTypeParameters.find((parameter) => parameter.binding.id === bindingId)?.constraint ??
    context.typeParameterConstraints.get(bindingId)
  );
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
    case 'required':
      return `flight::RowRequired<${emitCppStructuralRowSchemaTypeCpp(representation.row, context)}>`;
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

// A short, allocation-free name for a type inside a diagnostic: the ambient name for a runtime type,
// the binding name for a declared one, the kind otherwise. Emitting the type instead would allocate
// generated names and register includes while the emitter is already failing.
function describeIrTypeForDiagnosticCpp(type: Readonly<IrType>): string {
  if (type.kind === 'named') {
    return type.reference.kind === 'ambient' ? type.reference.name : type.reference.binding.name;
  }
  return type.kind;
}

// Naming a shapeless member is not enough when the member is a wrapper: `NoInfer<T>` has no shape of
// its own, and the reader cannot tell from the name whether the wrapper is the missing arm or whether
// the argument under it is the thing that had no shape. Reporting the argument's own resolution
// separates the two, so the next probe is not needed to ask which level failed.
function describeShapelessIntersectionMemberCpp(member: Readonly<IrType>, context: EmitContext): string {
  const name = describeIrTypeForDiagnosticCpp(member);
  const argument = member.kind === 'named' ? member.typeArguments[0] : undefined;
  if (!argument) return name;
  const argumentResolves = Boolean(context.referenceRepresentationPlanner.resolveObjectShape(argument, context.module));
  return `${name} (argument ${describeIrTypeForDiagnosticCpp(argument)} ${argumentResolves ? 'has a shape, so the wrapper is the gap' : 'has no shape either'})`;
}

function emitType(type: Readonly<IrType>, context: EmitContext, representation: 'storage' | 'value' = 'value'): string {
  if (
    context.expandAliasesForEarlyPublication &&
    type.kind === 'named' &&
    type.reference.kind === 'binding' &&
    type.reference.binding.kind !== 'typeParameter'
  ) {
    const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
    const resolving = context.earlyPublicationResolvingAliases ?? new Set<string>();
    if (!resolving.has(key)) {
      const target = resolveCppTypeAliasTarget(type, context);
      if (target) {
        return emitType(
          target,
          { ...context, earlyPublicationResolvingAliases: new Set(resolving).add(key) },
          representation,
        );
      }
    }
  }
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
    const externalProjection = context.referenceRepresentationPlanner.resolveExternalProjection(type, context.module);
    if (externalProjection) return emitType(externalProjection, context, representation);
    if (
      type.kind === 'named' &&
      type.reference.kind === 'binding' &&
      type.reference.binding.kind === 'typeParameter' &&
      type.reference.path.length === 0 &&
      type.typeArguments.length === 0
    ) {
      return getTypeReferenceTargetName(type, context);
    }
    const structuralRow = context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module);
    const structuralObject = structuralRow ? getCppStructuralRowObjectTypeCpp(structuralRow) : undefined;
    if (
      structuralRow &&
      (type.kind !== 'named' ||
        type.reference.kind === 'ambient' ||
        (structuralObject?.kind === 'object' &&
          getCppStructuralRowOverrideAliasOwnerCpp(type, context.module, context)))
    ) {
      return emitCppStructuralRowReferenceTypeCpp(structuralRow, context);
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
      if (!indexed) {
        // `T['k']` where T is a type PARAMETER has no shape to resolve -- the parameter is whatever the
        // instantiation supplies -- but C++ spells it directly, and this emitter already writes the same
        // construct elsewhere (`typename decltype(std::declval<Object&>().p)::value_type`). Without this
        // a generic alias whose body reads a member's type cannot be emitted AT ALL: `type PickD<Type
        // extends TextureLike> = Type['dimension']` refuses on its own declaration, before anything
        // instantiates it, and one such alias blocked 105 modules transitively.
        const dependent = emitCppDependentIndexedAccessCpp(type, context);
        if (dependent) return dependent;
        // Naming what the index was taken FROM is what separates "the object has no shape" from "the
        // index names nothing" -- and a type parameter here means the alias's own argument never
        // reached the object, which is a different fix from a shape the walker cannot resolve.
        emissionError(
          context,
          `indexedAccess types require C++ type computation lowering: object is ${describeIrTypeForDiagnosticCpp(type.object)}, index is ${describeIrTypeForDiagnosticCpp(type.index)}`,
          'cpp-indexed-access-unlowered',
        );
      }
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
      const nominalIdentity =
        getCppRuntimeProfile(context.options) === 'flight-cpp'
          ? getCppRedundantNominalIntersectionIdentityCpp(type, context)
          : undefined;
      if (nominalIdentity) return emitType(nominalIdentity, context, representation);
      // This intersection may be an arm some module already declares -- a selection over an imported
      // union arrives here expanded rather than as the alias it was written as, so its structure is the
      // only thing left to recognize it by. When exactly one arm in the emission holds this identity and
      // it belongs to another module, that arm is named: it is emitted from the declaring module's own
      // node, in that module's context, and qualified to its namespace, which is the same type that
      // module's union storage holds. Zero matches leaves an intersection written here alone; more than
      // one cannot say which union's alternative this is, and choosing between them would be a guess
      // about identity rather than a reading of it.
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
        populateCppUnionArmIdentitiesCpp(context.unionArmIdentities, context);
        const canonical = getCppUnionArmIdentityKeyCpp(type, context.module, context);
        const candidates = canonical ? context.unionArmIdentities.get(canonical) : undefined;
        // A module's identity is its package and source, not the object: the module being emitted is the
        // one the passes produced, while the index is built from the modules they were given. Comparing the
        // objects would make a module's own arms look like another module's, and naming them from there
        // suppresses the definitions this module owes -- the arm would be referenced and never declared.
        const declared =
          candidates?.length === 1 &&
          getCppModuleIdentityKey(candidates[0]!.owner) !== getCppModuleIdentityKey(context.module)
            ? candidates[0]
            : undefined;
        if (declared) {
          const owner = declared.owner;
          const ownerContext: EmitContext = { ...context, anonymousStructs: new Map(), module: owner };
          const emitted = emitType(declared.arm, ownerContext, representation);
          if (ownerContext.anonymousStructs.size > 0) {
            context.earlyPublicationMaterializedOwners?.add(getCppModuleIdentityKey(owner));
          }
          return qualifyCppDeclaringModuleAlternativesCpp(emitted, ownerContext, owner, context.options);
        }
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
      if (!distributed) {
        // This refusal is reached by several unrelated causes -- a union with no shape arm, an exclusion
        // with no arm, a member that is not an object at all -- and the message is the only thing they
        // share, so it cannot tell them apart. Naming the members that had no shape is what turns a
        // bisect into a read: a caller sees which conjunct failed rather than that the whole type did.
        const shapeless = type.types.filter(
          (member) => !context.referenceRepresentationPlanner.resolveObjectShape(member, context.module),
        );
        emissionError(
          context,
          `intersection types require C++ multiple-inheritance lowering: no shape for ${shapeless
            .map((member) => describeShapelessIntersectionMemberCpp(member, context))
            .join(', ')}`,
          'cpp-intersection-member-shapeless',
        );
      }
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
          emissionError(
            context,
            `imported type ${type.reference.binding.name} has ${plan.reason}`,
            `cpp-imported-type-unsupported:${plan.reason}`,
          );
        }
      }
      if (sourceName === 'Exclude') {
        return emitType(getCppExcludedType(type.typeArguments, context), context, representation);
      }
      if (sourceName === 'Extract') {
        const extracted = getCppExtractedType(type.typeArguments, context);
        if (!extracted) refuseCppUnexpandedTypeScriptUtilityAlias('Extract', context);
        return emitType(extracted, context, representation);
      }
      // `NoInfer<T>` withholds a position from TypeScript's inference and is otherwise exactly `T`:
      // it states nothing about the value the position holds. C++ has no inference to withhold, so
      // the marker is erased and the argument emitted. Writing it out names a template the target
      // has never seen, which the target compiler reports far from the declaration that used it.
      if (sourceName === 'NoInfer') {
        const argument = type.typeArguments[0];
        if (type.typeArguments.length !== 1 || !argument) {
          emissionError(context, 'NoInfer<T> requires exactly one type argument', 'cpp-noinfer-argument-count');
        }
        return emitType(argument, context, representation);
      }
      if (sourceName === 'Parameters' || sourceName === 'ReturnType') {
        if (type.typeArguments.length !== 1 || !type.typeArguments[0]) {
          emissionError(
            context,
            `${sourceName}<T> requires exactly one callable type argument`,
            'cpp-callable-type-argument-count',
          );
        }
        const externalCallResult =
          sourceName === 'ReturnType' ? getCppExternalCallResultTypeCpp(type.typeArguments[0], context) : undefined;
        if (externalCallResult) return externalCallResult;
        const callable = getCppClosedCallableType(type.typeArguments[0], context, new Set());
        if (!callable || callable.typeParameters.length > 0) {
          emissionError(
            context,
            `${sourceName}<T> requires a statically resolvable non-generic callable type`,
            'cpp-callable-type-unresolvable',
          );
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
          emissionError(
            context,
            `${sourceName}<T> result requires concrete C++ type evidence`,
            'cpp-callable-result-missing-type-evidence',
          );
        }
        return emitted;
      }
      if (sourceName === 'PropertyKey') {
        if (type.typeArguments.length > 0) emissionError(context, 'PropertyKey does not accept type arguments');
        return emitType(createCppPropertyKeyTypeCpp(), context, representation);
      }
      // A key projection over a subject that keeps a reference or row representation keeps that
      // subject's row: `Pick<T, K>` names a subset of T's members, and the view the target already
      // has for T carries every one of them. Lowering it to the subject is therefore a superset the
      // consumer can use, which is the same reading `Omit` is given, and it is what the downstream
      // register asks for: `Pick<Ref<HostClipboardChangeProvider>, 'subscribe'>` should be
      // `Ref<HostClipboardChangeProvider>`, not a name the C++ compiler has never seen.
      if (sourceName === 'Pick' && type.typeArguments[0]) {
        const subject = type.typeArguments[0];
        if (
          hasFlightReferenceRepresentationCpp(subject, context) ||
          hasFlightStructuralRowRepresentationCpp(subject, context)
        ) {
          return emitType(subject, context, representation);
        }
      }
      // A projection utility reduces at its use site from a statically known key set, so the lowering
      // removes it. One that survives to emission had no static key set, and its name has no C++
      // spelling: writing `Pick<...>` out emits invalid C++ that only the target compiler discovers,
      // far from the declaration that caused it. Refuse here instead.
      if (sourceName === 'Omit' || sourceName === 'Pick') {
        emissionError(
          context,
          `${sourceName}<T, K> requires a statically known key set before C++ emission`,
          'cpp-unlowered-projection-utility',
        );
      }
      if (sourceName === 'Partial' && type.typeArguments[0]) {
        const properties = context.referenceRepresentationPlanner.resolveObjectShape(
          type.typeArguments[0],
          context.module,
        );
        if (!properties) {
          // Naming what `T` turned out to be is what separates "the shape walker has not reached
          // this form yet" from "this is not an object at all": `Partial<TextureLike>` holds an
          // alias, so a reader who expects a union here is looking in the wrong place.
          emissionError(
            context,
            `Partial<T> requires a statically resolvable C++ object shape; T is ${type.typeArguments[0].kind}`,
            'cpp-partial-shape-unresolvable',
          );
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
                : sourceName === 'WeakMap' && index === 0 && argument.kind === 'unknown' && argument.source === 'object'
                  ? 'flight::Ref<void>'
                  : emitCppTypeArgumentCpp(argument, context),
            );
      if (weakMapTypeArgumentPlan?.weakKeyPolicyTargetName) {
        arguments_.push(weakMapTypeArgumentPlan.weakKeyPolicyTargetName);
      }
      // A reference that names a generic without arguments relies on the declaration's defaults, and
      // `X<>` still requires a default to be visible at the use site. A default may be declared in
      // only one declaration, and the consuming module is not the one that declares it, so this
      // spells the defaults out instead: the reference then depends on nothing but the declaration.
      const defaultArguments =
        arguments_.length === 0 && type.reference.kind === 'binding'
          ? getCppTypeReferenceDefaultArgumentsCpp(type, context)
          : undefined;
      const usesDefaultArguments =
        arguments_.length === 0 &&
        type.reference.kind === 'binding' &&
        getCppTypeReferenceUsesDefaultArgumentsCpp(type, context);
      const emittedArguments =
        arguments_.length > 0
          ? `<${arguments_.join(', ')}>`
          : defaultArguments
            ? `<${defaultArguments.join(', ')}>`
            : usesDefaultArguments
              ? '<>'
              : '';
      return `${mapped}${emittedArguments}`;
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
        ...emitCppObjectPropertyStorageCpp(
          property,
          emitOptionalTypeCpp(
            emitCppMaterializedObjectPropertyTypeCpp(property.type, context),
            property.optional,
            context,
          ),
          context,
        ),
      }));
      const unresolved = emittedProperties.find((property) => /\bauto\b/u.test(property.type));
      if (unresolved) {
        emissionError(
          context,
          `anonymous object property ${unresolved.name} requires concrete C++ type evidence`,
          'cpp-anonymous-object-property-missing-type-evidence',
        );
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
      const structName = generateAnonymousStructName(key, type.properties, structuralHash, context);
      context.anonymousStructs.set(key, {
        guard: getCppAnonymousStructGuard(structName, context),
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
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          context.includes.add('flight/erased_ref.hpp');
          return 'flight::ErasedRef';
        }
        context.includes.add('memory');
        return 'std::shared_ptr<void>';
      }
      // An `any` or `unknown` position is a value of no stated type, and flight-cpp's erased dynamic
      // value is exactly that: a closed variant over every language type the runtime has, so a number
      // stays a number rather than being misstated as an object reference. Elected only after `this`
      // and `object`, so residue from an alias the compiler could not expand still reaches the guard
      // below as `auto` and stays refused rather than being silently widened.
      if (type.source === 'any' || type.source === 'unknown') {
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          context.includes.add('flight/any.hpp');
          return 'flight::Any';
        }
      }
      return 'auto';
  }
}

function emitCppUnknownBridgedGenericFactoryAssertionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): string | undefined {
  if (
    expression.expression.kind !== 'cast' ||
    expression.expression.type.kind !== 'unknown' ||
    expression.expression.expression.kind !== 'identifier' ||
    expression.expression.expression.reference.kind !== 'binding'
  ) {
    return undefined;
  }
  const target = getCppClosedCallableType(expression.type, context, new Set());
  const source = getCppFunctionDeclarationForBindingCpp(expression.expression.expression.reference.binding.id, context);
  if (!target || !source || source.parameters.length !== 0 || source.typeParameters.length === 0) return undefined;
  const targetReturnConstraint = getCppTypeParameterConstraintCpp(target.returns, context) ?? target.returns;
  const parameterIds = new Set(source.typeParameters.map((parameter) => parameter.binding.id));
  const substitutions = new Map<string, Readonly<IrType>>();
  if (
    !collectCppResultTypeSubstitutionsCpp(source.returns, targetReturnConstraint, parameterIds, substitutions, context)
  ) {
    return undefined;
  }
  const typeArguments = source.typeParameters.map(
    (parameter) => substitutions.get(parameter.binding.id) ?? parameter.default,
  );
  if (!typeArguments.every((argument): argument is Readonly<IrType> => argument !== undefined)) return undefined;
  const parameters = target.parameters.map((parameter, index) => {
    const type = emitOptionalTypeCpp(
      emitCppParameterTypeCpp(parameter.type, parameter.rest, context),
      parameter.optional,
      context,
    );
    return `${type} ignored_${String(index)}`;
  });
  const ignored = target.parameters.map((_, index) => `(void)ignored_${String(index)};`).join(' ');
  const returnType = emitType(target.returns, context);
  const sourceCall = `${emitIdentifierReference(expression.expression.expression.reference, context)}${emitCppTypeArguments(typeArguments, context)}()`;
  return `[&](${parameters.join(', ')}) -> ${returnType} { ${ignored}${ignored ? ' ' : ''}return static_cast<${returnType}>(${sourceCall}); }`;
}

function getCppTypeParameterConstraintCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind !== 'typeParameter' ||
    type.reference.path.length !== 0 ||
    type.typeArguments.length !== 0
  ) {
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  return context.anonymousStructTypeParameters.find((parameter) => parameter.binding.id === bindingId)?.constraint;
}

// The base a nominal-intersection implementation inherits rather than redeclares, with the members it
// provides. The base is an IMPORTED interface reference, and the struct emitter declares only what the base
// does not already provide — so anything initializing that struct has to know which members are its own. The
// construction lane needs the same answer, because a designated initializer may name only direct members.
function getCppNominalIntersectionBaseCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  context: EmitContext,
):
  | Readonly<{
      properties: readonly Readonly<IrObjectTypeProperty>[];
      type: Readonly<IrType>;
    }>
  | undefined {
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
    return (
      plan.kind === 'represented' && plan.category === 'interface' && plan.valueRepresentation === 'flightReference'
    );
  });
  if (!baseType) return undefined;
  const properties = context.referenceRepresentationPlanner.resolveObjectShape(baseType, context.module);
  return properties ? { properties, type: baseType } : undefined;
}

function getCppNamedTypeDeclarationOwnerCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
):
  | Readonly<{
      declaration: Readonly<IrDeclaration>;
      module: Readonly<IrModule>;
    }>
  | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind === 'typeParameter' ||
    type.reference.path.length > 0
  ) {
    return undefined;
  }
  const reference = type.reference;
  const importedOwner = ():
    | Readonly<{ declaration: Readonly<IrDeclaration>; module: Readonly<IrModule> }>
    | undefined => {
    if (reference.kind !== 'binding' || reference.binding.kind !== 'import') return undefined;
    const moduleContext = module === context.module ? context : { ...context, module };
    const importItem = module.imports.find((candidate) =>
      candidate.bindings.some((binding) => binding.binding.id === reference.binding.id),
    );
    const binding = importItem?.bindings.find((candidate) => candidate.binding.id === reference.binding.id);
    if (!importItem || !binding || binding.imported === '*') return undefined;
    const candidates = getCppResolvedImportModules(importItem.specifier, moduleContext).flatMap((targetModule) =>
      getCppExportedTypeDeclarationOwnersCpp(targetModule, binding.imported, context, new Set()),
    );
    const unique = new Map(
      candidates.map((candidate) => [
        `${getCppModuleIdentityKey(candidate.module)}\0${candidate.declaration.binding.id}`,
        candidate,
      ]),
    );
    return unique.size === 1 ? [...unique.values()][0] : undefined;
  };
  const owner =
    type.reference.binding.kind === 'import'
      ? importedOwner()
      : context.directBindingOwners.get(type.reference.binding.id);
  return owner ? { declaration: owner.declaration, module: owner.module } : undefined;
}

function getCppNominalTypeDeclarationOwnerCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
):
  | Readonly<{
      declaration: Readonly<IrClassDeclaration | IrInterfaceDeclaration>;
      module: Readonly<IrModule>;
    }>
  | undefined {
  const owner = getCppNamedTypeDeclarationOwnerCpp(type, module, context);
  return owner?.declaration.kind === 'class' || owner?.declaration.kind === 'interface'
    ? { declaration: owner.declaration, module: owner.module }
    : undefined;
}

function getCppStructuralRowOverrideAliasOwnerCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
):
  | Readonly<{
      declaration: Readonly<IrTypeAliasDeclaration>;
      module: Readonly<IrModule>;
    }>
  | undefined {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    return getCppStructuralRowOverrideAliasOwnerCpp(type.typeArguments[0], module, context);
  }
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind === 'typeParameter' ||
    type.reference.path.length > 0
  ) {
    return undefined;
  }
  const reference = type.reference;
  const importedOwner = ():
    | Readonly<{ declaration: Readonly<IrDeclaration>; module: Readonly<IrModule> }>
    | undefined => {
    if (reference.kind !== 'binding' || reference.binding.kind !== 'import') return undefined;
    const moduleContext = module === context.module ? context : { ...context, module };
    const importItem = module.imports.find((candidate) =>
      candidate.bindings.some((binding) => binding.binding.id === reference.binding.id),
    );
    const binding = importItem?.bindings.find((candidate) => candidate.binding.id === reference.binding.id);
    if (!importItem || !binding || binding.imported === '*') return undefined;
    const candidates = getCppResolvedImportModules(importItem.specifier, moduleContext).flatMap((targetModule) =>
      getCppExportedTypeDeclarationOwnersCpp(targetModule, binding.imported, context, new Set()),
    );
    const unique = new Map(
      candidates.map((candidate) => [
        `${getCppModuleIdentityKey(candidate.module)}\0${candidate.declaration.binding.id}`,
        candidate,
      ]),
    );
    return unique.size === 1 ? [...unique.values()][0] : undefined;
  };
  const owner =
    type.reference.binding.kind === 'import'
      ? importedOwner()
      : context.directBindingOwners.get(type.reference.binding.id);
  return owner?.declaration.kind === 'typeAlias' && owner.declaration.structuralRowOverride
    ? { declaration: owner.declaration, module: owner.module }
    : undefined;
}

function getCppNominalTypeIdentityCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
): string | undefined {
  const owner = getCppNominalTypeDeclarationOwnerCpp(type, module, context);
  if (!owner || type.kind !== 'named') return undefined;
  return `${getCppModuleIdentityKey(owner.module)}\0${owner.declaration.binding.id}\0${normalizeCompilerStructuralValueCanonical(type.typeArguments)}`;
}

function getCppNamedTypeDeclarationIdentityCpp(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
): string | undefined {
  const owner = getCppNamedTypeDeclarationOwnerCpp(type, module, context);
  if (!owner || !('binding' in owner.declaration) || type.kind !== 'named') return undefined;
  return `${getCppModuleIdentityKey(owner.module)}\0${owner.declaration.binding.id}\0${normalizeCompilerStructuralValueCanonical(type.typeArguments)}`;
}

// An empty interface may give an authored structural-row alias a compatibility name without
// creating another runtime object. Preserve the row only when the source declaration is exactly the
// interface's sole base and both resolved rows name the same C++ carrier. Shape alone is not enough:
// an anonymous lookalike or a different alias with the same fields has no declaration identity that
// authorizes it to initialize the interface arm.
function isCppStructuralInterfaceRepresentationAliasTypeCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (type.kind !== 'named') return false;
  const module = getCppNamedTypeBindingModuleCpp(type, context);
  const owner = getCppNamedTypeDeclarationOwnerCpp(type, module, context);
  return Boolean(
    owner?.declaration.kind === 'interface' &&
    owner.declaration.extends.length === 1 &&
    owner.declaration.properties.length === 0 &&
    context.referenceRepresentationPlanner.resolveStructuralRow(type, module),
  );
}

function isCppStructuralInterfaceStorageAliasCpp(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (source.kind !== 'named' || target.kind !== 'named') return false;
  const sourceModule = getCppNamedTypeBindingModuleCpp(source, context);
  const targetModule = getCppNamedTypeBindingModuleCpp(target, context);
  const sourceOwner = getCppNamedTypeDeclarationOwnerCpp(source, sourceModule, context);
  const targetOwner = getCppNamedTypeDeclarationOwnerCpp(target, targetModule, context);
  const interfaceAliases = (
    alias: Readonly<IrType>,
    aliasModule: Readonly<IrModule>,
    aliasOwner: ReturnType<typeof getCppNamedTypeDeclarationOwnerCpp>,
    interfaceType: Readonly<IrType>,
    interfaceOwner: ReturnType<typeof getCppNamedTypeDeclarationOwnerCpp>,
  ): boolean => {
    if (
      aliasOwner?.declaration.kind !== 'typeAlias' ||
      interfaceOwner?.declaration.kind !== 'interface' ||
      interfaceOwner.declaration.extends.length !== 1 ||
      interfaceOwner.declaration.properties.length !== 0
    ) {
      return false;
    }
    const substitutions = createIrTypeParameterSubstitutionPlan(
      interfaceOwner.declaration.typeParameters,
      interfaceType.kind === 'named' ? interfaceType.typeArguments : [],
    );
    const base = resolveIrTypeStructuralSubstitution(interfaceOwner.declaration.extends[0]!, substitutions);
    const aliasIdentity = getCppNamedTypeDeclarationIdentityCpp(alias, aliasModule, context);
    const baseIdentity = getCppNamedTypeDeclarationIdentityCpp(base, interfaceOwner.module, context);
    return Boolean(aliasIdentity && aliasIdentity === baseIdentity);
  };
  if (
    !interfaceAliases(source, sourceModule, sourceOwner, target, targetOwner) &&
    !interfaceAliases(target, targetModule, targetOwner, source, sourceOwner)
  ) {
    return false;
  }
  const sourceRow = context.referenceRepresentationPlanner.resolveStructuralRow(source, sourceModule);
  const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(target, targetModule);
  if (
    !sourceRow ||
    !targetRow ||
    normalizeCompilerStructuralValueCanonical(sourceRow) !== normalizeCompilerStructuralValueCanonical(targetRow)
  ) {
    return false;
  }
  const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
  return (
    emitCppStructuralRowReferenceTypeCpp(sourceRow, isolatedContext) ===
    emitCppStructuralRowReferenceTypeCpp(targetRow, isolatedContext)
  );
}

function isCppNominalTypeDerivedFromCpp(
  source: Readonly<IrType>,
  sourceModule: Readonly<IrModule>,
  target: Readonly<IrType>,
  targetModule: Readonly<IrModule>,
  context: EmitContext,
  visited: ReadonlySet<string>,
): boolean {
  const sourceOwner = getCppNominalTypeDeclarationOwnerCpp(source, sourceModule, context);
  const targetIdentity = getCppNominalTypeIdentityCpp(target, targetModule, context);
  const sourceIdentity = getCppNominalTypeIdentityCpp(source, sourceModule, context);
  if (!sourceOwner || !sourceIdentity || !targetIdentity) return false;
  if (sourceIdentity === targetIdentity) return true;
  const visitKey = `${sourceIdentity}\0${targetIdentity}`;
  if (visited.has(visitKey) || source.kind !== 'named') return false;
  const substitutions = createIrTypeParameterSubstitutionPlan(
    sourceOwner.declaration.typeParameters,
    source.typeArguments,
  );
  const bases =
    sourceOwner.declaration.kind === 'interface'
      ? sourceOwner.declaration.extends
      : sourceOwner.declaration.extends
        ? [sourceOwner.declaration.extends]
        : [];
  const nextVisited = new Set(visited).add(visitKey);
  return bases.some((base) =>
    isCppNominalTypeDerivedFromCpp(
      resolveIrTypeStructuralSubstitution(base, substitutions),
      sourceOwner.module,
      target,
      targetModule,
      context,
      nextVisited,
    ),
  );
}

// An intersection does not mint a new referent when one named member explicitly inherits every
// other member: `GlyphSource & Entity` is still the authored GlyphSource identity because
// GlyphSource extends Entity. Shape compatibility alone is deliberately insufficient — an
// independent named interface or an anonymous structural refinement still needs its own carrier.
function getCppRedundantNominalIntersectionIdentityCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return type.types.find((candidate) => {
    const plan = context.referenceRepresentationPlanner.plan(candidate, context.module);
    return (
      plan.kind === 'represented' &&
      plan.identityDomain === 'object' &&
      plan.valueRepresentation === 'flightReference' &&
      type.types.every((member) =>
        isCppNominalTypeDerivedFromCpp(candidate, context.module, member, context.module, context, new Set()),
      )
    );
  });
}

function emitCppNominalIntersectionImplementationTypeCpp(
  type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
  properties: readonly Readonly<IrObjectTypeProperty>[],
  context: EmitContext,
): string | undefined {
  const base = getCppNominalIntersectionBaseCpp(type, context);
  if (!base) return undefined;
  const baseProperties = base.properties;
  const baseType = base.type;
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
    ...emitCppObjectPropertyStorageCpp(
      property,
      emitOptionalTypeCpp(emitCppMaterializedObjectPropertyTypeCpp(property.type, context), property.optional, context),
      context,
    ),
  }));
  if (emittedProperties.some((property) => /\bauto\b/u.test(property.type))) return undefined;

  const structuralHash = getCppStableIdentifierHash(key);
  const structName = generateAnonymousStructName(key, properties, structuralHash, context);
  context.anonymousStructs.set(key, {
    base: emitType(baseType, context, 'storage'),
    guard: getCppAnonymousStructGuard(structName, context),
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

function getCppExcludedType(typeArguments: readonly Readonly<IrType>[], context: EmitContext): Readonly<IrType> {
  if (typeArguments.length !== 2 || !typeArguments[0] || !typeArguments[1]) {
    emissionError(context, 'Exclude<T, U> requires exactly two type arguments', 'cpp-exclude-argument-count');
  }
  const included = getCppClosedTypeDomain(typeArguments[0], context);
  const excluded = getCppClosedTypeDomain(typeArguments[1], context);
  if (included.kind === 'refused') {
    const rule =
      included.reason === 'open'
        ? 'cpp-exclude-open-domain'
        : included.reason === 'mismatch'
          ? 'cpp-exclude-domain-mismatch'
          : 'cpp-exclude-unresolved-domain';
    emissionError(context, `Exclude types require closed C++ type computation: ${included.message}`, rule);
  }
  if (excluded.kind === 'refused') {
    const rule =
      excluded.reason === 'open'
        ? 'cpp-exclude-open-domain'
        : excluded.reason === 'mismatch'
          ? 'cpp-exclude-domain-mismatch'
          : 'cpp-exclude-unresolved-domain';
    emissionError(context, `Exclude types require closed C++ type computation: ${excluded.message}`, rule);
  }
  if (included.category && excluded.category && included.category !== excluded.category) {
    emissionError(
      context,
      `Exclude cannot compare ${included.category} and ${excluded.category} C++ type domains`,
      'cpp-exclude-domain-mismatch',
    );
  }
  const surviving: Readonly<IrType>[] = [];
  for (const member of included.members) {
    let removed = false;
    for (const candidate of excluded.members) {
      const assignability = getCppClosedTypeAssignability(member, candidate, included.category, context);
      if (assignability === 'indeterminate') {
        emissionError(
          context,
          'Exclude object member assignability requires unresolved semantic evidence',
          'cpp-exclude-assignability-indeterminate',
        );
      }
      if (assignability === 'compatible') {
        removed = true;
        break;
      }
    }
    if (!removed) surviving.push(member);
  }
  return createCppClosedTypeUnion(surviving);
}

function getCppExtractedType(
  typeArguments: readonly Readonly<IrType>[],
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (typeArguments.length !== 2 || !typeArguments[0] || !typeArguments[1]) return undefined;
  const source = getCppClosedTypeDomain(typeArguments[0], context);
  const filter = getCppClosedTypeDomain(typeArguments[1], context);
  if (source.kind === 'refused' || filter.kind === 'refused') return undefined;
  if (source.category && filter.category && source.category !== filter.category) return undefined;
  const surviving: Readonly<IrType>[] = [];
  for (const member of source.members) {
    let selected = false;
    for (const candidate of filter.members) {
      const assignability = getCppClosedTypeAssignability(member, candidate, source.category, context);
      if (assignability === 'indeterminate') return undefined;
      if (assignability === 'compatible') selected = true;
    }
    if (selected) surviving.push(member);
  }
  return createCppClosedTypeUnion(surviving);
}

type CppClosedTypeDomainCategory = 'object' | 'scalar';

type CppClosedTypeDomain =
  | Readonly<{
      category: CppClosedTypeDomainCategory | undefined;
      kind: 'resolved';
      members: readonly Readonly<IrType>[];
    }>
  | Readonly<{ kind: 'refused'; message: string; reason: 'mismatch' | 'open' | 'unresolved' }>;

function getCppClosedTypeDomain(
  type: Readonly<IrType>,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string> = new Set(),
): CppClosedTypeDomain {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'PropertyKey' &&
    type.typeArguments.length === 0
  ) {
    return getCppClosedTypeDomain(createCppPropertyKeyTypeCpp(), context, resolvingAliases);
  }
  if (type.kind === 'keyof' || type.kind === 'typeOf') {
    const resolved = type.kind === 'keyof' ? getCppKeyofType(type.type, context) : getCppTypeOfValueType(type, context);
    return resolved
      ? getCppClosedTypeDomain(resolved, context, resolvingAliases)
      : { kind: 'refused', message: `${type.kind} domain is unresolved`, reason: 'unresolved' };
  }
  if (type.kind === 'named' && type.reference.kind === 'binding') {
    if (type.reference.binding.kind === 'typeParameter') {
      return {
        kind: 'refused',
        message: `type parameter ${type.reference.binding.name} is open`,
        reason: 'open',
      };
    }
    const bindingId = type.reference.binding.id;
    if (resolvingAliases.has(bindingId)) {
      return {
        kind: 'refused',
        message: `type alias ${type.reference.binding.name} is recursive`,
        reason: 'unresolved',
      };
    }
    const alias = resolveCppTypeAliasTarget(type, context);
    if (alias) {
      const nextResolvingAliases = new Set(resolvingAliases);
      nextResolvingAliases.add(bindingId);
      return getCppClosedTypeDomain(alias, context, nextResolvingAliases);
    }
  }
  if (type.kind === 'never') return { category: undefined, kind: 'resolved', members: [] };
  if (type.kind === 'union') {
    const domains = type.types.map((member) => getCppClosedTypeDomain(member, context, resolvingAliases));
    const resolvedDomains: Extract<CppClosedTypeDomain, { kind: 'resolved' }>[] = [];
    for (const domain of domains) {
      if (domain.kind === 'refused') return domain;
      resolvedDomains.push(domain);
    }
    const categories = new Set(
      resolvedDomains.map((domain) => domain.category).filter((category) => category !== undefined),
    );
    if (categories.size > 1) {
      return { kind: 'refused', message: 'one type domain mixes primitive and object members', reason: 'mismatch' };
    }
    return {
      category: categories.values().next().value,
      kind: 'resolved',
      members: resolvedDomains.flatMap((domain) => domain.members),
    };
  }
  if (type.kind === 'literal' || type.kind === 'null' || type.kind === 'primitive' || type.kind === 'undefined') {
    return { category: 'scalar', kind: 'resolved', members: [type] };
  }
  const openTypeParameter = getCppOpenTypeParameterName(type);
  if (openTypeParameter) {
    return { kind: 'refused', message: `type parameter ${openTypeParameter} is open`, reason: 'open' };
  }
  if (context.referenceRepresentationPlanner.resolveObjectShape(type, context.module)) {
    return { category: 'object', kind: 'resolved', members: [type] };
  }
  return { kind: 'refused', message: `${type.kind} domain is unresolved`, reason: 'unresolved' };
}

function getCppOpenTypeParameterName(type: Readonly<IrType>): string | undefined {
  switch (type.kind) {
    case 'array':
      return getCppOpenTypeParameterName(type.element);
    case 'conditionalFacet':
      return getCppOpenTypeParameterName(type.check) ?? getCppOpenTypeParameterName(type.facet);
    case 'function':
      return (
        getCppOpenTypeParameterNameFromTypes(type.parameters.map((parameter) => parameter.type)) ??
        getCppOpenTypeParameterName(type.returns)
      );
    case 'indexedAccess':
      return getCppOpenTypeParameterName(type.object) ?? getCppOpenTypeParameterName(type.index);
    case 'intersection':
    case 'union':
      return getCppOpenTypeParameterNameFromTypes(type.types);
    case 'keyof':
      return getCppOpenTypeParameterName(type.type);
    case 'named':
      return type.reference.kind === 'binding' && type.reference.binding.kind === 'typeParameter'
        ? type.reference.binding.name
        : getCppOpenTypeParameterNameFromTypes(type.typeArguments);
    case 'object':
      return getCppOpenTypeParameterNameFromTypes(type.properties.map((property) => property.type));
    case 'tuple':
      return getCppOpenTypeParameterNameFromTypes(type.elements.map((element) => element.type));
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      return undefined;
  }
}

function getCppOpenTypeParameterNameFromTypes(types: readonly Readonly<IrType>[]): string | undefined {
  for (const type of types) {
    const name = getCppOpenTypeParameterName(type);
    if (name) return name;
  }
  return undefined;
}

function getCppClosedTypeAssignability(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  category: CppClosedTypeDomainCategory | undefined,
  context: EmitContext,
): 'compatible' | 'incompatible' | 'indeterminate' {
  if (category === 'object') {
    const sourceProperties = context.referenceRepresentationPlanner.resolveObjectShape(source, context.module);
    const targetProperties = context.referenceRepresentationPlanner.resolveObjectShape(target, context.module);
    if (!sourceProperties || !targetProperties) return 'indeterminate';
    return analyzeIrTypeStructuralAssignability(
      { kind: 'object', properties: getCppConditionalTypeProperties(sourceProperties) },
      { kind: 'object', properties: getCppConditionalTypeProperties(targetProperties) },
    ).status;
  }
  if (target.kind === 'primitive') {
    if (source.kind === 'primitive') return source.name === target.name ? 'compatible' : 'incompatible';
    if (source.kind !== 'literal') return 'incompatible';
    return typeof source.value === target.name ? 'compatible' : 'incompatible';
  }
  if (target.kind === 'literal') {
    return source.kind === 'literal' && Object.is(source.value, target.value) ? 'compatible' : 'incompatible';
  }
  return source.kind === target.kind ? 'compatible' : 'incompatible';
}

function getCppConditionalTypeProperties(
  properties: readonly Readonly<IrObjectTypeProperty>[],
): readonly Readonly<IrObjectTypeProperty>[] {
  // Property writability does not participate in TypeScript conditional-type assignability: a
  // readonly discriminant still satisfies the otherwise identical mutable filter used by Extract.
  // Storage assignability remains stricter elsewhere; only the closed type-level comparison erases
  // this modifier before asking the shared structural analyzer about the property values.
  return properties.map((property) => ({ ...property, readonly: false }));
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
  // Resolved aliases can carry a type query declared in another module. Its binding is then neither
  // local nor an import of the module currently being emitted, but the package-wide owner index still
  // identifies the declaration whose value type the query asks for.
  const directOwner = context.directBindingOwners.get(type.reference.binding.id);
  const functionDeclaration = getCppFunctionDeclarationForBindingCpp(type.reference.binding.id, context);
  let valueType =
    getCppBindingTypeCpp(type.reference.binding.id, context) ??
    (directOwner ? collectIrModuleBindingTypesCpp(directOwner.module).get(type.reference.binding.id) : undefined) ??
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
  if (!hasProvenWeakMapValueRepresentationCpp(typeArguments[1], context)) {
    emissionError(context, 'flight-cpp WeakMap value requires a proven C++ representation');
  }
  return {
    valueRepresentation: 'direct',
    ...(key.weakKeyPolicyTargetName ? { weakKeyPolicyTargetName: key.weakKeyPolicyTargetName } : {}),
  };
}

function hasProvenWeakMapValueRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  // `object` is not the same erasure as `unknown`: it excludes scalar values and is emitted as the
  // tagged `ErasedRef` carrier. That carrier is the concrete value representation needed by Flight's
  // scene-mesh caches, while preserving enough type identity for a later checked object assertion.
  if (type.kind === 'unknown' && type.source === 'object') return true;

  // The reference planner intentionally gives an open type parameter and an unresolved import a
  // provisional reference shape so other generic/imported declarations can still be written. A
  // WeakMap instantiation is storage, however, and must have one closed value ABI now rather than
  // inheriting that optimistic fallback.
  if (getCppOpenTypeParameterName(type)) return false;
  const owner =
    getCppDirectBindingOwner(type, context) ??
    (type.kind === 'named' ? getCppImportedBindingDeclarationCpp(type, context) : undefined);
  const value = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return value.kind === 'represented' && value.identity.identity !== 'indeterminate';
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

function getIrWeakSetTypeCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
  resolvingAliases: ReadonlySet<string>,
): Readonly<Extract<IrType, { kind: 'named' }>> | undefined {
  if (!type || type.kind !== 'named') return undefined;
  if (type.reference.kind === 'ambient' && type.reference.name === 'WeakSet') return type;
  if (type.reference.kind !== 'binding' || resolvingAliases.has(type.reference.binding.id)) return undefined;
  const alias = context.referenceRepresentationPlanner.resolveAlias(type, context.module);
  if (!alias) return undefined;
  return getIrWeakSetTypeCpp(alias, context, new Set(resolvingAliases).add(type.reference.binding.id));
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
  return { erasedValue: 'value', key: target.typeArguments[0], value: target.typeArguments[1] };
}

function getCppWeakMapViewPlan(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): Readonly<CppWeakMapViewPlan> | undefined {
  return getCppErasedWeakMapViewPlan(expression, context) ?? getCppErasedRefWeakMapViewPlan(expression, context);
}

function getCppErasedRefWeakMapViewPlan(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): Readonly<CppWeakMapViewPlan> | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  const sourceType = getIrExpressionTypeEvidenceCpp(expression.expression, context);
  const source = sourceType ? getCppNonNullableType(sourceType, context, new Set()) : undefined;
  if (!isCppErasedRefWeakMapType(source, context)) return undefined;
  const targetType = getCppNonNullableType(expression.type, context, new Set());
  const target = getIrWeakMapTypeCpp(targetType, context, new Set());
  if (!target || target.typeArguments.length !== 2 || !target.typeArguments[0] || !target.typeArguments[1]) {
    return undefined;
  }
  if (
    target.typeArguments[0].kind === 'unknown' &&
    target.typeArguments[0].source === 'object' &&
    target.typeArguments[1].kind === 'unknown' &&
    target.typeArguments[1].source === 'object'
  ) {
    return undefined;
  }
  if (getCppOpenTypeParameterName(target.typeArguments[0])) {
    emissionError(context, 'erased-reference WeakMap typed view requires a closed Flight reference key');
  }
  const key = context.referenceRepresentationPlanner.plan(target.typeArguments[0], context.module);
  if (key.kind !== 'represented' || key.valueRepresentation !== 'flightReference') {
    emissionError(context, 'erased-reference WeakMap typed view requires a proven Flight reference key');
  }
  if (getCppOpenTypeParameterName(target.typeArguments[1])) {
    emissionError(context, 'erased-reference WeakMap typed view requires a closed Flight reference value');
  }
  const valueType = target.typeArguments[1];
  const owner =
    getCppDirectBindingOwner(valueType, context) ??
    (valueType.kind === 'named' ? getCppImportedBindingDeclarationCpp(valueType, context) : undefined);
  const value = context.referenceRepresentationPlanner.plan(valueType, owner?.module ?? context.module);
  if (
    value.kind !== 'represented' ||
    value.identity.identity === 'indeterminate' ||
    value.valueRepresentation !== 'flightReference'
  ) {
    emissionError(context, 'erased-reference WeakMap typed view requires a proven Flight reference value');
  }
  return { erasedValue: 'reference', key: target.typeArguments[0], value: target.typeArguments[1] };
}

function refuseCppErasedRefWeakMapView(context: EmitContext, nullableBackingPlanned = false): never {
  emissionError(
    context,
    `flight-cpp WeakMap<object, object> typed views require the runtime overload ${cppErasedRefWeakMapViewRuntimeDependency}${nullableBackingPlanned ? ' after initializing and retaining the erased backing field' : ''}`,
    'cpp-weak-map-erased-ref-view-unsupported',
  );
}

function getCppNullableErasedRefWeakMapViewPlan(
  declarationStatement: Readonly<IrStatement> | undefined,
  guardStatement: Readonly<IrStatement> | undefined,
  context: EmitContext,
): Readonly<CppNullableErasedRefWeakMapViewPlan> | undefined {
  if (
    declarationStatement?.kind !== 'variable' ||
    declarationStatement.declarations.length !== 1 ||
    guardStatement?.kind !== 'if' ||
    guardStatement.otherwise
  ) {
    return undefined;
  }
  const variable = declarationStatement.declarations[0];
  if (
    !variable ||
    !('binding' in variable) ||
    !variable.mutable ||
    variable.initializer?.kind !== 'cast' ||
    variable.initializer.expression.kind !== 'property' ||
    variable.initializer.expression.object.kind !== 'identifier' ||
    variable.initializer.expression.object.reference.kind !== 'binding'
  ) {
    return undefined;
  }
  const view = getCppErasedRefWeakMapViewPlan(variable.initializer, context);
  if (!view || view.erasedValue !== 'reference') return undefined;
  if (!isCppNullishWeakMapViewGuardCpp(guardStatement.condition, variable.binding.id)) return undefined;
  const body = guardStatement.consequent.kind === 'block' ? guardStatement.consequent.statements : [];
  if (body.length !== 2) return undefined;
  const initialize = getCppStatementAssignmentCpp(body[0]);
  const writeBack = getCppStatementAssignmentCpp(body[1]);
  if (
    !initialize ||
    initialize.operator !== '=' ||
    !isCppBindingIdentifierCpp(initialize.left, variable.binding.id) ||
    initialize.right.kind !== 'new' ||
    getIrAmbientConstructorNameCpp(initialize.right.callee) !== 'WeakMap' ||
    initialize.right.arguments.length !== 0 ||
    !writeBack ||
    writeBack.operator !== '=' ||
    !isDeepStrictEqual(writeBack.left, variable.initializer.expression) ||
    !isCppErasedRefWeakMapWriteBackCpp(writeBack.right, variable.binding.id, context)
  ) {
    return undefined;
  }
  return { backing: variable.initializer.expression, view };
}

function getCppStatementAssignmentCpp(
  statement: Readonly<IrStatement> | undefined,
): Readonly<Extract<IrExpression, { kind: 'assignment' }>> | undefined {
  return statement?.kind === 'expression' && statement.expression.kind === 'assignment'
    ? statement.expression
    : undefined;
}

function isCppBindingIdentifierCpp(expression: Readonly<IrExpression>, bindingId: string): boolean {
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    expression.reference.binding.id === bindingId
  );
}

function isCppErasedRefWeakMapWriteBackCpp(
  expression: Readonly<IrExpression>,
  bindingId: string,
  context: EmitContext,
): boolean {
  return (
    expression.kind === 'cast' &&
    isCppErasedRefWeakMapType(expression.type, context) &&
    expression.expression.kind === 'cast' &&
    expression.expression.type.kind === 'unknown' &&
    expression.expression.type.source === 'unknown' &&
    isCppBindingIdentifierCpp(expression.expression.expression, bindingId)
  );
}

function isCppNullishWeakMapViewGuardCpp(expression: Readonly<IrExpression>, bindingId: string): boolean {
  if (expression.kind !== 'binary' || expression.operator !== '==' || !expression.semantics.nullishComparison) {
    return false;
  }
  const nullish = (candidate: Readonly<IrExpression>): boolean =>
    (candidate.kind === 'literal' && candidate.value === null) ||
    candidate.kind === 'undefinedValue' ||
    (candidate.kind === 'identifier' &&
      candidate.reference.kind === 'ambient' &&
      candidate.reference.name === 'undefined');
  return (
    (isCppBindingIdentifierCpp(expression.left, bindingId) && nullish(expression.right)) ||
    (isCppBindingIdentifierCpp(expression.right, bindingId) && nullish(expression.left))
  );
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

function isCppErasedRefWeakMapType(type: Readonly<IrType> | undefined, context: EmitContext): boolean {
  const resolved = type ? getIrWeakMapTypeCpp(type, context, new Set()) : undefined;
  return (
    resolved?.typeArguments.length === 2 &&
    resolved.typeArguments[0]?.kind === 'unknown' &&
    resolved.typeArguments[0].source === 'object' &&
    resolved.typeArguments[1]?.kind === 'unknown' &&
    resolved.typeArguments[1].source === 'object'
  );
}

function emitCppErasedWeakMapViewAcquisition(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  plan: Readonly<CppWeakMapViewPlan>,
  context: EmitContext,
): string {
  if (plan.erasedValue === 'reference') refuseCppErasedRefWeakMapView(context);
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
    key,
    [{ name: 'callable' }, ...representation.properties],
    structuralHash,
    context,
  );
  context.anonymousStructs.set(key, {
    ...createCppCallableObjectStructCpp(structName, representation, typeParameters, context),
    guard: getCppAnonymousStructGuard(structName, context),
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
  const structName = generateAnonymousStructName(key, [{ name: 'callableOverloads' }], structuralHash, context);
  context.anonymousStructs.set(key, {
    ...createCppCallableOverloadStructCpp(structName, representation, typeParameters, context),
    guard: getCppAnonymousStructGuard(structName, context),
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

function emitCppOrderedRecordConstructionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  constructionType: Readonly<IrType>,
  record: Readonly<{ key: IrType; value: IrType }>,
  context: EmitContext,
): string {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') {
    emissionError(context, 'ordered Record construction requires the flight-cpp runtime profile');
  }
  // The neutral object member list is already the source evaluation order. Materialize each key,
  // value, and spread operand separately because C++ call arguments do not provide JavaScript's
  // key-before-value ordering. Record::set replaces an existing value without reinserting its key,
  // so replaying those writes also preserves last-write-wins and stable property position.
  const result = getGeneratedTargetName('recordConstruction', context);
  const lines = [`${emitType(constructionType, context)} ${result} = {};`];
  for (const member of expression.members) {
    if (member.kind === 'getAccessor') {
      emissionError(context, 'Record construction does not support accessors');
    }
    if (member.kind === 'spread') {
      const sourceType = getIrExpressionTypeEvidenceCpp(member.expression, context);
      const sourceRecord = getCppRecordTypeArgumentsCpp(sourceType, context, new Set());
      if (
        !sourceRecord ||
        !areCppTypesRepresentationEquivalent(sourceRecord.key, record.key, context) ||
        !areCppTypesRepresentationEquivalent(sourceRecord.value, record.value, context)
      ) {
        emissionError(
          context,
          'Record spread construction requires a represented Record with equivalent key and value storage',
          'cpp-record-spread-source-unrepresented',
        );
      }
      const source = getGeneratedTargetName('recordSpreadSource', context);
      const entry = getGeneratedTargetName('recordSpreadEntry', context);
      lines.push(
        `auto&& ${source} = ${emitExpression(member.expression, context)};`,
        `for (const auto& ${entry} : ${source}) { ${result}.set(${entry}.first, ${entry}.second); }`,
      );
      continue;
    }
    const key = getGeneratedTargetName('recordConstructionKey', context);
    const value = getGeneratedTargetName('recordConstructionValue', context);
    lines.push(
      `auto ${key} = ${
        member.kind === 'computedProperty'
          ? emitCppRequiredRecordKeyCpp(member.key, record.key, context)
          : emitCppRecordLiteralKey(member.name, record.key, context)
      };`,
      `auto ${value} = ${emitExpression(member.value, context, record.value)};`,
      `${result}.set(${key}, ${value});`,
    );
  }
  lines.push(`return ${result};`);
  return `(${context.namespaceScope ? '[]' : '[&]'}() { ${lines.join(' ')} }())`;
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
    emissionError(
      context,
      `Record literal key ${name} requires a single string or number runtime domain`,
      'cpp-record-key-no-single-runtime-domain',
    );
  }
  if (runtimeType.name === 'string') {
    return emitExpression({ kind: 'literal', value: name }, context, runtimeType);
  }
  if (runtimeType.name !== 'number') {
    emissionError(
      context,
      `Record literal key ${name} requires a string or number runtime domain`,
      'cpp-record-key-not-string-or-number-domain',
    );
  }
  const numeric = Number(name);
  if (!Number.isFinite(numeric)) {
    emissionError(
      context,
      `Record literal key ${name} is not a finite numeric key`,
      'cpp-record-key-not-finite-numeric',
    );
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
  const importedValueAlias = getCppOptionalImportedUnionValueAliasCpp(type, context);
  // The alias owns the anonymous alternatives. The shared plan still decides whether this is an
  // optional variant, but asking it in the consumer's live context would register duplicate local
  // structs even though the emitted storage keeps the imported alias intact.
  const plan = getCppUnionRepresentationPlan(
    type,
    importedValueAlias ? { ...context, anonymousStructs: new Map(), includes: new Set() } : context,
  );
  if (importedValueAlias && plan.kind === 'optionalVariant') {
    context.includes.add('optional');
    return `std::optional<${emitType(importedValueAlias, context)}>`;
  }
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
  if (evidence.admitsNull && evidence.admitsUndefined) {
    const operandType = getCppNullishComparisonOperandTypeCpp(operand, context);
    const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
    const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
    if (!getCppOptionalParameterNullishStorageCpp(operand, context) && (!plan || plan.kind !== 'dualSentinelVariant')) {
      emissionError(context, 'nullish comparison admitting null and undefined requires dual-sentinel union evidence');
    }
  }
  return emitCppPresenceTestCpp(
    operand,
    evidence.literal,
    expression.operator === '!=' || expression.operator === '!==',
    expression.operator === '===' || expression.operator === '!==',
    context,
  );
}

// `typeof X === 'function'` asks whether X holds a callable. When X's runtime type is a closed union
// whose only member that is not absence is a callable, that is the question the presence machinery
// already answers: an absent or null value is not a function, and there is no other value the operand
// could hold, so "present" and "a function" are the same answer. The domain has to be closed AND have
// exactly one non-absent member -- two callables, a callable beside a string, a primitive, an open
// generic, or anything the emitter cannot close is a different question, and it is left to the lanes
// that know it rather than approximated here. The test is the loose one on purpose: `typeof` reports
// both `null` and `undefined` as something other than `function`, so an operand admitting both is
// asked the nullish question, which is exactly the answer the source asked for.
function emitCppInferredOptionalTypeofFunctionComparisonCpp(
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
  const operand = getCppTypeofFunctionComparisonOperandCpp(expression.left, expression.right);
  if (!operand) return undefined;
  const operandType = getCppNullishComparisonOperandTypeCpp(operand, context);
  const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  if (!union) return undefined;
  const values = union.types.filter((member) => member.kind !== 'undefined' && member.kind !== 'null');
  const only = values[0];
  if (values.length !== 1 || !only || !isCppCallableDomainTypeCpp(only, context)) return undefined;
  // The literal is the callable, so the comparison asserts PRESENCE where the nullish lane's literal
  // asserts absence: `typeof X === 'function'` is true when X holds a value, and `!==` when it does not.
  return emitCppPresenceTestCpp(
    operand,
    'undefined',
    expression.operator === '==' || expression.operator === '===',
    false,
    context,
  );
}

// Whether a member of a closed domain is a callable. A callable reached through a type alias is the
// same callable: the SDK writes `transform: ColorTransformFunction`, and that name denotes the arrow
// type. The alias is followed to what it denotes, with a bound so a cycle in an alias chain cannot loop
// here -- and anything a bounded walk does not reach is not proven, which leaves the question to the
// lanes that know it rather than answering it here.
function isCppCallableDomainTypeCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  let current = type;
  for (let depth = 0; depth < 8; depth++) {
    if (current.kind === 'function') return true;
    if (current.kind !== 'named') return false;
    const target = resolveCppTypeAliasTarget(current, context);
    if (!target) return false;
    current = target;
  }
  return false;
}

// The operand of `typeof X === 'function'`, when that is the comparison: one side a `typeof` of
// anything and the other the literal `'function'`, in either order. Both sides being a `typeof` is not
// this comparison, and neither is a literal on both sides.
function getCppTypeofFunctionComparisonOperandCpp(
  left: Readonly<IrExpression>,
  right: Readonly<IrExpression>,
): Readonly<IrExpression> | undefined {
  const typeofOperand = (side: Readonly<IrExpression>): Readonly<IrExpression> | undefined =>
    side.kind === 'unary' && side.operator === 'typeof' ? side.operand : undefined;
  const isFunctionLiteral = (side: Readonly<IrExpression>): boolean =>
    side.kind === 'literal' && side.value === 'function';
  if (isFunctionLiteral(right)) return typeofOperand(left);
  if (isFunctionLiteral(left)) return typeofOperand(right);
  return undefined;
}

// `typeof X === tag` asks what X holds, and a closed union answers it even with several value domains:
// the tag selects the leaf type that reports it, and the test is whether the value holds that leaf's
// alternative. Leaves are reached through aliases and through any union a member names, because a
// property typed with an alias to a union -- `value: RiveValue` where
// `RiveValue = number | string | Uint8Array` -- is exactly the shape the SDK writes.
//
// Everything the rule cannot prove is refused rather than approximated: a leaf whose tag the emitter
// cannot determine (an open generic, `unknown`, a callable object, a member behind an alias cycle)
// makes the domain incomplete; two leaves reporting the tested tag is genuinely ambiguous; and a tag
// whose leaf the union's representation does not name as an alternative has no question to ask. When the
// domain is one value domain beside absence, the answer is presence and the presence machinery gives it
// directly, with the loose test `typeof` actually is.
function emitCppInferredOptionalTypeofTagComparisonCpp(
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
  const comparison = getCppTypeofTagComparisonCpp(expression.left, expression.right);
  if (!comparison) return undefined;
  // An element read is not the union's own storage: the key may name no cell at all, so the read can be
  // absent where the element's type carries no absence, and an alternative test would ask a cell that
  // need not exist. Element reads keep the lanes that already answer them -- the closed-key lane for a
  // literal key, and a refusal for a dynamic one.
  // A binding whose absence the narrowing lane owns is left to it: it already reads a guarded local as
  // the value its evidence proves, and answering here would displace that. A binding whose storage is a
  // variant of value alternatives has no absence for that lane to answer -- refusing it would leave the
  // tag question to the variant guard, which refuses precisely because nobody proved the member test.
  // This rule is that proof, so it answers those.
  if (
    comparison.operand.kind === 'identifier' &&
    comparison.operand.reference.kind === 'binding' &&
    hasCppAbsenceStorageCpp(comparison.operand, context)
  ) {
    return undefined;
  }
  if (comparison.operand.kind === 'element') return undefined;
  const operandType = getCppNullishComparisonOperandTypeCpp(comparison.operand, context);
  // An erased value answers the tag itself at run time, and it can answer only the words the runtime
  // carries: `Any::type_of` reports undefined, boolean, number, string, symbol, function, and object --
  // which is what it reports for null, an object, and an external too. It has no `bigint` at all,
  // because `Any` has no bigint kind, so a comparison against that tag is not a question the target can
  // ask. Emitting it would spell a test that is silently always false, which is a claim about the
  // source the target cannot make; the capability it would need is named instead.
  if (hasCppErasedDynamicTestOperandCpp(comparison.operand, operandType, context)) {
    if (!getCppErasedTypeofTagSupportCpp(comparison.tag)) {
      emissionError(
        context,
        `the runtime's erased value cannot report the tag '${comparison.tag}': it carries undefined, boolean, number, string, symbol, function, object and no bigint`,
        'cpp-erased-tag-unreportable',
      );
    }
    return undefined;
  }
  const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  if (!union) return undefined;
  const alternatives = union.types.map((member) => collectCppTypeofLeavesCpp(member, context, new Set()));
  if (alternatives.some((leaves) => leaves === undefined)) return undefined;
  const matching = alternatives.flatMap((entries) => entries!).filter((leaf) => leaf.tag === comparison.tag);
  const leaf = matching[0];
  if (matching.length !== 1 || !leaf) return undefined;
  const present = expression.operator === '==' || expression.operator === '===';
  // The domain is one value domain beside absence exactly when a single member carries every leaf, and
  // the tested leaf is one of them: then "reports that tag" and "is present" are the same answer. The
  // member is compared by its leaves rather than by identity because the leaf is what an alias resolves
  // to -- `transform: ColorTransformFunction` is the function, not the name for it.
  const valueIndexes = union.types
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.kind !== 'undefined' && member.kind !== 'null');
  if (valueIndexes.length === 1 && alternatives[valueIndexes[0]!.index]?.length === 1) {
    return emitCppPresenceTestCpp(comparison.operand, 'undefined', present, false, context);
  }
  const plan = getCppUnionRepresentationPlan(union, context);
  if (!plan || plan.kind === 'singleValue') return undefined;
  const canonical = normalizeCompilerStructuralValueCanonical(leaf.type);
  const slot = plan.valueSlots.find(
    (candidate) =>
      normalizeCompilerStructuralValueCanonical(candidate.runtimeType) === canonical ||
      candidate.sourceAlternatives.some(
        (alternative) => normalizeCompilerStructuralValueCanonical(alternative) === canonical,
      ),
  );
  if (!slot) return undefined;
  context.includes.add('variant');
  const emitted = emitExpression(comparison.operand, context);
  // Storage that carries absence beside the alternatives holds the variant indirectly, so the value has
  // to be present before an alternative can be asked for. The read is bound once because it may be a call
  // or an indexed read as easily as a name, and asking it twice would run it twice.
  const test =
    plan.kind === 'optionalVariant'
      ? `([&]() { const auto& typeof_value = ${emitted}; return typeof_value.has_value() && typeof_value.value().index() == ${String(plan.valueSlots.indexOf(slot))}; }())`
      : `std::holds_alternative<${slot.targetType}>(${emitted})`;
  return present ? test : `!(${test})`;
}

function emitCppErasedTypeofConditionalCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'conditional' }>>,
  context: EmitContext,
  expectedType: Readonly<IrType> | undefined,
): string | undefined {
  // A repeated plain binding or field is one stable carrier; an accessor is not. Capture that carrier
  // once so the `typeof` tag and checked extraction ask the same Any, and require the branch to read it.
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp' || !expectedType) return undefined;
  const guard =
    expression.condition.kind === 'binary' && expression.condition.operator === '&&'
      ? expression.condition.left
      : undefined;
  const test = guard && expression.condition.kind === 'binary' ? expression.condition.right : expression.condition;
  if (
    test.kind !== 'binary' ||
    (test.operator !== '==' && test.operator !== '===') ||
    expression.whenFalse.kind !== 'literal' ||
    expression.whenFalse.value !== null
  ) {
    return undefined;
  }
  const comparison = getCppTypeofTagComparisonCpp(test.left, test.right);
  const operandType = comparison ? getCppNullishComparisonOperandTypeCpp(comparison.operand, context) : undefined;
  const operandUnion = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  const operandPlan = operandUnion ? getCppUnionRepresentationPlan(operandUnion, context) : undefined;
  const erasedSlot = operandPlan?.valueSlots.find((slot) => slot.targetType === 'flight::Any');
  if (
    comparison?.tag !== 'string' ||
    !isCppStableErasedTypeofCarrierCpp(comparison.operand, expression.whenTrue, context) ||
    (!erasedSlot && !isCppAliasResolvedErasedDynamicValueTypeCpp(operandType, context))
  ) {
    return undefined;
  }
  const union = getIrUnionTypeCpp(expectedType, context, new Set());
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  const slot = plan?.kind === 'optionalSingle' ? plan.valueSlots[0] : undefined;
  if (!union || !plan || !slot || !isCppStringValueTypeCpp(slot.runtimeType, context, new Set())) return undefined;

  const carrier = getGeneratedTargetName('erasedTypeofCarrier', context);
  const absent = emitCppUnionSentinelConstruction('null', union, plan.kind, context);
  const guarded = guard ? `if (!(${emitCppTruthinessExpression(guard, context)})) return ${absent}; ` : '';
  context.includes.add('flight/any.hpp');
  const source = emitExpression(comparison.operand, context);
  if (!operandPlan || operandPlan.kind === 'singleValue') {
    const present = emitCppUnionValueConstruction(`${carrier}.as_string()`, slot.targetType, union, plan.kind, context);
    return `([&]() -> ${emitUnionTypeCpp(union, context)} { ${guarded}const auto& ${carrier} = ${source}; if (${carrier}.type_of() == flight::String("string")) return ${present}; return ${absent}; }())`;
  }
  if (operandPlan.kind !== 'multiVariant' && operandPlan.kind !== 'optionalVariant') return undefined;
  const stringSlot = operandPlan.valueSlots.find((candidate) =>
    isCppStringValueTypeCpp(candidate.runtimeType, context, new Set()),
  );
  if (!erasedSlot || !stringSlot) return undefined;
  const direct = getGeneratedTargetName('typeofString', context);
  const erased = getGeneratedTargetName('typeofErased', context);
  const variant = operandPlan.kind === 'optionalVariant' ? `${carrier}.value()` : carrier;
  const presentDirect = emitCppUnionValueConstruction(`*${direct}`, slot.targetType, union, plan.kind, context);
  const presentErased = emitCppUnionValueConstruction(
    `${erased}->as_string()`,
    slot.targetType,
    union,
    plan.kind,
    context,
  );
  const hasValue = operandPlan.kind === 'optionalVariant' ? `if (${carrier}.has_value()) { ` : '';
  const closeValue = operandPlan.kind === 'optionalVariant' ? ' }' : '';
  context.includes.add('variant');
  return `([&]() -> ${emitUnionTypeCpp(union, context)} { ${guarded}const auto& ${carrier} = ${source}; ${hasValue}if (const auto* ${direct} = std::get_if<${stringSlot.targetType}>(&${variant})) return ${presentDirect}; if (const auto* ${erased} = std::get_if<${erasedSlot.targetType}>(&${variant}); ${erased} && ${erased}->type_of() == flight::String("string")) return ${presentErased};${closeValue} return ${absent}; }())`;
}

function isCppStableErasedTypeofCarrierCpp(
  tested: Readonly<IrExpression>,
  narrowed: Readonly<IrExpression>,
  context: EmitContext,
): boolean {
  if (
    tested.kind === 'identifier' &&
    tested.reference.kind === 'binding' &&
    narrowed.kind === 'identifier' &&
    narrowed.reference.kind === 'binding'
  ) {
    return tested.reference.binding.id === narrowed.reference.binding.id;
  }
  return (
    tested.kind === 'property' &&
    !tested.optional &&
    tested.absent === undefined &&
    tested.object.kind === 'identifier' &&
    tested.object.reference.kind === 'binding' &&
    narrowed.kind === 'property' &&
    !narrowed.optional &&
    narrowed.absent === undefined &&
    narrowed.object.kind === 'identifier' &&
    narrowed.object.reference.kind === 'binding' &&
    tested.name === narrowed.name &&
    tested.object.reference.binding.id === narrowed.object.reference.binding.id &&
    !getIrExpressionClassAccessorCpp(tested.object, tested.name, 'get', context)
  );
}

// Every leaf an alternative can hold, with the JavaScript `typeof` tag that leaf reports, following the
// alternative's aliases and descending into any union it names. Undefined means the domain is incomplete
// -- a member behind an alias cycle, or a type whose tag the emitter cannot determine -- and the caller
// refuses rather than answering from part of a domain.
function collectCppTypeofLeavesCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  resolving: ReadonlySet<string>,
): readonly Readonly<{ tag: string; type: Readonly<IrType> }>[] | undefined {
  if (type.kind === 'union') {
    const collected: Readonly<{ tag: string; type: Readonly<IrType> }>[] = [];
    for (const member of type.types) {
      const leaves = collectCppTypeofLeavesCpp(member, context, resolving);
      if (!leaves) return undefined;
      collected.push(...leaves);
    }
    return collected;
  }
  if (type.kind === 'named' && type.reference.kind === 'binding') {
    const bindingId = type.reference.binding.id;
    if (resolving.has(bindingId)) return undefined;
    const target = resolveCppTypeAliasTarget(type, context);
    if (target) return collectCppTypeofLeavesCpp(target, context, new Set(resolving).add(bindingId));
  }
  const tag = getCppStaticTypeofTypeCpp(type, context, new Set(resolving));
  return tag ? [{ tag, type }] : undefined;
}

// Whether the runtime's erased value can report this tag. `Any::type_of` is ECMAScript `typeof` over
// the kinds `Any` has: undefined, boolean, number, string, symbol and function each have one, and null,
// an object and an external all report `object`. `bigint` has no kind, so it can never be reported --
// which is what this answers, and it is a capability boundary rather than a guess about the value.
function getCppErasedTypeofTagSupportCpp(tag: string): boolean {
  switch (tag) {
    case 'undefined':
    case 'boolean':
    case 'number':
    case 'string':
    case 'symbol':
    case 'function':
    case 'object':
      return true;
    default:
      return false;
  }
}

// The operand of a `typeof X === tag` comparison, and the tag: one side a `typeof` of anything and the
// other a string literal, in either order. Two `typeof`s, a literal on both sides, or a tag that is not
// a literal are not this comparison.
function getCppTypeofTagComparisonCpp(
  left: Readonly<IrExpression>,
  right: Readonly<IrExpression>,
): Readonly<{ operand: Readonly<IrExpression>; tag: string }> | undefined {
  const typeofOperand = (side: Readonly<IrExpression>): Readonly<IrExpression> | undefined =>
    side.kind === 'unary' && side.operator === 'typeof' ? side.operand : undefined;
  const tagLiteral = (side: Readonly<IrExpression>): string | undefined =>
    side.kind === 'literal' && typeof side.value === 'string' ? side.value : undefined;
  const rightTag = tagLiteral(right);
  if (rightTag !== undefined) {
    const operand = typeofOperand(left);
    return operand ? { operand, tag: rightTag } : undefined;
  }
  const leftTag = tagLiteral(left);
  if (leftTag !== undefined) {
    const operand = typeofOperand(right);
    return operand ? { operand, tag: leftTag } : undefined;
  }
  return undefined;
}

function emitCppInferredOptionalNullishComparison(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): string | undefined {
  if (!['==', '===', '!=', '!=='].includes(expression.operator)) return undefined;
  const leftSentinel = getCppNullishLiteralKind(expression.left);
  const rightSentinel = getCppNullishLiteralKind(expression.right);
  if ((leftSentinel ? 1 : 0) + (rightSentinel ? 1 : 0) !== 1) return undefined;
  return emitCppPresenceTestCpp(
    leftSentinel ? expression.right : expression.left,
    leftSentinel ?? rightSentinel!,
    expression.operator === '!=' || expression.operator === '!==',
    expression.operator === '===' || expression.operator === '!==',
    context,
  );
}

// The declared type of a presence-test operand. A binding is asked for its binding type rather than
// its narrowed type: a presence test reads its operand outside the branch it guards, so the narrowing
// the body sees is not the one the test asks about.
function getCppNullishComparisonOperandTypeCpp(
  operand: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return operand.kind === 'identifier' && operand.reference.kind === 'binding'
    ? getCppBindingTypeCpp(operand.reference.binding.id, context)
    : getIrExpressionTypeEvidenceCpp(operand, context);
}

// Whether the emitted expression carries absence in its own storage: an `std::optional<...>` from an
// indexed read, or a read of an optional row member. This is the STORAGE axis and the declared type
// is a separate question -- a `Readonly<Record<string, V>>` index read shows no union in its type
// while the lowering elected `std::optional` storage for it, so neither axis can be read off the
// other.
function hasCppAbsenceStorageCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    (context.nullableBindingIds.has(expression.reference.binding.id) ||
      context.arrayElementBindingIds.has(expression.reference.binding.id))
  ) {
    return true;
  }
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    (hasCppRegExpExecArrayIndexedReceiverCpp(expression, context) ||
      hasIndexedRuntimeReceiverCpp(expression, context) ||
      Boolean(
        getCppRecordTypeArgumentsCpp(getIrExpressionTypeEvidenceCpp(expression.object, context), context, new Set()),
      ))
  ) {
    return true;
  }
  return (
    expression.kind === 'property' &&
    expression.optional &&
    expression.object.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression.object, context)
  );
}

// An optional property whose declared type is a nullable alias has two independent absence channels
// in its emitted storage. The property's outer optional represents omission (`undefined`), while the
// alias's inner optional represents its declared `null`. Alias identity is deliberately retained in
// the field type, so the effective read type's dual-sentinel plan cannot be used directly: that plan
// describes a flat variant, while the field is `optional<NullableAlias>`.
//
// Keep this query tied to the declaration and the storage election. A directly written nullable union
// is materialized as one flat three-state value by emitCppObjectPropertyStorageCpp and therefore does
// not qualify; only a type whose declared spelling hides the nullish member, but whose resolved union
// has exactly null-as-optional-absence, produces the nested representation answered below.
function hasCppNestedNullableOptionalPropertyStorageCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): boolean {
  if (expression.kind !== 'property' || expression.optional || getCppRuntimeProfile(context.options) !== 'flight-cpp') {
    return false;
  }
  const receiverType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  if (!receiverType) return false;
  const row = getCppStructuralRowExpressionPlanCpp(expression.object, context);
  const objectType = row ? getCppStructuralRowObjectTypeCpp(row) : receiverType;
  if (!objectType) return false;
  const property = context.referenceRepresentationPlanner
    .resolveObjectShape(objectType, context.module)
    ?.find((candidate) => candidate.name === expression.name);
  if (!property?.optional || hasIrTypeAbsentMember(property.type)) return false;
  const union = getIrUnionTypeCpp(property.type, context, new Set());
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  return (
    (plan?.kind === 'optionalSingle' || plan?.kind === 'optionalVariant') && plan.sentinels.null === 'optionalAbsence'
  );
}

interface CppGenericCarrierPropertyPresencePlan {
  readonly kind: 'alwaysPresent' | 'optionalUndefined';
  readonly valueType: Readonly<IrType>;
}

// A constrained generic carrier keeps its member storage dependent. `Readonly<T>` is emitted as a
// row over T, and row_get therefore returns generated_row_member_t<Key, T>: an optional member in one
// valid instantiation may be a required bare value in a narrower one. The constraint can still prove
// the complete set of representations a nullish test must handle when it names one closed property,
// one present runtime domain, and at most undefined absence. In that case C++ can select between the
// optional and bare storage at instantiation without choosing a destination type or erasing the value.
//
// Nullable, erased, open, or union-shaped constraints deliberately do not qualify. Null and undefined
// may use the same optional spelling with different meanings, Any carries its own tag, and an open or
// ambiguous constraint does not prove which member storage an instantiation supplies.
function getCppGenericCarrierPropertyPresencePlanCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<CppGenericCarrierPropertyPresencePlan> | undefined {
  if (expression.kind !== 'property' || expression.optional || getCppRuntimeProfile(context.options) !== 'flight-cpp') {
    return undefined;
  }
  const receiverType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const typeParameter = getCppReadonlyBareTypeParameterCpp(receiverType) ?? receiverType;
  const declaration = typeParameter ? getCppTypeParameterDeclarationCpp(typeParameter, context) : undefined;
  const constraint = declaration
    ? getCppDependentTypeParameterConstraintCpp(declaration.binding.id, context)
    : undefined;
  if (!constraint || getIrUnionTypeCpp(constraint, context, new Set())) return undefined;
  const row = getCppStructuralRowExpressionPlanCpp(expression.object, context);
  if (row) {
    const rowObject = getCppStructuralRowObjectTypeCpp(row);
    if (
      !rowObject ||
      normalizeCompilerStructuralValueCanonical(rowObject) !== normalizeCompilerStructuralValueCanonical(typeParameter!)
    ) {
      return undefined;
    }
  } else if (receiverType !== typeParameter || !hasFlightReferenceRepresentationCpp(constraint, context)) {
    return undefined;
  }
  const properties = context.referenceRepresentationPlanner.resolveObjectShape(constraint, context.module);
  if (!properties || properties.some((property) => property.computedKey)) return undefined;
  const matches = properties?.filter((property) => property.name === expression.name) ?? [];
  const property = matches.length === 1 ? matches[0] : undefined;
  if (
    !property ||
    property.computedKey ||
    property.phantom ||
    property.role ||
    isCppAliasResolvedErasedDynamicValueTypeCpp(property.type, context)
  ) {
    return undefined;
  }
  const readType = getIrObjectPropertyReadTypeCpp(property);
  if (!readType) return undefined;
  const union = getIrUnionTypeCpp(readType, context, new Set());
  if (!union) return { kind: 'alwaysPresent', valueType: readType };
  const plan = getCppUnionRepresentationPlan(union, context);
  if (
    plan.kind === 'singleValue' &&
    plan.valueSlots.length === 1 &&
    plan.sentinels.null === 'absent' &&
    plan.sentinels.undefined === 'absent'
  ) {
    return { kind: 'alwaysPresent', valueType: plan.valueSlots[0]!.runtimeType };
  }
  return plan.kind === 'optionalSingle' &&
    plan.valueSlots.length === 1 &&
    plan.sentinels.null === 'absent' &&
    plan.sentinels.undefined === 'optionalAbsence'
    ? { kind: 'optionalUndefined', valueType: plan.valueSlots[0]!.runtimeType }
    : undefined;
}

// An optional parameter adds one storage layer outside its declared type: the outer `std::optional`
// records an omitted argument (`undefined`). When the declared payload is exactly `null`, engagement
// itself records the other sentinel. When the declared type is a nullable value union, its inner
// `std::optional` records `null` while the outer layer still records `undefined`. These are the two
// declaration-elected shapes that preserve both sentinels without a flat dual-sentinel variant.
//
// Keep the query tied to an optional parameter with no default. A required `null` parameter has no
// outer storage, and a defaulted parameter consumes `undefined` before its body observes the value.
function getCppOptionalParameterNullishStorageCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): 'nestedNullable' | 'nullPayload' | undefined {
  if (
    expression.kind !== 'identifier' ||
    expression.reference.kind !== 'binding' ||
    !context.optionalParameterBindingIds.has(expression.reference.binding.id)
  ) {
    return undefined;
  }
  const type = getCppBindingTypeCpp(expression.reference.binding.id, context);
  if (type?.kind === 'null') return 'nullPayload';
  const union = type ? getIrUnionTypeCpp(type, context, new Set()) : undefined;
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  return (plan?.kind === 'optionalSingle' || plan?.kind === 'optionalVariant') &&
    plan.sentinels.null === 'optionalAbsence' &&
    plan.sentinels.undefined === 'absent'
    ? 'nestedNullable'
    : undefined;
}

// A source member is projected from the payload, never from `std::optional` itself. The storage fact
// and the source type are deliberately separate: Record and indexed Array reads may elect optional
// storage even when their TypeScript annotation names only the payload. Require control-flow evidence
// before crossing that boundary, and require one present runtime domain so a resolved member cannot be
// applied to a heterogeneous carrier merely because one alternative happens to provide it.
function assertCppPresentOptionalStorageMemberReceiverCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): void {
  const receiver = expression.object;
  if (receiver.kind !== 'identifier' || receiver.reference.kind !== 'binding') return;
  const bindingId = receiver.reference.binding.id;
  if (!context.nullableBindingIds.has(bindingId) && !context.arrayElementBindingIds.has(bindingId)) return;
  if (receiver.presence !== 'narrowedPresent') {
    emissionError(
      context,
      `member ${expression.name} on optional C++ storage requires proven present payload`,
      'cpp-member-projection-without-present-storage',
    );
  }
  const storageType = getCppBindingTypeCpp(bindingId, context);
  const payload = storageType ? getCppNonNullableType(storageType, context, new Set()) : undefined;
  if (!payload) {
    emissionError(
      context,
      `member ${expression.name} on optional C++ storage requires one present payload domain`,
      'cpp-member-projection-multiple-present-domains',
    );
  }
  const union = getIrUnionTypeCpp(payload, context, new Set());
  if (union && getCppUnionRepresentationPlan(union, context).valueSlots.length !== 1) {
    emissionError(
      context,
      `member ${expression.name} on optional C++ storage requires one present payload domain`,
      'cpp-member-projection-multiple-present-domains',
    );
  }
}

// Emits a presence test on `operand` -- `operand === sentinel`, `operand !== sentinel`, and their loose
// forms. Total: every shape either has an emitted storage that can answer the question or is refused
// with the rule that names which representation is missing.
//
// Two axes decide the answer and neither alone is sufficient. The STORAGE axis asks whether the
// emitted expression carries absence, and it is the only axis that can answer for a `Record` index
// read whose declared type shows no union while the lowering elected `std::optional` storage. The
// TYPE axis asks what the declared type admits, and it is the only axis that can answer for a
// `flight::Ref<T>` whose type excludes the sentinel, where the reference has no overload to compare
// against `flight::undefined` and the comparison is a tautology the source wrote deliberately.
//
// A storage query answers the test at runtime; a type that excludes the sentinel answers it at
// compile time, which is the same rule the `??` lane already applies to a non-nullable left operand.
function emitCppPresenceTestCpp(
  operand: Readonly<IrExpression>,
  sentinel: 'null' | 'undefined',
  present: boolean,
  strict: boolean,
  context: EmitContext,
): string {
  const operandType = getCppNullishComparisonOperandTypeCpp(operand, context);
  const union = operandType ? getIrUnionTypeCpp(operandType, context, new Set()) : undefined;
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  const optionalParameterStorage = getCppOptionalParameterNullishStorageCpp(operand, context);
  if (optionalParameterStorage === 'nullPayload') {
    if (!strict) return present ? 'false' : 'true';
    context.includes.add('optional');
    const hasValue = `${emitExpression(operand, context)}.has_value()`;
    return sentinel === 'undefined' ? `${present ? '' : '!'}${hasValue}` : `${present ? '!' : ''}${hasValue}`;
  }
  if (optionalParameterStorage === 'nestedNullable') {
    context.includes.add('optional');
    const value = emitExpression(operand, context);
    let test: string;
    if (!strict) {
      test = present
        ? 'presence_operand.has_value() && presence_operand.value().has_value()'
        : '!presence_operand.has_value() || !presence_operand.value().has_value()';
    } else if (sentinel === 'undefined') {
      test = `${present ? '' : '!'}presence_operand.has_value()`;
    } else {
      test = present
        ? '!presence_operand.has_value() || presence_operand.value().has_value()'
        : 'presence_operand.has_value() && !presence_operand.value().has_value()';
    }
    return `([&]() { const auto& presence_operand = ${value}; return ${test}; }())`;
  }
  const genericCarrier = getCppGenericCarrierPropertyPresencePlanCpp(operand, context);
  if (genericCarrier) {
    context.includes.add('flight/structural_ref.hpp');
    context.includes.add('type_traits');
    const valueName = getGeneratedTargetName('presenceOperand', context);
    const value = emitExpression(operand, context);
    const requiredResult = present ? 'true' : 'false';
    const absenceMatches = !strict || sentinel === 'undefined';
    if (genericCarrier.kind === 'alwaysPresent' || !absenceMatches) {
      return `([&]() { const auto& ${valueName} = ${value}; static_cast<void>(${valueName}); return ${requiredResult}; }())`;
    }
    const optionalResult = `${present ? '' : '!'}${valueName}.has_value()`;
    return `([&]() { const auto& ${valueName} = ${value}; if constexpr (flight::detail::optional_traits<std::remove_cvref_t<decltype(${valueName})>>::optional) return ${optionalResult}; return ${requiredResult}; }())`;
  }
  if (hasCppNestedNullableOptionalPropertyStorageCpp(operand, context)) {
    context.includes.add('optional');
    const value = emitExpression(operand, context);
    let test: string;
    if (!strict) {
      test = present
        ? 'presence_operand.has_value() && presence_operand.value().has_value()'
        : '!presence_operand.has_value() || !presence_operand.value().has_value()';
    } else if (sentinel === 'undefined') {
      test = `${present ? '' : '!'}presence_operand.has_value()`;
    } else {
      test = present
        ? '!presence_operand.has_value() || presence_operand.value().has_value()'
        : 'presence_operand.has_value() && !presence_operand.value().has_value()';
    }
    return `([&]() { const auto& presence_operand = ${value}; return ${test}; }())`;
  }
  if (plan?.kind === 'dualSentinelVariant') {
    context.includes.add('variant');
    const sentinels = getCppDualSentinelTargetTypes(context);
    const selected = sentinel === 'null' ? sentinels.null : sentinels.undefined;
    const value = emitExpression(operand, context);
    const test = strict
      ? `std::holds_alternative<${selected}>(${value})`
      : `(std::holds_alternative<${sentinels.null}>(${value}) || std::holds_alternative<${sentinels.undefined}>(${value}))`;
    return present ? `!(${test})` : test;
  }
  if (
    plan?.kind === 'optionalSingle' ||
    plan?.kind === 'optionalVariant' ||
    hasCppAbsenceStorageCpp(operand, context)
  ) {
    context.includes.add('optional');
    return `${present ? '' : '!'}${emitOptionalExpressionCpp(operand, context, operandType)}.has_value()`;
  }
  if (hasCppErasedDynamicTestOperandCpp(operand, operandType, context)) {
    context.includes.add('flight/any.hpp');
    // The erased dynamic value keeps presence in its own kind tag and carries the predicate for it, so
    // the test is an operation on the chosen representation rather than a comparison the target's
    // operator set has to have been given. `is_nullish` is the loose test exactly -- the runtime
    // documents it as ``== null`` in TypeScript -- so a strict comparison asks the named predicate and
    // a loose one asks that.
    const predicate = strict ? (sentinel === 'null' ? 'is_null' : 'is_undefined') : 'is_nullish';
    // The operand is evaluated once. A presence test may be written against a call or an indexed read
    // as easily as against a plain binding, and asking the predicate twice would run it twice.
    return `([&]() { const auto& presence_operand = ${emitExpression(operand, context)}; return ${present ? '!' : ''}presence_operand.${predicate}(); }())`;
  }
  // A loose comparison is true for either sentinel, so a type decides it only when it admits neither.
  const admitted = strict
    ? admitsCppNullishSentinelCpp(operandType, sentinel, context)
    : admitsCppNullishSentinelCpp(operandType, 'null', context) ||
      admitsCppNullishSentinelCpp(operandType, 'undefined', context);
  if (!admitted) return present ? 'true' : 'false';
  refuseCppPresenceTestCpp(operand, sentinel, context);
}

// Whether a presence test on `operand` is answered by the erased dynamic value's own kind tag.
//
// The question is about STORAGE, not about the declared type, and the two disagree in both directions.
// A binding answers from `erasedDynamicStorageBindingIds`, because its declaration made the decision:
// a `let` annotated `any` is stored erased so it can be reassigned across alternatives, while a
// `const` with an initializer keeps whatever the initializer proves -- `const rows = grid.length` is a
// `double` -- and an annotation of `unknown` there describes nothing the storage actually does. Asking
// the annotation would give both of those the wrong answer.
//
// Anything that is not a binding is a read of a declared member, and a member is emitted with its own
// declared type, so there the type is the storage and no second source is needed.
function hasCppErasedDynamicTestOperandCpp(
  operand: Readonly<IrExpression>,
  operandType: Readonly<IrType> | undefined,
  context: EmitContext,
): boolean {
  if (!isCppAliasResolvedErasedDynamicValueTypeCpp(operandType, context)) return false;
  return operand.kind === 'identifier' && operand.reference.kind === 'binding'
    ? context.erasedDynamicStorageBindingIds.has(operand.reference.binding.id)
    : true;
}

function isCppAliasResolvedErasedDynamicValueTypeCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (isCppErasedDynamicValueTypeCpp(type)) return true;
  const union = type ? getIrUnionTypeCpp(type, context, new Set()) : undefined;
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  if (plan?.kind === 'singleValue' && plan.valueSlots[0]?.targetType === 'flight::Any') return true;
  if (type?.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.binding.kind === 'typeParameter') {
    return false;
  }
  const key = `${type.reference.binding.id}\0${JSON.stringify(type.typeArguments)}`;
  if (seen.has(key)) return false;
  const target = resolveCppTypeAliasTarget(type, context);
  return target ? isCppAliasResolvedErasedDynamicValueTypeCpp(target, context, new Set(seen).add(key)) : false;
}

// Whether a declaration's storage decision elected the erased dynamic value.
//
// This mirrors the spelling election the declaration emitters perform a few lines below their own
// start, and it is the single owner of the answer for every binding: the collector records bindings
// through it and reports the result to `erasedDynamicStorageBindingIds`, so a presence test reads the
// decision instead of re-deriving it. A parameter passes `mutable: true`, which is only to say that
// nothing about a parameter is deduced from an initializer -- a parameter is emitted with its declared
// type, so its type is its storage.
function hasCppErasedDynamicStorageCpp(
  declaration: Readonly<{
    binding: Readonly<{ id: string }>;
    initializer?: Readonly<IrExpression> | undefined;
    mutable: boolean;
    type?: Readonly<IrType> | undefined;
  }>,
  context: EmitContext,
): boolean {
  const bindingId = declaration.binding.id;
  // A storage spelling named by an override is that spelling, whatever the annotation says.
  if (
    context.externalBindingStorageTargetTypes.has(bindingId) ||
    context.contextualBindingStorageTargetTypes.has(bindingId) ||
    context.preservedInitializerTypes.has(bindingId) ||
    context.structuralCastBindingRows.has(bindingId)
  ) {
    return false;
  }
  if (
    !declaration.type ||
    isCppDeducibleUnknownStorageCpp(declaration.mutable, declaration.initializer, declaration.type)
  ) {
    // The declaration emits `auto` and the initializer decides the storage, so the initializer's own
    // evidence is the answer -- and it is the same answer whether this is asked before emission, as
    // the collector does, or after, when a concrete inferred type has been preserved.
    const initializerType = declaration.initializer
      ? getIrExpressionTypeEvidenceCpp(declaration.initializer, context)
      : undefined;
    return isCppErasedDynamicValueTypeCpp(initializerType);
  }
  return isCppErasedDynamicValueTypeCpp(declaration.type);
}

// A presence test whose emitted storage has no absence channel at all, which happens only where the
// type admits the sentinel: the value can be absent at runtime and the representation cannot say so.
// Reported with a named rule rather than guessed at.
function refuseCppPresenceTestCpp(
  operand: Readonly<IrExpression>,
  sentinel: 'null' | 'undefined',
  context: EmitContext,
): never {
  emissionError(
    context,
    `a presence test against ${sentinel} has no absence channel in the emitted C++ storage for ${operand.kind}`,
    'cpp-presence-test-without-absence-storage',
  );
}

// Whether the declared type admits the nullish sentinel. A type that admits it can be absent at
// runtime, so a presence test on it is a question about storage; a type that excludes it makes the
// test a question the type already answers. An erased dynamic value names no value type at all, so it
// admits whatever it is asked about.
function admitsCppNullishSentinelCpp(
  type: Readonly<IrType> | undefined,
  sentinel: 'null' | 'undefined',
  context: EmitContext,
): boolean {
  if (!type) return true;
  if (isCppErasedDynamicValueTypeCpp(type)) return true;
  const union = getIrUnionTypeCpp(type, context, new Set());
  const members = union ? union.types : [type];
  return members.some((member) => (sentinel === 'null' ? member.kind === 'null' : member.kind === 'undefined'));
}

// The finite key set retained from the checker's resolved string-literal domain, or directly visible
// in the index's IR type -- `signals[name]` with `name` declared as a literal union. A key widened to
// `string` has no such set, and that difference is the whole reason this can be attempted here and
// refused there: the closed evidence says which members the access can reach, while `string` says nothing.
function getCppClosedElementKeyNamesCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): readonly string[] | undefined {
  if (expression.semantics.closedKeys) return expression.semantics.closedKeys;
  const index = expression.index;
  const type = getIrExpressionTypeEvidenceCpp(index, context);
  if (!type) return undefined;
  if (type.kind === 'literal') return typeof type.value === 'string' ? [type.value] : undefined;
  const union = getIrUnionTypeCpp(type, context, new Set());
  if (!union || union.types.length === 0) return undefined;
  const keys: string[] = [];
  for (const member of union.types) {
    if (member.kind !== 'literal' || typeof member.value !== 'string') return undefined;
    if (!keys.includes(member.value)) keys.push(member.value);
  }
  return keys;
}

// `typeof backend[operation]` does not need a common C++ value type for every selected member. It
// needs the smaller runtime domain that `typeof` observes. A finite key set proves which represented
// fields can be reached, and each field independently proves its present domain; optional fields
// retain their runtime absence test. Distinct present domains remain unanswerable here, as does an
// open key, because neither identifies one operation the target can perform without erasing values.
function emitCppClosedKeyElementTypeofCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  if (expression.kind !== 'element') return undefined;
  const keys = getCppClosedElementKeyNamesCpp(expression, context);
  if (!keys) return undefined;
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const runtime = objectType ? getIrTypeRuntimeDomainCpp(objectType, context, new Set()) : undefined;
  const properties = runtime
    ? context.referenceRepresentationPlanner.resolveObjectShape(runtime, context.module)
    : undefined;
  if (!runtime || !properties || !hasFlightReferenceRepresentationCpp(runtime, context)) return undefined;
  const members = new Map<string, Readonly<IrObjectTypeProperty>>();
  for (const property of properties) {
    if (isCppValuelessStructMemberCpp(property.type)) continue;
    if (!members.has(property.name)) members.set(property.name, property);
  }
  const selections = keys.map((key) => ({ key, property: members.get(key) }));
  if (selections.some((selection) => !selection.property)) return undefined;
  const domains = selections.map((selection) =>
    getCppStaticTypeofTypeCpp(selection.property!.type, context, new Set()),
  );
  const domain = domains[0];
  if (!domain || domains.some((candidate) => candidate !== domain)) return undefined;
  const receiver = getGeneratedTargetName('typeofReceiver', context);
  const key = getGeneratedTargetName('typeofKey', context);
  const branches = selections.map((selection) => {
    const selected = `${receiver}->${safeCppName(selection.property!.name)}`;
    const value = selection.property!.optional
      ? `${selected}.has_value() ? ${emitLiteral(domain, context)} : ${emitLiteral('undefined', context)}`
      : emitLiteral(domain, context);
    return `if (${key} == ${emitLiteral(selection.key, context)}) return ${value};`;
  });
  context.includes.add('stdexcept');
  const result = emitType({ kind: 'primitive', name: 'string' }, context);
  return `([&]() -> ${result} { const auto& ${receiver} = ${emitExpression(expression.object, context)}; const auto ${key} = ${emitExpression(expression.index, context)}; ${branches.join(' ')} throw std::logic_error("Flight finite-key typeof reached no member"); }())`;
}

// Selects the member a finite key names. This is still a dispatch at runtime, because the key's value
// chooses the member, but it is a dispatch over a set the compiler enumerated rather than a subscript
// the target has no operator for.
//
// Every key must name a member the object actually emits, and the members must lower to one C++ type:
// a key the object does not have would select nothing, and members of different types would need a
// result representation that can hold several, which is a question for the union planner rather than
// for this access.
function emitCppClosedKeyElementSelectionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  keys: readonly string[],
  context: EmitContext,
): string {
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const runtime = objectType ? getIrTypeRuntimeDomainCpp(objectType, context, new Set()) : undefined;
  const properties = runtime
    ? context.referenceRepresentationPlanner.resolveObjectShape(runtime, context.module)
    : undefined;
  if (!runtime || !properties) {
    emissionError(
      context,
      'closed-key element access requires represented object storage',
      'cpp-closed-key-access-without-object-storage',
    );
  }
  const members = new Map<string, Readonly<IrObjectTypeProperty>>();
  for (const property of properties) {
    if (isCppValuelessStructMemberCpp(property.type)) continue;
    if (!members.has(property.name)) members.set(property.name, property);
  }
  const memberTypes: string[] = [];
  for (const key of keys) {
    const property = members.get(key);
    if (!property) {
      emissionError(
        context,
        `closed key ${key} is not a member of ${emitType(runtime, context)}`,
        'cpp-closed-key-absent-member',
      );
    }
    // Select the member's read type rather than its declared payload. For an optional member this is
    // `T | undefined`, whose C++ representation is the optional cell the materialized object stores.
    memberTypes.push(emitType(getIrObjectPropertyReadTypeCpp(property)!, context));
  }
  const distinct = [...new Set(memberTypes)];
  if (distinct.length !== 1) {
    emissionError(
      context,
      `closed-key selection over ${String(distinct.length)} member types requires a represented result union`,
      'cpp-closed-key-multiple-member-types',
    );
  }
  const receiver = getGeneratedTargetName('selectionReceiver', context);
  const selectionKey = getGeneratedTargetName('selectionKey', context);
  const select = (member: string): string => `${receiver}->${safeCppName(member)}`;
  const branches = keys.map((key) => {
    const property = members.get(key)!;
    return `if (${selectionKey} == ${emitLiteral(key, context)}) return ${select(property.name)};`;
  });
  context.includes.add('stdexcept');
  // JavaScript evaluates the receiver and key once, in that order. Binding both before the dispatch
  // keeps that contract for effectful expressions as well as the plain identifiers in the common case.
  return `([&]() -> ${distinct[0]!} { const auto& ${receiver} = ${emitExpression(expression.object, context)}; const auto ${selectionKey} = ${emitExpression(expression.index, context)}; ${branches.join(' ')} throw std::logic_error("Flight finite-key selection reached no member"); }())`;
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

function emitCppErasedRefAssertionCpp(
  expression: Readonly<IrExpression>,
  assertedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  const sourceType = getIrExpressionTypeEvidenceCpp(expression, context);
  const sourceUnion = sourceType ? getIrUnionTypeCpp(sourceType, context, new Set()) : undefined;
  const assertedUnion = getIrUnionTypeCpp(assertedType, context, new Set());
  if (!sourceUnion || !assertedUnion) return undefined;
  const sourcePlan = getCppUnionRepresentationPlan(sourceUnion, context);
  const assertedPlan = getCppUnionRepresentationPlan(assertedUnion, context);
  if (
    sourcePlan.kind !== 'optionalSingle' ||
    sourcePlan.valueSlots.length !== 1 ||
    sourcePlan.valueSlots[0]!.targetType !== 'flight::ErasedRef' ||
    assertedPlan.kind !== 'optionalSingle' ||
    assertedPlan.valueSlots.length !== 1
  ) {
    return undefined;
  }
  const assertedSlot = assertedPlan.valueSlots[0]!;
  const concreteObject = getCppReferenceElementTypeNameCpp(assertedSlot.targetType);
  const genericReference = assertedSlot.sourceAlternatives.some(
    (alternative) =>
      alternative.kind === 'named' &&
      alternative.reference.kind === 'binding' &&
      alternative.reference.binding.kind === 'typeParameter' &&
      alternative.typeArguments.length === 0,
  );
  const objectType =
    concreteObject ?? (genericReference ? `typename ${assertedSlot.targetType}::element_type` : undefined);
  if (!objectType) return undefined;
  context.includes.add('flight/erased_ref.hpp');
  context.includes.add('optional');
  const recovered = getGeneratedTargetName('erasedReference', context);
  return `([&]() -> ${emitType(assertedType, context)} { auto ${recovered} = flight::erased_ref_as<${objectType}>(${emitExpression(expression, context)}); if (!${recovered}) return std::nullopt; return ${recovered}; }())`;
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
  // An assertion that names the union's own value type with a marker around it -- `mesh[key] as
  // MeshRuntime | undefined` against a slot holding `Ref<EntityRuntime>` -- cannot match a slot by
  // spelling, because the asserted target is the whole optional and the slot is the value inside it.
  // When both sides are one-value unions of the same representation kind, the assertion is narrowing
  // that single alternative, and the narrowing is a reference cast between two records. The cast is
  // only built when BOTH spellings are references, so an assertion between unrelated forms still
  // refuses rather than emitting something that cannot compile.
  const assertedUnion = getIrUnionTypeCpp(assertedType, context, new Set());
  const assertedPlan = assertedUnion ? getCppUnionRepresentationPlan(assertedUnion, context) : undefined;
  const narrowing =
    plan.valueSlots.length === 1 && assertedPlan?.valueSlots.length === 1 && assertedPlan.kind === plan.kind
      ? getCppReferenceNarrowingCpp(plan.valueSlots[0]!.targetType, assertedPlan.valueSlots[0]!.targetType)
      : undefined;
  const structuralNarrowing =
    plan.valueSlots.length === 1 && assertedPlan?.valueSlots.length === 1 && assertedPlan.kind === plan.kind
      ? isCppExplicitStructuralRowExtensionCpp(
          plan.valueSlots[0]!.runtimeType,
          assertedPlan.valueSlots[0]!.runtimeType,
          context,
        )
      : false;
  const alternatives = plan.valueSlots.filter(
    (slot) =>
      narrowing !== undefined ||
      structuralNarrowing ||
      slot.targetType === assertedTarget ||
      slot.sourceAlternatives.some((member) => isDeepStrictEqual(member, assertedType)),
  );
  if (alternatives.length !== 1) {
    // The alternatives are matched by target type, so naming the target and the types it was
    // compared against is what makes the refusal readable without a debugger: the asserted target
    // is often the whole optional the union already spells, compared against a slot's stored value.
    emissionError(
      context,
      `type assertion target must identify exactly one C++ variant alternative: target ${assertedTarget} against [${plan.valueSlots
        .map((slot) => slot.targetType)
        .join(', ')}]`,
      'cpp-type-assertion-unidentified',
    );
  }
  // This path owns projection out of the binding's declared union carrier. An identifier can also
  // carry checker flow evidence that makes ordinary reads project the present value. Rendering that
  // narrowed read here and then applying the assertion's projection consumes the same carrier twice.
  // Keep the raw binding storage for an identifier; the selected plan below performs exactly the
  // optional or variant access proved by the assertion target.
  const value =
    expression.kind === 'identifier' && expression.reference.kind === 'binding'
      ? emitIdentifierReference(expression.reference, context)
      : emitExpression(expression, context);
  if (plan.kind === 'singleValue') return value;
  context.includes.add(plan.kind === 'optionalSingle' ? 'optional' : 'variant');
  // The cast names the asserted type whenever the slot's stored spelling is not already it: a narrowing
  // has its own element, a subtype assertion narrows the slot to what was named, and an exact match
  // needs nothing. Only a reference can be pointer-cast; anything else keeps the slot's spelling, which
  // is what the union already stores.
  const cast =
    narrowing?.cast ??
    (alternatives[0]!.targetType === assertedTarget ? undefined : getCppReferenceElementTypeNameCpp(assertedTarget));
  const narrowed = (inner: string): string => {
    if (structuralNarrowing) {
      context.includes.add('flight/structural_ref.hpp');
      return `flight::structural_ref_cast<${assertedPlan!.valueSlots[0]!.targetType}>(${inner})`;
    }
    if (cast === undefined) return inner;
    context.includes.add('memory');
    return `std::static_pointer_cast<${cast}>(${inner})`;
  };
  if (plan.kind === 'optionalSingle') return narrowed(`${value}.value()`);
  if (plan.kind === 'optionalVariant') return narrowed(`std::get<${alternatives[0]!.targetType}>(${value}.value())`);
  return narrowed(`std::get<${alternatives[0]!.targetType}>(${value})`);
}

// A structural assertion may add a row only when the target plan literally contains the source
// plan. That is the generic `NodeOf<Traits> -> NodeOf<Traits> & HasTransform3D` relationship: the
// target is an explicit view extension of the same referent. Merely overlapping object properties do
// not satisfy this proof, so a foreign or wider source row still refuses.
function isCppExplicitStructuralRowExtensionCpp(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const sourceRow = context.referenceRepresentationPlanner.resolveStructuralRow(source, context.module);
  const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(target, context.module);
  return Boolean(sourceRow && targetRow && cppStructuralRowContainsPlanCpp(targetRow, sourceRow, context));
}

function cppStructuralRowContainsPlanCpp(
  target: Readonly<CompilerCppStructuralRowPlan>,
  source: Readonly<CompilerCppStructuralRowPlan>,
  context: EmitContext,
): boolean {
  if (
    normalizeCompilerStructuralValueCanonical(target) === normalizeCompilerStructuralValueCanonical(source) ||
    emitCppStructuralRowReferenceTypeCpp(target, {
      ...context,
      anonymousStructs: new Map(),
      includes: new Set(),
    }) ===
      emitCppStructuralRowReferenceTypeCpp(source, {
        ...context,
        anonymousStructs: new Map(),
        includes: new Set(),
      })
  ) {
    return true;
  }
  return target.kind === 'merge' && target.rows.some((row) => cppStructuralRowContainsPlanCpp(row, source, context));
}

// How an assertion relates the union's one value slot to the type it names. Both sides being references
// is what makes the assertion answerable: `mesh[key] as MeshRuntime | undefined` reads a slot holding
// `Ref<EntityRuntime>` and states the concrete runtime, and `as Base | undefined` on a union already
// holding `Ref<Base>` states the same one. The first needs a cast, the second does not, and both are the
// same slot. A side that is not a reference spelling -- a type parameter, a scalar -- has no pointer
// cast and no answer here, so those still refuse rather than emitting something that cannot compile.
function getCppReferenceNarrowingCpp(fromTarget: string, toTarget: string): Readonly<{ cast?: string }> | undefined {
  const from = getCppReferenceElementTypeNameCpp(fromTarget);
  const to = getCppReferenceElementTypeNameCpp(toTarget);
  if (!from || !to) return undefined;
  return from === to ? {} : { cast: to };
}

function getCppReferenceElementTypeNameCpp(target: string): string | undefined {
  for (const prefix of ['flight::Ref<', 'std::shared_ptr<']) {
    if (target.startsWith(prefix) && target.endsWith('>')) return target.slice(prefix.length, -1);
  }
  return undefined;
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
    const alternative = alternatives[0]!;
    const binding = emitInitializedBindingValueCpp(evidence.binding, context);
    const present =
      plan.kind === 'optionalSingle'
        ? `${binding}.has_value()`
        : `(${binding}.has_value() && ${binding}.value().index() == ${String(plan.valueSlots.indexOf(alternative))})`;
    const alternativeIndex = plan.valueSlots.indexOf(alternative);
    const value =
      plan.kind === 'optionalSingle'
        ? `${binding}.value()`
        : `std::get<${String(alternativeIndex)}>(${binding}.value())`;
    const discriminant = emitCppCoalescedUnionMemberDiscriminantTestCpp(
      evidence.member,
      {
        members: alternative.sourceAlternatives,
        runtimeType: alternative.runtimeType,
        targetType: alternative.targetType,
      },
      value,
      context,
    );
    if (alternative.sourceAlternatives.length > 1 && !discriminant) {
      emissionError(
        context,
        'coalesced C++ optional union storage requires one retained literal discriminant for a member test',
      );
    }
    const test = discriminant ? `(${present} && ${discriminant})` : present;
    return evidence.whenResult ? test : `!(${test})`;
  }
  const representation = getCppVariantRepresentationForInspection(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    doesCppVariantAlternativeMatchType(alternative, evidence.member, context),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'union member test must identify exactly one C++ variant alternative');
  }
  const alternative = alternatives[0]!;
  const alternativeIndex = representation.alternatives.indexOf(alternative);
  const binding = emitInitializedBindingValueCpp(evidence.binding, context);
  const value = representation.direct ? binding : `std::get<${String(alternativeIndex)}>(${binding})`;
  const discriminant = emitCppCoalescedUnionMemberDiscriminantTestCpp(evidence.member, alternative, value, context);
  if (alternative.members.length > 1 && !discriminant) {
    emissionError(context, 'coalesced C++ union storage requires one retained literal discriminant for a member test');
  }
  const alternativeTest = representation.direct ? undefined : `${binding}.index() == ${String(alternativeIndex)}`;
  const test =
    alternativeTest && discriminant
      ? `(${alternativeTest} && ${discriminant})`
      : (alternativeTest ?? discriminant ?? 'true');
  return evidence.whenResult ? test : `!(${test})`;
}

function emitCppCoalescedUnionMemberDiscriminantTestCpp(
  member: Readonly<IrType>,
  alternative: CppVariantRepresentation['alternatives'][number],
  value: string,
  context: EmitContext,
): string | undefined {
  // Literal values are erased from C++ field types, so source alternatives with the same layout can
  // intentionally share one storage slot. The slot index then proves only the shared layout. Retain
  // the source distinction by testing a literal value that uniquely identifies the selected member.
  if (alternative.members.length < 2) return undefined;
  const exact = alternative.members.filter((candidate) => isDeepStrictEqual(candidate, member));
  const discriminantMatches = alternative.members.filter((candidate) =>
    areCppUnionMemberDiscriminantsEquivalent(candidate, member, context),
  );
  const selected =
    exact.length === 1 ? exact[0] : discriminantMatches.length === 1 ? discriminantMatches[0] : undefined;
  if (!selected) return undefined;
  if (
    selected.kind === 'literal' &&
    alternative.members.every(
      (candidate) => candidate === selected || (candidate.kind === 'literal' && candidate.value !== selected.value),
    )
  ) {
    return `${value} == ${emitLiteral(selected.value, context)}`;
  }
  const selectedProperties = context.referenceRepresentationPlanner.resolveObjectShape(selected, context.module);
  if (!selectedProperties) return undefined;
  const discriminant = selectedProperties.find((property) => {
    if (property.type.kind !== 'literal') return false;
    const value = property.type.value;
    return alternative.members.every((candidate) => {
      if (candidate === selected) return true;
      const properties = context.referenceRepresentationPlanner.resolveObjectShape(candidate, context.module);
      const candidateProperty = properties?.find((item) => item.name === property.name);
      return candidateProperty?.type.kind === 'literal' && candidateProperty.type.value !== value;
    });
  });
  if (
    !discriminant ||
    discriminant.type.kind !== 'literal' ||
    !getIrObjectPropertyTypeCpp(alternative.runtimeType, discriminant.name, context)
  ) {
    return undefined;
  }
  const operator = hasFlightReferenceRepresentationCpp(alternative.runtimeType, context) ? '->' : '.';
  return `${value}${operator}${safeCppName(discriminant.name)} == ${emitLiteral(discriminant.type.value, context)}`;
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

function getCppUnionMemberTestBranchContextCpp(
  evidence: Readonly<IrUnionMemberTestEvidence> | undefined,
  result: boolean,
  context: EmitContext,
): EmitContext {
  if (!evidence) return context;
  const narrowedType =
    evidence.whenResult === result ? evidence.member : getCppUnionMemberComplementTypeCpp(evidence, context);
  return narrowedType
    ? {
        ...context,
        narrowedBindingTypes: new Map(context.narrowedBindingTypes).set(evidence.binding.id, narrowedType),
      }
    : context;
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

// Whether an expression's emitted storage is a variant, which no member access can reach directly.
function isCppExpressionVariantUnionCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  return Boolean(type && getIrVariantUnionTypeCpp(type, context, new Set()));
}

// Whether the storage an expression is read from is a variant, which only a visit can read a member of.
//
// `isCppExpressionVariantUnionCpp` looks at the type as written, which misses the reader that reaches a
// union through a type parameter -- `value.tag` under `T extends Left | Right` is a member read on a
// variant just as `holder.value.tag` is, though the type in hand is the parameter. Resolving the domain
// first answers for both, and it answers for the value being read rather than for the declaration: a
// binding narrowed to one alternative resolves to that alternative, which is exactly when a direct
// spelling is right.
//
// The domain being a union is not the same question as the storage being a variant. Two members that share
// one C++ type (`Segment` above, two object shapes whose discriminant is a `flight::String`) are one
// reference, and reading a member of it is the direct spelling -- so the representation plan decides, and
// a plan that coalesced the members into a single value is not a variant to refuse over.
// Whether an expression's storage carries absence beside its value: a union with a null or undefined
// member, which is the storage an optional holds. Unlike `isCppExpressionVariantStorageCpp` this is the
// question the *unwrapped* read is about -- `texture.value()` answers the variant question and this one
// answers whether there is a `value()` to call.
function isCppAbsenceCarryingExpressionCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!type) return false;
  const domain = getIrTypeRuntimeDomainCpp(type, context, new Set()) ?? type;
  const union = getIrUnionTypeCpp(domain, context, new Set());
  return union !== undefined && union.types.some((member) => member.kind === 'null' || member.kind === 'undefined');
}

function isCppExpressionVariantStorageCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!type) return false;
  const domain = getIrTypeRuntimeDomainCpp(type, context, new Set()) ?? type;
  const union = getIrVariantUnionTypeCpp(domain, context, new Set());
  return union !== undefined && !getCppVariantRepresentationForInspection(union, context).direct;
}

// Whether a member read is the runtime's own string conversion of a primitive variant: `value.toString()`
// on `string | number`.
//
// This is not a member of either alternative's C++ type -- `double` has no `to_string` -- and it is not
// asked of one, so the visitor over the alternatives' own members cannot prove it. What proves it is the
// runtime defining one conversion per alternative, which makes the conversion of the variant a single
// visit over `flight::to_string`, the same body the explicit `String(value)` operation emits. Every
// alternative has to be a primitive the runtime converts; anything else keeps the refusal.
function isCppVariantPrimitiveStringConversionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): boolean {
  if (expression.name !== 'toString') return false;
  const type = getIrExpressionTypeEvidenceCpp(expression.object, context);
  if (!type) return false;
  const domain = getIrTypeRuntimeDomainCpp(type, context, new Set()) ?? type;
  const union = getIrVariantUnionTypeCpp(domain, context, new Set());
  return union !== undefined && union.types.every(isCppPrimitiveStringConversionTypeCpp);
}

// The primitive domains whose `toString` the runtime answers with its own string conversion. A union of
// them is one domain per alternative, which is what a primitive variant is.
function isCppPrimitiveStringConversionTypeCpp(type: Readonly<IrType>): boolean {
  return type.kind === 'primitive' && (type.name === 'boolean' || type.name === 'number' || type.name === 'string');
}

function isCppPrimitiveStringConversionDomainCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  const domain = getIrTypeRuntimeDomainCpp(type, context, new Set()) ?? type;
  if (isCppPrimitiveStringConversionTypeCpp(domain)) return true;
  const union = getIrVariantUnionTypeCpp(domain, context, new Set());
  return union !== undefined && union.types.every(isCppPrimitiveStringConversionTypeCpp);
}

// The result of a primitive string conversion is a string, whatever the call's own recorded result says.
//
// `value.toString()` is a member of a primitive, and the surface declaring it belongs to the runtime
// rather than to this module: the lowering records the call as erased (`any`), which is true of the
// signature and false of the value -- the emitted C++ is a `flight::String`. A member read on that result
// (`value.toString().length`) has no other way to learn that it is reading a string, so the conversion
// answers its own result type here. Only a primitive receiver is claimed: an object may declare a
// `toString` of its own.
function getCppPrimitiveStringConversionCallResultTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const callee = expression.callee;
  if (callee.kind !== 'property' || callee.name !== 'toString') return undefined;
  const receiver = getIrExpressionTypeEvidenceCpp(callee.object, context);
  return receiver && isCppPrimitiveStringConversionDomainCpp(receiver, context)
    ? { kind: 'primitive', name: 'string' }
    : undefined;
}

function emitCppVariantCommonPropertyExpression(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  // The union is asked of the runtime domain, which is the same question the refusal below asks: a union
  // reached through an intersection distribution (`BuiltIn & Entity` merges Entity into each alternative)
  // or through a type parameter's constraint is a union the alternatives answer for, and looking only at
  // the type as written would leave those to the direct spelling.
  const domainType = objectType ? (getIrTypeRuntimeDomainCpp(objectType, context, new Set()) ?? objectType) : undefined;
  const union = domainType ? getIrVariantUnionTypeCpp(domainType, context, new Set()) : undefined;
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
  // The member's own C++ binding, which is the second half of the proof and is not the same question as
  // the member's name. One visitor body stands for every alternative, so a spelling is only provable
  // when the alternatives agree on it: `length` over `number[] | Float32Array` is spelled `size()` on
  // BOTH, because both answer a size method, while the source name is `length`. Asking only for the type
  // would emit `value.length` -- a member neither alternative has.
  //
  // All or nothing, and agreed: some alternatives naming a binding while others do not would put one
  // spelling in a body that reaches both, and two contrasting bindings would put one alternative's
  // spelling on the other. A shape where no alternative names one keeps the source spelling, which is
  // what a record-like member already relies on.
  const memberBindings = representation.alternatives.map((alternative) =>
    getCppVariantAmbientMemberBindingCpp(alternative.runtimeType, expression.name, context),
  );
  const namedBindings = memberBindings.filter((binding) => binding !== undefined);
  if (namedBindings.length > 0 && namedBindings.length !== memberBindings.length) return undefined;
  if (new Set(namedBindings.map((binding) => `${binding!.kind}\u0000${binding!.targetName}`)).size > 1) {
    return undefined;
  }
  const memberName = namedBindings[0]?.targetName ?? safeCppName(expression.name);
  // The binding's KIND decides the shape of the access, not only its name: a size method is called,
  // while a property is read. Both alternatives answer `length` as a size method here, so the body is a
  // call -- reading `value.size` would name a member function and hand back a pointer to it.
  const memberAccess =
    namedBindings[0]?.kind === 'sizeMethod'
      ? `${memberName}()`
      : namedBindings[0]?.kind === 'method'
        ? `${memberName}()`
        : memberName;
  context.includes.add('variant');
  const operator = referenceModes.has('reference') ? '->' : '.';
  const projected = `value${operator}${memberAccess}`;
  return `std::visit([](const auto& value) { return ${namedBindings[0]?.kind === 'sizeProperty' ? `static_cast<double>(${projected})` : projected}; }, ${emitExpression(expression.object, context)})`;
}

// The ambient member binding the emitter would use for a LONE access on one alternative, or undefined
// when the alternative names none. The receiver kind comes from the representation planner rather than
// from the member expression: a union has no resolved member of its own -- the analysis declines to
// resolve one across alternatives -- so the per-alternative kind is the only evidence available, and the
// planner is what decides it.
function getCppVariantAmbientMemberBindingCpp(
  type: Readonly<IrType>,
  memberName: string,
  context: EmitContext,
): CompilerCppAmbientMemberBinding | undefined {
  const receiver = getCppVariantMemberReceiverCpp(type);
  if (!receiver) return undefined;
  return getCompilerCppAmbientMemberBinding({ name: memberName, receiver }, getCppRuntimeProfile(context.options));
}

// The runtime receiver a lone member access on this type would be resolved against. An array is a kind
// of the type itself; the rest are named runtime domains, and the name-to-category mapping is asked of
// the planner rather than repeated here, so the two cannot drift.
function getCppVariantMemberReceiverCpp(type: Readonly<IrType>): IrResolvedMemberReceiver | undefined {
  if (type.kind === 'array') return 'array';
  if (type.kind !== 'named' || type.reference.kind !== 'ambient') return undefined;
  const category = getCppRuntimeReferenceCategory(type.reference.name);
  if (
    category === 'map' ||
    category === 'set' ||
    category === 'task' ||
    category === 'typedArray' ||
    category === 'date'
  ) {
    return category;
  }
  return undefined;
}

// The surface a member read resolves against when the analysis attached no member of its own.
//
// The analysis resolves a receiver from the type it can name and deliberately declines a union it cannot
// name one receiver for. A string that arrives from a conversion is the shape that leaves a read with
// nothing: `value.toString().length` reaches the string surface through a call whose IR result is erased,
// so the read has no member evidence and no source field to fall back on -- and the direct spelling is
// `length`, a property `flight::String` does not have, where the runtime exposes `length()`. What the
// emitter does know is what it emitted, so the object's own type names the surface here, under the same
// agreement rule the analysis applies: every inhabited member of a union has to answer the same receiver.
//
// Only a read the analysis left unresolved is answered this way. A resolved member is that analysis's
// answer, including when it names a source field the runtime categories know nothing about.
function getCppExpressionMemberReceiverCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): IrResolvedMemberReceiver | undefined {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  return type ? getCppTypeMemberReceiverCpp(type) : undefined;
}

function getCppTypeMemberReceiverCpp(type: Readonly<IrType>): IrResolvedMemberReceiver | undefined {
  if (type.kind === 'union') {
    const inhabited = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    const resolved = inhabited.map((member) => getCppTypeMemberReceiverCpp(member));
    if (resolved.length === 0 || resolved.some((receiver) => receiver === undefined)) return undefined;
    const receivers = new Set(resolved);
    return receivers.size === 1 ? [...receivers][0] : undefined;
  }
  if (type.kind === 'literal') {
    return typeof type.value === 'string' ? 'string' : typeof type.value === 'number' ? 'number' : undefined;
  }
  if (type.kind === 'primitive' && (type.name === 'number' || type.name === 'string')) return type.name;
  return getCppVariantMemberReceiverCpp(type);
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
  const binding = emitInitializedBindingValueCpp(expression.reference.binding, context);
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
  if (representation.direct) return binding;
  return `std::get<${String(representation.alternatives.indexOf(matches[0]!.alternative))}>(${binding})`;
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
    emissionError(
      context,
      `union has distinct runtime domains erased by C++ target type ${targetTypes}`,
      'cpp-union-runtime-domains-erased',
    );
  }
  return plan;
}

// The module that declares the alias an expected union is reached through, when that module is not
// this one.
//
// A union's alternatives are anonymous records, and an anonymous record is minted where it is
// emitted. The declaring module mints its own in its own namespace, so a consumer that mints an
// equivalent struct here produces a structurally identical but nominally different type -- and the
// declared result, which names the declaring module's, will not accept it. The alternatives have to be
// built in the declaring module's context and named there.
//
// `'ambiguous'` is a real answer rather than a fallback: an import that resolves to no single module
// cannot say whose records these are, and guessing would pick one of several equally wrong answers.
function getCppUnionAliasDeclarationOwnerCpp(
  expectedType: Readonly<IrType>,
  context: EmitContext,
): Readonly<IrModule> | 'ambiguous' | undefined {
  const alias =
    expectedType.kind === 'union' ? getCppOptionalImportedUnionValueAliasCpp(expectedType, context) : expectedType;
  if (!alias || alias.kind !== 'named' || alias.reference.kind !== 'binding') return undefined;
  const reference = alias.reference;
  // Only an import crosses a module boundary. A local alias and an inline union keep their own
  // ownership, which is what they already had.
  if (reference.binding.kind !== 'import') return undefined;
  const owner = context.importBindingOwners.get(reference.binding.id);
  // No import owner means the binding is not one this emission can follow, and the local path already
  // answers for it. Ambiguity is a different case: the alias IS imported and its declaring module does
  // not resolve to exactly one, so every answer would be a guess at which module's records these are.
  if (!owner) return undefined;
  const ownerContext: EmitContext = owner.module === context.module ? context : { ...context, module: owner.module };
  const resolved = getCppResolvedImportModules(owner.specifier, ownerContext);
  const candidates = resolved.flatMap((candidate) =>
    getCppExportedTypeDeclarationOwnersCpp(candidate, owner.imported, context, new Set()),
  );
  const unique = new Map(
    candidates.map((candidate) => [
      `${getCppModuleIdentityKey(candidate.module)}\0${candidate.declaration.binding.id}`,
      candidate,
    ]),
  );
  if (unique.size > 1) return 'ambiguous';
  const target = [...unique.values()][0];
  if (target) return target.module === context.module ? undefined : target.module;
  // Only a UNIQUE other module can say whose records these are. Anything else keeps the local
  // behaviour it already had: an import that resolves to several modules is a shape the emitter
  // handles today by minting here, and refusing it would turn a working emission into a refusal --
  // a behaviour change this round did not ask for.
  const directTargets = resolved.filter((candidate) => hasCppDirectExportName(candidate, owner.imported));
  if (directTargets.length !== 1) return undefined;
  return directTargets[0] === context.module ? undefined : directTargets[0];
}

function getCppExportedTypeDeclarationOwnersCpp(
  module: Readonly<IrModule>,
  exportedName: string,
  context: EmitContext,
  visited: ReadonlySet<string>,
): readonly CppTypeDeclarationOwner[] {
  const key = `${getCppModuleIdentityKey(module)}\0${exportedName}`;
  if (visited.has(key)) return [];
  const nextVisited = new Set(visited).add(key);
  const bindingIds = new Set([
    ...module.declarations.flatMap((declaration) =>
      'binding' in declaration && declaration.exported && declaration.binding.name === exportedName
        ? [declaration.binding.id]
        : [],
    ),
    ...module.exports.flatMap((exported) =>
      exported.kind === 'local' && exported.exported === exportedName ? [exported.binding.id] : [],
    ),
  ]);
  const direct = module.declarations.flatMap((declaration): readonly CppTypeDeclarationOwner[] => {
    if (
      (declaration.kind !== 'class' &&
        declaration.kind !== 'enum' &&
        declaration.kind !== 'interface' &&
        declaration.kind !== 'typeAlias') ||
      !bindingIds.has(declaration.binding.id)
    ) {
      return [];
    }
    return [{ declaration, module }];
  });
  const forwarded = module.exports.flatMap((exported): readonly CppTypeDeclarationOwner[] => {
    const importedName =
      exported.kind === 'all'
        ? exportedName
        : exported.kind === 'reexport' && exported.exported === exportedName
          ? exported.imported
          : undefined;
    if (!importedName || (exported.kind !== 'all' && exported.kind !== 'reexport')) return [];
    const moduleContext = module === context.module ? context : { ...context, module };
    return getCppResolvedImportModules(exported.specifier, moduleContext).flatMap((targetModule) =>
      getCppExportedTypeDeclarationOwnersCpp(targetModule, importedName, context, nextVisited),
    );
  });
  return [...direct, ...forwarded];
}

// Names the alternatives the declaring module minted, qualified by that module's namespace, so a
// construction here names the declared type rather than a local twin. Only the names this emission
// minted are rewritten, so a runtime type that happens to sit beside them is untouched.
function qualifyCppDeclaringModuleAlternativesCpp(
  emitted: string,
  ownerContext: EmitContext,
  owner: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions>,
): string {
  let result = emitted;
  const namespace = getCppCompilerPackageNamespace(owner.packageName, options.packageTargets);
  for (const structure of ownerContext.anonymousStructs.values()) {
    const name = structure.name;
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_:])${name}(?![A-Za-z0-9_])`, 'gu'), `${namespace}::${name}`);
  }
  return result;
}

function qualifyCppDeclaringModuleTypeCpp(emitted: string, context: EmitContext): string {
  let result = qualifyCppDeclaringModuleAlternativesCpp(emitted, context, context.module, context.options);
  const namespace = getCppCompilerPackageNamespace(context.module.packageName, context.options.packageTargets);
  for (const module of context.sourceModules) {
    if (getCppCompilerPackageNamespace(module.packageName, context.options.packageTargets) !== namespace) continue;
    for (const declaration of module.declarations) {
      if (
        declaration.kind !== 'class' &&
        declaration.kind !== 'enum' &&
        declaration.kind !== 'interface' &&
        declaration.kind !== 'typeAlias'
      ) {
        continue;
      }
      const name = context.targetNames.get(declaration.binding.id) ?? pascalCase(declaration.binding.name);
      result = result.replace(new RegExp(`(?<![A-Za-z0-9_:])${name}(?![A-Za-z0-9_])`, 'gu'), `${namespace}::${name}`);
    }
  }
  return result;
}

function emitContextualUnionExpressionCpp(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  const owner = getCppUnionAliasDeclarationOwnerCpp(expectedType, context);
  if (owner === 'ambiguous') {
    emissionError(
      context,
      'a contextual union value reached through an alias whose declaring module is unresolved cannot choose canonical alternatives',
      'cpp-contextual-union-alias-owner-unresolved',
    );
  }
  if (owner) {
    // The alternatives are built in the declaring module's context, with a scratch struct map so its
    // definitions are NOT emitted here -- the declaring module's own header defines them, and this
    // module already includes it through the ordinary import path. The two halves are one change: a
    // qualified name without the suppression would leave a duplicate, and the suppression without the
    // qualification would name a type this module does not have.
    const ownerContext: EmitContext = { ...context, anonymousStructs: new Map(), module: owner };
    const emitted = emitContextualUnionExpressionInContextCpp(expression, expectedType, ownerContext);
    return emitted === undefined
      ? undefined
      : qualifyCppDeclaringModuleAlternativesCpp(emitted, ownerContext, owner, context.options);
  }
  return emitContextualUnionExpressionInContextCpp(expression, expectedType, context);
}

function emitContextualUnionExpressionInContextCpp(
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
    const mergeEvidence = getCppNullishMergeEvidenceCpp(expression, context);
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
      mergeEvidence?.leftType ??
      getIrExpressionTypeEvidenceCpp(expression.left, context);
    const leftUnion = leftType ? getIrUnionTypeCpp(leftType, context, new Set()) : undefined;
    const leftStorageType = getIrExpressionTypeEvidenceCpp(expression.left, context);
    const leftStorageUnion = leftStorageType ? getIrUnionTypeCpp(leftStorageType, context, new Set()) : undefined;
    const declaredLeftStoragePlan = leftStorageUnion
      ? getCppUnionRepresentationPlan(leftStorageUnion, context)
      : undefined;
    const implicitLeftStoragePlan =
      leftStorageType && hasCppAbsenceStorageCpp(expression.left, context)
        ? getCppImplicitAbsenceStoragePlanCpp(leftStorageType, context)
        : undefined;
    const leftStoragePlan = implicitLeftStoragePlan ?? declaredLeftStoragePlan;
    const leftPlan = leftUnion ? getCppUnionRepresentationPlan(leftUnion, context) : undefined;
    const representedLeftPlan = implicitLeftStoragePlan ?? leftPlan;
    if (representedLeftPlan) {
      const targetSlot = plan.valueSlots[0];
      const sourceSlot = leftStoragePlan?.valueSlots[0];
      const expectedSentinels = union.types.filter(
        (member): member is Extract<IrType, { kind: 'null' | 'undefined' }> =>
          member.kind === 'null' || member.kind === 'undefined',
      );
      const variantMerge =
        leftStorageType && leftStoragePlan
          ? emitCppNullishCoalesceMultiVariantConstructionCpp(
              expression,
              leftStorageType,
              leftStoragePlan,
              union,
              plan,
              context,
            )
          : undefined;
      if (variantMerge) return variantMerge;
      // A literal-sentinel fallback deliberately merges both absent states from the left. Project
      // the dual-sentinel carrier into the contextual optional only when its sole value slot is the
      // destination's exact C++ representation; a heterogeneous destination or erased Any keeps the
      // existing fail-closed conversion path.
      if (
        fallback &&
        plan.kind === 'optionalSingle' &&
        targetSlot &&
        targetSlot.targetType !== 'flight::Any' &&
        expectedSentinels.length === 1 &&
        expectedSentinels[0]!.kind === fallback &&
        leftStorageType &&
        leftStoragePlan?.kind === 'dualSentinelVariant' &&
        leftStoragePlan.valueSlots.length === 1 &&
        sourceSlot?.targetType === targetSlot.targetType
      ) {
        const source = getGeneratedTargetName('nullishCoalesceLeft', context);
        const left = emitExpression(expression.left, context, leftStorageType);
        const present = emitCppUnionValueConstruction(
          `std::get<${sourceSlot.targetType}>(${source})`,
          targetSlot.targetType,
          union,
          plan.kind,
          context,
        );
        const absent = emitCppUnionSentinelConstruction(fallback, union, plan.kind, context);
        context.includes.add('variant');
        return `([&]() -> ${emitUnionTypeCpp(union, context)} { auto ${source} = ${left}; if (std::holds_alternative<${sourceSlot.targetType}>(${source})) return ${present}; return ${absent}; }())`;
      }
      if (
        hasEquivalentCppOptionalUnionRepresentation(plan, representedLeftPlan) &&
        ((expression.right.kind === 'literal' && expression.right.value === null) ||
          expression.right.kind === 'undefinedValue')
      ) {
        return implicitLeftStoragePlan
          ? emitOptionalExpressionCpp(expression.left, context, leftStorageType)
          : emitExpression(expression.left, context, leftType);
      }
      if (hasEquivalentCppOptionalUnionRepresentation(plan, representedLeftPlan)) {
        const unionType = emitUnionTypeCpp(union, context);
        const left = implicitLeftStoragePlan
          ? emitOptionalExpressionCpp(expression.left, context, leftStorageType)
          : emitExpression(expression.left, context, leftType);
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
  // An unresolved local initialized and assigned only from one manifest-stated result has the same
  // target domain as the call itself. Reading the local must not discard that storage decision and
  // fall back to the checker's `any`, but no destination type participates in making the decision.
  const externalValueTarget =
    getCppExternalCallResultTargetCpp(expression, context) ??
    (expression.kind === 'identifier' && expression.reference.kind === 'binding'
      ? context.externalBindingStorageTargetTypes.get(expression.reference.binding.id)
      : undefined);
  if (externalValueTarget) {
    const targetSlots = plan.valueSlots.filter((slot) => slot.targetType === externalValueTarget);
    const unresolvedTargetSlot =
      targetSlots.length === 0 &&
      plan.valueSlots.length === 1 &&
      plan.valueSlots[0]!.sourceAlternatives.every((alternative) => alternative.kind === 'unknown');
    if (targetSlots.length !== 1 && !unresolvedTargetSlot) {
      emissionError(
        context,
        `external call result type ${externalValueTarget} is not one represented contextual runtime domain`,
      );
    }
    return emitCppUnionValueConstruction(
      emitExpression(expression, context, undefined, false),
      externalValueTarget,
      union,
      plan.kind,
      context,
    );
  }
  const expressionType = getIrExpressionTypeForUnionConstructionCpp(expression, plan.valueSlots, context);
  if (!expressionType) {
    if (plan.kind === 'singleValue') return undefined;
    emissionError(
      context,
      `contextual ${plan.kind} construction requires expression type evidence`,
      `cpp-contextual-union-missing-expression-type:${plan.kind}`,
    );
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
    const widenedOptional = emitCppOptionalUnionWideningCpp(
      expression,
      expressionType,
      expressionPlan,
      union,
      plan,
      context,
    );
    if (widenedOptional) return widenedOptional;
    // `std::optional` erases which single sentinel caused absence, while the source plan retains it.
    // When widening into a dual-sentinel variant, branch before extracting the value and reconstruct
    // that exact sentinel. An explicit assertion may change the present structural view, but its
    // underlying optional remains the expression whose presence must be tested.
    if (
      expressionPlan.kind === 'optionalSingle' &&
      plan.kind === 'dualSentinelVariant' &&
      expressionPlan.valueSlots.length === 1 &&
      plan.valueSlots.length === 1
    ) {
      let sourceExpression: Readonly<IrExpression> = expression;
      let sourceType = expressionType;
      let sourcePlan = expressionPlan;
      let conversionTargetSlot = plan.valueSlots[0]!;
      if (expression.kind === 'cast') {
        const assertedSource =
          expression.expression.kind === 'cast' && expression.expression.type.kind === 'unknown'
            ? expression.expression.expression
            : expression.expression;
        const assertedSourceType = getIrExpressionTypeEvidenceCpp(assertedSource, context);
        const assertedSourceUnion = assertedSourceType
          ? getIrUnionTypeCpp(assertedSourceType, context, new Set())
          : undefined;
        const assertedSourcePlan = assertedSourceUnion
          ? getCppUnionRepresentationPlan(assertedSourceUnion, context)
          : undefined;
        if (assertedSourceType && assertedSourcePlan?.kind === 'optionalSingle') {
          sourceExpression = assertedSource;
          sourceType = assertedSourceType;
          sourcePlan = assertedSourcePlan;
          conversionTargetSlot = expressionPlan.valueSlots[0]!;
        }
      }
      const sourceSlot = sourcePlan.valueSlots[0]!;
      const targetSlot = plan.valueSlots[0]!;
      const sourceSentinel =
        sourcePlan.sentinels.null === 'optionalAbsence'
          ? 'null'
          : sourcePlan.sentinels.undefined === 'optionalAbsence'
            ? 'undefined'
            : undefined;
      const source = getGeneratedTargetName('contextualUnionSource', context);
      let converted =
        conversionTargetSlot.targetType === targetSlot.targetType &&
        sourceSlot.targetType === conversionTargetSlot.targetType
          ? `${source}.value()`
          : undefined;
      if (
        !converted &&
        conversionTargetSlot.targetType === targetSlot.targetType &&
        isCppExplicitStructuralRowExtensionCpp(sourceSlot.runtimeType, conversionTargetSlot.runtimeType, context)
      ) {
        context.includes.add('flight/structural_ref.hpp');
        converted = `flight::structural_ref_cast<${conversionTargetSlot.targetType}>(${source}.value())`;
      }
      if (!converted && conversionTargetSlot.targetType === targetSlot.targetType) {
        const conversions = (
          sourceSlot.sourceAlternatives.length > 0 ? sourceSlot.sourceAlternatives : [sourceSlot.runtimeType]
        ).flatMap((sourceType) =>
          (conversionTargetSlot.sourceAlternatives.length > 0
            ? conversionTargetSlot.sourceAlternatives
            : [conversionTargetSlot.runtimeType]
          ).flatMap((targetType) => {
            const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
            return emitCppStructuralReferenceValueConversionCpp('source', sourceType, targetType, isolatedContext)
              ? [{ sourceType, targetType }]
              : [];
          }),
        );
        if (conversions.length === 1) {
          const conversion = conversions[0]!;
          converted = emitCppStructuralReferenceValueConversionCpp(
            `${source}.value()`,
            conversion.sourceType,
            conversion.targetType,
            context,
          );
        }
      }
      if (sourceSentinel && converted && sourceSlot.targetType !== 'flight::Any') {
        context.includes.add('optional');
        const resultType = emitUnionTypeCpp(union, context);
        const absent = emitCppUnionSentinelConstruction(sourceSentinel, union, plan.kind, context);
        const present = emitCppUnionValueConstruction(converted, targetSlot.targetType, union, plan.kind, context);
        const value = emitExpression(sourceExpression, context, sourceType, false);
        return `([&]() -> ${resultType} { auto ${source} = ${value}; if (!${source}.has_value()) return ${absent}; return ${present}; }())`;
      }
    }
    if (
      expressionPlan.kind === 'optionalSingle' &&
      plan.kind === 'optionalSingle' &&
      expressionPlan.valueSlots.length === 1 &&
      plan.valueSlots.length === 1
    ) {
      const sourceSlot = expressionPlan.valueSlots[0]!;
      const targetSlot = plan.valueSlots[0]!;
      const source = getGeneratedTargetName('contextualUnionSource', context);
      const conversions = (
        sourceSlot.sourceAlternatives.length > 0 ? sourceSlot.sourceAlternatives : [sourceSlot.runtimeType]
      ).flatMap((sourceType) =>
        (targetSlot.sourceAlternatives.length > 0 ? targetSlot.sourceAlternatives : [targetSlot.runtimeType]).flatMap(
          (targetType) => {
            const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
            return emitCppStructuralReferenceValueConversionCpp('source', sourceType, targetType, isolatedContext)
              ? [{ sourceType, targetType }]
              : [];
          },
        ),
      );
      if (conversions.length === 1) {
        const conversion = conversions[0]!;
        const converted = emitCppStructuralReferenceValueConversionCpp(
          `${source}.value()`,
          conversion.sourceType,
          conversion.targetType,
          context,
        )!;
        context.includes.add('optional');
        const resultType = emitUnionTypeCpp(union, context);
        const present = emitCppUnionValueConstruction(converted, targetSlot.targetType, union, plan.kind, context);
        const value = emitExpression(expression, context, expressionType, false);
        return `([&]() -> ${resultType} { auto ${source} = ${value}; if (!${source}.has_value()) return std::nullopt; return ${present}; }())`;
      }
    }
    // The two plans are compared slot by slot, so naming the slots is what makes a refusal
    // reproducible from the message alone: the reader sees which alternative the source union
    // represents and which slot it has no counterpart for.
    emissionError(
      context,
      `contextual C++ union conversion requires equivalent source union evidence: target ${plan.kind} [${plan.valueSlots
        .map((slot) => slot.representationKey)
        .join(', ')}] from source ${expressionPlan.kind} [${expressionPlan.valueSlots
        .map((slot) => slot.representationKey)
        .join(', ')}]`,
      'cpp-contextual-union-inequivalent',
    );
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
    emissionError(
      context,
      `contextual ${plan.kind} construction requires one runtime value domain`,
      `cpp-contextual-union-missing-value-domain:${plan.kind}`,
    );
  }
  const targetType = emitType(runtimeType, context);
  const valueSlot = plan.valueSlots.findIndex((slot) => slot.targetType === targetType);
  const constrainedValueSlot =
    valueSlot < 0 ? getCppConstrainedTypeParameterUnionValueSlotCpp(runtimeType, plan.valueSlots, context) : undefined;
  const callableValueSlot =
    valueSlot < 0 && constrainedValueSlot === undefined
      ? getCppCallableUnionValueSlotCpp(runtimeType, plan.valueSlots, context)
      : undefined;
  const representedValueSlot = constrainedValueSlot ?? callableValueSlot ?? valueSlot;
  if (representedValueSlot < 0) {
    const declaredValueSlot = getCppConcreteNamedUnionValueSlotCpp(runtimeType, plan.valueSlots, context);
    if (declaredValueSlot !== undefined) {
      return emitCppUnionValueConstruction(
        emitExpression(expression, context, runtimeType, false),
        plan.valueSlots[declaredValueSlot]!.targetType,
        union,
        plan.kind,
        context,
      );
    }
    const structuralSlots = plan.valueSlots.flatMap((slot) => {
      const alternatives = slot.sourceAlternatives.filter((alternative) => {
        const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
        return (
          emitCppStructuralReferenceValueConversionCpp('source', runtimeType, alternative, isolatedContext) !==
          undefined
        );
      });
      return alternatives.length === 1 ? [{ alternative: alternatives[0]!, slot }] : [];
    });
    if (structuralSlots.length === 1) {
      const structural = structuralSlots[0]!;
      const converted = emitCppContextualStructuralReferenceCpp(expression, structural.alternative, context);
      if (converted) {
        return emitCppUnionValueConstruction(converted, structural.slot.targetType, union, plan.kind, context);
      }
    }
    emissionError(
      context,
      `contextual union value type ${targetType} is not a represented runtime domain`,
      'cpp-contextual-union-value-type-unrepresented',
    );
  }
  const emitted =
    callableValueSlot === undefined
      ? emitExpression(expression, context, runtimeType, false)
      : emitCppContextualCallableUnionValueCpp(
          expression,
          runtimeType,
          plan.valueSlots[callableValueSlot]!.runtimeType,
          context,
        );
  return emitCppUnionValueConstruction(
    emitted,
    plan.valueSlots[representedValueSlot]!.targetType,
    union,
    plan.kind,
    context,
  );
}

// Widen a represented source union into a nullable destination only when every present source slot
// selects exactly one destination slot. An optional source must also encode the same sentinel: passing
// optional<T> directly to optional<variant<T, U>> has no converting constructor, while extracting
// without the check would turn source absence into a throw.
function emitCppOptionalUnionWideningCpp(
  expression: Readonly<IrExpression>,
  expressionType: Readonly<IrType>,
  sourcePlan: ReturnType<typeof getCppUnionRepresentationPlan>,
  targetUnion: Readonly<Extract<IrType, { kind: 'union' }>>,
  targetPlan: ReturnType<typeof getCppUnionRepresentationPlan>,
  context: EmitContext,
): string | undefined {
  if (targetPlan.kind !== 'optionalVariant') {
    return undefined;
  }
  const slotMappings = sourcePlan.valueSlots.map((sourceSlot) => {
    if (sourceSlot.targetType === 'flight::Any') return undefined;
    const targets = targetPlan.valueSlots.filter(
      (slot) =>
        slot.targetType === sourceSlot.targetType ||
        hasCppSameDeclaredUnionRuntimeTypeCpp(sourceSlot.runtimeType, slot.runtimeType, context),
    );
    return targets.length === 1 ? { source: sourceSlot, target: targets[0]! } : undefined;
  });
  if (slotMappings.some((mapping) => mapping === undefined)) return undefined;
  const mappings = slotMappings.filter((mapping) => mapping !== undefined);
  const resultType = qualifyCppDeclaringModuleTypeCpp(emitUnionTypeCpp(targetUnion, context), context);
  if (sourcePlan.kind === 'multiVariant' && mappings.length > 1) {
    const value = getGeneratedTargetName('contextualUnionValue', context);
    const valueType = getGeneratedTargetName('contextualUnionValueType', context);
    const branches = mappings.map((mapping, index) => {
      const sourceType = mapping.source.targetType;
      const targetType = qualifyCppDeclaringModuleTypeCpp(mapping.target.targetType, context);
      const result = `${resultType}{std::in_place, std::in_place_type<${targetType}>, ${value}}`;
      if (index === mappings.length - 1) return `else return ${result};`;
      return `${index === 0 ? 'if' : 'else if'} constexpr (std::is_same_v<${valueType}, ${sourceType}>) return ${result};`;
    });
    context.includes.add('type_traits');
    context.includes.add('variant');
    return `std::visit([&](const auto& ${value}) -> ${resultType} { using ${valueType} = std::decay_t<decltype(${value})>; ${branches.join(' ')} }, ${emitExpression(expression, context, expressionType, false)})`;
  }
  if (sourcePlan.kind !== 'optionalSingle' || mappings.length !== 1) return undefined;
  const sourceSentinel =
    sourcePlan.sentinels.null === 'optionalAbsence'
      ? 'null'
      : sourcePlan.sentinels.undefined === 'optionalAbsence'
        ? 'undefined'
        : undefined;
  if (!sourceSentinel || targetPlan.sentinels[sourceSentinel] !== 'optionalAbsence') return undefined;
  const source = getGeneratedTargetName('contextualUnionSource', context);
  const absent = emitCppUnionSentinelConstruction(sourceSentinel, targetUnion, targetPlan.kind, context);
  const targetType = qualifyCppDeclaringModuleTypeCpp(mappings[0]!.target.targetType, context);
  const present = `${resultType}{std::in_place, std::in_place_type<${targetType}>, ${source}.value()}`;
  const value = emitExpression(expression, context, expressionType, false);
  context.includes.add('optional');
  return `([&]() -> ${resultType} { auto ${source} = ${value}; if (!${source}.has_value()) return ${absent}; return ${present}; }())`;
}

function hasCppSameDeclaredUnionRuntimeTypeCpp(
  left: Readonly<IrType>,
  right: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (
    left.kind !== 'named' ||
    right.kind !== 'named' ||
    left.reference.kind !== 'binding' ||
    right.reference.kind !== 'binding' ||
    !isDeepStrictEqual(left.typeArguments, right.typeArguments)
  ) {
    return false;
  }
  const getOwner = (type: Readonly<Extract<IrType, { kind: 'named' }>>) => {
    const direct = getCppDirectBindingOwner(type, context);
    if (direct) return direct;
    if (type.reference.kind !== 'binding') return undefined;
    const importOwner = context.importBindingOwners.get(type.reference.binding.id);
    const resolutionContext = importOwner ? { ...context, module: importOwner.module } : context;
    return getCppImportedBindingDeclarationCpp(type, resolutionContext);
  };
  const leftOwner = getOwner(left);
  const rightOwner = getOwner(right);
  return Boolean(
    leftOwner &&
    rightOwner &&
    'binding' in leftOwner.declaration &&
    'binding' in rightOwner.declaration &&
    leftOwner.declaration.binding.id === rightOwner.declaration.binding.id &&
    getCppModuleIdentityKey(leftOwner.module) === getCppModuleIdentityKey(rightOwner.module),
  );
}

function emitCppNullishCoalesceMultiVariantConstructionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  sourceType: Readonly<IrType>,
  sourcePlan: ReturnType<typeof getCppUnionRepresentationPlan>,
  targetUnion: Readonly<Extract<IrType, { kind: 'union' }>>,
  targetPlan: ReturnType<typeof getCppUnionRepresentationPlan>,
  context: EmitContext,
): string | undefined {
  if (
    expression.operator !== '??' ||
    sourcePlan.kind !== 'optionalSingle' ||
    sourcePlan.valueSlots.length !== 1 ||
    targetPlan.kind !== 'multiVariant'
  ) {
    return undefined;
  }
  const sourceSlot = sourcePlan.valueSlots[0]!;
  const targetSlotIndex = getCppConcreteNamedUnionValueSlotCpp(sourceSlot.runtimeType, targetPlan.valueSlots, context);
  if (targetSlotIndex === undefined) return undefined;
  const targetSlot = targetPlan.valueSlots[targetSlotIndex]!;
  // Identity and storage are separate evidence. Resolving the declaration proves which arm this is;
  // identical emitted storage proves that extracting the optional does not require a target cast.
  // A derived reference, erased Any, or otherwise different carrier stays on the refusal path until
  // its conversion has an explicit checked lowering of its own.
  if (sourceSlot.targetType === 'flight::Any' || sourceSlot.targetType !== targetSlot.targetType) return undefined;

  const fallbackSlots = targetPlan.valueSlots.filter((_, index) => index !== targetSlotIndex);
  const fallbackType = getIrExpressionTypeForUnionConstructionCpp(expression.right, fallbackSlots, context);
  if (!fallbackType || getIrUnionTypeCpp(fallbackType, context, new Set())) return undefined;
  const fallbackRuntimeType = getIrTypeRuntimeDomainCpp(fallbackType, context, new Set());
  if (!fallbackRuntimeType) return undefined;
  const fallbackPlan = getCppUnionRepresentationPlan(
    { kind: 'union', types: [fallbackRuntimeType, { kind: 'null' }] },
    { ...context, anonymousStructs: new Map(), includes: new Set<string>() },
  );
  const fallbackSourceSlot = fallbackPlan.valueSlots.length === 1 ? fallbackPlan.valueSlots[0] : undefined;
  if (!fallbackSourceSlot) return undefined;
  const matchingFallbackSlots = fallbackSlots.filter(
    (slot) =>
      slot.representationKey === fallbackSourceSlot.representationKey &&
      slot.targetType === fallbackSourceSlot.targetType,
  );
  if (matchingFallbackSlots.length !== 1) return undefined;
  const fallbackSlot = matchingFallbackSlots[0]!;

  const source = getGeneratedTargetName('contextualUnionSource', context);
  const sourceValue = emitOptionalExpressionCpp(expression.left, context, sourceType);
  const present = emitCppUnionValueConstruction(
    `${source}.value()`,
    targetSlot.targetType,
    targetUnion,
    targetPlan.kind,
    context,
  );
  const fallback = emitCppUnionValueConstruction(
    emitExpression(expression.right, context, fallbackSlot.runtimeType, false),
    fallbackSlot.targetType,
    targetUnion,
    targetPlan.kind,
    context,
  );
  const resultType = emitUnionTypeCpp(targetUnion, context);
  return `([&]() -> ${resultType} { auto ${source} = ${sourceValue}; if (${source}.has_value()) return ${present}; return ${fallback}; }())`;
}

function getCppCallableUnionValueSlotCpp(
  source: Readonly<IrType>,
  valueSlots: readonly Readonly<{ runtimeType: IrType }>[],
  context: EmitContext,
): number | undefined {
  if (source.kind !== 'function' || source.typeParameters.length > 0) return undefined;
  const matches = valueSlots.flatMap((slot, index) => {
    const target = getCppClosedCallableType(slot.runtimeType, context, new Set());
    if (!target || target.typeParameters.length > 0 || source.parameters.length > target.parameters.length) {
      return [];
    }
    const parametersAgree = source.parameters.every((parameter, parameterIndex) => {
      const targetParameter = target.parameters[parameterIndex]!;
      return (
        parameter.optional === targetParameter.optional &&
        parameter.rest === targetParameter.rest &&
        emitCppParameterTypeCpp(parameter.type, parameter.rest, context) ===
          emitCppParameterTypeCpp(targetParameter.type, targetParameter.rest, context)
      );
    });
    if (!parametersAgree) return [];
    if (emitType(source.returns, context) === emitType(target.returns, context)) return [index];
    // A nominal reference returned through its own structural row is the same object with a
    // read-only call surface. Keep the slot's one declared std::function type and prove the
    // callable against it from the same emitType spellings used to write both signatures.
    const targetRow = context.referenceRepresentationPlanner.resolveStructuralRow(target.returns, context.module);
    const targetObject = targetRow ? getCppStructuralRowObjectTypeCpp(targetRow) : undefined;
    return targetObject && emitType(source.returns, context) === emitType(targetObject, context) ? [index] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

// TypeScript callables may ignore trailing arguments: a `() => Value` is valid wherever a
// `(options?: Options) => Value` is expected, and the caller still invokes the contextual signature.
// `std::function` does not perform that adaptation -- a zero-argument target is not invocable with one
// argument -- so retain the contextual signature in a small wrapper and call the source with only the
// prefix it declares. The matcher above has already proved that every retained prefix parameter has the
// same optional/rest mode and C++ representation and that the return representation agrees. Binding the
// source in the lambda capture also preserves one evaluation for a call or property that produces it.
function emitCppContextualCallableUnionValueCpp(
  expression: Readonly<IrExpression>,
  sourceType: Readonly<IrType>,
  targetType: Readonly<IrType>,
  context: EmitContext,
): string {
  if (sourceType.kind !== 'function') return emitExpression(expression, context, sourceType, false);
  const target = getCppClosedCallableType(targetType, context, new Set());
  if (!target || sourceType.parameters.length === target.parameters.length) {
    return emitExpression(expression, context, sourceType, false);
  }
  const sourceName = getGeneratedTargetName('contextualCallable', context);
  const parameterNames = target.parameters.map((_, index) =>
    getGeneratedTargetName(`contextualCallableArgument${String(index)}`, context),
  );
  const parameters = target.parameters.map((parameter, index) => {
    const type = emitOptionalTypeCpp(
      emitCppParameterTypeCpp(parameter.type, parameter.rest, context),
      parameter.optional,
      context,
    );
    return `${type} ${parameterNames[index]!}`;
  });
  const arguments_ = parameterNames.slice(0, sourceType.parameters.length);
  const invocation = `${sourceName}(${arguments_.join(', ')})`;
  const returns = emitType(target.returns, context);
  const body =
    target.returns.kind === 'primitive' && target.returns.name === 'void' ? `${invocation};` : `return ${invocation};`;
  const source = emitExpression(expression, context, sourceType, false);
  return `[${sourceName} = ${source}](${parameters.join(', ')}) -> ${returns} { ${body} }`;
}

function getCppConstrainedTypeParameterUnionValueSlotCpp(
  type: Readonly<IrType>,
  valueSlots: readonly Readonly<{ targetType: string }>[],
  context: EmitContext,
): number | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind !== 'typeParameter' ||
    type.reference.path.length !== 0 ||
    type.typeArguments.length !== 0
  ) {
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  const declaration = context.anonymousStructTypeParameters.find((parameter) => parameter.binding.id === bindingId);
  const constraint = declaration?.constraint;
  if (!constraint || !hasFlightReferenceRepresentationCpp(constraint, context)) return undefined;
  const runtimeType = getIrTypeRuntimeDomainCpp(constraint, context, new Set());
  if (!runtimeType) return undefined;
  const targetType = emitType(runtimeType, { ...context, anonymousStructs: new Map(), includes: new Set() });
  const index = valueSlots.findIndex((slot) => slot.targetType === targetType);
  return index < 0 ? undefined : index;
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

// Whether an expression can denote a task at all, which is a different question from what its recorded
// type says. A return position types what is returned CONTEXTUALLY: `return { reason: 'x' }` in an
// `async` function is recorded as `Promise<Outcome>` because that is what the function returns, while the
// literal is an object and not a promise. `co_await` on it is not a syntax the target has, and it is what
// `expected primary-expression before '{'` was.
//
// What can denote a task is a value the program obtained -- a call, a reference, a conditional over
// those -- rather than a construction the emitter performs here. Reading the shape rather than only the
// type is what keeps this off object literals without keying it to object literals: an array literal, a
// scalar, an optional and a reference all answer the same way, and each for its own reason.
function canCppExpressionDenoteTaskCpp(expression: Readonly<IrExpression>): boolean {
  switch (expression.kind) {
    case 'array':
    case 'await':
    case 'function':
    case 'literal':
    case 'object':
    case 'objectRest':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'undefinedDefault':
    case 'undefinedValue':
      return false;
    case 'cast':
      return canCppExpressionDenoteTaskCpp(expression.expression);
    case 'conditional':
      return canCppExpressionDenoteTaskCpp(expression.whenTrue) || canCppExpressionDenoteTaskCpp(expression.whenFalse);
    default:
      return true;
  }
}

function emitAsyncTaskAdoptionCpp(expression: Readonly<IrExpression>, context: EmitContext): string | undefined {
  if (!context.async) return undefined;
  const expressionType = getIrExpressionTypeEvidenceCpp(expression, context);
  if (
    expressionType?.kind !== 'named' ||
    expressionType.reference.kind !== 'ambient' ||
    expressionType.reference.name !== 'Promise' ||
    !canCppExpressionDenoteTaskCpp(expression)
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
    emissionError(
      context,
      `async task adoption value type ${targetType} is not a represented runtime domain`,
      'cpp-async-task-value-type-unrepresented',
    );
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

// A runtime collection lookup carries one implicit undefined state outside the source value type.
// Build the representation of that storage explicitly before deciding that `lookup ?? null` can
// keep the lookup's optional unchanged. Comparing the value type spelling to the destination slot
// loses imported aliases (`types::Format` is still `flight::String`), while comparing the two plans
// uses the same alias resolution and target types that emit both carriers.
//
// A value type that already admits null or undefined is excluded: its lookup storage has two layers
// (`optional<optional<T>>` or the corresponding variant), so returning the raw lookup would preserve
// a missing-key layer that the nullish coalesce is required to consume.
function getCppImplicitAbsenceStoragePlanCpp(
  valueType: Readonly<IrType>,
  context: EmitContext,
): ReturnType<typeof getCppUnionRepresentationPlan> | undefined {
  const valueUnion = getIrUnionTypeCpp(valueType, context, new Set());
  if (valueUnion?.types.some((member) => member.kind === 'null' || member.kind === 'undefined')) {
    return undefined;
  }
  return getCppUnionRepresentationPlan({ kind: 'union', types: [valueType, { kind: 'undefined' }] }, context);
}

// `std::optional::value_or` is a function call, so its fallback argument is evaluated even when the
// optional is present. A source `??` must not do that. One optional payload domain is enough evidence
// to spell the lazy operation directly; wider optional variants remain on their existing conversion or
// refusal lanes, and a dual-sentinel carrier is rejected before this helper is reached.
//
// A plain binding is safe to name for the test and extraction independently. Every other expression is
// first bound because a property getter, collection lookup, or call may have effects of its own. This is
// not only an optimization distinction: duplicating that expression around `has_value()` and `value()`
// would change source evaluation count and order.
function emitCppOptionalSingleNullishCoalesceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  leftType: Readonly<IrType> | undefined,
  leftUsesOptionalStorage: boolean,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
  denseArrayLengthInitialized: boolean,
): string | undefined {
  if (!leftType) return undefined;
  const union = getIrUnionTypeCpp(leftType, context, new Set());
  const plan = union
    ? getCppUnionRepresentationPlan(union, context)
    : leftUsesOptionalStorage
      ? getCppImplicitAbsenceStoragePlanCpp(leftType, context)
      : undefined;
  const value = plan?.kind === 'optionalSingle' && plan.valueSlots.length === 1 ? plan.valueSlots[0] : undefined;
  if (!value) return undefined;
  const left = emitOptionalExpressionCpp(expression.left, context, leftType);
  const right = emitExpression(expression.right, context, expectedType, true, denseArrayLengthInitialized);
  context.includes.add('optional');
  if (isCppStableOptionalBindingIdentifierCpp(expression.left, context)) {
    return `(${left}.has_value() ? ${left}.value() : ${right})`;
  }
  return `([&]() -> ${value.targetType} { auto nullish_coalesce_left = ${left}; if (nullish_coalesce_left.has_value()) return nullish_coalesce_left.value(); return ${right}; }())`;
}

function isCppStableOptionalBindingIdentifierCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return false;
  const bindingId = expression.reference.binding.id;
  return (
    expression.presence !== 'narrowedPresent' &&
    !expression.narrowedMember &&
    !context.narrowedBindingTypes.has(bindingId) &&
    !context.sharedCaptureTargetNames.has(bindingId) &&
    !context.defaultedParameterIds.has(bindingId)
  );
}

// Two unions are interchangeable at a conversion site when they build the same C++ value: the same
// representation kind and the same target type in every slot. The source alternatives' own
// identities are deliberately not compared. A source spelling is not a representation:
// `readonly number[]` and `number[]` are one `flight::Array<double>` with no mutation in generated
// code, and one interface imported by two modules is one `flight::Ref` even though the two import
// bindings carry different identities. Comparing the spellings refused conversions whose target
// types were already identical, which was the largest single refusal family in the SDK corpus.
//
// Which sentinel an optional union spells is also not compared, and must not be: `string | undefined`
// and `string | null` are one `std::optional<flight::String>` whose absence is `std::nullopt` either
// way, which is what lets the nullish-coalesce path convert between them. Distinct runtime domains
// that erase onto one target type remain refused, by the collision check inside the planner that
// runs before this comparison.
function hasEquivalentCppUnionRepresentation(
  left: ReturnType<typeof getCppUnionRepresentationPlan>,
  right: ReturnType<typeof getCppUnionRepresentationPlan>,
): boolean {
  return (
    left.kind === right.kind &&
    left.valueSlots.length === right.valueSlots.length &&
    left.valueSlots.every((slot, index) => slot.targetType === right.valueSlots[index]?.targetType)
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
    emissionError(
      context,
      `${sentinel} is not represented by the contextual C++ union`,
      'cpp-union-sentinel-unrepresented',
    );
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
    case 'array': {
      const arraySlot = getSingleIrTypeKindCpp(valueSlots, 'array');
      if (arraySlot) return arraySlot;
      // An array literal is also how a tuple is written at the value: `[0, 0, 0, 0]` is what a
      // `readonly [number, number, number, number]` holds, and the source says the same thing either
      // way. The slot is still identified exactly -- one slot, and one whose arity the literal itself
      // decides -- because an array's length is open and a tuple's is not, so a literal of another
      // length is a value of a different type rather than a shorter one.
      const tupleSlot = getSingleIrTypeKindCpp(valueSlots, 'tuple');
      return tupleSlot?.kind === 'tuple' && tupleSlot.elements.length === expression.elements.length
        ? tupleSlot
        : undefined;
    }
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
      const declared = getIrIdentifierTypeEvidenceCpp(expression, context);
      if (declared) return declared;
      // A function declaration's binding records no type of its own, so its own signature is the
      // evidence. Without it, passing a named function where a function type is expected is
      // indistinguishable from passing a value of no stated type, which is the difference between a
      // guard being instalable and the module refusing.
      const declaration =
        expression.reference.kind === 'binding'
          ? getCppFunctionDeclarationForBindingCpp(expression.reference.binding.id, context)
          : undefined;
      return declaration ? getIrFunctionDeclarationTypeCpp(declaration) : undefined;
    }
    case 'literal':
      return typeof expression.value === 'boolean'
        ? { kind: 'primitive', name: 'boolean' }
        : typeof expression.value === 'number'
          ? { kind: 'primitive', name: 'number' }
          : typeof expression.value === 'string'
            ? { kind: 'primitive', name: 'string' }
            : { kind: 'null' };
    case 'new': {
      // An empty generic constructor carries no arguments from which to recover its type arguments.
      // Ask the same exact contextual-representability proof used by object members which single
      // union slot supplies them, so the slot and constructor both reach emitType through one type.
      const contextual = valueSlots.filter((slot) =>
        isCppExpressionRepresentableAsRuntimeTypeCpp(expression, slot.runtimeType, context),
      );
      return contextual.length === 1
        ? contextual[0]!.runtimeType
        : getIrNewExpressionTypeEvidenceCpp(expression, context);
    }
    case 'object':
      return getCppContextualObjectUnionRuntimeTypeCpp(expression, valueSlots, context) ?? expression.type;
    case 'template':
      // A template expression's value is a string, and it is one whatever its parts are: each part is
      // stringified and concatenated, so no part can make the result anything else. What the parts
      // decide is the SPELLING, which the emitter builds; the type is not in doubt here, which is what
      // makes this evidence rather than a guess about an expression whose type was never recorded.
      return { kind: 'primitive', name: 'string' };
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
      const unknownMember = members.some((member) => !targetByName.has(member.name));
      if (unknownMember) return false;
      // A required source property whose value domain contains absence has optional C++ storage. A
      // contextual partial object can omit it safely even when mapped-type lowering retained the
      // declaration's required bit; the aggregate's default construction represents that absence.
      const missingRequired = properties.some(
        (property) => !property.optional && !byName.has(property.name) && !hasIrTypeAbsentMember(property.type),
      );
      if (missingRequired) return false;
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
  const aliasModule = getCppNamedTypeBindingModuleCpp(type, context);
  const alias = resolveCppTypeAliasTarget(
    type,
    aliasModule === context.module ? context : { ...context, module: aliasModule },
  );
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
    if (!targetUnion) return false;
    const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
    const targetPlan = getCppUnionRepresentationPlan(targetUnion, isolatedContext);
    // A concrete named reference can initialize one wider union alternative even when an inferred
    // import through a barrel has no usable local C++ spelling. Compare the declared nominal heritage,
    // not object shape: an anonymous lookalike must not acquire a nominal arm, while a declared derived
    // reference may use its base arm. Exactly one arm is required, and a nullable or otherwise
    // union-valued source stays on the complete union-conversion path.
    if (!sourceUnion) {
      const sourceRuntime = getIrTypeRuntimeDomainCpp(source, context, new Set());
      if (!sourceRuntime || sourceRuntime.kind === 'null' || sourceRuntime.kind === 'undefined') return false;
      return getCppConcreteNamedUnionValueSlotCpp(sourceRuntime, targetPlan.valueSlots, context) !== undefined;
    }
    const sourcePlan = getCppUnionRepresentationPlan(sourceUnion, isolatedContext);
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

function getCppConcreteNamedUnionValueSlotCpp(
  source: Readonly<IrType>,
  valueSlots: readonly Readonly<{
    representationKey: string;
    runtimeType: IrType;
    sourceAlternatives: readonly IrType[];
  }>[],
  context: EmitContext,
): number | undefined {
  if (
    source.kind !== 'named' ||
    source.reference.kind !== 'binding' ||
    source.reference.binding.kind === 'typeParameter' ||
    source.typeArguments.length !== 0
  ) {
    return undefined;
  }
  const sourceModule = getCppNamedTypeBindingModuleCpp(source, context);
  const matches = valueSlots.flatMap((slot, slotIndex) =>
    slot.sourceAlternatives
      .flatMap((alternative) => getCppExpandedUnionSourceAlternativesCpp(alternative, context, new Set()))
      .flatMap((alternative) => {
        if (
          alternative.kind !== 'named' ||
          alternative.reference.kind !== 'binding' ||
          alternative.reference.binding.kind === 'typeParameter' ||
          alternative.typeArguments.length !== 0
        ) {
          return [];
        }
        const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
        const alternativePlan = getCppUnionRepresentationPlan(
          { kind: 'union', types: [alternative, { kind: 'null' }] },
          isolatedContext,
        );
        return alternativePlan.valueSlots[0]?.representationKey === slot.representationKey &&
          isCppNominalTypeDerivedFromCpp(
            source,
            sourceModule,
            alternative,
            getCppNamedTypeBindingModuleCpp(alternative, context),
            context,
            new Set(),
          )
          ? [slotIndex]
          : [];
      }),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function getCppNamedTypeBindingModuleCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): Readonly<IrModule> {
  if (type.reference.kind !== 'binding') return context.module;
  const binding = type.reference.binding;
  return (
    context.sourceModules.find(
      (module) => module.packageName === binding.packageName && module.source === binding.source,
    ) ?? context.module
  );
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
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  // A homomorphic identity utility over a union retains every runtime alternative. Without opening
  // the alias here, `Readonly<Texture>` appears to be one runtime domain while `Texture` is four,
  // even though the C++ type emitter erases the wrapper and both values use the same variant.
  if (identityPreserving && getIrUnionTypeCpp(identityPreserving, context, new Set())) {
    return getIrTypeRuntimeDomainCpp(identityPreserving, context, resolvingAliases);
  }
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
  if (type.reference.binding.kind === 'typeParameter') {
    const constraint = getCppDependentTypeParameterConstraintCpp(bindingId, context);
    if (!constraint) return type;
    return getIrTypeRuntimeDomainCpp(constraint, context, new Set(resolvingAliases).add(bindingId)) ?? type;
  }
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
  const preserved = getCppNullishMergeEvidenceCpp(expression, context);
  if (preserved) return preserved.resultType;
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

// An optional-chain element and an optional-chain property can carry the same value while generic
// expression recovery sees only the property's recorded type. Preserve their common result through
// `??` only from the representation plan both branches independently prove: one value domain, the
// same runtime representation, and the same mapping for null and undefined. Receiver spelling and
// nesting are irrelevant; a different value domain or sentinel mapping is not silently chosen.
function getCppNullishMergeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
):
  | Readonly<{
      leftType: IrType;
      resultType: IrType;
      rightType: IrType;
    }>
  | undefined {
  if (expression.operator !== '??') return undefined;
  const leftType = getCppNullishMergeBranchTypeEvidenceCpp(expression.left, context);
  const rightType = getCppNullishMergeBranchTypeEvidenceCpp(expression.right, context);
  if (!leftType || !rightType) return undefined;
  const leftUnion = getIrUnionTypeCpp(leftType, context, new Set());
  const rightUnion = getIrUnionTypeCpp(rightType, context, new Set());
  if (!leftUnion || !rightUnion) return undefined;
  const leftPlan = getCppUnionRepresentationPlan(leftUnion, context);
  const rightPlan = getCppUnionRepresentationPlan(rightUnion, context);
  const leftSlot = leftPlan.valueSlots.length === 1 ? leftPlan.valueSlots[0] : undefined;
  const rightSlot = rightPlan.valueSlots.length === 1 ? rightPlan.valueSlots[0] : undefined;
  if (
    !leftSlot ||
    !rightSlot ||
    leftSlot.representationKey !== rightSlot.representationKey ||
    leftSlot.targetType !== rightSlot.targetType ||
    leftPlan.sentinels.null !== rightPlan.sentinels.null ||
    leftPlan.sentinels.undefined !== rightPlan.sentinels.undefined
  ) {
    return undefined;
  }
  const resultType = createIrTypeEvidenceUnionCpp([
    ...leftUnion.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined'),
    ...rightUnion.types,
  ]);
  if (!resultType) return undefined;
  const resultUnion = getIrUnionTypeCpp(resultType, context, new Set());
  if (!resultUnion) return undefined;
  const resultPlan = getCppUnionRepresentationPlan(resultUnion, context);
  const resultSlot = resultPlan.valueSlots.length === 1 ? resultPlan.valueSlots[0] : undefined;
  if (
    !resultSlot ||
    resultSlot.representationKey !== leftSlot.representationKey ||
    resultSlot.targetType !== leftSlot.targetType ||
    resultPlan.sentinels.null !== leftPlan.sentinels.null ||
    resultPlan.sentinels.undefined !== leftPlan.sentinels.undefined
  ) {
    return undefined;
  }
  return { leftType, resultType, rightType };
}

function getCppNullishMergeBranchTypeEvidenceCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const direct = getIrExpressionTypeEvidenceCpp(expression, context);
  if (direct && direct.kind !== 'unknown') return direct;
  const valueType = getIrOptionalChainValueTypeEvidenceCpp(expression, context);
  if (!valueType || valueType.kind === 'unknown') return undefined;
  const semantics =
    expression.kind === 'call'
      ? expression.semantics.optionalChain
      : expression.kind === 'element'
        ? expression.semantics.optionalChain
        : expression.kind === 'property'
          ? expression.optionalChain
          : undefined;
  return semantics?.receiverNullish === 'possible'
    ? createIrTypeEvidenceUnionCpp([valueType, { kind: semantics.result }])
    : valueType;
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
  // An overload call's checker-selected result is narrower than the implementation signature by
  // design. Prefer that recorded selection before resolving the implementation declaration, or a
  // package-graph session which has already indexed the callee widens the same call that an isolated
  // session keeps narrow.
  if (expression.semantics.overloadImplementation && expression.semantics.resultType.kind !== 'unknown') {
    return expression.semantics.resultType;
  }
  if (expression.callee.kind === 'property' && expression.callee.optionalChain) {
    const callableReturns = getCppCallableReturnType(expression.callee.optionalChain.valueType, context, new Set());
    const recovered = getCppOptionalPropertyCallResultTypeEvidenceCpp(expression, context);
    const returns =
      callableReturns?.kind === 'unknown' ? (recovered ?? callableReturns) : (callableReturns ?? recovered);
    if (returns && returns.kind !== 'unknown') {
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
  const runtimeResult = getCppRuntimeMemberCallResultTypeEvidence(expression, context);
  const stringConversion = getCppPrimitiveStringConversionCallResultTypeCpp(expression, context);
  if (expression.semantics.resultType.kind !== 'unknown') {
    return (
      (runtimeResult
        ? getCppInvariantCollectionEvidenceRefinementCpp(expression.semantics.resultType, runtimeResult)
        : undefined) ?? expression.semantics.resultType
    );
  }
  if (runtimeResult) return runtimeResult;
  if (stringConversion) return stringConversion;
  const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
  return calleeType ? getCppCallableReturnType(calleeType, context, new Set()) : undefined;
}

function isIrNumberTypeEvidenceCpp(type: Readonly<IrType> | undefined): boolean {
  return type?.kind === 'primitive' && type.name === 'number';
}

function isIrStringTypeEvidenceCpp(type: Readonly<IrType> | undefined): boolean {
  return type?.kind === 'primitive' && type.name === 'string';
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
    const argumentType =
      getIrInvocationProvidedArgumentTypeCpp(expression, index) ?? getIrExpressionTypeEvidenceCpp(argument, context);
    if (!parameter?.type || !argumentType || argumentType.kind === 'unknown') return;
    const deductionType = parameter.optional ? getCppProvidedOptionalArgumentTypeCpp(argumentType) : argumentType;
    if (!deductionType) return;
    const candidateSubstitutions = new Map(argumentSubstitutions);
    if (
      collectCppResultTypeSubstitutionsCpp(parameter.type, deductionType, parameterIds, candidateSubstitutions, context)
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

function getCppValueRepresentedCallTypeArgumentsCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  typeArguments: readonly Readonly<IrType>[],
  context: EmitContext,
): readonly Readonly<IrType>[] {
  if (
    getCppRuntimeProfile(context.options) !== 'flight-cpp' ||
    !typeArguments.some((type) => type.kind === 'primitive' && type.name === 'void') ||
    expression.callee.kind !== 'identifier' ||
    expression.callee.reference.kind !== 'binding'
  ) {
    return typeArguments;
  }
  const declaration = getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context);
  if (!declaration || declaration.typeParameters.length !== typeArguments.length) return typeArguments;
  const substitutions = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, typeArguments);
  const reifiedParameterIds = new Set<string>();
  expression.arguments.forEach((argument, index) => {
    const parameter = declaration.parameters[index];
    const argumentType = getIrExpressionTypeEvidenceCpp(argument, context);
    if (
      !parameter ||
      parameter.rest ||
      argumentType?.kind !== 'primitive' ||
      argumentType.name !== 'void' ||
      parameter.type.kind !== 'named' ||
      parameter.type.reference.kind !== 'binding' ||
      parameter.type.reference.binding.kind !== 'typeParameter' ||
      parameter.type.reference.path.length !== 0 ||
      parameter.type.typeArguments.length !== 0
    ) {
      return;
    }
    const represented = resolveIrTypeStructuralSubstitution(parameter.type, substitutions);
    if (represented.kind === 'primitive' && represented.name === 'void') {
      reifiedParameterIds.add(parameter.type.reference.binding.id);
    }
  });
  if (reifiedParameterIds.size === 0) return typeArguments;
  context.includes.add('flight/presence.hpp');
  return typeArguments.map((type, index) =>
    type.kind === 'primitive' &&
    type.name === 'void' &&
    reifiedParameterIds.has(declaration.typeParameters[index]!.binding.id)
      ? { kind: 'undefined' as const }
      : type,
  );
}

// A supplied optional argument is recorded with the parameter's `undefined` branch even when the
// expression itself is present. Strip only that sentinel here. Resolving the remaining alias would
// erase the named generic application which template deduction needs to align with the declaration.
function getCppProvidedOptionalArgumentTypeCpp(type: Readonly<IrType>): Readonly<IrType> | undefined {
  if (type.kind !== 'union') return type.kind === 'undefined' ? undefined : type;
  const present = type.types.filter((member) => member.kind !== 'undefined');
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { kind: 'union', types: [present[0]!, present[1]!, ...present.slice(2)] };
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
  if (
    pattern.kind === 'intersection' &&
    candidate.kind === 'intersection' &&
    pattern.types.length === candidate.types.length
  ) {
    return pattern.types.every((type, index) =>
      collectCppResultTypeSubstitutionsCpp(type, candidate.types[index]!, parameterIds, substitutions, context),
    );
  }
  if (pattern.kind === 'union' && candidate.kind === 'union' && pattern.types.length === candidate.types.length) {
    return pattern.types.every((type, index) =>
      collectCppResultTypeSubstitutionsCpp(type, candidate.types[index]!, parameterIds, substitutions, context),
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

// An optional continuation can lose its ambient method signature when the lean package-graph checker
// sees the nullable receiver as `any`. The call immediately before it still retains the instantiated
// collection result, so recover only the value selected by a concrete Map/ReadonlyMap `get` receiver.
// A lookalike method, an erased value, or a union of different collection instantiations supplies no
// such proof and stays unrepresented.
function getCppOptionalCollectionPropertyCallValueTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const callee = expression.callee;
  if (callee.kind !== 'property' || !callee.optional || callee.name !== 'get') return undefined;
  const receiver = getIrExpressionTypeEvidenceCpp(callee.object, context);
  const presentReceiver = receiver ? getCppNonNullableType(receiver, context, new Set()) : undefined;
  const collection = getIrAmbientCollectionTypeCpp(presentReceiver, context, new Set());
  if (
    !collection ||
    !['Map', 'ReadonlyMap'].includes(collection.reference.name) ||
    collection.typeArguments.length !== 2
  ) {
    return undefined;
  }
  const value = collection.typeArguments[1];
  return value?.kind === 'unknown' ? undefined : value;
}

// A nullable receiver can retain one callable member while the lean package-graph library gives that
// generic callable an `any` return. The call still carries the checker's instantiated result. Use that
// result only when the member evidence identifies one callable surface, and remove only the sentinel
// introduced by this optional-chain segment. A union of callables is deliberately not one surface: the
// checker can report one selected signature even though another runtime alternative returns a different
// domain, so accepting its result would choose an alternative the receiver did not prove.
function getCppOptionalPropertyCallSemanticResultTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const callee = expression.callee;
  const semantics = callee.kind === 'property' && callee.optional ? callee.optionalChain : undefined;
  if (!semantics || !getCppClosedCallableType(semantics.valueType, context, new Set())) return undefined;
  const result = expression.semantics.resultType;
  if (result.kind === 'unknown') return undefined;
  if (result.kind !== 'union') return hasIrTypeAbsentMember(result) ? undefined : result;
  const invoked = result.types.filter((member) => member.kind !== semantics.result);
  const recovered = createIrTypeEvidenceUnionCpp(invoked);
  return recovered && !hasIrTypeAbsentMember(recovered) ? recovered : undefined;
}

function getCppOptionalPropertyCallResultTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  return (
    getCppOptionalCollectionPropertyCallValueTypeEvidenceCpp(expression, context) ??
    getCppRuntimeMemberCallResultTypeEvidence(expression, context) ??
    getCppOptionalPropertyCallSemanticResultTypeEvidenceCpp(expression, context)
  );
}

function getCppRuntimeCollectionResultRefinementCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  declaredType: Readonly<IrType>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const runtimeType = getCppRuntimeMemberCallResultTypeEvidence(expression, context);
  return runtimeType ? getCppInvariantCollectionEvidenceRefinementCpp(declaredType, runtimeType) : undefined;
}

// Array and tuple storage is invariant in C++, so a standard method that preserves its receiver's
// element values must keep that exact element type. Semantic library evidence may leave an `any` or
// `unknown` hole inside the same array/tuple skeleton; fill only those holes from the runtime contract.
// A different concrete leaf, arity, or optional/rest shape is not a refinement and remains ineligible,
// which prevents this path from becoming an unchecked container conversion.
function getCppInvariantCollectionEvidenceRefinementCpp(
  declaredType: Readonly<IrType>,
  runtimeType: Readonly<IrType>,
): Readonly<IrType> | undefined {
  const refine = (
    declared: Readonly<IrType>,
    runtime: Readonly<IrType>,
  ): Readonly<{ changed: boolean; type: Readonly<IrType> }> | undefined => {
    if (normalizeCompilerStructuralValueCanonical(declared) === normalizeCompilerStructuralValueCanonical(runtime)) {
      return { changed: false, type: declared };
    }
    if (isCppErasedDynamicValueTypeCpp(declared) && runtime.kind !== 'unknown') {
      return { changed: true, type: runtime };
    }
    if (declared.kind === 'array' && runtime.kind === 'array') {
      const element = refine(declared.element, runtime.element);
      return element ? { changed: element.changed, type: { ...declared, element: element.type } } : undefined;
    }
    if (declared.kind !== 'tuple' || runtime.kind !== 'tuple') return undefined;
    if (declared.elements.length !== runtime.elements.length) return undefined;
    const elements = declared.elements.map((element, index) => {
      const runtimeElement = runtime.elements[index]!;
      if (element.optional !== runtimeElement.optional || element.rest !== runtimeElement.rest) return undefined;
      const type = refine(element.type, runtimeElement.type);
      return type ? { changed: type.changed, element: { ...element, type: type.type } } : undefined;
    });
    if (elements.some((element) => !element)) return undefined;
    return {
      changed: elements.some((element) => element!.changed),
      type: { ...declared, elements: elements.map((element) => element!.element) },
    };
  };
  const refinement = refine(declaredType, runtimeType);
  return refinement?.changed ? refinement.type : undefined;
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
  const direct = getCppRuntimeExternalCallResultTargetCpp(
    expression,
    getCppRuntimeProfile(context.options),
    context.options.externalBindings,
  );
  if (direct) return direct;
  if (
    expression.kind !== 'call' ||
    expression.optional ||
    expression.semantics.optionalChain ||
    expression.callee.kind !== 'property'
  ) {
    return undefined;
  }
  const receiver = getCppExternalInstanceReceiverSourceNameCpp(expression.callee.object, context);
  return receiver
    ? getCompilerRuntimeExternalInstanceMemberCallResultTypeCpp(
        receiver,
        expression.callee.name,
        getCppRuntimeProfile(context.options),
        context.options.externalBindings,
      )
    : undefined;
}

function getCppExternalInstanceReceiverSourceNameCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  const type = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!type || hasIrTypeAbsentMember(type)) return undefined;
  const present = getCppNonNullableType(type, context, new Set()) ?? type;
  return present?.kind === 'named' && present.reference.kind === 'ambient' ? present.reference.name : undefined;
}

function getCppExternalInstanceCallParameterExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  context: EmitContext,
): Readonly<IrType> | undefined {
  if (expression.callee.kind !== 'property') return undefined;
  const receiver = getCppExternalInstanceReceiverSourceNameCpp(expression.callee.object, context);
  if (!receiver) return undefined;
  const sourceType = getCompilerRuntimeExternalInstanceMemberParameterTypeCpp(
    receiver,
    expression.callee.name,
    index,
    getCppRuntimeProfile(context.options),
    context.options.externalBindings,
  );
  return sourceType
    ? {
        kind: 'named',
        reference: { kind: 'ambient', name: sourceType },
        typeArguments: [],
      }
    : undefined;
}

function getCppExternalValueObjectSourceNameCpp(
  type: Readonly<IrType> | undefined,
  context: EmitContext,
): string | undefined {
  if (type?.kind !== 'named' || type.reference.kind !== 'ambient') return undefined;
  const evidence = getCompilerExternalBindingEvidenceCpp(type.reference.name, 'type', context.options.externalBindings);
  return evidence?.ownership === 'value' && evidence.nullability === 'non-null' ? evidence.sourceName : undefined;
}

function emitCppExternalObjectConstructionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  sourceName: string,
  context: EmitContext,
): string {
  const construction = getCompilerExternalBindingObjectConstructionCpp(sourceName, context.options.externalBindings);
  if (!construction) {
    emissionError(
      context,
      `external object ${sourceName} construction requires an exact field contract`,
      'cpp-external-object-field-contract-missing',
    );
  }
  if (expression.members.some((member) => member.kind !== 'property')) {
    emissionError(
      context,
      `external object ${sourceName} construction requires explicit named fields`,
      'cpp-external-object-field-contract-unproven',
    );
  }
  const properties = expression.members.filter(
    (member): member is Extract<(typeof expression.members)[number], { kind: 'property' }> =>
      member.kind === 'property',
  );
  const sourceFields = new Set(properties.map((property) => property.name.normalize('NFC')));
  if (sourceFields.size !== properties.length) {
    emissionError(
      context,
      `external object ${sourceName} construction has ambiguous source fields`,
      'cpp-external-object-field-contract-ambiguous',
    );
  }
  const fields = new Map(construction.fields.map((field) => [field.sourceField, field] as const));
  const assignments = properties.map((property) => {
    const field = fields.get(property.name.normalize('NFC'));
    if (!field) {
      emissionError(
        context,
        `external object ${sourceName} field ${property.name} has no exact field contract`,
        'cpp-external-object-field-contract-missing',
      );
    }
    return { field, property };
  });
  addCppExternalBindingHeaders(sourceName, 'type', context);
  const target = getGeneratedTargetName(`external_${sourceName}`, context);
  const statements = assignments.map(
    ({ field, property }) => `${target}.${field.targetName} = ${emitExpression(property.value, context)};`,
  );
  return `(${context.namespaceScope ? '[]' : '[&]'}() { ${construction.targetName} ${target}{}; ${statements.join(' ')} return ${target}; }())`;
}

function getCppExternalInstanceMemberBindingCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): Readonly<{ sourceName: string; targetName: string }> | undefined {
  const sourceName = getCppExternalInstanceReceiverSourceNameCpp(expression.object, context);
  if (!sourceName) return undefined;
  const targetName = getCompilerRuntimeExternalInstanceMemberTargetCpp(
    sourceName,
    expression.name,
    getCppRuntimeProfile(context.options),
    context.options.externalBindings,
  );
  return targetName ? { sourceName, targetName } : undefined;
}

interface CppExternalNumericPropertyViewPlan {
  readonly sourceName: string;
  readonly targetName: string;
}

function getCppExternalNumericPropertyViewPlanCpp(
  receiver: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<CppExternalNumericPropertyViewPlan> | undefined {
  const sourceName = getCppExternalInstanceReceiverSourceNameCpp(receiver, context);
  if (!sourceName) return undefined;
  const view = getCompilerExternalBindingNumericPropertyViewCpp(sourceName, context.options.externalBindings);
  return view ? { sourceName, targetName: view.targetName } : undefined;
}

function getCppExternalNumericPropertyViewAccessPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' | 'property' }>>,
  context: EmitContext,
): Readonly<CppExternalNumericPropertyViewPlan> | undefined {
  if (expression.kind === 'property' && getCppExternalInstanceMemberBindingCpp(expression, context)) return undefined;
  return getCppExternalNumericPropertyViewPlanCpp(expression.object, context);
}

function getCppExternalNumericPropertyViewTypeCpp(): Readonly<IrType> {
  return {
    kind: 'union',
    types: [{ kind: 'primitive', name: 'number' }, { kind: 'undefined' }],
  };
}

function emitCppExternalNumericPropertyViewPropertyCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  const plan = getCppExternalNumericPropertyViewAccessPlanCpp(expression, context);
  if (!plan) return undefined;
  addCppExternalBindingHeaders(plan.sourceName, 'type', context);
  context.includes.add('flight/string.hpp');
  return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${plan.targetName}(${emitLiteral(expression.name, context)})`;
}

function emitCppExternalNumericPropertyViewElementCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string | undefined {
  const plan = getCppExternalNumericPropertyViewAccessPlanCpp(expression, context);
  if (!plan) return undefined;
  if (!isCppStringKeyIndexCpp(expression.index, context)) {
    emissionError(
      context,
      'an external numeric-property view requires a proven string key',
      'cpp-external-numeric-property-view-key-unrepresented',
    );
  }
  addCppExternalBindingHeaders(plan.sourceName, 'type', context);
  context.includes.add('flight/string.hpp');
  return `${emitExpression(expression.object, context)}${memberOp(expression.object, context)}${plan.targetName}(${emitExpression(expression.index, context)})`;
}

function getCppRuntimeExternalCallResultTargetCpp(
  expression: Readonly<IrExpression>,
  runtimeProfile: CppCompilerRuntimeProfile,
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): string | undefined {
  if (
    (expression.kind !== 'call' && expression.kind !== 'new') ||
    (expression.kind === 'call' && (expression.optional || expression.semantics.optionalChain))
  ) {
    return undefined;
  }
  const callee = expression.callee;
  if (callee.kind === 'identifier' && callee.reference.kind === 'ambient') {
    return getCompilerRuntimeExternalSymbolCallResultTypeCpp(callee.reference.name, runtimeProfile, externalBindings);
  }
  if (callee.kind === 'property' && callee.object.kind === 'identifier' && callee.object.reference.kind === 'ambient') {
    return getCompilerRuntimeExternalMemberCallResultTypeCpp(
      callee.object.reference.name,
      callee.name,
      runtimeProfile,
      externalBindings,
    );
  }
  return undefined;
}

function collectCppExternalBindingStorageTargetTypesCpp(
  module: Readonly<IrModule>,
  context: EmitContext,
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>();
  const recordCandidate = (bindingId: string, expression: Readonly<IrExpression>): void => {
    const declaredType = context.bindingTypes.get(bindingId);
    if (!declaredType || !isCppUnresolvedExternalStorageTypeCpp(declaredType)) return;
    const targetType = getCppExternalCallResultTargetCpp(expression, context);
    if (!targetType) return;
    const targets = candidates.get(bindingId) ?? new Set<string>();
    targets.add(targetType);
    candidates.set(bindingId, targets);
  };
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (
        expression.kind !== 'assignment' ||
        expression.operator !== '=' ||
        expression.left.kind !== 'identifier' ||
        expression.left.reference.kind !== 'binding'
      ) {
        return;
      }
      recordCandidate(expression.left.reference.binding.id, expression.right);
    },
    variable(variable) {
      if ('binding' in variable && variable.initializer) {
        recordCandidate(variable.binding.id, variable.initializer);
      }
    },
  });
  return new Map(
    [...candidates].flatMap(([bindingId, targets]) =>
      targets.size === 1 ? ([[bindingId, [...targets][0]!] as const] as const) : [],
    ),
  );
}

function collectCppExceptionPointerBindingIdsCpp(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): ReadonlySet<string> {
  // Preserve the caught exception object only for the closed capture-and-rethrow pattern. Counting
  // every reference keeps ordinary unknown storage on the dynamic-value path as soon as it is read,
  // initialized, or assigned from anything other than a catch binding.
  const candidates = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (
        'binding' in variable &&
        variable.mutable &&
        !variable.initializer &&
        bindingTypes.get(variable.binding.id)?.kind === 'unknown'
      ) {
        candidates.add(variable.binding.id);
      }
    },
  });
  const assignmentCounts = new Map<string, number>();
  const invalidAssignments = new Set<string>();
  const referenceCounts = new Map<string, number>();
  const throwCounts = new Map<string, number>();
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
        const bindingId = expression.reference.binding.id;
        if (candidates.has(bindingId)) referenceCounts.set(bindingId, (referenceCounts.get(bindingId) ?? 0) + 1);
      }
      if (
        expression.kind !== 'assignment' ||
        expression.left.kind !== 'identifier' ||
        expression.left.reference.kind !== 'binding' ||
        !candidates.has(expression.left.reference.binding.id)
      ) {
        return;
      }
      const bindingId = expression.left.reference.binding.id;
      assignmentCounts.set(bindingId, (assignmentCounts.get(bindingId) ?? 0) + 1);
      if (
        expression.operator !== '=' ||
        expression.right.kind !== 'identifier' ||
        expression.right.reference.kind !== 'binding' ||
        expression.right.reference.binding.kind !== 'catch'
      ) {
        invalidAssignments.add(bindingId);
      }
    },
    statement(statement) {
      if (
        statement.kind === 'throw' &&
        statement.expression.kind === 'identifier' &&
        statement.expression.reference.kind === 'binding' &&
        candidates.has(statement.expression.reference.binding.id)
      ) {
        const bindingId = statement.expression.reference.binding.id;
        throwCounts.set(bindingId, (throwCounts.get(bindingId) ?? 0) + 1);
      }
    },
  });
  return new Set(
    [...candidates].filter((bindingId) => {
      const assignments = assignmentCounts.get(bindingId) ?? 0;
      const throws = throwCounts.get(bindingId) ?? 0;
      return (
        assignments > 0 &&
        throws > 0 &&
        !invalidAssignments.has(bindingId) &&
        referenceCounts.get(bindingId) === assignments + throws
      );
    }),
  );
}

function collectCppContextualBindingStorageTargetTypesCpp(
  module: Readonly<IrModule>,
  context: EmitContext,
): ReadonlyMap<string, Readonly<IrType>> {
  const acceptedReferenceCounts = new Map<string, number>();
  const candidates = new Map<string, Map<string, Readonly<IrType>>>();
  const eligible = new Set<string>();
  const projected = new Set<string>();
  const referenceCounts = new Map<string, number>();
  const recordTarget = (expression: Readonly<IrExpression>, expectedType: Readonly<IrType> | undefined): void => {
    if (
      expression.kind !== 'identifier' ||
      expression.reference.kind !== 'binding' ||
      !eligible.has(expression.reference.binding.id)
    ) {
      return;
    }
    const bindingId = expression.reference.binding.id;
    const sourceType = context.bindingTypes.get(bindingId);
    const targetType = expectedType
      ? (getCppNonNullableType(expectedType, context, new Set()) ?? expectedType)
      : undefined;
    if (!sourceType || !targetType) return;
    let representationEquivalent = true;
    if (
      !isCppContextualCollectionProjectionCpp(sourceType, targetType, context) &&
      !isCppEmptyArrayAssignmentStorageTargetCpp(bindingId, sourceType, targetType, module, context)
    ) {
      if (
        !hasFlightReferenceRepresentationCpp(targetType, context) ||
        hasFlightStructuralRowRepresentationCpp(targetType, context)
      ) {
        return;
      }
      const sourceShape = context.referenceRepresentationPlanner.resolveObjectShape(sourceType, context.module);
      const targetShape = context.referenceRepresentationPlanner.resolveObjectShape(targetType, context.module);
      if (!sourceShape || !targetShape) {
        return;
      }
      representationEquivalent = areCppObjectShapesRepresentationEquivalent(sourceShape, targetShape, context);
      if (
        !representationEquivalent &&
        !isCppContextualNamedObjectLiteralConstructionCpp(bindingId, targetType, context)
      ) {
        return;
      }
    }
    acceptedReferenceCounts.set(bindingId, (acceptedReferenceCounts.get(bindingId) ?? 0) + 1);
    if (!representationEquivalent) projected.add(bindingId);
    const targets = candidates.get(bindingId) ?? new Map<string, Readonly<IrType>>();
    targets.set(normalizeCompilerStructuralValueCanonical(targetType), targetType);
    candidates.set(bindingId, targets);
  };
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      const inferredType =
        'binding' in variable && variable.initializer
          ? getIrExpressionTypeEvidenceCpp(variable.initializer, context)
          : undefined;
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
        variable.initializer &&
        variable.type &&
        ((variable.initializer.kind === 'object' && hasFlightReferenceRepresentationCpp(variable.type, context)) ||
          getIrArrayTypeCpp(inferredType, context, new Set()) !== undefined ||
          (variable.initializer.kind === 'array' &&
            variable.initializer.elements.length === 0 &&
            getIrArrayTypeCpp(variable.type, context, new Set()) !== undefined))
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
      analyzeIrStatementSubtreeTraversal(statement, {
        expression(expression) {
          if (expression.kind === 'function') return false;
          return undefined;
        },
        statement(candidate) {
          if (candidate.kind !== 'return' || !candidate.expression) return;
          if (candidate.expression.kind === 'object') {
            collectCppObjectContextualStorageTargetsCpp(
              candidate.expression,
              returnType,
              eligible,
              candidates,
              context,
            );
          } else {
            recordTarget(candidate.expression, returnType);
          }
        },
      });
    }
  }
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (
        expression.kind === 'identifier' &&
        expression.reference.kind === 'binding' &&
        eligible.has(expression.reference.binding.id)
      ) {
        const bindingId = expression.reference.binding.id;
        referenceCounts.set(bindingId, (referenceCounts.get(bindingId) ?? 0) + 1);
      }
      if (expression.kind === 'assignment' && expression.operator === '=') {
        recordTarget(expression.right, getIrAssignmentTargetTypeCpp(expression.left, context));
      }
      if (expression.kind === 'object') {
        collectCppObjectContextualStorageTargetsCpp(expression, expression.type, eligible, candidates, context);
      }
      if (expression.kind !== 'call') return;
      expression.arguments.forEach((argument, index) => {
        const expectedType = getIrCallArgumentExpectedTypeCpp(expression, index, context);
        recordTarget(argument, expectedType);
      });
    },
  });
  return new Map(
    [...candidates].flatMap(([bindingId, targets]) =>
      targets.size === 1 &&
      (!projected.has(bindingId) || referenceCounts.get(bindingId) === acceptedReferenceCounts.get(bindingId))
        ? ([[bindingId, [...targets.values()][0]!] as const] as const)
        : [],
    ),
  );
}

function isCppContextualNamedObjectLiteralConstructionCpp(
  bindingId: string,
  targetType: Readonly<IrType>,
  context: EmitContext,
): boolean {
  // A fresh object may adopt a narrower nominal layout at its allocation site only when every
  // observable use asks for that one identity. Requiring all destination fields after the last
  // spread proves that omitted source-only fields never enter the allocation; restricting spreads
  // to closed Flight data references makes their otherwise discarded reads inert in this runtime.
  if (
    targetType.kind !== 'named' ||
    targetType.reference.kind !== 'binding' ||
    targetType.reference.binding.kind === 'typeParameter'
  ) {
    return false;
  }
  const initializer = context.bindingInitializers.get(bindingId);
  if (initializer?.kind !== 'object') return false;
  const sourceProperties = context.referenceRepresentationPlanner.resolveObjectShape(initializer.type, context.module);
  const targetProperties = context.referenceRepresentationPlanner.resolveObjectShape(targetType, context.module);
  if (
    !sourceProperties ||
    !targetProperties ||
    targetProperties.length === 0 ||
    targetProperties.some((property) => property.computedKey || property.phantom)
  ) {
    return false;
  }
  let lastSpread = -1;
  initializer.members.forEach((member, index) => {
    if (member.kind === 'spread') lastSpread = index;
  });
  const spreads = initializer.members.slice(0, lastSpread + 1);
  const properties = initializer.members.slice(lastSpread + 1);
  if (
    spreads.some((member) => {
      if (member.kind !== 'spread' || member.expression.kind !== 'identifier') return true;
      const sourceType = getIrExpressionTypeEvidenceCpp(member.expression, context);
      const valueType = sourceType ? (getCppNonNullableType(sourceType, context, new Set()) ?? sourceType) : undefined;
      return (
        !valueType ||
        !context.referenceRepresentationPlanner.resolveObjectShape(valueType, context.module) ||
        (!hasFlightReferenceRepresentationCpp(valueType, context) &&
          !hasFlightStructuralRowRepresentationCpp(valueType, context))
      );
    }) ||
    properties.some((member) => member.kind !== 'property')
  ) {
    return false;
  }
  const propertiesByName = new Map<string, Extract<(typeof properties)[number], { kind: 'property' }>>();
  for (const member of properties) {
    if (member.kind !== 'property' || propertiesByName.has(member.name)) return false;
    propertiesByName.set(member.name, member);
  }
  if (propertiesByName.size !== targetProperties.length) return false;
  const sourcePropertiesByName = new Map(sourceProperties.map((property) => [property.name, property] as const));
  return targetProperties.every((property) => {
    const member = propertiesByName.get(property.name);
    const sourceProperty = sourcePropertiesByName.get(property.name);
    if (!member || !sourceProperty || (sourceProperty.optional && !property.optional)) return false;
    const sourceReadType = sourceProperty.optional
      ? (createIrTypeEvidenceUnionCpp([sourceProperty.type, { kind: 'undefined' }]) ?? sourceProperty.type)
      : sourceProperty.type;
    const targetReadType = property.optional
      ? (createIrTypeEvidenceUnionCpp([property.type, { kind: 'undefined' }]) ?? property.type)
      : property.type;
    return (
      areCppTypesRepresentationEquivalent(sourceReadType, targetReadType, context) ||
      (!sourceProperty.optional &&
        property.optional &&
        areCppTypesRepresentationEquivalent(sourceProperty.type, property.type, context))
    );
  });
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
    const declaredType = context.bindingTypes.get(bindingId);
    const sourceType =
      declaredType && declaredType.kind !== 'unknown'
        ? declaredType
        : getIrExpressionTypeEvidenceCpp(context.bindingInitializers.get(bindingId)!, context);
    const targetType = getIrObjectPropertyTypeCpp(contextualType, member.name, context);
    if (!sourceType || !targetType || !isCppContextualCollectionProjectionCpp(sourceType, targetType, context)) {
      continue;
    }
    const targets = candidates.get(bindingId) ?? new Map<string, Readonly<IrType>>();
    targets.set(normalizeCompilerStructuralValueCanonical(targetType), targetType);
    candidates.set(bindingId, targets);
  }
}

function isCppContextualCollectionProjectionCpp(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  const sourceCollection = getIrAmbientCollectionTypeCpp(source, context, new Set());
  const targetCollection = getIrAmbientCollectionTypeCpp(target, context, new Set());
  if (
    sourceCollection &&
    targetCollection &&
    ((sourceCollection.reference.name === 'Map' && targetCollection.reference.name === 'ReadonlyMap') ||
      (sourceCollection.reference.name === 'Set' && targetCollection.reference.name === 'ReadonlySet'))
  ) {
    return true;
  }
  const sourceArray = getIrArrayTypeCpp(source, context, new Set());
  const targetArray = getIrArrayTypeCpp(target, context, new Set());
  if (!sourceArray || !targetArray) return false;
  const sourceShape = context.referenceRepresentationPlanner.resolveObjectShape(sourceArray.element, context.module);
  const targetShape = context.referenceRepresentationPlanner.resolveObjectShape(targetArray.element, context.module);
  return Boolean(
    sourceShape &&
    targetShape &&
    hasFlightReferenceRepresentationCpp(targetArray.element, context) &&
    areCppObjectShapesRepresentationEquivalent(sourceShape, targetShape, context),
  );
}

function isCppEmptyArrayAssignmentStorageTargetCpp(
  bindingId: string,
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
): boolean {
  const sourceArray = getIrArrayTypeCpp(source, context, new Set());
  const targetArray = getIrArrayTypeCpp(target, context, new Set());
  const initializer = context.bindingInitializers.get(bindingId);
  if (
    sourceArray?.element.kind !== 'unknown' ||
    sourceArray.element.source !== 'any' ||
    !targetArray ||
    !hasFlightReferenceRepresentationCpp(targetArray.element, context) ||
    initializer?.kind !== 'array' ||
    initializer.elements.length !== 0
  ) {
    return false;
  }
  const targetIdentity = normalizeCompilerStructuralValueCanonical(target);
  let references = 0;
  let representedUses = 0;
  let incompatibleWrite = false;
  analyzeIrModuleTraversal(module, {
    expression(expression) {
      if (
        expression.kind === 'identifier' &&
        expression.reference.kind === 'binding' &&
        expression.reference.binding.id === bindingId
      ) {
        references += 1;
      }
      if (
        expression.kind === 'call' &&
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.name === 'push' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'binding' &&
        expression.callee.object.reference.binding.id === bindingId
      ) {
        representedUses += 1;
        incompatibleWrite ||= expression.arguments.some(
          (argument) =>
            argument.kind === 'spread' ||
            !isCppContextualArrayElementWriteRepresentableCpp(argument, targetArray.element, context),
        );
      }
      if (
        expression.kind === 'assignment' &&
        expression.operator === '=' &&
        expression.right.kind === 'identifier' &&
        expression.right.reference.kind === 'binding' &&
        expression.right.reference.binding.id === bindingId
      ) {
        const assignmentTarget = getIrAssignmentTargetTypeCpp(expression.left, context);
        if (assignmentTarget && normalizeCompilerStructuralValueCanonical(assignmentTarget) === targetIdentity) {
          representedUses += 1;
        }
      }
    },
  });
  return !incompatibleWrite && references > 0 && references === representedUses;
}

function isCppContextualArrayElementWriteRepresentableCpp(
  expression: Readonly<IrExpression>,
  target: Readonly<IrType>,
  context: EmitContext,
): boolean {
  if (isCppExpressionRepresentableAsRuntimeTypeCpp(expression, target, context)) return true;
  if (expression.kind !== 'object' || expression.members.some((member) => member.kind !== 'property')) return false;
  const sourceShape = context.referenceRepresentationPlanner.resolveObjectShape(expression.type, context.module);
  const targetShape = context.referenceRepresentationPlanner.resolveObjectShape(target, context.module);
  return Boolean(
    sourceShape && targetShape && areCppObjectShapesRepresentationEquivalent(sourceShape, targetShape, context),
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
    emissionError(
      context,
      `external binding storage ${targetType} requires unresolved source type evidence`,
      'cpp-external-binding-missing-source-type-evidence',
    );
  }
  const present = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  const absent = type.types.filter((member) => member.kind === 'null' || member.kind === 'undefined');
  if (present.length !== 1 || present[0]!.kind !== 'unknown' || absent.length !== 1) {
    emissionError(
      context,
      `external binding storage ${targetType} requires one unresolved optional value domain`,
      'cpp-external-binding-missing-optional-domain',
    );
  }
  context.includes.add('optional');
  return `std::optional<${targetType}>`;
}

// `Promise.resolve(value)` says nothing about the value beyond the promise it lands in, so where the
// position names the promise's value type the value adopts it. Without this the argument is typed by
// the members it happens to spell: `Promise.resolve({ reason: 'blocked-scheme' })` returned from a
// function declared `Promise<ShellExternalOutcome>` built a fresh one-member record and a task over
// that, which is a different task type from the one the declaration names.
function getCppResolvedPromiseArgumentExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  expectedType: Readonly<IrType> | undefined,
): Readonly<IrType> | undefined {
  if (index !== 0 || expression.arguments.length !== 1 || !expectedType) return undefined;
  if (expression.callee.kind !== 'property' || expression.callee.name !== 'resolve') return undefined;
  const receiver = expression.callee.object;
  if (receiver.kind !== 'identifier' || receiver.reference.kind !== 'ambient') return undefined;
  if (receiver.reference.name !== 'Promise') return undefined;
  return expectedType.kind === 'named' &&
    expectedType.reference.kind === 'ambient' &&
    expectedType.reference.name === 'Promise' &&
    expectedType.typeArguments.length === 1 &&
    expectedType.typeArguments[0]
    ? expectedType.typeArguments[0]
    : undefined;
}

function getIrCallArgumentExpectedTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
  representedTypeArguments?: readonly Readonly<IrType>[] | undefined,
): Readonly<IrType> | undefined {
  const externalParameterType = getCppExternalInstanceCallParameterExpectedTypeCpp(expression, index, context);
  if (externalParameterType) return externalParameterType;
  const resolvedPromiseArgument = getCppResolvedPromiseArgumentExpectedTypeCpp(expression, index, expectedType);
  if (resolvedPromiseArgument) return resolvedPromiseArgument;
  const collectionType = getCppCollectionCallArgumentExpectedTypeCpp(expression, index, context);
  if (collectionType) return collectionType;
  if (expression.callee.kind === 'property' && expression.callee.member) {
    const argument = expression.arguments[index];
    if (argument?.kind === 'function') {
      const callable = getIrExpressionTypeEvidenceCpp(argument, context);
      const contextualType = getIrInvocationArgumentExpectedTypeCpp(expression, index);
      const contextualCallable =
        (contextualType ? getCppClosedCallableType(contextualType, context, new Set()) : undefined) ??
        getCppTaskFulfillmentCallbackTypeCpp(expression, index, callable, context);
      // TypeScript callbacks may intentionally omit trailing arguments. Preserve every source-declared
      // parameter and its inferred type, then carry only the missing invocation ABI into the emitted
      // lambda so a C++ caller can still supply the values that the callback ignores.
      if (
        callable?.kind === 'function' &&
        contextualCallable &&
        callable.parameters.length < contextualCallable.parameters.length &&
        !callable.parameters.some((parameter) => parameter.rest) &&
        contextualCallable.parameters.slice(callable.parameters.length).every((parameter) => !parameter.rest)
      ) {
        return {
          ...callable,
          parameters: [...callable.parameters, ...contextualCallable.parameters.slice(callable.parameters.length)],
        };
      }
      if (callable) return callable;
    }
    const provided = getIrInvocationProvidedArgumentTypeCpp(expression, index);
    if (provided) return provided;
  }
  const semanticType = getIrInvocationArgumentExpectedTypeCpp(expression, index);
  if (expression.callee.kind === 'function') return expression.callee.parameters[index]?.type;
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') {
    if (semanticType) return semanticType;
    // Required parameters do not need optional/default invocation metadata, but a property whose
    // written type is a closed callable still supplies an exact ABI for each argument. Carry that
    // declaration evidence into contextual emission so a readonly structural view can recover its
    // own retained native reference at the call boundary. Unknown and open callables stay unset.
    const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
    const parameterType = calleeType
      ? getCppClosedCallableType(calleeType, context, new Set())?.parameters[index]?.type
      : undefined;
    if (!parameterType) return undefined;
    const argument = expression.arguments[index];
    const argumentType = argument ? getIrExpressionTypeEvidenceCpp(argument, context) : undefined;
    if (!argument || !argumentType) return parameterType;
    const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
    if (emitType(argumentType, isolatedContext) === emitType(parameterType, isolatedContext)) return undefined;
    const sourceRow = context.referenceRepresentationPlanner.resolveStructuralRow(argumentType, context.module);
    if (
      sourceRow &&
      hasFlightReferenceRepresentationCpp(parameterType, context) &&
      !emitCppStructuralReferenceValueConversionCpp('source', argumentType, parameterType, isolatedContext)
    ) {
      emissionError(
        context,
        'a structural row can recover only the exact concrete reference retained by its RowOf owner',
        'cpp-structural-row-nominal-recovery-unproven',
      );
    }
    return parameterType;
  }
  const declaration = getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context);
  const parameterType = semanticType ?? declaration?.parameters[index]?.type;
  if (!declaration || !parameterType || declaration.typeParameters.length === 0) return parameterType;
  // Semantic invocation evidence can retain the declaration's type parameter even though template
  // emission has already inferred its concrete argument. Apply that same complete substitution to
  // the parameter slot so contextual union construction does not compare a value against raw `N`.
  const typeArguments =
    representedTypeArguments ??
    (declaration.typeParameters.length === expression.typeArguments.length
      ? expression.typeArguments
      : getCppContextualCallTypeArgumentsCpp(expression, expectedType, context));
  return typeArguments?.length === declaration.typeParameters.length
    ? resolveIrTypeStructuralSubstitution(
        parameterType,
        createIrTypeParameterSubstitutionPlan(declaration.typeParameters, typeArguments),
      )
    : parameterType;
}

function getCppTaskFulfillmentCallbackTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  index: number,
  callable: Readonly<IrType> | undefined,
  context: EmitContext,
): Readonly<Extract<IrType, { kind: 'function' }>> | undefined {
  if (
    index !== 0 ||
    callable?.kind !== 'function' ||
    expression.callee.kind !== 'property' ||
    expression.callee.member?.receiver !== 'task' ||
    expression.callee.member.name !== 'then'
  ) {
    return undefined;
  }
  // Promise.then's resolved invocation metadata does not retain the first callback's optional
  // parameter type when the source lambda omits it. The receiver still carries the fulfillment
  // domain, which is the value Task<Value>::then passes to its callable.
  const receiver = getIrExpressionTypeEvidenceCpp(expression.callee.object, context);
  if (
    receiver?.kind !== 'named' ||
    receiver.reference.kind !== 'ambient' ||
    receiver.reference.name !== 'Promise' ||
    receiver.typeArguments.length !== 1
  ) {
    return undefined;
  }
  const fulfilled = receiver.typeArguments[0];
  if (!fulfilled || (fulfilled.kind === 'primitive' && fulfilled.name === 'void')) return undefined;
  return {
    ...callable,
    parameters: [{ name: 'value', optional: false, rest: false, type: fulfilled }],
  };
}

function getCppContextualArrayCallbackTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  expectedType: Readonly<IrType> | undefined,
  index: number,
  context: EmitContext,
): Readonly<Extract<IrType, { kind: 'function' }>> | undefined {
  if (index !== 0 || expression.callee.kind !== 'property' || expression.callee.member?.receiver !== 'array') {
    return undefined;
  }
  const callback = getIrExpressionTypeEvidenceCpp(expression.arguments[index]!, context);
  if (callback?.kind !== 'function') return undefined;
  const receiver = getIrArrayTypeCpp(
    getIrExpressionTypeEvidenceCpp(expression.callee.object, context),
    context,
    new Set(),
  );
  const first = callback.parameters[0];
  const refinedParameter =
    receiver && first ? getCppInvariantCollectionEvidenceRefinementCpp(first.type, receiver.element) : undefined;
  const callbackExpression = expression.arguments[index]!;
  if (
    callbackExpression.kind === 'function' &&
    callbackExpression.parameters[0] &&
    isCppObjectEntriesTupleArrayExpressionCpp(expression.callee.object, context)
  ) {
    context.objectEntriesTupleBindingIds.add(callbackExpression.parameters[0].binding.id);
  }
  const result =
    expression.callee.member.name === 'map' ? getIrArrayTypeCpp(expectedType, context, new Set()) : undefined;
  if (!refinedParameter && !result) return undefined;
  return {
    ...callback,
    parameters: refinedParameter
      ? [{ ...first!, type: refinedParameter }, ...callback.parameters.slice(1)]
      : callback.parameters,
    returns: result?.element ?? callback.returns,
  };
}

function isCppObjectEntriesTupleArrayExpressionCpp(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    return context.objectEntriesTupleArrayBindingIds.has(expression.reference.binding.id);
  }
  if (expression.kind !== 'call' || expression.callee.kind !== 'property') return false;
  if (isCppAmbientObjectMemberCallCpp(expression, 'entries')) return true;
  return (
    expression.callee.member?.receiver === 'array' &&
    expression.callee.member.name === 'filter' &&
    isCppObjectEntriesTupleArrayExpressionCpp(expression.callee.object, context)
  );
}

function isCppObjectEntriesTupleStorageExpressionCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): boolean {
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    context.objectEntriesTupleBindingIds.has(expression.reference.binding.id)
  );
}

function getCppObjectEntriesTupleElementTypeCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
  const tuple = objectType ? getIrTupleTypeCpp(objectType, context, new Set()) : undefined;
  const index =
    expression.index.kind === 'literal' && typeof expression.index.value === 'number'
      ? expression.index.value
      : undefined;
  return index === undefined ? undefined : tuple?.elements[index]?.type;
}

function refineCppObjectEntriesDestructuringBindingsCpp(
  statements: readonly Readonly<IrStatement>[],
  context: EmitContext,
): void {
  // Binding-pattern lowering runs before callback context is recovered. Once an Object.entries
  // callback regains its exact tuple parameter, carry that evidence through the compiler-owned
  // temporary and into the hoisted leaf bindings before any declaration chooses C++ storage.
  for (const statement of statements) {
    if (statement.kind === 'variable') {
      for (const variable of statement.declarations) {
        if ('pattern' in variable || !variable.initializer) continue;
        if (!isCppObjectEntriesTupleStorageExpressionCpp(variable.initializer, context)) continue;
        const initializerType = getIrExpressionTypeEvidenceCpp(variable.initializer, context);
        if (!initializerType || !variable.type) continue;
        const refined = getCppInvariantCollectionEvidenceRefinementCpp(variable.type, initializerType);
        context.preservedInitializerTypes.set(variable.binding.id, refined ?? initializerType);
        context.objectEntriesTupleBindingIds.add(variable.binding.id);
      }
      continue;
    }
    if (
      statement.kind === 'expression' &&
      statement.expression.kind === 'assignment' &&
      statement.expression.operator === '=' &&
      statement.expression.left.kind === 'identifier' &&
      statement.expression.left.reference.kind === 'binding' &&
      statement.expression.right.kind === 'element' &&
      isCppObjectEntriesTupleStorageExpressionCpp(statement.expression.right.object, context)
    ) {
      const type = getCppObjectEntriesTupleElementTypeCpp(statement.expression.right, context);
      if (type) {
        context.contextualBindingStorageTargetTypes.set(statement.expression.left.reference.binding.id, type);
      }
      continue;
    }
    if (statement.kind === 'block') {
      refineCppObjectEntriesDestructuringBindingsCpp(statement.statements, context);
    }
  }
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
  const weakSet = getIrWeakSetTypeCpp(objectType, context, new Set());
  if (weakSet && weakSet.typeArguments.length === 1 && index === 0 && ['add', 'delete', 'has'].includes(name)) {
    return weakSet.typeArguments[0];
  }
  const array = getIrArrayTypeCpp(objectType, context, new Set());
  if (array && member?.receiver === 'array' && name === 'push') return array.element;
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

// A collection method whose element/key/value domain excludes absence cannot receive the optional
// carrier used by a lookup such as Array.pop. Crossing that boundary is valid only after source
// control flow proves the lookup present, and only while the carrier has one remaining runtime value
// domain. Otherwise passing the identifier through produces a call such as
// `set.delete_(std::optional<Ref<T>>)` that cannot preserve the source operation and does not compile.
function assertCppPresentOptionalCollectionArgumentCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  argument: Readonly<IrExpression>,
  index: number,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
): void {
  const collectionType = getCppCollectionCallArgumentExpectedTypeCpp(expression, index, context);
  const expectedUnion = expectedType ? getIrUnionTypeCpp(expectedType, context, new Set()) : undefined;
  if (
    !collectionType ||
    !expectedType ||
    (expectedUnion
      ? expectedUnion.types.some((member) => member.kind === 'null' || member.kind === 'undefined')
      : hasIrTypeAbsentMember(expectedType)) ||
    argument.kind !== 'identifier' ||
    argument.reference.kind !== 'binding' ||
    !hasCppAbsenceStorageCpp(argument, context)
  ) {
    return;
  }
  if (argument.presence !== 'narrowedPresent' && !context.narrowedBindingTypes.has(argument.reference.binding.id)) {
    emissionError(
      context,
      `collection member ${expression.callee.kind === 'property' ? expression.callee.name : 'call'} argument from optional C++ storage requires proven present payload`,
      'cpp-collection-argument-without-present-storage',
    );
  }
  const storageType = getCppBindingTypeCpp(argument.reference.binding.id, context);
  const union = storageType ? getIrUnionTypeCpp(storageType, context, new Set()) : undefined;
  if (
    !storageType ||
    storageType.kind === 'unknown' ||
    (union && getCppUnionRepresentationPlan(union, context).valueSlots.length !== 1)
  ) {
    emissionError(
      context,
      `collection member ${expression.callee.kind === 'property' ? expression.callee.name : 'call'} argument from optional C++ storage requires one present value domain`,
      'cpp-collection-argument-multiple-present-domains',
    );
  }
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
  if (!plan) {
    const calleeType = getIrExpressionTypeEvidenceCpp(expression.callee, context);
    const callable = calleeType ? getCppClosedCallableType(calleeType, context, new Set()) : undefined;
    if (!callable || emitted.length >= callable.parameters.length) return emitted;
    const omitted = callable.parameters.slice(emitted.length);
    if (!omitted.every((parameter) => parameter.optional)) return emitted;
    context.includes.add('optional');
    return [...emitted, ...omitted.map(() => 'std::nullopt')];
  }
  if (emitted.length >= plan.parameterCount) return emitted;
  if (expression.callee.kind === 'property') {
    const receiverType = getIrExpressionTypeEvidenceCpp(expression.callee.object, context);
    const structuralReceiver = receiverType
      ? context.referenceRepresentationPlanner.resolveStructuralRow(receiverType, context.module)
      : undefined;
    const standardRuntimeReceiver =
      expression.callee.member !== undefined ||
      getIrArrayTypeCpp(receiverType, context, new Set()) !== undefined ||
      (receiverType !== undefined && isCppStringValueTypeCpp(receiverType, context, new Set())) ||
      (receiverType?.kind === 'named' && receiverType.reference.kind === 'ambient' && !structuralReceiver);
    if (standardRuntimeReceiver) return emitted;
  }
  const declaration =
    expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
      ? getCppFunctionDeclarationForBindingCpp(expression.callee.reference.binding.id, context)
      : undefined;
  // A function-valued variable has no function declaration whose C++ defaults a call can inherit.
  // Its storage is std::function, so source defaults are optional ABI parameters and an omitted one
  // must be supplied explicitly just like an omitted optional callback parameter.
  const callableVariable =
    !declaration &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding' &&
    expression.callee.reference.binding.kind === 'variable'
      ? getCppClosedCallableType(
          getIrExpressionTypeEvidenceCpp(expression.callee, context) ?? { kind: 'unknown', source: 'unknown' },
          context,
          new Set(),
        )
      : undefined;
  if (!declaration && !callableVariable && !optionals) return emitted;
  if (plan.providedArgumentCount === 'dynamic') {
    emissionError(context, 'spread calls into optional or default parameters require ABI expansion lowering');
  }
  const omitted = new Set([
    ...(declaration || callableVariable ? (defaults?.omitted ?? []) : []),
    ...(optionals?.omitted ?? []),
  ]);
  const result = [...emitted];
  for (let index = emitted.length; index < plan.parameterCount; index += 1) {
    if (!omitted.has(index))
      emissionError(
        context,
        `missing required call argument at position ${String(index)}`,
        'cpp-call-argument-missing',
      );
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
  const optionalParameters = expression.semantics.optionalParameters;
  const provided = [
    ...(expression.semantics.defaultParameters?.provided ?? []),
    ...(optionalParameters?.provided ?? []),
  ].find((argument) => argument.position === index);
  const parameterType = provided?.parameterType;
  const argument = expression.arguments[index];
  const argumentType = provided?.argumentType;
  const argumentIsClosedPresentScalar =
    argumentType?.kind === 'literal' ||
    (argumentType?.kind === 'primitive' && argumentType.name !== 'bigint' && argumentType.name !== 'void');
  if (
    !parameterType ||
    !optionalParameters?.optional.includes(index) ||
    argument?.kind !== 'conditional' ||
    argumentIsClosedPresentScalar
  ) {
    return parameterType;
  }
  // The semantic invocation records an optional parameter's declared value type separately from its
  // optional bit. C++ can implicitly lift an ordinary supplied value into that parameter's
  // std::optional. A conditional needs an explicit common carrier only when its type evidence does
  // not prove one closed, present scalar domain; otherwise adding absence invents a source branch
  // and can box the value into an ABI the resolved call does not accept. Keep unknown, structural,
  // collection, open-generic, and absent-bearing conditionals on the checked union path.
  return createIrTypeEvidenceUnionCpp([parameterType, { kind: 'undefined' }]);
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
  // A declared member remains knowable when an imported base is not: resolving the member through the
  // declaration location keeps that one fact without publishing an incomplete whole-object shape to
  // callers which require every inherited field. This is deliberately property-specific; inherited
  // members still require the complete shape above.
  const ownProperty = context.referenceRepresentationPlanner.resolveOwnObjectProperty(
    type,
    propertyName,
    context.module,
  );
  if (ownProperty) return getIrObjectPropertyReadTypeCpp(ownProperty);
  // `length` is the one member every array and string has, and it is a number however the element or
  // character type varies -- so the answer is a property of the BASE, which is already resolved here,
  // rather than a selection among alternatives. That is the whole reason it can be answered where an
  // unresolved member cannot: there is nothing to choose and nothing to look up. A base that is
  // neither (an erased value, a type parameter, an unresolved reference) falls through unchanged.
  if (propertyName === 'length' && (type.kind === 'array' || (type.kind === 'primitive' && type.name === 'string'))) {
    return { kind: 'primitive', name: 'number' };
  }
  // A typed array is the same fact reached through a representation instead of a syntax: its `length`
  // is its element count, a number, whatever the element width is. The category is asked of the
  // representation planner because the planner is what decides that a type IS a typed array -- a name
  // list here would be a second owner of that answer, and it would have to be kept in step with the one
  // that decides the C++ spelling.
  if (propertyName === 'length' && type.kind === 'named') {
    const lengthPlan = context.referenceRepresentationPlanner.plan(type, context.module);
    if (lengthPlan.kind === 'represented' && lengthPlan.category === 'typedArray') {
      return { kind: 'primitive', name: 'number' };
    }
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

function getCppStructuralRowComputedPropertyCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): Readonly<IrObjectTypeProperty> | undefined {
  if (expression.semantics.key !== 'symbol') return undefined;
  const key = getIrExpressionValueNameReferenceCpp(expression.index);
  const row = getCppStructuralRowExpressionPlanCpp(expression.object, context);
  const objectType = row ? getCppStructuralRowObjectTypeCpp(row) : undefined;
  if (!key || !objectType) return undefined;
  const typeParameterConstraint = getCppTypeParameterDeclarationCpp(objectType, context)?.constraint;
  const properties =
    context.referenceRepresentationPlanner.resolveObjectShape(objectType, context.module) ??
    (typeParameterConstraint
      ? context.referenceRepresentationPlanner.resolveObjectShape(typeParameterConstraint, context.module)
      : undefined);
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

// An arm of a union, and the module that declares it.
type CppUnionArmIdentity = Readonly<{ arm: Readonly<IrType>; owner: Readonly<IrModule> }>;

// The declaration a type member names, resolved to the declaration itself rather than to the spelling
// this module reached it by.
//
// A member written in the module that declares the type it names is a local binding; the same member
// reached from anywhere else is an IMPORT of it, and the two carry different binding identities -- the
// import records this module and the specifier it used, not the declaration. Resolving the import
// through the module graph is what makes the two spellings one identity, and it follows barrels and
// type-only forwards because that is how a type is published: `export * from './Collision.js'` and
// `export type X = …` both hand out a declaration the barrel does not itself contain.
//
// A name that resolves to no declaration, or to more than one, has no identity to compare and returns
// undefined. That is the conservative answer everywhere it is used: an unresolved member never matches,
// so the emission it would have changed is left exactly as it is.
function getCppMemberDeclarationKeyCpp(
  member: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
): string | undefined {
  if (member.kind !== 'named' || member.reference.kind !== 'binding') return undefined;
  const binding = member.reference.binding;
  if (binding.kind !== 'import') return `${binding.packageName}\0${binding.source}\0${binding.name}`;
  const importItem = module.imports.find((candidate) =>
    candidate.bindings.some((candidateBinding) => candidateBinding.binding.id === binding.id),
  );
  const importedBinding = importItem?.bindings.find((candidate) => candidate.binding.id === binding.id);
  if (!importItem || !importedBinding || importedBinding.imported === '*') return undefined;
  const moduleContext: EmitContext = module === context.module ? context : { ...context, module };
  const owners = getCppResolvedImportModules(importItem.specifier, moduleContext).flatMap((targetModule) =>
    getCppExportedTypeDeclarationOwnersCpp(targetModule, importedBinding.imported, context, new Set()),
  );
  if (owners.length !== 1) return undefined;
  const declaration = owners[0]!.declaration.binding;
  return `${declaration.packageName}\0${declaration.source}\0${declaration.name}`;
}

// The identity an arm holds, which is what makes the same arm written in two modules one arm.
//
// An arm the provider's union storage holds is an anonymous record beside a nominal member, so its
// identity is two things: which declaration that member names, and what the rest of the arm is made of.
// Both are module-independent -- the declaration is the declaration however this module reached it, and
// the remaining members are compared by their canonical form, which for the anonymous records this rule
// is about is the same wherever it is written.
//
// The shape is required rather than searched for: one nominal member and at least one other. An arm that
// is not that shape is not what this rule recognizes, and a remaining member that is itself a reference
// can only be compared by a nested resolution this does not attempt -- so it simply fails to match, and
// the local emission stands.
function getCppUnionArmIdentityKeyCpp(
  arm: Readonly<IrType>,
  module: Readonly<IrModule>,
  context: EmitContext,
): string | undefined {
  if (arm.kind !== 'intersection') return undefined;
  const declared = arm.types.filter((member) => member.kind === 'named');
  if (declared.length !== 1) return undefined;
  const key = getCppMemberDeclarationKeyCpp(declared[0]!, module, context);
  if (!key) return undefined;
  const remaining = arm.types.filter((member) => member !== declared[0]);
  if (remaining.length === 0) return undefined;
  if (remaining.some((member) => member.kind === 'named')) return undefined;
  return `${key}\0${remaining.map((member) => normalizeCompilerStructuralValueCanonical(member)).join('\x01')}`;
}

// Records every union arm in the emission under the identity it holds. Called once, from the first
// module emitted, because the index is about the program and not about the module that happens to be
// emitting when it is first needed.
function populateCppUnionArmIdentitiesCpp(identities: Map<string, CppUnionArmIdentity[]>, context: EmitContext): void {
  if (identities.size > 0) return;
  for (const module of context.sourceModules) {
    const moduleContext: EmitContext =
      getCppModuleIdentityKey(module) === getCppModuleIdentityKey(context.module) ? context : { ...context, module };
    for (const declaration of module.declarations) {
      if (declaration.kind !== 'typeAlias' || !declaration.exported || declaration.type.kind !== 'union') {
        continue;
      }
      for (const arm of declaration.type.types) {
        const key = getCppUnionArmIdentityKeyCpp(arm, module, moduleContext);
        if (!key) continue;
        const existing = identities.get(key);
        if (existing) existing.push({ arm, owner: module });
        else identities.set(key, [{ arm, owner: module }]);
      }
    }
  }
}

function getCppImportedBindingTypeCpp(bindingId: string, context: EmitContext): Readonly<IrType> | undefined {
  const cached = context.importedBindingTypes.get(bindingId);
  if (cached !== undefined) return cached ?? undefined;
  const importItem = context.module.imports.find((candidate) =>
    candidate.bindings.some((binding) => binding.binding.id === bindingId),
  );
  const importedBinding = importItem?.bindings.find((binding) => binding.binding.id === bindingId);
  const foreignOwner = context.importBindingOwners.get(bindingId);
  const ownerModule = importItem && importedBinding ? context.module : foreignOwner?.module;
  const specifier = importItem && importedBinding ? importItem.specifier : foreignOwner?.specifier;
  const imported = importItem && importedBinding ? importedBinding.imported : foreignOwner?.imported;
  if (!ownerModule || !specifier || !imported || imported === '*') {
    context.importedBindingTypes.set(bindingId, null);
    return undefined;
  }
  const ownerContext = ownerModule === context.module ? context : { ...context, module: ownerModule };
  const candidates = getCppResolvedImportModules(specifier, ownerContext).flatMap((targetModule) =>
    getCppExportedBindingTypesCpp(targetModule, imported, context, new Set()),
  );
  const canonical = new Map(
    candidates.map((candidate) => [normalizeCompilerStructuralValueCanonical(candidate), candidate]),
  );
  const resolved = canonical.size === 1 ? [...canonical.values()][0]! : null;
  context.importedBindingTypes.set(bindingId, resolved);
  return resolved ?? undefined;
}

function getCppExportedBindingTypesCpp(
  module: Readonly<IrModule>,
  exportedName: string,
  context: EmitContext,
  visited: ReadonlySet<string>,
): readonly Readonly<IrType>[] {
  // A type query retains a value binding, while the consumer may see that value through any number
  // of named or star reexports. Follow the recorded export graph to the declaration that owns the
  // binding type; the exported spelling alone is never type evidence.
  const key = `${getCppModuleIdentityKey(module)}\0${exportedName}`;
  if (visited.has(key)) return [];
  const nextVisited = new Set(visited).add(key);
  const bindingIds = new Set([
    ...module.declarations.flatMap((declaration) =>
      'binding' in declaration && declaration.exported && declaration.binding.name === exportedName
        ? [declaration.binding.id]
        : [],
    ),
    ...module.exports.flatMap((exported) =>
      exported.kind === 'local' && !exported.typeOnly && exported.exported === exportedName
        ? [exported.binding.id]
        : [],
    ),
  ]);
  const bindingTypes = collectIrModuleBindingTypesCpp(module);
  const direct = [...bindingIds].flatMap((bindingId) => {
    const type = bindingTypes.get(bindingId);
    return type ? [type] : [];
  });
  const forwarded = module.exports.flatMap((exported): readonly Readonly<IrType>[] => {
    if ('typeOnly' in exported && exported.typeOnly) return [];
    const importedName =
      exported.kind === 'all'
        ? exportedName
        : exported.kind === 'reexport' && exported.exported === exportedName
          ? exported.imported
          : undefined;
    if (!importedName || (exported.kind !== 'all' && exported.kind !== 'reexport')) return [];
    const moduleContext = module === context.module ? context : { ...context, module };
    return getCppResolvedImportModules(exported.specifier, moduleContext).flatMap((targetModule) =>
      getCppExportedBindingTypesCpp(targetModule, importedName, context, nextVisited),
    );
  });
  return [...direct, ...forwarded];
}

function getIrNewExpressionTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  context: EmitContext,
  contextualType?: Readonly<IrType>,
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
  const contextualTypeArguments = getCppContextualAmbientConstructorTypeArgumentsCpp(name, contextualType);
  if (contextualTypeArguments.length > 0) {
    return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments: contextualTypeArguments };
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
        getIrNullishCoalesceTypeEvidenceCpp(expression, context) ??
        getIrOperatorValueDomainTypeCpp(expression.semantics.result)
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
      if (getCppExternalNumericPropertyViewAccessPlanCpp(expression, context)) {
        return getCppExternalNumericPropertyViewTypeCpp();
      }
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
      if (getCppExternalNumericPropertyViewAccessPlanCpp(expression, context)) {
        return getCppExternalNumericPropertyViewTypeCpp();
      }
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

// An unconstrained position is a value, not an erased object pointer. A Flight reference therefore
// enters it through the runtime's object alternative, which retains both the shared identity and the
// concrete referent type. Structural rows are deliberately excluded: `Any` has no row alternative,
// and boxing the projection handle would not store the concrete Flight reference its schema describes.
function emitCppContextualErasedDynamicValueCpp(
  expression: Readonly<IrExpression>,
  target: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp' || !isCppErasedDynamicValueTypeCpp(target)) {
    return undefined;
  }
  const source = getIrExpressionTypeEvidenceCpp(expression, context);
  if (!source || isCppErasedDynamicValueTypeCpp(source)) return undefined;
  if (context.referenceRepresentationPlanner.resolveStructuralRow(source, context.module)) {
    emissionError(
      context,
      'a structural row has no erased dynamic value because its projected schema is not one concrete Flight reference type',
      'cpp-erased-structural-row-construction-unrepresented',
    );
  }
  if (!hasFlightReferenceRepresentationCpp(source, context)) return undefined;
  context.includes.add('flight/any.hpp');
  return `flight::Any::object(${emitExpression(expression, context, source)})`;
}

// A readonly structural sequence parameter is an owner-preserving view: it can accept any compatible
// row without pretending that the rows have one nominal element type. Writing that view into an owning
// array of one nominal reference would need either a clone (which loses the source array's identity) or
// an unchecked nominal recovery. Neither is the assignment TypeScript wrote, so stop before row_set's
// constructibility assertion has to diagnose the representation mismatch in generated C++.
function refuseCppContextualStructuralArrayNominalRecoveryCpp(
  expression: Readonly<IrExpression>,
  target: Readonly<IrType>,
  context: EmitContext,
): void {
  if (expression.kind === 'array') return;
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    context.contextualBindingStorageTargetTypes.has(expression.reference.binding.id)
  ) {
    return;
  }
  const source = getIrExpressionTypeEvidenceCpp(expression, context);
  const sourceArray = getIrArrayTypeCpp(source, context, new Set());
  const targetArray = getIrArrayTypeCpp(target, context, new Set());
  if (!sourceArray?.readonly || !targetArray || !hasFlightReferenceRepresentationCpp(targetArray.element, context)) {
    return;
  }
  const sourceRow = context.referenceRepresentationPlanner.resolveStructuralRow(sourceArray.element, context.module);
  if (!sourceRow) return;
  const sourceShape = context.referenceRepresentationPlanner.resolveObjectShape(sourceArray.element, context.module);
  const targetShape = context.referenceRepresentationPlanner.resolveObjectShape(targetArray.element, context.module);
  if (!sourceShape || !targetShape || !areCppObjectShapesRepresentationEquivalent(sourceShape, targetShape, context)) {
    return;
  }
  emissionError(
    context,
    'a readonly structural sequence cannot be stored as an owning array of nominal references without cloning its array identity or assuming an unproven referent type',
    'cpp-contextual-structural-array-nominal-recovery-unproven',
  );
}

// `source as string` on a position TypeScript states as unconstrained is an assertion about a value
// the source cannot check. Once that position holds the erased dynamic value, no `static_cast` reaches
// its alternative — the erased value has no conversion operator — so the assertion becomes the runtime's
// own checked extraction, which is the closest faithful spelling of what the source wrote: it yields the
// alternative, and it throws rather than inventing one when the value is something else. Only the
// primitives are reached this way; an erased value asserted to an object reference is a different
// question and keeps its refusal.
function getCppErasedValueAssertionCpp(
  target: Readonly<IrType>,
  source: Readonly<IrType> | undefined,
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  if (!isCppErasedDynamicValueTypeCpp(source)) return undefined;
  const extractions: Readonly<Record<string, string>> = {
    boolean: 'as_boolean',
    number: 'as_number',
    string: 'as_string',
    symbol: 'as_symbol',
  };
  if (target.kind !== 'primitive') return undefined;
  const extraction = extractions[target.name];
  if (!extraction) return undefined;
  context.includes.add('flight/any.hpp');
  return `${emitExpression(expression, context)}.${extraction}()`;
}

// Exactly the positions `emitType` routes to `flight::Any`: an unconstrained type that is neither the
// dynamic `this` nor an erased object reference, which have their own representations.
function isCppErasedDynamicValueTypeCpp(type: Readonly<IrType> | undefined): boolean {
  return type?.kind === 'unknown' && type.source !== 'this' && type.source !== 'object';
}

function getIrFunctionDeclarationTypeCpp(
  declaration: Readonly<IrFunctionDeclaration>,
): Readonly<Extract<IrType, { kind: 'function' }>> {
  return {
    kind: 'function',
    parameters: declaration.parameters.map((parameter) => {
      const common = { name: parameter.binding.name, type: parameter.type };
      if (parameter.optional) return { ...common, optional: true, rest: false } as const;
      if (parameter.rest) return { ...common, optional: false, rest: true } as const;
      return { ...common, optional: false, rest: false } as const;
    }),
    returns: declaration.returns,
    typeParameters: declaration.typeParameters,
  };
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
  if (expression.presence !== 'narrowedPresent' && !union && context.nullableBindingIds.has(bindingId)) {
    return { kind: 'union', types: [declaredType, { kind: 'undefined' }] };
  }
  if (!expression.narrowedMember) return declaredType;
  return union?.types.find((member) => getIrUnionMemberNameCpp(member) === expression.narrowedMember) ?? declaredType;
}

function getIrPropertyExpressionTypeEvidenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const recordedType = expression.type?.kind === 'unknown' ? undefined : expression.type;
  const reconstructedType = expression.optional
    ? getIrOptionalChainValueTypeEvidenceCpp(expression, context)
    : (() => {
        const objectType = getIrExpressionTypeEvidenceCpp(expression.object, context);
        return objectType ? getIrObjectPropertyTypeCpp(objectType, expression.name, context) : undefined;
      })();
  // A literal recorded for a const-object member is a closed runtime domain even when the object is
  // imported through a barrel and its namespace-shaped receiver cannot be reconstructed here. A
  // member selected through a property-derived local alias is equally exact: the alias provenance
  // proves which source object supplied the field. Other recorded results still require the receiver
  // path above; accepting them would let unavailable inheritance or narrowed unions escape emission.
  const recordedLiteralType = recordedType?.kind === 'literal' ? recordedType : undefined;
  const receiverInitializer =
    expression.object.kind === 'identifier' && expression.object.reference.kind === 'binding'
      ? context.bindingInitializers.get(expression.object.reference.binding.id)
      : undefined;
  const recordedAliasedMemberType = receiverInitializer?.kind === 'property' ? recordedType : undefined;
  const valueType = reconstructedType ?? recordedLiteralType ?? recordedAliasedMemberType;
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
  if (type.kind === 'object') {
    // A finite mapped object is materialized as an object type before its initializer is emitted. Its
    // optional bit is part of every indexed read, so recover the read type from exactly the members the
    // checker-recorded key set can select rather than treating the materialized storage as an open index.
    const keys = getCppClosedElementKeyNamesCpp(expression, context);
    if (!keys) return undefined;
    const members = keys.map((key) =>
      getIrObjectPropertyReadTypeCpp(type.properties.find((property) => property.name === key)),
    );
    return members.every((member): member is Readonly<IrType> => member !== undefined)
      ? createIrTypeEvidenceUnionCpp(members)
      : undefined;
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
    if (type.reference.name === 'Partial' && type.typeArguments.length === 1 && type.typeArguments[0]) {
      // Partial contributes undefined only after the underlying indexed read has been proved. An open or
      // unresolved operand still returns no evidence; the contextual target cannot manufacture its value.
      const element = getIrIndexedElementTypeCpp(type.typeArguments[0], expression, context, resolvingAliases);
      return element ? createIrTypeEvidenceUnionCpp([element, { kind: 'undefined' }]) : undefined;
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
  // A declared object indexed by a FINITE set of string keys is the closed-key selection this emitter already
  // lowers, so the element type is the union of the members those keys name. This sits after the ambient
  // shapes, which are all answered above, so it runs only for a declared type and only where the alias path
  // below would otherwise answer nothing. Without it the element's source is unknown and everything keyed on
  // it goes without: a call argument with no evidence cannot have the callee's type parameters deduced, so no
  // explicit template arguments are stamped and the call leans on deduction that `flight::Ref`, a
  // `std::conditional_t` alias and therefore a non-deduced context, can never satisfy. An open, computed, or
  // absent key names no finite set and still reaches the refusal below.
  const closedElementKeys = getCppClosedElementKeyNamesCpp(expression, context);
  const closedElementShape = closedElementKeys
    ? context.referenceRepresentationPlanner.resolveObjectShape(type, context.module)
    : undefined;
  if (closedElementKeys && closedElementShape) {
    const closedMembers = closedElementKeys.map(
      (key) => closedElementShape.find((property) => property.name === key)?.type,
    );
    if (closedMembers.every((member): member is Readonly<IrType> => member !== undefined)) {
      return createIrTypeEvidenceUnionCpp(closedMembers);
    }
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

function collectCppMutuallyRecursiveFunctionGroups(
  module: Readonly<IrModule>,
  dependencies: ReadonlyMap<Readonly<IrDeclaration>, ReadonlySet<Readonly<IrDeclaration>>>,
): readonly Readonly<CppMutuallyRecursiveFunctionGroup>[] {
  const functions = module.declarations.filter(
    (declaration): declaration is IrFunctionDeclaration =>
      declaration.kind === 'function' && !declaration.namespaceMember,
  );
  const functionSet = new Set<Readonly<IrFunctionDeclaration>>(functions);
  const functionOrder = new Map(functions.map((declaration, index) => [declaration, index] as const));
  const indices = new Map<Readonly<IrFunctionDeclaration>, number>();
  const lowLinks = new Map<Readonly<IrFunctionDeclaration>, number>();
  const stack: Readonly<IrFunctionDeclaration>[] = [];
  const onStack = new Set<Readonly<IrFunctionDeclaration>>();
  const groups: CppMutuallyRecursiveFunctionGroup[] = [];
  let nextIndex = 0;
  const visit = (declaration: Readonly<IrFunctionDeclaration>): void => {
    const index = nextIndex++;
    indices.set(declaration, index);
    lowLinks.set(declaration, index);
    stack.push(declaration);
    onStack.add(declaration);
    for (const dependency of dependencies.get(declaration) ?? []) {
      if (dependency.kind !== 'function' || !functionSet.has(dependency)) continue;
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(declaration, Math.min(lowLinks.get(declaration)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(declaration, Math.min(lowLinks.get(declaration)!, indices.get(dependency)!));
      }
    }
    if (lowLinks.get(declaration) !== indices.get(declaration)) return;
    const component: Readonly<IrFunctionDeclaration>[] = [];
    let member: Readonly<IrFunctionDeclaration>;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== declaration);
    if (component.length > 1) {
      groups.push({
        declarations: component.sort((left, right) => functionOrder.get(left)! - functionOrder.get(right)!),
      });
    }
  };
  for (const declaration of functions) {
    if (!indices.has(declaration)) visit(declaration);
  }
  return groups.sort(
    (left, right) => functionOrder.get(left.declarations[0]!)! - functionOrder.get(right.declarations[0]!)!,
  );
}

function collectCppRecursiveTypeAliasBindingIds(
  module: Readonly<IrModule>,
  dependencies: ReadonlyMap<Readonly<IrDeclaration>, ReadonlySet<Readonly<IrDeclaration>>>,
): ReadonlySet<string> {
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
  mutuallyRecursiveFunctionGroups: readonly Readonly<CppMutuallyRecursiveFunctionGroup>[],
  dependencies: ReadonlyMap<Readonly<IrDeclaration>, ReadonlySet<Readonly<IrDeclaration>>>,
): readonly Readonly<IrDeclaration>[] {
  // Source order is the module-evaluation order for variables, classes, enums, and side-effect
  // carriers. Move a later declaration only when an earlier declaration actually depends on it.
  const ranked = [...module.declarations];
  const recursiveGroupByDeclaration = new Map<Readonly<IrDeclaration>, CppMutuallyRecursiveFunctionGroup>();
  for (const group of mutuallyRecursiveFunctionGroups) {
    for (const declaration of group.declarations) recursiveGroupByDeclaration.set(declaration, group);
  }

  const pending = new Set(ranked);
  const ordered: Readonly<IrDeclaration>[] = [];
  while (pending.size > 0) {
    const isReady = (declaration: Readonly<IrDeclaration>): boolean => {
      const group = recursiveGroupByDeclaration.get(declaration);
      const groupDeclarations = new Set<Readonly<IrDeclaration>>(group?.declarations ?? [declaration]);
      return [...groupDeclarations].every((member) =>
        [...(dependencies.get(member) ?? [])].every(
          (dependency) => groupDeclarations.has(dependency) || !pending.has(dependency),
        ),
      );
    };
    const next =
      ranked.find((declaration) => pending.has(declaration) && isReady(declaration)) ??
      ranked.find(
        (declaration) =>
          pending.has(declaration) &&
          declaration.kind === 'typeAlias' &&
          recursiveTypeAliasBindingIds.has(declaration.binding.id),
      ) ??
      ranked.find((declaration) => pending.has(declaration));
    if (!next) break;
    const group = recursiveGroupByDeclaration.get(next);
    // Definitions in one strongly connected component stay adjacent, with their shared prototype
    // block immediately before them. Waiting for every outside dependency keeps those signatures
    // from naming a type or value that has not been introduced yet.
    const scheduled = group
      ? ranked.filter(
          (declaration) => pending.has(declaration) && recursiveGroupByDeclaration.get(declaration) === group,
        )
      : [next];
    for (const declaration of scheduled) {
      pending.delete(declaration);
      ordered.push(declaration);
    }
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

// A bare `object` parameter has two possible C++ jobs. Most such parameters are opaque identities:
// they key a WeakMap or open a symbol-keyed Record view, and `Ref<void>` is the runtime ABI for both.
// A parameter copied into an erased object slot is different, because a later checked assertion must
// recover the concrete reference type captured at that boundary. Find those direct storage crossings
// before declarations are emitted so only they use `ErasedRef`.
function collectCppErasedObjectParameterBindingIds(
  module: Readonly<IrModule>,
  context: EmitContext,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'function') continue;
    const parameters = new Set(
      declaration.parameters
        .filter((parameter) => isCppBareObjectTypeCpp(parameter.type))
        .map((parameter) => parameter.binding.id),
    );
    if (parameters.size === 0) continue;
    for (const statement of declaration.body) {
      analyzeIrStatementSubtreeTraversal(statement, {
        expression(expression) {
          // A nested closure owns its own parameters and returns. Its body cannot decide the ABI of
          // this declaration merely because it captures a same-named outer value.
          if (expression.kind === 'function') return false;
          if (
            expression.kind === 'assignment' &&
            expression.operator === '=' &&
            expression.right.kind === 'identifier' &&
            expression.right.reference.kind === 'binding' &&
            parameters.has(expression.right.reference.binding.id)
          ) {
            // Imported nested fields can carry checker-owned property evidence even when resolving
            // the receiver shape through a computed symbol is intentionally conservative. The
            // declared property type is the storage contract for this assignment.
            const targetType =
              expression.left.kind === 'property'
                ? (expression.left.type ?? getIrAssignmentTargetTypeCpp(expression.left, context))
                : getIrAssignmentTargetTypeCpp(expression.left, context);
            if (targetType && isCppTypePreservingErasedObjectStorageCpp(targetType, context)) {
              result.add(expression.right.reference.binding.id);
            }
          }
          return undefined;
        },
        statement(candidate) {
          if (
            candidate.kind === 'return' &&
            candidate.expression?.kind === 'identifier' &&
            candidate.expression.reference.kind === 'binding' &&
            parameters.has(candidate.expression.reference.binding.id) &&
            isCppTypePreservingErasedObjectStorageCpp(declaration.returns, context)
          ) {
            result.add(candidate.expression.reference.binding.id);
          }
        },
      });
    }
  }
  return result;
}

function isCppBareObjectTypeCpp(type: Readonly<IrType>): boolean {
  return type.kind === 'unknown' && type.source === 'object';
}

function isCppTypePreservingErasedObjectStorageCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const union = getIrUnionTypeCpp(type, context, new Set());
  if (!union) return isCppBareObjectTypeCpp(type);
  const plan = getCppUnionRepresentationPlan(union, context);
  return plan.valueSlots.some((slot) => slot.targetType === 'flight::ErasedRef');
}

function collectIrModuleArrayElementBindingIdsCpp(
  module: Readonly<IrModule>,
  context: EmitContext,
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
      // An element read holds absence when the read the emitter will spell answers an optional. For an
      // array that is the runtime's indexed access; for a `Record` it is `get`, which answers
      // `std::optional`. The receiver the semantic layer records for a `Record` reads `unknown`, and
      // correctly so -- a mapped `Record` type is not an array -- so the decision is taken here, from
      // the representation the element emitter will use, rather than from a receiver's name. Absence
      // storage is the backend's own decision about its own output; the layer above reports what the
      // source is, not how it is stored.
      const carriesAbsence =
        initializer.semantics.receivers.includes('array') ||
        Boolean(
          getCppRecordTypeArgumentsCpp(getIrExpressionTypeEvidenceCpp(initializer.object, context), context, new Set()),
        );
      if (!carriesAbsence) return;
      candidates.add(variable.binding.id);
    },
  });
  const result = new Set<string>();
  for (const id of candidates) {
    if (nullishUsed.has(id)) result.add(id);
  }
  return result;
}

// A sized JavaScript Array begins sparse, while flight::Array is dense. One sound bridge is an
// immediate sequential initializer: construct first so the length expression and RangeError occur in
// source order, clear the unobservable holes, then append the values that the source writes at the
// current length. This also preserves a final partial stride -- `i += 2` followed by writes at `i` and
// `i + 1` grows an odd-sized JavaScript array by one, which a fixed dense allocation cannot model.
function collectIrModuleDenseArraySequentialAppendPlansCpp(
  module: Readonly<IrModule>,
): ReadonlyMap<string, Readonly<CppDenseArraySequentialAppendPlan>> {
  const immutableBindingIds = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && !variable.mutable) immutableBindingIds.add(variable.binding.id);
    },
  });
  const result = new Map<string, Readonly<CppDenseArraySequentialAppendPlan>>();
  const inspectStatements = (statements: readonly Readonly<IrStatement>[]): void => {
    statements.forEach((statement, statementIndex) => {
      if (statement.kind === 'variable') {
        for (const variable of statement.declarations) {
          if (!('binding' in variable) || !variable.initializer) continue;
          const length = getDirectDenseArrayLengthExpressionCpp(variable.initializer);
          const loop = statements[statementIndex + 1];
          const plan =
            length && loop
              ? getDenseArraySequentialAppendPlanCpp(variable.binding.id, length, loop, immutableBindingIds)
              : undefined;
          if (plan) result.set(variable.binding.id, plan);
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

function getDirectDenseArrayLengthExpressionCpp(
  expression: Readonly<IrExpression>,
): Readonly<IrExpression> | undefined {
  return expression.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'ambient' &&
    expression.callee.reference.name === 'Array' &&
    expression.arguments.length === 1
    ? expression.arguments[0]
    : undefined;
}

function getDenseArraySequentialAppendPlanCpp(
  arrayBindingId: string,
  length: Readonly<IrExpression>,
  statement: Readonly<IrStatement>,
  immutableBindingIds: ReadonlySet<string>,
): Readonly<CppDenseArraySequentialAppendPlan> | undefined {
  if (statement.kind !== 'for' || !Array.isArray(statement.initializer) || statement.initializer.length !== 1) {
    return undefined;
  }
  const index = statement.initializer[0]!;
  const condition = statement.condition;
  if (
    !('binding' in index) ||
    !index.initializer ||
    getNonnegativeIntegerLiteralCpp(index.initializer) !== 0 ||
    !condition ||
    condition.kind !== 'binary' ||
    condition.operator !== '<' ||
    !isIrBindingIdentifierCpp(condition.left, index.binding.id) ||
    !isEquivalentDenseArraySequentialBoundCpp(length, condition.right) ||
    !isStableDenseArraySequentialBoundCpp(condition.right, immutableBindingIds)
  ) {
    return undefined;
  }
  const step = getDenseArraySequentialLoopStepCpp(statement.increment, index.binding.id);
  if (step === undefined) return undefined;
  const body = statement.body.kind === 'block' ? statement.body.statements : [statement.body];
  const propertyBoundObject = getDenseArrayLengthPropertyObjectBindingIdCpp(condition.right);
  const freshBodyArrayBindingIds = collectDenseArrayFreshBindingIdsCpp(body);
  let expectedOffset = 0;
  for (const bodyStatement of body) {
    const offset = getDenseArraySequentialAppendStatementOffsetCpp(bodyStatement, arrayBindingId, index.binding.id);
    if (offset !== undefined) {
      if (offset !== expectedOffset || offset >= step) return undefined;
      expectedOffset += 1;
      continue;
    }
    if (
      doesIrStatementReferenceBindingCpp(bodyStatement, arrayBindingId) ||
      doesIrStatementContainLoopControlCpp(bodyStatement) ||
      (propertyBoundObject &&
        doesIrStatementInvalidateDenseArrayPropertyBoundCpp(
          bodyStatement,
          propertyBoundObject,
          freshBodyArrayBindingIds,
        ))
    ) {
      return undefined;
    }
  }
  if (expectedOffset !== step) return undefined;
  return { indexBindingId: index.binding.id, offsets: new Set(Array.from({ length: step }, (_, offset) => offset)) };
}

function collectDenseArrayFreshBindingIdsCpp(statements: readonly Readonly<IrStatement>[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const statement of statements) {
    analyzeIrStatementSubtreeTraversal(statement, {
      variable(variable) {
        if (
          'binding' in variable &&
          variable.initializer &&
          getDirectDenseArrayLengthExpressionCpp(variable.initializer)
        ) {
          result.add(variable.binding.id);
        }
      },
    });
  }
  return result;
}

function getDenseArraySequentialLoopStepCpp(
  increment: Readonly<IrExpression> | undefined,
  indexBindingId: string,
): number | undefined {
  if (
    increment?.kind === 'unary' &&
    increment.operator === '++' &&
    isIrBindingIdentifierCpp(increment.operand, indexBindingId)
  ) {
    return 1;
  }
  return increment?.kind === 'assignment' &&
    increment.operator === '+=' &&
    isIrBindingIdentifierCpp(increment.left, indexBindingId)
    ? getPositiveIntegerLiteralCpp(increment.right)
    : undefined;
}

function getDenseArraySequentialAppendStatementOffsetCpp(
  statement: Readonly<IrStatement>,
  arrayBindingId: string,
  indexBindingId: string,
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
  return getDenseArraySequentialWriteOffsetCpp(statement.expression.left.index, indexBindingId);
}

function getDenseArraySequentialWriteOffsetCpp(
  expression: Readonly<IrExpression>,
  indexBindingId: string,
): number | undefined {
  if (isIrBindingIdentifierCpp(expression, indexBindingId)) return 0;
  return expression.kind === 'binary' &&
    expression.operator === '+' &&
    isIrBindingIdentifierCpp(expression.left, indexBindingId)
    ? getNonnegativeIntegerLiteralCpp(expression.right)
    : undefined;
}

function isStableDenseArraySequentialBoundCpp(
  expression: Readonly<IrExpression>,
  immutableBindingIds: ReadonlySet<string>,
): boolean {
  if (getNonnegativeIntegerLiteralCpp(expression) !== undefined) return true;
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    immutableBindingIds.has(expression.reference.binding.id)
  ) {
    return true;
  }
  const objectBindingId = getDenseArrayLengthPropertyObjectBindingIdCpp(expression);
  return objectBindingId !== undefined && immutableBindingIds.has(objectBindingId);
}

function isEquivalentDenseArraySequentialBoundCpp(
  left: Readonly<IrExpression>,
  right: Readonly<IrExpression>,
): boolean {
  if (isEquivalentDenseArrayBoundCpp(left, right)) return true;
  const leftObject = getDenseArrayLengthPropertyObjectBindingIdCpp(left);
  const rightObject = getDenseArrayLengthPropertyObjectBindingIdCpp(right);
  return leftObject !== undefined && leftObject === rightObject;
}

function getDenseArrayLengthPropertyObjectBindingIdCpp(expression: Readonly<IrExpression>): string | undefined {
  return expression.kind === 'property' &&
    expression.member?.receiver === 'array' &&
    expression.member.name === 'length' &&
    expression.object.kind === 'identifier' &&
    expression.object.reference.kind === 'binding'
    ? expression.object.reference.binding.id
    : undefined;
}

function doesIrStatementInvalidateDenseArrayPropertyBoundCpp(
  statement: Readonly<IrStatement>,
  objectBindingId: string,
  freshArrayBindingIds: ReadonlySet<string>,
): boolean {
  let invalidates = false;
  analyzeIrStatementSubtreeTraversal(statement, {
    expression(expression) {
      if (expression.kind === 'call') invalidates = true;
      if (expression.kind === 'assignment' && doesIrExpressionReferenceBindingCpp(expression.left, objectBindingId)) {
        invalidates = true;
      }
      if (
        expression.kind === 'assignment' &&
        (expression.left.kind === 'element' || expression.left.kind === 'property') &&
        !(
          expression.left.object.kind === 'identifier' &&
          expression.left.object.reference.kind === 'binding' &&
          freshArrayBindingIds.has(expression.left.object.reference.binding.id)
        )
      ) {
        invalidates = true;
      }
      if (
        expression.kind === 'unary' &&
        (expression.operator === '++' || expression.operator === '--') &&
        (expression.operand.kind === 'element' || expression.operand.kind === 'property')
      ) {
        invalidates = true;
      }
      return invalidates ? false : undefined;
    },
    variable(variable) {
      if (
        'binding' in variable &&
        variable.initializer &&
        isIrBindingIdentifierCpp(variable.initializer, objectBindingId)
      ) {
        invalidates = true;
        return false;
      }
      return undefined;
    },
  });
  return invalidates;
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

function emitCppDenseArraySequentialAppendAssignmentCpp(
  expression: Readonly<IrExpression>,
  right: string,
  context: EmitContext,
): string | undefined {
  if (
    expression.kind !== 'element' ||
    expression.object.kind !== 'identifier' ||
    expression.object.reference.kind !== 'binding'
  ) {
    return undefined;
  }
  const plan = context.denseArraySequentialAppendPlans.get(expression.object.reference.binding.id);
  if (!plan) return undefined;
  const offset = getDenseArraySequentialWriteOffsetCpp(expression.index, plan.indexBindingId);
  if (offset === undefined || !plan.offsets.has(offset)) return undefined;
  const receiver = getGeneratedTargetName('sequentialAppendReceiver', context);
  const index = getGeneratedTargetName('sequentialAppendIndex', context);
  const value = getGeneratedTargetName('sequentialAppendValue', context);
  context.includes.add('stdexcept');
  return `([&]() { auto&& ${receiver} = ${emitExpression(expression.object, context)}; const auto ${index} = ${emitExpression(expression.index, context)}; if (${index} != static_cast<double>(${receiver}.size())) throw std::range_error("proven sequential Array write did not append at its current length"); const auto ${value} = ${right}; ${receiver}.push(${value}); return ${value}; }())`;
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
  const key =
    plan.key.kind === 'named'
      ? (() => {
          context.includes.add('string');
          return `std::string(${JSON.stringify(plan.key.name)})`;
        })()
      : emitExpression(plan.key.expression, context);
  const enabled = emitExpression(plan.enabled, context);
  const report = emitExpression(plan.report, context);
  const proxy = `flight::make_structural_write_proxy<${schema}>(${target}, ${key}, [=]() { if (${enabled}) { ${report}; } })`;
  return plan.resultType ? `flight::structural_ref_cast<${emitType(plan.resultType, context)}>(${proxy})` : proxy;
}

function getCppStructuralWriteProxyConstructionPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
):
  | Readonly<{
      enabled: IrExpression;
      key: Readonly<{ expression: IrExpression; kind: 'computed' }> | Readonly<{ kind: 'named'; name: string }>;
      report: Extract<IrExpression, { kind: 'call' }>;
      resultType?: IrType;
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
  if (handler.kind !== 'object' || handler.members.length !== 1) {
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
  const keyExpression = guardStatement.condition.left.right;
  const namedKey = keyExpression.kind === 'literal' && typeof keyExpression.value === 'string';
  const row =
    context.referenceRepresentationPlanner.resolveStructuralRow(type, context.module) ??
    (namedKey ? getCppStructuralProjectionRowCpp(type, context) : undefined);
  const directResultRow = context.referenceRepresentationPlanner.resolveStructuralRow(expectedType, context.module);
  const resultRow = directResultRow ?? (namedKey ? getCppStructuralProjectionRowCpp(expectedType, context) : undefined);
  const key = getCppStructuralWriteProxyKeyCpp(type, keyExpression, context);
  const reportStatement = guardStatement.consequent.statements[0];
  if (
    !row ||
    !resultRow ||
    normalizeCompilerStructuralValueCanonical(row) !== normalizeCompilerStructuralValueCanonical(resultRow) ||
    !key ||
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
    typeof reportStatement.expression.arguments[0].value !== 'string' ||
    (key.kind === 'computed' && reportStatement.expression.arguments[0].value !== 'runtime-slot') ||
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
    ...(directResultRow ? {} : { resultType: expectedType }),
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
  if (
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    expression.kind === 'binary' &&
    (expression.operator === '&&' || expression.operator === '||') &&
    (expression.semantics.left.flow === 'string' || expression.semantics.right.flow === 'string')
  ) {
    // Logical expressions preserve operand values in JavaScript, but this caller needs only the
    // expression's truthiness. Convert each string operand at that semantic boundary so short
    // circuiting stays intact without making Flight String an implicitly boolean C++ type.
    const left =
      expression.semantics.left.flow === 'boolean'
        ? emitExpression(expression.left, context, { kind: 'primitive', name: 'boolean' })
        : emitCppTruthinessExpression(expression.left, context);
    const right =
      expression.semantics.right.flow === 'boolean'
        ? emitExpression(expression.right, context, { kind: 'primitive', name: 'boolean' })
        : emitCppTruthinessExpression(expression.right, context);
    return `(${left} ${expression.operator} ${right})`;
  }
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

function getCppStructuralWriteProxyKeyCpp(
  type: Readonly<IrType>,
  key: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<{ expression: IrExpression; kind: 'computed' }> | Readonly<{ kind: 'named'; name: string }> | undefined {
  const members = type.kind === 'intersection' ? type.types : [type];
  if (key.kind === 'literal' && typeof key.value === 'string') {
    const matches = members.flatMap(
      (member) =>
        context.referenceRepresentationPlanner
          .resolveObjectShape(member, context.module)
          ?.filter((property) => !property.computedKey && property.name === key.value) ?? [],
    );
    return matches.length === 1 ? { kind: 'named', name: key.value } : undefined;
  }
  const keyReference = getIrExpressionValueNameReferenceCpp(key);
  if (!keyReference) return undefined;
  const keyName = getCppComputedPropertySourceName(keyReference, context);
  const matches = members.flatMap(
    (member) =>
      context.referenceRepresentationPlanner
        .resolveObjectShape(member, context.module)
        ?.filter(
          (property) =>
            property.computedKey && getCppComputedPropertySourceName(property.computedKey, context) === keyName,
        ) ?? [],
  );
  return matches.length === 1 ? { expression: key, kind: 'computed' } : undefined;
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
    if (
      target.semantics.key === 'symbol' &&
      target.object.kind === 'identifier' &&
      target.object.reference.kind === 'binding' &&
      context.structuralCloneRecordBindingIds.has(target.object.reference.binding.id) &&
      !getCppStructuralRowComputedPropertyCpp(target, context)
    ) {
      emissionError(
        context,
        'computed structural-row write requires one declared symbol property',
        'cpp-structural-row-computed-write-unproven',
      );
    }
    context.includes.add('flight/structural_ref.hpp');
    return `flight::row_set(${emitExpression(target.object, context)}, ${emitExpression(target.index, context)}, ${value})`;
  }
  return undefined;
}

function emitCppStructuralRowDeleteCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'unary' }>>,
  context: EmitContext,
): string | undefined {
  if (
    expression.operator !== 'delete' ||
    expression.operand.kind !== 'element' ||
    getCppRuntimeProfile(context.options) !== 'flight-cpp'
  ) {
    return undefined;
  }
  const property = getCppStructuralRowComputedPropertyCpp(expression.operand, context);
  if (
    !property &&
    expression.operand.object.kind === 'identifier' &&
    expression.operand.object.reference.kind === 'binding' &&
    context.structuralCloneRecordBindingIds.has(expression.operand.object.reference.binding.id)
  ) {
    emissionError(
      context,
      'computed structural-row delete requires one declared optional symbol property',
      'cpp-structural-row-computed-delete-unproven',
    );
  }
  if (!property || (!property.optional && !hasIrTypeAbsentMember(property.type))) return undefined;
  const target = emitExpression(expression.operand.object, context);
  const key = emitExpression(expression.operand.index, context);
  const absent = emitUndefinedWithExpectedTypeCpp(property.type, context);
  context.includes.add('flight/structural_ref.hpp');
  return `([&]() { flight::row_set(${target}, ${key}, ${absent}); return true; }())`;
}

function emitCppCapturedRuntimeReferentPropertyAssignmentCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  right: string,
  context: EmitContext,
): string | undefined {
  if (
    expression.operator !== '=' ||
    expression.left.kind !== 'property' ||
    expression.left.object.kind !== 'identifier' ||
    expression.left.object.reference.kind !== 'binding'
  ) {
    return undefined;
  }
  const bindingId = expression.left.object.reference.binding.id;
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(bindingId);
  const bindingType = getCppBindingTypeCpp(bindingId, context);
  if (
    !sharedCaptureTargetName ||
    !bindingType ||
    !context.capturedReferentOnlyBindingIds.has(bindingId) ||
    !hasCppExternalRuntimeReferenceRepresentationCpp(bindingType, context)
  ) {
    return undefined;
  }
  const memberBinding = expression.left.member
    ? getCompilerCppAmbientMemberBinding(expression.left.member, getCppRuntimeProfile(context.options))
    : undefined;
  const memberName = memberBinding?.kind === 'property' ? memberBinding.targetName : safeCppName(expression.left.name);
  const bindingValue = hasIrTypeAbsentMember(bindingType) ? 'binding_value.value()' : 'binding_value';
  return `${sharedCaptureTargetName}.update_binding([&](auto& binding_value) { return (${bindingValue}.${memberName} = ${right}); })`;
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
  // A writable projection such as EntityConstruction<Grid> stores RowOf<Grid>. Its resolved shape is
  // useful for deciding that `bounds` exists, but shape resolution expands a declared object alias
  // such as `bounds: AabbLike` into its raw `{ max, min }` members. Constructing that expansion would
  // mint an anonymous helper in Grid's namespace even though Grid's header emits the named AabbLike.
  // Recover the row subject first so a directly declared property retains its nominal source identity.
  const row = context.referenceRepresentationPlanner.resolveStructuralRow(receiverType, context.module);
  const declarationType = row ? getCppStructuralRowObjectTypeCpp(row) : receiverType;
  const owner = declarationType ? getCppTypeReferenceOwnerModuleCpp(declarationType, context) : context.module;
  if (owner.packageName === context.module.packageName) return undefined;
  const declaredProperty = declarationType
    ? context.referenceRepresentationPlanner.resolveOwnObjectProperty(declarationType, target.name, context.module)
    : undefined;
  if (declaredProperty?.type.kind === 'named' && declaredProperty.type.reference.kind === 'binding') {
    return emitExpression(value, context, declaredProperty.type);
  }
  const property = context.referenceRepresentationPlanner
    .resolveObjectShape(receiverType, context.module)
    ?.find((candidate) => candidate.name === target.name);
  const constructionProperty = declaredProperty ?? property;
  return constructionProperty
    ? emitCppForeignAnonymousObjectValueCpp(value, constructionProperty.type, owner, context)
    : undefined;
}

function emitCppForeignAnonymousObjectValueCpp(
  value: Readonly<IrExpression>,
  type: Readonly<IrType>,
  owner: Readonly<IrModule>,
  context: EmitContext,
): string | undefined {
  const objectType = getCppNonNullableType(type, context, new Set()) ?? type;
  if (
    value.kind !== 'object' ||
    objectType.kind !== 'object' ||
    value.members.some((member) => member.kind !== 'property')
  ) {
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
  const emitMemberValue = (
    member: Readonly<Extract<IrObjectMember, { kind: 'property' }>>,
    expected: Readonly<IrType> | undefined,
  ): string =>
    (expected ? emitCppForeignAnonymousObjectValueCpp(member.value, expected, owner, context) : undefined) ??
    emitExpression(member.value, context, expected);
  const sourceOrder = members.map((member) => member.name);
  const targetOrder = ordered.map(({ member }) => member.name);
  const reordered = sourceOrder.some((name, index) => name !== targetOrder[index]);
  if (reordered) {
    const temporaries = new Map(
      members.map((member) => [member, getGeneratedTargetName(`object_member_${member.name}`, context)] as const),
    );
    const evaluations = members.map((member) => {
      const expected = objectType.properties.find((property) => property.name === member.name)?.type;
      return `auto ${temporaries.get(member)!} = ${emitMemberValue(member, expected)};`;
    });
    const initializer = ordered
      .map(({ member }) => `.${safeCppName(member.name)} = ${temporaries.get(member)!}`)
      .join(', ');
    return `([&]() { ${evaluations.join(' ')} return flight::make_ref<${qualified}>(${qualified}{${initializer}}); }())`;
  }
  const initializer = ordered
    .map(({ expected, member }) => `.${safeCppName(member.name)} = ${emitMemberValue(member, expected.type)}`)
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
  const structuralProperty =
    expression.kind === 'element' ? getCppStructuralRowComputedPropertyCpp(expression, context) : undefined;
  return (
    structuralProperty?.type ??
    getIrExpressionBindingTypeCpp(expression, context) ??
    getIrExpressionTypeEvidenceCpp(expression, context)
  );
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
  // An indexed optional-chain continuation carries two independent sources of absence: its receiver
  // may already be absent, and the runtime collection lookup may miss. The direct `.get` paths below
  // preserve only the latter. Keep them for a receiver the checker proved present, but let the existing
  // optional-chain emitter guard a receiver whose neutral evidence still says it may be nullish.
  if (
    expression.kind === 'element' &&
    expression.optional &&
    expression.semantics.optionalChain?.receiverNullish === 'possible'
  ) {
    return emitOptionalElementExpressionCpp(expression, context);
  }
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
    return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${receiver}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().${getCppProjectedMemberNameCpp(expression, context)}; }())`;
  }
  return emitExpression(
    expression,
    context,
    expression.kind === 'binary' && expression.operator === '??' ? expectedType : undefined,
  );
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
    // A property READ can project one present alternative below. Calling through that property also has to
    // prove a callable surface and return carrier against the projected alternative, which this lane does not
    // yet represent, so it retains the original refusal.
    if (expression.callee.kind === 'property' && expression.callee.optionalChain) {
      assertIrOptionalChainReceiverIsSingleSentinelCpp(expression.callee.optionalChain.receiverType, context);
      return;
    }
    assertIrExpressionHasNoDualSentinelOptionalChainCpp(expression.callee, context);
    return;
  }
  if (expression.kind === 'element' && expression.semantics.optionalChain) {
    assertIrOptionalChainReceiverIsSingleSentinelCpp(expression.semantics.optionalChain.receiverType, context);
    return;
  }
  if (expression.kind === 'property' && expression.optionalChain) {
    const union = getIrUnionTypeCpp(expression.optionalChain.receiverType, context, new Set());
    const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
    if (plan?.kind === 'dualSentinelVariant' && plan.valueSlots.length !== 1) {
      emissionError(context, 'dual-sentinel optional chaining requires one concrete receiver value domain');
    }
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
  const callableReturns = getCppCallableReturnType(semantics.valueType, context, new Set());
  const recovered = getCppOptionalPropertyCallResultTypeEvidenceCpp(expression, context);
  const returns = callableReturns?.kind === 'unknown' ? (recovered ?? callableReturns) : (callableReturns ?? recovered);
  if (!returns || returns.kind === 'unknown')
    emissionError(
      context,
      `optional property call ${callee.name} requires callable result evidence`,
      'cpp-optional-property-call-missing-callable-result',
    );
  const receiver = emitOptionalChainReceiverCpp(callee.object, context);
  const memberOperator = hasFlightReferenceRepresentationCpp(receiverType, context) ? '->' : '.';
  const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context)).join(', ');
  // The member is spelled the same way here as everywhere else. This path wrote `safeCppName` of the
  // source name directly, so an ambient member reached through an optional chain kept its TypeScript
  // spelling -- `url.split('.').pop()?.toLowerCase()` emitted `to_lower_case` while the identical call
  // written without the chain emitted `to_lower`. The table already knew the answer; this site was the
  // one not asking it.
  const invocation = `optional_chain_receiver.value()${memberOperator}${getCppProjectedMemberNameCpp(callee, context)}(${arguments_})`;
  context.includes.add('optional');
  if (returns.kind === 'primitive' && returns.name === 'void') {
    return `([&]() { auto optional_chain_receiver = ${receiver}; if (!optional_chain_receiver.has_value()) return; ${invocation}; }())`;
  }
  const payload = emitOptionalChainPayloadTypeCpp(returns, context);
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
  const receiverPlan = getCppOptionalElementReceiverPlanCpp(expression, semantics.receiverType, context);
  const tupleIndex =
    receiverPlan?.kind === 'tuple' ? getElementAccessTupleIndexCpp(expression, context, receiverPlan.type) : undefined;
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  const index = emitExpression(expression.index, context);
  context.includes.add('optional');
  if (receiverPlan?.kind === 'tuple' && tupleIndex !== undefined) {
    if (
      getCppRuntimeProfile(context.options) === 'flight-cpp' &&
      getIrHomogeneousTupleElementTypeCpp(receiverPlan.type)
    ) {
      const elementType = getIrHomogeneousTupleElementTypeCpp(receiverPlan.type)!;
      const projected = emitCppOptionalElementLookupCpp(
        `optional_chain_receiver.value()`,
        index,
        elementType,
        semantics.valueType,
        context,
      );
      return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${projected}; }())`;
    }
    return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return std::get<${String(tupleIndex)}>(optional_chain_receiver.value()); }())`;
  }
  if (receiverPlan?.kind === 'regexpExecArray') {
    return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().capture(${index}); }())`;
  }
  if (receiverPlan?.kind === 'runtimeIndexed') {
    const projected = emitCppOptionalElementLookupCpp(
      `optional_chain_receiver.value()`,
      index,
      receiverPlan.elementType,
      semantics.valueType,
      context,
    );
    return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${projected}; }())`;
  }
  emissionError(context, 'optional element access requires one concrete nullable indexed collection receiver');
}

function emitCppOptionalElementLookupCpp(
  receiver: string,
  index: string,
  elementType: Readonly<IrType> | undefined,
  valueType: Readonly<IrType>,
  context: EmitContext,
): string {
  const projected = `${receiver}.get(${index})`;
  const storageUnion = elementType ? getIrUnionTypeCpp(elementType, context, new Set()) : undefined;
  const storagePlan = storageUnion ? getCppUnionRepresentationPlan(storageUnion, context) : undefined;
  const resultType = createIrTypeEvidenceUnionCpp([valueType, { kind: 'undefined' }]);
  const resultUnion = resultType ? getIrUnionTypeCpp(resultType, context, new Set()) : undefined;
  const resultPlan = resultUnion ? getCppUnionRepresentationPlan(resultUnion, context) : undefined;
  const storageSlot = storagePlan?.valueSlots.length === 1 ? storagePlan.valueSlots[0] : undefined;
  const resultSlot = resultPlan?.valueSlots.length === 1 ? resultPlan.valueSlots[0] : undefined;
  // A checked runtime lookup contributes an outer undefined absence. Flatten it only when the stored
  // element independently uses that same absence for its one value domain; null or a second domain must
  // remain distinguishable. This is the element counterpart to the nullish-merge representation proof.
  return storagePlan?.kind === 'optionalSingle' &&
    resultPlan?.kind === 'optionalSingle' &&
    storageSlot?.representationKey === resultSlot?.representationKey &&
    storageSlot?.targetType === resultSlot?.targetType &&
    storagePlan.sentinels.null === resultPlan.sentinels.null &&
    storagePlan.sentinels.undefined === resultPlan.sentinels.undefined
    ? `${projected}.value_or(std::nullopt)`
    : projected;
}

function getCppOptionalElementReceiverPlanCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  type: Readonly<IrType>,
  context: EmitContext,
):
  | Readonly<{ kind: 'regexpExecArray' }>
  | Readonly<{ elementType?: IrType | undefined; kind: 'runtimeIndexed' }>
  | Readonly<{ kind: 'tuple'; type: Extract<IrType, { kind: 'tuple' }> }>
  | undefined {
  // Nullability and collection identity are separate facts. Strip only the receiver sentinel, then require
  // exactly one concrete collection representation: syntax-level arrays and tuples, the regexp capture
  // carrier's checked lookup, or a runtime-planned array. A remaining union would need a variant visitor and
  // stays refused even when every alternative happens to be indexable.
  const receiver = getCppNonNullableType(type, context, new Set());
  if (!receiver || receiver.kind === 'union') return undefined;
  const tuple = getIrTupleTypeCpp(receiver, context, new Set());
  if (tuple) return { kind: 'tuple', type: tuple };
  const array = getIrArrayTypeCpp(receiver, context, new Set());
  if (array) return { elementType: array.element, kind: 'runtimeIndexed' };
  if (hasCppRegExpExecArrayIndexedReceiverCpp(expression, context)) return { kind: 'regexpExecArray' };
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return undefined;
  const representation = context.referenceRepresentationPlanner.plan(receiver, context.module);
  return representation.kind === 'represented' &&
    (representation.category === 'array' || representation.category === 'typedArray')
    ? { kind: 'runtimeIndexed' }
    : undefined;
}

function emitOptionalPropertyExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
): string {
  const semantics = expression.optionalChain;
  if (!semantics) emissionError(context, 'optional property access lacks neutral optional-chain evidence');
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
  const receiverProjection = getCppOptionalChainReceiverProjectionCpp(semantics.receiverType, context);
  const memberOperator = hasFlightReferenceRepresentationCpp(receiverType, context) ? '->' : '.';
  let projected: string;
  const structuralReceiver = context.referenceRepresentationPlanner.resolveStructuralRow(receiverType, context.module);
  if (structuralReceiver) {
    context.includes.add('flight/structural_ref.hpp');
    projected = `flight::row_get<flight::RowKey<${JSON.stringify(expression.name)}>>(${receiverProjection.value})`;
  } else if (expression.member) {
    const binding = getCompilerCppAmbientMemberBinding(expression.member, getCppRuntimeProfile(context.options));
    if (binding?.kind === 'sizeMethod') {
      projected = `static_cast<double>(${receiverProjection.value}${memberOperator}size())`;
    } else if (binding?.kind === 'sizeProperty') {
      projected = `static_cast<double>(${receiverProjection.value}${memberOperator}${binding.targetName})`;
    } else if (binding?.kind === 'property') {
      projected = `${receiverProjection.value}${memberOperator}${binding.targetName}`;
    } else {
      projected = `${receiverProjection.value}${memberOperator}${safeCppName(expression.name)}`;
    }
  } else if (getIrExpressionClassAccessorCpp(expression.object, expression.name, 'get', context)) {
    projected = `${receiverProjection.value}${memberOperator}${safeCppName(expression.name)}()`;
  } else {
    projected = `${receiverProjection.value}${memberOperator}${safeCppName(expression.name)}`;
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
  // What the projection READS is the member's storage, and for a `?`-marked property that also admits a
  // sentinel the storage is the same three-state variant every other crossing uses — a variant has no
  // `value_or`. The declared type alone cannot see that, because the `?` marker is the second absence, so
  // the plan is taken from the property's effective type, and the read is only taken while one value domain
  // is proven: two domains leave nothing for the member's alternative to be, and keep the existing path.
  //
  // The RESULT keeps all three of the source's states. `receiver?.member` is `undefined` when the receiver
  // is absent and `undefined` when the member is, but it is `null` when the member is null — collapsing the
  // two sentinels into an absent result would lose exactly the distinction the three-state storage exists to
  // carry, and would not convert into a declared dual-sentinel local. So the member passes through as it is
  // stored, and only the receiver's own absence produces the undefined sentinel. A later chain segment reads
  // this result as its own receiver evidence and may collapse nullish input there, which is that segment's
  // question rather than this one's.
  const projectedStorageUnion = declaredProperty
    ? getIrUnionTypeCpp(getIrObjectPropertyReadTypeCpp(declaredProperty) ?? declaredProperty.type, context, new Set())
    : undefined;
  const projectedStoragePlan = projectedStorageUnion
    ? getCppUnionRepresentationPlan(projectedStorageUnion, context)
    : undefined;
  const chainResultEvidence = getIrExpressionTypeEvidenceCpp(expression, context);
  const chainResultUnion = chainResultEvidence ? getIrUnionTypeCpp(chainResultEvidence, context, new Set()) : undefined;
  const chainResultPlan = chainResultUnion ? getCppUnionRepresentationPlan(chainResultUnion, context) : undefined;
  const projectedDualSentinel =
    projectedStoragePlan?.kind === 'dualSentinelVariant' && projectedStoragePlan.valueSlots.length === 1
      ? projectedStoragePlan.valueSlots[0]
      : undefined;
  const resultDualSentinel =
    chainResultPlan?.kind === 'dualSentinelVariant' && chainResultPlan.valueSlots.length === 1
      ? chainResultPlan.valueSlots[0]
      : undefined;
  const chainedResultType =
    resultDualSentinel && chainResultUnion ? emitUnionTypeCpp(chainResultUnion, context) : resultType;
  const chainedAbsent =
    resultDualSentinel && chainResultUnion
      ? emitCppUnionSentinelConstruction('undefined', chainResultUnion, 'dualSentinelVariant', context)
      : 'std::nullopt';
  let returned: string;
  // The receiver's two sentinels both become undefined, but they do not authorize collapsing the projected
  // member's own sentinel. Rebuild a nullable member's optional storage into the result variant, pass an
  // already three-state member through unchanged, or construct the value alternative from an ordinary member.
  if (
    resultDualSentinel &&
    chainResultUnion &&
    projectedStoragePlan?.kind === 'optionalSingle' &&
    projectedStoragePlan.valueSlots[0]?.targetType === resultDualSentinel.targetType
  ) {
    const projectedValue = getGeneratedTargetName('optionalChainProjected', context);
    const sentinel = projectedStoragePlan.sentinels.null === 'optionalAbsence' ? 'null' : 'undefined';
    const absent = emitCppUnionSentinelConstruction(sentinel, chainResultUnion, 'dualSentinelVariant', context);
    const present = emitCppUnionValueConstruction(
      `${projectedValue}.value()`,
      resultDualSentinel.targetType,
      chainResultUnion,
      'dualSentinelVariant',
      context,
    );
    returned = `([&]() -> ${chainedResultType} { auto ${projectedValue} = ${projected}; if (!${projectedValue}.has_value()) return ${absent}; return ${present}; }())`;
  } else if (
    resultDualSentinel &&
    chainResultUnion &&
    projectedDualSentinel?.targetType === resultDualSentinel.targetType
  ) {
    context.includes.add('variant');
    returned = projected;
  } else if (resultDualSentinel && chainResultUnion && emitType(valueType, context) === resultDualSentinel.targetType) {
    returned = emitCppUnionValueConstruction(
      projected,
      resultDualSentinel.targetType,
      chainResultUnion,
      'dualSentinelVariant',
      context,
    );
  } else if (resultDualSentinel) {
    emissionError(context, 'dual-sentinel optional property result requires one represented member value domain');
  } else if (
    !structuralReceiver &&
    (nestedOptionalStorage || projectedStorageType === `std::optional<${resultType}>`)
  ) {
    returned = `${projected}.value_or(std::nullopt)`;
  } else {
    returned = projected;
  }
  context.includes.add('optional');
  return `([&]() -> ${chainedResultType} { auto optional_chain_receiver = ${object}; if (${receiverProjection.absent}) return ${chainedAbsent}; return ${returned}; }())`;
}

function getCppOptionalChainReceiverProjectionCpp(
  type: Readonly<IrType>,
  context: EmitContext,
): Readonly<{ absent: string; value: string }> {
  const union = getIrUnionTypeCpp(type, context, new Set());
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  if (plan?.kind !== 'dualSentinelVariant') {
    return { absent: '!optional_chain_receiver.has_value()', value: 'optional_chain_receiver.value()' };
  }
  // Optional chaining asks only whether the receiver is present, so one positive alternative is the complete
  // proof: either sentinel fails the test and the same exact alternative is read after it succeeds. Multiple
  // value domains still need a visitor which proves that every domain supports the requested operation.
  const value = plan.valueSlots.length === 1 ? plan.valueSlots[0] : undefined;
  if (!value) {
    emissionError(context, 'dual-sentinel optional chaining requires one concrete receiver value domain');
  }
  context.includes.add('variant');
  return {
    absent: `!std::holds_alternative<${value.targetType}>(optional_chain_receiver)`,
    value: `std::get<${value.targetType}>(optional_chain_receiver)`,
  };
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
  const genericCarrier = getCppGenericCarrierPropertyPresencePlanCpp(expression, context);
  if (genericCarrier) {
    const storage = emitExpression(unnarrowed, context);
    if (genericCarrier.kind === 'alwaysPresent') return storage;
    context.includes.add('flight/structural_ref.hpp');
    context.includes.add('type_traits');
    const valueName = getGeneratedTargetName('presentOperand', context);
    return `([&]() -> decltype(auto) { const auto& ${valueName} = ${storage}; if constexpr (flight::detail::optional_traits<std::remove_cvref_t<decltype(${valueName})>>::optional) return (${valueName}.value()); else return (${valueName}); }())`;
  }
  const sourceType = getIrExpressionTypeEvidenceCpp(unnarrowed, context);
  if (!sourceType || !hasIrTypeAbsentMember(sourceType)) return undefined;
  const presentType = getCppNonNullableType(sourceType, context, new Set());
  if (!presentType) {
    emissionError(context, 'present access requires one concrete non-nullish C++ value domain');
  }
  const union = getIrUnionTypeCpp(sourceType, context, new Set());
  const plan = union ? getCppUnionRepresentationPlan(union, context) : undefined;
  // Which storage holds the present value is the union plan's answer, not a spelling. The narrowed
  // guard has already excluded every sentinel, so an optional keeps the value behind `value()` and a
  // variant that preserves null and undefined as distinct alternatives holds it as the one value
  // alternative. A plan with no single value domain still refuses rather than choosing an alternative
  // the guard did not prove.
  // Absence carried by an optional is one answer whatever the payload's width: `Texture | null` where
  // `Texture` is itself a union keeps its absent state in the optional and its value state as the
  // variant behind it, so the narrowed read is `value()` for both kinds. Only a plan that keeps the
  // sentinels as alternatives of the variant needs the single value alternative named.
  const paysForAbsenceWithOptional =
    plan !== undefined && (plan.kind === 'optionalSingle' || plan.kind === 'optionalVariant');
  const soleValueAlternative =
    plan !== undefined &&
    (plan.kind === 'dualSentinelVariant' || plan.kind === 'multiVariant' || plan.kind === 'optionalVariant') &&
    plan.valueSlots.length === 1
      ? plan.valueSlots[0]
      : undefined;
  if (!paysForAbsenceWithOptional && !soleValueAlternative) {
    emissionError(context, 'present access requires optional C++ storage with one value domain');
  }
  // The carrier is re-emitted to be unwrapped, so the contextual union construction must not run on it:
  // this expression is the STORAGE, and building a union out of it here is what the outer, narrowed
  // expression already did before this lane was reached. `presentType` is still passed, because every
  // other contextual rule is about the value this read produces and stays right.
  const unnarrowedExpression = emitExpression(unnarrowed, context, presentType, false);
  let unwrapped: string;
  if (paysForAbsenceWithOptional) {
    context.includes.add('optional');
    unwrapped = `${unnarrowedExpression}.value()`;
  } else {
    context.includes.add('variant');
    unwrapped = `std::get<${soleValueAlternative!.targetType}>(${unnarrowedExpression})`;
  }
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

// Retain an imported union alias when one nullish sentinel wraps it, including through an
// identity-preserving utility. Re-expanding that alias creates package-local anonymous alternatives
// with a distinct C++ identity even though the source still names the upstream ABI type.
// A property marked `?` whose own type already carries an absent member has THREE observably distinct
// states: absent, null, and present. The union planner is the single authority that answers how those
// three are stored, and every assignment and presence test already asks it — which is why the two
// spellings must not be wrapped a second time. Wrapping the already-emitted type in another optional
// answers a different question, and the two answers do not compile together: the null write builds a
// variant, the null test asks `holds_alternative`, and neither has a conversion into a nested optional.
//
// The case is deliberately narrow. A property that is not `?`-marked, or whose type carries no absent
// member, has no double absence and keeps whatever this declaration site already emitted — already
// optional-wrapped, so the returned `optional` is false for it too.
function emitCppObjectPropertyStorageCpp(
  property: Readonly<{ optional: boolean; type: IrType }>,
  emitted: string,
  context: EmitContext,
): Readonly<{ optional: boolean; type: string }> {
  if (!property.optional || !hasIrTypeAbsentMember(property.type)) {
    return { optional: false, type: emitted };
  }
  return {
    optional: false,
    type: emitCppMaterializedObjectPropertyTypeCpp(getIrObjectPropertyReadTypeCpp(property) ?? property.type, context),
  };
}

function emitCppMaterializedObjectPropertyTypeCpp(type: Readonly<IrType>, context: EmitContext): string {
  if (type.kind !== 'union') return emitType(type, context);
  const importedValueAlias = getCppOptionalImportedUnionValueAliasCpp(type, context);
  if (importedValueAlias) {
    context.includes.add('optional');
    return `std::optional<${emitType(importedValueAlias, context)}>`;
  }
  return emitType(type, context);
}

function getCppOptionalImportedUnionValueAliasCpp(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): Readonly<Extract<IrType, { kind: 'named' }>> | undefined {
  const sentinels = type.types.filter((member) => member.kind === 'null' || member.kind === 'undefined');
  const values = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  if (sentinels.length !== 1 || values.length !== 1) return undefined;
  const value = getCppIdentityPreservingUtilityArgument(values[0]!) ?? values[0];
  if (
    value?.kind !== 'named' ||
    value.reference.kind !== 'binding' ||
    value.reference.binding.kind !== 'import' ||
    resolveCppTypeAliasTarget(value, context)?.kind !== 'union'
  ) {
    return undefined;
  }
  return value;
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
  if (type.kind === 'union' && type.types.some((member) => member.kind === 'null' || member.kind === 'undefined')) {
    const present = getCppNonNullableType(type, context, new Set());
    if (present) return hasSharedReferentRepresentationCpp(present, context);
  }
  // The direct index is import-blind, so an imported subject would plan against this module instead
  // of the one that owns it and report no representation for a type that plainly has one.
  const owner =
    getCppDirectBindingOwner(type, context) ??
    (type.kind === 'named' ? getCppImportedBindingDeclarationCpp(type, context) : undefined);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return plan.kind === 'represented' && plan.valueRepresentation !== 'inlineValue';
}

function hasCppExternalRuntimeReferenceRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  if (identityPreserving) return hasCppExternalRuntimeReferenceRepresentationCpp(identityPreserving, context);
  if (hasIrTypeAbsentMember(type)) {
    const present = getCppNonNullableType(type, context, new Set());
    if (present) return hasCppExternalRuntimeReferenceRepresentationCpp(present, context);
  }
  const owner =
    getCppDirectBindingOwner(type, context) ??
    (type.kind === 'named' ? getCppImportedBindingDeclarationCpp(type, context) : undefined);
  const plan = context.referenceRepresentationPlanner.plan(type, owner?.module ?? context.module);
  return plan.kind === 'represented' && plan.category === 'external' && plan.valueRepresentation === 'runtimeReference';
}

function hasFlightReferenceRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  if (getCppCallableObjectIrTypeCpp(type, context, new Set())) return true;
  const identityPreserving = getCppIdentityPreservingUtilityArgument(type);
  if (identityPreserving) return hasFlightReferenceRepresentationCpp(identityPreserving, context);
  // An imported subject resolves through its own owner: the direct index is import-blind, and
  // falling back to this module would plan the type against the wrong one and report no
  // representation for a type that plainly has one.
  const owner =
    getCppDirectBindingOwner(type, context) ??
    (type.kind === 'named' ? getCppImportedBindingDeclarationCpp(type, context) : undefined);
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
  // The direct index is import-blind, so an imported subject would plan against this module instead
  // of the one that owns it and report no representation for a type that plainly has one.
  const owner =
    getCppDirectBindingOwner(type, context) ??
    (type.kind === 'named' ? getCppImportedBindingDeclarationCpp(type, context) : undefined);
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
  // The direct index is import-blind, so an imported subject would plan against this module instead
  // of the one that owns it and report no representation for a type that plainly has one.
  const owner =
    getCppDirectBindingOwner(type, context) ??
    (type.kind === 'named' ? getCppImportedBindingDeclarationCpp(type, context) : undefined);
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

function collectCppOptionalParameterBindingIds(module: Readonly<IrModule>): ReadonlySet<string> {
  const bindingIds = new Set<string>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      if (parameter.optional && !parameter.initializer) bindingIds.add(parameter.binding.id);
    },
  });
  return bindingIds;
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

function emitParameter(parameter: Readonly<IrParameter>, context: EmitContext, includeDefault = true): string {
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
  const objectEntriesTuple =
    context.objectEntriesTupleBindingIds.has(parameter.binding.id) && parameter.type.kind === 'tuple'
      ? parameter.type
      : undefined;
  const type = objectEntriesTuple
    ? emitCppStdTupleTypeCpp(objectEntriesTuple, context)
    : parameter.type
      ? getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        isCppBareObjectTypeCpp(parameter.type) &&
        !context.erasedObjectParameterBindingIds.has(parameter.binding.id)
        ? 'flight::Ref<void>'
        : emitCppParameterTypeCpp(parameter.type, parameter.rest, context)
      : 'auto';
  if (parameter.optional) {
    context.includes.add('optional');
    return `std::optional<${type}> ${name}${includeDefault ? ' = std::nullopt' : ''}`;
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

function isCppGenericStructuralSequenceParameterCpp(parameter: Readonly<IrParameter>, context: EmitContext): boolean {
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
      if (!targetModule)
        emissionError(
          context,
          `namespace reexport ${exported.exported} requires module resolution`,
          'cpp-namespace-reexport-unresolved',
        );
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
      emissionError(
        context,
        `renamed value reexport ${exported.exported} requires callable or storage alias lowering`,
        'cpp-renamed-value-reexport-unsupported',
      );
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
    collectCppDefaultArgumentModuleIncludeCpp(type, context);
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
  includeDefaults = true,
): CppFunctionTemplate {
  const declared = typeParameters.map((parameter) => {
    const name = context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name);
    const defaultType =
      includeDefaults && parameter.default
        ? ` = ${emitCppTemplateDefaultTypeArgumentCpp(parameter.default, context)}`
        : '';
    return `typename ${name}${defaultType}`;
  });
  const packs = parameters.flatMap((parameter) =>
    parameter.dependentCallablePack ? [getCppDependentCallablePack(parameter, context)] : [],
  );
  const names = [
    ...typeParameters.map(
      (parameter) => context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name),
    ),
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
  const erasedIdentityOperand = (
    operand: Readonly<IrExpression>,
    type: Readonly<IrType>,
  ): Readonly<{ erased: boolean; expression: Readonly<IrExpression>; type: Readonly<IrType> }> => {
    if (operand.kind !== 'cast' || !isCppErasedDynamicValueTypeCpp(operand.type)) {
      return { erased: false, expression: operand, type };
    }
    const sourceType = getIrExpressionTypeEvidenceCpp(operand.expression, context);
    return sourceType
      ? { erased: true, expression: operand.expression, type: sourceType }
      : { erased: false, expression: operand, type };
  };
  const leftOperand = erasedIdentityOperand(expression.left, leftType);
  const rightOperand = erasedIdentityOperand(expression.right, rightType);
  const leftStructural = context.referenceRepresentationPlanner.resolveStructuralRow(leftOperand.type, context.module);
  const rightStructural = context.referenceRepresentationPlanner.resolveStructuralRow(
    rightOperand.type,
    context.module,
  );
  if (Boolean(leftStructural) === Boolean(rightStructural)) return undefined;
  const structuralType = leftStructural ? leftOperand.type : rightOperand.type;
  const referenceType = leftStructural ? rightOperand.type : leftOperand.type;
  if (!hasFlightReferenceRepresentationCpp(referenceType, context)) return undefined;
  if (leftOperand.erased || rightOperand.erased) {
    // Erasure in an equality expression does not change JavaScript reference identity. Avoid
    // materializing `Any` only when BOTH sides explicitly erased their types and the row retains the
    // exact nominal owner compared on the other side. A lookalike row, a derived owner, or a one-sided
    // erasure stays on the fail-closed erased-value path.
    if (!leftOperand.erased || !rightOperand.erased) return undefined;
    const structuralObject = getCppStructuralRowObjectTypeCpp(leftStructural ?? rightStructural!);
    if (
      !structuralObject ||
      normalizeCompilerStructuralValueCanonical(structuralObject) !==
        normalizeCompilerStructuralValueCanonical(referenceType)
    ) {
      return undefined;
    }
    const isolatedContext = { ...context, anonymousStructs: new Map(), includes: new Set<string>() };
    if (emitType(structuralObject, isolatedContext) !== emitType(referenceType, isolatedContext)) return undefined;
    const left = getGeneratedTargetName('referenceIdentityLeft', context);
    const right = getGeneratedTargetName('referenceIdentityRight', context);
    const structural = leftStructural ? left : right;
    const reference = leftStructural ? right : left;
    const referenceAsStructural = `${emitType(structuralType, context)}(${reference})`;
    const comparedLeft = leftStructural ? structural : referenceAsStructural;
    const comparedRight = leftStructural ? referenceAsStructural : structural;
    const op = emitBinaryOperator(expression.operator, expression.semantics, context);
    return `([&]() { auto ${left} = ${emitExpression(leftOperand.expression, context)}; auto ${right} = ${emitExpression(rightOperand.expression, context)}; return (${comparedLeft} ${op} ${comparedRight}); }())`;
  }
  const structuralExpression = leftStructural ? leftOperand.expression : rightOperand.expression;
  const referenceExpression = leftStructural ? rightOperand.expression : leftOperand.expression;
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

function emitInitializedBindingValueCpp(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  const value = emitBindingValueCpp(binding, context);
  return context.defaultedParameterIds.has(binding.id) && !context.sharedCaptureTargetNames.has(binding.id)
    ? `${value}.value()`
    : value;
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

// An enum's members are scoped names, not members of an instance: the source writes `Rotation.member` and C++
// needs `Rotation::member`. A LOCAL enum already reaches the right spelling, but an imported one arrives as a
// value-space binding, takes the ordinary member operator, and emits `flighthq_types::Rotation.member` — a dot
// on a type, which is not an expression. The declaration decides, wherever it lives, so this resolves it the
// same way the function-declaration lookup resolves an import, and refuses anything that is not an enum so a
// plain object with a same-spelled property keeps its member access.
function emitCppEnumMemberReferenceCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  const object = expression.object;
  if (object.kind !== 'identifier' || object.reference.kind !== 'binding') return undefined;
  const bindingId = object.reference.binding.id;
  const declaration =
    context.module.declarations.find(
      (candidate): candidate is Extract<IrDeclaration, { kind: 'enum' }> =>
        candidate.kind === 'enum' && candidate.binding.id === bindingId,
    ) ??
    context.module.imports
      .flatMap((importItem) =>
        importItem.bindings.flatMap((binding) =>
          binding.binding.id === bindingId && binding.imported !== '*'
            ? getCppResolvedImportModules(importItem.specifier, context).flatMap((module) =>
                module.declarations.filter(
                  (candidate): candidate is Extract<IrDeclaration, { kind: 'enum' }> =>
                    candidate.kind === 'enum' && candidate.binding.name === binding.imported,
                ),
              )
            : [],
        ),
      )
      .at(0);
  // A NAME the enum declares. `Flags.any(…)` is a namespace function merged onto the enum, not a member, and
  // it keeps whatever lane already emits it.
  if (!declaration?.members.some((member) => member.name === expression.name)) return undefined;
  return `${emitExpression(object, context)}::${pascalCase(expression.name)}`;
}

function memberOp(object: Readonly<IrExpression>, context: EmitContext): string {
  if (isSuperAccess(object)) return '::';
  if (isThisAccess(object)) return '->';
  const genericCarrier =
    object.kind === 'property' && object.presence === 'narrowedPresent'
      ? getCppGenericCarrierPropertyPresencePlanCpp(object, context)
      : undefined;
  if (
    genericCarrier &&
    (hasFlightReferenceRepresentationCpp(genericCarrier.valueType, context) ||
      hasFlightFacetReferenceRepresentationCpp(genericCarrier.valueType, context))
  ) {
    return '->';
  }
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
  // The erased dynamic value carries `undefined` as one of its own alternatives and has no constructor
  // for `std::nullopt`, so a position whose storage is erased spells the sentinel through the value
  // itself. This is the same projection the presence test asks, reached through an assignment.
  if (isCppErasedDynamicValueTypeCpp(expectedType) && getCppRuntimeProfile(context.options) === 'flight-cpp') {
    context.includes.add('flight/any.hpp');
    return 'flight::undefined';
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

function getCppTypeReferenceDefaultArgumentsCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): readonly string[] | undefined {
  // A consumer refers to another module's generic through an import, and the direct-owner index
  // excludes imports, so the import resolves through its own owner first.
  const owner = getCppDirectBindingOwner(type, context) ?? getCppImportedBindingDeclarationCpp(type, context);
  const declaration = owner?.declaration;
  if (
    !owner ||
    !declaration ||
    (declaration.kind !== 'class' && declaration.kind !== 'interface' && declaration.kind !== 'typeAlias') ||
    declaration.typeParameters.length === 0 ||
    !declaration.typeParameters.every((parameter) => parameter.default !== undefined)
  ) {
    return undefined;
  }
  // `X<>` already works where the declaration is in scope, so only a reference that resolves to
  // another module needs the defaults spelled out.
  if (getCppModuleIdentityKey(owner.module) === getCppModuleIdentityKey(context.module)) return undefined;
  return declaration.typeParameters.map((parameter) => {
    collectCppDefaultArgumentModuleIncludeCpp(parameter.default!, context);
    return emitCppTypeArgumentCpp(parameter.default!, context);
  });
}

// Spelled out, a default argument names a type in the same breath as using it, so whatever header
// spells it out has to declare that type. The default is written where the parameter is declared and
// the header spelling it out is often a different module: `GizmoState` inherits `NodeType = NodeAny`
// through `HierarchyNode` and never imports `NodeAny`, so emitting the name alone left the target
// compiler to report an undeclared type far from the declaration that caused it.
function collectCppDefaultArgumentModuleIncludeCpp(type: Readonly<IrType>, context: EmitContext): void {
  const owner = getCppTypeReferenceOwnerModuleCpp(type, context);
  if (getCppModuleIdentityKey(owner) !== getCppModuleIdentityKey(context.module)) {
    context.includes.add(getCppModuleFilePath(owner, context.options));
  }
}

function getCppTypeReferenceUsesDefaultArgumentsCpp(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): boolean {
  if (type.reference.kind !== 'binding') return false;
  const declaration = (getCppDirectBindingOwner(type, context) ?? getCppImportedBindingDeclarationCpp(type, context))
    ?.declaration;
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

function emitAmbientTypeofUndefinedComparisonCpp(
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
    ambient.operand.reference.kind !== 'ambient'
  ) {
    return undefined;
  }
  // Presence is the target's own answer rather than an unknown: a global the target binds exists,
  // and one it binds no value for has none at runtime, so the probe is false instead of unanswerable.
  // Folding the absent case keeps the operand out of emitted code, so no binding is claimed for a
  // symbol the target cannot provide, and it is what lets a capability guard read correctly there.
  const present =
    getCompilerRuntimeExternalSymbolTargetCpp(
      ambient.operand.reference.name,
      'value',
      getCppRuntimeProfile(context.options),
      context.options.externalBindings,
    ) !== undefined;
  const absent = expression.operator === '==' || expression.operator === '===';
  return present !== absent ? 'true' : 'false';
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
  // A bare ambient global this target binds no value for has no runtime value here, so `typeof` of it
  // is exactly "undefined" — the answer ECMAScript gives for an absent global. A capability probe
  // therefore reads as absent rather than folding to the type's shape, which would claim the symbol
  // exists on a target that cannot provide it. A bound symbol keeps resolving through evidence below.
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'ambient' &&
    !getCompilerRuntimeExternalSymbolTargetCpp(
      expression.reference.name,
      'value',
      getCppRuntimeProfile(context.options),
      context.options.externalBindings,
    )
  ) {
    return 'undefined';
  }
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
    // A lib.d.ts type utility that reached emission was never expanded, and its name is not a C++ type.
    // `Extract<...>` names a template the target has never seen, so writing it out produces a header
    // that fails wherever it is included, naming nothing the compiler can point at. Refusing says which
    // utility went unresolved, at the declaration that reached emission holding it.
    //
    // Only utilities without unconditional C++ lowering are listed. `Extract` is the guarded member:
    // the closed evaluator handles it above, while an open or indeterminate instance deliberately
    // reaches the same named refusal. Utilities with total handling -- `Omit`, `Partial`, `Readonly`,
    // `Required`, `Pick`, `Record`, `Exclude`, `NonNullable`, `NoInfer`, `Parameters`, `ReturnType`,
    // `PropertyKey` -- never reach this line.
    if (cppUnexpandedTypeScriptUtilityAliases.has(type.reference.name)) {
      refuseCppUnexpandedTypeScriptUtilityAlias(type.reference.name, context);
    }
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

function refuseCppUnexpandedTypeScriptUtilityAlias(name: string, context: EmitContext): never {
  emissionError(
    context,
    `${name} was not resolved before emission and has no C++ lowering`,
    `cpp-typescript-utility-unexpanded:${name}`,
  );
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
  const importItem = context.module.imports.find((candidate) =>
    candidate.bindings.some((binding) => binding.binding.id === bindingId),
  );
  const importedBinding = importItem?.bindings.find((binding) => binding.binding.id === bindingId);
  const foreignOwner = context.importBindingOwners.get(bindingId);
  const ownerModule = importItem && importedBinding ? context.module : foreignOwner?.module;
  const specifier = importItem && importedBinding ? importItem.specifier : foreignOwner?.specifier;
  const imported = importItem && importedBinding ? importedBinding : foreignOwner;
  if (!ownerModule || !specifier || !imported) return undefined;
  const importedName = imported.imported === '*' ? referencePath[0] : imported.imported;
  if (!importedName) return undefined;
  const ownerContext = ownerModule === context.module ? context : { ...context, module: ownerModule };
  const targetModules = getCppResolvedImportModules(specifier, ownerContext);
  if (targetModules.length === 0) {
    return context.targetNames.get(bindingId) ?? safeCppName(importedBinding?.binding.name ?? importedName);
  }
  if (space === 'value') {
    // A facade owns the import route but not the declaration's C++ name. Follow named and star
    // reexports to the value declaration so its package namespace and allocated spelling travel
    // together; deriving either from the facade produces a name that no emitted header declares.
    const candidates = targetModules.flatMap((targetModule) =>
      getCppExportedValueBindingOwnersCpp(targetModule, importedName, context, new Set()),
    );
    const unique = new Map(
      candidates.map((candidate) => [
        `${getCppModuleIdentityKey(candidate.module)}\0${candidate.binding.id}`,
        candidate,
      ]),
    );
    if (unique.size === 1) {
      const target = [...unique.values()][0]!;
      const targetName =
        context.targetNameMaps.get(getCppModuleIdentityKey(target.module))?.get(target.binding.id) ??
        safeCppName(target.binding.name);
      return `${getCppCompilerPackageNamespace(target.module.packageName, context.options.packageTargets)}::${targetName}`;
    }
    if (unique.size > 1) {
      emissionError(
        context,
        `imported binding ${importedName} requires one module export target`,
        'cpp-imported-binding-no-export-target',
      );
    }
  }
  const directTargets = targetModules.filter((target) => hasCppDirectExportName(target, importedName));
  const targetModule =
    directTargets.length === 1 ? directTargets[0]! : getCppResolvedImportModule(specifier, ownerContext);
  if (!targetModule) {
    emissionError(
      context,
      `imported binding ${importedName} requires one module export target`,
      'cpp-imported-binding-no-export-target',
    );
  }
  const targetName = getCppResolvedExportTargetName(targetModule, importedName, space, context);
  return `${getCppCompilerPackageNamespace(targetModule.packageName, context.options.packageTargets)}::${targetName}`;
}

function getCppExportedValueBindingOwnersCpp(
  module: Readonly<IrModule>,
  exportedName: string,
  context: EmitContext,
  visited: ReadonlySet<string>,
): readonly CppValueBindingOwner[] {
  const key = `${getCppModuleIdentityKey(module)}\0${exportedName}`;
  if (visited.has(key)) return [];
  const nextVisited = new Set(visited).add(key);
  const directBindingIds = new Set([
    ...module.declarations.flatMap((declaration) =>
      declaration.exported && getCppValueDeclarationBindingCpp(declaration)?.name === exportedName
        ? [getCppValueDeclarationBindingCpp(declaration)!.id]
        : [],
    ),
    ...module.exports.flatMap((exported) =>
      exported.kind === 'local' && !exported.typeOnly && exported.exported === exportedName
        ? [exported.binding.id]
        : [],
    ),
  ]);
  const direct = module.declarations.flatMap((declaration): readonly CppValueBindingOwner[] => {
    const binding = getCppValueDeclarationBindingCpp(declaration);
    return binding && directBindingIds.has(binding.id) ? [{ binding, module }] : [];
  });
  const forwarded = module.exports.flatMap((exported): readonly CppValueBindingOwner[] => {
    if ('typeOnly' in exported && exported.typeOnly) return [];
    const importedName =
      exported.kind === 'all'
        ? exportedName
        : exported.kind === 'reexport' && exported.exported === exportedName
          ? exported.imported
          : undefined;
    if (!importedName || (exported.kind !== 'all' && exported.kind !== 'reexport')) return [];
    const moduleContext = module === context.module ? context : { ...context, module };
    return getCppResolvedImportModules(exported.specifier, moduleContext).flatMap((targetModule) =>
      getCppExportedValueBindingOwnersCpp(targetModule, importedName, context, nextVisited),
    );
  });
  return [...direct, ...forwarded];
}

function getCppValueDeclarationBindingCpp(
  declaration: Readonly<IrDeclaration>,
): Readonly<IrBindingIdentity | IrTypeBindingIdentity> | undefined {
  if (!('binding' in declaration)) return undefined;
  return declaration.kind === 'class' ||
    declaration.kind === 'enum' ||
    declaration.kind === 'function' ||
    declaration.kind === 'variable'
    ? declaration.binding
    : undefined;
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
      emissionError(
        context,
        `namespace import ${importedBinding.binding.name} requires module resolution`,
        'cpp-namespace-import-unresolved',
      );
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
  tuple?: Readonly<Extract<IrType, { kind: 'tuple' }>> | undefined,
): number {
  if (
    (!tuple && expression.semantics.receivers.length !== 1) ||
    expression.index.kind !== 'literal' ||
    typeof expression.index.value !== 'number' ||
    !Number.isSafeInteger(expression.index.value) ||
    expression.index.value < 0
  ) {
    emissionError(context, 'tuple projection requires one statically known nonnegative integer index');
  }
  const index = expression.index.value;
  if (tuple && index >= tuple.elements.length) {
    emissionError(context, `fixed-tuple projection index ${String(index)} is out of range`);
  }
  return index;
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
    'cpp-runtime-external-symbol-binding-incomplete',
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

function createCppAnonymousStructNaming(
  targetNameMaps: ReadonlyMap<string, ReadonlyMap<string, string>>,
): AnonymousStructNaming {
  // The declared names of every module in the emission, so the same shape resolves the same way
  // wherever it is written. Iteration is over a Map built in source order, and `createCppTargetNameMaps`
  // is deterministic, so the seed is too.
  const taken = new Set<string>();
  for (const names of targetNameMaps.values()) {
    for (const name of names.values()) taken.add(name);
  }
  return { names: new Map(), taken };
}

function generateAnonymousStructName(
  key: string,
  properties: readonly { readonly name: string }[],
  structuralHash: string,
  context: EmitContext,
): string {
  const naming = context.anonymousStructNaming;
  const existing = naming.names.get(key);
  if (existing) return existing;
  const base = getCppAnonymousStructBaseName(properties, structuralHash);
  let candidate = base;
  let suffix = 0;
  while (naming.taken.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  naming.names.set(key, candidate);
  naming.taken.add(candidate);
  // Keep the module's own set aware of it as well, so a name generated later in this module does not
  // land on the one this shape already took.
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

// The guard is derived from the NAME rather than from the structural hash, which is what keeps the
// definition, the guard, and the forward declaration that precedes it naming one thing. A guard taken
// from the hash alone lets a definition of one name suppress a definition of another whenever the two
// share a hash, and the suppressed one's uses then have no declaration at all -- with no diagnostic,
// because the preprocessor removed it.
function getCppAnonymousStructGuard(name: string, context: EmitContext): string {
  const packageIdentity = context.module.packageName.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase();
  return `FLIGHT_COMPILER_ANONYMOUS_${packageIdentity}_${name.toUpperCase()}`;
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

// A projected member reached through an optional receiver is still a member of whatever the runtime
// resolved it against, so its target spelling comes from the binding table rather than from the source
// name. `toLowerCase` is `to_lower` in the runtime, and deriving `to_lower_case` from the source name
// produces a member that does not exist. The fallback stays for members no table decides.
function getCppProjectedMemberNameCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string {
  const binding = expression.member
    ? getCompilerCppAmbientMemberBinding(expression.member, getCppRuntimeProfile(context.options))
    : undefined;
  return binding && binding.kind !== 'algorithm' ? binding.targetName : safeCppName(expression.name);
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

function emissionError(context: EmitContext, message: string, rule?: string): never {
  throw createBackendEmissionFailure('cpp', context.module, message, rule, context.currentOrigin);
}

// The ambient wrappers that change a member's optionality or mutability but never WHICH members exist, so
// a proof about one of them is a proof about its argument. `Pick`, `Omit`, and `Exclude` are absent on
// purpose: they decide membership, so they are resolved through the shape planner rather than assumed.
const cppDependentMemberPreservingAmbientWrappers = new Set(['NoInfer', 'Partial', 'Readonly', 'Required']);

// The lib.d.ts type utilities this emitter cannot lower unconditionally. Each names a type-level
// operation -- `Extract` filters a union, `Uppercase` transforms a string literal -- that a target must
// COMPUTE, and writing the name out would ask the target's compiler to compute it with a template it does
// not have. Closed `Extract` is computed before this fallback; open or indeterminate instances stay here.
const cppUnexpandedTypeScriptUtilityAliases = new Set([
  'Awaited',
  'Capitalize',
  'ConstructorParameters',
  'Extract',
  'InstanceType',
  'Lowercase',
  'OmitThisParameter',
  'ThisParameterType',
  'ThisType',
  'Uncapitalize',
  'Uppercase',
]);

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
