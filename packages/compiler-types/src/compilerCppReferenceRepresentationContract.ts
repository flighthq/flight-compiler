import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { IrObjectTypeProperty, IrType } from './compilerTypeIntermediateRepresentation.js';
import type { CompilerTypeValueIdentityAnalysis } from './compilerTypeValueIdentityContract.js';

export type CompilerCppReferenceRepresentationCategory =
  | 'anonymousObject'
  | 'array'
  | 'class'
  | 'date'
  | 'external'
  | 'interface'
  | 'map'
  | 'objectAlias'
  | 'set'
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

export interface CompilerCppReferenceRepresentationPlanner {
  readonly plan: (type: Readonly<IrType>, module: Readonly<IrModule>) => CompilerCppReferenceRepresentationPlan;
  readonly resolveAlias: (type: Readonly<IrType>, module: Readonly<IrModule>) => Readonly<IrType> | undefined;
  readonly resolveClosedIntersectionDistribution: (
    type: Readonly<Extract<IrType, { kind: 'intersection' }>>,
    module: Readonly<IrModule>,
  ) => Readonly<Extract<IrType, { kind: 'union' }>> | undefined;
  readonly resolveModule: (specifier: string, module: Readonly<IrModule>) => Readonly<IrModule> | undefined;
  readonly resolveModules: (specifier: string, module: Readonly<IrModule>) => readonly Readonly<IrModule>[];
  readonly resolveObjectShape: (
    type: Readonly<IrType>,
    module: Readonly<IrModule>,
  ) => readonly Readonly<IrObjectTypeProperty>[] | undefined;
  readonly schema: 'flight-compiler-cpp-reference-representation-planner/1';
}
