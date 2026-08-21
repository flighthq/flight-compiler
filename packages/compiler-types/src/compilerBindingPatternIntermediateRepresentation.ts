import type { IrBindingIdentity, IrBindingScope } from './compilerBindingIntermediateRepresentation.js';
import type { IrExpression } from './compilerExecutableIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export interface IrArrayBindingPattern extends CompilerSourceOrigin {
  readonly elements: ReadonlyArray<IrBindingPatternElement | undefined>;
  readonly kind: 'array';
  readonly rest?: IrBindingPattern | undefined;
  readonly scope: IrBindingScope;
}

export type IrBindingPattern = IrArrayBindingPattern | IrBindingPatternBinding;

export interface IrBindingPatternBinding {
  readonly binding: IrBindingIdentity;
  readonly kind: 'binding';
  readonly type?: IrType | undefined;
}

export interface IrBindingPatternElement {
  readonly initializer?: IrExpression | undefined;
  readonly pattern: IrBindingPattern;
}
