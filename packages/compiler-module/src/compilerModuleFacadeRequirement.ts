import type { IrBindingPattern, IrDeclaration, IrExport, IrModule } from '../../compiler-types/src/index.js';

export function hasCompilerModuleFacadeLoweringRequirement(module: Readonly<IrModule>): boolean {
  return module.exports.some(
    (exported) =>
      exported.kind !== 'local' ||
      !hasCompilerModuleFacadeDeclarationReflection(module.declarations, exported),
  );
}

function hasCompilerModuleFacadeBindingPattern(pattern: Readonly<IrBindingPattern>, bindingId: string): boolean {
  if (pattern.kind === 'binding') return pattern.binding.id === bindingId;
  return (
    (pattern.kind === 'array'
      ? pattern.elements.some(
          (element) => !!element && hasCompilerModuleFacadeBindingPattern(element.pattern, bindingId),
        )
      : pattern.properties.some((property) =>
          hasCompilerModuleFacadeBindingPattern(property.pattern, bindingId),
        )) ||
    (!!pattern.rest && hasCompilerModuleFacadeBindingPattern(pattern.rest, bindingId))
  );
}

function hasCompilerModuleFacadeDeclarationBinding(
  declaration: Readonly<IrDeclaration>,
  bindingId: string,
): boolean {
  if (declaration.kind !== 'variable') return declaration.binding.id === bindingId;
  return 'binding' in declaration
    ? declaration.binding.id === bindingId
    : hasCompilerModuleFacadeBindingPattern(declaration.pattern, bindingId);
}

function hasCompilerModuleFacadeDeclarationReflection(
  declarations: readonly Readonly<IrDeclaration>[],
  exported: Readonly<Extract<IrExport, { kind: 'local' }>>,
): boolean {
  if (exported.exported !== exported.binding.name) return false;
  const declaration = declarations.find(
    (candidate) => candidate.exported && hasCompilerModuleFacadeDeclarationBinding(candidate, exported.binding.id),
  );
  if (!declaration) return false;
  const typeOnly = declaration.kind === 'interface' || declaration.kind === 'typeAlias';
  return exported.typeOnly === typeOnly;
}
