import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
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

export interface IrInvocationSemantics {
  readonly defaultParameters?: IrDefaultParameterInvocationSemantics | undefined;
  readonly optionalParameters?: IrOptionalParameterInvocationSemantics | undefined;
  readonly overloadImplementation?: IrOverloadImplementationInvocationSemantics | undefined;
  readonly signature?: IrInvocationSignatureSemantics | undefined;
}

export interface IrInvocationSignatureSemantics {
  readonly parameterCount: number;
  readonly providedArgumentCount: number | 'dynamic';
  readonly restParameter?: number | undefined;
}

export interface IrCallSemantics extends IrInvocationSemantics {
  readonly extraArguments?: IrExtraArgumentErasureSemantics | undefined;
  readonly optionalChain?: IrOptionalChainSemantics | undefined;
  // The checker-resolved result belongs to the call rather than its callee: overload selection,
  // generic instantiation, and ambient methods can all make two calls through the same written
  // member produce different types. Backends use this evidence to preserve result containers such
  // as `T | undefined` without re-resolving source declarations or guessing from member names.
  readonly resultType: IrType;
  readonly statementValue?: IrStatementValueCallSemantics | undefined;
  readonly typedArraySet?: IrTypedArraySetSemantics | undefined;
}

export interface IrExtraArgumentErasureSemantics {
  readonly argumentBindings: readonly IrBindingIdentity[];
  readonly resultType: IrType;
}

export interface IrOverloadImplementationInvocationSemantics {
  readonly implementationParameterCount: number;
  readonly overloadIndex: number;
  readonly resolvedParameterCount: number;
}

export interface IrOptionalParameterInvocationSemantics {
  readonly omitted: readonly number[];
  readonly optional: readonly number[];
  readonly parameterCount: number;
  readonly provided: readonly IrParameterProvidedArgumentInvocationSemantics[];
  readonly providedArgumentCount: number | 'dynamic';
}

export type IrInvocationArgumentValue = 'null' | 'undefined' | 'value';

export interface IrParameterProvidedArgumentInvocationSemantics {
  readonly argumentType: IrType;
  readonly parameterType: IrType;
  readonly position: number;
  readonly value: IrInvocationArgumentValue;
}

export interface IrStatementValueCallSemantics {
  readonly abruptCompletion: 'propagate';
  readonly asyncContext: 'inherit';
  readonly normalCompletion: 'final-return-value';
  readonly thisBinding: 'lexical';
}

export interface IrOptionalChainSemantics {
  readonly receiverEvaluation: 'once';
  readonly receiverNullish: 'excluded' | 'possible';
  readonly receiverType: IrType;
  readonly result: 'undefined';
  readonly shortCircuit: 'nullish';
  readonly valueType: IrType;
}

export interface IrDefaultParameterInvocationSemantics {
  readonly defaulted: readonly number[];
  readonly omitted: readonly number[];
  readonly parameterCount: number;
  readonly provided: readonly IrParameterProvidedArgumentInvocationSemantics[];
  readonly providedArgumentCount: number | 'dynamic';
}
