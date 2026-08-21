import { isDeepStrictEqual } from 'node:util';

import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectTypeProperty,
  IrType,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrTypeReference,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

interface InterfaceInheritanceLoweringContext {
  readonly interfaces: ReadonlyMap<string, Readonly<IrInterfaceDeclaration>>;
  readonly module: Readonly<IrModule>;
}

const compilerLoweringPassNameInterfaceInheritance = 'interface-inheritance';

export function createCompilerLoweringPassInterfaceInheritance(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: lowerIrModuleInterfaceInheritance,
    name: compilerLoweringPassNameInterfaceInheritance,
    runsAfter: [],
    verifyIrModule(module) {
      let inherited = false;
      analyzeIrModuleTraversal(module, {
        declaration(declaration) {
          if (declaration.kind === 'interface' && declaration.extends.length > 0) inherited = true;
        },
      });
      return inherited
        ? { kind: 'invalid', reason: 'interface inheritance remains after structural flattening' }
        : { kind: 'valid' };
    },
  };
}

function lowerIrModuleInterfaceInheritance(module: Readonly<IrModule>): IrModule {
  const interfaces = new Map(
    module.declarations.flatMap((declaration) =>
      declaration.kind === 'interface' ? [[declaration.binding.id, declaration] as const] : [],
    ),
  );
  const context: InterfaceInheritanceLoweringContext = { interfaces, module };
  return {
    ...module,
    declarations: module.declarations.map((declaration) =>
      declaration.kind === 'interface' ? lowerIrInterfaceDeclarationInheritance(declaration, context) : declaration,
    ),
  };
}

function lowerIrInterfaceDeclarationInheritance(
  declaration: Readonly<IrInterfaceDeclaration>,
  context: InterfaceInheritanceLoweringContext,
): IrInterfaceDeclaration {
  const inherited = declaration.extends.length > 0;
  const properties = getIrInterfaceDeclarationPropertiesFlattened(declaration, new Map(), new Set(), context);
  return {
    ...declaration,
    extends: [],
    properties: inherited
      ? properties.map((property, index) => rebindIrInterfacePropertyTypeParameters(property, declaration, index))
      : properties,
  };
}

function getIrInterfaceDeclarationPropertiesFlattened(
  declaration: Readonly<IrInterfaceDeclaration>,
  substitutions: ReadonlyMap<string, Readonly<IrType>>,
  ancestors: ReadonlySet<string>,
  context: InterfaceInheritanceLoweringContext,
): readonly IrObjectTypeProperty[] {
  if (ancestors.has(declaration.binding.id)) {
    failIrInterfaceInheritanceLowering(
      context.module,
      `interface ${declaration.binding.name} has cyclic structural inheritance`,
    );
  }
  const nextAncestors = new Set(ancestors).add(declaration.binding.id);
  const properties: IrObjectTypeProperty[] = [];
  for (const reference of declaration.extends) {
    const base = getIrInterfaceDeclarationBase(reference, declaration, context);
    const baseSubstitutions = getIrInterfaceTypeSubstitutions(reference, base, substitutions, context);
    for (const property of getIrInterfaceDeclarationPropertiesFlattened(
      base,
      baseSubstitutions,
      nextAncestors,
      context,
    )) {
      addIrInterfacePropertyFlattened(property, declaration, properties, context);
    }
  }
  for (const property of declaration.properties) {
    addIrInterfacePropertyFlattened(
      { ...property, type: substituteIrTypeInterfaceInheritance(property.type, substitutions) },
      declaration,
      properties,
      context,
    );
  }
  return properties;
}

function getIrInterfaceDeclarationBase(
  reference: Readonly<IrTypeReference>,
  declaration: Readonly<IrInterfaceDeclaration>,
  context: InterfaceInheritanceLoweringContext,
): Readonly<IrInterfaceDeclaration> {
  if (reference.reference.kind !== 'binding' || reference.reference.path.length > 0) {
    return failIrInterfaceInheritanceLowering(
      context.module,
      `interface ${declaration.binding.name} inherits a nonlocal interface that cannot be structurally resolved`,
    );
  }
  const base = context.interfaces.get(reference.reference.binding.id);
  if (!base) {
    return failIrInterfaceInheritanceLowering(
      context.module,
      `interface ${declaration.binding.name} inherits unavailable interface ${reference.reference.binding.name}`,
    );
  }
  return base;
}

