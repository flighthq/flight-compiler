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
});
