import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { IrObjectTypeProperty, IrType } from './compilerTypeIntermediateRepresentation.js';
import type { CompilerTypeValueIdentityAnalysis } from './compilerTypeValueIdentityContract.js';

export type CompilerCppReferenceRepresentationCategory =
  | 'anonymousObject'
  | 'array'
  | 'class'
  | 'date'
  | 'external'
  | 'facet'
  | 'interface'
  | 'map'
  | 'objectAlias'
  | 'set'
  | 'structuralRow'
  | 'task'
  | 'typedArray'
  | 'value'
  | 'weakMap';

export type CompilerCppReferenceRepresentationIdentityDomain = 'none' | 'object' | 'view';

export type CompilerCppReferenceRepresentationRefusalReason =
  | 'compoundReference'
  | 'indeterminateIdentity'
  | 'unsupportedAmbientReference'
  | 'unsupportedReferenceForm'
  | 'unresolvedReferenceRepresentation';

export type CompilerCppReferenceStorageRepresentation =
  | 'inlineValue'
  | 'rawAnonymousObject'
  | 'rawNamedObject'
  | 'runtimeManaged';

export type CompilerCppReferenceValueRepresentation = 'flightReference' | 'inlineValue' | 'runtimeReference';

export interface CompilerCppReferenceRepresentationSuccess {
  readonly category: CompilerCppReferenceRepresentationCategory;
  readonly identity: CompilerTypeValueIdentityAnalysis;
  readonly identityDomain: CompilerCppReferenceRepresentationIdentityDomain;
  readonly kind: 'represented';
  readonly schema: 'flight-compiler-cpp-reference-representation/1';
  readonly storageRepresentation: CompilerCppReferenceStorageRepresentation;
  readonly valueRepresentation: CompilerCppReferenceValueRepresentation;
}

export interface CompilerCppReferenceRepresentationRefusal {
  readonly identity: CompilerTypeValueIdentityAnalysis;
  readonly kind: 'refused';
  readonly reason: CompilerCppReferenceRepresentationRefusalReason;
  readonly schema: 'flight-compiler-cpp-reference-representation/1';
}

export type CompilerCppReferenceRepresentationPlan =
  | CompilerCppReferenceRepresentationRefusal
  | CompilerCppReferenceRepresentationSuccess;

export interface CompilerCppFacetReferencePlan {
  readonly base: IrType;
  readonly facet: IrType;
}

export interface CompilerCppConditionalFacetRulePlan {
  readonly facet: IrType;
  readonly path: readonly [string, ...string[]];
}

export interface CompilerCppConditionalFacetReferencePlan {
  readonly base: IrType;
  readonly check: IrType;
  readonly rules: readonly CompilerCppConditionalFacetRulePlan[];
}

export type CompilerCppStructuralRowPlan =
  | Readonly<{
      kind: 'merge';
      rows: readonly [CompilerCppStructuralRowPlan, CompilerCppStructuralRowPlan, ...CompilerCppStructuralRowPlan[]];
    }>
  | Readonly<{ kind: 'partial'; row: CompilerCppStructuralRowPlan }>
  | Readonly<{ kind: 'readonly'; row: CompilerCppStructuralRowPlan }>
  | Readonly<{ kind: 'required'; row: CompilerCppStructuralRowPlan }>
  | Readonly<{ kind: 'rowOf'; type: IrType }>
  | Readonly<{ kind: 'writable'; row: CompilerCppStructuralRowPlan }>;

export interface CompilerCppReferenceRepresentationPlanner {
  readonly plan: (type: Readonly<IrType>, module: Readonly<IrModule>) => CompilerCppReferenceRepresentationPlan;
  readonly resolveAlias: (type: Readonly<IrType>, module: Readonly<IrModule>) => Readonly<IrType> | undefined;
  readonly resolveConditionalFacetReference: (
    type: Readonly<IrType>,
    module: Readonly<IrModule>,
  ) => Readonly<CompilerCppConditionalFacetReferencePlan> | undefined;
  readonly resolveFacetReference: (
    type: Readonly<IrType>,
    module: Readonly<IrModule>,
  ) => Readonly<CompilerCppFacetReferencePlan> | undefined;
  // The result is a union when more than one branch survives, and the single surviving branch when
  // every other branch contradicts a member and is therefore `never`: `CollisionBuiltInShape3D &
  // { kind: 'capsule' }` is the capsule branch alone, not a one-member union.
  readonly resolveClosedIntersectionDistribution: (
    type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
    module: Readonly<IrModule>,
  ) => Readonly<IrType> | undefined;
  readonly resolveModule: (specifier: string, module: Readonly<IrModule>) => Readonly<IrModule> | undefined;
  readonly resolveModules: (specifier: string, module: Readonly<IrModule>) => readonly Readonly<IrModule>[];
  readonly resolveObjectShape: (
    type: Readonly<IrType>,
    module: Readonly<IrModule>,
  ) => readonly Readonly<IrObjectTypeProperty>[] | undefined;
  readonly resolveStructuralRow: (
    type: Readonly<IrType>,
    module: Readonly<IrModule>,
  ) => Readonly<CompilerCppStructuralRowPlan> | undefined;
  readonly schema: 'flight-compiler-cpp-reference-representation-planner/1';
}
