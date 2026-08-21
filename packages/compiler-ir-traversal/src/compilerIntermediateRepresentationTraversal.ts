import type {
  CompilerIrTraversalCallback,
  CompilerIrTraversalObserver,
  CompilerIrTraversalPath,
  IrBindingPattern,
  IrDeclaration,
  IrExpression,
  IrFunctionSignature,
  IrInvocationSemantics,
  IrModule,
  IrObjectMember,
  IrOptionalChainSemantics,
  IrParameter,
  IrStatement,
  IrType,
  IrTypeParameter,
  IrVariable,
} from '../../compiler-types/src/index.js';

const compilerIrTraversalRootPath: CompilerIrTraversalPath = Object.freeze([]);
const compilerIrTraversalStop = Symbol('compiler-ir-traversal-stop');

export function analyzeIrModuleTraversal(
  module: Readonly<IrModule>,
  observer: Readonly<CompilerIrTraversalObserver>,
): void {
  try {
    observeIrTraversalValue(observer.module, module, compilerIrTraversalRootPath);
    module.declarations.forEach((declaration, index) =>
      analyzeIrDeclarationTraversal(
        declaration,
        observer,
        createIrTraversalPath(compilerIrTraversalRootPath, 'declarations', index),
      ),
    );
    module.exports.forEach((exported, index) => {
      if (exported.kind === 'default') {
        analyzeIrExpressionTraversal(
          exported.expression,
          observer,
          createIrTraversalPath(compilerIrTraversalRootPath, 'exports', index, 'expression'),
        );
      }
    });
  } catch (error) {
    if (error !== compilerIrTraversalStop) throw error;
  }
}

function analyzeIrBindingPatternTraversal(
  pattern: Readonly<IrBindingPattern>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.bindingPattern, pattern, path);
  if (pattern.type) analyzeIrTypeTraversal(pattern.type, observer, createIrTraversalPath(path, 'type'));
  if (pattern.kind === 'binding') return;
  if (pattern.kind === 'array') {
    pattern.elements.forEach((element, index) => {
      if (!element) return;
      const elementPath = createIrTraversalPath(path, 'elements', index);
      if (element.initializer) {
        analyzeIrExpressionTraversal(element.initializer, observer, createIrTraversalPath(elementPath, 'initializer'));
      }
      analyzeIrBindingPatternTraversal(element.pattern, observer, createIrTraversalPath(elementPath, 'pattern'));
    });
  } else {
    pattern.properties.forEach((property, index) => {
      const propertyPath = createIrTraversalPath(path, 'properties', index);
      if (property.key.kind === 'computed') {
        analyzeIrExpressionTraversal(
          property.key.expression,
          observer,
          createIrTraversalPath(propertyPath, 'key', 'expression'),
        );
      }
      if (property.initializer) {
        analyzeIrExpressionTraversal(
          property.initializer,
          observer,
          createIrTraversalPath(propertyPath, 'initializer'),
        );
      }
      analyzeIrBindingPatternTraversal(property.pattern, observer, createIrTraversalPath(propertyPath, 'pattern'));
    });
  }
  if (pattern.rest) analyzeIrBindingPatternTraversal(pattern.rest, observer, createIrTraversalPath(path, 'rest'));
}

