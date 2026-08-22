import type { IrExpression, IrStatementValueCallSemantics } from '../../compiler-types/src/index.js';

export function createIrStatementValueCallSemantics(): IrStatementValueCallSemantics {
  return Object.freeze({
    abruptCompletion: 'propagate',
    asyncContext: 'inherit',
    normalCompletion: 'final-return-value',
    thisBinding: 'lexical',
  });
}

export function isIrCallExpressionStatementValueCarrier(expression: Readonly<IrExpression>): boolean {
  if (expression.kind !== 'call' || !isIrStatementValueCallSemantics(expression.semantics.statementValue)) {
    return false;
  }
  if (Object.keys(expression.semantics).length !== 1) return false;
  if (
    expression.callee.kind !== 'function' ||
    expression.callee.async ||
    expression.callee.binding !== undefined ||
    expression.callee.expression !== undefined ||
    expression.callee.parameters.length > 0 ||
    expression.callee.thisMode !== 'lexical' ||
    expression.callee.typeParameters.length > 0 ||
    expression.arguments.length > 0 ||
    expression.optional ||
    expression.typeArguments.length > 0
  ) {
    return false;
  }
  const completion = expression.callee.body.at(-1);
  return completion?.kind === 'return' && completion.expression !== undefined;
}

export function isIrStatementValueCallSemantics(value: unknown): value is IrStatementValueCallSemantics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<IrStatementValueCallSemantics>;
  return (
    Object.keys(value).length === 4 &&
    candidate.abruptCompletion === 'propagate' &&
    candidate.asyncContext === 'inherit' &&
    candidate.normalCompletion === 'final-return-value' &&
    candidate.thisBinding === 'lexical'
  );
}
