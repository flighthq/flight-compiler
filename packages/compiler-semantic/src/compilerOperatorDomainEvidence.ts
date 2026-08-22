import type { IrBinaryOperator, IrOperatorValueDomain, IrType } from '../../compiler-types/src/index.js';

// The analysis checker runs with `noLib`, so it often cannot type a whole binary expression even
// when both operands are known. The result of an operator over known operand domains is a property
// of the source language rather than of any target, so it belongs here rather than in a backend.
export function getIrBinaryOperatorResultDomain(
  operator: IrBinaryOperator,
  left: IrOperatorValueDomain,
  right: IrOperatorValueDomain,
): IrOperatorValueDomain {
  switch (operator) {
    case '+':
      return left === right && (left === 'number' || left === 'string' || left === 'bigint') ? left : 'unknown';
    case '%':
    case '*':
    case '-':
    case '/':
    case '**':
      return left === right && (left === 'number' || left === 'bigint') ? left : 'unknown';
    case '&':
    case '<<':
    case '>>':
    case '>>>':
    case '^':
    case '|':
      return left === 'number' && right === 'number' ? 'number' : 'unknown';
    case '!=':
    case '!==':
    case '<':
    case '<=':
    case '==':
    case '===':
    case '>':
    case '>=':
      return left === right && left !== 'unknown' ? 'boolean' : 'unknown';
    case 'in':
    case 'instanceof':
      return 'boolean';
    case '&&':
    case '||':
      return left === right ? left : 'unknown';
    case ',':
      return right;
    case '??':
      // `a ?? b` yields `a` with its absent values removed, or `b`. Where those agree, so does the
      // result; the caller supplies the left operand's present-value domain.
      return left === right ? left : 'unknown';
  }
}

export function getIrTypeOperatorValueDomain(type: Readonly<IrType> | undefined): IrOperatorValueDomain {
  if (!type) return 'unknown';
  switch (type.kind) {
    case 'array':
    case 'function':
    case 'object':
    case 'tuple':
      return 'object';
    case 'literal':
      return typeof type.value === 'boolean' ? 'boolean' : typeof type.value === 'number' ? 'number' : 'string';
    case 'null':
      return 'null';
    case 'primitive':
      return type.name === 'void' ? 'undefined' : type.name;
    case 'undefined':
      return 'undefined';
    case 'union': {
      const domains = new Set(type.types.map(getIrTypeOperatorValueDomain));
      return domains.size === 1 ? [...domains][0]! : 'unknown';
    }
    case 'indexedAccess':
    case 'intersection':
    case 'keyof':
    case 'named':
    case 'never':
    case 'typeOf':
    case 'unknown':
      return 'unknown';
  }
}