function analyzeIrDeclarationTraversal(
  declaration: Readonly<IrDeclaration>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.declaration, declaration, path);
  switch (declaration.kind) {
    case 'class':
      declaration.typeParameters.forEach((parameter, index) =>
        analyzeIrTypeParameterTraversal(parameter, observer, createIrTraversalPath(path, 'typeParameters', index)),
      );
      if (declaration.extends) {
        analyzeIrTypeTraversal(declaration.extends, observer, createIrTraversalPath(path, 'extends'));
      }
      declaration.implements.forEach((type, index) =>
        analyzeIrTypeTraversal(type, observer, createIrTraversalPath(path, 'implements', index)),
      );
      declaration.fields.forEach((field, index) => {
        const fieldPath = createIrTraversalPath(path, 'fields', index);
        analyzeIrTypeTraversal(field.type, observer, createIrTraversalPath(fieldPath, 'type'));
        if (field.initializer) {
          analyzeIrExpressionTraversal(field.initializer, observer, createIrTraversalPath(fieldPath, 'initializer'));
        }
      });
      if (declaration.classConstructor) {
        const constructorPath = createIrTraversalPath(path, 'classConstructor');
        declaration.classConstructor.parameters.forEach((parameter, index) =>
          analyzeIrParameterTraversal(parameter, observer, createIrTraversalPath(constructorPath, 'parameters', index)),
        );
        declaration.classConstructor.overloads.forEach((overload, overloadIndex) =>
          overload.parameters.forEach((parameter, parameterIndex) =>
            analyzeIrParameterTraversal(
              parameter,
              observer,
              createIrTraversalPath(constructorPath, 'overloads', overloadIndex, 'parameters', parameterIndex),
            ),
          ),
        );
        declaration.classConstructor.body.forEach((statement, index) =>
          analyzeIrStatementTraversal(statement, observer, createIrTraversalPath(constructorPath, 'body', index)),
        );
      }
      declaration.methods.forEach((method, index) => {
        const methodPath = createIrTraversalPath(path, 'methods', index);
        analyzeIrFunctionSignatureTraversal(method, observer, methodPath);
        method.body.forEach((statement, statementIndex) =>
          analyzeIrStatementTraversal(statement, observer, createIrTraversalPath(methodPath, 'body', statementIndex)),
        );
      });
      break;
    case 'function':
      analyzeIrFunctionSignatureTraversal(declaration, observer, path);
      declaration.overloads.forEach((overload, index) =>
        analyzeIrFunctionSignatureTraversal(overload, observer, createIrTraversalPath(path, 'overloads', index)),
      );
      declaration.body.forEach((statement, index) =>
        analyzeIrStatementTraversal(statement, observer, createIrTraversalPath(path, 'body', index)),
      );
      break;
    case 'interface':
      declaration.typeParameters.forEach((parameter, index) =>
        analyzeIrTypeParameterTraversal(parameter, observer, createIrTraversalPath(path, 'typeParameters', index)),
      );
      declaration.extends.forEach((type, index) =>
        analyzeIrTypeTraversal(type, observer, createIrTraversalPath(path, 'extends', index)),
      );
      declaration.properties.forEach((property, index) =>
        analyzeIrTypeTraversal(property.type, observer, createIrTraversalPath(path, 'properties', index, 'type')),
      );
      break;
    case 'typeAlias':
      declaration.typeParameters.forEach((parameter, index) =>
        analyzeIrTypeParameterTraversal(parameter, observer, createIrTraversalPath(path, 'typeParameters', index)),
      );
      analyzeIrTypeTraversal(declaration.type, observer, createIrTraversalPath(path, 'type'));
      break;
    case 'variable':
      analyzeIrVariableTraversal(declaration, observer, path);
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
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.expression, expression, path);
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element, index) => {
        if (element) {
          analyzeIrExpressionTraversal(element, observer, createIrTraversalPath(path, 'elements', index));
        }
      });
      break;
    case 'assignment':
    case 'binary':
      analyzeIrExpressionTraversal(expression.left, observer, createIrTraversalPath(path, 'left'));
      analyzeIrExpressionTraversal(expression.right, observer, createIrTraversalPath(path, 'right'));
      break;
    case 'await':
    case 'spread':
      analyzeIrExpressionTraversal(expression.expression, observer, createIrTraversalPath(path, 'expression'));
      break;
    case 'call':
      analyzeIrExpressionTraversal(expression.callee, observer, createIrTraversalPath(path, 'callee'));
      expression.arguments.forEach((argument, index) =>
        analyzeIrExpressionTraversal(argument, observer, createIrTraversalPath(path, 'arguments', index)),
      );
      expression.typeArguments.forEach((type, index) =>
        analyzeIrTypeTraversal(type, observer, createIrTraversalPath(path, 'typeArguments', index)),
      );
      analyzeIrOptionalChainTraversal(
        expression.semantics.optionalChain,
        observer,
        createIrTraversalPath(path, 'semantics', 'optionalChain'),
      );
      if (expression.semantics.extraArguments) {
        analyzeIrTypeTraversal(
          expression.semantics.extraArguments.resultType,
          observer,
          createIrTraversalPath(path, 'semantics', 'extraArguments', 'resultType'),
        );
      }
      analyzeIrInvocationSemanticsTraversal(expression.semantics, observer, createIrTraversalPath(path, 'semantics'));
      break;
    case 'cast':
      analyzeIrExpressionTraversal(expression.expression, observer, createIrTraversalPath(path, 'expression'));
      analyzeIrTypeTraversal(expression.type, observer, createIrTraversalPath(path, 'type'));
      break;
    case 'conditional':
      analyzeIrExpressionTraversal(expression.condition, observer, createIrTraversalPath(path, 'condition'));
      analyzeIrExpressionTraversal(expression.whenTrue, observer, createIrTraversalPath(path, 'whenTrue'));
      analyzeIrExpressionTraversal(expression.whenFalse, observer, createIrTraversalPath(path, 'whenFalse'));
      break;
    case 'element':
      analyzeIrExpressionTraversal(expression.object, observer, createIrTraversalPath(path, 'object'));
      analyzeIrExpressionTraversal(expression.index, observer, createIrTraversalPath(path, 'index'));
      analyzeIrOptionalChainTraversal(
        expression.semantics.optionalChain,
        observer,
        createIrTraversalPath(path, 'semantics', 'optionalChain'),
      );
      break;
    case 'function':
      analyzeIrFunctionSignatureTraversal(expression, observer, path);
      expression.body.forEach((statement, index) =>
        analyzeIrStatementTraversal(statement, observer, createIrTraversalPath(path, 'body', index)),
      );
      if (expression.expression) {
        analyzeIrExpressionTraversal(expression.expression, observer, createIrTraversalPath(path, 'expression'));
      }
      break;
    case 'new':
      analyzeIrExpressionTraversal(expression.callee, observer, createIrTraversalPath(path, 'callee'));
      expression.arguments.forEach((argument, index) =>
        analyzeIrExpressionTraversal(argument, observer, createIrTraversalPath(path, 'arguments', index)),
      );
      expression.typeArguments.forEach((type, index) =>
        analyzeIrTypeTraversal(type, observer, createIrTraversalPath(path, 'typeArguments', index)),
      );
      analyzeIrInvocationSemanticsTraversal(expression.semantics, observer, createIrTraversalPath(path, 'semantics'));
      break;
    case 'object':
      expression.members.forEach((member, index) =>
        analyzeIrObjectMemberTraversal(member, observer, createIrTraversalPath(path, 'members', index)),
      );
      analyzeIrTypeTraversal(expression.type, observer, createIrTraversalPath(path, 'type'));
      break;
    case 'objectRest':
      analyzeIrExpressionTraversal(expression.object, observer, createIrTraversalPath(path, 'object'));
      analyzeIrTypeTraversal(expression.type, observer, createIrTraversalPath(path, 'type'));
      expression.excluded.forEach((key, index) => {
        if (key.kind === 'computed') {
          analyzeIrExpressionTraversal(
            key.expression,
            observer,
            createIrTraversalPath(path, 'excluded', index, 'expression'),
          );
        }
      });
      break;
    case 'property':
      analyzeIrExpressionTraversal(expression.object, observer, createIrTraversalPath(path, 'object'));
      analyzeIrOptionalChainTraversal(expression.optionalChain, observer, createIrTraversalPath(path, 'optionalChain'));
      break;
    case 'template':
      expression.parts.forEach((part, index) => {
        if (typeof part !== 'string') {
          analyzeIrExpressionTraversal(part, observer, createIrTraversalPath(path, 'parts', index));
        }
      });
      break;
    case 'tuple':
      expression.elements.forEach((element, index) => {
        if (element.expression) {
          analyzeIrExpressionTraversal(
            element.expression,
            observer,
            createIrTraversalPath(path, 'elements', index, 'expression'),
          );
        }
      });
      break;
    case 'tupleSpread':
      analyzeIrTypeTraversal(expression.type, observer, createIrTraversalPath(path, 'type'));
      expression.segments.forEach((segment, index) => {
        const segmentPath = createIrTraversalPath(path, 'segments', index);
        if (segment.kind === 'spread') {
          analyzeIrExpressionTraversal(segment.expression, observer, createIrTraversalPath(segmentPath, 'expression'));
          analyzeIrTypeTraversal(segment.type, observer, createIrTraversalPath(segmentPath, 'type'));
        } else if (segment.element.expression) {
          analyzeIrExpressionTraversal(
            segment.element.expression,
            observer,
            createIrTraversalPath(segmentPath, 'element', 'expression'),
          );
        }
      });
      break;
    case 'tupleRest':
    case 'tupleSuffix':
      analyzeIrExpressionTraversal(expression.object, observer, createIrTraversalPath(path, 'object'));
      break;
    case 'unary':
      analyzeIrExpressionTraversal(expression.operand, observer, createIrTraversalPath(path, 'operand'));
      break;
    case 'undefinedDefault':
      analyzeIrExpressionTraversal(expression.value, observer, createIrTraversalPath(path, 'value'));
      analyzeIrExpressionTraversal(expression.fallback, observer, createIrTraversalPath(path, 'fallback'));
      break;
    case 'undefinedValue':
      analyzeIrTypeTraversal(expression.type, observer, createIrTraversalPath(path, 'type'));
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
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.functionSignature, signature, path);
  signature.typeParameters.forEach((parameter, index) =>
    analyzeIrTypeParameterTraversal(parameter, observer, createIrTraversalPath(path, 'typeParameters', index)),
  );
  signature.parameters.forEach((parameter, index) =>
    analyzeIrParameterTraversal(parameter, observer, createIrTraversalPath(path, 'parameters', index)),
  );
  analyzeIrTypeTraversal(signature.returns, observer, createIrTraversalPath(path, 'returns'));
}

