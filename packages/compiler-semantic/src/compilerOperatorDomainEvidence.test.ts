import type { IrType } from '../../compiler-types/src/index.js';
import { getIrTypeOperatorValueDomain } from './compilerOperatorDomainEvidence.js';

describe('getIrTypeOperatorValueDomain', () => {
  it('classifies primitive, literal, reference, nullish, and absent evidence', () => {
    expect(getIrTypeOperatorValueDomain({ kind: 'primitive', name: 'number' })).toBe('number');
    expect(getIrTypeOperatorValueDomain({ kind: 'primitive', name: 'void' })).toBe('undefined');
    expect(getIrTypeOperatorValueDomain({ kind: 'literal', value: 'flight' })).toBe('string');
    expect(getIrTypeOperatorValueDomain({ kind: 'literal', value: true })).toBe('boolean');
    expect(getIrTypeOperatorValueDomain({ kind: 'null' })).toBe('null');
    expect(getIrTypeOperatorValueDomain({ kind: 'undefined' })).toBe('undefined');
    expect(
      getIrTypeOperatorValueDomain({ element: { kind: 'primitive', name: 'number' }, kind: 'array', readonly: false }),
    ).toBe('object');
    expect(getIrTypeOperatorValueDomain({ kind: 'unknown', source: 'any' })).toBe('unknown');
    expect(getIrTypeOperatorValueDomain(undefined)).toBe('unknown');
  });

  it('preserves a common union domain and refuses mixed or unresolved unions', () => {
    const same: IrType = {
      kind: 'union',
      types: [
        { kind: 'literal', value: 1 },
        { kind: 'primitive', name: 'number' },
      ],
    };
    const mixed: IrType = {
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'number' },
        { kind: 'primitive', name: 'string' },
      ],
    };

    expect(getIrTypeOperatorValueDomain(same)).toBe('number');
    expect(getIrTypeOperatorValueDomain(mixed)).toBe('unknown');
    expect(
      getIrTypeOperatorValueDomain({
        kind: 'union',
        types: [
          { kind: 'unknown', source: 'unknown' },
          { kind: 'primitive', name: 'number' },
        ],
      }),
    ).toBe('unknown');
  });
});
