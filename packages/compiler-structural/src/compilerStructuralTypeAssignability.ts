import type {
  CompilerIrTraversalPath,
  CompilerStructuralTypeAssignabilityDiagnostic,
  CompilerStructuralTypeAssignabilityDiagnosticCode,
  CompilerStructuralTypeAssignabilityFailure,
  CompilerStructuralTypeAssignabilityFailureCode,
  CompilerStructuralTypeAssignabilityReport,
  IrObjectTypeProperty,
  IrType,
} from '../../compiler-types/src/index.js';

interface StructuralAssignabilityResult {
  readonly diagnostics: readonly CompilerStructuralTypeAssignabilityDiagnostic[];
  readonly status: CompilerStructuralTypeAssignabilityReport['status'];
}

interface StructuralAssignabilityState {
  readonly ancestors: WeakMap<object, WeakSet<object>>;
}

export function analyzeIrTypeStructuralAssignability(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
): CompilerStructuralTypeAssignabilityReport {
  const result = analyzeIrTypeStructuralAssignabilityPair(source, target, [], { ancestors: new WeakMap() });
  return Object.freeze({
    diagnostics: Object.freeze(
      result.diagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic, path: Object.freeze([...diagnostic.path]) }),
      ),
    ),
    schema: 'flight-compiler-structural-type-assignability/1',
    status: result.status,
  });
}

export function isCompilerStructuralTypeAssignabilityFailure(
  value: unknown,
): value is CompilerStructuralTypeAssignabilityFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-structural-type-assignability' &&
    'code' in value &&
    compilerStructuralTypeAssignabilityFailureCodes.has(value.code as CompilerStructuralTypeAssignabilityFailureCode) &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function analyzeIrTypeStructuralAssignabilityPair(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  if (!source || !target || typeof source !== 'object' || typeof target !== 'object') {
    return createStructuralAssignabilityDiagnostic(
      'type-incompatible',
      'incompatible',
      path,
      'Structural assignability requires two type records',
    );
  }
  const targets = state.ancestors.get(source) ?? new WeakSet<object>();
  if (targets.has(target)) {
    throw createCompilerStructuralTypeAssignabilityFailure(
      'cyclic-type',
      path,
      'Structural type values cannot be cyclic',
    );
  }
  targets.add(target);
  state.ancestors.set(source, targets);
  try {
    if (source.kind === 'never') return compatibleStructuralAssignability();
    if (target.kind === 'unknown' && (target.source === 'any' || target.source === 'unknown')) {
      return compatibleStructuralAssignability();
    }
    if (
      source.kind === 'unknown' &&
      source.source === 'object' &&
      target.kind === 'unknown' &&
      target.source === 'object'
    ) {
      return compatibleStructuralAssignability();
    }
    if (source.kind === 'union') return analyzeIrSourceUnionAssignability(source.types, target, path, state);
    if (target.kind === 'union') return analyzeIrTargetUnionAssignability(source, target.types, path, state);
    if (source.kind === 'unknown' || target.kind === 'unknown') {
      return createStructuralAssignabilityDiagnostic(
        'unknown-type-indeterminate',
        'indeterminate',
        path,
        'Unknown, object, any, and this evidence requires semantic narrowing before assignment',
      );
    }
    if (source.kind === 'literal' && target.kind === 'primitive' && typeof source.value === target.name) {
      return compatibleStructuralAssignability();
    }
    switch (source.kind) {
      case 'array':
        if (target.kind !== 'array') return incompatibleTypeStructuralAssignability(source, target, path);
        return analyzeIrArrayTypeStructuralAssignability(source, target, path, state);
      case 'function':
        if (target.kind !== 'function') return incompatibleTypeStructuralAssignability(source, target, path);
        return analyzeIrFunctionTypeStructuralAssignability(source, target, path, state);
      case 'literal':
        return target.kind === 'literal' && Object.is(source.value, target.value)
          ? compatibleStructuralAssignability()
          : incompatibleTypeStructuralAssignability(source, target, path);
      case 'named':
        if (target.kind !== 'named') return incompatibleTypeStructuralAssignability(source, target, path);
        return analyzeIrNamedTypeStructuralAssignability(source, target, path, state);
      case 'null':
        return target.kind === 'null'
          ? compatibleStructuralAssignability()
          : incompatibleTypeStructuralAssignability(source, target, path);
      case 'undefined':
        return target.kind === 'undefined'
          ? compatibleStructuralAssignability()
          : incompatibleTypeStructuralAssignability(source, target, path);
      case 'object':
        if (target.kind !== 'object') return incompatibleTypeStructuralAssignability(source, target, path);
        return analyzeIrObjectTypeStructuralAssignability(source.properties, target.properties, path, state);
      case 'primitive':
        return target.kind === 'primitive' && source.name === target.name
          ? compatibleStructuralAssignability()
          : incompatibleTypeStructuralAssignability(source, target, path);
      case 'tuple':
        if (target.kind !== 'tuple') return incompatibleTypeStructuralAssignability(source, target, path);
        return analyzeIrTupleTypeStructuralAssignability(source, target, path, state);
      case 'indexedAccess':
      case 'intersection':
      case 'keyof':
      case 'typeOf':
        if (target.kind !== source.kind) return incompatibleTypeStructuralAssignability(source, target, path);
        return createStructuralAssignabilityDiagnostic(
          'type-operator-indeterminate',
          'indeterminate',
          path,
          `Structural assignability for ${source.kind} requires semantic resolution`,
        );
    }
  } finally {
    targets.delete(target);
  }
}

