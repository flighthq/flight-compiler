import { isCompilerSourceFingerprint } from '../../compiler-provenance/src/index.js';
import type {
  CompilerIrModuleValidation,
  CompilerIrModuleValidationFailure,
  CompilerIrModuleValidationFailureCode,
  CompilerSourceOrigin,
  IrBindingPattern,
  IrBindingIdentity,
  IrBindingKind,
  IrBindingScope,
  IrControlFlowLabelIdentity,
  IrDeclaration,
  IrExpression,
  IrFunctionSignature,
  IrModule,
  IrObjectMember,
  IrOptionalChainSemantics,
  IrParameter,
  IrStatement,
  IrType,
  IrTypeBindingIdentity,
  IrTypeBindingKind,
  IrTypeParameter,
  IrVariable,
} from '../../compiler-types/src/index.js';

interface BindingDefinition {
  readonly binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>;
  readonly path: string;
  readonly scope: string;
}

interface BindingIntroductionExpectation {
  readonly kind: IrBindingKind | IrTypeBindingKind;
  readonly scope: IrBindingScope | readonly IrBindingScope[];
  readonly space: 'type' | 'value';
}

interface BindingReference {
  readonly binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>;
  readonly path: string;
  readonly scope: string;
}

type IrInvocationExpression = Extract<IrExpression, { kind: 'call' | 'new' }>;

interface IrLexicalScope {
  readonly id: string;
  readonly kind: IrBindingScope;
}

interface IrModuleValidationState {
  readonly bindings: Map<string, BindingDefinition>;
  readonly failures: CompilerIrModuleValidationFailure[];
  readonly module: Readonly<IrModule>;
  readonly references: BindingReference[];
  readonly scopeParents: Map<string, string | undefined>;
  readonly scopes: IrLexicalScope[];
  readonly controlFlowLabels: Array<Readonly<{ continuable: boolean; label: Readonly<IrControlFlowLabelIdentity> }>>;
}

function validateIrOptionalChainEvidence(
  optional: boolean,
  evidence: Readonly<IrOptionalChainSemantics> | undefined,
  path: string,
  state: IrModuleValidationState,
): void {
  const receiverType = evidence?.receiverType;
  const valueType = evidence?.valueType;
  const receiverNullish = evidence?.receiverNullish;
  const valid =
    evidence?.receiverEvaluation === 'once' &&
    (receiverNullish === 'excluded' || receiverNullish === 'possible') &&
    evidence.result === 'undefined' &&
    evidence.shortCircuit === 'nullish' &&
    isIrTypeEvidence(receiverType) &&
    isIrTypeEvidence(valueType) &&
    isIrOptionalChainReceiverNullishCoherent(receiverType, receiverNullish);
  if ((optional && !valid) || (!optional && evidence !== undefined)) {
    addFailure(
      'invalid-node-shape',
      `${path}.optionalChain`,
      'optional-chain evidence must exactly match an optional access target',
      state,
    );
  }
  if (valid) {
    visitType(receiverType, `${path}.optionalChain.receiverType`, state);
    visitType(valueType, `${path}.optionalChain.valueType`, state);
  }
}

function isIrOptionalChainReceiverNullishCoherent(
  type: Readonly<IrType>,
  receiverNullish: 'excluded' | 'possible',
): boolean {
  if (type.kind === 'null' || type.kind === 'undefined') return receiverNullish === 'possible';
  if (type.kind === 'union' && type.types.some((member) => member.kind === 'null' || member.kind === 'undefined')) {
    return receiverNullish === 'possible';
  }
  if (
    type.kind === 'array' ||
    type.kind === 'function' ||
    type.kind === 'literal' ||
    type.kind === 'never' ||
    type.kind === 'object' ||
    type.kind === 'primitive' ||
    type.kind === 'tuple'
  ) {
    return receiverNullish === 'excluded';
  }
  return true;
}

function isIrTypeEvidence(value: unknown): value is IrType {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string';
}

interface ParameterCardinality {
  readonly initializer?: unknown;
  readonly optional: boolean;
  readonly rest: boolean;
}

export function validateIrModuleStructure(module: Readonly<IrModule>): CompilerIrModuleValidation {
  const moduleScope: IrLexicalScope = { id: '$#module', kind: 'module' };
  const state: IrModuleValidationState = {
    bindings: new Map(),
    controlFlowLabels: [],
    failures: [],
    module,
    references: [],
    scopeParents: new Map([[moduleScope.id, undefined]]),
    scopes: [moduleScope],
  };
  try {
    validateModuleIdentity(module, state);
    module.imports.forEach((imported, importIndex) => {
      imported.bindings.forEach(({ binding, typeOnly }, bindingIndex) =>
        addBindingDefinition(
          binding,
          `$.imports[${String(importIndex)}].bindings[${String(bindingIndex)}]`,
          { kind: 'import', scope: 'module', space: typeOnly ? 'type' : 'value' },
          state,
        ),
      );
    });
    module.declarations.forEach((declaration, index) =>
      visitDeclaration(declaration, `$.declarations[${String(index)}]`, state),
    );
    module.exports.forEach((exported, index) => {
      const path = `$.exports[${String(index)}]`;
      switch (exported.kind) {
        case 'all':
        case 'namespace':
        case 'reexport':
          break;
        case 'default':
          visitExpression(exported.expression, `${path}.expression`, state);
          break;
        case 'local':
          addBindingReference(exported.binding, `${path}.binding`, state);
          break;
        default:
          addUnknownKind(exported, path, state);
      }
    });
    validateBindingReferences(state);
  } catch (error) {
    addFailure('invalid-node-shape', '$', error instanceof Error ? error.message : String(error), state);
  }
  return state.failures.length === 0 ? { kind: 'valid' } : { failures: state.failures, kind: 'invalid' };
}

function addBindingDefinition(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  path: string,
  expectation: Readonly<BindingIntroductionExpectation>,
  state: IrModuleValidationState,
): void {
  if (!isNonEmptyString(binding.id) || !isNonEmptyString(binding.name)) {
    addFailure('invalid-binding-identity', path, 'binding id and name must be nonempty strings', state);
    return;
  }
  validateBindingOrigin(binding, path, state);
  validateBindingIntroduction(binding, path, expectation, state);
  const scope = getBindingIntroductionScope(binding.scope, expectation.scope, state);
  const existing = state.bindings.get(binding.id);
  if (existing) {
    if (isRepeatedFunctionVariableBinding(existing, binding, scope, expectation)) return;
    addFailure(
      'duplicate-binding-identity',
      path,
      `binding ${binding.id} was already introduced at ${existing.path}`,
      state,
    );
    return;
  }
  state.bindings.set(binding.id, {
    binding,
    path,
    scope,
  });
}

function isRepeatedFunctionVariableBinding(
  existing: Readonly<BindingDefinition>,
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  scope: string,
  expectation: Readonly<BindingIntroductionExpectation>,
): boolean {
  const previous = existing.binding;
  return (
    expectation.kind === 'variable' &&
    expectation.space === 'value' &&
    binding.kind === 'variable' &&
    binding.scope === 'function' &&
    existing.scope === scope &&
    previous.id === binding.id &&
    previous.name === binding.name &&
    previous.kind === binding.kind &&
    previous.scope === binding.scope &&
    previous.space === binding.space &&
    previous.packageName === binding.packageName &&
    previous.source === binding.source &&
    previous.line === binding.line &&
    previous.column === binding.column &&
    previous.fingerprint === binding.fingerprint
  );
}

