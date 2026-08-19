import { createHash } from 'node:crypto';

import ts from 'typescript';

const printer = ts.createPrinter({ removeComments: true });

export function fingerprintText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function fingerprintTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return fingerprintText(normalizeTypeScriptNode(node, sourceFile));
}

export function normalizeTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/gu, ' ').trim();
}
