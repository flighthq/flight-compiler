import { analyzeCompilerRuntimeTaskCapabilityCompleteness } from '../../compiler-runtime-contract/src/index.js';
import type { CompilerRuntimeTaskCapabilityRequirements } from '../../compiler-types/src/index.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';

describe('createCompilerRuntimeTaskCapabilityPlanHaxe', () => {
  it('declares every versioned Haxe task runtime entry point', () => {
    const plan = createCompilerRuntimeTaskCapabilityPlanHaxe();
    const requirements: CompilerRuntimeTaskCapabilityRequirements = {
      module: { name: 'Task', packageName: '@flighthq/task', source: 'Task.ts' },
      requirements: plan.capabilities.map((capability) => ({ capability: capability.capability, evidence: [] })),
      schema: 'flight-runtime-task-capability-requirements/1',
    };

    expect(plan.contract).toBe('flight-runtime-task-capability-abi/1');
    expect(plan.capabilities.map((capability) => capability.capability)).toEqual([
      'cleanup',
      'construct',
      'continue',
      'joinAll',
      'normalize',
      'reject',
    ]);
    expect(analyzeCompilerRuntimeTaskCapabilityCompleteness(requirements, plan).kind).toBe('complete');
  });

  it('returns fresh deeply immutable plans', () => {
    const first = createCompilerRuntimeTaskCapabilityPlanHaxe();
    const second = createCompilerRuntimeTaskCapabilityPlanHaxe();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
  });
});

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}
