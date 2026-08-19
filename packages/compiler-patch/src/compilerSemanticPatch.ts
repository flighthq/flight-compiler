import type {
  AppliedSemanticPatches,
  IrDeclaration,
  IrModule,
  PatchAuditRecord,
  SemanticPatch,
  SemanticPatchFailure,
  SemanticPatchFailureCode,
} from '../../compiler-types/src/index.js';

export function applySemanticPatchSet(
  modules: readonly IrModule[],
  patches: readonly SemanticPatch[],
  backend: string,
): AppliedSemanticPatches {
  validateUniqueIds(patches);
  validateConflicts(patches);
  const output = structuredClone(modules) as IrModule[];
  const active = patches.filter(
    (patch) => patch.scope.kind === 'neutral' || (patch.scope.kind === 'backend' && patch.scope.backend === backend),
  );
  validateActiveRemovals(active);
  const applied: PatchAuditRecord[] = [];
  const declarationIndex = new Map<string, Array<{ declaration: IrDeclaration; module: IrModule }>>();
  for (const module of output) {
    for (const declaration of module.declarations) {
      const key = targetKey({
        exportName: declaration.name,
        packageName: declaration.origin.packageName,
        source: declaration.origin.source,
      });
      const indexed = declarationIndex.get(key) ?? [];
      indexed.push({ declaration, module });
      declarationIndex.set(key, indexed);
    }
  }

  for (const patch of [...active].sort(comparePatchPrecedence)) {
    const matches = declarationIndex.get(targetKey(patch.target)) ?? [];
    if (matches.length === 0) {
      throw createSemanticPatchError(
        'unmatched-patch-target',
        [patch.id],
        targetSubject(patch.target),
        `Unmatched semantic patch ${patch.id}`,
      );
    }
    if (matches.length > 1)
      throw createSemanticPatchError(
        'ambiguous-patch-target',
        [patch.id],
        targetSubject(patch.target),
        `Ambiguous semantic patch ${patch.id}: matched ${String(matches.length)} declarations`,
      );
    const { declaration, module } = matches[0]!;
    if (declaration.kind !== patch.expect.kind) {
      throw createSemanticPatchError(
        'patch-kind-mismatch',
        [patch.id],
        targetSubject(patch.target),
        `Semantic patch ${patch.id} expected ${patch.expect.kind}, received ${declaration.kind}`,
      );
    }
    if (declaration.origin.fingerprint !== patch.expect.fingerprint) {
      throw createSemanticPatchError(
        'stale-patch-fingerprint',
        [patch.id],
        targetSubject(patch.target),
        `Stale semantic patch ${patch.id}: expected ${patch.expect.fingerprint}, received ${declaration.origin.fingerprint}`,
      );
    }

    switch (patch.operation) {
      case 'remove':
        module.declarations.splice(module.declarations.indexOf(declaration), 1);
        break;
      case 'rename':
        declaration.name = patch.name;
        break;
      case 'replaceBody':
        if (declaration.kind !== 'function') {
          throw createSemanticPatchError(
            'incompatible-patch-operation',
            [patch.id],
            targetSubject(patch.target),
            `Semantic patch ${patch.id} requires a function`,
          );
        }
        declaration.body = structuredClone([...patch.body]);
        break;
      case 'replaceType':
        if (declaration.kind !== 'type') {
          throw createSemanticPatchError(
            'incompatible-patch-operation',
            [patch.id],
            targetSubject(patch.target),
            `Semantic patch ${patch.id} requires a type alias`,
          );
        }
        declaration.type = structuredClone(patch.type);
        break;
    }
    applied.push({
      fingerprint: declaration.origin.fingerprint,
      id: patch.id,
      operation: patch.operation,
      reason: patch.reason,
      scope: structuredClone(patch.scope),
      target: structuredClone(patch.target),
    });
  }

  return {
    audit: {
      applied,
      schema: 'flight-compiler-patch-audit/1',
      summary: { applied: applied.length, skipped: patches.length - active.length },
    },
    modules: output,
  };
}

