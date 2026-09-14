import { getIrStatementListCompletionSet } from '../../compiler-completion/src/index.js';
import { analyzeIrModuleTraversal, analyzeIrStatementSubtreeTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  CompilerSourceOrigin,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';

// A suspending finally body cannot be duplicated between the normal and rejection arms of a task
// state machine: both copies would address the same source suspension. Where the protected region
// can only complete normally or throw, make those two routes explicit before task analysis:
//
//   try { A } catch (error) { saved = error; threw = true; }
//   await cleanup();
//   if (threw) throw saved;
//
// The boolean is separate from the saved value because JavaScript permits throwing null and
// undefined. Returns and escaping loop control still need a general completion carrier, so this pass
// leaves those shapes visible to its verifier rather than changing their order.
export function createCompilerLoweringPassFinallyAwaitHoisting(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: lowerIrModuleFinallyAwaitHoisting,
    name: compilerLoweringPassNameFinallyAwaitHoisting,
    runsAfter: [],
    verifyIrModule(module) {
      return hasIrModuleFinallyAwaitResidual(module)
        ? { kind: 'invalid', reason: 'an await expression remains inside a finally handler after hoisting' }
        : { kind: 'valid' };
    },
  };
}

interface FinallyAwaitHoistingContext {
  nextBindingOrdinal: number;
  readonly origin: Readonly<CompilerSourceOrigin>;
}

function hasIrModuleFinallyAwaitResidual(module: Readonly<IrModule>): boolean {
  let residual = false;
  analyzeIrModuleTraversal(module, {
    statement(statement) {
      if (statement.kind === 'try' && statement.finallyBody && hasIrStatementAwait(statement.finallyBody)) {
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
    expression(expression) {
      if (expression.kind !== 'await') return undefined;
      found = true;
      return false;
    },
  });
  return found;
}

function createIrFinallyBinding(
  context: FinallyAwaitHoistingContext,
  role: 'caught' | 'error' | 'threw',
): IrBindingIdentity {
  const ordinal = context.nextBindingOrdinal++;
  return {
    ...context.origin,
    id: `binding:${JSON.stringify([
      context.origin.packageName,
      context.origin.source,
      context.origin.line,
      context.origin.column,
      'finally-await',
      role,
      ordinal,
    ])}`,
    kind: role === 'caught' ? 'catch' : 'variable',
    name: role === 'caught' ? 'finallyCaught' : role === 'error' ? 'finallyError' : 'finallyThrew',
    scope: 'block',
    space: 'value',
  };
}

function lowerIrModuleFinallyAwaitHoisting(module: Readonly<IrModule>): IrModule {
  return {
    ...module,
    declarations: module.declarations.map(lowerIrDeclarationFinallyAwaitHoisting),
  };
}

function lowerIrDeclarationFinallyAwaitHoisting(declaration: Readonly<IrDeclaration>): IrDeclaration {
  const context: FinallyAwaitHoistingContext = { nextBindingOrdinal: 0, origin: declaration.origin };
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: declaration.classConstructor.body.map((statement) =>
                  lowerIrStatementFinallyAwaitHoisting(statement, context),
                ),
              },
            }
          : {}),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: method.body.map((statement) => lowerIrStatementFinallyAwaitHoisting(statement, context)),
        })),
      };
    case 'function':
      return {
        ...declaration,
        body: declaration.body.map((statement) => lowerIrStatementFinallyAwaitHoisting(statement, context)),
      };
    case 'enum':
    case 'interface':
    case 'typeAlias':
    case 'variable':
      return declaration;
  }
}

