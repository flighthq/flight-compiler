import type {
  CompilerIrTraversalPath,
  CompilerStructuralTypeSubstitution,
  CompilerStructuralTypeSubstitutionFailure,
  CompilerStructuralTypeSubstitutionFailureCode,
  CompilerStructuralTypeSubstitutionPlan,
  IrType,
  IrTypeParameter,
} from '../../compiler-types/src/index.js';

interface TypeSubstitutionContext {
  readonly active: ReadonlySet<string>;
  readonly ancestors: Set<object>;
  readonly substitutions: ReadonlyMap<string, Readonly<IrType>>;
}

export function createIrTypeParameterSubstitutionPlan(
  parameters: readonly Readonly<IrTypeParameter>[],
  arguments_: readonly Readonly<IrType>[],
): CompilerStructuralTypeSubstitutionPlan {
  if (arguments_.length > parameters.length) {
    throw createCompilerStructuralTypeSubstitutionFailure(
      'too-many-type-arguments',
      ['typeArguments', parameters.length],
      `Structural type receives ${String(arguments_.length)} argument(s) for ${String(parameters.length)} parameter(s)`,
    );
  }
  const seen = new Set<string>();
  const substitutions: CompilerStructuralTypeSubstitution[] = [];
  for (const [index, parameter] of parameters.entries()) {
    if (seen.has(parameter.binding.id)) {
      throw createCompilerStructuralTypeSubstitutionFailure(
        'duplicate-type-parameter',
        ['typeParameters', index, 'binding', 'id'],
        `Structural type repeats type parameter ${parameter.binding.id}`,
      );
    }
    seen.add(parameter.binding.id);
    const argument = arguments_[index] ?? parameter.default;
    if (!argument) {
      throw createCompilerStructuralTypeSubstitutionFailure(
        'missing-type-argument',
        ['typeParameters', index],
        `Structural type requires argument for ${parameter.binding.name}`,
      );
    }
    const partial = Object.freeze({
      schema: 'flight-compiler-structural-type-substitution/1' as const,
      substitutions: Object.freeze([...substitutions]),
    });
    substitutions.push(
      Object.freeze({
        parameter: parameter.binding,
        type: resolveIrTypeStructuralSubstitution(argument, partial),
      }),
    );
  }
  return Object.freeze({
    schema: 'flight-compiler-structural-type-substitution/1',
    substitutions: Object.freeze(substitutions),
  });
}

export function isCompilerStructuralTypeSubstitutionFailure(
  value: unknown,
): value is CompilerStructuralTypeSubstitutionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-structural-type-substitution' &&
    'code' in value &&
    compilerStructuralTypeSubstitutionFailureCodes.has(value.code as CompilerStructuralTypeSubstitutionFailureCode) &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

export function resolveIrTypeStructuralSubstitution(
  type: Readonly<IrType>,
  plan: Readonly<CompilerStructuralTypeSubstitutionPlan>,
): IrType {
  if (plan.schema !== 'flight-compiler-structural-type-substitution/1' || !Array.isArray(plan.substitutions)) {
    throw createCompilerStructuralTypeSubstitutionFailure(
      'invalid-substitution-plan',
      [],
      `Structural type substitution plan uses ${String(plan.schema)}; expected flight-compiler-structural-type-substitution/1`,
    );
  }
  const substitutions = new Map<string, Readonly<IrType>>();
  for (const [index, substitution] of plan.substitutions.entries()) {
    if (
      substitution.parameter.kind !== 'typeParameter' ||
      substitution.parameter.space !== 'type' ||
      substitutions.has(substitution.parameter.id)
    ) {
      throw createCompilerStructuralTypeSubstitutionFailure(
        'invalid-substitution-plan',
        ['substitutions', index],
        `Structural type substitution ${String(index)} does not introduce one unique type parameter`,
      );
    }
    substitutions.set(substitution.parameter.id, substitution.type);
  }
  return resolveIrTypeStructuralSubstitutionInternal(
    type,
    { active: new Set(), ancestors: new Set(), substitutions },
    [],
  );
}

