import type { IrTypeBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

// A rest binding whose written type is Parameters<T> is not an array-valued rest parameter. It is a
// dependent projection of T's complete callable signature. Keeping that fact in target-neutral IR
// lets a variadic target preserve required, optional, and rest roles without guessing from the
// projected storage type or broadly erasing the parameter to `any[]`.
export interface IrDependentCallableParameterPackEvidence {
  readonly callable: IrTypeBindingIdentity;
  readonly constraint: Extract<IrType, { kind: 'function' }>;
  readonly kind: 'implementation' | 'parameters';
  readonly schema: 'flight-compiler-dependent-callable-pack/1';
}
