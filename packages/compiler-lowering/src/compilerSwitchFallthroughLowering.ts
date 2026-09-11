import type {
  CompilerLoweringPass,
  CompilerSourceIdentity,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrSwitchCase,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';
import { getIrSwitchCaseCompletion } from './compilerSwitchClauseCompletion.js';

export function createCompilerLoweringPassSwitchFallthrough(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule(module) {
      return lowerIrModuleSwitchFallthrough(module);
    },
    name: compilerLoweringPassNameSwitchFallthrough,
    runsAfter: ['variable-hoisting'],
    verifyIrModule(module) {
      return hasIrModuleSwitchFallthrough(module)
        ? { kind: 'invalid', reason: 'switch fallthrough remains after normalization' }
        : { kind: 'valid' };
    },
  };
}

function hasIrDeclarationSwitchFallthrough(declaration: Readonly<IrDeclaration>): boolean {
  switch (declaration.kind) {
    case 'class':
      return (
        declaration.fields.some((field) => field.initializer && hasIrExpressionSwitchFallthrough(field.initializer)) ||
        (declaration.classConstructor
          ? declaration.classConstructor.parameters.some(hasIrParameterSwitchFallthrough) ||
            declaration.classConstructor.body.some(hasIrStatementSwitchFallthrough)
          : false) ||
        declaration.methods.some(
          (method) =>
            method.parameters.some(hasIrParameterSwitchFallthrough) ||
            method.body.some(hasIrStatementSwitchFallthrough),
        )
      );
    case 'function':
      return (
        declaration.parameters.some(hasIrParameterSwitchFallthrough) ||
        declaration.body.some(hasIrStatementSwitchFallthrough)
      );
    case 'variable':
      return declaration.initializer ? hasIrExpressionSwitchFallthrough(declaration.initializer) : false;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return false;
  }
}

function hasIrExpressionBindingIntroductionSwitchFallthrough(expression: Readonly<IrExpression>): boolean {
  if (expression.kind === 'function') return true;
  let found = false;
  visitIrExpressionChildrenSwitchFallthrough(expression, (child) => {
    found ||= hasIrExpressionBindingIntroductionSwitchFallthrough(child);
  });
  return found;
}

function hasIrExpressionSwitchFallthrough(expression: Readonly<IrExpression>): boolean {
  if (expression.kind === 'function') {
    return (
      expression.parameters.some(hasIrParameterSwitchFallthrough) ||
      expression.body.some(hasIrStatementSwitchFallthrough) ||
      (expression.expression ? hasIrExpressionSwitchFallthrough(expression.expression) : false)
    );
  }
  let found = false;
  visitIrExpressionChildrenSwitchFallthrough(expression, (child) => {
    found ||= hasIrExpressionSwitchFallthrough(child);
  });
  return found;
}

function hasIrModuleSwitchFallthrough(module: Readonly<IrModule>): boolean {
  return (
    module.declarations.some(hasIrDeclarationSwitchFallthrough) ||
    module.exports.some(
      (exported) => exported.kind === 'default' && hasIrExpressionSwitchFallthrough(exported.expression),
    )
  );
}

function hasIrParameterSwitchFallthrough(parameter: Readonly<IrParameter>): boolean {
  return parameter.initializer ? hasIrExpressionSwitchFallthrough(parameter.initializer) : false;
}