function addBindingReference(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  path: string,
  state: IrModuleValidationState,
): void {
  state.references.push({ binding, path, scope: getCurrentLexicalScope(state).id });
}

function addFailure(
  code: CompilerIrModuleValidationFailureCode,
  path: string,
  reason: string,
  state: IrModuleValidationState,
): void {
  state.failures.push({ code, path, reason });
}

function addUnknownKind(value: never, path: string, state: IrModuleValidationState): void {
  const kind = (value as { readonly kind?: unknown }).kind;
  addFailure('unknown-ir-kind', path, `unknown neutral IR kind ${String(kind)}`, state);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function getBindingIntroductionScope(
  received: IrBindingScope,
  expected: IrBindingScope | readonly IrBindingScope[],
  state: IrModuleValidationState,
): string {
  const expectedScopes = typeof expected === 'string' ? [expected] : expected;
  const kind = expectedScopes.includes(received) ? received : expectedScopes[0]!;
  return [...state.scopes].reverse().find((scope) => scope.kind === kind)!.id;
}

function getCurrentLexicalScope(state: IrModuleValidationState): IrLexicalScope {
  return state.scopes[state.scopes.length - 1]!;
}

function visitDeclaration(declaration: Readonly<IrDeclaration>, path: string, state: IrModuleValidationState): void {
  switch (declaration.kind) {
    case 'class':
      validateDeclarationOrigin(declaration, path, state);
      addBindingDefinition(
        declaration.binding,
        `${path}.binding`,
        { kind: 'class', scope: 'module', space: 'value' },
        state,
      );
      visitLexicalScope('declaration', path, state, () => {
        visitTypeParameters(declaration.typeParameters, `${path}.typeParameters`, 'declaration', state);
        if (declaration.extends) visitType(declaration.extends, `${path}.extends`, state);
        declaration.implements.forEach((type, index) => visitType(type, `${path}.implements[${String(index)}]`, state));
        declaration.fields.forEach((field, index) => {
          const fieldPath = `${path}.fields[${String(index)}]`;
          visitType(field.type, `${fieldPath}.type`, state);
          if (field.initializer) visitExpression(field.initializer, `${fieldPath}.initializer`, state);
        });
        const classConstructor = declaration.classConstructor;
        if (classConstructor) {
          visitLexicalScope('function', `${path}.classConstructor`, state, () => {
            visitParameters(classConstructor.parameters, `${path}.classConstructor.parameters`, state);
            visitStatementList(classConstructor.body, `${path}.classConstructor.body`, state);
          });
          classConstructor.overloads.forEach((overload, index) => {
            const overloadPath = `${path}.classConstructor.overloads[${String(index)}]`;
            visitLexicalScope('function', overloadPath, state, () =>
              visitParameters(overload.parameters, `${overloadPath}.parameters`, state),
            );
          });
        }
        declaration.methods.forEach((method, index) => {
          const methodPath = `${path}.methods[${String(index)}]`;
          visitLexicalScope('function', methodPath, state, () => {
            visitFunctionSignature(method, methodPath, state);
            visitStatementList(method.body, `${methodPath}.body`, state);
          });
        });
      });
      break;
    case 'enum':
      validateDeclarationOrigin(declaration, path, state);
      addBindingDefinition(
        declaration.binding,
        `${path}.binding`,
        { kind: 'enum', scope: 'module', space: 'value' },
        state,
      );
      break;
    case 'function':
      validateDeclarationOrigin(declaration, path, state);
      addBindingDefinition(
        declaration.binding,
        `${path}.binding`,
        { kind: 'function', scope: 'module', space: 'value' },
        state,
      );
      visitLexicalScope('function', path, state, () => {
        visitFunctionSignature(declaration, path, state);
        visitStatementList(declaration.body, `${path}.body`, state);
      });
      declaration.overloads.forEach((overload, index) => {
        const overloadPath = `${path}.overloads[${String(index)}]`;
        visitLexicalScope('function', overloadPath, state, () => visitFunctionSignature(overload, overloadPath, state));
      });
      break;
    case 'interface':
      validateDeclarationOrigin(declaration, path, state);
      addBindingDefinition(
        declaration.binding,
        `${path}.binding`,
        { kind: 'interface', scope: 'module', space: 'type' },
        state,
      );
      visitLexicalScope('declaration', path, state, () => {
        visitTypeParameters(declaration.typeParameters, `${path}.typeParameters`, 'declaration', state);
        declaration.extends.forEach((type, index) => visitType(type, `${path}.extends[${String(index)}]`, state));
        declaration.properties.forEach((property, index) =>
          visitType(property.type, `${path}.properties[${String(index)}].type`, state),
        );
      });
      break;
    case 'typeAlias':
      validateDeclarationOrigin(declaration, path, state);
      addBindingDefinition(
        declaration.binding,
        `${path}.binding`,
        { kind: 'typeAlias', scope: 'module', space: 'type' },
        state,
      );
      visitLexicalScope('declaration', path, state, () => {
        visitTypeParameters(declaration.typeParameters, `${path}.typeParameters`, 'declaration', state);
        visitType(declaration.type, `${path}.type`, state);
      });
      break;
    case 'variable':
      validateDeclarationOrigin(declaration, path, state);
      visitVariable(declaration, path, ['module'], state);
      break;
    default:
      addUnknownKind(declaration, path, state);
  }
}

function validateDeclarationOrigin(
  declaration: Readonly<IrDeclaration>,
  path: string,
  state: IrModuleValidationState,
): void {
  validateSourceOrigin(declaration.origin, `${path}.origin`, 'invalid-declaration-origin', 'declaration', state);
}

function visitExpression(expression: Readonly<IrExpression>, path: string, state: IrModuleValidationState): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element, index) => {
        if (element) visitExpression(element, `${path}.elements[${String(index)}]`, state);
      });
      break;
    case 'assignment':
    case 'binary':
      visitExpression(expression.left, `${path}.left`, state);
      visitExpression(expression.right, `${path}.right`, state);
      break;
    case 'await':
    case 'spread':
      visitExpression(expression.expression, `${path}.expression`, state);
      break;
    case 'call':
      validateIrOptionalChainEvidence(expression.optional, expression.semantics.optionalChain, path, state);
      validateIrInvocationSignatureEvidence(expression, path, state);
      validateIrDefaultParameterInvocationEvidence(expression, path, state);
      validateIrExtraArgumentErasureEvidence(expression, path, state);
      validateIrOptionalParameterInvocationEvidence(expression, path, state);
      validateIrOverloadImplementationInvocationEvidence(expression, path, state);
      if (expression.semantics.statementValue && !isIrCallExpressionStatementValueCarrierValid(expression)) {
        addFailure(
          'invalid-node-shape',
          `${path}.semantics.statementValue`,
          'statement-value evidence requires a zero-argument function carrier with a final return',
          state,
        );
      }
      visitExpression(expression.callee, `${path}.callee`, state);
      expression.arguments.forEach((argument, index) =>
        visitExpression(argument, `${path}.arguments[${String(index)}]`, state),
      );
      expression.typeArguments.forEach((type, index) =>
        visitType(type, `${path}.typeArguments[${String(index)}]`, state),
      );
      break;
    case 'new':
      validateIrInvocationSignatureEvidence(expression, path, state);
      validateIrDefaultParameterInvocationEvidence(expression, path, state);
      validateIrOptionalParameterInvocationEvidence(expression, path, state);
      validateIrOverloadImplementationInvocationEvidence(expression, path, state);
      visitExpression(expression.callee, `${path}.callee`, state);
      expression.arguments.forEach((argument, index) =>
        visitExpression(argument, `${path}.arguments[${String(index)}]`, state),
      );
      expression.typeArguments.forEach((type, index) =>
        visitType(type, `${path}.typeArguments[${String(index)}]`, state),
      );
      break;
    case 'cast':
      visitExpression(expression.expression, `${path}.expression`, state);
      visitType(expression.type, `${path}.type`, state);
      break;
    case 'conditional':
      visitExpression(expression.condition, `${path}.condition`, state);
      visitExpression(expression.whenFalse, `${path}.whenFalse`, state);
      visitExpression(expression.whenTrue, `${path}.whenTrue`, state);
      break;
    case 'element':
      if (!compilerIrPropertyKeyCoercions.has(expression.semantics.key)) {
        addFailure('invalid-node-shape', `${path}.semantics.key`, 'element access key coercion is invalid', state);
      }
      validateIrOptionalChainEvidence(expression.optional, expression.semantics.optionalChain, path, state);
      visitExpression(expression.index, `${path}.index`, state);
      visitExpression(expression.object, `${path}.object`, state);
      break;
    case 'function':
      visitLexicalScope('function', path, state, () => {
        if (expression.binding) {
          addBindingDefinition(
            expression.binding,
            `${path}.binding`,
            { kind: 'function', scope: 'function', space: 'value' },
            state,
          );
        }
        visitParameters(expression.parameters, `${path}.parameters`, state);
        visitType(expression.returns, `${path}.returns`, state);
        visitTypeParameters(expression.typeParameters, `${path}.typeParameters`, 'function', state);
        visitStatementList(expression.body, `${path}.body`, state);
        if (expression.expression) visitExpression(expression.expression, `${path}.expression`, state);
      });
      break;
    case 'identifier':
      if (expression.reference.kind === 'binding') {
        addBindingReference(expression.reference.binding, `${path}.reference.binding`, state);
      }
      break;
    case 'literal':
    case 'regexp':
      break;
    case 'object':
      expression.members.forEach((member, index) =>
        visitObjectMember(member, `${path}.members[${String(index)}]`, state),
      );
      if (isIrTypeEvidence(expression.type)) visitType(expression.type, `${path}.type`, state);
      else addFailure('invalid-node-shape', `${path}.type`, 'object construction type evidence is required', state);
      break;
    case 'objectRest':
      visitType(expression.type, `${path}.type`, state);
      visitExpression(expression.object, `${path}.object`, state);
      expression.excluded.forEach((key, index) => {
        const keyPath = `${path}.excluded[${String(index)}]`;
        if (key.kind === 'computed') {
          if (!compilerIrPropertyKeyCoercions.has(key.coercion)) {
            addFailure('invalid-node-shape', `${keyPath}.coercion`, 'object rest key coercion is invalid', state);
          }
          visitExpression(key.expression, `${keyPath}.expression`, state);
        } else if (key.name.length === 0) {
          addFailure('invalid-node-shape', `${keyPath}.name`, 'object rest exclusion key must be nonempty', state);
        }
      });
      break;
    case 'property':
      validateIrOptionalChainEvidence(expression.optional, expression.optionalChain, path, state);
      visitExpression(expression.object, `${path}.object`, state);
      break;
    case 'template':
      expression.parts.forEach((part, index) => {
        if (typeof part !== 'string') visitExpression(part, `${path}.parts[${String(index)}]`, state);
      });
      break;
    case 'tuple':
      expression.elements.forEach((element, index) => {
        const elementPath = `${path}.elements[${String(index)}]`;
        if (typeof element.optional !== 'boolean') {
          addFailure('invalid-node-shape', `${elementPath}.optional`, 'tuple optional flag must be boolean', state);
        }
        if (!element.optional && !element.expression) {
          addFailure('invalid-node-shape', elementPath, 'required tuple expression element must have a value', state);
        }
        if (element.expression) visitExpression(element.expression, `${elementPath}.expression`, state);
      });
      break;
    case 'tupleSpread': {
      visitType(expression.type, `${path}.type`, state);
      if (expression.type.elements.some((element) => element.rest)) {
        addFailure('invalid-node-shape', `${path}.type`, 'tuple spread result type must have fixed width', state);
      }
      if (!expression.segments.some((segment) => segment.kind === 'spread')) {
        addFailure('invalid-node-shape', `${path}.segments`, 'tuple spread requires a spread segment', state);
      }
      const optional: boolean[] = [];
      expression.segments.forEach((segment, index) => {
        const segmentPath = `${path}.segments[${String(index)}]`;
        if (segment.kind === 'element') {
          if (typeof segment.element.optional !== 'boolean') {
            addFailure(
              'invalid-node-shape',
              `${segmentPath}.element.optional`,
              'tuple optional flag must be boolean',
              state,
            );
          }
          if (!segment.element.optional && !segment.element.expression) {
            addFailure(
              'invalid-node-shape',
              `${segmentPath}.element`,
              'required tuple expression element must have a value',
              state,
            );
          }
          if (segment.element.expression) {
            visitExpression(segment.element.expression, `${segmentPath}.element.expression`, state);
          }
          optional.push(segment.element.optional);
          return;
        }
        visitExpression(segment.expression, `${segmentPath}.expression`, state);
        visitType(segment.type, `${segmentPath}.type`, state);
        if (segment.type.elements.some((element) => element.rest)) {
          addFailure('invalid-node-shape', `${segmentPath}.type`, 'tuple spread segment must have fixed width', state);
        }
        optional.push(...segment.type.elements.map((element) => element.optional));
      });
      if (optional.length !== expression.type.elements.length) {
        addFailure('invalid-node-shape', `${path}.segments`, 'tuple spread width must match its result type', state);
      }
      optional.forEach((value, index) => {
        const target = expression.type.elements[index];
        if (value && target && !target.optional) {
          addFailure(
            'invalid-node-shape',
            `${path}.segments`,
            `optional tuple spread value cannot initialize required index ${String(index)}`,
            state,
          );
        }
      });
      break;
    }
    case 'tupleRest':
      if (!Number.isSafeInteger(expression.start) || expression.start < 0) {
        addFailure('invalid-node-shape', `${path}.start`, 'tuple rest start must be a nonnegative integer', state);
      }
      visitExpression(expression.object, `${path}.object`, state);
      break;
    case 'tupleSuffix':
      if (!Number.isSafeInteger(expression.start) || expression.start < 0) {
        addFailure('invalid-node-shape', `${path}.start`, 'tuple suffix start must be a nonnegative integer', state);
      }
      if (!Number.isSafeInteger(expression.width) || expression.width < 0) {
        addFailure('invalid-node-shape', `${path}.width`, 'tuple suffix width must be a nonnegative integer', state);
      }
      if (expression.object.kind !== 'identifier') {
        addFailure('invalid-node-shape', `${path}.object`, 'tuple suffix receiver must be an identifier', state);
      }
      visitExpression(expression.object, `${path}.object`, state);
      break;
    case 'unary':
      visitExpression(expression.operand, `${path}.operand`, state);
      break;
    case 'undefinedValue':
      if (!hasIrTypeUndefinedOptionDomain(expression.type)) {
        addFailure(
          'invalid-node-shape',
          `${path}.type`,
          'contextual undefined values require a union with undefined and a concrete value domain',
          state,
        );
      }
      visitType(expression.type, `${path}.type`, state);
      break;
    case 'undefinedDefault':
      visitExpression(expression.fallback, `${path}.fallback`, state);
      visitExpression(expression.value, `${path}.value`, state);
      break;
    default:
      addUnknownKind(expression, path, state);
  }
}

