export type IrClassConstructorInitialization =
  | Readonly<{ kind: 'explicit' }>
  | Readonly<{ kind: 'implicit-base' }>
  | Readonly<{ argumentForwarding: 'all'; kind: 'implicit-derived' }>;

export interface IrClassFieldInitialization {
  readonly fieldIndex: number;
  readonly timing: 'base-instance-binding' | 'class-evaluation' | 'derived-super-return';
  readonly value: 'initializer' | 'undefined';
}

export interface IrClassInitializationPlan {
  readonly constructor: IrClassConstructorInitialization;
  readonly fields: readonly IrClassFieldInitialization[];
  readonly schema: 'flight-compiler-class-initialization/1';
}

export type IrClassInitializationFailureCode = 'invalid-class-declaration' | 'invalid-class-field';

export interface IrClassInitializationFailure extends Error {
  readonly code: IrClassInitializationFailureCode;
  readonly kind: 'ir-class-initialization';
  readonly path: readonly (number | string)[];
}
