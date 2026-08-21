import type {
  IrClassDeclaration,
  IrClassFieldInitialization,
  IrClassInitializationFailure,
  IrClassInitializationFailureCode,
  IrClassInitializationPlan,
} from '../../compiler-types/src/index.js';

export function createIrClassInitializationPlan(declaration: Readonly<IrClassDeclaration>): IrClassInitializationPlan {
  validateIrClassInitializationDeclaration(declaration);
  const derived = declaration.extends !== undefined;
  const instanceTiming = derived ? 'derived-super-return' : 'base-instance-binding';
  const fields = declaration.fields.map((field, fieldIndex): IrClassFieldInitialization => {
    if (field.parameterProperty) {
      return Object.freeze({
        fieldIndex,
        parameterIndex: field.parameterProperty.parameterIndex,
        timing: derived ? 'derived-super-return-after-fields' : 'base-constructor-body-entry',
        value: 'parameter',
      });
    }
    return Object.freeze({
      fieldIndex,
      timing: field.static ? 'class-evaluation' : instanceTiming,
      value: field.initializer === undefined ? 'undefined' : 'initializer',
    });
  });
  const constructor = declaration.classConstructor
    ? Object.freeze({ kind: 'explicit' as const })
    : derived
      ? Object.freeze({ argumentForwarding: 'all' as const, kind: 'implicit-derived' as const })
      : Object.freeze({ kind: 'implicit-base' as const });
  return Object.freeze({
    constructor,
    fields: Object.freeze(fields),
    schema: 'flight-compiler-class-initialization/1',
  });
}

export function isIrClassInitializationFailure(value: unknown): value is IrClassInitializationFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'ir-class-initialization' &&
    'code' in value &&
    irClassInitializationFailureCodes.has(value.code as IrClassInitializationFailureCode) &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function validateIrClassInitializationDeclaration(declaration: Readonly<IrClassDeclaration>): void {
  if (
    !declaration ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration) ||
    declaration.kind !== 'class' ||
    !Array.isArray(declaration.fields)
  ) {
    throw createIrClassInitializationFailure(
      'invalid-class-declaration',
      ['declaration'],
      'Class initialization requires a class declaration with a field list',
    );
  }
  if (declaration.extends !== undefined && !isRecord(declaration.extends)) {
    throw createIrClassInitializationFailure(
      'invalid-class-declaration',
      ['declaration', 'extends'],
      'Class heritage must be an IR type reference when present',
    );
  }
  if (
    declaration.classConstructor !== undefined &&
    (!isRecord(declaration.classConstructor) ||
      !Array.isArray(declaration.classConstructor.body) ||
      !Array.isArray(declaration.classConstructor.overloads) ||
      !Array.isArray(declaration.classConstructor.parameters))
  ) {
    throw createIrClassInitializationFailure(
      'invalid-class-declaration',
      ['declaration', 'classConstructor'],
      'Explicit class constructor data must contain body, overload, and parameter lists',
    );
  }
  const parameterPropertyIndexes = new Set<number>();
  declaration.fields.forEach((field, fieldIndex) => {
    if (!isRecord(field) || typeof field.static !== 'boolean') {
      throw createIrClassInitializationFailure(
        'invalid-class-field',
        ['declaration', 'fields', fieldIndex],
        'Class fields must declare whether their storage is static',
      );
    }
    if (field.parameterProperty === undefined) return;
    const parameterProperty = field.parameterProperty;
    const parameterIndex = isRecord(parameterProperty) ? parameterProperty.parameterIndex : undefined;
    const parameter =
      typeof parameterIndex === 'number' ? declaration.classConstructor?.parameters[parameterIndex] : undefined;
    const binding = isRecord(parameter) ? parameter.binding : undefined;
    if (
      !isRecord(parameterProperty) ||
      typeof parameterIndex !== 'number' ||
      !Number.isInteger(parameterIndex) ||
      parameterIndex < 0 ||
      !isRecord(parameter) ||
      !isRecord(binding) ||
      binding.name !== field.name ||
      field.static ||
      field.initializer !== undefined ||
      parameterPropertyIndexes.has(parameterIndex)
    ) {
      throw createIrClassInitializationFailure(
        'invalid-parameter-property',
        ['declaration', 'fields', fieldIndex, 'parameterProperty'],
        'Parameter property must uniquely reference its same-named constructor parameter and cannot be static or independently initialized',
      );
    }
    parameterPropertyIndexes.add(parameterIndex);
  });
}

function createIrClassInitializationFailure(
  code: IrClassInitializationFailureCode,
  path: readonly (number | string)[],
  message: string,
): IrClassInitializationFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'ir-class-initialization' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'IrClassInitializationError';
  return failure;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const irClassInitializationFailureCodes = new Set<IrClassInitializationFailureCode>([
  'invalid-class-declaration',
  'invalid-class-field',
  'invalid-parameter-property',
]);
