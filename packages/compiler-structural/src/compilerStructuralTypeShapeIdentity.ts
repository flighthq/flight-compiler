import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerStructuralTypeShapeFailure,
  CompilerStructuralTypeShapeFailureCode,
  CompilerStructuralTypeShapeIdentity,
  IrObjectTypeProperty,
  IrType,
  IrTypeNameReference,
  IrTypeParameter,
  IrValueNameReference,
} from '../../compiler-types/src/index.js';

interface CanonicalTypeContext {
  readonly ancestors: Set<object>;
  readonly typeParameters: ReadonlyMap<string, number>;
}

export function createIrObjectTypeShapeIdentity(
  properties: readonly Readonly<IrObjectTypeProperty>[],
): CompilerStructuralTypeShapeIdentity {
  const canonical = createIrTypeCanonical(
    { kind: 'object', properties },
    { ancestors: new Set(), typeParameters: new Map() },
    [],
  );
  return `flight-structural-type-shape/1:${canonical}`;
}

export function isCompilerStructuralTypeShapeFailure(value: unknown): value is CompilerStructuralTypeShapeFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-structural-type-shape' &&
    'code' in value &&
    (value.code === 'cyclic-type' ||
      value.code === 'duplicate-object-property' ||
      value.code === 'non-finite-literal') &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function createIrTypeCanonical(
  type: Readonly<IrType>,
  context: Readonly<CanonicalTypeContext>,
  path: CompilerIrTraversalPath,
): string {
  if (context.ancestors.has(type)) {
    throw createCompilerStructuralTypeShapeFailure('cyclic-type', path, 'Structural type values cannot be cyclic');
  }
  context.ancestors.add(type);
  try {
    switch (type.kind) {
      case 'array':
        return normalizeCompilerStructuralValueCanonical([
          'array',
          type.readonly,
          createIrTypeCanonical(type.element, context, [...path, 'element']),
        ]);
      case 'function':
        return createIrFunctionTypeCanonical(type, context, path);
      case 'indexedAccess':
        return normalizeCompilerStructuralValueCanonical([
          'indexedAccess',
          createIrTypeCanonical(type.object, context, [...path, 'object']),
          createIrTypeCanonical(type.index, context, [...path, 'index']),
        ]);
      case 'intersection':
      case 'union':
        return createIrCompoundTypeCanonical(type, context, path);
      case 'keyof':
        return normalizeCompilerStructuralValueCanonical([
          'keyof',
          createIrTypeCanonical(type.type, context, [...path, 'type']),
        ]);
      case 'literal':
        if (typeof type.value === 'number' && !Number.isFinite(type.value)) {
          throw createCompilerStructuralTypeShapeFailure(
            'non-finite-literal',
            [...path, 'value'],
            'Structural type literals require finite numbers',
          );
        }
        return normalizeCompilerStructuralValueCanonical(['literal', type.value]);
      case 'named':
        return normalizeCompilerStructuralValueCanonical([
          'named',
          createIrTypeNameReferenceCanonical(type.reference, context),
          type.typeArguments.map((argument, index) =>
            createIrTypeCanonical(argument, context, [...path, 'typeArguments', index]),
          ),
        ]);
      case 'never':
      case 'null':
      case 'undefined':
        return normalizeCompilerStructuralValueCanonical([type.kind]);
      case 'object':
        return createIrObjectTypeCanonical(type.properties, context, path);
      case 'primitive':
        return normalizeCompilerStructuralValueCanonical(['primitive', type.name]);
      case 'tuple':
        return normalizeCompilerStructuralValueCanonical([
          'tuple',
          type.readonly,
          type.elements.map((element, index) => [
            element.optional,
            element.rest,
            createIrTypeCanonical(element.type, context, [...path, 'elements', index, 'type']),
          ]),
        ]);
      case 'typeOf':
        return normalizeCompilerStructuralValueCanonical([
          'typeOf',
          createIrValueNameReferenceCanonical(type.reference),
        ]);
      case 'unknown':
        return normalizeCompilerStructuralValueCanonical(['unknown', type.source]);
    }
  } finally {
    context.ancestors.delete(type);
  }
}

