import type { IrStatement, IrSwitchCase, IrSwitchCaseCompletion } from '../../compiler-types/src/index.js';

export function getIrSwitchCaseCompletion(switchCase: Readonly<IrSwitchCase>): IrSwitchCaseCompletion {
  const last = switchCase.statements.at(-1);
  const preceding = last ? switchCase.statements.slice(0, -1) : switchCase.statements;
  if (preceding.some(hasIrStatementSwitchTargetBreak)) {
    return {
      kind: 'unsupported',
      reason: 'switch-local break must be the final direct statement of its clause',
    };
  }
  if (last?.kind === 'break') return { kind: 'localBreak' };
  if (last && hasIrStatementSwitchTargetBreak(last)) {
    return {
      kind: 'unsupported',
      reason: 'switch-local break must be the final direct statement of its clause',
    };
  }
  return last?.kind === 'return' || last?.kind === 'throw' ? { kind: 'abrupt' } : { kind: 'fallthrough' };
}

function hasIrStatementSwitchTargetBreak(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'block':
      return statement.statements.some(hasIrStatementSwitchTargetBreak);
    case 'if':
      return (
        hasIrStatementSwitchTargetBreak(statement.consequent) ||
        (statement.otherwise ? hasIrStatementSwitchTargetBreak(statement.otherwise) : false)
      );
    case 'try':
      return (
        hasIrStatementSwitchTargetBreak(statement.tryBody) ||
        (statement.catchClause ? hasIrStatementSwitchTargetBreak(statement.catchClause.body) : false) ||
        (statement.finallyBody ? hasIrStatementSwitchTargetBreak(statement.finallyBody) : false)
      );
    case 'break':
      return true;
    case 'do':
    case 'for':
    case 'forIn':
    case 'forOf':
    case 'switch':
    case 'while':
      return false;
    case 'continue':
    case 'expression':
    case 'return':
    case 'throw':
    case 'variable':
      return false;
  }
}