function hasIrTypeUndefinedOptionDomain(type: Readonly<IrType>): boolean {
  if (type.kind !== 'union' || !type.types.some((member) => member.kind === 'undefined')) return false;
  return type.types.some((member) => member.kind !== 'null' && member.kind !== 'undefined');
}

function validateIrInvocationSignatureEvidence(
  expression: Readonly<IrInvocationExpression>,
  path: string,
  state: IrModuleValidationState,
): void {
  const evidence = expression.semantics.signature;
  if (!evidence) return;
  const providedValid =
    evidence.providedArgumentCount === 'dynamic'
      ? expression.arguments.some((argument) => argument.kind === 'spread')
      : Number.isSafeInteger(evidence.providedArgumentCount) &&
        evidence.providedArgumentCount >= 0 &&
        evidence.providedArgumentCount === expression.arguments.length &&
        !expression.arguments.some((argument) => argument.kind === 'spread');
  const overloadValid =
    !expression.semantics.overloadImplementation ||
    expression.semantics.overloadImplementation.implementationParameterCount === evidence.parameterCount;
  const defaultsValid =
    !expression.semantics.defaultParameters ||
    expression.semantics.defaultParameters.parameterCount === evidence.parameterCount;
  const optionalsValid =
    !expression.semantics.optionalParameters ||
    expression.semantics.optionalParameters.parameterCount === evidence.parameterCount;
  const restValid =
    evidence.restParameter === undefined ||
    (Number.isSafeInteger(evidence.restParameter) &&
      evidence.restParameter >= 0 &&
      evidence.restParameter === evidence.parameterCount - 1);
  if (
    !Number.isSafeInteger(evidence.parameterCount) ||
    evidence.parameterCount < 0 ||
    !providedValid ||
    !overloadValid ||
    !defaultsValid ||
    !optionalsValid ||
    !restValid
  ) {
    addFailure(
      'invalid-node-shape',
      `${path}.semantics.signature`,
      'invocation signature evidence must have exact argument state, implementation ABI arity, and final rest position',
      state,
    );
  }
}

