import type { IrModule, IrStatement, IrType } from './ir.js';

export interface PatchTarget {
  export: string;
  package: string;
  source: string;
}

export type PatchScope = { kind: 'neutral' } | { backend: string; kind: 'backend' };

interface BasePatch {
  expect: {
    fingerprint: string;
    kind: 'class' | 'enum' | 'function' | 'interface' | 'type' | 'variable';
  };
  id: string;
  reason: string;
  scope: PatchScope;
  target: PatchTarget;
}

export type SemanticPatch =
  | (BasePatch & { operation: 'remove' })
  | (BasePatch & { name: string; operation: 'rename' })
  | (BasePatch & { body: IrStatement[]; operation: 'replaceBody' })
  | (BasePatch & { operation: 'replaceType'; type: IrType });

export interface PatchAuditRecord {
  fingerprint: string;
  id: string;
  operation: SemanticPatch['operation'];
  reason: string;
  scope: PatchScope;
  target: PatchTarget;
}

export interface PatchAudit {
  applied: PatchAuditRecord[];
  schema: 'flight-compiler-patch-audit/1';
  summary: {
    applied: number;
    skipped: number;
  };
}

export interface AppliedSemanticPatches {
  audit: PatchAudit;
  modules: IrModule[];
}