function hasIrStatementBindingIntroductionSwitchFallthrough(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some(hasIrStatementBindingIntroductionSwitchFallthrough);
    case 'do':
    case 'while':
      return (
        hasIrExpressionBindingIntroductionSwitchFallthrough(statement.condition) ||
        hasIrStatementBindingIntroductionSwitchFallthrough(statement.body)
      );
    case 'expression':
    case 'throw':
      return hasIrExpressionBindingIntroductionSwitchFallthrough(statement.expression);
    case 'for':
      return (
        (Array.isArray(statement.initializer)
          ? statement.initializer.length > 0
          : statement.initializer
            ? hasIrExpressionBindingIntroductionSwitchFallthrough(statement.initializer as IrExpression)
            : false) ||
        (statement.condition ? hasIrExpressionBindingIntroductionSwitchFallthrough(statement.condition) : false) ||
        (statement.increment ? hasIrExpressionBindingIntroductionSwitchFallthrough(statement.increment) : false) ||
        hasIrStatementBindingIntroductionSwitchFallthrough(statement.body)
      );
    case 'forIn':
    case 'forOf':
      return true;
    case 'if':
      return (
        hasIrExpressionBindingIntroductionSwitchFallthrough(statement.condition) ||
        hasIrStatementBindingIntroductionSwitchFallthrough(statement.consequent) ||
        (statement.otherwise ? hasIrStatementBindingIntroductionSwitchFallthrough(statement.otherwise) : false)
      );
    case 'return':
      return statement.expression ? hasIrExpressionBindingIntroductionSwitchFallthrough(statement.expression) : false;
    case 'switch':
      return (
        hasIrExpressionBindingIntroductionSwitchFallthrough(statement.expression) ||
        statement.cases.some(
          (switchCase) =>
            (switchCase.expression
              ? hasIrExpressionBindingIntroductionSwitchFallthrough(switchCase.expression)
              : false) || switchCase.statements.some(hasIrStatementBindingIntroductionSwitchFallthrough),
        )
      );
    case 'try':
      return (
        statement.catchClause?.binding !== undefined ||
        hasIrStatementBindingIntroductionSwitchFallthrough(statement.tryBody) ||
        (statement.catchClause
          ? hasIrStatementBindingIntroductionSwitchFallthrough(statement.catchClause.body)
          : false) ||
        (statement.finallyBody ? hasIrStatementBindingIntroductionSwitchFallthrough(statement.finallyBody) : false)
      );
    case 'variable':
      return statement.declarations.length > 0;
    case 'break':
    case 'continue':
      return false;
  }
}

function hasIrStatementSwitchFallthrough(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some(hasIrStatementSwitchFallthrough);
    case 'do':
    case 'while':
      return hasIrStatementSwitchFallthrough(statement.body) || hasIrExpressionSwitchFallthrough(statement.condition);
    case 'expression':
    case 'throw':
      return hasIrExpressionSwitchFallthrough(statement.expression);
    case 'for':
      return (
        (Array.isArray(statement.initializer)
          ? statement.initializer.some(hasIrVariableSwitchFallthrough)
          : statement.initializer
            ? hasIrExpressionSwitchFallthrough(statement.initializer as IrExpression)
            : false) ||
        (statement.condition ? hasIrExpressionSwitchFallthrough(statement.condition) : false) ||
        (statement.increment ? hasIrExpressionSwitchFallthrough(statement.increment) : false) ||
        hasIrStatementSwitchFallthrough(statement.body)
      );
    case 'forIn':
      return (
        hasIrVariableSwitchFallthrough(statement.variable) ||
        hasIrExpressionSwitchFallthrough(statement.object) ||
        hasIrStatementSwitchFallthrough(statement.body)
      );
    case 'forOf':
      return (
        hasIrVariableSwitchFallthrough(statement.variable) ||
        hasIrExpressionSwitchFallthrough(statement.iterable) ||
        hasIrStatementSwitchFallthrough(statement.body)
      );
    case 'if':
      return (
        hasIrExpressionSwitchFallthrough(statement.condition) ||
        hasIrStatementSwitchFallthrough(statement.consequent) ||
        (statement.otherwise ? hasIrStatementSwitchFallthrough(statement.otherwise) : false)
      );
    case 'return':
      return statement.expression ? hasIrExpressionSwitchFallthrough(statement.expression) : false;
    case 'switch':
      return (
        statement.cases.some(
          (switchCase) =>
            getIrSwitchCaseCompletion(switchCase).kind !== 'localBreak' &&
            getIrSwitchCaseCompletion(switchCase).kind !== 'abrupt',
        ) ||
        hasIrExpressionSwitchFallthrough(statement.expression) ||
        statement.cases.some(
          (switchCase) =>
            (switchCase.expression ? hasIrExpressionSwitchFallthrough(switchCase.expression) : false) ||
            switchCase.statements.some(hasIrStatementSwitchFallthrough),
        )
      );
    case 'try':
      return (
        hasIrStatementSwitchFallthrough(statement.tryBody) ||
        (statement.catchClause ? hasIrStatementSwitchFallthrough(statement.catchClause.body) : false) ||
        (statement.finallyBody ? hasIrStatementSwitchFallthrough(statement.finallyBody) : false)
      );
    case 'variable':
      return statement.declarations.some(hasIrVariableSwitchFallthrough);
    case 'break':
    case 'continue':
      return false;
  }
}