function getIrInterfaceTypeSubstitutions(
  reference: Readonly<IrTypeReference>,
  declaration: Readonly<IrInterfaceDeclaration>,
  outerSubstitutions: ReadonlyMap<string, Readonly<IrType>>,
  context: InterfaceInheritanceLoweringContext,
): ReadonlyMap<string, Readonly<IrType>> {
  if (reference.typeArguments.length > declaration.typeParameters.length) {
    return failIrInterfaceInheritanceLowering(
      context.module,
      `interface ${declaration.binding.name} receives too many heritage type arguments`,
    );
  }
  const substitutions = new Map<string, Readonly<IrType>>();
  declaration.typeParameters.forEach((parameter, index) => {
    const argument = reference.typeArguments[index];
    if (argument) {
      substitutions.set(parameter.binding.id, substituteIrTypeInterfaceInheritance(argument, outerSubstitutions));
      return;
    }
    if (!parameter.default) {
      failIrInterfaceInheritanceLowering(
        context.module,
        `interface ${declaration.binding.name} requires heritage type argument ${parameter.binding.name}`,
      );
    }
    substitutions.set(parameter.binding.id, substituteIrTypeInterfaceInheritance(parameter.default, substitutions));
  });
  return substitutions;
}

function addIrInterfacePropertyFlattened(
  property: Readonly<IrObjectTypeProperty>,
  declaration: Readonly<IrInterfaceDeclaration>,
  properties: IrObjectTypeProperty[],
  context: InterfaceInheritanceLoweringContext,
): void {
  const existing = properties.find((candidate) => candidate.name === property.name);
  if (!existing) {
    properties.push(property);
    return;
  }
  if (!isDeepStrictEqual(existing, property)) {
    failIrInterfaceInheritanceLowering(
      context.module,
      `interface ${declaration.binding.name} inherits incompatible property ${property.name}`,
    );
  }
}

