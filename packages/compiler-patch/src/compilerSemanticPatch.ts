import type {
  AppliedSemanticPatches,
  IrDeclaration,
  IrModule,
  PatchAuditRecord,
  SemanticPatch,
  SemanticPatchFailure,
  SemanticPatchFailureCode,
} from '../../compiler-types/src/index.js';

interface IndexedDeclaration {
  declaration: IrDeclaration;
  readonly moduleIndex: number;
}

export function applySemanticPatchSet(
  modules: readonly IrModule[],
  patches: readonly SemanticPatch[],
  backend: string,
): AppliedSemanticPatches {
  validateUniqueIds(patches);
  validateConflicts(patches);
  let output: readonly IrModule[] = structuredClone(modules);
  const active = patches.filter(
    (patch) => patch.scope.kind === 'neutral' || (patch.scope.kind === 'backend' && patch.scope.backend === backend),
  );
  validateActiveRemovals(active);
  const applied: PatchAuditRecord[] = [];
  const declarationIndex = new Map<string, IndexedDeclaration[]>();
  for (const [moduleIndex, module] of output.entries()) {
    for (const declaration of module.declarations) {
      const key = targetKey({
        exportName: declarationSemanticName(declaration),
        packageName: declaration.origin.packageName,
        source: declaration.origin.source,
      });
      const indexed = declarationIndex.get(key) ?? [];
      indexed.push({ declaration, moduleIndex });
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
    const match = matches[0]!;
    const { declaration } = match;
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

    let updatedDeclaration: IrDeclaration | undefined;
    switch (patch.operation) {
      case 'remove':
        updatedDeclaration = undefined;
        break;
      case 'rename':
        updatedDeclaration = renameSemanticDeclaration(declaration, patch.name);
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
        updatedDeclaration = { ...declaration, body: structuredClone([...patch.body]) };
        break;
      case 'replaceType':
        if (declaration.kind !== 'typeAlias') {
          throw createSemanticPatchError(
            'incompatible-patch-operation',
            [patch.id],
            targetSubject(patch.target),
            `Semantic patch ${patch.id} requires a type alias`,
          );
        }
        updatedDeclaration = { ...declaration, type: structuredClone(patch.type) };
        break;
    }
    const module = output[match.moduleIndex]!;
    const declarationPosition = module.declarations.indexOf(declaration);
    if (declarationPosition < 0) {
      throw createSemanticPatchError(
        'patch-index-desynchronized',
        [patch.id],
        targetSubject(patch.target),
        `Semantic patch index lost declaration ${patch.id}`,
      );
    }
    const declarations = updatedDeclaration
      ? module.declarations.map((item, index) => (index === declarationPosition ? updatedDeclaration : item))
      : module.declarations.filter((_item, index) => index !== declarationPosition);
    output = output.map((item, index) => (index === match.moduleIndex ? { ...module, declarations } : item));
    if (updatedDeclaration) match.declaration = updatedDeclaration;
    else declarationIndex.delete(targetKey(patch.target));
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

function declarationSemanticName(declaration: Readonly<IrDeclaration>): string {
  return declaration.binding.name;
}

function renameSemanticDeclaration(declaration: Readonly<IrDeclaration>, name: string): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
    case 'enum':
    case 'function':
    case 'variable':
      return { ...declaration, binding: { ...declaration.binding, name } };
    case 'interface':
    case 'typeAlias':
      return { ...declaration, binding: { ...declaration.binding, name } };
  }
}

function comparePatchPrecedence(left: Readonly<SemanticPatch>, right: Readonly<SemanticPatch>): number {
  const leftRank = left.scope.kind === 'neutral' ? 0 : 1;
  const rightRank = right.scope.kind === 'neutral' ? 0 : 1;
  return leftRank - rightRank || compareText(left.id, right.id);
}

function comparePatchIdentifiers(left: Readonly<SemanticPatch>, right: Readonly<SemanticPatch>): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    patchIds: [...patchIds].sort(compareText),
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
  'patch-index-desynchronized': true,
  'patch-kind-mismatch': true,
  'stale-patch-fingerprint': true,
  'unmatched-patch-target': true,
} as const satisfies Readonly<Record<SemanticPatchFailureCode, true>>;
