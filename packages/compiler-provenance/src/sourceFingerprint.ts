import { createHash } from 'node:crypto';

import ts from 'typescript';

export function fingerprintSourceText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function fingerprintTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return fingerprintSourceText(normalizeTypeScriptNode(node, sourceFile));
}

export function normalizeTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return `flight-typescript-node/1;typescript=${ts.version}:${serializeTypeScriptNode(node, sourceFile)}`;
}

function serializeTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  const children = node.getChildren(sourceFile).filter((child) => child.kind !== ts.SyntaxKind.JSDocComment);
  if (children.length === 0) {
    const text = 'text' in node && typeof node.text === 'string' ? node.text : node.getText(sourceFile);
    return `${String(node.kind)}:${String(text.length)}:${text}`;
  }
  return `${String(node.kind)}[${children.map((child) => serializeTypeScriptNode(child, sourceFile)).join(',')}]`;
}