function validateIrDefaultParameterInvocationEvidence(
  expression: Readonly<IrInvocationExpression>,
  path: string,
  state: IrModuleValidationState,
): void {
  const evidence = expression.semantics.defaultParameters;
  if (!evidence) return;
  const defaultedValid =
    evidence.defaulted.length > 0 &&
    isStrictlyIncreasingIntegerList(evidence.defaulted) &&
    evidence.defaulted.every((index) => index < evidence.parameterCount);
  const omittedValid =
    isStrictlyIncreasingIntegerList(evidence.omitted) &&
    evidence.omitted.every((index) => evidence.defaulted.includes(index));
  const providedPositions = Array.isArray(evidence.provided)
    ? evidence.provided.map((provided) => provided.position)
    : [];
  const providedEvidenceValid =
    Array.isArray(evidence.provided) &&
    isStrictlyIncreasingIntegerList(providedPositions) &&
    evidence.provided.every(
      (provided) =>
        evidence.defaulted.includes(provided.position) &&
        isIrTypeEvidence(provided.argumentType) &&
        isIrTypeEvidence(provided.parameterType) &&
        (provided.value === 'null' || provided.value === 'undefined' || provided.value === 'value'),
    );
  const providedArgumentCount = evidence.providedArgumentCount;
  const providedValid =
    providedArgumentCount === 'dynamic'
      ? expression.arguments.some((argument) => argument.kind === 'spread') &&
        evidence.omitted.length === 0 &&
        providedPositions.length === 0
      : Number.isSafeInteger(providedArgumentCount) &&
        providedArgumentCount >= 0 &&
        providedArgumentCount === expression.arguments.length &&
        !expression.arguments.some((argument) => argument.kind === 'spread') &&
        JSON.stringify(providedPositions) ===
          JSON.stringify(evidence.defaulted.filter((index) => index < providedArgumentCount)) &&
        JSON.stringify(evidence.omitted) ===
          JSON.stringify(evidence.defaulted.filter((index) => index >= providedArgumentCount));
  if (
    !Number.isSafeInteger(evidence.parameterCount) ||
    evidence.parameterCount < 0 ||
    !defaultedValid ||
    !omittedValid ||
    !providedEvidenceValid ||
    !providedValid
  ) {
    addFailure(
      'invalid-node-shape',
      `${path}.semantics.defaultParameters`,
      'default-parameter invocation evidence must have exact arity, ordered positions, value classifications, types, and omission state',
      state,
    );
  }
  if (providedEvidenceValid) {
    evidence.provided.forEach((provided, index) => {
      visitType(
        provided.argumentType,
        `${path}.semantics.defaultParameters.provided[${String(index)}].argumentType`,
        state,
      );
      visitType(
        provided.parameterType,
        `${path}.semantics.defaultParameters.provided[${String(index)}].parameterType`,
        state,
      );
    });
  }
}