function analyzeIrInvocationSemanticsTraversal(
  semantics: Readonly<IrInvocationSemantics>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  semantics.optionalParameters?.provided.forEach((provided, index) => {
    const providedPath = createIrTraversalPath(path, 'optionalParameters', 'provided', index);
    analyzeIrTypeTraversal(provided.argumentType, observer, createIrTraversalPath(providedPath, 'argumentType'));
    analyzeIrTypeTraversal(provided.parameterType, observer, createIrTraversalPath(providedPath, 'parameterType'));
  });
}

function analyzeIrObjectMemberTraversal(
  member: Readonly<IrObjectMember>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.objectMember, member, path);
  switch (member.kind) {
    case 'computedProperty':
      analyzeIrExpressionTraversal(member.key, observer, createIrTraversalPath(path, 'key'));
      analyzeIrExpressionTraversal(member.value, observer, createIrTraversalPath(path, 'value'));
      break;
    case 'property':
      analyzeIrExpressionTraversal(member.value, observer, createIrTraversalPath(path, 'value'));
      break;
    case 'spread':
      analyzeIrExpressionTraversal(member.expression, observer, createIrTraversalPath(path, 'expression'));
      break;
    default:
      assertNeverIrTraversal(member);
  }
}

function analyzeIrOptionalChainTraversal(
  semantics: Readonly<IrOptionalChainSemantics> | undefined,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  if (!semantics) return;
  observeIrTraversalValue(observer.optionalChain, semantics, path);
  analyzeIrTypeTraversal(semantics.receiverType, observer, createIrTraversalPath(path, 'receiverType'));
  analyzeIrTypeTraversal(semantics.valueType, observer, createIrTraversalPath(path, 'valueType'));
}

