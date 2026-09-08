import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerAsyncStateMachineStep, IrModule } from '../../compiler-types/src/index.js';
import { analyzeIrModuleAsyncStateMachines } from './compilerAsyncStateMachine.js';

describe('analyzeIrModuleAsyncStateMachines', () => {
  it('builds deterministic linear states for binding initialization, rebinding, discard, and returned suspension', () => {
    const module = lower(`
      let external: number = 1;
      export async function linear(input: number): Promise<number> {
        const first = await Promise.resolve(input);
        let second: number = 0;
        second = await Promise.resolve(first);
        await Promise.resolve(second);
        return await Promise.resolve(second + external);
      }
    `);
    const snapshot = structuredClone(module);

    const analysis = analyzeIrModuleAsyncStateMachines(module);
    const machine = analysis.machines[0];
    const suspensions = machine?.states.flatMap((state) =>
      state.steps.filter(
        (step): step is Extract<CompilerAsyncStateMachineStep, { kind: 'suspend' }> => step.kind === 'suspend',
      ),
    );

    expect(analysis.schema).toBe('flight-compiler-async-state-machine-analysis/1');
    expect(analysis.refusals).toEqual([]);
    expect(machine?.states.map((state) => state.identity.kind)).toEqual(['entry', 'resume', 'resume', 'resume']);
    expect(suspensions?.map((step) => step.fulfillment.kind)).toEqual([
      'initializeBinding',
      'rebind',
      'discard',
      'resolve',
    ]);
    expect(suspensions?.slice(0, -1).every((step) => step.resumeState?.kind === 'resume')).toBe(true);
    expect(suspensions?.at(-1)).not.toHaveProperty('resumeState');
    expect(machine?.retainedCaptures.map((capture) => capture.binding.name)).toEqual(['external']);
    expect(machine?.retainedBindings.map((retained) => retained.binding.name)).toEqual(['second']);
    expect(machine?.retainedBindings[0]?.suspensionPaths).toEqual([suspensions?.[2]?.path]);
    expect(machine?.completionPaths.paths.some((completion) => completion.kind === 'return')).toBe(true);
    expect(machine?.completionPaths.paths.filter((completion) => completion.kind === 'throw')).toHaveLength(9);
    expect(module).toEqual(snapshot);
    expect(isDeeplyFrozen(analysis, new WeakSet())).toBe(true);
  });

  it('retains parameters and destructured locals only across suspensions where their current value remains live', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function retained(input: number, task: Promise<void>): Promise<number> {
          const [local] = [input];
          await task;
          return input + local;
        }
        export async function overwritten(task: Promise<number>): Promise<number> {
          let value = 1;
          value = await task;
          return value;
        }
      `),
    );
    const machines = new Map(
      analysis.machines.flatMap((machine) =>
        machine.origin.kind === 'functionDeclaration' ? [[machine.origin.binding.name, machine] as const] : [],
      ),
    );

    expect(machines.get('retained')?.retainedBindings.map((retained) => retained.binding.name)).toEqual([
      'input',
      'local',
    ]);
    expect(machines.get('retained')?.retainedBindings.every((retained) => retained.suspensionPaths.length === 1)).toBe(
      true,
    );
    expect(machines.get('overwritten')?.retainedBindings).toEqual([]);
  });

  it('supports concise async resolution, concise await, explicit settlement, and implicit fallthrough', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export const immediate = async (): Promise<number> => 1;
        export const awaited = async (): Promise<number> => await Promise.resolve(1);
        export const blockExpression = async (): Promise<number> => { return 1; };
        export async function empty(): Promise<void> {
          let vacant: number;
          const [value] = [1];
          value;
        }
        export async function returns(): Promise<void> { return; }
        export async function rejects(): Promise<void> { throw new Error('failure'); }
      `),
    );
    const immediate = analysis.machines[0];
    const awaited = analysis.machines[1];
    const machines = new Map(
      analysis.machines.flatMap((machine) =>
        machine.origin.kind === 'functionDeclaration' ? [[machine.origin.binding.name, machine] as const] : [],
      ),
    );

    expect(analysis.refusals).toEqual([]);
    expect(immediate?.states[0]?.steps.map((step) => step.kind)).toEqual(['resolve']);
    expect(awaited?.states[0]?.steps.map((step) => step.kind)).toEqual(['suspend']);
    expect(analysis.machines[2]?.states[0]?.steps.map((step) => step.kind)).toEqual(['resolve']);
    expect(machines.get('empty')?.states[0]?.steps.map((step) => step.kind)).toEqual([
      'execute',
      'execute',
      'execute',
      'resolve',
    ]);
    expect(machines.get('empty')?.completionPaths.paths.some((path) => path.kind === 'normal')).toBe(true);
    expect(machines.get('returns')?.states[0]?.steps[0]).toMatchObject({
      kind: 'resolve',
      value: { kind: 'implicitUndefined' },
    });
    expect(machines.get('rejects')?.states[0]?.steps[0]).toMatchObject({ kind: 'reject' });
  });

  it('covers async methods and nested async expressions without assigning suspensions to their parents', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export class Worker {
          async run(value: number): Promise<number> { return await Promise.resolve(value); }
        }
        export async function outer(value: number): Promise<number> {
          const nested = async (): Promise<number> => await Promise.resolve(value);
          nested;
          return value;
        }
      `),
    );

    expect(analysis.refusals).toEqual([]);
    expect(analysis.machines).toHaveLength(3);
    expect(analysis.machines.find((machine) => machine.origin.kind === 'classMethod')?.states[0]?.steps[0]?.kind).toBe(
      'suspend',
    );
    const outer = analysis.machines.find(
      (machine) => machine.origin.kind === 'functionDeclaration' && machine.origin.binding.name === 'outer',
    );
    const nested = analysis.machines.find((machine) => machine.origin.kind === 'functionExpression');
    expect(outer?.states).toHaveLength(1);
    expect(nested?.states[0]?.steps[0]?.kind).toBe('suspend');
  });

  it('returns stable refusals for every control-flow and suspension shape not yet proven safe', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function iteration(values: number[]): Promise<void> {
          for await (const value of values) value;
        }
        export async function branch(value: boolean): Promise<void> { if (value) return; }
        export async function unreachable(): Promise<void> { return; 1; }
        export async function escaped(): Promise<void> { break; }
        export async function nestedAwait(task: Promise<number>): Promise<number> {
          return 1 + await task;
        }
        export async function multiple(task: Promise<number>): Promise<number> {
          return await Promise.resolve(await task);
        }
        export async function property(task: Promise<number>, value: { result: number }): Promise<void> {
          value.result = await task;
        }
        export async function declarations(task: Promise<number>): Promise<void> {
          const first = await task, second = 1;
          first; second;
        }
        export async function pattern(task: Promise<[number]>): Promise<void> {
          const [first] = await task;
          first;
        }
        export const conciseUnsupported = async (task: Promise<number>): Promise<number> => 1 + await task;
      `),
    );

    expect(analysis.machines).toEqual([]);
    expect(analysis.refusals.map((refusal) => refusal.code)).toEqual([
      'unsupported-async-iteration',
      'unsupported-control-flow',
      'unreachable-statement',
      'escaping-control-flow',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
      'unsupported-suspension-expression',
    ]);
  });

  it('runs non-suspending structured control flow inside one state and keeps its rejection path', () => {
    // Structured control flow only has to become states when a suspension is inside it. A branch or
    // loop that never awaits runs to completion within one state, so refusing it refused most of the
    // ordinary code in an async function. It can still reject from anywhere inside, which is why the
    // step carries the statement itself as an abrupt completion path.
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function work(values: number[], flag: boolean): Promise<number> {
          let total: number = 0;
          if (flag) { total = 1; } else { total = 2; }
          for (const value of values) total += value;
          while (total < 0) total += 1;
          switch (total) { case 1: total = 3; break; default: total = 4; }
          try { total += 1; } finally { total += 2; }
          return await Promise.resolve(total);
        }
      `),
    );
    const machine = analysis.machines[0];
    const executed = machine?.states.flatMap((state) =>
      state.steps.filter((step) => step.kind === 'execute').map((step) => step.path.at(-1)),
    );

    expect(analysis.refusals).toEqual([]);
    expect(analysis.machines).toHaveLength(1);
    expect(executed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      machine?.states
        .flatMap((state) => state.steps)
        .filter((step) => step.kind === 'execute')
        .every((step) => step.abruptValues.length > 0),
    ).toBe(true);
    expect(machine?.completionPaths.paths.some((path) => path.kind === 'return')).toBe(true);
  });

  it('runs do, for, and for-in loops as opaque execute steps when they contain no suspension', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function loops(values: number[], record: Record<string, number>): Promise<number> {
          let total: number = 0;
          do { total += 1; } while (total < 3);
          for (let i: number = 0; i < values.length; i = i + 1) total += values[i];
          for (const key in record) total += record[key];
          return await Promise.resolve(total);
        }
      `),
    );
    const machine = analysis.machines[0];
    const executed = machine?.states.flatMap((state) =>
      state.steps.filter((step) => step.kind === 'execute').map((step) => step.path.at(-1)),
    );

    expect(analysis.refusals).toEqual([]);
    expect(analysis.machines).toHaveLength(1);
    expect(executed).toEqual([0, 1, 2, 3]);
  });

  it('marks the join unreachable when both arms of a suspending if leave', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function decide(task: Promise<number>, flag: boolean): Promise<number> {
          if (flag) { return await task; } else { return await task; }
        }
      `),
    );
    const machine = analysis.machines[0];

    expect(analysis.refusals).toEqual([]);
    expect(machine?.states.some((state) => state.identity.kind === 'join')).toBe(true);
    expect(machine?.completionPaths.paths.filter((p) => p.kind === 'return')).toHaveLength(2);
  });

  it('returns a refusal when a suspension appears in the else arm that fails', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function nested(task: Promise<number>, flag: boolean): Promise<number> {
          let result: number = 0;
          if (flag) {
            result = 1;
          } else {
            result = 1 + await task;
          }
          return result;
        }
      `),
    );

    expect(analysis.refusals).toHaveLength(1);
    expect(analysis.refusals[0]?.code).toBe('unsupported-suspension-expression');
  });

  it('carries a non-await return value through the cleanup when a return is inside try/finally', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>): Promise<number> {
          const value = await task;
          try { return value; } finally { value; }
        }
      `),
    );
    const steps = (analysis.machines[0]?.states ?? []).flatMap((state) => state.steps);

    expect(analysis.refusals).toEqual([]);
    expect(steps.filter((step) => step.kind === 'carry')).toHaveLength(1);
    expect(steps.filter((step) => step.kind === 'carry')[0]).toMatchObject({
      kind: 'carry',
      binding: { name: 'cleanupValue' },
    });
  });

  it('refuses a suspension in a do-while condition, which has to settle before the next iteration', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function poll(task: Promise<boolean>): Promise<void> {
          do { 1; } while (await task);
        }
      `),
    );

    expect(analysis.refusals).toHaveLength(1);
    expect(analysis.refusals[0]?.code).toBe('unsupported-suspension-expression');
  });

  it('refuses a finally body that leaves, because the cleanup must fall through', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function bad(task: Promise<number>): Promise<number> {
          try { return await task; } finally { return 0; }
        }
      `),
    );

    expect(analysis.refusals).toHaveLength(1);
    expect(analysis.refusals[0]?.code).toBe('unsupported-control-flow');
  });

  it('refuses a handler whose own suspension fails', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function rescue(task: Promise<number>): Promise<number> {
          try {
            return await task;
          } catch {
            return 1 + await task;
          }
        }
      `),
    );

    expect(analysis.refusals).toHaveLength(1);
    expect(analysis.refusals[0]?.code).toBe('unsupported-suspension-expression');
  });

  it('runs an opaque single-statement arm without refusing it', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function guarded(task: Promise<number>): Promise<number> {
          let result: number = 0;
          if (true) result = await task;
          else result = 1;
          return result;
        }
      `),
    );

    expect(analysis.refusals).toEqual([]);
    expect(analysis.machines).toHaveLength(1);
  });

  it('walks a suspending block as its own statement list rather than refusing it', () => {
    // A block adds no control flow, so a suspension inside one needs no new state shape. Two awaits
    // in the same block therefore produce two suspensions, which the whole-statement refusal used to
    // reject before it could look at the block at all.
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function scoped(task: Promise<number>): Promise<number> {
          let total: number = 0;
          {
            const first = await task;
            total = await Promise.resolve(first);
          }
          return total;
        }
      `),
    );
    const machine = analysis.machines[0];
    const suspended = machine?.states.flatMap((state) =>
      state.steps.filter((step) => step.kind === 'suspend').map((step) => step.path),
    );

    expect(analysis.refusals).toEqual([]);
    expect(suspended).toEqual([
      ['declarations', 0, 'body', 1, 'statements', 0, 'declarations', 0, 'initializer'],
      ['declarations', 0, 'body', 1, 'statements', 1, 'expression', 'right'],
    ]);
    expect(machine?.states).toHaveLength(3);
  });

  it('refuses a labelled block whose label the machine cannot represent', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function labelled(task: Promise<number>): Promise<number> {
          let total: number = 0;
          outer: {
            total = await task;
          }
          return total;
        }
      `),
    );

    expect(analysis.machines).toEqual([]);
    expect(analysis.refusals.map((refusal) => refusal.code)).toEqual(['unsupported-control-flow']);
  });

  it('branches into arm states when a suspension is inside one arm and joins after both', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function choose(task: Promise<number>, flag: boolean): Promise<number> {
          let total: number = 0;
          if (flag) {
            total = await task;
          } else {
            total = 1;
          }
          return total;
        }
      `),
    );
    const machine = analysis.machines[0];
    const branchPath = ['declarations', 0, 'body', 1];

    expect(analysis.refusals).toEqual([]);
    expect(machine?.states.map((state) => state.identity)).toEqual([
      { kind: 'entry' },
      { arm: 'whenTrue', kind: 'branchArm', path: branchPath },
      { kind: 'resume', suspensionPath: [...branchPath, 'consequent', 'statements', 0, 'expression', 'right'] },
      { arm: 'whenFalse', kind: 'branchArm', path: branchPath },
      { kind: 'join', path: branchPath },
    ]);
    expect(machine?.states[0]?.steps.at(-1)).toMatchObject({
      conditionPath: [...branchPath, 'condition'],
      kind: 'branch',
      whenFalse: { arm: 'whenFalse', kind: 'branchArm', path: branchPath },
      whenTrue: { arm: 'whenTrue', kind: 'branchArm', path: branchPath },
    });
    // The resumed consequent and the else arm both fall to the join rather than into each other.
    expect(machine?.states[2]?.steps.at(-1)).toEqual({
      kind: 'goto',
      path: [...branchPath, 'consequent'],
      target: { kind: 'join', path: branchPath },
    });
    expect(machine?.states[3]?.steps.at(-1)).toEqual({
      kind: 'goto',
      path: [...branchPath, 'otherwise'],
      target: { kind: 'join', path: branchPath },
    });
  });

  it('sends the false route straight to the join when the branch has no else', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function guard(task: Promise<number>, flag: boolean): Promise<number> {
          let total: number = 0;
          if (flag) total = await task;
          return total;
        }
      `),
    );
    const machine = analysis.machines[0];
    const branchPath = ['declarations', 0, 'body', 1];

    expect(analysis.refusals).toEqual([]);
    expect(machine?.states.map((state) => state.identity)).toEqual([
      { kind: 'entry' },
      { arm: 'whenTrue', kind: 'branchArm', path: branchPath },
      { kind: 'resume', suspensionPath: [...branchPath, 'consequent', 'expression', 'right'] },
      { kind: 'join', path: branchPath },
    ]);
    expect(machine?.states[0]?.steps.at(-1)).toMatchObject({
      kind: 'branch',
      whenFalse: { kind: 'join', path: branchPath },
    });
  });

  it('refuses a suspension in the condition, which has to settle before the branch is decided', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function decide(task: Promise<boolean>): Promise<number> {
          let total: number = 0;
          if (await task) { total = 1; }
          return total;
        }
      `),
    );

    expect(analysis.machines).toEqual([]);
    expect(analysis.refusals.map((refusal) => refusal.code)).toEqual(['unsupported-suspension-expression']);
  });

  it('names a loop header and re-enters it from the back edge of a suspending body', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>, again: boolean): Promise<number> {
          let last: number = 0;
          let pending: boolean = true;
          while (pending) {
            last = await task;
            pending = again;
          }
          return last;
        }
      `),
    );
    const machine = analysis.machines[0];
    const loopPath = ['declarations', 0, 'body', 2];

    expect(analysis.refusals).toEqual([]);
    expect(machine?.states.map((state) => state.identity)).toEqual([
      { kind: 'entry' },
      { kind: 'loopHeader', path: loopPath },
      { arm: 'whenTrue', kind: 'branchArm', path: loopPath },
      { kind: 'resume', suspensionPath: [...loopPath, 'body', 'statements', 0, 'expression', 'right'] },
      { kind: 'join', path: loopPath },
    ]);
    expect(machine?.states[0]?.steps.at(-1)).toEqual({
      header: { kind: 'loopHeader', path: loopPath },
      kind: 'loop',
      path: loopPath,
    });
    // The back edge is what separates a loop from a branch: the resumed body returns to the header
    // so the condition is evaluated again, rather than falling through to the join.
    expect(machine?.states[3]?.steps.at(-1)).toEqual({
      kind: 'goto',
      path: [...loopPath, 'body'],
      target: { kind: 'loopHeader', path: loopPath },
    });
  });

  it('refuses a suspension in a loop condition, which settles before each iteration is decided', () => {
    const condition = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function decide(task: Promise<boolean>): Promise<number> {
          let total: number = 0;
          while (await task) { total = 1; }
          return total;
        }
      `),
    );

    expect(condition.refusals.map((refusal) => refusal.code)).toEqual(['unsupported-suspension-expression']);
  });

  it('puts the do-while test at the tail of its header, where the source puts it', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>, again: boolean): Promise<number> {
          let last: number = 0;
          do {
            last = await task;
          } while (again);
          return last;
        }
      `),
    );
    const machine = analysis.machines[0];
    const loopPath = ['declarations', 0, 'body', 1];
    const steps = machine?.states.flatMap((state) => state.steps) ?? [];

    expect(analysis.refusals).toEqual([]);
    // A do-while has no separate body arm state: the header is the body, and the test is its tail,
    // which is exactly the difference from `while`.
    expect(machine?.states.map((state) => state.identity)).toEqual([
      { kind: 'entry' },
      { kind: 'loopHeader', path: loopPath },
      { kind: 'resume', suspensionPath: [...loopPath, 'body', 'statements', 0, 'expression', 'right'] },
      { kind: 'join', path: loopPath },
    ]);
    expect(steps.filter((step) => step.kind === 'branch')).toMatchObject([
      { conditionPath: [...loopPath, 'condition'], whenFalse: { kind: 'join', path: loopPath } },
    ]);
    // A true test re-enters the header, because for do-while the header is the body.
    expect(machine?.states[2]?.steps.at(-1)).toMatchObject({
      kind: 'branch',
      whenTrue: { kind: 'loopHeader', path: loopPath },
    });
  });

  it('sends break to the loop join and continue to the loop header', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>, stop: boolean, skip: boolean): Promise<number> {
          let last: number = 0;
          while (true) {
            last = await task;
            if (skip) { continue; }
            if (stop) { break; }
          }
          return last;
        }
      `),
    );
    const machine = analysis.machines[0];
    const loopPath = ['declarations', 0, 'body', 1];
    const gotos = (machine?.states.flatMap((state) => state.steps) ?? []).filter((step) => step.kind === 'goto');

    expect(analysis.refusals).toEqual([]);
    expect(gotos.map((step) => step.kind === 'goto' && step.target)).toEqual([
      { kind: 'loopHeader', path: loopPath },
      { kind: 'join', path: loopPath },
      { kind: 'loopHeader', path: loopPath },
    ]);
  });

  it('sends a labelled jump to the loop that carries the label, not the innermost one', () => {
    const labelled = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>, stop: boolean): Promise<number> {
          let last: number = 0;
          outer: while (true) {
            while (true) {
              last = await task;
              if (stop) { break outer; }
            }
          }
          return last;
        }
      `),
    );
    const outerPath = ['declarations', 0, 'body', 1];
    const jumps = (labelled.machines[0]?.states.flatMap((state) => state.steps) ?? []).filter(
      (step) => step.kind === 'goto',
    );

    expect(labelled.refusals).toEqual([]);
    // The break leaves the OUTER loop, so it targets that loop's join rather than the inner one's.
    expect(
      jumps.some(
        (step) => step.kind === 'goto' && step.target.kind === 'join' && step.target.path.length === outerPath.length,
      ),
    ).toBe(true);

    const bare = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>): Promise<number> {
          const last = await task;
          break;
        }
      `),
    );

    expect(bare.refusals.map((refusal) => refusal.code)).toEqual(['escaping-control-flow']);
  });

  it('routes a suspension rejection into the source handler instead of settling the task', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>, fallback: number): Promise<number> {
          let result: number = 0;
          try {
            result = await task;
          } catch (error) {
            result = fallback;
          }
          return result;
        }
      `),
    );
    const machine = analysis.machines[0];
    const tryPath = ['declarations', 0, 'body', 1];
    const steps = machine?.states.flatMap((state) => state.steps) ?? [];

    expect(analysis.refusals).toEqual([]);
    expect(steps.filter((step) => step.kind === 'guard')).toMatchObject([
      {
        body: { arm: 'whenTrue', kind: 'branchArm', path: tryPath },
        catchState: { kind: 'catch', path: tryPath },
        join: { kind: 'join', path: tryPath },
      },
    ]);
    // The suspension inside the guarded body names the handler, so a rejected task enters the source
    // `catch` rather than settling the whole function.
    expect(steps.filter((step) => step.kind === 'suspend')).toMatchObject([
      { rejectState: { kind: 'catch', path: tryPath } },
    ]);
    expect(machine?.states.filter((state) => state.guard).map((state) => state.identity)).toEqual([
      { arm: 'whenTrue', kind: 'branchArm', path: tryPath },
      { kind: 'resume', suspensionPath: [...tryPath, 'tryBody', 'statements', 0, 'expression', 'right'] },
    ]);
  });

  it('suspends inside a handler, whose own rejection settles the task rather than re-entering it', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>, other: Promise<number>): Promise<number> {
          let result: number = 0;
          try { result = await task; } catch (error) { result = await other; }
          return result;
        }
      `),
    );
    const tryPath = ['declarations', 0, 'body', 1];
    const suspends = (analysis.machines[0]?.states.flatMap((state) => state.steps) ?? []).filter(
      (step) => step.kind === 'suspend',
    );

    expect(analysis.refusals).toEqual([]);
    // The guarded suspension names the handler; the handler's own suspension names nothing, because
    // a handler runs outside the region it handles.
    expect(suspends.map((step) => (step.kind === 'suspend' ? step.rejectState : undefined))).toEqual([
      { kind: 'catch', path: tryPath },
      undefined,
    ]);
  });

  it('runs a finally on both the normal route and the rejection route, then re-raises', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>): Promise<number> {
          let result: number = 0;
          let done: boolean = false;
          try { result = await task; } finally { done = true; }
          return done ? result : result;
        }
      `),
    );
    const machine = analysis.machines[0];
    const tryPath = ['declarations', 0, 'body', 2];

    expect(analysis.refusals).toEqual([]);
    // Cleanup is reached twice on purpose: once when the body completes and once from the rejection
    // route, which re-raises afterwards rather than consuming the rejection the way `catch` does.
    expect(machine?.states.map((state) => state.identity)).toEqual([
      { kind: 'entry' },
      { arm: 'whenTrue', kind: 'branchArm', path: tryPath },
      { kind: 'resume', suspensionPath: [...tryPath, 'tryBody', 'statements', 0, 'expression', 'right'] },
      { arm: 'whenFalse', kind: 'branchArm', path: tryPath },
      { kind: 'catch', path: tryPath },
      { kind: 'join', path: tryPath },
    ]);
    expect(machine?.states.filter((state) => state.guard?.rethrow).map((state) => state.identity)).toEqual([
      { arm: 'whenTrue', kind: 'branchArm', path: tryPath },
      { kind: 'resume', suspensionPath: [...tryPath, 'tryBody', 'statements', 0, 'expression', 'right'] },
    ]);
  });

  it('carries a returned value through the cleanup that owes it', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>, done: boolean): Promise<number> {
          try { return await task; } finally { done = true; }
        }
      `),
    );
    const steps = (analysis.machines[0]?.states ?? []).flatMap((state) => state.steps);

    expect(analysis.refusals).toEqual([]);
    // The route does not settle when the suspension fulfills: it leaves the value in the carrier the
    // region declared, jumps to the cleanup, and the cleanup settles from what it finds there.
    expect(steps.filter((step) => step.kind === 'suspend')).toMatchObject([
      { fulfillment: { binding: { name: 'cleanupValue' }, kind: 'rebind' } },
    ]);
    // The cleanup settles from the carrier; the join settles the route that fell out of the region.
    expect(steps.filter((step) => step.kind === 'resolve')[0]).toMatchObject({
      value: { binding: { name: 'cleanupValue' }, kind: 'carried' },
    });
    expect(steps.filter((step) => step.kind === 'guard')).toMatchObject([{ carrier: { name: 'cleanupValue' } }]);
  });

  it('runs a cleanup on every route out of a handled region', () => {
    // `try`/`catch`/`finally` is two regions rather than one with a third route: the cleanup owes the
    // handler's own routes as much as the body's, which is exactly `try { try A catch H } finally F`.
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>, log: number[]): Promise<number> {
          let result: number = 0;
          try { result = await task; } catch { result = 1; } finally { log.push(result); }
          return result;
        }
      `),
    );
    const steps = (analysis.machines[0]?.states ?? []).flatMap((state) => state.steps);
    const tryPath = ['declarations', 0, 'body', 1];

    expect(analysis.refusals).toEqual([]);
    // Two regions, keyed on different paths so their state identities cannot collide.
    expect(
      steps.filter((step) => step.kind === 'guard').map((step) => (step.kind === 'guard' ? step.path : [])),
    ).toEqual([tryPath, [...tryPath, 'tryBody']]);
  });

  it('refuses nothing that a catch and finally together now cover', () => {
    const both = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function attempt(task: Promise<number>): Promise<number> {
          let result: number = 0;
          try { result = await task; } catch { result = 1; } finally { result = result; }
          return result;
        }
      `),
    );

    expect(both.refusals).toEqual([]);
  });

  it('retains only the bindings that outlive a suspension, not the ones each iteration recreates', () => {
    // A binding the suspension itself initializes lives in the state resumed after it, so it is
    // recreated on every iteration and must not be hoisted into shared storage. Getting this wrong
    // is how a loop ends up with one shared variable where the source had one per iteration.
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>, again: boolean): Promise<number> {
          let total: number = 0;
          while (again) {
            const value = await task;
            total = value;
            again = false;
          }
          return total;
        }
      `),
    );
    const machine = analysis.machines[0];

    expect(analysis.refusals).toEqual([]);
    expect(machine?.retainedBindings.map((retained) => retained.binding.name).sort()).toEqual(['again', 'total']);
    expect(
      machine?.states
        .flatMap((state) => state.steps)
        .filter((step) => step.kind === 'suspend')
        .map((step) => step.kind === 'suspend' && step.fulfillment.kind),
    ).toEqual(['initializeBinding']);
  });

  it('carries one completion path per route out, and no path for a route that does not exist', () => {
    // A machine that drops a completion path still looks plausible: the states are there and the
    // steps run. The paths are what a target settles from, so a missing one is a task that never
    // settles, and a spurious one is a settlement the source never had.
    const branch = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function choose(task: Promise<number>, flag: boolean): Promise<number> {
          if (flag) { return await task; }
          return 1;
        }
      `),
    );
    const loop = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function drain(task: Promise<number>, again: boolean): Promise<number> {
          let last: number = 0;
          while (again) { last = await task; again = false; }
          return last;
        }
      `),
    );
    const kinds = (analysis: ReturnType<typeof analyzeIrModuleAsyncStateMachines>) =>
      (analysis.machines[0]?.completionPaths.paths ?? []).map((entry) => entry.kind).sort();

    expect(branch.refusals).toEqual([]);
    expect(loop.refusals).toEqual([]);
    // Both arms settle, so both return routes are present, and each awaited operand can reject.
    expect(kinds(branch).filter((kind) => kind === 'return')).toHaveLength(2);
    // The loop has one return, reached whether or not the body ever runs — not one per iteration.
    expect(kinds(loop).filter((kind) => kind === 'return')).toHaveLength(1);
    // A function with no explicit return still completes normally, and one with only returns does not.
    expect(kinds(branch)).not.toContain('normal');
    expect(kinds(loop)).not.toContain('normal');
  });

  it('settles a body that falls off its end, rather than leaving the task pending', () => {
    const analysis = analyzeIrModuleAsyncStateMachines(
      lower(`
        export async function observe(task: Promise<number>): Promise<void> {
          await task;
        }
      `),
    );
    const paths = analysis.machines[0]?.completionPaths.paths ?? [];

    expect(analysis.refusals).toEqual([]);
    // The implicit completion is what settles a void async function; without it the task never
    // resolves and nothing in the emitted source looks wrong.
    expect(paths.filter((entry) => entry.kind === 'normal')).toMatchObject([{ value: { kind: 'implicitUndefined' } }]);
  });

  it('is deterministic, deeply immutable, and vacuous for a module without async scopes', () => {
    const module = lower('export function read(value: number): number { return value; }');
    const first = analyzeIrModuleAsyncStateMachines(module);
    const second = analyzeIrModuleAsyncStateMachines(module);

    expect(first).toEqual({
      machines: [],
      module: { name: module.name, packageName: module.packageName, source: module.source },
      refusals: [],
      schema: 'flight-compiler-async-state-machine-analysis/1',
    });
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

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile('/flight/packages/task/src/state.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/task-state',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}
