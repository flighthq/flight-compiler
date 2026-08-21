import type {
  CompilerLoweringPass,
  IrBindingPattern,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';

export function createCompilerLoweringPassBindingPattern(): CompilerLoweringPass {
  const array = createCompilerLoweringPassArrayBindingPattern();
  const object = createCompilerLoweringPassObjectBindingPattern();
  return {
    idempotent: true,
    lowerIrModule(module) {
      let lowered: IrModule = module;
      let residual = getIrModuleBindingPatternResidualCount(lowered);
      while (residual > 0) {
        lowered = array.lowerIrModule(object.lowerIrModule(lowered));
        const nextResidual = getIrModuleBindingPatternResidualCount(lowered);
        if (nextResidual >= residual) {
          throw createCompilerLoweringFailure(
            'unsupported-ir',
            compilerLoweringPassNameBindingPattern,
            module,
            `recursive binding normalization did not decrease its structural residual from ${String(residual)}`,
          );
        }
        residual = nextResidual;
      }
      return lowered;
    },
    name: compilerLoweringPassNameBindingPattern,
    runsAfter: [],
    verifyIrModule(module) {
      const arrayResult = array.verifyIrModule(module);
      if (arrayResult.kind === 'invalid') return arrayResult;
      return object.verifyIrModule(module);
    },
  };
}

export function getIrModuleBindingPatternResidualCount(module: Readonly<IrModule>): number {
  return (
    sumNumbers(module.declarations.map(countIrDeclarationBindingPatternResiduals)) +
    sumNumbers(
      module.exports.map((exported) =>
        exported.kind === 'default' ? countIrExpressionBindingPatternResiduals(exported.expression) : 0,
      ),
    )
  );
}

function countIrBindingPatternResiduals(pattern: Readonly<IrBindingPattern>): number {
  if (pattern.kind === 'binding') return 1;
  if (pattern.kind === 'array') {
    return (
      1 +
      sumNumbers(
        pattern.elements.map((element) =>
          element
            ? countIrBindingPatternResiduals(element.pattern) +
              (element.initializer ? countIrExpressionBindingPatternResiduals(element.initializer) : 0)
            : 0,
        ),
      ) +
      (pattern.rest ? countIrBindingPatternResiduals(pattern.rest) : 0)
    );
  }
  return (
    1 +
    sumNumbers(
      pattern.properties.map(
        (property) =>
          countIrBindingPatternResiduals(property.pattern) +
          (property.initializer ? countIrExpressionBindingPatternResiduals(property.initializer) : 0) +
          (property.key.kind === 'computed' ? countIrExpressionBindingPatternResiduals(property.key.expression) : 0),
      ),
    ) +
    (pattern.rest ? countIrBindingPatternResiduals(pattern.rest) : 0)
  );
}

function countIrDeclarationBindingPatternResiduals(declaration: Readonly<IrDeclaration>): number {
  switch (declaration.kind) {
    case 'class':
      return (
        sumNumbers(
          declaration.fields.map((field) =>
            field.initializer ? countIrExpressionBindingPatternResiduals(field.initializer) : 0,
          ),
        ) +
        (declaration.classConstructor
          ? sumNumbers(declaration.classConstructor.parameters.map(countIrParameterBindingPatternResiduals)) +
            sumNumbers(declaration.classConstructor.body.map(countIrStatementBindingPatternResiduals))
          : 0) +
        sumNumbers(
          declaration.methods.map(
            (method) =>
              sumNumbers(method.parameters.map(countIrParameterBindingPatternResiduals)) +
              sumNumbers(method.body.map(countIrStatementBindingPatternResiduals)),
          ),
        )
      );
    case 'function':
      return (
        sumNumbers(declaration.parameters.map(countIrParameterBindingPatternResiduals)) +
        sumNumbers(
          declaration.overloads.flatMap((overload) => overload.parameters.map(countIrParameterBindingPatternResiduals)),
        ) +
        sumNumbers(declaration.body.map(countIrStatementBindingPatternResiduals))
      );
    case 'variable':
      return countIrVariableBindingPatternResiduals(declaration);
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return 0;
  }
}

function countIrExpressionBindingPatternResiduals(expression: Readonly<IrExpression>): number {
  switch (expression.kind) {
    case 'array':
      return sumNumbers(
        expression.elements.map((element) => (element ? countIrExpressionBindingPatternResiduals(element) : 0)),
      );
    case 'assignment':
    case 'binary':
      return (
        countIrExpressionBindingPatternResiduals(expression.left) +
        countIrExpressionBindingPatternResiduals(expression.right)
      );
    case 'await':
    case 'cast':
    case 'spread':
      return countIrExpressionBindingPatternResiduals(expression.expression);
    case 'call':
    case 'new':
      return (
        countIrExpressionBindingPatternResiduals(expression.callee) +
        sumNumbers(expression.arguments.map(countIrExpressionBindingPatternResiduals))
      );
    case 'conditional':
      return (
        countIrExpressionBindingPatternResiduals(expression.condition) +
        countIrExpressionBindingPatternResiduals(expression.whenFalse) +
        countIrExpressionBindingPatternResiduals(expression.whenTrue)
      );
    case 'element':
      return (
        countIrExpressionBindingPatternResiduals(expression.index) +
        countIrExpressionBindingPatternResiduals(expression.object)
      );
    case 'function':
      return (
        sumNumbers(expression.parameters.map(countIrParameterBindingPatternResiduals)) +
        sumNumbers(expression.body.map(countIrStatementBindingPatternResiduals)) +
        (expression.expression ? countIrExpressionBindingPatternResiduals(expression.expression) : 0)
      );
    case 'object':
      return sumNumbers(expression.members.map(countIrObjectMemberBindingPatternResiduals));
    case 'objectRest':
      return (
        countIrExpressionBindingPatternResiduals(expression.object) +
        sumNumbers(
          expression.excluded.map((key) =>
            key.kind === 'computed' ? countIrExpressionBindingPatternResiduals(key.expression) : 0,
          ),
        )
      );
    case 'property':
      return countIrExpressionBindingPatternResiduals(expression.object);
    case 'template':
      return sumNumbers(
        expression.parts.map((part) => (typeof part === 'string' ? 0 : countIrExpressionBindingPatternResiduals(part))),
      );
    case 'tuple':
      return sumNumbers(
        expression.elements.map((element) =>
          element.expression ? countIrExpressionBindingPatternResiduals(element.expression) : 0,
        ),
      );
    case 'tupleSpread':
      return sumNumbers(
        expression.segments.map((segment) =>
          segment.kind === 'spread'
            ? countIrExpressionBindingPatternResiduals(segment.expression)
            : segment.element.expression
              ? countIrExpressionBindingPatternResiduals(segment.element.expression)
              : 0,
        ),
      );
    case 'tupleRest':
      return countIrExpressionBindingPatternResiduals(expression.object);
    case 'unary':
      return countIrExpressionBindingPatternResiduals(expression.operand);
    case 'undefinedDefault':
      return (
        countIrExpressionBindingPatternResiduals(expression.fallback) +
        countIrExpressionBindingPatternResiduals(expression.value)
      );
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'tupleSuffix':
    case 'undefinedValue':
      return 0;
  }
}

function countIrObjectMemberBindingPatternResiduals(member: Readonly<IrObjectMember>): number {
  switch (member.kind) {
    case 'computedProperty':
      return (
        countIrExpressionBindingPatternResiduals(member.key) + countIrExpressionBindingPatternResiduals(member.value)
      );
    case 'property':
      return countIrExpressionBindingPatternResiduals(member.value);
    case 'spread':
      return countIrExpressionBindingPatternResiduals(member.expression);
  }
}

function countIrParameterBindingPatternResiduals(parameter: Readonly<IrParameter>): number {
  return parameter.initializer ? countIrExpressionBindingPatternResiduals(parameter.initializer) : 0;
}

function countIrStatementBindingPatternResiduals(statement: Readonly<IrStatement>): number {
  switch (statement.kind) {
    case 'block':
      return sumNumbers(statement.statements.map(countIrStatementBindingPatternResiduals));
    case 'do':
    case 'while':
      return (
        countIrStatementBindingPatternResiduals(statement.body) +
        countIrExpressionBindingPatternResiduals(statement.condition)
      );
    case 'expression':
    case 'throw':
      return countIrExpressionBindingPatternResiduals(statement.expression);
    case 'for':
      return (
        (isIrVariableList(statement.initializer)
          ? sumNumbers(statement.initializer.map(countIrVariableBindingPatternResiduals))
          : statement.initializer
            ? countIrExpressionBindingPatternResiduals(statement.initializer)
            : 0) +
        (statement.condition ? countIrExpressionBindingPatternResiduals(statement.condition) : 0) +
        (statement.increment ? countIrExpressionBindingPatternResiduals(statement.increment) : 0) +
        countIrStatementBindingPatternResiduals(statement.body)
      );
    case 'forIn':
      return (
        countIrVariableBindingPatternResiduals(statement.variable) +
        countIrExpressionBindingPatternResiduals(statement.object) +
        countIrStatementBindingPatternResiduals(statement.body)
      );
    case 'forOf':
      return (
        countIrVariableBindingPatternResiduals(statement.variable) +
        countIrExpressionBindingPatternResiduals(statement.iterable) +
        countIrStatementBindingPatternResiduals(statement.body)
      );
    case 'if':
      return (
        countIrExpressionBindingPatternResiduals(statement.condition) +
        countIrStatementBindingPatternResiduals(statement.consequent) +
        (statement.otherwise ? countIrStatementBindingPatternResiduals(statement.otherwise) : 0)
      );
    case 'return':
      return statement.expression ? countIrExpressionBindingPatternResiduals(statement.expression) : 0;
    case 'switch':
      return (
        countIrExpressionBindingPatternResiduals(statement.expression) +
        sumNumbers(
          statement.cases.flatMap((switchCase) => [
            switchCase.expression ? countIrExpressionBindingPatternResiduals(switchCase.expression) : 0,
            ...switchCase.statements.map(countIrStatementBindingPatternResiduals),
          ]),
        )
      );
    case 'try':
      return (
        countIrStatementBindingPatternResiduals(statement.tryBody) +
        (statement.catchClause ? countIrStatementBindingPatternResiduals(statement.catchClause.body) : 0) +
        (statement.finallyBody ? countIrStatementBindingPatternResiduals(statement.finallyBody) : 0)
      );
    case 'variable':
      return sumNumbers(statement.declarations.map(countIrVariableBindingPatternResiduals));
    case 'break':
    case 'continue':
      return 0;
  }
}

function countIrVariableBindingPatternResiduals(variable: Readonly<IrVariable>): number {
  return (
    ('pattern' in variable ? countIrBindingPatternResiduals(variable.pattern) : 0) +
    (variable.initializer ? countIrExpressionBindingPatternResiduals(variable.initializer) : 0)
  );
}

function isIrVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

const compilerLoweringPassNameBindingPattern = 'array-binding-pattern';