function analyzeIrArrayTypeStructuralAssignability(
  source: Readonly<Extract<IrType, { kind: 'array' }>>,
  target: Readonly<Extract<IrType, { kind: 'array' }>>,
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  if (source.readonly && !target.readonly) return readonlyContainerStructuralAssignability(path);
  const forward = analyzeIrTypeStructuralAssignabilityPair(source.element, target.element, [...path, 'element'], state);
  if (target.readonly || forward.status !== 'compatible') return forward;
  return combineStructuralAssignabilityResults([
    forward,
    analyzeIrTypeStructuralAssignabilityPair(target.element, source.element, [...path, 'element'], state),
  ]);
}

function analyzeIrFunctionTypeStructuralAssignability(
  source: Readonly<Extract<IrType, { kind: 'function' }>>,
  target: Readonly<Extract<IrType, { kind: 'function' }>>,
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  if (source.typeParameters.length > 0 || target.typeParameters.length > 0) {
    return createStructuralAssignabilityDiagnostic(
      'generic-callable-indeterminate',
      'indeterminate',
      path,
      'Generic callable assignability requires type-parameter instantiation evidence',
    );
  }
  const sourceRequired = source.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  const targetRequired = target.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  const sourceRest = source.parameters.find((parameter) => parameter.rest);
  if (sourceRequired > targetRequired) {
    return createStructuralAssignabilityDiagnostic(
      'callable-parameter-cardinality-incompatible',
      'incompatible',
      [...path, 'parameters'],
      'Source callable cannot accept every target call cardinality',
    );
  }
  const results: StructuralAssignabilityResult[] = [];
  target.parameters.forEach((parameter, index) => {
    const sourceParameter = source.parameters[index] ?? sourceRest;
    if (sourceParameter) {
      results.push(
        analyzeIrTypeStructuralAssignabilityPair(
          parameter.type,
          sourceParameter.type,
          [...path, 'parameters', index],
          state,
        ),
      );
    }
  });
  results.push(analyzeIrTypeStructuralAssignabilityPair(source.returns, target.returns, [...path, 'returns'], state));
  return combineStructuralAssignabilityResults(results);
}

function analyzeIrNamedTypeStructuralAssignability(
  source: Readonly<Extract<IrType, { kind: 'named' }>>,
  target: Readonly<Extract<IrType, { kind: 'named' }>>,
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  const sourceIdentity = getIrTypeReferenceStructuralIdentity(source);
  const targetIdentity = getIrTypeReferenceStructuralIdentity(target);
  if (sourceIdentity !== targetIdentity || source.typeArguments.length !== target.typeArguments.length) {
    return createStructuralAssignabilityDiagnostic(
      'named-type-indeterminate',
      'indeterminate',
      path,
      'Distinct named types require declaration resolution before structural assignment',
    );
  }
  return combineStructuralAssignabilityResults(
    source.typeArguments.flatMap((argument, index) => {
      const targetArgument = target.typeArguments[index]!;
      return [
        analyzeIrTypeStructuralAssignabilityPair(argument, targetArgument, [...path, 'typeArguments', index], state),
        analyzeIrTypeStructuralAssignabilityPair(targetArgument, argument, [...path, 'typeArguments', index], state),
      ];
    }),
  );
}

