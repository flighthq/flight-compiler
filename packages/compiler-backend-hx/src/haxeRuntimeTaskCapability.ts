import type { CompilerRuntimeTaskCapabilityPlan } from '../../compiler-types/src/index.js';

export function createCompilerRuntimeTaskCapabilityPlanHaxe(): CompilerRuntimeTaskCapabilityPlan {
  return cloneHaxeRuntimeTaskCapabilityValue(haxeRuntimeTaskCapabilityPlan);
}

function cloneHaxeRuntimeTaskCapabilityValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeHaxeRuntimeTaskCapabilityValue(clone, new WeakSet());
  return clone;
}

function freezeHaxeRuntimeTaskCapabilityValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeHaxeRuntimeTaskCapabilityValue(child, seen);
  Object.freeze(value);
}

const haxeRuntimeTaskCapabilityPlan = {
  capabilities: [
    {
      capability: 'cleanup',
      invocation: 'instanceMethod',
      memberName: 'finally',
      operation: 'finally',
      operationSemantics: 'flight-compiler-task-operation-semantics/1',
    },
    {
      capability: 'construct',
      completionSemantics: 'flight-compiler-async-task-completion/1',
      executorInvocation: 'synchronous',
      executorParameters: ['resolve', 'reject'],
      invocation: 'constructor',
      settlementCallbacks: 'first-call-wins-assimilating-resolve-exact-reject',
    },
    {
      awaitSemantics: 'flight-compiler-await-semantics/1',
      capability: 'continue',
      invocation: 'instanceMethod',
      memberName: 'then',
      operation: 'then',
      operationSemantics: 'flight-compiler-task-operation-semantics/1',
    },
    {
      capability: 'joinAll',
      invocation: 'staticMethod',
      memberName: 'all',
      operation: 'joinAll',
      operationSemantics: 'flight-compiler-task-operation-semantics/1',
    },
    {
      capability: 'normalize',
      invocation: 'staticMethod',
      memberName: 'resolve',
      operation: 'ready',
      operationSemantics: 'flight-compiler-task-operation-semantics/1',
    },
    {
      capability: 'reject',
      invocation: 'staticMethod',
      memberName: 'reject',
      operation: 'reject',
      operationSemantics: 'flight-compiler-task-operation-semantics/1',
    },
  ],
  contract: 'flight-runtime-task-capability-abi/1',
} as const satisfies CompilerRuntimeTaskCapabilityPlan;
