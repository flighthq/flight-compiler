import type {
  CompilerLoweringPass,
  CompilerSourceIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrObjectMember,
  IrParameter,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

interface CStyleForLoweringAnalysis {
  loweredStatements: number;
  sourceIdentity: Readonly<CompilerSourceIdentity>;
}

export function createCompilerLoweringPassCStyleFor(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule(module) {
      return lowerIrModuleCStyleFor(module).module;
    },
    name: compilerLoweringPassNameCStyleFor,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrModuleCStyleForStatement(module)
        ? { kind: 'invalid', reason: 'C-style for statement remains after normalization' }
        : { kind: 'valid' };
    },
  };
}

function hasIrDeclarationCStyleForStatement(declaration: Readonly<IrDeclaration>): boolean {
  switch (declaration.kind) {
    case 'class':
      return (
        declaration.fields.some((field) =>
          field.initializer ? hasIrExpressionCStyleForStatement(field.initializer) : false,
        ) ||
        (declaration.classConstructor
          ? declaration.classConstructor.parameters.some(hasIrParameterCStyleForStatement) ||
            declaration.classConstructor.body.some(hasIrStatementCStyleForStatement)
          : false) ||
        declaration.methods.some(
          (method) =>
            method.parameters.some(hasIrParameterCStyleForStatement) ||
            method.body.some(hasIrStatementCStyleForStatement),
        )
      );
    case 'function':
      return (
        declaration.parameters.some(hasIrParameterCStyleForStatement) ||
        declaration.overloads.some((overload) => overload.parameters.some(hasIrParameterCStyleForStatement)) ||
        declaration.body.some(hasIrStatementCStyleForStatement)
      );
    case 'variable':
      return declaration.initializer ? hasIrExpressionCStyleForStatement(declaration.initializer) : false;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return false;
  }
}

function hasIrExpressionCStyleForStatement(expression: Readonly<IrExpression>): boolean {
  switch (expression.kind) {
    case 'array':
      return expression.elements.some((element) => (element ? hasIrExpressionCStyleForStatement(element) : false));
    case 'assignment':
    case 'binary':
      return hasIrExpressionCStyleForStatement(expression.left) || hasIrExpressionCStyleForStatement(expression.right);
    case 'await':
    case 'spread':
      return hasIrExpressionCStyleForStatement(expression.expression);
    case 'call':
    case 'new':
      return (
        hasIrExpressionCStyleForStatement(expression.callee) ||
        expression.arguments.some(hasIrExpressionCStyleForStatement)
      );
    case 'cast':
      return hasIrExpressionCStyleForStatement(expression.expression);
    case 'conditional':
      return (
        hasIrExpressionCStyleForStatement(expression.condition) ||
        hasIrExpressionCStyleForStatement(expression.whenFalse) ||
        hasIrExpressionCStyleForStatement(expression.whenTrue)
      );
    case 'element':
      return (
        hasIrExpressionCStyleForStatement(expression.index) || hasIrExpressionCStyleForStatement(expression.object)
      );
    case 'function':
      return (
        expression.parameters.some(hasIrParameterCStyleForStatement) ||
        expression.body.some(hasIrStatementCStyleForStatement) ||
        (expression.expression ? hasIrExpressionCStyleForStatement(expression.expression) : false)
      );
    case 'object':
      return expression.members.some(hasIrObjectMemberCStyleForStatement);
    case 'property':
      return hasIrExpressionCStyleForStatement(expression.object);
    case 'template':
      return expression.parts.some((part) =>
        typeof part === 'string' ? false : hasIrExpressionCStyleForStatement(part),
      );
    case 'unary':
      return hasIrExpressionCStyleForStatement(expression.operand);
    case 'identifier':
    case 'literal':
    case 'regexp':
      return false;
  }
}

function hasIrModuleCStyleForStatement(module: Readonly<IrModule>): boolean {
  return (
    module.declarations.some(hasIrDeclarationCStyleForStatement) ||
    module.exports.some((item) =>
      item.kind === 'default' ? hasIrExpressionCStyleForStatement(item.expression) : false,
    )
  );
}

function hasIrObjectMemberCStyleForStatement(member: Readonly<IrObjectMember>): boolean {
  switch (member.kind) {
    case 'computedProperty':
      return hasIrExpressionCStyleForStatement(member.key) || hasIrExpressionCStyleForStatement(member.value);
    case 'property':
      return hasIrExpressionCStyleForStatement(member.value);
    case 'spread':
      return hasIrExpressionCStyleForStatement(member.expression);
  }
}

