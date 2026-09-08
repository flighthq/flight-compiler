import { analyzeIrModuleClosureEvidence } from '../../compiler-closure/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerClosureCaptureMutation,
  CompilerCppClosureCapturePlan,
  CompilerCppClosureCaptureReason,
  CompilerIrTraversalPath,
  IrBindingIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';

export function createIrModuleClosureCapturePlanCpp(module: Readonly<IrModule>): CompilerCppClosureCapturePlan {
  const capturesByBinding = new Map<
    string,
    {
      binding: IrBindingIdentity;
      declarationPath: CompilerIrTraversalPath;
      mutations: Set<CompilerClosureCaptureMutation>;
      outsideMutation: boolean;
    }
  >();
  for (const closure of analyzeIrModuleClosureEvidence(module).closures) {
    for (const capture of closure.captures) {
      const existing = capturesByBinding.get(capture.binding.id);
      const draft = existing ?? {
        binding: capture.binding,
        declarationPath: capture.declarationPath,
        mutations: new Set<CompilerClosureCaptureMutation>(),
        outsideMutation: false,
      };
      draft.mutations.add(capture.mutation);
      draft.outsideMutation ||= capture.outsideMutations.length > 0;
      capturesByBinding.set(capture.binding.id, draft);
    }
  }
  const mutableBindingIds = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if ('binding' in variable && variable.mutable) mutableBindingIds.add(variable.binding.id);
    },
  });

  return cloneCompilerCppClosureCapturePlan({
    bindings: [...capturesByBinding.values()].map((capture) => {
      const reasons = createCompilerCppClosureCaptureReasons(
        capture.binding,
        capture.mutations,
        mutableBindingIds.has(capture.binding.id),
        capture.outsideMutation,
      );
      return {
        binding: capture.binding,
        declarationPath: capture.declarationPath,
        reasons,
        representation:
          capture.binding.scope === 'module'
            ? 'directModuleBinding'
            : reasons.includes('valueSnapshot')
              ? 'valueCopy'
              : 'sharedMutableCell',
      };
    }),
    schema: 'flight-compiler-cpp-closure-capture-plan/1',
  });
}

function cloneCompilerCppClosureCapturePlan(plan: CompilerCppClosureCapturePlan): CompilerCppClosureCapturePlan {
  const clone = structuredClone(plan);
  freezeCompilerCppClosureCapturePlan(clone, new WeakSet());
  return clone;
}

function createCompilerCppClosureCaptureReasons(
  binding: Readonly<IrBindingIdentity>,
  mutations: ReadonlySet<CompilerClosureCaptureMutation>,
  mutableBinding: boolean,
  outsideMutation: boolean,
): CompilerCppClosureCaptureReason[] {
  const moduleBinding = binding.scope === 'module';
  const reasons: CompilerCppClosureCaptureReason[] = moduleBinding ? ['moduleLifetime'] : [];
  if (mutations.has('bindingReassigned') || mutations.has('bindingAndReferent')) {
    reasons.push('capturedBindingMutation');
  }
  if (mutableBinding && !moduleBinding) reasons.push('capturedMutableBinding');
  if (mutations.has('referentMutated') || mutations.has('bindingAndReferent')) {
    reasons.push('capturedReferentMutation');
  }
  if (outsideMutation) reasons.push('outsideMutation');
  if (reasons.length === 0) reasons.push('valueSnapshot');
  return reasons;
}

function freezeCompilerCppClosureCapturePlan(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerCppClosureCapturePlan(child, seen);
  Object.freeze(value);
}