function hasIrVariableSwitchFallthrough(variable: Readonly<IrVariable>): boolean {
  return variable.initializer ? hasIrExpressionSwitchFallthrough(variable.initializer) : false;
}

function lowerIrDeclarationSwitchFallthrough(
  declaration: Readonly<IrDeclaration>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: declaration.classConstructor.body.map((statement) =>
                  lowerIrStatementSwitchFallthrough(statement, sourceIdentity),
                ),
                parameters: declaration.classConstructor.parameters.map((parameter) =>
                  lowerIrParameterSwitchFallthrough(parameter, sourceIdentity),
                ),
              },
            }
          : {}),
        fields: declaration.fields.map((field) =>
          field.parameterProperty
            ? field
            : {
                ...field,
                ...(field.initializer
                  ? { initializer: lowerIrExpressionSwitchFallthrough(field.initializer, sourceIdentity) }
                  : {}),
              },
        ),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: method.body.map((statement) => lowerIrStatementSwitchFallthrough(statement, sourceIdentity)),
          parameters: method.parameters.map((parameter) =>
            lowerIrParameterSwitchFallthrough(parameter, sourceIdentity),
          ),
        })),
      };
    case 'function':
      return {
        ...declaration,
        body: declaration.body.map((statement) => lowerIrStatementSwitchFallthrough(statement, sourceIdentity)),
        parameters: declaration.parameters.map((parameter) =>
          lowerIrParameterSwitchFallthrough(parameter, sourceIdentity),
        ),
      };
    case 'variable':
      return declaration.initializer
        ? {
            ...declaration,
            initializer: lowerIrExpressionSwitchFallthrough(declaration.initializer, sourceIdentity),
          }
        : declaration;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return declaration;
  }
}