function hasIrParameterCStyleForStatement(parameter: Readonly<IrParameter>): boolean {
  return parameter.initializer ? hasIrExpressionCStyleForStatement(parameter.initializer) : false;
}

function hasIrStatementCStyleForStatement(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some(hasIrStatementCStyleForStatement);
    case 'do':
    case 'while':
      return hasIrStatementCStyleForStatement(statement.body) || hasIrExpressionCStyleForStatement(statement.condition);
    case 'expression':
    case 'throw':
      return hasIrExpressionCStyleForStatement(statement.expression);
    case 'for':
      return true;
    case 'forIn':
      return (
        hasIrVariableCStyleForStatement(statement.variable) ||
        hasIrExpressionCStyleForStatement(statement.object) ||
        hasIrStatementCStyleForStatement(statement.body)
      );
    case 'forOf':
      return (
        hasIrVariableCStyleForStatement(statement.variable) ||
        hasIrExpressionCStyleForStatement(statement.iterable) ||
        hasIrStatementCStyleForStatement(statement.body)
      );
    case 'if':
      return (
        hasIrExpressionCStyleForStatement(statement.condition) ||
        hasIrStatementCStyleForStatement(statement.consequent) ||
        (statement.otherwise ? hasIrStatementCStyleForStatement(statement.otherwise) : false)
      );
    case 'return':
      return statement.expression ? hasIrExpressionCStyleForStatement(statement.expression) : false;
    case 'switch':
      return (
        hasIrExpressionCStyleForStatement(statement.expression) ||
        statement.cases.some(
          (item) =>
            (item.expression ? hasIrExpressionCStyleForStatement(item.expression) : false) ||
            item.statements.some(hasIrStatementCStyleForStatement),
        )
      );
    case 'try':
      return (
        hasIrStatementCStyleForStatement(statement.tryBody) ||
        (statement.catchClause ? hasIrStatementCStyleForStatement(statement.catchClause.body) : false) ||
        (statement.finallyBody ? hasIrStatementCStyleForStatement(statement.finallyBody) : false)
      );
    case 'variable':
      return statement.declarations.some(hasIrVariableCStyleForStatement);
    case 'break':
    case 'continue':
      return false;
  }
}

function hasIrVariableCStyleForStatement(variable: Readonly<IrVariable>): boolean {
  return variable.initializer ? hasIrExpressionCStyleForStatement(variable.initializer) : false;
}

function lowerIrDeclaration(declaration: Readonly<IrDeclaration>, analysis: CStyleForLoweringAnalysis): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: declaration.classConstructor.body.map((statement) =>
                  lowerIrStatement(statement, analysis, undefined, false),
                ),
                parameters: declaration.classConstructor.parameters.map((parameter) =>
                  lowerIrParameter(parameter, analysis),
                ),
              },
            }
          : {}),
        fields: declaration.fields.map((field) => ({
          ...field,
          ...(field.initializer ? { initializer: lowerIrExpression(field.initializer, analysis) } : {}),
        })),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: method.body.map((statement) => lowerIrStatement(statement, analysis, undefined, false)),
          parameters: method.parameters.map((parameter) => lowerIrParameter(parameter, analysis)),
        })),
      };
    case 'function':
      return {
        ...declaration,
        body: declaration.body.map((statement) => lowerIrStatement(statement, analysis, undefined, false)),
        overloads: declaration.overloads.map((overload) => ({
          ...overload,
          parameters: overload.parameters.map((parameter) => lowerIrParameter(parameter, analysis)),
        })),
        parameters: declaration.parameters.map((parameter) => lowerIrParameter(parameter, analysis)),
      };
    case 'variable':
      return declaration.initializer
        ? { ...declaration, initializer: lowerIrExpression(declaration.initializer, analysis) }
        : declaration;
    case 'enum':
    case 'interface':
    case 'typeAlias':
      return declaration;
  }
}

