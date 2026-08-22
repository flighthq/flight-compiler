import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
} from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerLoweringPass,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrStatement,
  IrSwitchCase,
} from '../../compiler-types/src/index.js';

// A `switch` whose body suspends has no state shape of its own: it is an N-way branch, and the state
// machine already models a two-way one. Rewriting it into equality tests over a bound subject reuses
// that shape instead of adding another.
//
// Only a switch that suspends is rewritten. A switch that does not is left alone, because emitting it
// as a switch is what keeps target output idiomatic.
export function createCompilerLoweringPassSwitchSuspension(): CompilerLoweringPass {
  return {
    idempotent: true,
    lowerIrModule: lowerIrModuleSwitchSuspension,
    name: compilerLoweringPassNameSwitchSuspension,
    runsAfter: ['switch-fallthrough'],
    verifyIrModule(module) {
      return hasIrModuleSwitchSuspensionResidual(module)
        ? { kind: 'invalid', reason: 'a suspending switch remains after branch normalization' }
        : { kind: 'valid' };
    },
  };
}

function createIrSwitchSubjectBinding(origin: NonNullable<Extract<IrStatement, { kind: 'switch' }>['origin']>) {
  const binding: IrBindingIdentity = {
    ...origin,
    id: `binding:${JSON.stringify([origin.packageName, origin.source, origin.line, origin.column, 'switch-subject'])}`,
    kind: 'variable',
    name: 'switchSubject',
    scope: 'block',
    space: 'value',
  };
  return binding;
}

function hasIrSwitchCasesAwait(cases: readonly Readonly<IrSwitchCase>[]): boolean {
  let found = false;
  const observer = {
    expression(candidate: Readonly<IrExpression>) {
      if (candidate.kind !== 'await') return undefined;
      found = true;
      return false;
    },
  };
  for (const clause of cases) {
    if (clause.expression) analyzeIrExpressionSubtreeTraversal(clause.expression, observer);
    clause.statements.forEach((statement) => analyzeIrStatementSubtreeTraversal(statement, observer));
  }
  return found;
}

function hasIrModuleSwitchSuspensionResidual(module: Readonly<IrModule>): boolean {
  let residual = false;
  analyzeIrModuleTraversal(module, {
    statement(statement) {
      if (statement.kind !== 'switch' || !isIrSwitchStatementSuspensionConvertible(statement)) return undefined;
      residual = true;
      return false;
    },
  });
  return residual;
}

// A case is convertible when control cannot leave it other than by its own trailing `break`, which
// the branch form does not need. Anything else keeps its switch and refuses downstream by name.
function isIrSwitchCaseSuspensionConvertible(clause: Readonly<IrSwitchCase>, last: boolean): boolean {
  const trailing = clause.statements.at(-1);
  if (trailing?.kind === 'break' && !trailing.target) return true;
  if (trailing?.kind === 'return' || trailing?.kind === 'throw') return true;
  return last && clause.statements.every((statement) => !hasIrStatementSwitchLocalBreak(statement));
}

function hasIrStatementSwitchLocalBreak(statement: Readonly<IrStatement>): boolean {
  if (statement.kind === 'break') return !statement.target;
  if (statement.kind === 'block') return statement.statements.some(hasIrStatementSwitchLocalBreak);
  if (statement.kind === 'if') {
    return (
      hasIrStatementSwitchLocalBreak(statement.consequent) ||
      (statement.otherwise ? hasIrStatementSwitchLocalBreak(statement.otherwise) : false)
    );
  }
  return false;
}

function isIrSwitchStatementSuspensionConvertible(statement: Readonly<Extract<IrStatement, { kind: 'switch' }>>) {
  if (statement.label || !statement.origin || !statement.subjectDomain) return false;
  if (statement.subjectDomain === 'unknown') return false;
  if (!hasIrSwitchCasesAwait(statement.cases)) return false;
  const defaults = statement.cases.filter((clause) => !clause.expression);
  if (defaults.length > 1) return false;
  const last = statement.cases.at(-1);
  if (defaults.length === 1 && last?.expression) return false;
  return statement.cases.every((clause, index) =>
    isIrSwitchCaseSuspensionConvertible(clause, index === statement.cases.length - 1),
  );
}

