import { normalizeCompilerStructuralValueCanonical } from './compilerStructuralValue.js';

describe('normalizeCompilerStructuralValueCanonical', () => {
  it('sorts object keys while preserving array order, scalar domains, and negative zero', () => {
    const first = { nested: [{ right: undefined, left: -0 }], value: true };
    const second = { value: true, nested: [{ left: -0, right: undefined }] };
    const firstKeys = Object.keys(first);

    expect(normalizeCompilerStructuralValueCanonical(first)).toBe(normalizeCompilerStructuralValueCanonical(second));
    expect(normalizeCompilerStructuralValueCanonical([1, 2])).not.toBe(
      normalizeCompilerStructuralValueCanonical([2, 1]),
    );
    expect(normalizeCompilerStructuralValueCanonical(-0)).not.toBe(normalizeCompilerStructuralValueCanonical(0));
    expect(normalizeCompilerStructuralValueCanonical(null)).not.toBe(normalizeCompilerStructuralValueCanonical('null'));
    expect(normalizeCompilerStructuralValueCanonical({})).not.toBe(normalizeCompilerStructuralValueCanonical([]));
    expect(Object.keys(first)).toEqual(firstKeys);
  });

  it('rejects non-finite, non-structural, prototype-bearing, and cyclic values', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 1;
    const named: unknown[] = [];
    Object.assign(named, { property: true });
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, 'value', { enumerable: false, value: 1 });
    const symbolic = { [Symbol('value')]: 1 };

    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol('value'),
      () => 1,
      new Date(),
      cyclic,
      sparse,
      named,
      accessor,
      hidden,
      symbolic,
    ]) {
      expect(() => normalizeCompilerStructuralValueCanonical(value)).toThrow(TypeError);
    }
  });

  it('rejects arrays with an accessor at a valid index even when indices and length are intact', () => {
    const withAccessor: unknown[] = [1, 2, 3];
    Object.defineProperty(withAccessor, '1', { get: () => 2, enumerable: true, configurable: true });
    expect(() => normalizeCompilerStructuralValueCanonical(withAccessor)).toThrow(TypeError);
  });

  it('rejects arrays with a non-enumerable own property even when indices are intact', () => {
    const withHidden: unknown[] = [1];
    Object.defineProperty(withHidden, 'secret', { value: 42, enumerable: false });
    expect(() => normalizeCompilerStructuralValueCanonical(withHidden)).toThrow(TypeError);
  });

  it('rejects arrays with a non-enumerable index leaving a gap in Object.keys', () => {
    const withHiddenIndex: unknown[] = [1, 2, 3];
    Object.defineProperty(withHiddenIndex, '2', { value: 3, enumerable: false });
    expect(() => normalizeCompilerStructuralValueCanonical(withHiddenIndex)).toThrow(TypeError);
  });
});
