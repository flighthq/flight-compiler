import type { IrStatement } from './compilerExecutableIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerSourceFingerprint } from './compilerSourceFingerprint.js';
import type { CompilerExportIdentity } from './compilerSourceIdentity.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type SemanticPatchTarget = CompilerExportIdentity;

export type PatchScope = { readonly kind: 'neutral' } | { readonly backend: string; readonly kind: 'backend' };

interface BasePatch {
  readonly expect: {
    readonly fingerprint: CompilerSourceFingerprint;
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
  readonly fingerprint: CompilerSourceFingerprint;
  readonly id: string;
  readonly operation: SemanticPatch['operation'];
  readonly reason: string;
  readonly scope: PatchScope;
  readonly target: SemanticPatchTarget;
}

export type PatchAuditSkipReason = 'backend-mismatch';

export interface PatchAuditSkippedRecord extends PatchAuditRecord {
  readonly skipReason: PatchAuditSkipReason;
}

export interface PatchAudit {
  readonly applied: readonly PatchAuditRecord[];
  readonly backend: string;
  readonly schema: 'flight-compiler-patch-audit/2';
  readonly skipped: readonly PatchAuditSkippedRecord[];
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
  | 'invalid-patch-backend'
  | 'invalid-patch-expectation'
  | 'invalid-patch-id'
  | 'invalid-patch-operation'
  | 'invalid-patch-reason'
  | 'invalid-patch-scope'
  | 'invalid-patch-target'
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
