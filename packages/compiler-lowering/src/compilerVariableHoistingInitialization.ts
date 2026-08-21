import type {
  CompilerSourceIdentity,
  IrExpression,
  IrNamedVariable,
  IrObjectMember,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

export function validateIrFunctionVariableInitialization(
  statements: readonly Readonly<IrStatement>[],
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  analyzeIrStatementListVariableInitialization(statements, new Set(), variables, sourceIdentity);
}

function addIrExpressionAssignmentTargetVariableInitialization(
  expression: Readonly<IrExpression>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
): void {
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    variables.has(expression.reference.binding.id)
  ) {
    initialized.add(expression.reference.binding.id);
  }
}

function analyzeIrExpressionAssignmentTargetVariableInitialization(
  expression: Readonly<IrExpression>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  if (expression.kind === 'identifier') return;
  if (expression.kind === 'property') {
    analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity);
    return;
  }
  if (expression.kind === 'element') {
    analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity);
    analyzeIrExpressionVariableInitialization(expression.index, initialized, variables, sourceIdentity);
    return;
  }
  analyzeIrExpressionVariableInitialization(expression, initialized, variables, sourceIdentity);
}

function analyzeIrExpressionVariableInitialization(
  expression: Readonly<IrExpression>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) analyzeIrExpressionVariableInitialization(element, initialized, variables, sourceIdentity);
      });
      return;
    case 'assignment':
      if (expression.operator === '=') {
        analyzeIrExpressionAssignmentTargetVariableInitialization(
          expression.left,
          initialized,
          variables,
          sourceIdentity,
        );
      } else {
        analyzeIrExpressionVariableInitialization(expression.left, initialized, variables, sourceIdentity);
      }
      analyzeIrExpressionVariableInitialization(expression.right, initialized, variables, sourceIdentity);
      addIrExpressionAssignmentTargetVariableInitialization(expression.left, initialized, variables);
      return;
    case 'await':
    case 'cast':
    case 'spread':
      analyzeIrExpressionVariableInitialization(expression.expression, initialized, variables, sourceIdentity);
      return;
    case 'binary':
      analyzeIrExpressionVariableInitialization(expression.left, initialized, variables, sourceIdentity);
      analyzeIrExpressionVariableInitialization(
        expression.right,
        expression.operator === '&&' || expression.operator === '||' || expression.operator === '??'
          ? new Set(initialized)
          : initialized,
        variables,
        sourceIdentity,
      );
      return;
    case 'call':
    case 'new':
      analyzeIrExpressionVariableInitialization(expression.callee, initialized, variables, sourceIdentity);
      expression.arguments.forEach((argument) =>
        analyzeIrExpressionVariableInitialization(argument, initialized, variables, sourceIdentity),
      );
      return;
    case 'conditional': {
      analyzeIrExpressionVariableInitialization(expression.condition, initialized, variables, sourceIdentity);
      const whenTrue = new Set(initialized);
      const whenFalse = new Set(initialized);
      analyzeIrExpressionVariableInitialization(expression.whenTrue, whenTrue, variables, sourceIdentity);
      analyzeIrExpressionVariableInitialization(expression.whenFalse, whenFalse, variables, sourceIdentity);
      replaceIrVariableInitializationSet(initialized, intersectIrVariableInitializationSets(whenTrue, whenFalse));
      return;
    }
    case 'element':
      analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity);
      analyzeIrExpressionVariableInitialization(expression.index, initialized, variables, sourceIdentity);
      return;
    case 'function':
      assertIrExpressionFunctionCaptureVariableInitialization(expression, initialized, variables, sourceIdentity);
      return;
    case 'identifier':
      if (expression.reference.kind === 'binding') {
        assertIrBindingVariableInitialization(expression.reference.binding.id, initialized, variables, sourceIdentity);
      }
      return;
    case 'object':
      expression.members.forEach((member) =>
        analyzeIrObjectMemberVariableInitialization(member, initialized, variables, sourceIdentity),
      );
      return;
    case 'property':
      analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity);
      return;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') {
          analyzeIrExpressionVariableInitialization(part, initialized, variables, sourceIdentity);
        }
      });
      return;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) {
          analyzeIrExpressionVariableInitialization(element.expression, initialized, variables, sourceIdentity);
        }
      });
      return;
    case 'tupleRest':
    case 'tupleSuffix':
      analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity);
      return;
    case 'unary':
      analyzeIrExpressionVariableInitialization(expression.operand, initialized, variables, sourceIdentity);
      if (expression.operator === '++' || expression.operator === '--') {
        addIrExpressionAssignmentTargetVariableInitialization(expression.operand, initialized, variables);
      }
      return;
    case 'undefinedDefault':
      analyzeIrExpressionVariableInitialization(expression.value, initialized, variables, sourceIdentity);
      analyzeIrExpressionVariableInitialization(expression.fallback, new Set(initialized), variables, sourceIdentity);
      return;
    case 'literal':
    case 'regexp':
      return;
  }
}