function comparePatchPrecedence(left: Readonly<SemanticPatch>, right: Readonly<SemanticPatch>): number {
  const leftRank = left.scope.kind === 'neutral' ? 0 : 1;
  const rightRank = right.scope.kind === 'neutral' ? 0 : 1;
  return leftRank - rightRank || left.id.localeCompare(right.id);
}

function comparePatchIdentifiers(left: Readonly<SemanticPatch>, right: Readonly<SemanticPatch>): number {
  return left.id.localeCompare(right.id);
}

export function defineSemanticPatchSet<const Patches extends readonly SemanticPatch[]>(patches: Patches): Patches {
  return patches;
}

export function isSemanticPatchFailure(value: unknown): value is SemanticPatchFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'semantic-patch' &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(semanticPatchFailureCodes, value.code) &&
    'patchIds' in value &&
    Array.isArray(value.patchIds) &&
    value.patchIds.every((id) => typeof id === 'string') &&
    'subject' in value &&
    typeof value.subject === 'string'
  );
}

function createSemanticPatchError(
  code: SemanticPatchFailureCode,
  patchIds: readonly string[],
  subject: string,
  message: string,
): SemanticPatchFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'semantic-patch' as const,
    patchIds: [...patchIds].sort(),
    subject,
  });
  failure.name = 'SemanticPatchError';
  return failure;
}

function targetKey(target: Readonly<SemanticPatch['target']>): string {
  return JSON.stringify([target.packageName, target.source, target.exportName]);
}

function targetSubject(target: Readonly<SemanticPatch['target']>): string {
  return `${target.packageName}/${target.source}#${target.exportName}`;
}

function validateActiveRemovals(patches: readonly SemanticPatch[]): void {
  const byTarget = new Map<string, SemanticPatch[]>();
  for (const patch of [...patches].sort(comparePatchIdentifiers)) {
    const key = targetKey(patch.target);
    const targetPatches = byTarget.get(key) ?? [];
    targetPatches.push(patch);
    byTarget.set(key, targetPatches);
  }
  for (const targetPatches of byTarget.values()) {
    if (targetPatches.length > 1 && targetPatches.some((patch) => patch.operation === 'remove')) {
      throw createSemanticPatchError(
        'conflicting-patch-removal',
        targetPatches.map((patch) => patch.id),
        targetSubject(targetPatches[0]!.target),
        `Remove patch conflicts with another active patch: ${targetPatches.map((patch) => patch.id).join(', ')}`,
      );
    }
  }
}

function validateConflicts(patches: readonly SemanticPatch[]): void {
  const owners = new Map<string, string>();
  for (const patch of [...patches].sort(comparePatchIdentifiers)) {
    const scope = patch.scope.kind === 'neutral' ? 'neutral' : `backend:${patch.scope.backend}`;
    const key = JSON.stringify([
      scope,
      patch.target.packageName,
      patch.target.source,
      patch.target.exportName,
      patch.operation,
    ]);
    const owner = owners.get(key);
    if (owner) {
      throw createSemanticPatchError(
        'conflicting-patch-operation',
        [owner, patch.id],
        targetSubject(patch.target),
        `Conflicting semantic patches ${owner} and ${patch.id}`,
      );
    }
    owners.set(key, patch.id);
  }
}

function validateUniqueIds(patches: readonly SemanticPatch[]): void {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (ids.has(patch.id)) {
      throw createSemanticPatchError(
        'duplicate-patch-id',
        [patch.id],
        patch.id,
        `Duplicate semantic patch id ${patch.id}`,
      );
    }
    ids.add(patch.id);
  }
}

const semanticPatchFailureCodes = {
  'ambiguous-patch-target': true,
  'conflicting-patch-operation': true,
  'conflicting-patch-removal': true,
  'duplicate-patch-id': true,
  'incompatible-patch-operation': true,
  'patch-kind-mismatch': true,
  'stale-patch-fingerprint': true,
  'unmatched-patch-target': true,
} as const satisfies Readonly<Record<SemanticPatchFailureCode, true>>;