function lowerIrStatementFinallyAwaitHoisting(
  statement: Readonly<IrStatement>,
  context: FinallyAwaitHoistingContext,
): IrStatement {
  switch (statement.kind) {
    case 'block':
      return {
        ...statement,
        statements: statement.statements.map((child) => lowerIrStatementFinallyAwaitHoisting(child, context)),
      };
    case 'do':
    case 'while':
      return { ...statement, body: lowerIrStatementFinallyAwaitHoisting(statement.body, context) };
    case 'for':
      return {
        ...statement,
        body: lowerIrStatementFinallyAwaitHoisting(statement.body, context),
        ...(statement.initializer ? { initializer: statement.initializer } : {}),
      };
    case 'forIn':
    case 'forOf':
      return { ...statement, body: lowerIrStatementFinallyAwaitHoisting(statement.body, context) };
    case 'if':
      return {
        ...statement,
        consequent: lowerIrStatementFinallyAwaitHoisting(statement.consequent, context),
        ...(statement.otherwise
          ? { otherwise: lowerIrStatementFinallyAwaitHoisting(statement.otherwise, context) }
          : {}),
      };
    case 'switch':
      return {
        ...statement,
        cases: statement.cases.map((clause) => ({
          ...clause,
          statements: clause.statements.map((child) => lowerIrStatementFinallyAwaitHoisting(child, context)),
        })),
      };
    case 'try':
      return lowerIrTryStatementFinallyAwaitHoisting(statement, context);
    case 'break':
    case 'continue':
    case 'expression':
    case 'return':
    case 'throw':
    case 'variable':
      return statement;
  }
}

function lowerIrTryStatementFinallyAwaitHoisting(
  statement: Readonly<Extract<IrStatement, { kind: 'try' }>>,
  context: FinallyAwaitHoistingContext,
): IrStatement {
  const tryBody = lowerIrStatementFinallyAwaitHoisting(statement.tryBody, context);
  const catchClause = statement.catchClause
    ? {
        ...statement.catchClause,
        body: lowerIrStatementFinallyAwaitHoisting(statement.catchClause.body, context),
      }
    : undefined;
  const finallyBody = statement.finallyBody
    ? lowerIrStatementFinallyAwaitHoisting(statement.finallyBody, context)
    : undefined;
  const lowered = {
    ...statement,
    ...(catchClause ? { catchClause } : {}),
    ...(finallyBody ? { finallyBody } : {}),
    tryBody,
  };
  if (!finallyBody || !hasIrStatementAwait(finallyBody)) return lowered;

  const protectedStatement: IrStatement = catchClause ? { catchClause, kind: 'try', tryBody } : tryBody;
  if (
    getIrStatementListCompletionSet([protectedStatement]).completions.some(
      (completion) => completion.kind !== 'normal' && completion.kind !== 'throw',
    )
  ) {
    return lowered;
  }

  const threw = createIrFinallyBinding(context, 'threw');
  const error = createIrFinallyBinding(context, 'error');
  const caught = createIrFinallyBinding(context, 'caught');
  const reference = (binding: Readonly<IrBindingIdentity>): IrExpression => ({
    kind: 'identifier',
    reference: { binding, kind: 'binding' },
  });
  const assign = (
    left: Readonly<IrBindingIdentity>,
    right: IrExpression,
    domain: 'boolean' | 'unknown',
  ): IrStatement => ({
    expression: {
      kind: 'assignment',
      left: reference(left),
      operator: '=',
      right,
      semantics: {
        left: { declared: domain, flow: domain },
        result: domain,
        right: { declared: domain, flow: domain },
      },
    },
    kind: 'expression',
  });
  return {
    kind: 'block',
    statements: [
      {
        declarations: [{ binding: threw, initializer: { kind: 'literal', value: false }, mutable: true }],
        kind: 'variable',
      },
      {
        declarations: [
          {
            binding: error,
            initializer: { kind: 'literal', value: null },
            mutable: true,
            type: { kind: 'unknown', source: 'unknown' },
          },
        ],
        kind: 'variable',
      },
      {
        catchClause: {
          binding: caught,
          body: {
            kind: 'block',
            statements: [
              assign(error, reference(caught), 'unknown'),
              assign(threw, { kind: 'literal', value: true }, 'boolean'),
            ],
          },
          semantics: {
            bindingInitialization: { kind: 'initialize', source: 'thrown-value', timing: 'before-body' },
            bodyExecution: 'once-per-caught-throw',
            catchCompletion: 'propagate',
            interceptedCompletion: 'throw',
            schema: 'flight-compiler-catch-semantics/1',
            uncaughtCompletion: 'preserve',
          },
        },
        kind: 'try',
        tryBody: protectedStatement,
      },
      finallyBody,
      {
        condition: reference(threw),
        consequent: { expression: reference(error), kind: 'throw' },
        kind: 'if',
        origin: context.origin,
      },
    ],
  };
}

const compilerLoweringPassNameFinallyAwaitHoisting = 'finally-await-hoisting';