function lowerIrExpressionSwitchFallthrough(
  expression: Readonly<IrExpression>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrExpression {
  switch (expression.kind) {
    case 'array':
      return {
        ...expression,
        elements: expression.elements.map((element) =>
          element ? lowerIrExpressionSwitchFallthrough(element, sourceIdentity) : undefined,
        ),
      };
    case 'assignment':
    case 'binary':
      return {
        ...expression,
        left: lowerIrExpressionSwitchFallthrough(expression.left, sourceIdentity),
        right: lowerIrExpressionSwitchFallthrough(expression.right, sourceIdentity),
      };
    case 'await':
    case 'cast':
    case 'spread':
      return { ...expression, expression: lowerIrExpressionSwitchFallthrough(expression.expression, sourceIdentity) };
    case 'call':
    case 'new':
      return {
        ...expression,
        arguments: expression.arguments.map((argument) => lowerIrExpressionSwitchFallthrough(argument, sourceIdentity)),
        callee: lowerIrExpressionSwitchFallthrough(expression.callee, sourceIdentity),
      };
    case 'conditional':
      return {
        ...expression,
        condition: lowerIrExpressionSwitchFallthrough(expression.condition, sourceIdentity),
        whenFalse: lowerIrExpressionSwitchFallthrough(expression.whenFalse, sourceIdentity),
        whenTrue: lowerIrExpressionSwitchFallthrough(expression.whenTrue, sourceIdentity),
      };
    case 'element':
      return {
        ...expression,
        index: lowerIrExpressionSwitchFallthrough(expression.index, sourceIdentity),
        object: lowerIrExpressionSwitchFallthrough(expression.object, sourceIdentity),
      };
    case 'function':
      return {
        ...expression,
        body: expression.body.map((statement) => lowerIrStatementSwitchFallthrough(statement, sourceIdentity)),
        ...(expression.expression
          ? { expression: lowerIrExpressionSwitchFallthrough(expression.expression, sourceIdentity) }
          : {}),
        parameters: expression.parameters.map((parameter) =>
          lowerIrParameterSwitchFallthrough(parameter, sourceIdentity),
        ),
      };
    case 'object':
      return {
        ...expression,
        members: expression.members.map((member) => lowerIrObjectMemberSwitchFallthrough(member, sourceIdentity)),
      };
    case 'objectRest':
      return {
        ...expression,
        excluded: expression.excluded.map((key) =>
          key.kind === 'computed'
            ? {
                ...key,
                expression: lowerIrExpressionSwitchFallthrough(key.expression, sourceIdentity),
              }
            : key,
        ),
        object: expression.object,
      };
    case 'property':
      return { ...expression, object: lowerIrExpressionSwitchFallthrough(expression.object, sourceIdentity) };
    case 'template':
      return {
        ...expression,
        parts: expression.parts.map((part) =>
          typeof part === 'string' ? part : lowerIrExpressionSwitchFallthrough(part, sourceIdentity),
        ),
      };
    case 'tuple':
      return {
        ...expression,
        elements: expression.elements.map((element) => ({
          ...element,
          ...(element.expression
            ? { expression: lowerIrExpressionSwitchFallthrough(element.expression, sourceIdentity) }
            : {}),
        })),
      };
    case 'tupleSpread':
      return {
        ...expression,
        segments: expression.segments.map((segment) =>
          segment.kind === 'spread'
            ? { ...segment, expression: lowerIrExpressionSwitchFallthrough(segment.expression, sourceIdentity) }
            : segment.element.expression
              ? {
                  ...segment,
                  element: {
                    ...segment.element,
                    expression: lowerIrExpressionSwitchFallthrough(segment.element.expression, sourceIdentity),
                  },
                }
              : segment,
        ),
      };
    case 'tupleRest':
      return { ...expression, object: lowerIrExpressionSwitchFallthrough(expression.object, sourceIdentity) };
    case 'unary':
      return { ...expression, operand: lowerIrExpressionSwitchFallthrough(expression.operand, sourceIdentity) };
    case 'undefinedDefault':
      return {
        ...expression,
        fallback: lowerIrExpressionSwitchFallthrough(expression.fallback, sourceIdentity),
        value: lowerIrExpressionSwitchFallthrough(expression.value, sourceIdentity),
      };
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'tupleSuffix':
    case 'undefinedValue':
      return expression;
  }
}

function lowerIrModuleSwitchFallthrough(module: Readonly<IrModule>): IrModule {
  return {
    ...module,
    declarations: module.declarations.map((declaration) => lowerIrDeclarationSwitchFallthrough(declaration, module)),
    exports: module.exports.map((exported) =>
      exported.kind === 'default'
        ? { ...exported, expression: lowerIrExpressionSwitchFallthrough(exported.expression, module) }
        : exported,
    ),
  };
}

function lowerIrObjectMemberSwitchFallthrough(
  member: Readonly<IrObjectMember>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrObjectMember {
  switch (member.kind) {
    case 'computedProperty':
      return {
        ...member,
        key: lowerIrExpressionSwitchFallthrough(member.key, sourceIdentity),
        value: lowerIrExpressionSwitchFallthrough(member.value, sourceIdentity),
      };
    case 'property':
      return { ...member, value: lowerIrExpressionSwitchFallthrough(member.value, sourceIdentity) };
    case 'spread':
      return { ...member, expression: lowerIrExpressionSwitchFallthrough(member.expression, sourceIdentity) };
  }
}

function lowerIrParameterSwitchFallthrough(
  parameter: Readonly<IrParameter>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrParameter {
  return parameter.initializer
    ? { ...parameter, initializer: lowerIrExpressionSwitchFallthrough(parameter.initializer, sourceIdentity) }
    : parameter;
}

function lowerIrStatementSwitchFallthrough(
  statement: Readonly<IrStatement>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return {
        ...statement,
        statements: statement.statements.map((item) => lowerIrStatementSwitchFallthrough(item, sourceIdentity)),
      };
    case 'do':
    case 'while':
      return {
        ...statement,
        body: lowerIrStatementSwitchFallthrough(statement.body, sourceIdentity),
        condition: lowerIrExpressionSwitchFallthrough(statement.condition, sourceIdentity),
      };
    case 'expression':
    case 'throw':
      return { ...statement, expression: lowerIrExpressionSwitchFallthrough(statement.expression, sourceIdentity) };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementSwitchFallthrough(statement.body, sourceIdentity),
        ...(statement.condition
          ? { condition: lowerIrExpressionSwitchFallthrough(statement.condition, sourceIdentity) }
          : {}),
        ...(statement.increment
          ? { increment: lowerIrExpressionSwitchFallthrough(statement.increment, sourceIdentity) }
          : {}),
        ...(Array.isArray(statement.initializer)
          ? {
              initializer: statement.initializer.map((variable) =>
                lowerIrVariableSwitchFallthrough(variable, sourceIdentity),
              ),
            }
          : statement.initializer
            ? { initializer: lowerIrExpressionSwitchFallthrough(statement.initializer as IrExpression, sourceIdentity) }
            : {}),
      };
    case 'forIn':
      return {
        ...statement,
        body: lowerIrStatementSwitchFallthrough(statement.body, sourceIdentity),
        object: lowerIrExpressionSwitchFallthrough(statement.object, sourceIdentity),
        variable: lowerIrVariableSwitchFallthrough(statement.variable, sourceIdentity),
      };
    case 'forOf':
      return {
        ...statement,
        body: lowerIrStatementSwitchFallthrough(statement.body, sourceIdentity),
        iterable: lowerIrExpressionSwitchFallthrough(statement.iterable, sourceIdentity),
        variable: lowerIrVariableSwitchFallthrough(statement.variable, sourceIdentity),
      };
    case 'if':
      return {
        ...statement,
        condition: lowerIrExpressionSwitchFallthrough(statement.condition, sourceIdentity),
        consequent: lowerIrStatementSwitchFallthrough(statement.consequent, sourceIdentity),
        ...(statement.otherwise
          ? { otherwise: lowerIrStatementSwitchFallthrough(statement.otherwise, sourceIdentity) }
          : {}),
      };
    case 'return':
      return statement.expression
        ? { ...statement, expression: lowerIrExpressionSwitchFallthrough(statement.expression, sourceIdentity) }
        : statement;
    case 'switch': {
      const cases = statement.cases.map((switchCase) => ({
        ...switchCase,
        ...(switchCase.expression
          ? { expression: lowerIrExpressionSwitchFallthrough(switchCase.expression, sourceIdentity) }
          : {}),
        statements: switchCase.statements.map((item) => lowerIrStatementSwitchFallthrough(item, sourceIdentity)),
      }));
      const expression = lowerIrExpressionSwitchFallthrough(statement.expression, sourceIdentity);
      const completions = cases.map((switchCase) => getIrSwitchCaseCompletion(switchCase, statement.label?.id));
      if (
        completions.some((completion) => completion.kind === 'fallthrough') &&
        cases.some((switchCase) => switchCase.statements.some(hasIrStatementBindingIntroductionSwitchFallthrough))
      ) {
        return createIrSwitchStateMachineFallthrough({ ...statement, cases, expression }, completions, sourceIdentity);
      }
      return {
        ...statement,
        cases: lowerIrSwitchCasesFallthrough(cases, sourceIdentity, statement.label?.id),
        expression,
      };
    }
    case 'try':
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatementSwitchFallthrough(statement.catchClause.body, sourceIdentity),
              },
            }
          : {}),
        ...(statement.finallyBody
          ? { finallyBody: lowerIrStatementSwitchFallthrough(statement.finallyBody, sourceIdentity) }
          : {}),
        tryBody: lowerIrStatementSwitchFallthrough(statement.tryBody, sourceIdentity),
      };
    case 'variable':
      return {
        ...statement,
        declarations: statement.declarations.map((variable) =>
          lowerIrVariableSwitchFallthrough(variable, sourceIdentity),
        ),
      };
    case 'break':
    case 'continue':
      return statement;
  }
}