function analyzeIrObjectMemberVariableInitialization(
  member: Readonly<IrObjectMember>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  switch (member.kind) {
    case 'computedProperty':
      analyzeIrExpressionVariableInitialization(member.key, initialized, variables, sourceIdentity);
      analyzeIrExpressionVariableInitialization(member.value, initialized, variables, sourceIdentity);
      return;
    case 'property':
      analyzeIrExpressionVariableInitialization(member.value, initialized, variables, sourceIdentity);
      return;
    case 'spread':
      analyzeIrExpressionVariableInitialization(member.expression, initialized, variables, sourceIdentity);
      return;
  }
}

function analyzeIrStatementListVariableInitialization(
  statements: readonly Readonly<IrStatement>[],
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): Set<string> | undefined {
  let current: Set<string> | undefined = initialized;
  for (const statement of statements) {
    if (!current) break;
    current = analyzeIrStatementVariableInitialization(statement, current, variables, sourceIdentity);
  }
  return current;
}

function analyzeIrStatementVariableInitialization(
  statement: Readonly<IrStatement>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): Set<string> | undefined {
  switch (statement.kind) {
    case 'block':
      return analyzeIrStatementListVariableInitialization(statement.statements, initialized, variables, sourceIdentity);
    case 'do': {
      const afterBody = analyzeIrStatementVariableInitialization(
        statement.body,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      if (!afterBody) return initialized;
      analyzeIrExpressionVariableInitialization(statement.condition, afterBody, variables, sourceIdentity);
      return afterBody;
    }
    case 'expression':
      analyzeIrExpressionVariableInitialization(statement.expression, initialized, variables, sourceIdentity);
      return initialized;
    case 'for':
      if (Array.isArray(statement.initializer)) {
        statement.initializer.forEach((variable) =>
          analyzeIrVariableVariableInitialization(variable, initialized, variables, sourceIdentity),
        );
      } else if (statement.initializer) {
        analyzeIrExpressionVariableInitialization(
          statement.initializer as IrExpression,
          initialized,
          variables,
          sourceIdentity,
        );
      }
      if (statement.condition) {
        analyzeIrExpressionVariableInitialization(statement.condition, initialized, variables, sourceIdentity);
      }
      {
        const afterBody = analyzeIrStatementVariableInitialization(
          statement.body,
          new Set(initialized),
          variables,
          sourceIdentity,
        );
        if (afterBody && statement.increment) {
          analyzeIrExpressionVariableInitialization(statement.increment, afterBody, variables, sourceIdentity);
        }
      }
      return initialized;
    case 'forIn':
      analyzeIrExpressionVariableInitialization(statement.object, initialized, variables, sourceIdentity);
      analyzeIrStatementVariableInitialization(statement.body, new Set(initialized), variables, sourceIdentity);
      return initialized;
    case 'forOf':
      analyzeIrExpressionVariableInitialization(statement.iterable, initialized, variables, sourceIdentity);
      analyzeIrStatementVariableInitialization(statement.body, new Set(initialized), variables, sourceIdentity);
      return initialized;
    case 'if': {
      analyzeIrExpressionVariableInitialization(statement.condition, initialized, variables, sourceIdentity);
      const consequent = analyzeIrStatementVariableInitialization(
        statement.consequent,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const otherwise = statement.otherwise
        ? analyzeIrStatementVariableInitialization(statement.otherwise, new Set(initialized), variables, sourceIdentity)
        : new Set(initialized);
      return mergeIrVariableInitializationBranches(consequent, otherwise);
    }
    case 'return':
      if (statement.expression) {
        analyzeIrExpressionVariableInitialization(statement.expression, initialized, variables, sourceIdentity);
      }
      return undefined;
    case 'switch':
      analyzeIrExpressionVariableInitialization(statement.expression, initialized, variables, sourceIdentity);
      statement.cases.forEach((switchCase) => {
        const caseState = new Set(initialized);
        if (switchCase.expression) {
          analyzeIrExpressionVariableInitialization(switchCase.expression, caseState, variables, sourceIdentity);
        }
        analyzeIrStatementListVariableInitialization(switchCase.statements, caseState, variables, sourceIdentity);
      });
      return initialized;
    case 'throw':
      analyzeIrExpressionVariableInitialization(statement.expression, initialized, variables, sourceIdentity);
      return undefined;
    case 'try': {
      const afterTry = analyzeIrStatementVariableInitialization(
        statement.tryBody,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const afterCatch = statement.catchClause
        ? analyzeIrStatementVariableInitialization(
            statement.catchClause.body,
            new Set(initialized),
            variables,
            sourceIdentity,
          )
        : new Set(initialized);
      const merged = mergeIrVariableInitializationBranches(afterTry, afterCatch) ?? new Set(initialized);
      return statement.finallyBody
        ? analyzeIrStatementVariableInitialization(statement.finallyBody, merged, variables, sourceIdentity)
        : merged;
    }
    case 'variable':
      statement.declarations.forEach((variable) =>
        analyzeIrVariableVariableInitialization(variable, initialized, variables, sourceIdentity),
      );
      return initialized;
    case 'while':
      analyzeIrExpressionVariableInitialization(statement.condition, initialized, variables, sourceIdentity);
      analyzeIrStatementVariableInitialization(statement.body, new Set(initialized), variables, sourceIdentity);
      return initialized;
    case 'break':
    case 'continue':
      return undefined;
  }
}

function analyzeIrVariableVariableInitialization(
  variable: Readonly<IrVariable>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  if (variable.initializer) {
    analyzeIrExpressionVariableInitialization(variable.initializer, initialized, variables, sourceIdentity);
  }
  if (!('pattern' in variable) && variable.initializer && variables.has(variable.binding.id)) {
    initialized.add(variable.binding.id);
  }
}

function assertIrBindingVariableInitialization(
  identity: string,
  initialized: ReadonlySet<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  const variable = variables.get(identity);
  if (!variable || initialized.has(identity)) return;
  throw createCompilerLoweringFailure(
    'unsupported-ir',
    compilerLoweringPassNameVariableHoisting,
    sourceIdentity,
    `function-scoped variable ${variable.binding.name} may be read before initialization; undefined-preserving lowering is required`,
  );
}

function assertIrExpressionFunctionCaptureVariableInitialization(
  expression: Readonly<Extract<IrExpression, { kind: 'function' }>>,
  initialized: ReadonlySet<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): void {
  const visit = (value: Readonly<IrExpression>): void => {
    if (value.kind === 'identifier' && value.reference.kind === 'binding') {
      assertIrBindingVariableInitialization(value.reference.binding.id, initialized, variables, sourceIdentity);
      return;
    }
    if (value.kind === 'function') return;
    visitIrExpressionChildrenVariableInitialization(value, visit);
  };
  expression.parameters.forEach((parameter) => {
    if (parameter.initializer) visit(parameter.initializer);
  });
  expression.body.forEach((statement) => visitIrStatementExpressionsVariableInitialization(statement, visit));
  if (expression.expression) visit(expression.expression);
}

function intersectIrVariableInitializationSets(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((identity) => right.has(identity)));
}

function mergeIrVariableInitializationBranches(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): Set<string> | undefined {
  if (!left) return right ? new Set(right) : undefined;
  if (!right) return new Set(left);
  return intersectIrVariableInitializationSets(left, right);
}

function replaceIrVariableInitializationSet(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  source.forEach((identity) => target.add(identity));
}

function visitIrExpressionChildrenVariableInitialization(
  expression: Readonly<IrExpression>,
  visit: (expression: Readonly<IrExpression>) => void,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) visit(element);
      });
      return;
    case 'assignment':
    case 'binary':
      visit(expression.left);
      visit(expression.right);
      return;
    case 'await':
    case 'cast':
    case 'spread':
      visit(expression.expression);
      return;
    case 'call':
    case 'new':
      visit(expression.callee);
      expression.arguments.forEach(visit);
      return;
    case 'conditional':
      visit(expression.condition);
      visit(expression.whenFalse);
      visit(expression.whenTrue);
      return;
    case 'element':
      visit(expression.object);
      visit(expression.index);
      return;
    case 'function':
      return;
    case 'object':
      expression.members.forEach((member) => {
        if (member.kind === 'computedProperty') visit(member.key);
        if (member.kind === 'spread') visit(member.expression);
        else visit(member.value);
      });
      return;
    case 'property':
      visit(expression.object);
      return;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') visit(part);
      });
      return;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) visit(element.expression);
      });
      return;
    case 'tupleRest':
    case 'tupleSuffix':
      visit(expression.object);
      return;
    case 'unary':
      visit(expression.operand);
      return;
    case 'undefinedDefault':
      visit(expression.value);
      visit(expression.fallback);
      return;
    case 'identifier':
    case 'literal':
    case 'regexp':
      return;
  }
}

