import type { IrType } from '../../compiler-types/src/index.js';

// What an indexed read of a written type produces. Whether the read can also produce nothing is a
// property of the analysed program's own configuration, not of the written type, so it is not
// answered here: this is the element the collection holds, and a caller that needs to know whether
// the index was in range has to establish that separately.
export function getIrTypeIndexedElementEvidence(
  type: Readonly<IrType> | undefined,
  index: number | undefined,
): Readonly<IrType> | undefined {
  if (!type) return undefined;
  if (type.kind === 'array') return type.element;
  if (type.kind !== 'tuple' || index === undefined) return undefined;
  const element = type.elements[index];
  return element && !element.optional && !element.rest ? element.type : undefined;
}

// What a member of a written type is, without asking a checker that has no library types. The array
// and tuple `length` is the load-bearing case: `index < values.length` is ordinary code, and its
// operands were both unknown because `length` lives in `lib.es5.d.ts` rather than in the source.
//
// Only members the written type decides are answered. Anything else returns undefined so the caller
// keeps its unknown domain rather than inheriting a guess.
export function getIrTypeMemberEvidence(
  type: Readonly<IrType> | undefined,
  name: string,
): Readonly<IrType> | undefined {
  if (!type) return undefined;
  if (name === 'length' && (type.kind === 'array' || type.kind === 'tuple')) {
    return { kind: 'primitive', name: 'number' };
  }
  if (type.kind === 'object') {
    const property = type.properties.find((candidate) => candidate.name === name);
    // An optional property is not the property's type: reading it can produce undefined, and the
    // domain vocabulary has no way to say "number or undefined" without losing the distinction.
    return property && !property.optional ? property.type : undefined;
  }
  return undefined;
}
