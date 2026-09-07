import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type { IrModule, IrType } from '../../compiler-types/src/index.js';

// Which bindings can hold an absent value.
//
// A target with one absent value can compare `x === undefined` directly, but comparing is not
// narrowing: after the comparison the source's type system knows the value is present and the neutral
// model does not. Emitting the later use anyway produces target source that does not compile, which
// pinning bytes cannot catch — so a backend refuses that flow until narrowing evidence exists, and
// this is the set it refuses on.
export function collectIrModuleNullableBindingIds(module: Readonly<IrModule>): ReadonlySet<string> {
  const nullable = new Set<string>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      if ((parameter.optional && !parameter.initializer) || hasIrTypeAbsentMember(parameter.type))
        nullable.add(parameter.binding.id);
      return undefined;
    },
    variable(variable) {
      if ('binding' in variable && hasIrTypeAbsentMember(variable.type)) nullable.add(variable.binding.id);
      return undefined;
    },
  });
  return nullable;
}

export function hasIrTypeAbsentMember(type: Readonly<IrType> | undefined): boolean {
  if (!type) return false;
  if (type.kind === 'null' || type.kind === 'undefined') return true;
  return type.kind === 'union' && type.types.some((member) => hasIrTypeAbsentMember(member));
}
