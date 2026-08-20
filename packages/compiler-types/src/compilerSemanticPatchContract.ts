import type { IrStatement } from './compilerExecutableIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerExportIdentity } from './compilerSourceIdentity.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type SemanticPatchTarget = CompilerExportIdentity;

export type PatchScope = { readonly kind: 'neutral' } | { readonly backend: string; readonly kind: 'backend' };

interface BasePatch {
  readonly expect: {
    readonly fingerprint: string;
    readonly kind: 'class' | 'enum' | 'function' | 'interface' | 'typeAlias' | 'variable';
  };
  readonly id: string;
  readonly reason: string;
  readonly scope: PatchScope;
  readonly target: SemanticPatchTarget;
}

export type SemanticPatch =
  | (BasePatch & { readonly operation: 'remove' })
  | (BasePatch & { readonly name: string; readonly operation: 'rename' })
  | (BasePatch & { readonly body: readonly IrStatement[]; readonly operation: 'replaceBody' })
  | (BasePatch & { readonly operation: 'replaceType'; readonly type: IrType });

export interface PatchAuditRecord {
  readonly fingerprint: string;
  readonly id: string;
  readonly operation: SemanticPatch['operation'];
  readonly reason: string;
  readonly scope: PatchScope;
  readonly target: SemanticPatchTarget;
}

export interface PatchAudit {
  readonly applied: readonly PatchAuditRecord[];
  readonly schema: 'flight-compiler-patch-audit/1';
  readonly summary: {
    readonly applied: number;
    readonly skipped: number;
  };
}

export interface AppliedSemanticPatches {
  readonly audit: PatchAudit;
  readonly modules: readonly IrModule[];
}

export type SemanticPatchFailureCode =
  | 'ambiguous-patch-target'
  | 'conflicting-patch-operation'
  | 'conflicting-patch-removal'
  | 'duplicate-patch-id'
  | 'incompatible-patch-operation'
  | 'patch-index-desynchronized'
  | 'patch-kind-mismatch'
  | 'stale-patch-fingerprint'
  | 'unmatched-patch-target';

export interface SemanticPatchFailure extends Error {
  readonly code: SemanticPatchFailureCode;
  readonly kind: 'semantic-patch';
  readonly patchIds: readonly string[];
  readonly subject: string;
}