function lowerIrExpression(expression: Readonly<IrExpression>, analysis: CStyleForLoweringAnalysis): IrExpression {
  switch (expression.kind) {
    case 'array':
      return {
        ...expression,
        elements: expression.elements.map((element) => (element ? lowerIrExpression(element, analysis) : undefined)),
      };
    case 'assignment':
    case 'binary':
      return {
        ...expression,
        left: lowerIrExpression(expression.left, analysis),
        right: lowerIrExpression(expression.right, analysis),
      };
    case 'await':
    case 'spread':
      return { ...expression, expression: lowerIrExpression(expression.expression, analysis) };
    case 'call':
      return {
        ...expression,
        arguments: expression.arguments.map((argument) => lowerIrExpression(argument, analysis)),
        callee: lowerIrExpression(expression.callee, analysis),
      };
    case 'cast':
      return { ...expression, expression: lowerIrExpression(expression.expression, analysis) };
    case 'conditional':
      return {
        ...expression,
        condition: lowerIrExpression(expression.condition, analysis),
        whenFalse: lowerIrExpression(expression.whenFalse, analysis),
        whenTrue: lowerIrExpression(expression.whenTrue, analysis),
      };
    case 'element':
      return {
        ...expression,
        index: lowerIrExpression(expression.index, analysis),
        object: lowerIrExpression(expression.object, analysis),
      };
    case 'function':
      return {
        ...expression,
        body: expression.body.map((statement) => lowerIrStatement(statement, analysis, undefined, false)),
        ...(expression.expression ? { expression: lowerIrExpression(expression.expression, analysis) } : {}),
        parameters: expression.parameters.map((parameter) => lowerIrParameter(parameter, analysis)),
      };
    case 'new':
      return {
        ...expression,
        arguments: expression.arguments.map((argument) => lowerIrExpression(argument, analysis)),
        callee: lowerIrExpression(expression.callee, analysis),
      };
    case 'object':
      return {
        ...expression,
        members: expression.members.map((member) => lowerIrObjectMember(member, analysis)),
      };
    case 'property':
      return { ...expression, object: lowerIrExpression(expression.object, analysis) };
    case 'template':
      return {
        ...expression,
        parts: expression.parts.map((part) => (typeof part === 'string' ? part : lowerIrExpression(part, analysis))),
      };
    case 'unary':
      return { ...expression, operand: lowerIrExpression(expression.operand, analysis) };
    case 'identifier':
    case 'literal':
    case 'regexp':
      return expression;
  }
}

function lowerIrModuleCStyleFor(module: Readonly<IrModule>): Readonly<{ loweredStatements: number; module: IrModule }> {
  const cloned = structuredClone(module);
  const analysis: CStyleForLoweringAnalysis = { loweredStatements: 0, sourceIdentity: module };
  const loweredModule: IrModule = {
    ...cloned,
    declarations: cloned.declarations.map((declaration) => lowerIrDeclaration(declaration, analysis)),
    exports: cloned.exports.map((item) =>
      item.kind === 'default' ? { ...item, expression: lowerIrExpression(item.expression, analysis) } : item,
    ),
  };
  return {
    loweredStatements: analysis.loweredStatements,
    module: loweredModule,
  };
}

function lowerIrObjectMember(member: Readonly<IrObjectMember>, analysis: CStyleForLoweringAnalysis): IrObjectMember {
  switch (member.kind) {
    case 'computedProperty':
      return {
        ...member,
        key: lowerIrExpression(member.key, analysis),
        value: lowerIrExpression(member.value, analysis),
      };
    case 'property':
      return { ...member, value: lowerIrExpression(member.value, analysis) };
    case 'spread':
      return { ...member, expression: lowerIrExpression(member.expression, analysis) };
  }
}

function lowerIrParameter(parameter: Readonly<IrParameter>, analysis: CStyleForLoweringAnalysis): IrParameter {
  return parameter.initializer
    ? { ...parameter, initializer: lowerIrExpression(parameter.initializer, analysis) }
    : parameter;
}

