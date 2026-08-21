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
  IrDeclaration,
  IrExpression,
  IrFunctionSignature,
  IrModule,
  IrObjectMember,
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
  const existing = state.bindings.get(binding.id);
  if (existing) {
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
    scope: getBindingIntroductionScope(binding.scope, expectation.scope, state),
  });
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
    case 'new':
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
      break;
    case 'property':
      visitExpression(expression.object, `${path}.object`, state);
      break;
    case 'template':
      expression.parts.forEach((part, index) => {
        if (typeof part !== 'string') visitExpression(part, `${path}.parts[${String(index)}]`, state);
      });
      break;
    case 'tupleRest':
      if (!Number.isSafeInteger(expression.start) || expression.start < 0) {
        addFailure('invalid-node-shape', `${path}.start`, 'tuple rest start must be a nonnegative integer', state);
      }
      visitExpression(expression.object, `${path}.object`, state);
      break;
    case 'unary':
      visitExpression(expression.operand, `${path}.operand`, state);
      break;
    case 'undefinedDefault':
      visitExpression(expression.fallback, `${path}.fallback`, state);
      visitExpression(expression.value, `${path}.value`, state);
      break;
    default:
      addUnknownKind(expression, path, state);
  }
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
  switch (statement.kind) {
    case 'block':
      visitStatementList(statement.statements, `${path}.statements`, state);
      break;
    case 'break':
    case 'continue':
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
    case 'forIn':
      visitExpression(statement.object, `${path}.object`, state);
      visitLexicalScope('block', path, state, () => {
        visitVariable(statement.variable, `${path}.variable`, ['block', 'function'], state);
        visitStatement(statement.body, `${path}.body`, state);
      });
      break;
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
      type.properties.forEach((property, index) =>
        visitType(property.type, `${path}.properties[${String(index)}].type`, state),
      );
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
  code: Extract<CompilerIrModuleValidationFailureCode, 'invalid-binding-origin' | 'invalid-declaration-origin'>,
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