function analyzeIrParameterTraversal(
  parameter: Readonly<IrParameter>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.parameter, parameter, path);
  analyzeIrTypeTraversal(parameter.type, observer, createIrTraversalPath(path, 'type'));
  if (parameter.initializer) {
    analyzeIrExpressionTraversal(parameter.initializer, observer, createIrTraversalPath(path, 'initializer'));
  }
}

function analyzeIrStatementTraversal(
  statement: Readonly<IrStatement>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.statement, statement, path);
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((child, index) =>
        analyzeIrStatementTraversal(child, observer, createIrTraversalPath(path, 'statements', index)),
      );
      break;
    case 'do':
    case 'while':
      analyzeIrStatementTraversal(statement.body, observer, createIrTraversalPath(path, 'body'));
      analyzeIrExpressionTraversal(statement.condition, observer, createIrTraversalPath(path, 'condition'));
      break;
    case 'expression':
    case 'throw':
      analyzeIrExpressionTraversal(statement.expression, observer, createIrTraversalPath(path, 'expression'));
      break;
    case 'for':
      if (Array.isArray(statement.initializer)) {
        statement.initializer.forEach((variable, index) =>
          analyzeIrVariableTraversal(variable, observer, createIrTraversalPath(path, 'initializer', index)),
        );
      } else if (statement.initializer) {
        analyzeIrExpressionTraversal(
          statement.initializer as IrExpression,
          observer,
          createIrTraversalPath(path, 'initializer'),
        );
      }
      if (statement.condition) {
        analyzeIrExpressionTraversal(statement.condition, observer, createIrTraversalPath(path, 'condition'));
      }
      if (statement.increment) {
        analyzeIrExpressionTraversal(statement.increment, observer, createIrTraversalPath(path, 'increment'));
      }
      analyzeIrStatementTraversal(statement.body, observer, createIrTraversalPath(path, 'body'));
      break;
    case 'forIn':
      analyzeIrVariableTraversal(statement.variable, observer, createIrTraversalPath(path, 'variable'));
      analyzeIrExpressionTraversal(statement.object, observer, createIrTraversalPath(path, 'object'));
      analyzeIrStatementTraversal(statement.body, observer, createIrTraversalPath(path, 'body'));
      break;
    case 'forOf':
      analyzeIrVariableTraversal(statement.variable, observer, createIrTraversalPath(path, 'variable'));
      analyzeIrExpressionTraversal(statement.iterable, observer, createIrTraversalPath(path, 'iterable'));
      analyzeIrStatementTraversal(statement.body, observer, createIrTraversalPath(path, 'body'));
      break;
    case 'if':
      analyzeIrExpressionTraversal(statement.condition, observer, createIrTraversalPath(path, 'condition'));
      analyzeIrStatementTraversal(statement.consequent, observer, createIrTraversalPath(path, 'consequent'));
      if (statement.otherwise) {
        analyzeIrStatementTraversal(statement.otherwise, observer, createIrTraversalPath(path, 'otherwise'));
      }
      break;
    case 'return':
      if (statement.expression) {
        analyzeIrExpressionTraversal(statement.expression, observer, createIrTraversalPath(path, 'expression'));
      }
      break;
    case 'switch':
      analyzeIrExpressionTraversal(statement.expression, observer, createIrTraversalPath(path, 'expression'));
      statement.cases.forEach((switchCase, caseIndex) => {
        const casePath = createIrTraversalPath(path, 'cases', caseIndex);
        if (switchCase.expression) {
          analyzeIrExpressionTraversal(switchCase.expression, observer, createIrTraversalPath(casePath, 'expression'));
        }
        switchCase.statements.forEach((child, statementIndex) =>
          analyzeIrStatementTraversal(child, observer, createIrTraversalPath(casePath, 'statements', statementIndex)),
        );
      });
      break;
    case 'try':
      analyzeIrStatementTraversal(statement.tryBody, observer, createIrTraversalPath(path, 'tryBody'));
      if (statement.catchClause) {
        analyzeIrStatementTraversal(
          statement.catchClause.body,
          observer,
          createIrTraversalPath(path, 'catchClause', 'body'),
        );
      }
      if (statement.finallyBody) {
        analyzeIrStatementTraversal(statement.finallyBody, observer, createIrTraversalPath(path, 'finallyBody'));
      }
      break;
    case 'variable':
      statement.declarations.forEach((variable, index) =>
        analyzeIrVariableTraversal(variable, observer, createIrTraversalPath(path, 'declarations', index)),
      );
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
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.typeParameter, parameter, path);
  if (parameter.constraint) {
    analyzeIrTypeTraversal(parameter.constraint, observer, createIrTraversalPath(path, 'constraint'));
  }
  if (parameter.default) analyzeIrTypeTraversal(parameter.default, observer, createIrTraversalPath(path, 'default'));
}

