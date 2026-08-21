import type { IrOperatorValueDomain, IrType } from '../../compiler-types/src/index.js';

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
