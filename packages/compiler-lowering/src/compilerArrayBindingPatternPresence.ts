import type {
  IrDeclaration,
  IrBindingPattern,
  IrExpression,
  IrModule,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';

export function hasIrModuleArrayBindingPattern(module: Readonly<IrModule>): boolean {
  return (
    module.declarations.some(hasIrDeclarationArrayBindingPattern) ||
    module.exports.some((item) =>
      item.kind === 'default' ? hasIrExpressionArrayBindingPattern(item.expression) : false,
    )
  );
}

function hasIrDeclarationArrayBindingPattern(declaration: Readonly<IrDeclaration>): boolean {
  switch (declaration.kind) {
    case 'class':
      return (
        declaration.fields.some((field) =>
          field.initializer ? hasIrExpressionArrayBindingPattern(field.initializer) : false,
        ) ||
        (declaration.classConstructor
          ? declaration.classConstructor.parameters.some(hasIrParameterArrayBindingPattern) ||
            declaration.classConstructor.body.some(hasIrStatementArrayBindingPattern)
          : false) ||
        declaration.methods.some(
          (method) =>
            method.parameters.some(hasIrParameterArrayBindingPattern) ||
            method.body.some(hasIrStatementArrayBindingPattern),
        )
      );
    case 'function':
      return (
        declaration.parameters.some(hasIrParameterArrayBindingPattern) ||
        declaration.overloads.some((overload) => overload.parameters.some(hasIrParameterArrayBindingPattern)) ||
        declaration.body.some(hasIrStatementArrayBindingPattern)
      );
    case 'variable':
      return hasIrVariableArrayBindingPattern(declaration);
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return false;
  }
}

function hasIrExpressionArrayBindingPattern(expression: Readonly<IrExpression>): boolean {
  switch (expression.kind) {
    case 'array':
      return expression.elements.some((element) => (element ? hasIrExpressionArrayBindingPattern(element) : false));
    case 'assignment':
    case 'binary':
      return (
        hasIrExpressionArrayBindingPattern(expression.left) || hasIrExpressionArrayBindingPattern(expression.right)
      );
    case 'await':
    case 'cast':
    case 'spread':
      return hasIrExpressionArrayBindingPattern(expression.expression);
    case 'call':
    case 'new':
      return (
        hasIrExpressionArrayBindingPattern(expression.callee) ||
        expression.arguments.some(hasIrExpressionArrayBindingPattern)
      );
    case 'conditional':
      return (
        hasIrExpressionArrayBindingPattern(expression.condition) ||
        hasIrExpressionArrayBindingPattern(expression.whenFalse) ||
        hasIrExpressionArrayBindingPattern(expression.whenTrue)
      );
    case 'element':
      return (
        hasIrExpressionArrayBindingPattern(expression.index) || hasIrExpressionArrayBindingPattern(expression.object)
      );
    case 'function':
      return (
        expression.parameters.some(hasIrParameterArrayBindingPattern) ||
        expression.body.some(hasIrStatementArrayBindingPattern) ||
        (expression.expression ? hasIrExpressionArrayBindingPattern(expression.expression) : false)
      );
    case 'object':
      return expression.members.some(hasIrObjectMemberArrayBindingPattern);
    case 'property':
      return hasIrExpressionArrayBindingPattern(expression.object);
    case 'template':
      return expression.parts.some((part) =>
        typeof part === 'string' ? false : hasIrExpressionArrayBindingPattern(part),
      );
    case 'tuple':
      return expression.elements.some(
        (element) => element.expression && hasIrExpressionArrayBindingPattern(element.expression),
      );
    case 'tupleSpread':
      return expression.segments.some((segment) =>
        segment.kind === 'spread'
          ? hasIrExpressionArrayBindingPattern(segment.expression)
          : segment.element.expression
            ? hasIrExpressionArrayBindingPattern(segment.element.expression)
            : false,
      );
    case 'tupleRest':
      return hasIrExpressionArrayBindingPattern(expression.object);
    case 'tupleSuffix':
      return false;
    case 'unary':
      return hasIrExpressionArrayBindingPattern(expression.operand);
    case 'undefinedDefault':
      return (
        hasIrExpressionArrayBindingPattern(expression.fallback) || hasIrExpressionArrayBindingPattern(expression.value)
      );
    case 'identifier':
    case 'literal':
    case 'regexp':
      return false;
  }
}

function hasIrObjectMemberArrayBindingPattern(member: Readonly<IrObjectMember>): boolean {
  switch (member.kind) {
    case 'computedProperty':
      return hasIrExpressionArrayBindingPattern(member.key) || hasIrExpressionArrayBindingPattern(member.value);
    case 'property':
      return hasIrExpressionArrayBindingPattern(member.value);
    case 'spread':
      return hasIrExpressionArrayBindingPattern(member.expression);
  }
}

function hasIrParameterArrayBindingPattern(parameter: Readonly<IrParameter>): boolean {
  return parameter.initializer ? hasIrExpressionArrayBindingPattern(parameter.initializer) : false;
}

function hasIrStatementArrayBindingPattern(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some(hasIrStatementArrayBindingPattern);
    case 'do':
    case 'while':
      return (
        hasIrStatementArrayBindingPattern(statement.body) || hasIrExpressionArrayBindingPattern(statement.condition)
      );
    case 'expression':
    case 'throw':
      return hasIrExpressionArrayBindingPattern(statement.expression);
    case 'for':
      return (
        (isIrVariableList(statement.initializer)
          ? statement.initializer.some(hasIrVariableArrayBindingPattern)
          : statement.initializer
            ? hasIrExpressionArrayBindingPattern(statement.initializer)
            : false) ||
        (statement.condition ? hasIrExpressionArrayBindingPattern(statement.condition) : false) ||
        (statement.increment ? hasIrExpressionArrayBindingPattern(statement.increment) : false) ||
        hasIrStatementArrayBindingPattern(statement.body)
      );
    case 'forIn':
      return (
        hasIrVariableArrayBindingPattern(statement.variable) ||
        hasIrExpressionArrayBindingPattern(statement.object) ||
        hasIrStatementArrayBindingPattern(statement.body)
      );
    case 'forOf':
      return (
        hasIrVariableArrayBindingPattern(statement.variable) ||
        hasIrExpressionArrayBindingPattern(statement.iterable) ||
        hasIrStatementArrayBindingPattern(statement.body)
      );
    case 'if':
      return (
        hasIrExpressionArrayBindingPattern(statement.condition) ||
        hasIrStatementArrayBindingPattern(statement.consequent) ||
        (statement.otherwise ? hasIrStatementArrayBindingPattern(statement.otherwise) : false)
      );
    case 'return':
      return statement.expression ? hasIrExpressionArrayBindingPattern(statement.expression) : false;
    case 'switch':
      return (
        hasIrExpressionArrayBindingPattern(statement.expression) ||
        statement.cases.some(
          (item) =>
            (item.expression ? hasIrExpressionArrayBindingPattern(item.expression) : false) ||
            item.statements.some(hasIrStatementArrayBindingPattern),
        )
      );
    case 'try':
      return (
        hasIrStatementArrayBindingPattern(statement.tryBody) ||
        (statement.catchClause ? hasIrStatementArrayBindingPattern(statement.catchClause.body) : false) ||
        (statement.finallyBody ? hasIrStatementArrayBindingPattern(statement.finallyBody) : false)
      );
    case 'variable':
      return statement.declarations.some(hasIrVariableArrayBindingPattern);
    case 'break':
    case 'continue':
      return false;
  }
}

function hasIrVariableArrayBindingPattern(variable: Readonly<IrVariable>): boolean {
  return (
    ('pattern' in variable ? hasIrBindingPatternArrayBindingPattern(variable.pattern) : false) ||
    (variable.initializer ? hasIrExpressionArrayBindingPattern(variable.initializer) : false)
  );
}

function hasIrBindingPatternArrayBindingPattern(pattern: Readonly<IrBindingPattern>): boolean {
  if (pattern.kind === 'binding') return false;
  if (pattern.kind === 'array') return true;
  return (
    pattern.properties.some(
      (property) =>
        (property.key.kind === 'computed' && hasIrExpressionArrayBindingPattern(property.key.expression)) ||
        (property.initializer ? hasIrExpressionArrayBindingPattern(property.initializer) : false) ||
        hasIrBindingPatternArrayBindingPattern(property.pattern),
    ) || (pattern.rest ? hasIrBindingPatternArrayBindingPattern(pattern.rest) : false)
  );
}

function isIrVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}
