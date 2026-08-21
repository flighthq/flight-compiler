import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type IrIndexedReceiver =
  | 'array'
  | 'bigInt64Array'
  | 'bigUint64Array'
  | 'float32Array'
  | 'float64Array'
  | 'int16Array'
  | 'int32Array'
  | 'int8Array'
  | 'object'
  | 'string'
  | 'tuple'
  | 'uint16Array'
  | 'uint32Array'
  | 'uint8Array'
  | 'uint8ClampedArray'
  | 'unknown';

export interface IrElementAccessSemantics {
  readonly key: IrPropertyKeyCoercion;
  readonly optionalChain?: IrOptionalChainSemantics | undefined;
  readonly receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]];
}

export type IrPropertyKeyCoercion = 'number' | 'string' | 'symbol' | 'toPropertyKey';

export type IrTypedArrayElementWidth = 8 | 16 | 32 | 64;

export type IrTypedArrayReceiver = Exclude<IrIndexedReceiver, 'array' | 'object' | 'string' | 'tuple' | 'unknown'>;

export interface IrTypedArraySetSemantics {
  readonly receivers: readonly [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
}

export interface IrCallSemantics {
  readonly defaultParameters?: IrDefaultParameterCallSemantics | undefined;
  readonly optionalChain?: IrOptionalChainSemantics | undefined;
  readonly statementValue?: IrStatementValueCallSemantics | undefined;
  readonly typedArraySet?: IrTypedArraySetSemantics | undefined;
}

export interface IrStatementValueCallSemantics {
  readonly asyncContext: 'inherit';
  readonly completion: 'finalReturn';
  readonly thisBinding: 'lexical';
}

export interface IrOptionalChainSemantics {
  readonly receiverEvaluation: 'once';
  readonly receiverType: IrType;
  readonly result: 'undefined';
  readonly shortCircuit: 'nullish';
  readonly valueType: IrType;
}

export interface IrDefaultParameterCallSemantics {
  readonly defaulted: readonly number[];
  readonly omitted: readonly number[];
  readonly parameterCount: number;
  readonly providedArgumentCount: number | 'dynamic';
}
