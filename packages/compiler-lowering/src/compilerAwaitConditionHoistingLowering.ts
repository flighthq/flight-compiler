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
      if (statement.kind !== 'if' || !hasIrExpressionAwait(statement.condition)) return undefined;
      residual = true;
      return false;
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
                body: declaration.classConstructor.body.map(lowerIrStatementAwaitConditionHoisting),
              },
            }
          : {}),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: method.body.map(lowerIrStatementAwaitConditionHoisting),
        })),
      };
    case 'function':
      return { ...declaration, body: declaration.body.map(lowerIrStatementAwaitConditionHoisting) };
    case 'enum':
    case 'interface':
    case 'typeAlias':
    case 'variable':
      return declaration;
  }
}

function lowerIrStatementAwaitConditionHoisting(statement: Readonly<IrStatement>): IrStatement {
  switch (statement.kind) {
    case 'block':
      return { ...statement, statements: statement.statements.map(lowerIrStatementAwaitConditionHoisting) };
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
          statements: clause.statements.map(lowerIrStatementAwaitConditionHoisting),
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

const compilerLoweringPassNameAwaitConditionHoisting = 'await-condition-hoisting';
