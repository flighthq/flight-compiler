import type {
  CompilerIrTraversalObserver,
  IrBindingPattern,
  IrDeclaration,
  IrExpression,
  IrFunctionSignature,
  IrModule,
  IrObjectMember,
  IrOptionalChainSemantics,
  IrParameter,
  IrStatement,
  IrType,
  IrTypeParameter,
  IrVariable,
} from '../../compiler-types/src/index.js';

const compilerIrTraversalStop = Symbol('compiler-ir-traversal-stop');

export function analyzeIrModuleTraversal(
  module: Readonly<IrModule>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  try {
    observeIrTraversalValue(observer.module, module);
    module.declarations.forEach((declaration) => analyzeIrDeclarationTraversal(declaration, observer));
    module.exports.forEach((exported) => {
      if (exported.kind === 'default') analyzeIrExpressionTraversal(exported.expression, observer);
    });
  } catch (error) {
    if (error !== compilerIrTraversalStop) throw error;
  }
}

function analyzeIrBindingPatternTraversal(
  pattern: Readonly<IrBindingPattern>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.bindingPattern, pattern);
  if (pattern.type) analyzeIrTypeTraversal(pattern.type, observer);
  if (pattern.kind === 'binding') return;
  if (pattern.kind === 'array') {
    pattern.elements.forEach((element) => {
      if (!element) return;
      if (element.initializer) analyzeIrExpressionTraversal(element.initializer, observer);
      analyzeIrBindingPatternTraversal(element.pattern, observer);
    });
  } else {
    pattern.properties.forEach((property) => {
      if (property.key.kind === 'computed') analyzeIrExpressionTraversal(property.key.expression, observer);
      if (property.initializer) analyzeIrExpressionTraversal(property.initializer, observer);
      analyzeIrBindingPatternTraversal(property.pattern, observer);
    });
  }
  if (pattern.rest) analyzeIrBindingPatternTraversal(pattern.rest, observer);
}

function analyzeIrDeclarationTraversal(
  declaration: Readonly<IrDeclaration>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.declaration, declaration);
  switch (declaration.kind) {
    case 'class':
      declaration.typeParameters.forEach((parameter) => analyzeIrTypeParameterTraversal(parameter, observer));
      if (declaration.extends) analyzeIrTypeTraversal(declaration.extends, observer);
      declaration.implements.forEach((type) => analyzeIrTypeTraversal(type, observer));
      declaration.fields.forEach((field) => {
        analyzeIrTypeTraversal(field.type, observer);
        if (field.initializer) analyzeIrExpressionTraversal(field.initializer, observer);
      });
      if (declaration.classConstructor) {
        declaration.classConstructor.parameters.forEach((parameter) =>
          analyzeIrParameterTraversal(parameter, observer),
        );
        declaration.classConstructor.body.forEach((statement) => analyzeIrStatementTraversal(statement, observer));
      }
      declaration.methods.forEach((method) => {
        analyzeIrFunctionSignatureTraversal(method, observer);
        method.body.forEach((statement) => analyzeIrStatementTraversal(statement, observer));
      });
      break;
    case 'function':
      analyzeIrFunctionSignatureTraversal(declaration, observer);
      declaration.overloads.forEach((overload) => analyzeIrFunctionSignatureTraversal(overload, observer));
      declaration.body.forEach((statement) => analyzeIrStatementTraversal(statement, observer));
      break;
    case 'interface':
      declaration.typeParameters.forEach((parameter) => analyzeIrTypeParameterTraversal(parameter, observer));
      declaration.extends.forEach((type) => analyzeIrTypeTraversal(type, observer));
      declaration.properties.forEach((property) => analyzeIrTypeTraversal(property.type, observer));
      break;
    case 'typeAlias':
      declaration.typeParameters.forEach((parameter) => analyzeIrTypeParameterTraversal(parameter, observer));
      analyzeIrTypeTraversal(declaration.type, observer);
      break;
    case 'variable':
      analyzeIrVariableTraversal(declaration, observer);
      break;
    case 'enum':
      break;
    default:
      assertNeverIrTraversal(declaration);
  }
}

