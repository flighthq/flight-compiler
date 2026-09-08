import { analyzeIrModuleTraversal, analyzeIrStatementSubtreeTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';

// C++ prohibits `co_await` inside a catch handler. This pass hoists the catch body out:
//
//   try { … } catch (…) { <body with await> }
//
// becomes:
//
//   { bool __caught = false;
//     try { … } catch (…) { __caught = true; }
//     if (__caught) { <body> } }
export function createCompilerLoweringPassCatchAwaitHoisting(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: lowerIrModuleCatchAwaitHoisting,
    name: compilerLoweringPassNameCatchAwaitHoisting,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrModuleCatchAwaitResidual(module)
        ? { kind: 'invalid', reason: 'an await expression remains inside a catch handler after hoisting' }
        : { kind: 'valid' };
    },
  };
}

function hasIrModuleCatchAwaitResidual(module: Readonly<IrModule>): boolean {
  let residual = false;
  analyzeIrModuleTraversal(module, {
    statement(statement) {
      if (statement.kind !== 'try' || !statement.catchClause) return undefined;
      if (hasIrStatementAwait(statement.catchClause.body)) {
        residual = true;
        return false;
      }
      return undefined;
    },
  });
  return residual;
}

function hasIrStatementAwait(statement: Readonly<IrStatement>): boolean {
  let found = false;
  analyzeIrStatementSubtreeTraversal(statement, {
    expression(candidate: Readonly<IrExpression>) {
      if (candidate.kind !== 'await') return undefined;
      found = true;
      return false;
    },
  });
  return found;
}

function createIrCatchFlagBinding(
  origin: Readonly<IrDeclaration>['origin'],
  counter: { value: number },
): IrBindingIdentity {
  const index = counter.value++;
  return {
    ...origin,
    id: `binding:${JSON.stringify([origin.packageName, origin.source, origin.line, origin.column, 'catch-flag', index])}`,
    kind: 'variable',
    name: 'caught',
    scope: 'block',
    space: 'value',
  };
}

function lowerIrModuleCatchAwaitHoisting(module: Readonly<IrModule>): IrModule {
  return {
    ...module,
    declarations: module.declarations.map(lowerIrDeclarationCatchAwaitHoisting),
  };
}

function lowerIrDeclarationCatchAwaitHoisting(declaration: Readonly<IrDeclaration>): IrDeclaration {
  const origin = declaration.origin;
  const counter = { value: 0 };
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: declaration.classConstructor.body.map((s) =>
                  lowerIrStatementCatchAwaitHoisting(s, origin, counter),
                ),
              },
            }
          : {}),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: method.body.map((s) => lowerIrStatementCatchAwaitHoisting(s, origin, counter)),
        })),
      };
    case 'function':
      return {
        ...declaration,
        body: declaration.body.map((s) => lowerIrStatementCatchAwaitHoisting(s, origin, counter)),
      };
    case 'enum':
    case 'interface':
    case 'typeAlias':
    case 'variable':
      return declaration;
  }
}

function lowerIrStatementCatchAwaitHoisting(
  statement: Readonly<IrStatement>,
  origin: Readonly<IrDeclaration>['origin'],
  counter: { value: number },
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return {
        ...statement,
        statements: statement.statements.map((s) => lowerIrStatementCatchAwaitHoisting(s, origin, counter)),
      };
    case 'do':
    case 'while':
      return { ...statement, body: lowerIrStatementCatchAwaitHoisting(statement.body, origin, counter) };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementCatchAwaitHoisting(statement.body, origin, counter),
        ...(statement.initializer ? { initializer: statement.initializer } : {}),
      };
    case 'forIn':
    case 'forOf':
      return { ...statement, body: lowerIrStatementCatchAwaitHoisting(statement.body, origin, counter) };
    case 'if':
      return {
        ...statement,
        consequent: lowerIrStatementCatchAwaitHoisting(statement.consequent, origin, counter),
        ...(statement.otherwise
          ? { otherwise: lowerIrStatementCatchAwaitHoisting(statement.otherwise, origin, counter) }
          : {}),
      };
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((clause) => ({
          ...clause,
          statements: clause.statements.map((s) => lowerIrStatementCatchAwaitHoisting(s, origin, counter)),
        })),
      };
    case 'try': {
      const loweredTryBody = lowerIrStatementCatchAwaitHoisting(statement.tryBody, origin, counter);
      const loweredFinally = statement.finallyBody
        ? lowerIrStatementCatchAwaitHoisting(statement.finallyBody, origin, counter)
        : undefined;
      if (!statement.catchClause || !hasIrStatementAwait(statement.catchClause.body)) {
        return {
          ...statement,
          tryBody: loweredTryBody,
          ...(statement.catchClause
            ? {
                catchClause: {
                  ...statement.catchClause,
                  body: lowerIrStatementCatchAwaitHoisting(statement.catchClause.body, origin, counter),
                },
              }
            : {}),
          ...(loweredFinally ? { finallyBody: loweredFinally } : {}),
        };
      }

      const catchBody = lowerIrStatementCatchAwaitHoisting(statement.catchClause.body, origin, counter);
      const flagBinding = createIrCatchFlagBinding(origin, counter);
      const flagVariable: IrStatement = {
        declarations: [
          {
            binding: flagBinding,
            initializer: { kind: 'literal', value: false },
            mutable: true,
          },
        ],
        kind: 'variable',
      };
      const tryCatchWithFlag: IrStatement = {
        catchClause: {
          ...statement.catchClause,
          body: {
            kind: 'block',
            statements: [
              {
                expression: {
                  kind: 'assignment',
                  left: { kind: 'identifier', reference: { binding: flagBinding, kind: 'binding' } },
                  operator: '=',
                  right: { kind: 'literal', value: true },
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
        },
        kind: 'try',
        tryBody: loweredTryBody,
      };
      const ifCaught: IrStatement = {
        condition: { kind: 'identifier', reference: { binding: flagBinding, kind: 'binding' } },
        consequent: catchBody,
        kind: 'if',
        origin,
      };
      const statements: IrStatement[] = [flagVariable, tryCatchWithFlag, ifCaught];
      if (loweredFinally) {
        return {
          kind: 'block',
          statements: [
            {
              finallyBody: loweredFinally,
              kind: 'try',
              tryBody: { kind: 'block', statements },
            },
          ],
        };
      }
      return { kind: 'block', statements };
    }
    case 'break':
    case 'continue':
    case 'expression':
    case 'return':
    case 'throw':
    case 'variable':
      return statement;
  }
}

const compilerLoweringPassNameCatchAwaitHoisting = 'catch-await-hoisting';
