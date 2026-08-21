import { compareTextCodeUnits } from './compilerTextOrder.js';

describe('compareTextCodeUnits', () => {
  it('orders equal, empty, prefix, case, and non-ASCII text by UTF-16 code units', () => {
    expect(compareTextCodeUnits('', '')).toBe(0);
    expect(compareTextCodeUnits('', 'a')).toBe(-1);
    expect(compareTextCodeUnits('a', '')).toBe(1);
    expect(compareTextCodeUnits('a', 'a')).toBe(0);
    expect(compareTextCodeUnits('a', 'aa')).toBe(-1);
    expect(compareTextCodeUnits('aa', 'a')).toBe(1);
    expect(['😀', 'é', 'aa', 'a', 'Z', 'A', ''].sort(compareTextCodeUnits)).toEqual([
      '',
      'A',
      'Z',
      'a',
      'aa',
      'é',
      '😀',
    ]);
  });

  it('is antisymmetric and transitive across representative compiler text', () => {
    const values = ['', 'A', 'Z', '_', 'a', 'aa', 'e\u0301', 'é', 'Ω', '😀'] as const;
    for (const left of values) {
      for (const right of values) {
        expect(compareTextCodeUnits(left, right) + compareTextCodeUnits(right, left)).toBe(0);
        for (const last of values) {
          if (compareTextCodeUnits(left, right) <= 0 && compareTextCodeUnits(right, last) <= 0) {
            expect(compareTextCodeUnits(left, last)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it('does not hide caller-owned Unicode normalization decisions', () => {
    const decomposed = 'e\u0301';
    const composed = 'é';

    expect(decomposed).not.toBe(composed);
    expect(compareTextCodeUnits(decomposed, composed)).toBe(-1);
    expect(compareTextCodeUnits(decomposed.normalize('NFC'), composed)).toBe(0);
  });
});
