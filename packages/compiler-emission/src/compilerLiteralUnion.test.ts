import { describe, expect, it } from 'vitest';

import type { IrType } from '../../compiler-types/src/index.js';
import { getIrUnionTypeStringLiteralValues } from './compilerLiteralUnion.js';

describe('getIrUnionTypeStringLiteralValues', () => {
  it('reads the names a union of string literals is closed over, in the order written', () => {
    expect(getIrUnionTypeStringLiteralValues(union([literal('fast'), literal('safe')]))).toEqual(['fast', 'safe']);
  });

  it('answers nothing for a union that is not a closed set of names', () => {
    // One member that is not a string literal means the union is not a set of names, and describing
    // it as one would be wrong rather than imprecise.
    expect(
      getIrUnionTypeStringLiteralValues(union([literal('fast'), { kind: 'primitive', name: 'string' }])),
    ).toBeUndefined();
    expect(getIrUnionTypeStringLiteralValues(union([literal('fast'), literal(1)]))).toBeUndefined();
    // A single-member union is the member, and a repeated name is not a set.
    expect(getIrUnionTypeStringLiteralValues(union([literal('only')]))).toBeUndefined();
    expect(getIrUnionTypeStringLiteralValues(union([literal('same'), literal('same')]))).toBeUndefined();
  });

  it('answers nothing for a type that is not a union at all', () => {
    expect(getIrUnionTypeStringLiteralValues({ kind: 'primitive', name: 'string' })).toBeUndefined();
    expect(getIrUnionTypeStringLiteralValues(literal('alone'))).toBeUndefined();
  });
});

function literal(value: boolean | number | string): IrType {
  return { kind: 'literal', value };
}

function union(types: readonly [IrType, IrType, ...IrType[]] | readonly [IrType]): IrType {
  return { kind: 'union', types: types as readonly [IrType, IrType, ...IrType[]] };
}
