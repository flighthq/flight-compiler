import ts from 'typescript';

export function createTypeScriptSyntacticAliasSubstitutions(
  reference: ts.TypeReferenceNode,
  declaration: ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): ReadonlyMap<ts.Symbol, ts.TypeNode> | undefined {
  return createTypeScriptSyntacticDeclarationSubstitutions(reference, declaration, checker, substitutions);
}

export function createTypeScriptSyntacticDeclarationSubstitutions(
  reference: Readonly<{ typeArguments?: readonly ts.TypeNode[] | undefined }>,
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): ReadonlyMap<ts.Symbol, ts.TypeNode> | undefined {
  const parameters = declaration.typeParameters ?? [];
  const arguments_ = reference.typeArguments ?? [];
  if (arguments_.length > parameters.length) return undefined;
  const next = new Map(substitutions);
  for (const [index, parameter] of parameters.entries()) {
    const argument = arguments_[index] ?? parameter.default;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!argument || !symbol) return undefined;
    next.set(symbol, getTypeScriptSyntacticTypeSubstitution(argument, checker, next));
  }
  return next;
}

export function getTypeScriptSyntacticExpressionTypeEvidence(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  return getTypeScriptSyntacticExpressionTypeEvidenceAt(expression, checker, new Set());
}

// The analysis checker runs with `noLib` and `noResolve`, so a library type such as `Promise<T>`
// never resolves and the checker reports its awaited type as unknown. The type argument is right
// there in the source, though, which is what this evidence reads.
function getTypeScriptSyntacticAwaitedTypeEvidence(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!type || !ts.isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return undefined;
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
  return name === 'Promise' || name === 'PromiseLike' ? type.typeArguments[0] : undefined;
}

function getTypeScriptSyntacticExpressionTypeEvidenceAt(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): ts.TypeNode | undefined {
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isAwaitExpression(expression)) {
    return getTypeScriptSyntacticAwaitedTypeEvidence(
      getTypeScriptSyntacticExpressionTypeEvidenceAt(expression.expression, checker, seen),
    );
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return getTypeScriptSyntacticExpressionTypeEvidenceAt(expression.expression, checker, seen);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return expression.type;
  if (ts.isCallExpression(expression)) {
    const type = checker.getResolvedSignature(expression)?.declaration?.type;
    return type && ts.isTypeNode(type) ? type : undefined;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;
  if (
    ts.isParameter(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isVariableDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration)
  ) {
    // An inferred `const` has no annotation of its own, so its evidence is whatever its initializer
    // proves. The seen set is what keeps `const value = value` from recurring forever.
    if (!declaration.type && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return getTypeScriptSyntacticExpressionTypeEvidenceAt(declaration.initializer, checker, seen);
    }
    return declaration.type;
  }
  return undefined;
}

export function getTypeScriptSyntacticTypeSubstitution(
  type: ts.TypeNode,
  checker: ts.TypeChecker,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): ts.TypeNode {
  if (!ts.isTypeReferenceNode(type) || type.typeArguments?.length) return type;
  const symbol = checker.getSymbolAtLocation(type.typeName);
  return (symbol && substitutions.get(symbol)) ?? type;
}
