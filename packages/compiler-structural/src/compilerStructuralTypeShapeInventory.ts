import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerStructuralTypeShape,
  CompilerStructuralTypeShapeIdentity,
  CompilerStructuralTypeShapeInventory,
  CompilerStructuralTypeShapeOccurrence,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createIrObjectTypeShapeIdentity } from './compilerStructuralTypeShapeIdentity.js';

export function collectIrModulesStructuralTypeShapes(
  modules: readonly Readonly<IrModule>[],
): CompilerStructuralTypeShapeInventory {
  const occurrences = new Map<
    CompilerStructuralTypeShapeIdentity,
    Map<string, CompilerStructuralTypeShapeOccurrence>
  >();
  for (const module of modules) {
    analyzeIrModuleTraversal(module, {
      type(type, path) {
        if (type.kind !== 'object') return;
        const identity = createIrObjectTypeShapeIdentity(type.properties);
        const occurrence = Object.freeze({
          name: module.name,
          packageName: module.packageName,
          path: Object.freeze([...path]),
          source: module.source,
        });
        const identityOccurrences = occurrences.get(identity) ?? new Map();
        identityOccurrences.set(createCompilerStructuralTypeOccurrenceKey(occurrence), occurrence);
        occurrences.set(identity, identityOccurrences);
      },
    });
  }
  const shapes: CompilerStructuralTypeShape[] = [...occurrences]
    .sort(([left], [right]) => compareTextCodeUnits(left, right))
    .map(([identity, identityOccurrences]) =>
      Object.freeze({
        identity,
        occurrences: Object.freeze([...identityOccurrences.values()].sort(compareCompilerStructuralTypeOccurrences)),
      }),
    );
  return Object.freeze({
    modules: modules.length,
    schema: 'flight-compiler-structural-type-shapes/1',
    shapes: Object.freeze(shapes),
  });
}

function compareCompilerStructuralTypeOccurrences(
  left: Readonly<CompilerStructuralTypeShapeOccurrence>,
  right: Readonly<CompilerStructuralTypeShapeOccurrence>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    compareTextCodeUnits(left.name, right.name) ||
    compareTextCodeUnits(
      normalizeCompilerStructuralValueCanonical(left.path),
      normalizeCompilerStructuralValueCanonical(right.path),
    )
  );
}

function createCompilerStructuralTypeOccurrenceKey(
  occurrence: Readonly<CompilerStructuralTypeShapeOccurrence>,
): string {
  return normalizeCompilerStructuralValueCanonical([
    occurrence.packageName,
    occurrence.source,
    occurrence.name,
    occurrence.path,
  ]);
}
