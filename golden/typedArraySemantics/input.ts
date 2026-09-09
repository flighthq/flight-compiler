export function signedRangeConstruction(): Int8Array {
  const zero: number = 0;
  const values: Int8Array = new Int8Array([130, -129, zero / zero, 1 / zero]);
  return values;
}

export function unsignedModuloWrites(): Uint8Array {
  const values: Uint8Array = new Uint8Array(5);
  values[0] = 300;
  values[1] = -1;
  values[2] = 1;
  values[2] += 257;
  values[3] = 255;
  values[3] += 2;
  values[4] = 250;
  values[4] %= 64;
  return values;
}

export function clampedTies(): Uint8ClampedArray {
  const values: Uint8ClampedArray = new Uint8ClampedArray(6);
  values[0] = 0.5;
  values[1] = 1.5;
  values[2] = 2.5;
  values[3] = 3.5;
  values[4] = 254.5;
  values[5] = 255.5;
  return values;
}

export function float32Overflow(): Float32Array {
  const values: Float32Array = new Float32Array(2);
  values[0] = 3.5e38;
  values[1] = -3.5e38;
  return values;
}

export function subarrayAliasesStorage(): Uint8Array {
  const source: Uint8Array = new Uint8Array([1, 2, 3, 4]);
  const view: Uint8Array = source.subarray(1, 3);
  view[0] = 9;
  source[2] = 8;
  return source;
}

export function sliceCopiesStorage(): Uint8Array {
  const source: Uint8Array = new Uint8Array([1, 2, 3, 4]);
  const copy: Uint8Array = source.slice(1, 3);
  copy[0] = 9;
  source[2] = 8;
  return copy;
}

export function viewsHaveDistinctIdentity(): boolean {
  const source: Uint8Array = new Uint8Array([1, 2]);
  return source.subarray(0) !== source && source.slice(0) !== source && source.subarray(0) !== source.subarray(0);
}