function analyzeIrExpressionTraversal(
  expression: Readonly<IrExpression>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.expression, expression);
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) analyzeIrExpressionTraversal(element, observer);
      });
      break;
    case 'assignment':
    case 'binary':
      analyzeIrExpressionTraversal(expression.left, observer);
      analyzeIrExpressionTraversal(expression.right, observer);
      break;
    case 'await':
    case 'spread':
      analyzeIrExpressionTraversal(expression.expression, observer);
      break;
    case 'call':
      analyzeIrExpressionTraversal(expression.callee, observer);
      expression.arguments.forEach((argument) => analyzeIrExpressionTraversal(argument, observer));
      expression.typeArguments.forEach((type) => analyzeIrTypeTraversal(type, observer));
      analyzeIrOptionalChainTraversal(expression.semantics.optionalChain, observer);
      expression.semantics.optionalParameters?.provided.forEach((provided) => {
        analyzeIrTypeTraversal(provided.argumentType, observer);
        analyzeIrTypeTraversal(provided.parameterType, observer);
      });
      break;
    case 'cast':
      analyzeIrExpressionTraversal(expression.expression, observer);
      analyzeIrTypeTraversal(expression.type, observer);
      break;
    case 'conditional':
      analyzeIrExpressionTraversal(expression.condition, observer);
      analyzeIrExpressionTraversal(expression.whenTrue, observer);
      analyzeIrExpressionTraversal(expression.whenFalse, observer);
      break;
    case 'element':
      analyzeIrExpressionTraversal(expression.object, observer);
      analyzeIrExpressionTraversal(expression.index, observer);
      analyzeIrOptionalChainTraversal(expression.semantics.optionalChain, observer);
      break;
    case 'function':
      analyzeIrFunctionSignatureTraversal(expression, observer);
      expression.body.forEach((statement) => analyzeIrStatementTraversal(statement, observer));
      if (expression.expression) analyzeIrExpressionTraversal(expression.expression, observer);
      break;
    case 'new':
      analyzeIrExpressionTraversal(expression.callee, observer);
      expression.arguments.forEach((argument) => analyzeIrExpressionTraversal(argument, observer));
      expression.typeArguments.forEach((type) => analyzeIrTypeTraversal(type, observer));
      break;
    case 'object':
      expression.members.forEach((member) => analyzeIrObjectMemberTraversal(member, observer));
      break;
    case 'objectRest':
      analyzeIrExpressionTraversal(expression.object, observer);
      analyzeIrTypeTraversal(expression.type, observer);
      expression.excluded.forEach((key) => {
        if (key.kind === 'computed') analyzeIrExpressionTraversal(key.expression, observer);
      });
      break;
    case 'property':
      analyzeIrExpressionTraversal(expression.object, observer);
      analyzeIrOptionalChainTraversal(expression.optionalChain, observer);
      break;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') analyzeIrExpressionTraversal(part, observer);
      });
      break;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) analyzeIrExpressionTraversal(element.expression, observer);
      });
      break;
    case 'tupleSpread':
      analyzeIrTypeTraversal(expression.type, observer);
      expression.segments.forEach((segment) => {
        if (segment.kind === 'spread') {
          analyzeIrExpressionTraversal(segment.expression, observer);
          analyzeIrTypeTraversal(segment.type, observer);
        } else if (segment.element.expression) {
          analyzeIrExpressionTraversal(segment.element.expression, observer);
        }
      });
      break;
    case 'tupleRest':
    case 'tupleSuffix':
      analyzeIrExpressionTraversal(expression.object, observer);
      break;
    case 'unary':
      analyzeIrExpressionTraversal(expression.operand, observer);
      break;
    case 'undefinedDefault':
      analyzeIrExpressionTraversal(expression.value, observer);
      analyzeIrExpressionTraversal(expression.fallback, observer);
      break;
    case 'undefinedValue':
      analyzeIrTypeTraversal(expression.type, observer);
      break;
    case 'identifier':
    case 'literal':
    case 'regexp':
      break;
    default:
      assertNeverIrTraversal(expression);
  }
}

function analyzeIrFunctionSignatureTraversal(
  signature: Readonly<IrFunctionSignature>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.functionSignature, signature);
  signature.typeParameters.forEach((parameter) => analyzeIrTypeParameterTraversal(parameter, observer));
  signature.parameters.forEach((parameter) => analyzeIrParameterTraversal(parameter, observer));
  analyzeIrTypeTraversal(signature.returns, observer);
}

function analyzeIrObjectMemberTraversal(
  member: Readonly<IrObjectMember>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.objectMember, member);
  switch (member.kind) {
    case 'computedProperty':
      analyzeIrExpressionTraversal(member.key, observer);
      analyzeIrExpressionTraversal(member.value, observer);
      break;
    case 'property':
      analyzeIrExpressionTraversal(member.value, observer);
      break;
    case 'spread':
      analyzeIrExpressionTraversal(member.expression, observer);
      break;
    default:
      assertNeverIrTraversal(member);
  }
}

function analyzeIrOptionalChainTraversal(
  semantics: Readonly<IrOptionalChainSemantics> | undefined,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  if (!semantics) return;
  observeIrTraversalValue(observer.optionalChain, semantics);
  analyzeIrTypeTraversal(semantics.receiverType, observer);
  analyzeIrTypeTraversal(semantics.valueType, observer);
}

function analyzeIrParameterTraversal(
  parameter: Readonly<IrParameter>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.parameter, parameter);
  analyzeIrTypeTraversal(parameter.type, observer);
  if (parameter.initializer) analyzeIrExpressionTraversal(parameter.initializer, observer);
}

