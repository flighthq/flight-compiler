export type IrClassConstructorInitialization =
  | Readonly<{ kind: 'explicit' }>
  | Readonly<{ kind: 'implicit-base' }>
  | Readonly<{ argumentForwarding: 'all'; kind: 'implicit-derived' }>;

export type IrClassFieldInitialization = Readonly<{ fieldIndex: number }> &
  (
    | Readonly<{
        timing: 'base-instance-binding' | 'class-evaluation' | 'derived-super-return';
        value: 'initializer' | 'undefined';
      }>
    | Readonly<{
        parameterIndex: number;
        timing: 'base-constructor-body-entry' | 'derived-super-return-after-fields';
        value: 'parameter';
      }>
  );

export interface IrClassInitializationPlan {
  readonly constructor: IrClassConstructorInitialization;
  readonly fields: readonly IrClassFieldInitialization[];
  readonly schema: 'flight-compiler-class-initialization/1';
}

export type IrClassInitializationFailureCode =
  | 'invalid-class-declaration'
  | 'invalid-class-field'
  | 'invalid-parameter-property';

export interface IrClassInitializationFailure extends Error {
  readonly code: IrClassInitializationFailureCode;
  readonly kind: 'ir-class-initialization';
  readonly path: readonly (number | string)[];
}