function createIrCompoundTypeCanonical(
  type: Readonly<Extract<IrType, { kind: 'intersection' | 'union' }>>,
  context: Readonly<CanonicalTypeContext>,
  path: CompilerIrTraversalPath,
): string {
  const members = type.types
    .map((member, index) => createIrTypeCanonical(member, context, [...path, 'types', index]))
    .sort(compareTextCodeUnits)
    .filter((member, index, values) => index === 0 || member !== values[index - 1]);
  return members.length === 1 ? members[0]! : normalizeCompilerStructuralValueCanonical([type.kind, members]);
}

function createIrFunctionTypeCanonical(
  type: Readonly<Extract<IrType, { kind: 'function' }>>,
  context: Readonly<CanonicalTypeContext>,
  path: CompilerIrTraversalPath,
): string {
  const typeParameters = new Map(context.typeParameters);
  const offset = typeParameters.size;
  type.typeParameters.forEach((parameter, index) => typeParameters.set(parameter.binding.id, offset + index));
  const nestedContext = { ancestors: context.ancestors, typeParameters };
  return normalizeCompilerStructuralValueCanonical([
    'function',
    type.typeParameters.map((parameter, index) =>
      createIrTypeParameterCanonical(parameter, nestedContext, [...path, 'typeParameters', index]),
    ),
    type.parameters.map((parameter, index) => [
      parameter.optional,
      parameter.rest,
      createIrTypeCanonical(parameter.type, nestedContext, [...path, 'parameters', index, 'type']),
    ]),
    createIrTypeCanonical(type.returns, nestedContext, [...path, 'returns']),
  ]);
}

function createIrObjectTypeCanonical(
  properties: readonly Readonly<IrObjectTypeProperty>[],
  context: Readonly<CanonicalTypeContext>,
  path: CompilerIrTraversalPath,
): string {
  const ordered = properties
    .map((property, index) => ({ index, property }))
    .sort((left, right) => compareTextCodeUnits(left.property.name, right.property.name));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.property.name === ordered[index]!.property.name) {
      const duplicate = ordered[index]!;
      throw createCompilerStructuralTypeShapeFailure(
        'duplicate-object-property',
        [...path, 'properties', duplicate.index],
        `Structural type contains duplicate property ${JSON.stringify(duplicate.property.name)}`,
      );
    }
  }
  return normalizeCompilerStructuralValueCanonical([
    'object',
    ordered.map(({ index, property }) => [
      property.computedKey
        ? ['computed', property.name, createIrValueNameReferenceCanonical(property.computedKey)]
        : property.name,
      property.optional,
      property.readonly,
      createIrTypeCanonical(property.type, context, [...path, 'properties', index, 'type']),
    ]),
  ]);
}

function createIrTypeNameReferenceCanonical(
  reference: Readonly<IrTypeNameReference>,
  context: Readonly<CanonicalTypeContext>,
): readonly unknown[] {
  if (reference.kind === 'ambient') return ['ambient', reference.name];
  const typeParameter = context.typeParameters.get(reference.binding.id);
  return typeParameter === undefined
    ? ['binding', reference.binding.id, reference.binding.space, reference.path]
    : ['typeParameter', typeParameter, reference.path];
}

function createIrTypeParameterCanonical(
  parameter: Readonly<IrTypeParameter>,
  context: Readonly<CanonicalTypeContext>,
  path: CompilerIrTraversalPath,
): readonly unknown[] {
  return [
    parameter.constraint ? createIrTypeCanonical(parameter.constraint, context, [...path, 'constraint']) : ['absent'],
    parameter.default ? createIrTypeCanonical(parameter.default, context, [...path, 'default']) : ['absent'],
  ];
}

function createIrValueNameReferenceCanonical(reference: Readonly<IrValueNameReference>): readonly unknown[] {
  return reference.kind === 'ambient' ? ['ambient', reference.name] : ['binding', reference.binding.id, reference.path];
}

function createCompilerStructuralTypeShapeFailure(
  code: CompilerStructuralTypeShapeFailureCode,
  path: CompilerIrTraversalPath,
  message: string,
): CompilerStructuralTypeShapeFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-structural-type-shape' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'CompilerStructuralTypeShapeError';
  return failure;
}
