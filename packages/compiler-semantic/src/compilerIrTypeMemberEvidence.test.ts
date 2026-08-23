import { describe, expect, it } from 'vitest';

import type { IrType } from '../../compiler-types/src/index.js';
import { getIrTypeIndexedElementEvidence, getIrTypeMemberEvidence } from './compilerIrTypeMemberEvidence.js';

describe('getIrTypeIndexedElementEvidence', () => {
  const array: IrType = { element: { kind: 'primitive', name: 'string' }, kind: 'array', readonly: true };
  const tuple: IrType = {
    elements: [
      { optional: false, rest: false, type: { kind: 'primitive', name: 'string' } },
      { optional: true, rest: false, type: { kind: 'primitive', name: 'number' } },
    ],
    kind: 'tuple',
    readonly: true,
  };

  it("answers an array's element whatever the index is, because every position holds it", () => {
    expect(getIrTypeIndexedElementEvidence(array, undefined)).toEqual({ kind: 'primitive', name: 'string' });
    expect(getIrTypeIndexedElementEvidence(array, 7)).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('answers a tuple position only when the index names one that always holds a value', () => {
    expect(getIrTypeIndexedElementEvidence(tuple, 0)).toEqual({ kind: 'primitive', name: 'string' });
    // Position 1 is optional, position 2 does not exist, and a computed index names no position.
    expect(getIrTypeIndexedElementEvidence(tuple, 1)).toBeUndefined();
    expect(getIrTypeIndexedElementEvidence(tuple, 2)).toBeUndefined();
    expect(getIrTypeIndexedElementEvidence(tuple, undefined)).toBeUndefined();
  });

  it('answers nothing for an absent type or one that holds no elements', () => {
    expect(getIrTypeIndexedElementEvidence(undefined, 0)).toBeUndefined();
    expect(getIrTypeIndexedElementEvidence({ kind: 'primitive', name: 'string' }, 0)).toBeUndefined();
  });
});

describe('getIrTypeMemberEvidence', () => {
  it('answers the length of an array or tuple, which the library would otherwise have to', () => {
    const array: IrType = { element: { kind: 'primitive', name: 'number' }, kind: 'array', readonly: true };
    const tuple: IrType = {
      elements: [{ optional: false, rest: false, type: { kind: 'primitive', name: 'number' } }],
      kind: 'tuple',
      readonly: false,
    };

    expect(getIrTypeMemberEvidence(array, 'length')).toEqual({ kind: 'primitive', name: 'number' });
    expect(getIrTypeMemberEvidence(tuple, 'length')).toEqual({ kind: 'primitive', name: 'number' });
  });

  it('answers a written object property, and refuses to answer an optional one', () => {
    const object: IrType = {
      kind: 'object',
      properties: [
        { name: 'width', optional: false, readonly: false, type: { kind: 'primitive', name: 'number' } },
        { name: 'label', optional: true, readonly: false, type: { kind: 'primitive', name: 'string' } },
      ],
    };

    expect(getIrTypeMemberEvidence(object, 'width')).toEqual({ kind: 'primitive', name: 'number' });
    // Reading an optional property can produce undefined, and the domain vocabulary cannot say
    // "string or undefined" without losing the distinction that makes nullability refusals correct.
    expect(getIrTypeMemberEvidence(object, 'label')).toBeUndefined();
  });

  it('claims nothing for a member the written type does not decide', () => {
    const array: IrType = { element: { kind: 'primitive', name: 'number' }, kind: 'array', readonly: true };
    const object: IrType = { kind: 'object', properties: [] };

    expect(getIrTypeMemberEvidence(array, 'push')).toBeUndefined();
    expect(getIrTypeMemberEvidence(object, 'missing')).toBeUndefined();
    expect(getIrTypeMemberEvidence({ kind: 'primitive', name: 'number' }, 'length')).toBeUndefined();
    expect(getIrTypeMemberEvidence(undefined, 'length')).toBeUndefined();
  });
});