function lowerIrDeclarationSwitchSuspension(declaration: Readonly<IrDeclaration>): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
      return {
        ...declaration,
        ...(declaration.classConstructor
          ? {
              classConstructor: {
                ...declaration.classConstructor,
                body: declaration.classConstructor.body.map(lowerIrStatementSwitchSuspension),
              },
            }
          : {}),
        methods: declaration.methods.map((method) => ({
          ...method,
          body: method.body.map(lowerIrStatementSwitchSuspension),
        })),
      };
    case 'function':
      return { ...declaration, body: declaration.body.map(lowerIrStatementSwitchSuspension) };
    case 'enum':
    case 'interface':
    case 'typeAlias':
    case 'variable':
      return declaration;
  }
}

function lowerIrModuleSwitchSuspension(module: Readonly<IrModule>): IrModule {
  return { ...module, declarations: module.declarations.map(lowerIrDeclarationSwitchSuspension) };
}

function lowerIrStatementSwitchSuspension(statement: Readonly<IrStatement>): IrStatement {
  switch (statement.kind) {
    case 'block':
      return { ...statement, statements: statement.statements.map(lowerIrStatementSwitchSuspension) };
    case 'do':
    case 'for':
    case 'forIn':
    case 'forOf':
    case 'while':
      return { ...statement, body: lowerIrStatementSwitchSuspension(statement.body) };
    case 'if':
      return {
        ...statement,
        consequent: lowerIrStatementSwitchSuspension(statement.consequent),
        ...(statement.otherwise ? { otherwise: lowerIrStatementSwitchSuspension(statement.otherwise) } : {}),
      };
    case 'switch': {
      const lowered: Extract<IrStatement, { kind: 'switch' }> = {
        ...statement,
        cases: statement.cases.map((clause) => ({
          ...clause,
          statements: clause.statements.map(lowerIrStatementSwitchSuspension),
        })),
      };
      if (!isIrSwitchStatementSuspensionConvertible(lowered)) return lowered;
      return lowerIrSwitchStatementToBranches(lowered);
    }
    case 'try':
      return {
        ...statement,
        ...(statement.catchClause
          ? {
              catchClause: {
                ...statement.catchClause,
                body: lowerIrStatementSwitchSuspension(statement.catchClause.body),
              },
            }
          : {}),
        ...(statement.finallyBody ? { finallyBody: lowerIrStatementSwitchSuspension(statement.finallyBody) } : {}),
        tryBody: lowerIrStatementSwitchSuspension(statement.tryBody),
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

function lowerIrSwitchStatementToBranches(statement: Readonly<Extract<IrStatement, { kind: 'switch' }>>): IrStatement {
  const origin = statement.origin!;
  const domain = statement.subjectDomain!;
  const binding = createIrSwitchSubjectBinding(origin);
  const reference: IrExpression = { kind: 'identifier', reference: { binding, kind: 'binding' } };
  const body = (clause: Readonly<IrSwitchCase>): IrStatement => {
    const trailing = clause.statements.at(-1);
    const statements =
      trailing?.kind === 'break' && !trailing.target ? clause.statements.slice(0, -1) : clause.statements;
    return { kind: 'block', statements };
  };
  const otherwiseClause = statement.cases.find((clause) => !clause.expression);
  const tests = statement.cases.filter((clause) => clause.expression);
  const branch = tests.reduceRight<IrStatement | undefined>(
    (otherwise, clause) => ({
      condition: {
        kind: 'binary',
        left: reference,
        operator: '===',
        right: clause.expression!,
        semantics: {
          left: { declared: domain, flow: domain },
          result: 'boolean',
          right: { declared: domain, flow: domain },
        },
      },
      consequent: body(clause),
      kind: 'if',
      origin,
      ...(otherwise ? { otherwise } : {}),
    }),
    otherwiseClause ? body(otherwiseClause) : undefined,
  );
  return {
    kind: 'block',
    statements: [
      { declarations: [{ binding, initializer: statement.expression, mutable: false }], kind: 'variable' },
      ...(branch ? [branch] : []),
    ],
  };
}

const compilerLoweringPassNameSwitchSuspension = 'switch-suspension';
