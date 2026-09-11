import { normalizeCompilerStructuralValueCanonical } from '../../compiler-canonical-form/src/index.js';
import type { IrType } from '../../compiler-types/src/index.js';

export function getIrHomogeneousTupleElementTypeCpp(
  type: Readonly<IrType>,
): Readonly<IrType> | undefined {
  if (type.kind !== 'tuple' || type.elements.length === 0) return undefined;
  const first = type.elements[0]!;
  if (first.optional || first.rest) return undefined;
  const identity = normalizeCompilerStructuralValueCanonical(first.type);
  return type.elements.every(
    (element) =>
      !element.optional &&
      !element.rest &&
      normalizeCompilerStructuralValueCanonical(element.type) === identity,
  )
    ? first.type
    : undefined;
}
