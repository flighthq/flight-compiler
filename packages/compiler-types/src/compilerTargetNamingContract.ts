import type { IrBindingIdentity, IrTypeBindingIdentity } from './compilerBindingIntermediateRepresentation.js';

export interface CompilerTargetNameCandidate {
  readonly disposition: CompilerTargetNameDisposition;
  readonly identity: string;
  readonly preferredName: string;
  readonly scope: string;
}

export type CompilerTargetNameDisposition = 'fixed' | 'renamable';

export type CompilerTargetNamePreference = (
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
) => Readonly<{ namespace: string; preferredName: string }>;

export interface CompilerTargetNameAllocation {
  readonly identity: string;
  readonly name: string;
  readonly scope: string;
}

export type CompilerTargetNameAllocationFailureCode = 'fixed-target-name-collision';

export interface CompilerTargetNameAllocationFailure extends Error {
  readonly code: CompilerTargetNameAllocationFailureCode;
  readonly identities: readonly string[];
  readonly kind: 'target-name-allocation';
  readonly scope: string;
  readonly targetName: string;
}
