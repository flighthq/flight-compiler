import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
} from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  CompilerSourceOrigin,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';

// `if (await task)` has to settle before the branch is decided, and a state machine can only branch
// on a value it already holds. Binding the condition first turns that into an ordinary suspension
// followed by an ordinary branch, which is a rewrite the source language permits because an `if`
// evaluates its condition exactly once, before either arm.
//
// Loop conditions are deliberately untouched: a loop re-evaluates its condition on every iteration,
// so hoisting one out would evaluate it once and change what the program means.
export function createCompilerLoweringPassAwaitConditionHoisting(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: lowerIrModuleAwaitConditionHoisting,
    name: compilerLoweringPassNameAwaitConditionHoisting,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrModuleAwaitConditionResidual(module)
        ? { kind: 'invalid', reason: 'a suspending branch condition remains after hoisting' }
        : { kind: 'valid' };
    },
  };
}

function hasIrModuleAwaitConditionResidual(module: Readonly<IrModule>): boolean {
  let residual = false;
  analyzeIrModuleTraversal(module, {
    statement(statement) {
      if (statement.kind === 'if' && hasIrExpressionAwait(statement.condition)) {
        residual = true;
        return false;
      }
      if (
        statement.kind === 'variable' &&
        statement.declarations.some(
          (declaration) =>
            declaration.initializer?.kind === 'conditional' && hasIrExpressionAwait(declaration.initializer),
        )
      ) {
        residual = true;
        return false;
      }
      return undefined;
    },
  });
  return residual;
}

function createIrAwaitConditionBinding(origin: Readonly<IrDeclaration>['origin']): IrBindingIdentity {
  return {
    ...origin,
    id: `binding:${JSON.stringify([origin.packageName, origin.source, origin.line, origin.column, 'await-condition'])}`,
    kind: 'variable',
    name: 'awaitCondition',
    scope: 'block',
    space: 'value',
  };
}

function createIrAwaitValueBinding(origin: Readonly<CompilerSourceOrigin>, ordinal: number): IrBindingIdentity {
  return {
    ...origin,
    id: `binding:${JSON.stringify([origin.packageName, origin.source, origin.line, origin.column, 'await-value', ordinal])}`,
    kind: 'variable',
    name: 'awaitValue',
    scope: 'block',
    space: 'value',
  };
}

function createIrAwaitLoopBinding(
  origin: Readonly<CompilerSourceOrigin>,
  ordinal: number,
  role: 'index' | 'iterable',
): IrBindingIdentity {
  return {
    ...origin,
    id: `binding:${JSON.stringify([origin.packageName, origin.source, origin.line, origin.column, 'await-loop', role, ordinal])}`,
    kind: 'variable',
    name: role === 'index' ? 'awaitLoopIndex' : 'awaitLoopIterable',
    scope: 'block',
    space: 'value',
  };
}

function createIrAwaitLogicalBinding(origin: Readonly<CompilerSourceOrigin>, ordinal: number): IrBindingIdentity {
  return {
    ...origin,
    id: `binding:${JSON.stringify([origin.packageName, origin.source, origin.line, origin.column, 'await-logical', ordinal])}`,
    kind: 'variable',
    name: 'awaitLogicalCondition',
    scope: 'block',
    space: 'value',
  };
}

interface AwaitConditionHoistingContext {
  readonly origin: Readonly<CompilerSourceOrigin>;
  nextBindingOrdinal: number;
}

function hasIrExpressionAwait(expression: Readonly<IrExpression>): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (candidate.kind === 'function') return false;
      if (candidate.kind !== 'await') return undefined;
      found = true;
      return false;
    },
  });
  return found;
}

function hasIrStatementAwait(statement: Readonly<IrStatement>): boolean {
  let found = false;
  analyzeIrStatementSubtreeTraversal(statement, {
    expression(candidate) {
      if (candidate.kind === 'function') return false;
      if (candidate.kind !== 'await') return undefined;
      found = true;
      return false;
    },
  });
  return found;
}

function lowerIrModuleAwaitConditionHoisting(module: Readonly<IrModule>): IrModule {
  return {
    ...module,
    declarations: module.declarations.map(lowerIrDeclarationAwaitConditionHoisting),
    exports: module.exports.map((exported) => {
      if (exported.kind !== 'default') return exported;
      const origin = module.declarations[0]?.origin;
      if (!origin) return exported;
      const context: AwaitConditionHoistingContext = { nextBindingOrdinal: 0, origin };
      return { ...exported, expression: lowerIrExpressionAwaitConditionHoisting(exported.expression, context) };
    }),
  };
}