function analyzeIrTypeTraversal(
  type: Readonly<IrType>,
  observer: Readonly<CompilerIrTraversalObserver>,
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.type, type, path);
  switch (type.kind) {
    case 'array':
      analyzeIrTypeTraversal(type.element, observer, createIrTraversalPath(path, 'element'));
      break;
    case 'function':
      type.typeParameters.forEach((parameter, index) =>
        analyzeIrTypeParameterTraversal(parameter, observer, createIrTraversalPath(path, 'typeParameters', index)),
      );
      type.parameters.forEach((parameter, index) =>
        analyzeIrTypeTraversal(parameter.type, observer, createIrTraversalPath(path, 'parameters', index, 'type')),
      );
      analyzeIrTypeTraversal(type.returns, observer, createIrTraversalPath(path, 'returns'));
      break;
    case 'indexedAccess':
      analyzeIrTypeTraversal(type.object, observer, createIrTraversalPath(path, 'object'));
      analyzeIrTypeTraversal(type.index, observer, createIrTraversalPath(path, 'index'));
      break;
    case 'intersection':
    case 'union':
      type.types.forEach((member, index) =>
        analyzeIrTypeTraversal(member, observer, createIrTraversalPath(path, 'types', index)),
      );
      break;
    case 'keyof':
      analyzeIrTypeTraversal(type.type, observer, createIrTraversalPath(path, 'type'));
      break;
    case 'named':
      type.typeArguments.forEach((argument, index) =>
        analyzeIrTypeTraversal(argument, observer, createIrTraversalPath(path, 'typeArguments', index)),
      );
      break;
    case 'object':
      type.properties.forEach((property, index) =>
        analyzeIrTypeTraversal(property.type, observer, createIrTraversalPath(path, 'properties', index, 'type')),
      );
      break;
    case 'tuple':
      type.elements.forEach((element, index) =>
        analyzeIrTypeTraversal(element.type, observer, createIrTraversalPath(path, 'elements', index, 'type')),
      );
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
  path: CompilerIrTraversalPath,
): void {
  observeIrTraversalValue(observer.variable, variable, path);
  if (variable.type) analyzeIrTypeTraversal(variable.type, observer, createIrTraversalPath(path, 'type'));
  if (variable.initializer) {
    analyzeIrExpressionTraversal(variable.initializer, observer, createIrTraversalPath(path, 'initializer'));
  }
  if ('pattern' in variable) {
    analyzeIrBindingPatternTraversal(variable.pattern, observer, createIrTraversalPath(path, 'pattern'));
  }
}

function createIrTraversalPath(
  parent: CompilerIrTraversalPath,
  ...segments: readonly (number | string)[]
): CompilerIrTraversalPath {
  return Object.freeze([...parent, ...segments]);
}

function observeIrTraversalValue<Value>(
  observe: CompilerIrTraversalCallback<Value> | undefined,
  value: Readonly<Value>,
  path: CompilerIrTraversalPath,
): void {
  if (observe?.(value, path) === false) throw compilerIrTraversalStop;
}

function assertNeverIrTraversal(value: never): never {
  const kind = (value as { kind?: unknown }).kind;
  throw new TypeError(`Unknown IR traversal kind ${String(kind)}`);
}
