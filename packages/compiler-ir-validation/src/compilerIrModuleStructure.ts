import type {
  CompilerIrModuleValidation,
  CompilerIrModuleValidationFailure,
  CompilerIrModuleValidationFailureCode,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrFunctionSignature,
  IrModule,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrType,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrVariable,
} from '../../compiler-types/src/index.js';

interface BindingDefinition {
  readonly binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>;
  readonly path: string;
}

interface BindingReference {
  readonly binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>;
  readonly path: string;
}

interface IrModuleValidationState {
  readonly bindings: Map<string, BindingDefinition>;
  readonly failures: CompilerIrModuleValidationFailure[];
  readonly module: Readonly<IrModule>;
  readonly references: BindingReference[];
}

interface ParameterCardinality {
  readonly initializer?: unknown;
  readonly optional: boolean;
  readonly rest: boolean;
}

export function validateIrModuleStructure(module: Readonly<IrModule>): CompilerIrModuleValidation {
  const state: IrModuleValidationState = {
    bindings: new Map(),
    failures: [],
    module,
    references: [],
  };
  try {
    validateModuleIdentity(module, state);
    module.imports.forEach((imported, importIndex) => {
      imported.bindings.forEach(({ binding }, bindingIndex) =>
        addBindingDefinition(binding, `$.imports[${String(importIndex)}].bindings[${String(bindingIndex)}]`, state),
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
  state: IrModuleValidationState,
): void {
  if (!isNonEmptyString(binding.id) || !isNonEmptyString(binding.name)) {
    addFailure('invalid-binding-identity', path, 'binding id and name must be nonempty strings', state);
    return;
  }
  validateBindingOrigin(binding, path, state);
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
  state.bindings.set(binding.id, { binding, path });
}

function addBindingReference(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  path: string,
  state: IrModuleValidationState,
): void {
  state.references.push({ binding, path });
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

function visitDeclaration(declaration: Readonly<IrDeclaration>, path: string, state: IrModuleValidationState): void {
  switch (declaration.kind) {
    case 'class':
      addBindingDefinition(declaration.binding, `${path}.binding`, state);
      visitTypeParameters(declaration.typeParameters, `${path}.typeParameters`, state);
      if (declaration.extends) visitType(declaration.extends, `${path}.extends`, state);
      declaration.implements.forEach((type, index) => visitType(type, `${path}.implements[${String(index)}]`, state));
      declaration.fields.forEach((field, index) => {
        const fieldPath = `${path}.fields[${String(index)}]`;
        visitType(field.type, `${fieldPath}.type`, state);
        if (field.initializer) visitExpression(field.initializer, `${fieldPath}.initializer`, state);
      });
      if (declaration.classConstructor) {
        visitParameters(declaration.classConstructor.parameters, `${path}.classConstructor.parameters`, state);
        declaration.classConstructor.body.forEach((statement, index) =>
          visitStatement(statement, `${path}.classConstructor.body[${String(index)}]`, state),
        );
      }
      declaration.methods.forEach((method, index) => {
        const methodPath = `${path}.methods[${String(index)}]`;
        visitFunctionSignature(method, methodPath, state);
        method.body.forEach((statement, statementIndex) =>
          visitStatement(statement, `${methodPath}.body[${String(statementIndex)}]`, state),
        );
      });
      break;
    case 'enum':
      addBindingDefinition(declaration.binding, `${path}.binding`, state);
      break;
    case 'function':
      addBindingDefinition(declaration.binding, `${path}.binding`, state);
      visitFunctionSignature(declaration, path, state);
      declaration.overloads.forEach((overload, index) =>
        visitFunctionSignature(overload, `${path}.overloads[${String(index)}]`, state),
      );
      declaration.body.forEach((statement, index) =>
        visitStatement(statement, `${path}.body[${String(index)}]`, state),
      );
      break;
    case 'interface':
      addBindingDefinition(declaration.binding, `${path}.binding`, state);
      visitTypeParameters(declaration.typeParameters, `${path}.typeParameters`, state);
      declaration.extends.forEach((type, index) => visitType(type, `${path}.extends[${String(index)}]`, state));
      declaration.properties.forEach((property, index) =>
        visitType(property.type, `${path}.properties[${String(index)}].type`, state),
      );
      break;
    case 'typeAlias':
      addBindingDefinition(declaration.binding, `${path}.binding`, state);
      visitTypeParameters(declaration.typeParameters, `${path}.typeParameters`, state);
      visitType(declaration.type, `${path}.type`, state);
      break;
    case 'variable':
      visitVariable(declaration, path, state);
      break;
    default:
      addUnknownKind(declaration, path, state);
  }
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
      if (expression.binding) addBindingDefinition(expression.binding, `${path}.binding`, state);
      visitParameters(expression.parameters, `${path}.parameters`, state);
      visitType(expression.returns, `${path}.returns`, state);
      visitTypeParameters(expression.typeParameters, `${path}.typeParameters`, state);
      expression.body.forEach((statement, index) => visitStatement(statement, `${path}.body[${String(index)}]`, state));
      if (expression.expression) visitExpression(expression.expression, `${path}.expression`, state);
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
    case 'unary':
      visitExpression(expression.operand, `${path}.operand`, state);
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
  visitTypeParameters(signature.typeParameters, `${path}.typeParameters`, state);
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
    addBindingDefinition(parameter.binding, `${parameterPath}.binding`, state);
    visitType(parameter.type, `${parameterPath}.type`, state);
    if (parameter.initializer) visitExpression(parameter.initializer, `${parameterPath}.initializer`, state);
  });
}

function visitStatement(statement: Readonly<IrStatement>, path: string, state: IrModuleValidationState): void {
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((child, index) =>
        visitStatement(child, `${path}.statements[${String(index)}]`, state),
      );
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
      if (Array.isArray(statement.initializer)) {
        statement.initializer.forEach((variable, index) =>
          visitVariable(variable, `${path}.initializer[${String(index)}]`, state),
        );
      } else if (statement.initializer) {
        visitExpression(statement.initializer as IrExpression, `${path}.initializer`, state);
      }
      if (statement.condition) visitExpression(statement.condition, `${path}.condition`, state);
      if (statement.increment) visitExpression(statement.increment, `${path}.increment`, state);
      visitStatement(statement.body, `${path}.body`, state);
      break;
    case 'forIn':
      visitVariable(statement.variable, `${path}.variable`, state);
      visitExpression(statement.object, `${path}.object`, state);
      visitStatement(statement.body, `${path}.body`, state);
      break;
    case 'forOf':
      visitVariable(statement.variable, `${path}.variable`, state);
      visitExpression(statement.iterable, `${path}.iterable`, state);
      visitStatement(statement.body, `${path}.body`, state);
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
      statement.cases.forEach((switchCase, index) => {
        const casePath = `${path}.cases[${String(index)}]`;
        if (switchCase.expression) visitExpression(switchCase.expression, `${casePath}.expression`, state);
        switchCase.statements.forEach((child, statementIndex) =>
          visitStatement(child, `${casePath}.statements[${String(statementIndex)}]`, state),
        );
      });
      break;
    case 'try':
      visitStatement(statement.tryBody, `${path}.tryBody`, state);
      if (statement.catchClause) {
        if (statement.catchClause.binding) {
          addBindingDefinition(statement.catchClause.binding, `${path}.catchClause.binding`, state);
        }
        visitStatement(statement.catchClause.body, `${path}.catchClause.body`, state);
      }
      if (statement.finallyBody) visitStatement(statement.finallyBody, `${path}.finallyBody`, state);
      break;
    case 'variable':
      statement.declarations.forEach((variable, index) =>
        visitVariable(variable, `${path}.declarations[${String(index)}]`, state),
      );
      break;
    default:
      addUnknownKind(statement, path, state);
  }
}

function visitType(type: Readonly<IrType>, path: string, state: IrModuleValidationState): void {
  switch (type.kind) {
    case 'array':
      visitType(type.element, `${path}.element`, state);
      break;
    case 'function':
      validateParameterCardinality(type.parameters, `${path}.parameters`, state);
      type.parameters.forEach((parameter, index) =>
        visitType(parameter.type, `${path}.parameters[${String(index)}].type`, state),
      );
      visitType(type.returns, `${path}.returns`, state);
      visitTypeParameters(type.typeParameters, `${path}.typeParameters`, state);
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
  state: IrModuleValidationState,
): void {
  parameters.forEach((parameter, index) => {
    const parameterPath = `${path}[${String(index)}]`;
    addBindingDefinition(parameter.binding, `${parameterPath}.binding`, state);
    if (parameter.constraint) visitType(parameter.constraint, `${parameterPath}.constraint`, state);
    if (parameter.default) visitType(parameter.default, `${parameterPath}.default`, state);
  });
}

function visitVariable(variable: Readonly<IrVariable>, path: string, state: IrModuleValidationState): void {
  addBindingDefinition(variable.binding, `${path}.binding`, state);
  if (variable.type) visitType(variable.type, `${path}.type`, state);
  if (variable.initializer) visitExpression(variable.initializer, `${path}.initializer`, state);
}

function validateBindingOrigin(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  path: string,
  state: IrModuleValidationState,
): void {
  if (
    binding.packageName !== state.module.packageName ||
    binding.source !== state.module.source ||
    !isPositiveInteger(binding.line) ||
    !isPositiveInteger(binding.column) ||
    !isNonEmptyString(binding.fingerprint)
  ) {
    addFailure(
      'invalid-binding-origin',
      path,
      'binding origin must identify a positive source location in its containing module',
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
  }
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
      (parameter.rest && (parameter.optional || parameter.initializer !== undefined)) ||
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