function lowerIrDeclarationAwaitConditionHoisting(declaration: Readonly<IrDeclaration>): IrDeclaration {
  const context: AwaitConditionHoistingContext = { nextBindingOrdinal: 0, origin: declaration.origin };
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: lowerIrStatementListAwaitConditionHoisting(declaration.classConstructor.body, context),
                parameters: declaration.classConstructor.parameters.map((parameter) =>
                  lowerIrParameterAwaitConditionHoisting(parameter, context),
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
                  ? { initializer: lowerIrExpressionAwaitConditionHoisting(field.initializer, context) }
                  : {}),
              },
        ),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: lowerIrStatementListAwaitConditionHoisting(method.body, context),
          parameters: method.parameters.map((parameter) => lowerIrParameterAwaitConditionHoisting(parameter, context)),
        })),
      };
    case 'function':
      return {
        ...declaration,
        body: lowerIrStatementListAwaitConditionHoisting(declaration.body, context),
        parameters: declaration.parameters.map((parameter) =>
          lowerIrParameterAwaitConditionHoisting(parameter, context),
        ),
      };
    case 'variable':
      return declaration.initializer
        ? { ...declaration, initializer: lowerIrExpressionAwaitConditionHoisting(declaration.initializer, context) }
        : declaration;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return declaration;
  }
}

function lowerIrStatementListAwaitConditionHoisting(
  statements: readonly IrStatement[],
  context: AwaitConditionHoistingContext,
): IrStatement[] {
  return statements.flatMap((statement) => {
    const lowered = lowerIrStatementAwaitConditionHoisting(statement, context);
    if (lowered.kind === 'variable') {
      const conditional = lowerIrAwaitConditionalVariable(lowered);
      if (conditional) return conditional;
    }
    return [lowered];
  });
}