function lowerIrStatement(
  statement: Readonly<IrStatement>,
  analysis: CStyleForLoweringAnalysis,
  continueIncrement: Readonly<IrExpression> | undefined,
  crossesFinally: boolean,
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return {
        ...statement,
        statements: statement.statements.map((item) =>
          lowerIrStatement(item, analysis, continueIncrement, crossesFinally),
        ),
      };
    case 'continue':
      if (!continueIncrement) return statement;
      if (crossesFinally) {
        throw createCompilerLoweringFailure(
          'unsupported-ir',
          compilerLoweringPassNameCStyleFor,
          analysis.sourceIdentity,
          'continue across a finally block requires completion-record lowering',
        );
      }
      return {
        kind: 'block',
        statements: [{ expression: structuredClone(continueIncrement), kind: 'expression' }, { kind: 'continue' }],
      };
    case 'do':
    case 'while':
      return {
        ...statement,
        body: lowerIrStatement(statement.body, analysis, undefined, false),
        condition: lowerIrExpression(statement.condition, analysis),
      };
    case 'expression':
    case 'throw':
      return { ...statement, expression: lowerIrExpression(statement.expression, analysis) };
    case 'for':
      return lowerIrStatementCStyleFor(statement, analysis);
    case 'forIn':
      return {
        ...statement,
        body: lowerIrStatement(statement.body, analysis, undefined, false),
        object: lowerIrExpression(statement.object, analysis),
        variable: lowerIrVariable(statement.variable, analysis),
      };
    case 'forOf':
      return {
        ...statement,
        body: lowerIrStatement(statement.body, analysis, undefined, false),
        iterable: lowerIrExpression(statement.iterable, analysis),
        variable: lowerIrVariable(statement.variable, analysis),
      };
    case 'if':
      return {
        ...statement,
        condition: lowerIrExpression(statement.condition, analysis),
        consequent: lowerIrStatement(statement.consequent, analysis, continueIncrement, crossesFinally),
        ...(statement.otherwise
          ? { otherwise: lowerIrStatement(statement.otherwise, analysis, continueIncrement, crossesFinally) }
          : {}),
      };
    case 'return':
      return {
        ...statement,
        ...(statement.expression ? { expression: lowerIrExpression(statement.expression, analysis) } : {}),
      };
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((item) => ({
          ...item,
          ...(item.expression ? { expression: lowerIrExpression(item.expression, analysis) } : {}),
          statements: item.statements.map((caseStatement) =>
            lowerIrStatement(caseStatement, analysis, continueIncrement, crossesFinally),
          ),
        })),
        expression: lowerIrExpression(statement.expression, analysis),
      };
    case 'try': {
      const exitsThroughFinally = crossesFinally || statement.finallyBody !== undefined;
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatement(statement.catchClause.body, analysis, continueIncrement, exitsThroughFinally),
              },
            }
          : {}),
        ...(statement.finallyBody
          ? {
              finallyBody: lowerIrStatement(statement.finallyBody, analysis, continueIncrement, crossesFinally),
            }
          : {}),
        tryBody: lowerIrStatement(statement.tryBody, analysis, continueIncrement, exitsThroughFinally),
      };
    }
    case 'variable':
      return {
        ...statement,
        declarations: statement.declarations.map((declaration) => lowerIrVariable(declaration, analysis)),
      };
    case 'break':
      return statement;
  }
}

function lowerIrStatementCStyleFor(
  statement: Readonly<Extract<IrStatement, { kind: 'for' }>>,
  analysis: CStyleForLoweringAnalysis,
): IrStatement {
  analysis.loweredStatements += 1;
  const increment = statement.increment ? lowerIrDiscardedUpdateCStyleFor(statement.increment, analysis) : undefined;
  const initializer = statement.initializer;
  if (isIrVariableList(initializer) && initializer.length === 0) {
    throw createCompilerLoweringFailure(
      'malformed-ir',
      compilerLoweringPassNameCStyleFor,
      analysis.sourceIdentity,
      'C-style for variable initializer must contain at least one declaration',
    );
  }
  const initializerStatements: IrStatement[] = isIrVariableList(initializer)
    ? [{ declarations: initializer.map((variable) => lowerIrVariable(variable, analysis)), kind: 'variable' }]
    : initializer
      ? [{ expression: lowerIrExpression(initializer, analysis), kind: 'expression' }]
      : [];
  const body = lowerIrStatement(statement.body, analysis, increment, false);
  return {
    kind: 'block',
    statements: [
      ...initializerStatements,
      {
        body: {
          kind: 'block',
          statements: [
            body,
            ...(increment ? [{ expression: structuredClone(increment), kind: 'expression' } as const] : []),
          ],
        },
        condition: statement.condition
          ? lowerIrExpression(statement.condition, analysis)
          : { kind: 'literal', value: true },
        kind: 'while',
      },
    ],
  };
}

function lowerIrDiscardedUpdateCStyleFor(
  expression: Readonly<IrExpression>,
  analysis: CStyleForLoweringAnalysis,
): IrExpression {
  const lowered = lowerIrExpression(expression, analysis);
  if (
    lowered.kind !== 'unary' ||
    (lowered.operator !== '++' && lowered.operator !== '--') ||
    lowered.semantics.result !== 'number'
  ) {
    return lowered;
  }
  return {
    kind: 'assignment',
    left: lowered.operand,
    operator: lowered.operator === '++' ? '+=' : '-=',
    right: { kind: 'literal', value: 1 },
    semantics: {
      left: lowered.semantics.operand,
      result: lowered.semantics.result,
      right: { declared: 'number', flow: 'number' },
    },
  };
}

function lowerIrVariable(variable: Readonly<IrVariable>, analysis: CStyleForLoweringAnalysis): IrVariable {
  return variable.initializer
    ? { ...variable, initializer: lowerIrExpression(variable.initializer, analysis) }
    : variable;
}

function isIrVariableList(value: IrExpression | readonly IrVariable[] | undefined): value is readonly IrVariable[] {
  return Array.isArray(value);
}

const compilerLoweringPassNameCStyleFor = 'c-style-for';