function analyzeIrObjectTypeStructuralAssignability(
  source: readonly Readonly<IrObjectTypeProperty>[],
  target: readonly Readonly<IrObjectTypeProperty>[],
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  const sourceProperties = createIrObjectTypePropertyMap(source, [...path, 'source', 'properties']);
  createIrObjectTypePropertyMap(target, [...path, 'target', 'properties']);
  const results: StructuralAssignabilityResult[] = [];
  target.forEach((targetProperty) => {
    const propertyPath = [...path, 'properties', targetProperty.name];
    const sourceProperty = sourceProperties.get(targetProperty.name);
    if (!sourceProperty) {
      if (!targetProperty.optional) {
        results.push(
          createStructuralAssignabilityDiagnostic(
            'missing-required-property',
            'incompatible',
            propertyPath,
            `Required property ${targetProperty.name} is missing`,
          ),
        );
      }
      return;
    }
    if (sourceProperty.optional && !targetProperty.optional) {
      results.push(
        createStructuralAssignabilityDiagnostic(
          'optional-member-incompatible',
          'incompatible',
          propertyPath,
          `Optional property ${targetProperty.name} cannot satisfy a required property`,
        ),
      );
    }
    if (sourceProperty.readonly && !targetProperty.readonly) {
      results.push(
        createStructuralAssignabilityDiagnostic(
          'readonly-member-incompatible',
          'incompatible',
          propertyPath,
          `Readonly property ${targetProperty.name} cannot satisfy mutable storage`,
        ),
      );
    }
    results.push(
      analyzeIrTypeStructuralAssignabilityPair(sourceProperty.type, targetProperty.type, propertyPath, state),
    );
  });
  return combineStructuralAssignabilityResults(results);
}

function analyzeIrTupleTypeStructuralAssignability(
  source: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  target: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  if (source.readonly && !target.readonly) return readonlyContainerStructuralAssignability(path);
  const sourceRest = source.elements.find((element) => element.rest);
  const targetRest = target.elements.find((element) => element.rest);
  const sourceFixed = source.elements.filter((element) => !element.rest);
  const targetFixed = target.elements.filter((element) => !element.rest);
  if (
    (!targetRest && (sourceRest || sourceFixed.length > targetFixed.length)) ||
    targetFixed.some((element, index) => !element.optional && (!sourceFixed[index] || sourceFixed[index].optional))
  ) {
    return createStructuralAssignabilityDiagnostic(
      'tuple-cardinality-incompatible',
      'incompatible',
      [...path, 'elements'],
      'Source tuple cardinality cannot satisfy the target tuple',
    );
  }
  const results: StructuralAssignabilityResult[] = [];
  targetFixed.forEach((element, index) => {
    const sourceElement = sourceFixed[index];
    if (sourceElement) {
      results.push(
        analyzeIrTypeStructuralAssignabilityPair(sourceElement.type, element.type, [...path, 'elements', index], state),
      );
    }
  });
  if (targetRest) {
    sourceFixed
      .slice(targetFixed.length)
      .forEach((element, index) =>
        results.push(
          analyzeIrTypeStructuralAssignabilityPair(
            element.type,
            targetRest.type,
            [...path, 'elements', targetFixed.length + index],
            state,
          ),
        ),
      );
    if (sourceRest) {
      results.push(
        analyzeIrTypeStructuralAssignabilityPair(
          sourceRest.type,
          targetRest.type,
          [...path, 'elements', 'rest'],
          state,
        ),
      );
    }
  }
  return combineStructuralAssignabilityResults(results);
}

function analyzeIrSourceUnionAssignability(
  sources: readonly IrType[],
  target: Readonly<IrType>,
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  return combineStructuralAssignabilityResults(
    sources.map((source, index) =>
      analyzeIrTypeStructuralAssignabilityPair(source, target, [...path, 'types', index], state),
    ),
  );
}