function lowerIrStatementAwaitConditionHoisting(
  statement: Readonly<IrStatement>,
  context: AwaitConditionHoistingContext,
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return { ...statement, statements: lowerIrStatementListAwaitConditionHoisting(statement.statements, context) };
    case 'do':
    case 'while':
      return {
        ...statement,
        body: lowerIrStatementAwaitConditionHoisting(statement.body, context),
        condition: lowerIrExpressionAwaitConditionHoisting(statement.condition, context),
      };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementAwaitConditionHoisting(statement.body, context),
        ...(statement.condition
          ? { condition: lowerIrExpressionAwaitConditionHoisting(statement.condition, context) }
          : {}),
        ...(statement.increment
          ? { increment: lowerIrExpressionAwaitConditionHoisting(statement.increment, context) }
          : {}),
        ...(statement.initializer
          ? {
              initializer: Array.isArray(statement.initializer)
                ? statement.initializer.map((variable) => lowerIrVariableAwaitConditionHoisting(variable, context))
                : lowerIrExpressionAwaitConditionHoisting(statement.initializer as IrExpression, context),
            }
          : {}),
      };
    case 'forIn':
      return {
        ...statement,
        body: lowerIrStatementAwaitConditionHoisting(statement.body, context),
        object: lowerIrExpressionAwaitConditionHoisting(statement.object, context),
        variable: lowerIrVariableAwaitConditionHoisting(statement.variable, context),
      };
    case 'forOf': {
      const body = lowerIrStatementAwaitConditionHoisting(statement.body, context);
      const loweredIterable = lowerIrExpressionAwaitConditionHoisting(statement.iterable, context);
      const variable = lowerIrVariableAwaitConditionHoisting(statement.variable, context);
      if (statement.await || loweredIterable.kind !== 'array' || !hasIrStatementAwait(body)) {
        return { ...statement, body, iterable: loweredIterable, variable };
      }
      const iterableBinding = createIrAwaitLoopBinding(context.origin, context.nextBindingOrdinal++, 'iterable');
      const indexBinding = createIrAwaitLoopBinding(context.origin, context.nextBindingOrdinal++, 'index');
      const iterable: IrExpression = {
        kind: 'identifier',
        reference: { binding: iterableBinding, kind: 'binding' },
      };
      const index: IrExpression = {
        kind: 'identifier',
        reference: { binding: indexBinding, kind: 'binding' },
      };
      return {
        kind: 'block',
        statements: [
          {
            declarations: [{ binding: iterableBinding, initializer: loweredIterable, mutable: false }],
            kind: 'variable',
          },
          {
            declarations: [{ binding: indexBinding, initializer: { kind: 'literal', value: 0 }, mutable: true }],
            kind: 'variable',
          },
          {
            body: {
              kind: 'block',
              statements: [
                {
                  declarations: [
                    {
                      ...variable,
                      initializer: {
                        index,
                        kind: 'element',
                        object: iterable,
                        optional: false,
                        semantics: { key: 'number', receivers: ['array'] },
                      },
                    },
                  ],
                  kind: 'variable',
                },
                {
                  expression: {
                    kind: 'unary',
                    operand: index,
                    operator: '++',
                    postfix: true,
                    semantics: {
                      operand: { declared: 'number', flow: 'number' },
                      result: 'number',
                    },
                  },
                  kind: 'expression',
                },
                body,
              ],
            },
            condition: {
              kind: 'binary',
              left: index,
              operator: '<',
              right: {
                kind: 'property',
                member: { name: 'length', receiver: 'array' },
                name: 'length',
                object: iterable,
                optional: false,
              },
              semantics: {
                left: { declared: 'number', flow: 'number' },
                result: 'boolean',
                right: { declared: 'number', flow: 'number' },
              },
            },
            kind: 'while',
            ...(statement.label ? { label: statement.label } : {}),
          },
        ],
      };
    }
    case 'if': {
      const condition = lowerIrExpressionAwaitConditionHoisting(statement.condition, context);
      const lowered: Extract<IrStatement, { kind: 'if' }> = {
        ...statement,
        condition,
        consequent: lowerIrStatementAwaitConditionHoisting(statement.consequent, context),
        ...(statement.otherwise
          ? { otherwise: lowerIrStatementAwaitConditionHoisting(statement.otherwise, context) }
          : {}),
      };
      if (!statement.origin || !hasIrExpressionAwait(condition)) return lowered;
      const valueBinding = createIrAwaitValueBinding(context.origin, context.nextBindingOrdinal++);
      const extracted = extractIrLeadingAwait(condition, valueBinding);
      if (!extracted) {
        const logical = lowerIrLazyAwaitCondition(lowered, valueBinding, context);
        if (logical) return logical;
      }
      const binding = extracted ? valueBinding : createIrAwaitConditionBinding(statement.origin);
      return {
        kind: 'block',
        statements: [
          {
            declarations: [{ binding, initializer: extracted?.await ?? lowered.condition, mutable: false }],
            kind: 'variable',
          },
          {
            ...lowered,
            condition: extracted?.expression ?? { kind: 'identifier', reference: { binding, kind: 'binding' } },
          },
        ],
      };
    }
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((clause) => ({
          ...clause,
          ...(clause.expression
            ? { expression: lowerIrExpressionAwaitConditionHoisting(clause.expression, context) }
            : {}),
          statements: lowerIrStatementListAwaitConditionHoisting(clause.statements, context),
        })),
        expression: lowerIrExpressionAwaitConditionHoisting(statement.expression, context),
      };
    case 'try':
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatementAwaitConditionHoisting(statement.catchClause.body, context),
              },
            }
          : {}),
        ...(statement.finallyBody
          ? { finallyBody: lowerIrStatementAwaitConditionHoisting(statement.finallyBody, context) }
          : {}),
        tryBody: lowerIrStatementAwaitConditionHoisting(statement.tryBody, context),
      };
    case 'expression':
    case 'throw':
      return { ...statement, expression: lowerIrExpressionAwaitConditionHoisting(statement.expression, context) };
    case 'variable':
      return {
        ...statement,
        declarations: statement.declarations.map((variable) =>
          lowerIrVariableAwaitConditionHoisting(variable, context),
        ),
      };
    case 'break':
    case 'continue':
      return statement;
    case 'return': {
      const expression = statement.expression
        ? lowerIrExpressionAwaitConditionHoisting(statement.expression, context)
        : undefined;
      if (!expression || expression.kind === 'await' || !hasIrExpressionAwait(expression)) {
        return expression ? { ...statement, expression } : statement;
      }
      const binding = createIrAwaitValueBinding(context.origin, context.nextBindingOrdinal++);
      const extracted = extractIrLeadingAwait(expression, binding);
      if (!extracted) return { ...statement, expression };
      return {
        kind: 'block',
        statements: [
          { declarations: [{ binding, initializer: extracted.await, mutable: false }], kind: 'variable' },
          { expression: extracted.expression, kind: 'return' },
        ],
      };
    }
  }
}

