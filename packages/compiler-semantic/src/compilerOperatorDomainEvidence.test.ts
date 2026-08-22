import type { IrType } from '../../compiler-types/src/index.js';
import { getIrBinaryOperatorResultDomain, getIrTypeOperatorValueDomain } from './compilerOperatorDomainEvidence.js';

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

describe('getIrBinaryOperatorResultDomain', () => {
  it('derives a result only where the operator and both operand domains decide one', () => {
    expect(getIrBinaryOperatorResultDomain('+', 'number', 'number')).toBe('number');
    expect(getIrBinaryOperatorResultDomain('+', 'string', 'string')).toBe('string');
    expect(getIrBinaryOperatorResultDomain('+', 'bigint', 'bigint')).toBe('bigint');
    expect(getIrBinaryOperatorResultDomain('-', 'number', 'number')).toBe('number');
    expect(getIrBinaryOperatorResultDomain('<', 'number', 'number')).toBe('boolean');
    expect(getIrBinaryOperatorResultDomain('&&', 'boolean', 'boolean')).toBe('boolean');
    expect(getIrBinaryOperatorResultDomain('|', 'number', 'number')).toBe('number');
    expect(getIrBinaryOperatorResultDomain('in', 'string', 'object')).toBe('boolean');
    expect(getIrBinaryOperatorResultDomain(',', 'number', 'string')).toBe('string');
  });

  it('reports unknown wherever the source language does not decide, rather than guessing', () => {
    // `+` over mixed domains is the coercion case a target must lower deliberately, and `??` depends
    // on nullability the domain vocabulary does not carry.
    expect(getIrBinaryOperatorResultDomain('+', 'number', 'string')).toBe('unknown');
    expect(getIrBinaryOperatorResultDomain('+', 'object', 'object')).toBe('unknown');
    expect(getIrBinaryOperatorResultDomain('-', 'string', 'string')).toBe('unknown');
    expect(getIrBinaryOperatorResultDomain('<', 'unknown', 'unknown')).toBe('unknown');
    expect(getIrBinaryOperatorResultDomain('|', 'bigint', 'bigint')).toBe('unknown');
    expect(getIrBinaryOperatorResultDomain('??', 'number', 'number')).toBe('unknown');
  });
});