function analyzeIrStatementTraversal(
  statement: Readonly<IrStatement>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.statement, statement);
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((child) => analyzeIrStatementTraversal(child, observer));
      break;
    case 'do':
    case 'while':
      analyzeIrStatementTraversal(statement.body, observer);
      analyzeIrExpressionTraversal(statement.condition, observer);
      break;
    case 'expression':
    case 'throw':
      analyzeIrExpressionTraversal(statement.expression, observer);
      break;
    case 'for':
      if (Array.isArray(statement.initializer)) {
        statement.initializer.forEach((variable) => analyzeIrVariableTraversal(variable, observer));
      } else if (statement.initializer) {
        analyzeIrExpressionTraversal(statement.initializer as IrExpression, observer);
      }
      if (statement.condition) analyzeIrExpressionTraversal(statement.condition, observer);
      if (statement.increment) analyzeIrExpressionTraversal(statement.increment, observer);
      analyzeIrStatementTraversal(statement.body, observer);
      break;
    case 'forIn':
      analyzeIrVariableTraversal(statement.variable, observer);
      analyzeIrExpressionTraversal(statement.object, observer);
      analyzeIrStatementTraversal(statement.body, observer);
      break;
    case 'forOf':
      analyzeIrVariableTraversal(statement.variable, observer);
      analyzeIrExpressionTraversal(statement.iterable, observer);
      analyzeIrStatementTraversal(statement.body, observer);
      break;
    case 'if':
      analyzeIrExpressionTraversal(statement.condition, observer);
      analyzeIrStatementTraversal(statement.consequent, observer);
      if (statement.otherwise) analyzeIrStatementTraversal(statement.otherwise, observer);
      break;
    case 'return':
      if (statement.expression) analyzeIrExpressionTraversal(statement.expression, observer);
      break;
    case 'switch':
      analyzeIrExpressionTraversal(statement.expression, observer);
      statement.cases.forEach((switchCase) => {
        if (switchCase.expression) analyzeIrExpressionTraversal(switchCase.expression, observer);
        switchCase.statements.forEach((child) => analyzeIrStatementTraversal(child, observer));
      });
      break;
    case 'try':
      analyzeIrStatementTraversal(statement.tryBody, observer);
      if (statement.catchClause) analyzeIrStatementTraversal(statement.catchClause.body, observer);
      if (statement.finallyBody) analyzeIrStatementTraversal(statement.finallyBody, observer);
      break;
    case 'variable':
      statement.declarations.forEach((variable) => analyzeIrVariableTraversal(variable, observer));
      break;
    case 'break':
    case 'continue':
      break;
    default:
      assertNeverIrTraversal(statement);
  }
}

function analyzeIrTypeParameterTraversal(
  parameter: Readonly<IrTypeParameter>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.typeParameter, parameter);
  if (parameter.constraint) analyzeIrTypeTraversal(parameter.constraint, observer);
  if (parameter.default) analyzeIrTypeTraversal(parameter.default, observer);
}

function analyzeIrTypeTraversal(type: Readonly<IrType>, observer: Readonly<CompilerIrTraversalObserver>): void {
  observeIrTraversalValue(observer.type, type);
  switch (type.kind) {
    case 'array':
      analyzeIrTypeTraversal(type.element, observer);
      break;
    case 'function':
      type.typeParameters.forEach((parameter) => analyzeIrTypeParameterTraversal(parameter, observer));
      type.parameters.forEach((parameter) => analyzeIrTypeTraversal(parameter.type, observer));
      analyzeIrTypeTraversal(type.returns, observer);
      break;
    case 'indexedAccess':
      analyzeIrTypeTraversal(type.object, observer);
      analyzeIrTypeTraversal(type.index, observer);
      break;
    case 'intersection':
    case 'union':
      type.types.forEach((member) => analyzeIrTypeTraversal(member, observer));
      break;
    case 'keyof':
      analyzeIrTypeTraversal(type.type, observer);
      break;
    case 'named':
      type.typeArguments.forEach((argument) => analyzeIrTypeTraversal(argument, observer));
      break;
    case 'object':
      type.properties.forEach((property) => analyzeIrTypeTraversal(property.type, observer));
      break;
    case 'tuple':
      type.elements.forEach((element) => analyzeIrTypeTraversal(element.type, observer));
      break;
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      break;
    default:
      assertNeverIrTraversal(type);
  }
}

function analyzeIrVariableTraversal(
  variable: Readonly<IrVariable>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  observeIrTraversalValue(observer.variable, variable);
  if (variable.type) analyzeIrTypeTraversal(variable.type, observer);
  if (variable.initializer) analyzeIrExpressionTraversal(variable.initializer, observer);
  if ('pattern' in variable) analyzeIrBindingPatternTraversal(variable.pattern, observer);
}

function observeIrTraversalValue<Value>(
  observe: ((value: Readonly<Value>) => boolean | void) | undefined,
  value: Readonly<Value>,
): void {
  if (observe?.(value) === false) throw compilerIrTraversalStop;
}

function assertNeverIrTraversal(value: never): never {
  const kind = (value as { kind?: unknown }).kind;
  throw new TypeError(`Unknown IR traversal kind ${String(kind)}`);
}
