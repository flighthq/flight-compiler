import { createIrObjectCopySemantics } from './compilerStructuralObjectCopySemantics.js';

describe('createIrObjectCopySemantics', () => {
  it('defines JavaScript object-copy evaluation, enumeration, read, write, and overwrite behavior', () => {
    expect(createIrObjectCopySemantics()).toEqual({
      evaluation: 'left-to-right-once',
      nullish: 'skip',
      overwrite: 'replace-value-preserve-key-position',
      propertyKeys: 'own-enumerable-string-and-symbol',
      propertyReads: 'get-once-in-own-key-order',
      targetWrites: 'create-data-property',
    });
  });

  it('returns independent immutable records', () => {
    const first = createIrObjectCopySemantics();
    const second = createIrObjectCopySemantics();

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => Object.assign(first, { nullish: 'copy' })).toThrow(TypeError);
    expect(second.nullish).toBe('skip');
  });
});
