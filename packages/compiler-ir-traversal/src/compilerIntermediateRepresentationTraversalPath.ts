import type { CompilerIrTraversalPath, IrModule } from '../../compiler-types/src/index.js';

export function getIrModuleTraversalPathValue(module: Readonly<IrModule>, path: CompilerIrTraversalPath): unknown {
  let value: unknown = module;
  for (const segment of path) {
    if (!isIrTraversalPathContainer(value) || !(segment in value)) {
      throw new TypeError(`IR traversal path does not resolve at ${JSON.stringify(path)}`);
    }
    value = value[segment];
  }
  return value;
}

function isIrTraversalPathContainer(value: unknown): value is Record<number | string, unknown> {
  return typeof value === 'object' && value !== null;
}
