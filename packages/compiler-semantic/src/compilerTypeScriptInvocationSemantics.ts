import ts from 'typescript';

import type { TypeScriptInvocationSignatureResolution } from '../../compiler-types/src/index.js';

export function getTypeScriptInvocationSignatureResolution(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): TypeScriptInvocationSignatureResolution | undefined {
  const resolved = checker.getResolvedSignature(node)?.declaration;
  if (!resolved) return undefined;
  if (ts.isFunctionDeclaration(resolved) && !resolved.body && resolved.name) {
    const symbol = checker.getSymbolAtLocation(resolved.name);
    const declarations = symbol?.declarations?.filter(ts.isFunctionDeclaration) ?? [];
    return getTypeScriptOverloadSignatureResolution(resolved, declarations);
  }
  if (ts.isMethodDeclaration(resolved) && !resolved.body) {
    const symbol = checker.getSymbolAtLocation(resolved.name);
    const declarations = symbol?.declarations?.filter(ts.isMethodDeclaration) ?? [];
    return getTypeScriptOverloadSignatureResolution(resolved, declarations);
  }
  if (
    ts.isConstructorDeclaration(resolved) &&
    !resolved.body &&
    (ts.isClassDeclaration(resolved.parent) || ts.isClassExpression(resolved.parent))
  ) {
    const declarations = resolved.parent.members.filter(ts.isConstructorDeclaration);
    return getTypeScriptOverloadSignatureResolution(resolved, declarations);
  }
  return { implementation: resolved, resolved };
}

function getTypeScriptOverloadSignatureResolution<
  Declaration extends ts.ConstructorDeclaration | ts.FunctionDeclaration | ts.MethodDeclaration,
>(resolved: Declaration, declarations: readonly Declaration[]): TypeScriptInvocationSignatureResolution {
  const implementation = declarations.find((declaration) => declaration.body !== undefined);
  if (!implementation) return { implementation: resolved, resolved };
  const overloadIndex = declarations.filter((declaration) => !declaration.body).indexOf(resolved);
  return overloadIndex < 0 ? { implementation: resolved, resolved } : { implementation, overloadIndex, resolved };
}