function substituteIrTypeInterfaceInheritance(
  type: Readonly<IrType>,
  substitutions: ReadonlyMap<string, Readonly<IrType>>,
): IrType {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'binding' &&
    type.reference.path.length === 0 &&
    type.reference.binding.kind === 'typeParameter'
  ) {
    const substitution = substitutions.get(type.reference.binding.id);
    if (substitution) return structuredClone(substitution);
  }
  switch (type.kind) {
    case 'array':
      return { ...type, element: substituteIrTypeInterfaceInheritance(type.element, substitutions) };
    case 'function':
      return {
        ...type,
        parameters: type.parameters.map((parameter) => ({
          ...parameter,
          type: substituteIrTypeInterfaceInheritance(parameter.type, substitutions),
        })),
        returns: substituteIrTypeInterfaceInheritance(type.returns, substitutions),
        typeParameters: type.typeParameters.map((parameter) =>
          substituteIrTypeParameterInterfaceInheritance(parameter, substitutions),
        ),
      };
    case 'indexedAccess':
      return {
        ...type,
        index: substituteIrTypeInterfaceInheritance(type.index, substitutions),
        object: substituteIrTypeInterfaceInheritance(type.object, substitutions),
      };
    case 'intersection': {
      const types = type.types.map((member) => substituteIrTypeInterfaceInheritance(member, substitutions));
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'keyof':
      return { ...type, type: substituteIrTypeInterfaceInheritance(type.type, substitutions) };
    case 'named':
      return {
        ...type,
        typeArguments: type.typeArguments.map((argument) =>
          substituteIrTypeInterfaceInheritance(argument, substitutions),
        ),
      };
    case 'object':
      return {
        ...type,
        properties: type.properties.map((property) => ({
          ...property,
          type: substituteIrTypeInterfaceInheritance(property.type, substitutions),
        })),
      };
    case 'tuple':
      return {
        ...type,
        elements: type.elements.map((element) => ({
          ...element,
          type: substituteIrTypeInterfaceInheritance(element.type, substitutions),
        })),
      };
    case 'union': {
      const types = type.types.map((member) => substituteIrTypeInterfaceInheritance(member, substitutions));
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      return type;
  }
}

function substituteIrTypeParameterInterfaceInheritance(
  parameter: Readonly<IrTypeParameter>,
  substitutions: ReadonlyMap<string, Readonly<IrType>>,
): IrTypeParameter {
  return {
    ...parameter,
    ...(parameter.constraint
      ? { constraint: substituteIrTypeInterfaceInheritance(parameter.constraint, substitutions) }
      : {}),
    ...(parameter.default ? { default: substituteIrTypeInterfaceInheritance(parameter.default, substitutions) } : {}),
  };
}

function rebindIrInterfacePropertyTypeParameters(
  property: Readonly<IrObjectTypeProperty>,
  declaration: Readonly<IrInterfaceDeclaration>,
  propertyIndex: number,
): IrObjectTypeProperty {
  return {
    ...property,
    type: rebindIrTypeInterfaceInheritance(
      property.type,
      declaration,
      `properties[${String(propertyIndex)}].type`,
      new Map(),
    ),
  };
}

function rebindIrTypeInterfaceInheritance(
  type: Readonly<IrType>,
  declaration: Readonly<IrInterfaceDeclaration>,
  path: string,
  bindings: ReadonlyMap<string, Readonly<IrTypeBindingIdentity>>,
): IrType {
  switch (type.kind) {
    case 'array':
      return {
        ...type,
        element: rebindIrTypeInterfaceInheritance(type.element, declaration, `${path}.element`, bindings),
      };
    case 'function': {
      const nestedBindings = new Map(bindings);
      const typeParameters = type.typeParameters.map((parameter, index) => {
        const binding = {
          ...parameter.binding,
          id: `${parameter.binding.id}:interface-inheritance:${JSON.stringify([declaration.binding.id, path, index])}`,
        };
        nestedBindings.set(parameter.binding.id, binding);
        return { ...parameter, binding };
      });
      return {
        ...type,
        parameters: type.parameters.map((parameter, index) => ({
          ...parameter,
          type: rebindIrTypeInterfaceInheritance(
            parameter.type,
            declaration,
            `${path}.parameters[${String(index)}].type`,
            nestedBindings,
          ),
        })),
        returns: rebindIrTypeInterfaceInheritance(type.returns, declaration, `${path}.returns`, nestedBindings),
        typeParameters: typeParameters.map((parameter, index) => ({
          ...parameter,
          ...(parameter.constraint
            ? {
                constraint: rebindIrTypeInterfaceInheritance(
                  parameter.constraint,
                  declaration,
                  `${path}.typeParameters[${String(index)}].constraint`,
                  nestedBindings,
                ),
              }
            : {}),
          ...(parameter.default
            ? {
                default: rebindIrTypeInterfaceInheritance(
                  parameter.default,
                  declaration,
                  `${path}.typeParameters[${String(index)}].default`,
                  nestedBindings,
                ),
              }
            : {}),
        })),
      };
    }
    case 'indexedAccess':
      return {
        ...type,
        index: rebindIrTypeInterfaceInheritance(type.index, declaration, `${path}.index`, bindings),
        object: rebindIrTypeInterfaceInheritance(type.object, declaration, `${path}.object`, bindings),
      };
    case 'intersection': {
      const types = type.types.map((member, index) =>
        rebindIrTypeInterfaceInheritance(member, declaration, `${path}.types[${String(index)}]`, bindings),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'keyof':
      return {
        ...type,
        type: rebindIrTypeInterfaceInheritance(type.type, declaration, `${path}.type`, bindings),
      };
    case 'named': {
      const binding = type.reference.kind === 'binding' ? bindings.get(type.reference.binding.id) : undefined;
      const reference = type.reference.kind === 'binding' && binding ? { ...type.reference, binding } : type.reference;
      return {
        ...type,
        reference,
        typeArguments: type.typeArguments.map((argument, index) =>
          rebindIrTypeInterfaceInheritance(argument, declaration, `${path}.typeArguments[${String(index)}]`, bindings),
        ),
      };
    }
    case 'object':
      return {
        ...type,
        properties: type.properties.map((property, index) => ({
          ...property,
          type: rebindIrTypeInterfaceInheritance(
            property.type,
            declaration,
            `${path}.properties[${String(index)}].type`,
            bindings,
          ),
        })),
      };
    case 'tuple':
      return {
        ...type,
        elements: type.elements.map((element, index) => ({
          ...element,
          type: rebindIrTypeInterfaceInheritance(
            element.type,
            declaration,
            `${path}.elements[${String(index)}].type`,
            bindings,
          ),
        })),
      };
    case 'union': {
      const types = type.types.map((member, index) =>
        rebindIrTypeInterfaceInheritance(member, declaration, `${path}.types[${String(index)}]`, bindings),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      return type;
  }
}

function failIrInterfaceInheritanceLowering(module: Readonly<IrModule>, message: string): never {
  throw createCompilerLoweringFailure('unsupported-ir', compilerLoweringPassNameInterfaceInheritance, module, message);
}
