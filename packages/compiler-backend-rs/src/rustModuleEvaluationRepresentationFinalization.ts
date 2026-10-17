import { normalizeCompilerStructuralValueCanonical } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerBackendPackageGraphFinalization,
  CompilerModuleIdentity,
  CompilerRustModuleConstantPlan,
  CompilerRustModuleEvaluationRepresentationPlan,
  CompilerRustModuleEvaluationRepresentationPlanningFailure,
  CompilerRustModuleEvaluationRepresentationRefusal,
  CompilerRustModuleStatePlan,
  CompilerRustReferenceRepresentationPlan,
  CompilerRustSourceTreePlan,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerRustModuleEvaluationRepresentationPlan } from './rustModuleEvaluationRepresentationPlan.js';

interface RustModuleEvaluationRepresentationFinalizationInput {
  readonly constantPlan: Readonly<CompilerRustModuleConstantPlan>;
  readonly finalization: Readonly<CompilerBackendPackageGraphFinalization>;
  readonly modules: readonly Readonly<IrModule>[];
  readonly referencePlan: Readonly<CompilerRustReferenceRepresentationPlan>;
  readonly sourceTree: Readonly<CompilerRustSourceTreePlan>;
  readonly statePlan: Readonly<CompilerRustModuleStatePlan>;
}

type RustModuleEvaluationRepresentationFinalizationProjection =
  | Readonly<{
      readonly kind: 'plan';
      readonly plan: Readonly<CompilerRustModuleEvaluationRepresentationPlan>;
    }>
  | Readonly<{
      readonly kind: 'output-scope-incomplete';
      readonly refusal: Readonly<CompilerRustModuleEvaluationRepresentationRefusal>;
      readonly subjects: readonly string[];
    }>;

interface RustModuleEvaluationRepresentationFinalizationState {
  readonly projection: RustModuleEvaluationRepresentationFinalizationProjection;
  readonly seal: string;
}

/**
 * Finalizes one session-owned representation projection after the canonical source tree exists. The first
 * projection is retained by identity; repeats prove the same final provenance without reconstructing target
 * evidence or rerunning the representation planner.
 */
export function createCompilerRustModuleEvaluationRepresentationFinalizationState(
  cached: Readonly<RustModuleEvaluationRepresentationFinalizationState> | undefined,
  input: Readonly<RustModuleEvaluationRepresentationFinalizationInput>,
): Readonly<RustModuleEvaluationRepresentationFinalizationState> {
  const seal = createRustModuleEvaluationRepresentationFinalizationSeal(input);
  if (cached) {
    if (cached.seal !== seal) throw createRustModuleEvaluationRepresentationFinalizationMismatch();
    return cached;
  }

  const incompleteSubjects = collectRustModuleEvaluationRepresentationIncompleteSubjects(input);
  const projection: RustModuleEvaluationRepresentationFinalizationProjection =
    incompleteSubjects.length === 0
      ? Object.freeze({
          kind: 'plan' as const,
          plan: createCompilerRustModuleEvaluationRepresentationPlan({
            constantPlan: input.constantPlan,
            finalization: input.finalization,
            modules: selectRustModuleEvaluationRepresentationModules(input),
            referencePlan: input.referencePlan,
            sourceTree: input.sourceTree,
            statePlan: input.statePlan,
          }),
        })
      : cloneAndFreezeRustModuleEvaluationRepresentationFinalizationValue({
          kind: 'output-scope-incomplete' as const,
          refusal: {
            code: 'rust-module-evaluation-output-scope-incomplete' as const,
            message:
              'Rust module evaluation requires one complete retained output closure; omitted, refused, or placeholder output makes the scope incomplete',
            subject: 'full-output',
          },
          subjects: incompleteSubjects,
        });
  return Object.freeze({ projection, seal });
}

function collectRustModuleEvaluationRepresentationIncompleteSubjects(
  input: Readonly<RustModuleEvaluationRepresentationFinalizationInput>,
): readonly string[] {
  const retainedCounts = new Map<string, number>();
  for (const retained of input.finalization.moduleFiles) {
    const key = getRustModuleEvaluationRepresentationIdentityKey(retained.module);
    retainedCounts.set(key, (retainedCounts.get(key) ?? 0) + 1);
  }
  const incomplete = new Set<string>();
  for (const modulePlan of input.finalization.moduleEvaluation.modules) {
    const key = getRustModuleEvaluationRepresentationIdentityKey(modulePlan.module);
    if ((retainedCounts.get(key) ?? 0) === 0) incomplete.add(key);
  }
  for (const refusal of input.finalization.refusals ?? []) {
    incomplete.add(getRustModuleEvaluationRepresentationIdentityKey(refusal.module));
  }
  for (const module of input.finalization.placeholderModules ?? []) {
    incomplete.add(getRustModuleEvaluationRepresentationIdentityKey(module));
  }
  for (const file of input.sourceTree.files) {
    if (file.ownership.kind === 'placeholder') {
      incomplete.add(getRustModuleEvaluationRepresentationIdentityKey(file.ownership.module));
    }
  }
  return [...incomplete].sort();
}

function createRustModuleEvaluationRepresentationFinalizationSeal(
  input: Readonly<RustModuleEvaluationRepresentationFinalizationInput>,
): string {
  return normalizeCompilerStructuralValueCanonical({
    facade: input.finalization.facade,
    moduleEvaluation: input.finalization.moduleEvaluation,
    moduleFiles: input.finalization.moduleFiles.map(({ file, module }) => ({ module, path: file.path })),
    placeholders: (input.finalization.placeholderModules ?? []).map(cloneRustModuleEvaluationRepresentationIdentity),
    refusals: input.finalization.refusals ?? [],
    sourceTree: input.sourceTree,
  });
}

function createRustModuleEvaluationRepresentationFinalizationMismatch(): CompilerRustModuleEvaluationRepresentationPlanningFailure {
  const failure = Object.assign(
    new Error('Rust module-evaluation representation finalization changed within one emission session'),
    {
      code: 'rust-module-evaluation-representation-finalization-mismatch' as const,
      kind: 'rust-module-evaluation-representation-planning' as const,
      subjects: ['module-evaluation-representation'],
    },
  );
  failure.name = 'CompilerRustModuleEvaluationRepresentationPlanningError';
  return failure;
}

function selectRustModuleEvaluationRepresentationModules(
  input: Readonly<RustModuleEvaluationRepresentationFinalizationInput>,
): readonly Readonly<IrModule>[] {
  const evaluationKeys = new Set(
    input.finalization.moduleEvaluation.modules.map(({ module }) =>
      getRustModuleEvaluationRepresentationIdentityKey(module),
    ),
  );
  return input.modules.filter((module) => evaluationKeys.has(getRustModuleEvaluationRepresentationIdentityKey(module)));
}

function cloneRustModuleEvaluationRepresentationIdentity(
  module: Readonly<CompilerModuleIdentity>,
): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function cloneAndFreezeRustModuleEvaluationRepresentationFinalizationValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeRustModuleEvaluationRepresentationFinalizationValue(clone, new WeakSet());
  return clone;
}

function freezeRustModuleEvaluationRepresentationFinalizationValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const member of Object.values(value)) {
    freezeRustModuleEvaluationRepresentationFinalizationValue(member, seen);
  }
  Object.freeze(value);
}

function getRustModuleEvaluationRepresentationIdentityKey(module: Readonly<CompilerModuleIdentity>): string {
  return JSON.stringify([module.packageName, module.source, module.name]);
}