function validateIrExtraArgumentErasureEvidence(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  path: string,
  state: IrModuleValidationState,
): void {
  const evidence = expression.semantics.extraArguments;
  if (!evidence) return;
  const signature = expression.semantics.signature;
  const defaulted = new Set(expression.semantics.defaultParameters?.defaulted ?? []);
  const bindingsValid =
    Array.isArray(evidence.argumentBindings) &&
    evidence.argumentBindings.length === expression.arguments.length &&
    new Set(evidence.argumentBindings.map((binding) => binding.id)).size === evidence.argumentBindings.length &&
    evidence.argumentBindings.every(
      (binding) =>
        isNonEmptyString(binding.id) &&
        isNonEmptyString(binding.name) &&
        binding.kind === 'variable' &&
        binding.scope === 'block' &&
        binding.space === 'value',
    );
  const eligible =
    signature !== undefined &&
    typeof signature.providedArgumentCount === 'number' &&
    signature.providedArgumentCount > signature.parameterCount &&
    signature.restParameter === undefined &&
    !expression.optional &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind !== 'this' &&
    !expression.arguments
      .slice(0, signature.parameterCount)
      .some((argument, index) => argument.kind === 'undefinedValue' && defaulted.has(index)) &&
    expression.semantics.statementValue === undefined;
  if (!eligible || !bindingsValid || !isIrTypeEvidence(evidence.resultType)) {
    addFailure(
      'invalid-node-shape',
      `${path}.semantics.extraArguments`,
      'extra-argument erasure evidence requires a fixed direct call, one distinct block binding per argument, and result type evidence',
      state,
    );
    return;
  }
  evidence.argumentBindings.forEach((binding, index) => {
    validateSourceOrigin(
      binding,
      `${path}.semantics.extraArguments.argumentBindings[${String(index)}]`,
      'invalid-binding-origin',
      'extra-argument carrier binding',
      state,
    );
  });
  visitType(evidence.resultType, `${path}.semantics.extraArguments.resultType`, state);
}

function validateIrOptionalParameterInvocationEvidence(
  expression: Readonly<IrInvocationExpression>,
  path: string,
  state: IrModuleValidationState,
): void {
  const evidence = expression.semantics.optionalParameters;
  if (!evidence) return;
  const optionalValid =
    evidence.optional.length > 0 &&
    isStrictlyIncreasingIntegerList(evidence.optional) &&
    evidence.optional.every((index) => index < evidence.parameterCount);
  const omittedValid =
    isStrictlyIncreasingIntegerList(evidence.omitted) &&
    evidence.omitted.every((index) => evidence.optional.includes(index));
  const providedArgumentCount = evidence.providedArgumentCount;
  const providedPositions = Array.isArray(evidence.provided)
    ? evidence.provided.map((provided) => provided.position)
    : [];
  const providedEvidenceValid =
    Array.isArray(evidence.provided) &&
    isStrictlyIncreasingIntegerList(providedPositions) &&
    evidence.provided.every(
      (provided) =>
        evidence.optional.includes(provided.position) &&
        isIrTypeEvidence(provided.argumentType) &&
        isIrTypeEvidence(provided.parameterType) &&
        (provided.value === 'null' || provided.value === 'undefined' || provided.value === 'value'),
    );
  const providedValid =
    providedArgumentCount === 'dynamic'
      ? expression.arguments.some((argument) => argument.kind === 'spread') &&
        evidence.omitted.length === 0 &&
        providedPositions.length === 0
      : Number.isSafeInteger(providedArgumentCount) &&
        providedArgumentCount >= 0 &&
        providedArgumentCount === expression.arguments.length &&
        !expression.arguments.some((argument) => argument.kind === 'spread') &&
        JSON.stringify(providedPositions) ===
          JSON.stringify(evidence.optional.filter((index) => index < providedArgumentCount)) &&
        JSON.stringify(evidence.omitted) ===
          JSON.stringify(evidence.optional.filter((index) => index >= providedArgumentCount));
  const defaults = expression.semantics.defaultParameters;
  const compatibleWithDefaults =
    !defaults ||
    (defaults.parameterCount === evidence.parameterCount &&
      defaults.providedArgumentCount === evidence.providedArgumentCount &&
      defaults.defaulted.every((index) => !evidence.optional.includes(index)));
  if (
    !Number.isSafeInteger(evidence.parameterCount) ||
    evidence.parameterCount < 0 ||
    !optionalValid ||
    !omittedValid ||
    !providedEvidenceValid ||
    !providedValid ||
    !compatibleWithDefaults
  ) {
    addFailure(
      'invalid-node-shape',
      `${path}.semantics.optionalParameters`,
      'optional-parameter invocation evidence must have exact arity, ordered positions, value classifications, types, distinct defaults, and omission state',
      state,
    );
  }
  if (providedEvidenceValid) {
    evidence.provided.forEach((provided, index) => {
      visitType(
        provided.argumentType,
        `${path}.semantics.optionalParameters.provided[${String(index)}].argumentType`,
        state,
      );
      visitType(
        provided.parameterType,
        `${path}.semantics.optionalParameters.provided[${String(index)}].parameterType`,
        state,
      );
    });
  }
}

function validateIrOverloadImplementationInvocationEvidence(
  expression: Readonly<IrInvocationExpression>,
  path: string,
  state: IrModuleValidationState,
): void {
  const evidence = expression.semantics.overloadImplementation;
  if (!evidence) return;
  const countsValid =
    Number.isSafeInteger(evidence.implementationParameterCount) &&
    evidence.implementationParameterCount >= 0 &&
    Number.isSafeInteger(evidence.resolvedParameterCount) &&
    evidence.resolvedParameterCount >= 0;
  const indexValid = Number.isSafeInteger(evidence.overloadIndex) && evidence.overloadIndex >= 0;
  const defaultsValid =
    !expression.semantics.defaultParameters ||
    expression.semantics.defaultParameters.parameterCount === evidence.implementationParameterCount;
  const optionalsValid =
    !expression.semantics.optionalParameters ||
    expression.semantics.optionalParameters.parameterCount === evidence.implementationParameterCount;
  if (!countsValid || !indexValid || !defaultsValid || !optionalsValid) {
    addFailure(
      'invalid-node-shape',
      `${path}.semantics.overloadImplementation`,
      'overload implementation evidence must identify nonnegative signature arities, source order, and implementation ABI carriers',
      state,
    );
  }
}

function isStrictlyIncreasingIntegerList(values: readonly number[]): boolean {
  return values.every(
    (value, index) => Number.isSafeInteger(value) && value >= 0 && (index === 0 || values[index - 1]! < value),
  );
}

function visitFunctionSignature(
  signature: Readonly<IrFunctionSignature>,
  path: string,
  state: IrModuleValidationState,
): void {
  visitParameters(signature.parameters, `${path}.parameters`, state);
  visitType(signature.returns, `${path}.returns`, state);
  visitTypeParameters(signature.typeParameters, `${path}.typeParameters`, 'function', state);
}

function visitObjectMember(member: Readonly<IrObjectMember>, path: string, state: IrModuleValidationState): void {
  switch (member.kind) {
    case 'computedProperty':
      visitExpression(member.key, `${path}.key`, state);
      visitExpression(member.value, `${path}.value`, state);
      break;
    case 'property':
      visitExpression(member.value, `${path}.value`, state);
      break;
    case 'spread':
      visitExpression(member.expression, `${path}.expression`, state);
      break;
    default:
      addUnknownKind(member, path, state);
  }
}

function visitParameters(
  parameters: readonly Readonly<IrParameter>[],
  path: string,
  state: IrModuleValidationState,
): void {
  validateParameterCardinality(parameters, path, state);
  parameters.forEach((parameter, index) => {
    const parameterPath = `${path}[${String(index)}]`;
    addBindingDefinition(
      parameter.binding,
      `${parameterPath}.binding`,
      { kind: 'parameter', scope: 'function', space: 'value' },
      state,
    );
    visitType(parameter.type, `${parameterPath}.type`, state);
    if (parameter.initializer) visitExpression(parameter.initializer, `${parameterPath}.initializer`, state);
  });
}

