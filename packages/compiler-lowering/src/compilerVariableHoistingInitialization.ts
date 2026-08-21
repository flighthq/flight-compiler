import type {
  CompilerSourceIdentity,
  IrExpression,
  IrNamedVariable,
  IrObjectMember,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';
import {
  combineCompilerVariableInitializationSets,
  createCompilerVariableInitializationCompletionAlternative,
  createCompilerVariableInitializationCompletionWithState,
} from './compilerVariableInitializationCompletion.js';

type CompilerVariableInitializationCompletion = Parameters<
  typeof createCompilerVariableInitializationCompletionAlternative
>[0];
type CompilerVariableInitializationCompletionKind = keyof CompilerVariableInitializationCompletion;

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
  completion: MutableCompilerVariableInitializationCompletion,
): void {
  if (expression.kind === 'identifier') return;
  if (expression.kind === 'property') {
    analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity, completion);
    addIrVariableInitializationCompletion(completion, 'throw', initialized);
    return;
  }
  if (expression.kind === 'element') {
    analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity, completion);
    analyzeIrExpressionVariableInitialization(expression.index, initialized, variables, sourceIdentity, completion);
    addIrVariableInitializationCompletion(completion, 'throw', initialized);
    return;
  }
  analyzeIrExpressionVariableInitialization(expression, initialized, variables, sourceIdentity, completion);
}