function lowerIrExpressionAwaitConditionHoisting(
  expression: Readonly<IrExpression>,
  context: AwaitConditionHoistingContext,
): IrExpression {
  switch (expression.kind) {
    case 'array':
      return {
        ...expression,
        elements: expression.elements.map((element) =>
          element ? lowerIrExpressionAwaitConditionHoisting(element, context) : undefined,
        ),
      };
    case 'assignment':
    case 'binary':
      return {
        ...expression,
        left: lowerIrExpressionAwaitConditionHoisting(expression.left, context),
        right: lowerIrExpressionAwaitConditionHoisting(expression.right, context),
      };
    case 'await':
    case 'cast':
    case 'spread':
      return { ...expression, expression: lowerIrExpressionAwaitConditionHoisting(expression.expression, context) };
    case 'call':
    case 'new':
      return {
        ...expression,
        arguments: expression.arguments.map((argument) => lowerIrExpressionAwaitConditionHoisting(argument, context)),
        callee: lowerIrExpressionAwaitConditionHoisting(expression.callee, context),
      };
    case 'conditional':
      return {
        ...expression,
        condition: lowerIrExpressionAwaitConditionHoisting(expression.condition, context),
        whenFalse: lowerIrExpressionAwaitConditionHoisting(expression.whenFalse, context),
        whenTrue: lowerIrExpressionAwaitConditionHoisting(expression.whenTrue, context),
      };
    case 'element':
      return {
        ...expression,
        index: lowerIrExpressionAwaitConditionHoisting(expression.index, context),
        object: lowerIrExpressionAwaitConditionHoisting(expression.object, context),
      };
    case 'function': {
      const { expression: conciseSource, ...functionExpression } = expression;
      const body = lowerIrStatementListAwaitConditionHoisting(expression.body, context);
      const conciseExpression = conciseSource
        ? lowerIrExpressionAwaitConditionHoisting(conciseSource, context)
        : undefined;
      const conciseReturn = conciseExpression
        ? lowerIrStatementAwaitConditionHoisting({ expression: conciseExpression, kind: 'return' }, context)
        : undefined;
      return {
        ...functionExpression,
        body: conciseReturn?.kind === 'return' ? body : [...body, ...(conciseReturn ? [conciseReturn] : [])],
        ...(conciseReturn?.kind === 'return' && conciseReturn.expression
          ? { expression: conciseReturn.expression }
          : {}),
        parameters: expression.parameters.map((parameter) =>
          lowerIrParameterAwaitConditionHoisting(parameter, context),
        ),
      };
    }
    case 'object':
      return {
        ...expression,
        members: expression.members.map((member) => lowerIrObjectMemberAwaitConditionHoisting(member, context)),
      };
    case 'objectRest':
      return {
        ...expression,
        excluded: expression.excluded.map((key) =>
          key.kind === 'computed'
            ? { ...key, expression: lowerIrExpressionAwaitConditionHoisting(key.expression, context) }
            : key,
        ),
        object: expression.object,
      };
    case 'property':
      return { ...expression, object: lowerIrExpressionAwaitConditionHoisting(expression.object, context) };
    case 'template':
      return {
        ...expression,
        parts: expression.parts.map((part) =>
          typeof part === 'string' ? part : lowerIrExpressionAwaitConditionHoisting(part, context),
        ),
      };
    case 'tuple':
      return {
        ...expression,
        elements: expression.elements.map((element) => ({
          ...element,
          ...(element.expression
            ? { expression: lowerIrExpressionAwaitConditionHoisting(element.expression, context) }
            : {}),
        })),
      };
    case 'tupleSpread':
      return {
        ...expression,
        segments: expression.segments.map((segment) =>
          segment.kind === 'spread'
            ? { ...segment, expression: lowerIrExpressionAwaitConditionHoisting(segment.expression, context) }
            : segment.element.expression
              ? {
                  ...segment,
                  element: {
                    ...segment.element,
                    expression: lowerIrExpressionAwaitConditionHoisting(segment.element.expression, context),
                  },
                }
              : segment,
        ),
      };
    case 'tupleRest':
      return { ...expression, object: lowerIrExpressionAwaitConditionHoisting(expression.object, context) };
    case 'unary':
      return { ...expression, operand: lowerIrExpressionAwaitConditionHoisting(expression.operand, context) };
    case 'undefinedDefault':
      return {
        ...expression,
        fallback: lowerIrExpressionAwaitConditionHoisting(expression.fallback, context),
        value: lowerIrExpressionAwaitConditionHoisting(expression.value, context),
      };
    case 'identifier':
    case 'literal':
    case 'regexp':
    case 'tupleSuffix':
    case 'undefinedValue':
      return expression;
  }
}