function visitStatement(statement: Readonly<IrStatement>, path: string, state: IrModuleValidationState): void {
  const label = 'label' in statement ? statement.label : undefined;
  if (label) {
    validateControlFlowLabel(label, `${path}.label`, state);
    state.controlFlowLabels.push({
      continuable:
        statement.kind === 'do' ||
        statement.kind === 'for' ||
        statement.kind === 'forIn' ||
        statement.kind === 'forOf' ||
        statement.kind === 'while',
      label,
    });
  }
  try {
    switch (statement.kind) {
      case 'block':
        visitStatementList(statement.statements, `${path}.statements`, state);
        break;
      case 'break':
        if (statement.target) validateControlFlowTarget(statement.target, false, `${path}.target`, state);
        break;
      case 'continue':
        if (statement.target) validateControlFlowTarget(statement.target, true, `${path}.target`, state);
        break;
      case 'do':
      case 'while':
        visitStatement(statement.body, `${path}.body`, state);
        visitExpression(statement.condition, `${path}.condition`, state);
        break;
      case 'expression':
      case 'throw':
        visitExpression(statement.expression, `${path}.expression`, state);
        break;
      case 'for':
        visitLexicalScope('block', path, state, () => {
          if (Array.isArray(statement.initializer)) {
            statement.initializer.forEach((variable, index) =>
              visitVariable(variable, `${path}.initializer[${String(index)}]`, ['block', 'function'], state),
            );
          } else if (statement.initializer) {
            visitExpression(statement.initializer as IrExpression, `${path}.initializer`, state);
          }
          if (statement.condition) visitExpression(statement.condition, `${path}.condition`, state);
          if (statement.increment) visitExpression(statement.increment, `${path}.increment`, state);
          visitStatement(statement.body, `${path}.body`, state);
        });
        break;
      case 'forIn': {
        visitExpression(statement.object, `${path}.object`, state);
        if (statement.keyPlan) {
          const keys = getIrExpressionStaticForInKeys(statement.object);
          const validSource =
            statement.keyPlan.kind === 'objectLiteral'
              ? statement.object.kind === 'object' &&
                keys !== undefined &&
                statement.keyPlan.evaluation ===
                  (statement.object.members.every(
                    (member) => member.kind === 'property' && member.value.kind === 'literal',
                  )
                    ? 'elide'
                    : 'preserve')
              : statement.keyPlan.kind === 'closedRecord' &&
                statement.keyPlan.evaluation === 'alreadyEvaluated' &&
                statement.object.kind === 'identifier';
          if (!validSource) {
            addFailure(
              'invalid-node-shape',
              `${path}.keyPlan`,
              'for-in key plan source and evaluation classification must match its object expression',
              state,
            );
          } else if (
            statement.keyPlan.keys.some((key) => typeof key !== 'string') ||
            new Set(statement.keyPlan.keys).size !== statement.keyPlan.keys.length ||
            JSON.stringify(statement.keyPlan.keys) !==
              JSON.stringify(
                statement.keyPlan.kind === 'objectLiteral' ? keys : orderIrStaticForInKeys(statement.keyPlan.keys),
              )
          ) {
            addFailure(
              'invalid-node-shape',
              `${path}.keyPlan.keys`,
              'static for-in keys must exactly match JavaScript object enumeration order',
              state,
            );
          }
        }
        visitLexicalScope('block', path, state, () => {
          visitVariable(statement.variable, `${path}.variable`, ['block', 'function'], state);
          visitStatement(statement.body, `${path}.body`, state);
        });
        break;
      }
      case 'forOf':
        visitExpression(statement.iterable, `${path}.iterable`, state);
        visitLexicalScope('block', path, state, () => {
          visitVariable(statement.variable, `${path}.variable`, ['block', 'function'], state);
          visitStatement(statement.body, `${path}.body`, state);
        });
        break;
      case 'if':
        visitExpression(statement.condition, `${path}.condition`, state);
        visitStatement(statement.consequent, `${path}.consequent`, state);
        if (statement.otherwise) visitStatement(statement.otherwise, `${path}.otherwise`, state);
        break;
      case 'return':
        if (statement.expression) visitExpression(statement.expression, `${path}.expression`, state);
        break;
      case 'switch':
        visitExpression(statement.expression, `${path}.expression`, state);
        visitLexicalScope('block', `${path}.cases`, state, () => {
          statement.cases.forEach((switchCase, index) => {
            const casePath = `${path}.cases[${String(index)}]`;
            if (switchCase.expression) visitExpression(switchCase.expression, `${casePath}.expression`, state);
            switchCase.statements.forEach((child, statementIndex) =>
              visitStatement(child, `${casePath}.statements[${String(statementIndex)}]`, state),
            );
          });
        });
        break;
      case 'try':
        visitStatement(statement.tryBody, `${path}.tryBody`, state);
        const catchClause = statement.catchClause;
        if (catchClause) {
          visitLexicalScope('block', `${path}.catchClause`, state, () => {
            if (catchClause.binding) {
              addBindingDefinition(
                catchClause.binding,
                `${path}.catchClause.binding`,
                { kind: 'catch', scope: 'block', space: 'value' },
                state,
              );
            }
            visitStatement(catchClause.body, `${path}.catchClause.body`, state);
          });
        }
        if (statement.finallyBody) visitStatement(statement.finallyBody, `${path}.finallyBody`, state);
        break;
      case 'variable':
        statement.declarations.forEach((variable, index) =>
          visitVariable(variable, `${path}.declarations[${String(index)}]`, ['block', 'function'], state),
        );
        break;
      default:
        addUnknownKind(statement, path, state);
    }
  } finally {
    if (label) state.controlFlowLabels.pop();
  }
}

function validateControlFlowLabel(
  label: Readonly<IrControlFlowLabelIdentity>,
  path: string,
  state: IrModuleValidationState,
): void {
  validateSourceOrigin(label, path, 'invalid-node-shape', 'control-flow label', state);
  if (!isNonEmptyString(label.id) || !isNonEmptyString(label.name)) {
    addFailure('invalid-node-shape', path, 'control-flow label identity and name must be nonempty', state);
  }
  if (state.controlFlowLabels.some((definition) => definition.label.id === label.id)) {
    addFailure('invalid-node-shape', path, `control-flow label ${label.id} is already active`, state);
  }
}

function validateControlFlowTarget(
  target: Readonly<IrControlFlowLabelIdentity>,
  continuable: boolean,
  path: string,
  state: IrModuleValidationState,
): void {
  validateSourceOrigin(target, path, 'invalid-node-shape', 'control-flow target', state);
  let definition: (typeof state.controlFlowLabels)[number] | undefined;
  for (let index = state.controlFlowLabels.length - 1; index >= 0; index -= 1) {
    const candidate = state.controlFlowLabels[index]!;
    if (candidate.label.id === target.id) {
      definition = candidate;
      break;
    }
  }
  if (!definition || definition.label.name !== target.name) {
    addFailure('invalid-node-shape', path, `control-flow target ${target.id} is not an active label`, state);
  } else if (continuable && !definition.continuable) {
    addFailure('invalid-node-shape', path, `continue target ${target.id} is not a loop label`, state);
  }
}

