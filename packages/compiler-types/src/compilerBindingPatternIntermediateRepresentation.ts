import type { IrPropertyKeyCoercion } from './compilerAccessSemanticIntermediateRepresentation.js';
import type { IrBindingIdentity, IrBindingScope } from './compilerBindingIntermediateRepresentation.js';
import type { IrExpression } from './compilerExecutableIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export interface IrArrayBindingPattern extends CompilerSourceOrigin {
  readonly elements: ReadonlyArray<IrBindingPatternElement | undefined>;
  readonly kind: 'array';
  readonly rest?: IrBindingPattern | undefined;
  readonly scope: IrBindingScope;
  readonly type?: IrType | undefined;
}

export type IrBindingPattern = IrArrayBindingPattern | IrBindingPatternBinding | IrObjectBindingPattern;

export interface IrBindingPatternBinding {
  readonly binding: IrBindingIdentity;
  readonly kind: 'binding';
  readonly type?: IrType | undefined;
}

export interface IrBindingPatternElement {
  readonly initializer?: IrExpression | undefined;
  readonly pattern: IrBindingPattern;
}

export interface IrObjectBindingPattern extends CompilerSourceOrigin {
  readonly kind: 'object';
  readonly properties: readonly IrObjectBindingPatternProperty[];
  readonly rest?: IrBindingPattern | undefined;
  readonly scope: IrBindingScope;
  readonly type?: IrType | undefined;
}

export type IrObjectBindingPatternKey =
  | Readonly<{ coercion: IrPropertyKeyCoercion; kind: 'computed'; expression: IrExpression }>
  | Readonly<{ kind: 'named'; name: string }>;

export interface IrObjectBindingPatternProperty {
  readonly initializer?: IrExpression | undefined;
  readonly key: IrObjectBindingPatternKey;
  readonly pattern: IrBindingPattern;
}