function visitIrStatementExpressionsVariableInitialization(
  statement: Readonly<IrStatement>,
  visit: (expression: Readonly<IrExpression>) => void,
): void {
  switch (statement.kind) {
    case 'block':
      statement.statements.forEach((child) => visitIrStatementExpressionsVariableInitialization(child, visit));
      return;
    case 'do':
    case 'while':
      visitIrStatementExpressionsVariableInitialization(statement.body, visit);
      visit(statement.condition);
      return;
    case 'expression':
    case 'throw':
      visit(statement.expression);
      return;
    case 'for':
      if (Array.isArray(statement.initializer)) {
        statement.initializer.forEach((variable) => {
          if (variable.initializer) visit(variable.initializer);
        });
      } else if (statement.initializer) visit(statement.initializer as IrExpression);
      if (statement.condition) visit(statement.condition);
      if (statement.increment) visit(statement.increment);
      visitIrStatementExpressionsVariableInitialization(statement.body, visit);
      return;
    case 'forIn':
      if (statement.variable.initializer) visit(statement.variable.initializer);
      visit(statement.object);
      visitIrStatementExpressionsVariableInitialization(statement.body, visit);
      return;
    case 'forOf':
      if (statement.variable.initializer) visit(statement.variable.initializer);
      visit(statement.iterable);
      visitIrStatementExpressionsVariableInitialization(statement.body, visit);
      return;
    case 'if':
      visit(statement.condition);
      visitIrStatementExpressionsVariableInitialization(statement.consequent, visit);
      if (statement.otherwise) visitIrStatementExpressionsVariableInitialization(statement.otherwise, visit);
      return;
    case 'return':
      if (statement.expression) visit(statement.expression);
      return;
    case 'switch':
      visit(statement.expression);
      statement.cases.forEach((switchCase) => {
        if (switchCase.expression) visit(switchCase.expression);
        switchCase.statements.forEach((child) => visitIrStatementExpressionsVariableInitialization(child, visit));
      });
      return;
    case 'try':
      visitIrStatementExpressionsVariableInitialization(statement.tryBody, visit);
      if (statement.catchClause) visitIrStatementExpressionsVariableInitialization(statement.catchClause.body, visit);
      if (statement.finallyBody) visitIrStatementExpressionsVariableInitialization(statement.finallyBody, visit);
      return;
    case 'variable':
      statement.declarations.forEach((variable) => {
        if (variable.initializer) visit(variable.initializer);
      });
      return;
    case 'break':
    case 'continue':
      return;
  }
}

const compilerLoweringPassNameVariableHoisting = 'variable-hoisting';