function analyzeIrExpressionVariableInitialization(
  expression: Readonly<IrExpression>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  completion: MutableCompilerVariableInitializationCompletion,
): void {
  switch (expression.kind) {
    case 'array':
      expression.elements.forEach((element) => {
        if (element) {
          analyzeIrExpressionVariableInitialization(element, initialized, variables, sourceIdentity, completion);
        }
      });
      return;
    case 'assignment':
      if (expression.operator === '=') {
        analyzeIrExpressionAssignmentTargetVariableInitialization(
          expression.left,
          initialized,
          variables,
          sourceIdentity,
          completion,
        );
      } else {
        analyzeIrExpressionVariableInitialization(expression.left, initialized, variables, sourceIdentity, completion);
      }
      analyzeIrExpressionVariableInitialization(expression.right, initialized, variables, sourceIdentity, completion);
      if (
        expression.left.kind !== 'identifier' ||
        (expression.operator !== '=' &&
          expression.operator !== '&&=' &&
          expression.operator !== '||=' &&
          expression.operator !== '??=')
      ) {
        addIrVariableInitializationCompletion(completion, 'throw', initialized);
      }
      addIrExpressionAssignmentTargetVariableInitialization(expression.left, initialized, variables);
      return;
    case 'await':
    case 'spread':
      analyzeIrExpressionVariableInitialization(
        expression.expression,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      return;
    case 'cast':
      analyzeIrExpressionVariableInitialization(
        expression.expression,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      return;
    case 'binary':
      analyzeIrExpressionVariableInitialization(expression.left, initialized, variables, sourceIdentity, completion);
      analyzeIrExpressionVariableInitialization(
        expression.right,
        expression.operator === '&&' || expression.operator === '||' || expression.operator === '??'
          ? new Set(initialized)
          : initialized,
        variables,
        sourceIdentity,
        completion,
      );
      if (
        expression.operator !== ',' &&
        expression.operator !== '&&' &&
        expression.operator !== '||' &&
        expression.operator !== '??' &&
        expression.operator !== '===' &&
        expression.operator !== '!=='
      ) {
        addIrVariableInitializationCompletion(completion, 'throw', initialized);
      }
      return;
    case 'call':
    case 'new': {
      const immediatelyInvoked = expression.callee.kind === 'function' ? expression.callee : undefined;
      if (!immediatelyInvoked) {
        analyzeIrExpressionVariableInitialization(
          expression.callee,
          initialized,
          variables,
          sourceIdentity,
          completion,
        );
      }
      expression.arguments.forEach((argument) =>
        analyzeIrExpressionVariableInitialization(argument, initialized, variables, sourceIdentity, completion),
      );
      if (immediatelyInvoked) {
        assertIrExpressionFunctionCaptureVariableInitialization(
          immediatelyInvoked,
          initialized,
          variables,
          sourceIdentity,
        );
      }
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      return;
    }
    case 'conditional': {
      analyzeIrExpressionVariableInitialization(
        expression.condition,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      const whenTrue = new Set(initialized);
      const whenFalse = new Set(initialized);
      analyzeIrExpressionVariableInitialization(expression.whenTrue, whenTrue, variables, sourceIdentity, completion);
      analyzeIrExpressionVariableInitialization(expression.whenFalse, whenFalse, variables, sourceIdentity, completion);
      replaceIrVariableInitializationSet(initialized, combineCompilerVariableInitializationSets(whenTrue, whenFalse)!);
      return;
    }
    case 'element':
      analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity, completion);
      analyzeIrExpressionVariableInitialization(expression.index, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
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
        analyzeIrObjectMemberVariableInitialization(member, initialized, variables, sourceIdentity, completion),
      );
      return;
    case 'property':
      analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      return;
    case 'template':
      expression.parts.forEach((part) => {
        if (typeof part !== 'string') {
          analyzeIrExpressionVariableInitialization(part, initialized, variables, sourceIdentity, completion);
          addIrVariableInitializationCompletion(completion, 'throw', initialized);
        }
      });
      return;
    case 'tuple':
      expression.elements.forEach((element) => {
        if (element.expression) {
          analyzeIrExpressionVariableInitialization(
            element.expression,
            initialized,
            variables,
            sourceIdentity,
            completion,
          );
        }
      });
      return;
    case 'tupleSpread':
      expression.segments.forEach((segment) => {
        const value = segment.kind === 'spread' ? segment.expression : segment.element.expression;
        if (value) {
          analyzeIrExpressionVariableInitialization(value, initialized, variables, sourceIdentity, completion);
        }
        if (segment.kind === 'spread') addIrVariableInitializationCompletion(completion, 'throw', initialized);
      });
      return;
    case 'tupleRest':
    case 'tupleSuffix':
      analyzeIrExpressionVariableInitialization(expression.object, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      return;
    case 'unary':
      analyzeIrExpressionVariableInitialization(expression.operand, initialized, variables, sourceIdentity, completion);
      if (expression.operator !== '!' && expression.operator !== 'typeof' && expression.operator !== 'void') {
        addIrVariableInitializationCompletion(completion, 'throw', initialized);
      }
      if (expression.operator === '++' || expression.operator === '--') {
        addIrExpressionAssignmentTargetVariableInitialization(expression.operand, initialized, variables);
      }
      return;
    case 'undefinedDefault':
      analyzeIrExpressionVariableInitialization(expression.value, initialized, variables, sourceIdentity, completion);
      analyzeIrExpressionVariableInitialization(
        expression.fallback,
        new Set(initialized),
        variables,
        sourceIdentity,
        completion,
      );
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
  completion: MutableCompilerVariableInitializationCompletion,
): void {
  switch (member.kind) {
    case 'computedProperty':
      analyzeIrExpressionVariableInitialization(member.key, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      analyzeIrExpressionVariableInitialization(member.value, initialized, variables, sourceIdentity, completion);
      return;
    case 'property':
      analyzeIrExpressionVariableInitialization(member.value, initialized, variables, sourceIdentity, completion);
      return;
    case 'spread':
      analyzeIrExpressionVariableInitialization(member.expression, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      return;
  }
}

function analyzeIrStatementListVariableInitialization(
  statements: readonly Readonly<IrStatement>[],
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): CompilerVariableInitializationCompletion {
  const completion: MutableCompilerVariableInitializationCompletion = { normal: initialized };
  for (const statement of statements) {
    const current = completion.normal;
    if (!current) break;
    delete completion.normal;
    mergeIrVariableInitializationCompletions(
      completion,
      analyzeIrStatementVariableInitialization(statement, current, variables, sourceIdentity),
    );
  }
  return completion;
}

function analyzeIrStatementVariableInitialization(
  statement: Readonly<IrStatement>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): CompilerVariableInitializationCompletion {
  switch (statement.kind) {
    case 'block':
      return analyzeIrStatementListVariableInitialization(statement.statements, initialized, variables, sourceIdentity);
    case 'do': {
      const body = analyzeIrStatementVariableInitialization(
        statement.body,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const completion = getIrVariableInitializationAbruptLoopCompletions(body);
      const backEdge = combineCompilerVariableInitializationSets(body.normal, body.continue);
      if (backEdge) {
        analyzeIrExpressionVariableInitialization(statement.condition, backEdge, variables, sourceIdentity, completion);
        addIrVariableInitializationCompletion(completion, 'normal', backEdge);
      }
      addIrVariableInitializationCompletion(completion, 'normal', body.break);
      return completion;
    }
    case 'expression': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(
        statement.expression,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      addIrVariableInitializationCompletion(completion, 'normal', initialized);
      return completion;
    }
    case 'for': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      if (Array.isArray(statement.initializer)) {
        statement.initializer.forEach((variable) =>
          analyzeIrVariableVariableInitialization(variable, initialized, variables, sourceIdentity, completion),
        );
      } else if (statement.initializer) {
        analyzeIrExpressionVariableInitialization(
          statement.initializer as IrExpression,
          initialized,
          variables,
          sourceIdentity,
          completion,
        );
      }
      if (statement.condition) {
        analyzeIrExpressionVariableInitialization(
          statement.condition,
          initialized,
          variables,
          sourceIdentity,
          completion,
        );
      }
      const body = analyzeIrStatementVariableInitialization(
        statement.body,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const backEdge = combineCompilerVariableInitializationSets(body.normal, body.continue);
      if (backEdge) {
        if (statement.increment) {
          analyzeIrExpressionVariableInitialization(
            statement.increment,
            backEdge,
            variables,
            sourceIdentity,
            completion,
          );
        }
        if (statement.condition) {
          analyzeIrExpressionVariableInitialization(
            statement.condition,
            backEdge,
            variables,
            sourceIdentity,
            completion,
          );
        }
      }
      mergeIrVariableInitializationCompletions(completion, getIrVariableInitializationAbruptLoopCompletions(body));
      if (statement.condition) addIrVariableInitializationCompletion(completion, 'normal', initialized);
      addIrVariableInitializationCompletion(completion, 'normal', body.break);
      return completion;
    }
    case 'forIn': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(statement.object, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      const bodyState = new Set(initialized);
      addIrIterationVariableVariableInitialization(statement.variable, bodyState, variables);
      const body = analyzeIrStatementVariableInitialization(statement.body, bodyState, variables, sourceIdentity);
      mergeIrVariableInitializationCompletions(completion, getIrVariableInitializationAbruptLoopCompletions(body));
      addIrVariableInitializationCompletion(completion, 'normal', initialized);
      addIrVariableInitializationCompletion(completion, 'normal', body.break);
      return completion;
    }
    case 'forOf': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(statement.iterable, initialized, variables, sourceIdentity, completion);
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      const bodyState = new Set(initialized);
      addIrIterationVariableVariableInitialization(statement.variable, bodyState, variables);
      const body = analyzeIrStatementVariableInitialization(statement.body, bodyState, variables, sourceIdentity);
      mergeIrVariableInitializationCompletions(completion, getIrVariableInitializationAbruptLoopCompletions(body));
      addIrVariableInitializationCompletion(completion, 'normal', initialized);
      addIrVariableInitializationCompletion(completion, 'normal', body.break);
      return completion;
    }
    case 'if': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(
        statement.condition,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      const consequent = analyzeIrStatementVariableInitialization(
        statement.consequent,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const otherwise = statement.otherwise
        ? analyzeIrStatementVariableInitialization(statement.otherwise, new Set(initialized), variables, sourceIdentity)
        : { normal: new Set(initialized) };
      mergeIrVariableInitializationCompletions(
        completion,
        createCompilerVariableInitializationCompletionAlternative(consequent, otherwise),
      );
      return completion;
    }
    case 'return': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      if (statement.expression) {
        analyzeIrExpressionVariableInitialization(
          statement.expression,
          initialized,
          variables,
          sourceIdentity,
          completion,
        );
      }
      addIrVariableInitializationCompletion(completion, 'return', initialized);
      return completion;
    }
    case 'switch': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(
        statement.expression,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      const directEntries: Array<Set<string> | undefined> = [];
      let defaultIndex: number | undefined;
      const selectionState = new Set(initialized);
      statement.cases.forEach((switchCase, index) => {
        if (switchCase.expression) {
          analyzeIrExpressionVariableInitialization(
            switchCase.expression,
            selectionState,
            variables,
            sourceIdentity,
            completion,
          );
          directEntries[index] = new Set(selectionState);
        } else {
          defaultIndex = index;
        }
      });
      if (defaultIndex !== undefined) directEntries[defaultIndex] = new Set(selectionState);
      if (defaultIndex === undefined) {
        addIrVariableInitializationCompletion(completion, 'normal', selectionState);
      }
      let fallthrough: ReadonlySet<string> | undefined;
      statement.cases.forEach((switchCase, index) => {
        const entry = combineCompilerVariableInitializationSets(directEntries[index], fallthrough);
        if (!entry) return;
        const item = analyzeIrStatementListVariableInitialization(
          switchCase.statements,
          entry,
          variables,
          sourceIdentity,
        );
        fallthrough = item.normal;
        addIrVariableInitializationCompletion(completion, 'normal', item.break);
        addIrVariableInitializationCompletion(completion, 'continue', item.continue);
        addIrVariableInitializationCompletion(completion, 'return', item.return);
        addIrVariableInitializationCompletion(completion, 'throw', item.throw);
      });
      addIrVariableInitializationCompletion(completion, 'normal', fallthrough);
      return completion;
    }
    case 'throw': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(
        statement.expression,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      addIrVariableInitializationCompletion(completion, 'throw', initialized);
      return completion;
    }
    case 'try': {
      const tryCompletion = analyzeIrStatementVariableInitialization(
        statement.tryBody,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const catchCompletion =
        statement.catchClause && tryCompletion.throw
          ? analyzeIrStatementVariableInitialization(
              statement.catchClause.body,
              new Set(tryCompletion.throw),
              variables,
              sourceIdentity,
            )
          : undefined;
      const combined = catchCompletion
        ? createCompilerVariableInitializationCompletionAlternative(
            getIrVariableInitializationNonThrowCompletions(tryCompletion),
            catchCompletion,
          )
        : statement.catchClause
          ? getIrVariableInitializationNonThrowCompletions(tryCompletion)
          : tryCompletion;
      if (!statement.finallyBody) return combined;
      const afterFinally: MutableCompilerVariableInitializationCompletion = {};
      for (const kind of variableInitializationCompletionKinds) {
        const state = combined[kind];
        if (!state) continue;
        const finallyCompletion = analyzeIrStatementVariableInitialization(
          statement.finallyBody,
          new Set(state),
          variables,
          sourceIdentity,
        );
        addIrVariableInitializationCompletion(afterFinally, kind, finallyCompletion.normal);
        addIrVariableInitializationCompletion(afterFinally, 'break', finallyCompletion.break);
        addIrVariableInitializationCompletion(afterFinally, 'continue', finallyCompletion.continue);
        addIrVariableInitializationCompletion(afterFinally, 'return', finallyCompletion.return);
        addIrVariableInitializationCompletion(afterFinally, 'throw', finallyCompletion.throw);
      }
      return afterFinally;
    }
    case 'variable': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      statement.declarations.forEach((variable) =>
        analyzeIrVariableVariableInitialization(variable, initialized, variables, sourceIdentity, completion),
      );
      addIrVariableInitializationCompletion(completion, 'normal', initialized);
      return completion;
    }
    case 'while': {
      const completion: MutableCompilerVariableInitializationCompletion = {};
      analyzeIrExpressionVariableInitialization(
        statement.condition,
        initialized,
        variables,
        sourceIdentity,
        completion,
      );
      const body = analyzeIrStatementVariableInitialization(
        statement.body,
        new Set(initialized),
        variables,
        sourceIdentity,
      );
      const backEdge = combineCompilerVariableInitializationSets(body.normal, body.continue);
      if (backEdge) {
        analyzeIrExpressionVariableInitialization(statement.condition, backEdge, variables, sourceIdentity, completion);
      }
      mergeIrVariableInitializationCompletions(completion, getIrVariableInitializationAbruptLoopCompletions(body));
      addIrVariableInitializationCompletion(completion, 'normal', initialized);
      addIrVariableInitializationCompletion(completion, 'normal', body.break);
      return completion;
    }
    case 'break':
      return { break: initialized };
    case 'continue':
      return { continue: initialized };
  }
}

function addIrIterationVariableVariableInitialization(
  variable: Readonly<IrVariable>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
): void {
  if (!('pattern' in variable) && variables.has(variable.binding.id)) {
    initialized.add(variable.binding.id);
  }
}

function addIrVariableInitializationCompletion(
  completion: MutableCompilerVariableInitializationCompletion,
  kind: CompilerVariableInitializationCompletionKind,
  initialized: ReadonlySet<string> | undefined,
): void {
  const combined = createCompilerVariableInitializationCompletionWithState(completion, kind, initialized)[kind];
  if (combined) completion[kind] = new Set(combined);
}

function getIrVariableInitializationAbruptLoopCompletions(
  completion: Readonly<CompilerVariableInitializationCompletion>,
): MutableCompilerVariableInitializationCompletion {
  return {
    ...(completion.return ? { return: new Set(completion.return) } : {}),
    ...(completion.throw ? { throw: new Set(completion.throw) } : {}),
  };
}

function getIrVariableInitializationNonThrowCompletions(
  completion: Readonly<CompilerVariableInitializationCompletion>,
): MutableCompilerVariableInitializationCompletion {
  return {
    ...(completion.break ? { break: new Set(completion.break) } : {}),
    ...(completion.continue ? { continue: new Set(completion.continue) } : {}),
    ...(completion.normal ? { normal: new Set(completion.normal) } : {}),
    ...(completion.return ? { return: new Set(completion.return) } : {}),
  };
}

function mergeIrVariableInitializationCompletions(
  target: MutableCompilerVariableInitializationCompletion,
  source: Readonly<CompilerVariableInitializationCompletion>,
): void {
  for (const kind of variableInitializationCompletionKinds) {
    addIrVariableInitializationCompletion(target, kind, source[kind]);
  }
}

function analyzeIrVariableVariableInitialization(
  variable: Readonly<IrVariable>,
  initialized: Set<string>,
  variables: ReadonlyMap<string, IrNamedVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  completion: MutableCompilerVariableInitializationCompletion,
): void {
  if (variable.initializer) {
    analyzeIrExpressionVariableInitialization(variable.initializer, initialized, variables, sourceIdentity, completion);
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
    case 'tupleSpread':
      expression.segments.forEach((segment) => {
        const value = segment.kind === 'spread' ? segment.expression : segment.element.expression;
        if (value) visit(value);
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
const variableInitializationCompletionKinds: readonly CompilerVariableInitializationCompletionKind[] = [
  'break',
  'continue',
  'normal',
  'return',
  'throw',
];

type MutableCompilerVariableInitializationCompletion = {
  -readonly [Kind in CompilerVariableInitializationCompletionKind]?: Set<string>;
};
