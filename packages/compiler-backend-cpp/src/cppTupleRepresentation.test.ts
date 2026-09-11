import { describe, expect, it } from 'vitest';

import type { IrType } from '../../compiler-types/src/index.js';
import { getIrHomogeneousTupleElementTypeCpp } from './cppTupleRepresentation.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const stringType = { kind: 'primitive', name: 'string' } as const satisfies IrType;

describe('getIrHomogeneousTupleElementTypeCpp', () => {
  it('returns the shared element type for a nonempty required homogeneous tuple', () => {
    expect(
      getIrHomogeneousTupleElementTypeCpp({
        elements: [
          { optional: false, rest: false, type: numberType },
          { optional: false, rest: false, type: numberType },
        ],
        kind: 'tuple',
        readonly: true,
      }),
    ).toEqual(numberType);
  });

  it('rejects empty, heterogeneous, optional, and rest tuples', () => {
    expect(getIrHomogeneousTupleElementTypeCpp({ elements: [], kind: 'tuple', readonly: false })).toBeUndefined();
    expect(
      getIrHomogeneousTupleElementTypeCpp({
        elements: [
          { optional: false, rest: false, type: numberType },
          { optional: false, rest: false, type: stringType },
        ],
        kind: 'tuple',
        readonly: false,
      }),
    ).toBeUndefined();
    expect(
      getIrHomogeneousTupleElementTypeCpp({
        elements: [{ optional: true, rest: false, type: numberType }],
        kind: 'tuple',
        readonly: false,
      }),
    ).toBeUndefined();
    expect(
      getIrHomogeneousTupleElementTypeCpp({
        elements: [{ optional: false, rest: true, type: numberType }],
        kind: 'tuple',
        readonly: false,
      }),
    ).toBeUndefined();
  });
});
