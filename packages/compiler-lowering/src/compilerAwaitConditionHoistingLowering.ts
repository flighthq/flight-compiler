import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
} from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrStatement,
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

function hasIrExpressionAwait(expression: Readonly<IrExpression>): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
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
  };
}

function lowerIrDeclarationAwaitConditionHoisting(declaration: Readonly<IrDeclaration>): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: lowerIrStatementListAwaitConditionHoisting(declaration.classConstructor.body),
              },
            }
          : {}),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: lowerIrStatementListAwaitConditionHoisting(method.body),
        })),
      };
    case 'function':
      return { ...declaration, body: lowerIrStatementListAwaitConditionHoisting(declaration.body) };
    case 'enum':
    case 'interface':
    case 'typeAlias':
    case 'variable':
      return declaration;
  }
}

function lowerIrStatementListAwaitConditionHoisting(statements: readonly IrStatement[]): IrStatement[] {
  return statements.flatMap((statement) => {
    if (statement.kind === 'variable') {
      const conditional = lowerIrAwaitConditionalVariable(statement);
      if (conditional) return conditional;
    }
    return [lowerIrStatementAwaitConditionHoisting(statement)];
  });
}

function lowerIrStatementAwaitConditionHoisting(statement: Readonly<IrStatement>): IrStatement {
  switch (statement.kind) {
    case 'block':
      return { ...statement, statements: lowerIrStatementListAwaitConditionHoisting(statement.statements) };
    case 'do':
    case 'while':
      return { ...statement, body: lowerIrStatementAwaitConditionHoisting(statement.body) };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementAwaitConditionHoisting(statement.body),
        ...(statement.initializer ? { initializer: statement.initializer } : {}),
      };
    case 'forIn':
    case 'forOf':
      return { ...statement, body: lowerIrStatementAwaitConditionHoisting(statement.body) };
    case 'if': {
      const lowered: Extract<IrStatement, { kind: 'if' }> = {
        ...statement,
        consequent: lowerIrStatementAwaitConditionHoisting(statement.consequent),
        ...(statement.otherwise ? { otherwise: lowerIrStatementAwaitConditionHoisting(statement.otherwise) } : {}),
      };
      if (!statement.origin || !hasIrExpressionAwait(statement.condition)) return lowered;
      const binding = createIrAwaitConditionBinding(statement.origin);
      return {
        kind: 'block',
        statements: [
          {
            declarations: [{ binding, initializer: lowered.condition, mutable: false }],
            kind: 'variable',
          },
          { ...lowered, condition: { kind: 'identifier', reference: { binding, kind: 'binding' } } },
        ],
      };
    }
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((clause) => ({
          ...clause,
          statements: lowerIrStatementListAwaitConditionHoisting(clause.statements),
        })),
      };
    case 'try':
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatementAwaitConditionHoisting(statement.catchClause.body),
              },
            }
          : {}),
        ...(statement.finallyBody
          ? { finallyBody: lowerIrStatementAwaitConditionHoisting(statement.finallyBody) }
          : {}),
        tryBody: lowerIrStatementAwaitConditionHoisting(statement.tryBody),
      };
    case 'break':
    case 'continue':
    case 'expression':
    case 'return':
    case 'throw':
    case 'variable':
      return statement;
  }
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