function lowerIrObjectMemberAwaitConditionHoisting(
  member: Readonly<IrObjectMember>,
  context: AwaitConditionHoistingContext,
): IrObjectMember {
  switch (member.kind) {
    case 'computedProperty':
      return {
        ...member,
        key: lowerIrExpressionAwaitConditionHoisting(member.key, context),
        value: lowerIrExpressionAwaitConditionHoisting(member.value, context),
      };
    case 'getAccessor': {
      const value = lowerIrExpressionAwaitConditionHoisting(member.value, context);
      if (value.kind !== 'function') throw new TypeError('object getter lowering must preserve its function value');
      return { ...member, value };
    }
    case 'property':
      return { ...member, value: lowerIrExpressionAwaitConditionHoisting(member.value, context) };
    case 'spread':
      return { ...member, expression: lowerIrExpressionAwaitConditionHoisting(member.expression, context) };
  }
}

function lowerIrParameterAwaitConditionHoisting(
  parameter: Readonly<IrParameter>,
  context: AwaitConditionHoistingContext,
): IrParameter {
  return parameter.initializer
    ? { ...parameter, initializer: lowerIrExpressionAwaitConditionHoisting(parameter.initializer, context) }
    : parameter;
}

function lowerIrVariableAwaitConditionHoisting(
  variable: Readonly<IrVariable>,
  context: AwaitConditionHoistingContext,
): IrVariable {
  return variable.initializer
    ? { ...variable, initializer: lowerIrExpressionAwaitConditionHoisting(variable.initializer, context) }
    : variable;
}

function lowerIrLazyAwaitCondition(
  statement: Readonly<Extract<IrStatement, { kind: 'if' }>>,
  valueBinding: Readonly<IrBindingIdentity>,
  context: AwaitConditionHoistingContext,
): IrStatement | undefined {
  const condition = statement.condition;
  if (
    condition.kind !== 'binary' ||
    (condition.operator !== '&&' && condition.operator !== '||') ||
    condition.semantics.result !== 'boolean' ||
    hasIrExpressionAwait(condition.left)
  ) {
    return undefined;
  }
  const extracted = extractIrLeadingAwait(condition.right, valueBinding);
  if (!extracted) return undefined;
  const conditionBinding = createIrAwaitLogicalBinding(context.origin, context.nextBindingOrdinal++);
  const conditionValue: IrExpression = {
    kind: 'identifier',
    reference: { binding: conditionBinding, kind: 'binding' },
  };
  const gateCondition: IrExpression =
    condition.operator === '&&'
      ? conditionValue
      : {
          kind: 'unary',
          operand: conditionValue,
          operator: '!',
          postfix: false,
          semantics: {
            operand: { declared: 'boolean', flow: 'boolean' },
            result: 'boolean',
          },
        };
  return {
    kind: 'block',
    statements: [
      {
        declarations: [{ binding: conditionBinding, initializer: condition.left, mutable: true }],
        kind: 'variable',
      },
      {
        condition: gateCondition,
        consequent: {
          kind: 'block',
          statements: [
            {
              declarations: [{ binding: valueBinding, initializer: extracted.await, mutable: false }],
              kind: 'variable',
            },
            {
              expression: {
                kind: 'assignment',
                left: conditionValue,
                operator: '=',
                right: extracted.expression,
                semantics: {
                  left: { declared: 'boolean', flow: 'boolean' },
                  result: 'boolean',
                  right: { declared: 'boolean', flow: 'boolean' },
                },
              },
              kind: 'expression',
            },
          ],
        },
        kind: 'if',
      },
      { ...statement, condition: conditionValue },
    ],
  };
}

