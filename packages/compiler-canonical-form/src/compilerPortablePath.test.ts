import { normalizePathPortable } from './compilerPortablePath.js';

describe('normalizePathPortable', () => {
  it('canonicalizes every separator spelling independently of the host platform', () => {
    expect(normalizePathPortable('packages\\math/src\\value.ts')).toBe('packages/math/src/value.ts');
    expect(normalizePathPortable('packages/math/src/value.ts')).toBe('packages/math/src/value.ts');
    expect(normalizePathPortable('C:\\source\\value.ts')).toBe('C:/source/value.ts');
  });

  it('is idempotent for empty, mixed, and repeated separators', () => {
    for (const value of ['', '/', 'one\\two/three', 'one\\\\two']) {
      const normalized = normalizePathPortable(value);
      expect(normalizePathPortable(normalized)).toBe(normalized);
    }
    expect(normalizePathPortable('one\\\\two')).toBe('one//two');
  });

  it('does not apply path resolution or Unicode identity policy', () => {
    const decomposed = 'cafe\u0301';

    expect(normalizePathPortable(`one\\..\\${decomposed}.ts`)).toBe(`one/../${decomposed}.ts`);
    expect(normalizePathPortable(decomposed)).not.toBe(decomposed.normalize('NFC'));
  });
});
