import ts from 'typescript';

import type { IrForInKeyPlan } from '../../compiler-types/src/index.js';

export function getTypeScriptForInKeyEvidence(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  getPropertyName: (name: ts.PropertyName) => string,
): IrForInKeyPlan | undefined {
  const literal = getTypeScriptForInObjectLiteral(expression);
  if (!literal) {
    const closed = getTypeScriptForInClosedRecord(expression, checker, sourceFile, getPropertyName);
    const keys = closed && getTypeScriptForInObjectKeys(closed, getPropertyName);
    return keys
      ? { evaluation: 'alreadyEvaluated', keys: orderTypeScriptForInStaticObjectKeys(keys), kind: 'closedRecord' }
      : undefined;
  }
  const keys = getTypeScriptForInObjectKeys(literal, getPropertyName);
  if (!keys) return undefined;
  return {
    evaluation: literal.properties.every(
      (member) => ts.isPropertyAssignment(member) && isTypeScriptForInStaticObjectValue(member.initializer),
    )
      ? 'elide'
      : 'preserve',
    keys: orderTypeScriptForInStaticObjectKeys(keys),
    kind: 'objectLiteral',
  };
}

function getTypeScriptForInClosedRecord(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  getPropertyName: (name: ts.PropertyName) => string,
): ts.ObjectLiteralExpression | undefined {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return undefined;
  }
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0 || !declaration.initializer) {
    return undefined;
  }
  const literal = getTypeScriptForInObjectLiteral(declaration.initializer);
  if (!literal || !getTypeScriptForInObjectKeys(literal, getPropertyName)) return undefined;
  let closed = true;
  const visit = (node: ts.Node): void => {
    if (!closed) return;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol && node !== declaration.name) {
      const parent = node.parent;
      if (!ts.isForInStatement(parent) || parent.expression !== node) closed = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return closed ? literal : undefined;
}

function getTypeScriptForInObjectKeys(
  expression: ts.ObjectLiteralExpression,
  getPropertyName: (name: ts.PropertyName) => string,
): readonly string[] | undefined {
  const keys: string[] = [];
  for (const member of expression.properties) {
    if (!ts.isPropertyAssignment(member) || ts.isComputedPropertyName(member.name)) return undefined;
    const key = getPropertyName(member.name);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function getTypeScriptForInObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    expression = expression.expression;
  }
  return ts.isObjectLiteralExpression(expression) ? expression : undefined;
}

function isTypeScriptForInStaticObjectValue(expression: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(expression) ||
    ts.isStringLiteral(expression) ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.TrueKeyword
  );
}

function orderTypeScriptForInStaticObjectKeys(keys: readonly string[]): readonly string[] {
  const indices: Array<{ key: string; value: number }> = [];
  const names: string[] = [];
  for (const key of keys) {
    const value = Number(key);
    if (Number.isSafeInteger(value) && value >= 0 && value < 4_294_967_295 && String(value) === key) {
      indices.push({ key, value });
    } else {
      names.push(key);
    }
  }
  indices.sort((left, right) => left.value - right.value);
  return [...indices.map((index) => index.key), ...names];
}