// An await at the leading evaluation position of these expression forms can be bound before the
// enclosing expression without reordering work or making a lazy arm eager. This covers the common
// `!(await task)`, `(await task) !== null`, `(await task) ? a : b`, and
// `new External(await task)` shapes while deliberately leaving right-hand logical operands and
// conditional arms to structured control-flow lowering.
function extractIrLeadingAwait(
  expression: Readonly<IrExpression>,
  binding: Readonly<IrBindingIdentity>,
): Readonly<{ await: Extract<IrExpression, { kind: 'await' }>; expression: IrExpression }> | undefined {
  if (expression.kind === 'await') {
    return {
      await: expression,
      expression: { kind: 'identifier', reference: { binding, kind: 'binding' } },
    };
  }
  if (expression.kind === 'unary') {
    const nested = extractIrLeadingAwait(expression.operand, binding);
    return nested ? { await: nested.await, expression: { ...expression, operand: nested.expression } } : undefined;
  }
  if (expression.kind === 'binary') {
    const nested = extractIrLeadingAwait(expression.left, binding);
    return nested ? { await: nested.await, expression: { ...expression, left: nested.expression } } : undefined;
  }
  if (expression.kind === 'conditional') {
    const nested = extractIrLeadingAwait(expression.condition, binding);
    return nested ? { await: nested.await, expression: { ...expression, condition: nested.expression } } : undefined;
  }
  if (expression.kind === 'cast') {
    const nested = extractIrLeadingAwait(expression.expression, binding);
    return nested ? { await: nested.await, expression: { ...expression, expression: nested.expression } } : undefined;
  }
  if (expression.kind === 'property') {
    const nested = extractIrLeadingAwait(expression.object, binding);
    return nested ? { await: nested.await, expression: { ...expression, object: nested.expression } } : undefined;
  }
  if (expression.kind === 'element') {
    const nested = extractIrLeadingAwait(expression.object, binding);
    return nested ? { await: nested.await, expression: { ...expression, object: nested.expression } } : undefined;
  }
  if (
    expression.kind === 'call' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding' &&
    expression.arguments[0]
  ) {
    const nested = extractIrLeadingAwait(expression.arguments[0], binding);
    return nested
      ? {
          await: nested.await,
          expression: { ...expression, arguments: [nested.expression, ...expression.arguments.slice(1)] },
        }
      : undefined;
  }
  if (
    expression.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'ambient' &&
    expression.arguments[0]
  ) {
    const nested = extractIrLeadingAwait(expression.arguments[0], binding);
    return nested
      ? {
          await: nested.await,
          expression: { ...expression, arguments: [nested.expression, ...expression.arguments.slice(1)] },
        }
      : undefined;
  }
  return undefined;
}

function lowerIrAwaitConditionalVariable(
  statement: Readonly<Extract<IrStatement, { kind: 'variable' }>>,
): readonly IrStatement[] | undefined {
  if (statement.declarations.length !== 1) return undefined;
  const variable = statement.declarations[0];
  if (
    !variable ||
    !('binding' in variable) ||
    variable.initializer?.kind !== 'conditional' ||
    !hasIrExpressionAwait(variable.initializer)
  ) {
    return undefined;
  }
  const initializer = variable.initializer;
  const target: IrExpression = {
    kind: 'identifier',
    reference: { binding: variable.binding, kind: 'binding' },
  };
  const assign = (right: IrExpression): IrStatement => ({
    expression: {
      kind: 'assignment',
      left: target,
      operator: '=',
      right,
      semantics: {
        left: { declared: 'unknown', flow: 'unknown' },
        result: 'unknown',
        right: { declared: 'unknown', flow: 'unknown' },
      },
    },
    kind: 'expression',
  });
  return [
    {
      declarations: [
        {
          binding: variable.binding,
          mutable: true,
          ...(variable.type ? { type: variable.type } : {}),
        },
      ],
      kind: 'variable',
    },
    {
      condition: initializer.condition,
      consequent: assign(initializer.whenTrue),
      kind: 'if',
      otherwise: assign(initializer.whenFalse),
    },
  ];
}

const compilerLoweringPassNameAwaitConditionHoisting = 'await-condition-hoisting';