function lowerIrSwitchCasesFallthrough(
  cases: readonly Readonly<IrSwitchCase>[],
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  switchLabel?: string,
): readonly IrSwitchCase[] {
  const completions = cases.map((switchCase) => getIrSwitchCaseCompletion(switchCase, switchLabel));
  const unsupported = completions.find((completion) => completion.kind === 'unsupported');
  if (unsupported?.kind === 'unsupported') {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameSwitchFallthrough,
      sourceIdentity,
      unsupported.reason,
    );
  }
  return cases.map((switchCase, start) => {
    const statements: IrStatement[] = [];
    for (let index = start; index < cases.length; index += 1) {
      const item = cases[index]!;
      const completion = completions[index]!;
      statements.push(...(completion.kind === 'localBreak' ? item.statements.slice(0, -1) : item.statements));
      if (completion.kind !== 'fallthrough') break;
    }
    const last = statements.at(-1);
    if (!last || (last.kind !== 'break' && last.kind !== 'return' && last.kind !== 'throw')) {
      statements.push({ kind: 'break' });
    }
    return { ...switchCase, statements };
  });
}

function createIrSwitchStateMachineFallthrough(
  statement: Readonly<Extract<IrStatement, { kind: 'switch' }>>,
  completions: readonly ReturnType<typeof getIrSwitchCaseCompletion>[],
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrStatement {
  if (!statement.origin) {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameSwitchFallthrough,
      sourceIdentity,
      'binding-sensitive switch fallthrough requires switch source identity',
    );
  }
  const unsupported = completions.find((completion) => completion.kind === 'unsupported');
  if (unsupported?.kind === 'unsupported') {
    throw createCompilerLoweringFailure(
      'unsupported-ir',
      compilerLoweringPassNameSwitchFallthrough,
      sourceIdentity,
      unsupported.reason,
    );
  }
  const state: IrBindingIdentity = {
    ...statement.origin,
    id: `binding:${JSON.stringify([
      statement.origin.packageName,
      statement.origin.source,
      statement.origin.line,
      statement.origin.column,
      'switch-fallthrough-state',
    ])}`,
    kind: 'variable',
    name: 'switchFallthroughState',
    scope: 'block',
    space: 'value',
  };
  const stateReference: IrExpression = {
    kind: 'identifier',
    reference: { binding: state, kind: 'binding' },
  };
  const assignState = (value: number): IrStatement => ({
    expression: {
      kind: 'assignment',
      left: stateReference,
      operator: '=',
      right: { kind: 'literal', value },
      semantics: {
        left: { declared: 'number', flow: 'number' },
        result: 'number',
        right: { declared: 'number', flow: 'number' },
      },
    },
    kind: 'expression',
  });
  const defaultIndex = statement.cases.findIndex((switchCase) => switchCase.expression === undefined);
  const selectorCases: IrSwitchCase[] = statement.cases.flatMap((switchCase, index) =>
    switchCase.expression
      ? [{ expression: switchCase.expression, statements: [assignState(index), { kind: 'break' }] }]
      : [],
  );
  selectorCases.push({ statements: [assignState(defaultIndex), { kind: 'break' }] });
  const executionCases = statement.cases.map((switchCase, index): IrSwitchCase => {
    const completion = completions[index]!;
    const last = switchCase.statements.at(-1);
    const continues = last?.kind === 'continue' && !last.target;
    const statements =
      completion.kind === 'localBreak' || continues ? switchCase.statements.slice(0, -1) : [...switchCase.statements];
    if (completion.kind === 'fallthrough' || completion.kind === 'localBreak' || continues) {
      statements.push(
        assignState(
          continues ? -2 : completion.kind === 'fallthrough' && index + 1 < statement.cases.length ? index + 1 : -1,
        ),
      );
      statements.push({ kind: 'break' });
    }
    return { ...switchCase, expression: { kind: 'literal', value: index }, statements };
  });
  return {
    kind: 'block',
    ...(statement.label ? { label: statement.label } : {}),
    statements: [
      {
        declarations: [
          {
            binding: state,
            initializer: { kind: 'literal', value: -1 },
            mutable: true,
            type: { kind: 'primitive', name: 'number' },
          },
        ],
        kind: 'variable',
      },
      { cases: selectorCases, expression: statement.expression, kind: 'switch', origin: statement.origin },
      {
        body: {
          cases: executionCases,
          expression: stateReference,
          kind: 'switch',
          origin: statement.origin,
        },
        condition: {
          kind: 'binary',
          left: stateReference,
          operator: '>=',
          right: { kind: 'literal', value: 0 },
          semantics: {
            left: { declared: 'number', flow: 'number' },
            result: 'boolean',
            right: { declared: 'number', flow: 'number' },
          },
        },
        kind: 'while',
      },
      ...(statement.cases.some((switchCase) => {
        const last = switchCase.statements.at(-1);
        return last?.kind === 'continue' && !last.target;
      })
        ? [
            {
              condition: {
                kind: 'binary' as const,
                left: stateReference,
                operator: '===' as const,
                right: { kind: 'literal' as const, value: -2 },
                semantics: {
                  left: { declared: 'number' as const, flow: 'number' as const },
                  result: 'boolean' as const,
                  right: { declared: 'number' as const, flow: 'number' as const },
                },
              },
              consequent: { kind: 'continue' as const },
              kind: 'if' as const,
            },
          ]
        : []),
    ],
  };
}

function lowerIrVariableSwitchFallthrough(
  variable: Readonly<IrVariable>,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
): IrVariable {
  return variable.initializer
    ? { ...variable, initializer: lowerIrExpressionSwitchFallthrough(variable.initializer, sourceIdentity) }
    : variable;
}

function visitIrExpressionChildrenSwitchFallthrough(
  expression: Readonly<IrExpression>,
  visit: (child: Readonly<IrExpression>) => void,
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
      visit(expression.whenTrue);
      visit(expression.whenFalse);
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
    case 'objectRest':
      visit(expression.object);
      expression.excluded.forEach((key) => {
        if (key.kind === 'computed') visit(key.expression);
      });
      return;
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'undefinedValue':
      return;
    default:
      assertNeverSwitchFallthrough(expression);
  }
}

const compilerLoweringPassNameSwitchFallthrough = 'switch-fallthrough';

function assertNeverSwitchFallthrough(value: never): never {
  const kind = (value as { readonly kind?: unknown }).kind;
  throw new TypeError(`Unknown neutral IR kind ${String(kind)}`);
}