function visitStatementList(
  statements: readonly Readonly<IrStatement>[],
  path: string,
  state: IrModuleValidationState,
): void {
  visitLexicalScope('block', path, state, () => {
    statements.forEach((statement, index) => visitStatement(statement, `${path}[${String(index)}]`, state));
  });
}

function visitType(type: Readonly<IrType>, path: string, state: IrModuleValidationState): void {
  if (!isIrTypeEvidence(type)) {
    addFailure('invalid-node-shape', path, 'type evidence requires a discriminated type value', state);
    return;
  }
  switch (type.kind) {
    case 'array':
      visitType(type.element, `${path}.element`, state);
      break;
    case 'function':
      visitLexicalScope('function', path, state, () => {
        validateParameterCardinality(type.parameters, `${path}.parameters`, state);
        type.parameters.forEach((parameter, index) =>
          visitType(parameter.type, `${path}.parameters[${String(index)}].type`, state),
        );
        visitType(type.returns, `${path}.returns`, state);
        visitTypeParameters(type.typeParameters, `${path}.typeParameters`, 'function', state);
      });
      break;
    case 'indexedAccess':
      visitType(type.index, `${path}.index`, state);
      visitType(type.object, `${path}.object`, state);
      break;
    case 'intersection':
    case 'union':
      if (type.types.length < 2) {
        addFailure('invalid-compound-type-arity', path, `${type.kind} types require at least two members`, state);
      }
      type.types.forEach((member, index) => visitType(member, `${path}.types[${String(index)}]`, state));
      break;
    case 'keyof':
      visitType(type.type, `${path}.type`, state);
      break;
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
    case 'unknown':
      break;
    case 'named':
      if (type.reference.kind === 'binding') {
        addBindingReference(type.reference.binding, `${path}.reference.binding`, state);
      }
      type.typeArguments.forEach((argument, index) =>
        visitType(argument, `${path}.typeArguments[${String(index)}]`, state),
      );
      break;
    case 'object':
      {
        const propertyNames = new Set<string>();
        type.properties.forEach((property, index) => {
          const propertyPath = `${path}.properties[${String(index)}]`;
          if (property.name.length === 0) {
            addFailure('invalid-node-shape', `${propertyPath}.name`, 'object property name must be nonempty', state);
          } else if (propertyNames.has(property.name)) {
            addFailure('invalid-node-shape', `${propertyPath}.name`, 'object property names must be unique', state);
          }
          propertyNames.add(property.name);
          if (typeof property.optional !== 'boolean') {
            addFailure(
              'invalid-node-shape',
              `${propertyPath}.optional`,
              'object optional marker must be boolean',
              state,
            );
          }
          if (typeof property.readonly !== 'boolean') {
            addFailure(
              'invalid-node-shape',
              `${propertyPath}.readonly`,
              'object readonly marker must be boolean',
              state,
            );
          }
          visitType(property.type, `${propertyPath}.type`, state);
        });
      }
      break;
    case 'tuple':
      validateParameterCardinality(type.elements, `${path}.elements`, state);
      type.elements.forEach((element, index) =>
        visitType(element.type, `${path}.elements[${String(index)}].type`, state),
      );
      break;
    case 'typeOf':
      if (type.reference.kind === 'binding') {
        addBindingReference(type.reference.binding, `${path}.reference.binding`, state);
      }
      break;
    default:
      addUnknownKind(type, path, state);
  }
}

function visitTypeParameters(
  parameters: readonly Readonly<IrTypeParameter>[],
  path: string,
  scope: Extract<IrBindingScope, 'declaration' | 'function'>,
  state: IrModuleValidationState,
): void {
  parameters.forEach((parameter, index) => {
    const parameterPath = `${path}[${String(index)}]`;
    addBindingDefinition(
      parameter.binding,
      `${parameterPath}.binding`,
      { kind: 'typeParameter', scope, space: 'type' },
      state,
    );
    if (parameter.constraint) visitType(parameter.constraint, `${parameterPath}.constraint`, state);
    if (parameter.default) visitType(parameter.default, `${parameterPath}.default`, state);
  });
}

function getIrExpressionStaticForInKeys(expression: Readonly<IrExpression>): readonly string[] | undefined {
  if (expression.kind !== 'object' || expression.members.some((member) => member.kind !== 'property')) {
    return undefined;
  }
  const keys: string[] = [];
  expression.members.forEach((member) => {
    if (member.kind === 'property' && !keys.includes(member.name)) keys.push(member.name);
  });
  return orderIrStaticForInKeys(keys);
}

function orderIrStaticForInKeys(keys: readonly string[]): readonly string[] {
  const indices: Array<{ key: string; value: number }> = [];
  const names: string[] = [];
  for (const key of keys) {
    const value = Number(key);
    if (Number.isSafeInteger(value) && value >= 0 && value < 4_294_967_295 && String(value) === key) {
      indices.push({ key, value });
    } else {
      names.push(key);
    }
  }
  indices.sort((left, right) => left.value - right.value);
  return [...indices.map((index) => index.key), ...names];
}

const compilerIrPropertyKeyCoercions = new Set(['number', 'string', 'symbol', 'toPropertyKey']);

function isIrCallExpressionStatementValueCarrierValid(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
): boolean {
  if (
    expression.callee.kind !== 'function' ||
    expression.callee.async ||
    expression.callee.binding !== undefined ||
    expression.callee.expression !== undefined ||
    expression.callee.parameters.length > 0 ||
    expression.callee.typeParameters.length > 0 ||
    expression.arguments.length > 0 ||
    expression.optional ||
    expression.typeArguments.length > 0
  ) {
    return false;
  }
  const completion = expression.callee.body.at(-1);
  return completion?.kind === 'return' && completion.expression !== undefined;
}

function visitVariable(
  variable: Readonly<IrVariable>,
  path: string,
  scopes: readonly IrBindingScope[],
  state: IrModuleValidationState,
): void {
  if ('pattern' in variable) {
    visitBindingPattern(variable.pattern, `${path}.pattern`, scopes, state);
  } else {
    addBindingDefinition(
      variable.binding,
      `${path}.binding`,
      { kind: 'variable', scope: scopes, space: 'value' },
      state,
    );
    if (variable.initialValue !== undefined) {
      if (variable.initialValue !== 'undefined' && variable.initialValue !== 'uninitialized') {
        addFailure(
          'invalid-node-shape',
          `${path}.initialValue`,
          'variable initial value must be undefined or proven uninitialized',
          state,
        );
      }
      if (variable.binding.scope !== 'function') {
        addFailure(
          'invalid-node-shape',
          `${path}.initialValue`,
          'only function-scoped variables may have an entry-value classification',
          state,
        );
      }
      if (variable.initializer) {
        addFailure(
          'invalid-node-shape',
          `${path}.initialValue`,
          'an entry-value classification cannot share a declaration with an initializer',
          state,
        );
      }
    }
  }
  if (variable.type) visitType(variable.type, `${path}.type`, state);
  if (variable.initializer) visitExpression(variable.initializer, `${path}.initializer`, state);
}

