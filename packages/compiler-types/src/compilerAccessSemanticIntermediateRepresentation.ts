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
  readonly receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]];
}

export type IrTypedArrayElementWidth = 8 | 16 | 32 | 64;

export type IrTypedArrayReceiver = Exclude<IrIndexedReceiver, 'array' | 'object' | 'string' | 'tuple' | 'unknown'>;

export interface IrTypedArraySetSemantics {
  readonly receivers: readonly [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
}

export interface IrCallSemantics {
  readonly typedArraySet?: IrTypedArraySetSemantics | undefined;
}
