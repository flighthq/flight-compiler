import { describe, expect, it } from 'vitest';

import type { IrType } from '../../compiler-types/src/index.js';
import { getIrTypeMemberEvidence } from './compilerIrTypeMemberEvidence.js';

describe('getIrTypeMemberEvidence', () => {
  it('answers the length of an array or tuple, which the library would otherwise have to', () => {
    const array: IrType = { element: { kind: 'primitive', name: 'number' }, kind: 'array', readonly: true };
    const tuple: IrType = {
      elements: [{ optional: false, rest: false, type: { kind: 'primitive', name: 'number' } }],
      kind: 'tuple',
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
