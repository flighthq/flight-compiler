import type { IrObjectCopySemantics } from '../../compiler-types/src/index.js';

export function createIrObjectCopySemantics(): IrObjectCopySemantics {
  return Object.freeze({
    evaluation: 'left-to-right-once',
    nullish: 'skip',
    overwrite: 'replace-value-preserve-key-position',
    propertyKeys: 'own-enumerable-string-and-symbol',
    propertyReads: 'get-once-in-own-key-order',
    targetWrites: 'create-data-property',
  });
}
