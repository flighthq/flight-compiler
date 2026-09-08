import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrExpression, IrModule, IrStatement, IrVariable } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassBindingPattern } from './compilerBindingPatternLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';
import { createCompilerLoweringPassSwitchFallthrough } from './compilerSwitchFallthroughLowering.js';
import { createCompilerLoweringPassVariableHoisting } from './compilerVariableHoistingLowering.js';

describe('createCompilerLoweringPassSwitchFallthrough', () => {
  it('duplicates fallthrough suffixes and consumes only final switch-local breaks', () => {
    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-fallthrough.ts',
        `
          export function classify(value: number): number {
            switch (value) {
              case 1:
              case 2: return 5;
              default: return 0;
            }
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting(), pass],
      { verificationDepth: 'idempotence' },
    );
    const statement = getFunctionSwitch(output);

    expect(pass).toMatchObject({
      idempotent: true,
      name: 'switch-fallthrough',
      runsAfter: ['variable-hoisting'],
    });
    expect(statement.cases).toMatchObject([
      { expression: { value: 1 }, statements: [{ expression: { value: 5 }, kind: 'return' }] },
      { expression: { value: 2 }, statements: [{ expression: { value: 5 }, kind: 'return' }] },
      { statements: [{ expression: { value: 0 }, kind: 'return' }] },
    ]);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('preserves default position while expanding every reachable suffix', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-default.ts',
        `
          export function adjust(value: number): number {
            let total = 0;
            switch (value) {
              case 0: total += 1;
              default: total += 2;
              case 3: total += 4; break;
              case 4: return total;
            }
            return total;
          }
        `,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const statement = getFunctionSwitch(output);

    expect(statement.cases.map((switchCase) => switchCase.statements.length)).toEqual([4, 3, 2, 1]);
    expect(statement.cases[0]?.statements.at(-1)).toEqual({ kind: 'break' });
    expect(statement.cases[1]?.expression).toBeUndefined();
    expect(statement.cases[3]?.statements.at(-1)).toMatchObject({ kind: 'return' });
  });

  it('refuses conditional local breaks explicitly', () => {
    const cases = [
      {
        message: 'switch-local break must be the final direct statement of its clause',
        source:
          'export function read(value: number): number { switch (value) { case 0: if (value) break; return 1; default: return 0; } }',
      },
    ];
    for (const item of cases) {
      const run = (): IrModule =>
        lowerIrModuleWithCompilerPasses(lower('switch-refusal.ts', item.source), [
          createCompilerLoweringPassBindingPattern(),
          createCompilerLoweringPassVariableHoisting(),
          createCompilerLoweringPassSwitchFallthrough(),
        ]);

      try {
        run();
        expect.unreachable('Expected switch fallthrough lowering to refuse the input');
      } catch (error) {
        expect(isCompilerLoweringFailure(error)).toBe(true);
        expect(error).toMatchObject({ code: 'unsupported-ir', message: expect.stringContaining(item.message) });
      }
    }
  });

  it('uses a state machine to preserve one binding identity across fallthrough execution', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-binding-state.ts',
        'export function read(value: number): number { switch (value) { case 0: value += 1; case 1: const local = value; return local; default: return 0; } }',
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'block') {
      throw new Error('Expected state-machine block');
    }
    const [stateDeclaration, selector, machine] = declaration.body[0].statements;

    expect(stateDeclaration).toMatchObject({
      declarations: [{ binding: { name: 'switchFallthroughState', scope: 'block' }, initializer: { value: -1 } }],
      kind: 'variable',
    });
    expect(selector).toMatchObject({ kind: 'switch' });
    expect(machine).toMatchObject({
      body: { cases: [{ expression: { value: 0 } }, { expression: { value: 1 } }, { expression: { value: 2 } }] },
      kind: 'while',
    });
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reports switch fallthrough as invalid in declarations and default exports', () => {
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(
      pass.verifyIrModule(
        lower(
          'verify-declaration.ts',
          `export function voidReturn(): void { return; }
           export function process(value: number, limit = 10): number {
             switch (value) { case 0: case 1: return 1; default: return 0; }
           }`,
        ),
      ),
    ).toEqual({ kind: 'invalid', reason: 'switch fallthrough remains after normalization' });
    expect(
      pass.verifyIrModule(
        lower(
          'verify-default.ts',
          'export default (value: number): number => { switch (value) { case 0: case 1: return 1; default: return 0; } };',
        ),
      ),
    ).toEqual({ kind: 'invalid', reason: 'switch fallthrough remains after normalization' });
  });

  it('lowers switch fallthrough in class constructors, methods, and field initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-fallthrough.ts',
        `export class Handler {
           handler = (value: number): number => {
             switch (value) { case 0: case 1: return 1; default: return 0; }
           };
           constructor(public label: string) {}
           process(value: number): number {
             switch (value) { case 0: case 1: return 1; default: return 0; }
           }
         }
         export class Simple {
           process(value: number): number {
             switch (value) { case 0: case 1: return 1; default: return 0; }
           }
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers switch fallthrough in variable initializers and default exports', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'variable-default.ts',
        `export const processor = (value: number): number => {
           switch (value) { case 0: case 1: return 1; default: return 0; }
         };
         export default (value: number): number => {
           switch (value) { case 0: case 1: return 1; default: return 0; }
         };`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('recurses through diverse expression kinds and for-loop variants during lowering', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'expression-variety.ts',
        `export function voidHelper(): void { return; }
         export function compute(
           values: number[],
           obj: { x: number },
           fn: (n: number) => number,
           limit = 10,
         ): string {
           const mapper = (n: number): number => { return n * 2; };
           for (;;) { break; }
           for (let i = 0; i < 1; i++) { break; }
           switch (values.length) {
             case 0: {
               const arr = [1, ...values];
               const first = values[0];
               const prop = obj.x;
               const key = 'z';
               const message = \`count: \${values.length}\`;
               const ternary = prop > 0 ? 1 : 0;
               const composed = { y: prop, [key]: ternary, ...obj };
               const negated = -prop;
               const called = fn(prop);
               const instance = new Error(message);
               return message;
             }
             case 1:
             default:
               return '';
           }
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('detects binding introductions in diverse statement containers for state machine election', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'binding-containers.ts',
        `export function analyze(
           value: number,
           items: number[],
           obj: Record<string, number>,
         ): number {
           let total = 0;
           switch (value) {
             case 0:
               total += 1;
               { total += 2; }
               do { total += 1; } while (false);
               while (false) { total += 1; }
               if (total > 0) { total += 1; }
               if (total > 0) { total += 1; } else { total -= 1; }
               try { total += 1; } catch { total -= 1; }
               for (total = 0; total < 1; total++) { break; }
               for (;;) { break; }
             case 1:
               for (const item of items) { total += item; }
               break;
             default:
               return total;
           }
           switch (value) {
             case 2:
               for (const key in obj) { total += 1; }
             case 3:
               const other = total;
               total = other + 1;
               break;
             default:
               return total;
           }
           return total;
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    expect(declaration.body.filter((statement) => statement.kind === 'block')).toHaveLength(2);
  });

  it('transfers the switch label to the state machine wrapper block', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'labeled-state-machine.ts',
        `export function labeled(value: number): number {
           let total = 0;
           outer: switch (value) {
             case 0: const local = value; total += local;
             case 1: total += 1; break outer;
             default: total += 2;
           }
           return total;
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const block = declaration.body.find((statement) => statement.kind === 'block');
    expect(block).toBeDefined();
    expect(block?.kind === 'block' && block.label).toBeDefined();
  });

  it('elects state machine when binding introduction is only inside try-finally', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'try-finally-binding.ts',
        `export function analyze(value: number): number {
           let total = 0;
           switch (value) {
             case 0:
               total += 1;
             case 1:
               try { total += 2; } finally { const x = total; total = x; }
               break;
             default:
               return total;
           }
           return total;
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    expect(declaration.body.some((statement) => statement.kind === 'block')).toBe(true);
  });

  it('elects state machine when binding introduction is only inside a nested switch', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-switch-binding.ts',
        `export function analyze(value: number): number {
           let total = 0;
           switch (value) {
             case 0:
               total += 1;
             case 1:
               switch (total) { case 0: const y = total; total = y; break; default: total = 3; break; }
               break;
             default:
               return total;
           }
           return total;
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    expect(declaration.body.some((statement) => statement.kind === 'block')).toBe(true);
  });

  it('elects state machine when binding introduction is only in a return expression containing a function', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'return-function-binding.ts',
        `export function analyze(value: number): number {
           let total = 0;
           switch (value) {
             case 0:
               total += 1;
             case 1:
               return ((): number => total)();
             default:
               return total;
           }
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    expect(declaration.body.some((statement) => statement.kind === 'block')).toBe(true);
  });

  it('scans void returns and simple cases during binding introduction election', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'void-return-binding.ts',
        `export function analyze(value: number): void {
           let total = 0;
           switch (value) {
             case 0:
               return;
             case 1:
               total += 1;
             case 2:
               const y = total;
               total = y;
               break;
             default:
               return;
           }
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    expect(declaration.body.some((statement) => statement.kind === 'block')).toBe(true);
  });

  it('covers IR-only expression types via injection in switch case bodies', () => {
    const module = lower(
      'inject-ir.ts',
      `export function process(value: number): number {
         let total = 0;
         switch (value) {
           case 0: total += 1;
           case 1: const local = total; return local;
           default: return 0;
         }
       }`,
    );
    const clone: IrModule = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const switchStmt = declaration.body.find((s) => s.kind === 'switch');
    if (switchStmt?.kind !== 'switch') throw new Error('Expected switch');
    const ref = { binding: declaration.parameters[0]!.binding };
    const ident: IrExpression = { kind: 'identifier', reference: ref };
    const expr = (expression: IrExpression): IrStatement => ({ expression, kind: 'expression' as const });

    switchStmt.cases[0]!.statements.unshift(
      expr({
        excluded: [
          { kind: 'named', name: 'x' },
          { kind: 'computed', expression: ident },
        ],
        kind: 'objectRest',
        object: ident,
      } as IrExpression),
      expr({
        elements: [{ expression: ident, optional: false }, { optional: true }],
        kind: 'tuple',
      } as IrExpression),
      expr({
        kind: 'tupleSpread',
        segments: [
          { expression: ident, kind: 'spread' },
          { element: { expression: ident, optional: false as const }, kind: 'element' },
          { element: { optional: true as const }, kind: 'element' },
        ],
        type: { elements: [], kind: 'tuple' },
      } as IrExpression),
      expr({ kind: 'tupleRest', object: ident, start: 0 } as IrExpression),
      expr({ kind: 'tupleSuffix', object: ident, start: 0, width: 1 } as IrExpression),
      expr({ fallback: ident, kind: 'undefinedDefault', value: ident } as IrExpression),
    );

    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('covers objectRest expression through object-binding-pattern lowering composition', () => {
    const module = lower(
      'composed-object.ts',
      `export function process(source: { value: number; other: boolean }, key: string): number {
         let total = 0;
         const { value, [key]: computed, ...rest } = source;
         switch (value) {
           case 0: total += value;
           case 1: const local = total + (computed as number); return local + (rest.other ? 1 : 0);
           default: return 0;
         }
       }`,
    );
    const partiallyLowered = lowerIrModuleWithCompilerPasses(module, [
      createCompilerLoweringPassObjectBindingPattern(),
    ]);
    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = pass.lowerIrModule(partiallyLowered);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers switch fallthrough inside class constructors with body and skips fields without initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-constructor-field.ts',
        `export class Handler {
           label!: string;
           constructor(value: number) {
             switch (value) { case 0: case 1: this.label = 'a'; break; default: this.label = 'b'; }
           }
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers switch fallthrough through sparse arrays', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'sparse-array.ts',
        `export function process(value: number): (number | undefined)[] {
           switch (value) {
             case 0:
             case 1: return [1, , 3];
             default: return [];
           }
         }`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('detects binding introduction through switch case expressions', () => {
    const module = lower(
      'case-expression-binding.ts',
      `export function process(value: number): number {
         let total = 0;
         switch (value) {
           case 0:
             total += 1;
           case 1:
             switch (total) {
               case ((): number => 0)(): const inner = total; total = inner; break;
               default: break;
             }
             break;
           default:
             return total;
         }
         return total;
       }`,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [
      createCompilerLoweringPassBindingPattern(),
      createCompilerLoweringPassVariableHoisting(),
      createCompilerLoweringPassSwitchFallthrough(),
    ]);
    const pass = createCompilerLoweringPassSwitchFallthrough();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers default export expressions directly', () => {
    const module = lower(
      'default-direct.ts',
      `export default (value: number): number => {
         switch (value) { case 0: case 1: return 1; default: return 0; }
       };`,
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = pass.lowerIrModule(module);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('refuses binding-sensitive state machine when switch lacks origin', () => {
    const module = lower(
      'no-origin.ts',
      `export function process(value: number): number {
         let total = 0;
         switch (value) {
           case 0: total += 1;
           case 1: const local = total; return local;
           default: return 0;
         }
       }`,
    );
    const clone: IrModule = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const switchStmt = declaration.body.find((s) => s.kind === 'switch');
    if (switchStmt?.kind !== 'switch') throw new Error('Expected switch');
    delete (switchStmt as { origin?: unknown }).origin;

    const pass = createCompilerLoweringPassSwitchFallthrough();
    try {
      pass.lowerIrModule(clone);
      expect.unreachable('Expected lowering failure for missing origin');
    } catch (error) {
      expect(isCompilerLoweringFailure(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'unsupported-ir',
        message: expect.stringContaining('binding-sensitive switch fallthrough requires switch source identity'),
      });
    }
  });

  it('refuses unsupported completion in binding-sensitive state machine', () => {
    const module = lower(
      'unsupported-state.ts',
      `export function process(value: number): number {
         let total = 0;
         switch (value) {
           case 0: total += 1;
           case 1: if (total > 0) break; const local = total; return local;
           default: return 0;
         }
       }`,
    );
    const pass = createCompilerLoweringPassSwitchFallthrough();
    try {
      lowerIrModuleWithCompilerPasses(module, [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        pass,
      ]);
      expect.unreachable('Expected lowering failure for unsupported completion');
    } catch (error) {
      expect(isCompilerLoweringFailure(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'unsupported-ir',
        message: expect.stringContaining('switch-local break must be the final direct statement'),
      });
    }
  });

  it('covers tuple, tupleSpread, tupleRest, tupleSuffix, and undefinedDefault via variable injection', () => {
    const module = lower(
      'inject-vars.ts',
      'export function loop(x: number): void { switch (x) { case 0: case 1: break; default: break; } }',
    );
    const clone: IrModule = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const ref = { binding: declaration.parameters[0]!.binding };
    const ident: IrExpression = { kind: 'identifier', reference: ref };
    const namedVar = (name: string, initializer: IrExpression): IrVariable => ({
      binding: { id: name, name },
      initializer,
      mutable: false,
      type: { kind: 'intrinsic', name: 'number' },
    });

    declaration.body = [
      {
        declarations: [
          namedVar('a', {
            elements: [{ expression: ident, optional: false }, { optional: true }],
            kind: 'tuple',
          } as IrExpression),
          namedVar('b', {
            kind: 'tupleSpread',
            segments: [
              { expression: ident, kind: 'spread' },
              { element: { expression: ident, optional: false as const }, kind: 'element' },
              { element: { optional: true as const }, kind: 'element' },
            ],
            type: { elements: [], kind: 'tuple' },
          } as IrExpression),
          namedVar('c', { kind: 'tupleRest', object: ident, start: 0 } as IrExpression),
          namedVar('d', { kind: 'tupleSuffix', object: ident, start: 0, width: 1 } as IrExpression),
          namedVar('e', { fallback: ident, kind: 'undefinedDefault', value: ident } as IrExpression),
        ],
        kind: 'variable' as const,
      },
      ...declaration.body,
    ];

    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('passes enum, interface, type alias, and variable-without-initializer declarations unchanged', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'passthrough.ts',
        `export enum Status { Active, Inactive }
         export interface Shape { area(): number; }
         export type Pair = [number, string];
         export let counter: number;
         export const processor = (value: number): number => {
           switch (value) { case 0: case 1: return 1; default: return 0; }
         };
         export default (value: number): number => {
           switch (value) { case 0: case 1: return 1; default: return 0; }
         };`,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
    expect(output.declarations.some((d) => d.kind === 'enum')).toBe(true);
    expect(output.declarations.some((d) => d.kind === 'interface')).toBe(true);
    expect(output.declarations.some((d) => d.kind === 'typeAlias')).toBe(true);
  });

  it('exits the state loop before continuing its enclosing loop and keeps multiple machine identities unique', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-continue.ts',
        `
          export function visit(values: number[]): void {
            for (const value of values) {
              switch (value) { case 0: const local = value; local; case 1: continue; default: break; }
              switch (value) { case 2: const other = value; other; case 3: continue; default: break; }
            }
          }
        `,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'forOf') {
      throw new Error('Expected for-of function');
    }
    const body = declaration.body[0].body;
    if (body.kind !== 'block') throw new Error('Expected loop body');
    const machines = body.statements.filter((statement) => statement.kind === 'block');
    const identities = machines.map((machine) => {
      const declaration = machine.statements[0];
      if (declaration?.kind !== 'variable' || 'pattern' in declaration.declarations[0]!) {
        throw new Error('Expected state binding');
      }
      return declaration.declarations[0]!.binding.id;
    });

    expect(new Set(identities).size).toBe(2);
    expect(machines).toHaveLength(2);
    expect(machines.every((machine) => machine.statements.at(-1)?.kind === 'if')).toBe(true);
  });

  it('checks binding introductions through nested switch default cases', () => {
    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-default.ts',
        `
          export function nested(mode: number, sub: number): number {
            let result = 0;
            switch (mode) {
              case 0:
                switch (sub) {
                  case 1: result = 10; break;
                  default: result = 20; break;
                }
              case 1: result += 30; break;
            }
            return result;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting(), pass],
    );

    expect(pass.verifyIrModule(output)).toMatchObject({ kind: 'valid' });
  });

  it('lowers fallthrough in default export function expressions', () => {
    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'default-export.ts',
        `
          export default (mode: number): number => {
            switch (mode) {
              case 0:
              case 1: return 1;
              case 2: return 2;
            }
            return 0;
          };
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting(), pass],
    );

    expect(pass.verifyIrModule(output)).toMatchObject({ kind: 'valid' });
  });
});

function getFunctionSwitch(module: Readonly<IrModule>): Extract<IrStatement, { kind: 'switch' }> {
  const declaration = module.declarations[0];
  if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
  const statement = declaration.body.find((item) => item.kind === 'switch');
  if (statement?.kind !== 'switch') throw new Error('Expected switch statement');
  return statement;
}

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/switch/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/switch', upstreamDirectory: '/flight' },
  ).module;
}
