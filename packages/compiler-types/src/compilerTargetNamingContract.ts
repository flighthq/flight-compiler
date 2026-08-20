import type { IrBindingIdentity, IrTypeBindingIdentity } from './compilerBindingIntermediateRepresentation.js';

export interface CompilerTargetNameCandidate {
  readonly identity: string;
  readonly preferredName: string;
  readonly scope: string;
}

export type CompilerTargetNamePreference = (
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
) => Readonly<{ namespace: string; preferredName: string }>;

export interface CompilerTargetNameAllocation {
  readonly identity: string;
  readonly name: string;
  readonly scope: string;
}
