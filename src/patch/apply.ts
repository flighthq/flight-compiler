import type { IrDeclaration, IrModule } from '../model/ir.ts';
import type { PatchAudit, PatchAuditRecord, SemanticPatch } from '../model/patch.ts';

export interface AppliedSemanticPatches {
  audit: PatchAudit;
  modules: IrModule[];
}

export function applySemanticPatches(
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
        export: declaration.name,
        package: declaration.origin.packageName,
        source: declaration.origin.source,
      });
      const indexed = declarationIndex.get(key) ?? [];
      indexed.push({ declaration, module });
      declarationIndex.set(key, indexed);
    }
  }

  for (const patch of [...active].sort(comparePatchPrecedence)) {
    const matches = declarationIndex.get(targetKey(patch.target)) ?? [];
    if (matches.length === 0) throw new Error(`Unmatched semantic patch ${patch.id}`);
    if (matches.length > 1)
      throw new Error(`Ambiguous semantic patch ${patch.id}: matched ${String(matches.length)} declarations`);
    const { declaration, module } = matches[0]!;
    if (declaration.kind !== patch.expect.kind) {
      throw new Error(`Semantic patch ${patch.id} expected ${patch.expect.kind}, received ${declaration.kind}`);
    }
    if (declaration.origin.fingerprint !== patch.expect.fingerprint) {
      throw new Error(
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
        if (declaration.kind !== 'function') throw new Error(`Semantic patch ${patch.id} requires a function`);
        declaration.body = structuredClone(patch.body);
        break;
      case 'replaceType':
        if (declaration.kind !== 'type') throw new Error(`Semantic patch ${patch.id} requires a type alias`);
        declaration.type = structuredClone(patch.type);
        break;
    }
    applied.push({
      fingerprint: declaration.origin.fingerprint,
      id: patch.id,
      operation: patch.operation,
      reason: patch.reason,
      scope: patch.scope,
      target: patch.target,
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

export function defineSemanticPatches<const Patches extends readonly SemanticPatch[]>(patches: Patches): Patches {
  return patches;
}

function targetKey(target: Readonly<SemanticPatch['target']>): string {
  return `${target.package}\0${target.source}\0${target.export}`;
}

function validateActiveRemovals(patches: readonly SemanticPatch[]): void {
  const byTarget = new Map<string, SemanticPatch[]>();
  for (const patch of patches) {
    const key = targetKey(patch.target);
    const targetPatches = byTarget.get(key) ?? [];
    targetPatches.push(patch);
    byTarget.set(key, targetPatches);
  }
  for (const targetPatches of byTarget.values()) {
    if (targetPatches.length > 1 && targetPatches.some((patch) => patch.operation === 'remove')) {
      throw new Error(
        `Remove patch conflicts with another active patch: ${targetPatches.map((patch) => patch.id).join(', ')}`,
      );
    }
  }
}

function validateConflicts(patches: readonly SemanticPatch[]): void {
  const owners = new Map<string, string>();
  for (const patch of patches) {
    const scope = patch.scope.kind === 'neutral' ? 'neutral' : `backend:${patch.scope.backend}`;
    const key = `${scope}\0${patch.target.package}\0${patch.target.source}\0${patch.target.export}\0${patch.operation}`;
    const owner = owners.get(key);
    if (owner) throw new Error(`Conflicting semantic patches ${owner} and ${patch.id}`);
    owners.set(key, patch.id);
  }
}

function validateUniqueIds(patches: readonly SemanticPatch[]): void {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (ids.has(patch.id)) throw new Error(`Duplicate semantic patch id ${patch.id}`);
    ids.add(patch.id);
  }
}
