import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerClosureBindingUseKind = 'read' | 'rebind' | 'referentMutation';

export interface CompilerClosureBindingUseEvidence {
  readonly kind: CompilerClosureBindingUseKind;
  readonly path: CompilerIrTraversalPath;
}

export type CompilerClosureCaptureLifetimeBoundary = 'closureEscape' | 'iteration' | 'moduleLifetime' | 'suspension';

export type CompilerClosureCaptureMutation = 'bindingAndReferent' | 'bindingReassigned' | 'none' | 'referentMutated';

export interface CompilerClosureCaptureOutsideMutationEvidence extends CompilerClosureBindingUseEvidence {
  readonly lexicalRelation: 'afterCreation' | 'beforeCreation';
}

export interface CompilerClosureCaptureEvidence {
  readonly binding: IrBindingIdentity;
  readonly declarationPath: CompilerIrTraversalPath;
  readonly lifetimeBoundaries: readonly CompilerClosureCaptureLifetimeBoundary[];
  readonly mutation: CompilerClosureCaptureMutation;
  readonly outsideMutations: readonly CompilerClosureCaptureOutsideMutationEvidence[];
  readonly uses: readonly CompilerClosureBindingUseEvidence[];
}

export type CompilerClosureOrigin =
  | Readonly<{ binding: IrBindingIdentity; kind: 'functionDeclaration' }>
  | Readonly<{ binding?: IrBindingIdentity | undefined; kind: 'functionExpression' }>
  | Readonly<{ classBinding: IrBindingIdentity; kind: 'classConstructor' }>
  | Readonly<{
      classBinding: IrBindingIdentity;
      kind: 'classMethod';
      method: string;
      static: boolean;
    }>;

export type CompilerClosureValueUseKind =
  | 'classStorage'
  | 'directInvocation'
  | 'discarded'
  | 'exported'
  | 'passedArgument'
  | 'returned'
  | 'storedAggregate'
  | 'storedAlias'
  | 'storedBinding'
  | 'storedProperty'
  | 'unknown';

export interface CompilerClosureValueUseEvidence {
  readonly kind: CompilerClosureValueUseKind;
  readonly path: CompilerIrTraversalPath;
}

export interface CompilerClosureEvidence {
  readonly async: boolean;
  readonly body: 'block' | 'expression';
  readonly captures: readonly CompilerClosureCaptureEvidence[];
  readonly escape: 'knownNonEscaping' | 'mayEscape';
  readonly origin: CompilerClosureOrigin;
  readonly path: CompilerIrTraversalPath;
  readonly selfReferences: readonly CompilerIrTraversalPath[];
  readonly suspensions: readonly CompilerIrTraversalPath[];
  readonly thisMode: 'dynamic' | 'lexical';
  readonly thisUses: readonly CompilerIrTraversalPath[];
  readonly valueUses: readonly CompilerClosureValueUseEvidence[];
}

export interface CompilerClosureModuleEvidence {
  readonly closures: readonly CompilerClosureEvidence[];
  readonly module: CompilerModuleIdentity;
  readonly schema: 'flight-compiler-closure-evidence/1';
}