function visitBindingPattern(
  pattern: Readonly<IrBindingPattern>,
  path: string,
  scopes: readonly IrBindingScope[],
  state: IrModuleValidationState,
): void {
  switch (pattern.kind) {
    case 'array':
      validateSourceOrigin(pattern, path, 'invalid-binding-origin', 'binding pattern', state);
      if (!scopes.includes(pattern.scope)) {
        addFailure('invalid-binding-introduction', path, `binding pattern scope must be ${scopes.join(' or ')}`, state);
      }
      pattern.elements.forEach((element, index) => {
        if (!element) return;
        const elementPath = `${path}.elements[${String(index)}]`;
        visitBindingPattern(element.pattern, `${elementPath}.pattern`, [pattern.scope], state);
        if (element.initializer) visitExpression(element.initializer, `${elementPath}.initializer`, state);
      });
      if (pattern.rest) visitBindingPattern(pattern.rest, `${path}.rest`, [pattern.scope], state);
      if (pattern.type) visitType(pattern.type, `${path}.type`, state);
      break;
    case 'binding':
      addBindingDefinition(
        pattern.binding,
        `${path}.binding`,
        { kind: 'variable', scope: scopes, space: 'value' },
        state,
      );
      if (pattern.type) visitType(pattern.type, `${path}.type`, state);
      break;
    case 'object':
      validateSourceOrigin(pattern, path, 'invalid-binding-origin', 'binding pattern', state);
      if (!scopes.includes(pattern.scope)) {
        addFailure('invalid-binding-introduction', path, `binding pattern scope must be ${scopes.join(' or ')}`, state);
      }
      pattern.properties.forEach((property, index) => {
        const propertyPath = `${path}.properties[${String(index)}]`;
        if (property.key.kind === 'computed') {
          visitExpression(property.key.expression, `${propertyPath}.key.expression`, state);
        } else if (property.key.name.length === 0) {
          addFailure('invalid-node-shape', `${propertyPath}.key.name`, 'object binding key must be nonempty', state);
        }
        visitBindingPattern(property.pattern, `${propertyPath}.pattern`, [pattern.scope], state);
        if (property.initializer) visitExpression(property.initializer, `${propertyPath}.initializer`, state);
      });
      if (pattern.rest) {
        if (pattern.rest.kind !== 'binding') {
          addFailure('invalid-node-shape', `${path}.rest`, 'object binding rest must introduce one binding', state);
        }
        visitBindingPattern(pattern.rest, `${path}.rest`, [pattern.scope], state);
      }
      if (pattern.type) visitType(pattern.type, `${path}.type`, state);
      break;
    default:
      addUnknownKind(pattern, path, state);
  }
}

function validateBindingOrigin(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  path: string,
  state: IrModuleValidationState,
): void {
  validateSourceOrigin(binding, path, 'invalid-binding-origin', 'binding', state);
}

function validateBindingIntroduction(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  path: string,
  expectation: Readonly<BindingIntroductionExpectation>,
  state: IrModuleValidationState,
): void {
  const scopes = typeof expectation.scope === 'string' ? [expectation.scope] : expectation.scope;
  if (binding.space !== expectation.space || binding.kind !== expectation.kind || !scopes.includes(binding.scope)) {
    addFailure(
      'invalid-binding-introduction',
      path,
      `binding introduction requires ${expectation.space} ${expectation.kind} in ${scopes.join(' or ')} scope`,
      state,
    );
  }
}

function validateSourceOrigin(
  origin: Readonly<CompilerSourceOrigin>,
  path: string,
  code: Extract<
    CompilerIrModuleValidationFailureCode,
    'invalid-binding-origin' | 'invalid-declaration-origin' | 'invalid-node-shape'
  >,
  subject: string,
  state: IrModuleValidationState,
): void {
  if (
    origin.packageName !== state.module.packageName ||
    origin.source !== state.module.source ||
    !isPositiveInteger(origin.line) ||
    !isPositiveInteger(origin.column) ||
    !isCompilerSourceFingerprint(origin.fingerprint)
  ) {
    addFailure(
      code,
      path,
      `${subject} origin must identify a positive source location in its containing module and an exact SHA-256 fingerprint`,
      state,
    );
  }
}

function validateBindingReferences(state: IrModuleValidationState): void {
  for (const reference of state.references) {
    const definition = state.bindings.get(reference.binding.id);
    if (!definition) {
      addFailure(
        'dangling-binding-reference',
        reference.path,
        `binding ${reference.binding.id} has no introduction in the module`,
        state,
      );
      continue;
    }
    const expected = definition.binding;
    const received = reference.binding;
    if (
      expected.space !== received.space ||
      expected.kind !== received.kind ||
      expected.scope !== received.scope ||
      expected.packageName !== received.packageName ||
      expected.source !== received.source ||
      expected.line !== received.line ||
      expected.column !== received.column ||
      expected.fingerprint !== received.fingerprint
    ) {
      addFailure(
        'inconsistent-binding-reference',
        reference.path,
        `binding ${received.id} metadata differs from its introduction at ${definition.path}`,
        state,
      );
    }
    if (!isLexicalScopeAncestor(definition.scope, reference.scope, state.scopeParents)) {
      addFailure(
        'out-of-scope-binding-reference',
        reference.path,
        `binding ${received.id} is introduced outside the reference's lexical scope at ${definition.path}`,
        state,
      );
    }
  }
}

function isLexicalScopeAncestor(
  expected: string,
  received: string,
  parents: ReadonlyMap<string, string | undefined>,
): boolean {
  let scope: string | undefined = received;
  while (scope !== undefined) {
    if (scope === expected) return true;
    scope = parents.get(scope);
  }
  return false;
}

function validateModuleIdentity(module: Readonly<IrModule>, state: IrModuleValidationState): void {
  if (!isNonEmptyString(module.name) || !isNonEmptyString(module.packageName) || !isNonEmptyString(module.source)) {
    addFailure('invalid-module-identity', '$', 'module name, packageName, and source must be nonempty strings', state);
  }
}

function validateParameterCardinality(
  parameters: readonly Readonly<ParameterCardinality>[],
  path: string,
  state: IrModuleValidationState,
): void {
  parameters.forEach((parameter, index) => {
    if (
      (parameter.rest && parameter.optional) ||
      (parameter.initializer !== undefined && !parameter.optional) ||
      (parameter.rest && index !== parameters.length - 1)
    ) {
      addFailure(
        'invalid-parameter-cardinality',
        `${path}[${String(index)}]`,
        'rest values must be required, initializer-free, and last; initializers require optional cardinality',
        state,
      );
    }
  });
}

function visitLexicalScope(
  kind: IrBindingScope,
  path: string,
  state: IrModuleValidationState,
  visit: () => void,
): void {
  const parent = getCurrentLexicalScope(state).id;
  const scope: IrLexicalScope = { id: `${path}#${kind}`, kind };
  state.scopeParents.set(scope.id, parent);
  state.scopes.push(scope);
  try {
    visit();
  } finally {
    state.scopes.pop();
  }
}