function resolveIrTypeStructuralSubstitutionInternal(
  type: Readonly<IrType>,
  context: Readonly<TypeSubstitutionContext>,
  path: CompilerIrTraversalPath,
): IrType {
  if (context.ancestors.has(type)) {
    throw createCompilerStructuralTypeSubstitutionFailure(
      'cyclic-type-substitution',
      path,
      'Structural type substitution cannot traverse a cyclic type value',
    );
  }
  context.ancestors.add(type);
  try {
    if (
      type.kind === 'named' &&
      type.reference.kind === 'binding' &&
      type.reference.binding.kind === 'typeParameter' &&
      context.substitutions.has(type.reference.binding.id)
    ) {
      if (type.reference.path.length > 0 || type.typeArguments.length > 0) {
        throw createCompilerStructuralTypeSubstitutionFailure(
          'invalid-type-parameter-reference',
          path,
          `Substituted type parameter ${type.reference.binding.name} must be an unqualified bare reference`,
        );
      }
      if (context.active.has(type.reference.binding.id)) {
        throw createCompilerStructuralTypeSubstitutionFailure(
          'cyclic-type-substitution',
          path,
          `Structural type substitution for ${type.reference.binding.name} is cyclic`,
        );
      }
      const active = new Set(context.active).add(type.reference.binding.id);
      return resolveIrTypeStructuralSubstitutionInternal(
        context.substitutions.get(type.reference.binding.id)!,
        { ...context, active },
        path,
      );
    }
    switch (type.kind) {
      case 'array':
        return {
          ...type,
          element: resolveIrTypeStructuralSubstitutionInternal(type.element, context, [...path, 'element']),
        };
      case 'function': {
        const substitutions = new Map(context.substitutions);
        type.typeParameters.forEach((parameter) => substitutions.delete(parameter.binding.id));
        const nested = { ...context, substitutions };
        return {
          ...type,
          parameters: type.parameters.map((parameter, index) => ({
            ...parameter,
            type: resolveIrTypeStructuralSubstitutionInternal(parameter.type, nested, [
              ...path,
              'parameters',
              index,
              'type',
            ]),
          })),
          returns: resolveIrTypeStructuralSubstitutionInternal(type.returns, nested, [...path, 'returns']),
          typeParameters: type.typeParameters.map((parameter, index) => ({
            ...parameter,
            ...(parameter.constraint
              ? {
                  constraint: resolveIrTypeStructuralSubstitutionInternal(parameter.constraint, nested, [
                    ...path,
                    'typeParameters',
                    index,
                    'constraint',
                  ]),
                }
              : {}),
            ...(parameter.default
              ? {
                  default: resolveIrTypeStructuralSubstitutionInternal(parameter.default, nested, [
                    ...path,
                    'typeParameters',
                    index,
                    'default',
                  ]),
                }
              : {}),
          })),
        };
      }
      case 'indexedAccess':
        return {
          ...type,
          index: resolveIrTypeStructuralSubstitutionInternal(type.index, context, [...path, 'index']),
          object: resolveIrTypeStructuralSubstitutionInternal(type.object, context, [...path, 'object']),
        };
      case 'intersection':
      case 'union': {
        const types = type.types.map((member, index) =>
          resolveIrTypeStructuralSubstitutionInternal(member, context, [...path, 'types', index]),
        );
        return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
      }
      case 'keyof':
        return {
          ...type,
          type: resolveIrTypeStructuralSubstitutionInternal(type.type, context, [...path, 'type']),
        };
      case 'named':
        return {
          ...type,
          reference:
            type.reference.kind === 'ambient'
              ? { ...type.reference }
              : { ...type.reference, path: [...type.reference.path] },
          typeArguments: type.typeArguments.map((argument, index) =>
            resolveIrTypeStructuralSubstitutionInternal(argument, context, [...path, 'typeArguments', index]),
          ),
        };
      case 'object':
        return {
          ...type,
          properties: type.properties.map((property, index) => ({
            ...property,
            type: resolveIrTypeStructuralSubstitutionInternal(property.type, context, [
              ...path,
              'properties',
              index,
              'type',
            ]),
          })),
        };
      case 'tuple':
        return {
          ...type,
          elements: type.elements.map((element, index) => ({
            ...element,
            type: resolveIrTypeStructuralSubstitutionInternal(element.type, context, [
              ...path,
              'elements',
              index,
              'type',
            ]),
          })),
        };
      case 'typeOf':
        return {
          ...type,
          reference:
            type.reference.kind === 'ambient'
              ? { ...type.reference }
              : { ...type.reference, path: [...type.reference.path] },
        };
      case 'literal':
      case 'never':
      case 'null':
      case 'primitive':
      case 'undefined':
      case 'unknown':
        return { ...type };
    }
  } finally {
    context.ancestors.delete(type);
  }
}

function createCompilerStructuralTypeSubstitutionFailure(
  code: CompilerStructuralTypeSubstitutionFailureCode,
  path: CompilerIrTraversalPath,
  message: string,
): CompilerStructuralTypeSubstitutionFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-structural-type-substitution' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'CompilerStructuralTypeSubstitutionError';
  return failure;
}

const compilerStructuralTypeSubstitutionFailureCodes = new Set<CompilerStructuralTypeSubstitutionFailureCode>([
  'cyclic-type-substitution',
  'duplicate-type-parameter',
  'invalid-substitution-plan',
  'invalid-type-parameter-reference',
  'missing-type-argument',
  'too-many-type-arguments',
]);
