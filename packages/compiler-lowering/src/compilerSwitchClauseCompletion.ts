import type { IrStatement, IrSwitchCase, IrSwitchCaseCompletion } from '../../compiler-types/src/index.js';

export function getIrSwitchCaseCompletion(
  switchCase: Readonly<IrSwitchCase>,
  switchLabel?: string,
): IrSwitchCaseCompletion {
  const last = switchCase.statements.at(-1);
  const preceding = last ? switchCase.statements.slice(0, -1) : switchCase.statements;
  if (preceding.some((statement) => hasIrStatementSwitchTargetBreak(statement, switchLabel))) {
    return {
      kind: 'unsupported',
      reason: 'switch-local break must be the final direct statement of its clause',
    };
  }
  if (last?.kind === 'break') {
    return !last.target || last.target.id === switchLabel ? { kind: 'localBreak' } : { kind: 'abrupt' };
  }
  if (last && hasIrStatementAbruptCompletion(last)) return { kind: 'abrupt' };
  if (last && hasIrStatementSwitchTargetBreak(last, switchLabel)) {
    return {
      kind: 'unsupported',
      reason: 'switch-local break must be the final direct statement of its clause',
    };
  }
  return { kind: 'fallthrough' };
}

function hasIrStatementAbruptCompletion(statement: Readonly<IrStatement>): boolean {
  if (statement.kind === 'continue' || statement.kind === 'return' || statement.kind === 'throw') return true;
  if (statement.kind !== 'block') return false;
  const last = statement.statements.at(-1);
  return last ? hasIrStatementAbruptCompletion(last) : false;
}

function hasIrStatementSwitchTargetBreak(statement: Readonly<IrStatement>, switchLabel?: string): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some((child) => hasIrStatementSwitchTargetBreak(child, switchLabel));
    case 'if':
      return (
        hasIrStatementSwitchTargetBreak(statement.consequent, switchLabel) ||
        (statement.otherwise ? hasIrStatementSwitchTargetBreak(statement.otherwise, switchLabel) : false)
      );
    case 'try':
      return (
        hasIrStatementSwitchTargetBreak(statement.tryBody, switchLabel) ||
        (statement.catchClause ? hasIrStatementSwitchTargetBreak(statement.catchClause.body, switchLabel) : false) ||
        (statement.finallyBody ? hasIrStatementSwitchTargetBreak(statement.finallyBody, switchLabel) : false)
      );
    case 'break':
      return statement.target ? statement.target.id === switchLabel : true;
    case 'do':
    case 'for':
    case 'forIn':
    case 'forOf':
    case 'while':
      return switchLabel ? hasIrStatementSwitchTargetBreak(statement.body, switchLabel) : false;
    case 'switch':
      return switchLabel
        ? statement.cases.some((switchCase) =>
            switchCase.statements.some((child) => hasIrStatementSwitchTargetBreak(child, switchLabel)),
          )
        : false;
    case 'continue':
    case 'expression':
    case 'return':
    case 'throw':
    case 'variable':
      return false;
  }
}
