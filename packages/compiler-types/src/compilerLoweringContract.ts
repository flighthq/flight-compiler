import type { IrInterfaceDeclaration } from './compilerDeclarationIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerSourceIdentity } from './compilerSourceIdentity.js';
import type { IrTypeReference } from './compilerTypeIntermediateRepresentation.js';

export interface CompilerInterfaceInheritanceLoweringOptions {
  readonly eraseAmbientUtilityHeritage?:
    | ((reference: Readonly<IrTypeReference>, declaration: Readonly<IrInterfaceDeclaration>) => boolean)
    | undefined;
}

export type CompilerLoweringPassVerification =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{ kind: 'invalid'; reason: string }>;

export type CompilerLoweringPassVerificationDepth = 'idempotence' | 'output';

export interface CompilerLoweringPassExecutionOptions {
  readonly verificationDepth?: CompilerLoweringPassVerificationDepth;
}

export interface CompilerLoweringPass {
  readonly idempotent: boolean;
  readonly lowerIrModule: (module: Readonly<IrModule>) => IrModule;
  readonly name: string;
  readonly runsAfter: readonly string[];
  readonly verifyIrModule: (module: Readonly<IrModule>) => CompilerLoweringPassVerification;
}

export type CompilerLoweringFailureCode =
  | 'duplicate-pass-name'
  | 'invalid-pass-identity'
  | 'invalid-pass-order'
  | 'invalid-verification-depth'
  | 'malformed-ir'
  | 'non-idempotent-pass'
  | 'pass-execution-failed'
  | 'unsupported-ir';

export interface CompilerLoweringFailure extends Error, CompilerSourceIdentity {
  readonly code: CompilerLoweringFailureCode;
  readonly kind: 'compiler-lowering';
  readonly pass: string;
}