function analyzeIrTargetUnionAssignability(
  source: Readonly<IrType>,
  targets: readonly IrType[],
  path: CompilerIrTraversalPath,
  state: Readonly<StructuralAssignabilityState>,
): StructuralAssignabilityResult {
  const alternatives = targets.map((target, index) =>
    analyzeIrTypeStructuralAssignabilityPair(source, target, [...path, 'types', index], state),
  );
  if (alternatives.some((alternative) => alternative.status === 'compatible'))
    return compatibleStructuralAssignability();
  const indeterminate = alternatives.some((alternative) => alternative.status === 'indeterminate');
  return createStructuralAssignabilityDiagnostic(
    indeterminate ? 'union-target-indeterminate' : 'union-target-incompatible',
    indeterminate ? 'indeterminate' : 'incompatible',
    path,
    indeterminate
      ? 'No target union branch is proven compatible and at least one requires semantic resolution'
      : 'Source type is incompatible with every target union branch',
  );
}

function createIrObjectTypePropertyMap(
  properties: readonly Readonly<IrObjectTypeProperty>[],
  path: CompilerIrTraversalPath,
): ReadonlyMap<string, Readonly<IrObjectTypeProperty>> {
  const result = new Map<string, Readonly<IrObjectTypeProperty>>();
  properties.forEach((property, index) => {
    if (result.has(property.name)) {
      throw createCompilerStructuralTypeAssignabilityFailure(
        'duplicate-object-property',
        [...path, index],
        `Structural type property ${property.name} is duplicated`,
      );
    }
    result.set(property.name, property);
  });
  return result;
}

function getIrTypeReferenceStructuralIdentity(type: Readonly<Extract<IrType, { kind: 'named' }>>): string {
  return type.reference.kind === 'ambient'
    ? `ambient:${type.reference.name}`
    : `binding:${type.reference.binding.id}:${type.reference.path.join('.')}`;
}

function combineStructuralAssignabilityResults(
  results: readonly Readonly<StructuralAssignabilityResult>[],
): StructuralAssignabilityResult {
  const diagnostics = results.flatMap((result) => result.diagnostics);
  return {
    diagnostics,
    status: diagnostics.some((diagnostic) => diagnostic.disposition === 'incompatible')
      ? 'incompatible'
      : diagnostics.length > 0
        ? 'indeterminate'
        : 'compatible',
  };
}

function compatibleStructuralAssignability(): StructuralAssignabilityResult {
  return { diagnostics: [], status: 'compatible' };
}

function createStructuralAssignabilityDiagnostic(
  code: CompilerStructuralTypeAssignabilityDiagnosticCode,
  disposition: CompilerStructuralTypeAssignabilityDiagnostic['disposition'],
  path: CompilerIrTraversalPath,
  message: string,
): StructuralAssignabilityResult {
  return { diagnostics: [{ code, disposition, message, path }], status: disposition };
}

function incompatibleTypeStructuralAssignability(
  source: Readonly<IrType>,
  target: Readonly<IrType>,
  path: CompilerIrTraversalPath,
): StructuralAssignabilityResult {
  return createStructuralAssignabilityDiagnostic(
    'type-incompatible',
    'incompatible',
    path,
    `Source ${source.kind} type is incompatible with target ${target.kind} type`,
  );
}

function readonlyContainerStructuralAssignability(path: CompilerIrTraversalPath): StructuralAssignabilityResult {
  return createStructuralAssignabilityDiagnostic(
    'readonly-container-incompatible',
    'incompatible',
    path,
    'Readonly source storage cannot satisfy a mutable target container',
  );
}

function createCompilerStructuralTypeAssignabilityFailure(
  code: CompilerStructuralTypeAssignabilityFailureCode,
  path: CompilerIrTraversalPath,
  message: string,
): CompilerStructuralTypeAssignabilityFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-structural-type-assignability' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'CompilerStructuralTypeAssignabilityError';
  return failure;
}

const compilerStructuralTypeAssignabilityFailureCodes = new Set<CompilerStructuralTypeAssignabilityFailureCode>([
  'cyclic-type',
  'duplicate-object-property',
]);
