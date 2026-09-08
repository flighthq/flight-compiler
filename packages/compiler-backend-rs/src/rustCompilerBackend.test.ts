import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrStatement } from '../../compiler-types/src/index.js';
import { createRustCompilerBackend, emitIrModuleRust } from './rustCompilerBackend.js';

function lower(file: string, source: string) {
  return lowerPackage('@flighthq/math', file, source);
}

function lowerPackage(packageName: string, file: string, source: string) {
  const packageDirectory = packageName.slice(packageName.lastIndexOf('/') + 1);
  const sourceFile = ts.createSourceFile(
    `/flight/packages/${packageDirectory}/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, {
    packageName,
    upstreamDirectory: '/flight',
  });
}

describe('createRustCompilerBackend', () => {
  it('creates independent stateless backend records with Rust identity', () => {
    const first = createRustCompilerBackend();
    const second = createRustCompilerBackend();
    const module = lower('value.ts', 'export const value = 1;').module;

    expect(first).not.toBe(second);
    expect(first.name).toBe('rust');
    expect(first.emitModule(module, { modules: [module], options: {} })).toEqual([emitIrModuleRust(module)]);
  });

  it('uses explicit package-export resolution from the complete backend module context', () => {
    const target = lowerPackage('@flighthq/types', 'public.ts', 'export interface Box { value: number }').module;
    const subject = lowerPackage(
      '@flighthq/core',
      'use.ts',
      "import type { Box } from '@flighthq/types/public'; export const box: Box = {};",
    ).module;
    const backend = createRustCompilerBackend();

    expect(() => backend.emitModule(subject, { modules: [subject, target], options: {} })).not.toThrow();
    expect(() =>
      backend.emitModule(subject, {
        moduleResolution: {
          edges: [
            {
              specifier: '@flighthq/types/public',
              target: { packageName: '@flighthq/types', source: target.source },
            },
          ],
          schema: 'flight-compiler-module-resolution/1',
        },
        modules: [subject, target],
        options: {},
      }),
    ).toThrow('structural object compatibility missing-required-property');
  });
});

describe('emitIrModuleRust', () => {
  it('constructs named structural records and fills optional fields explicitly', () => {
    const result = lower(
      'named-object.ts',
      `
        export interface Range { readonly max: number; readonly min: number; label?: string }
        export function widen(range: Range, by: number): Range {
          return { max: range.max + by, min: range.min - by };
        }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('struct Range {\n  pub max: f64,\n  pub min: f64,\n  pub label: Option<String>,\n}');
    expect(output).toContain('return Range { max: (range.max + by), min: (range.min - by), label: None, };');
  });

  it('constructs nested nominal records through conditional and array contexts', () => {
    const result = lower(
      'nested-object.ts',
      `
        interface Item { value: number }
        interface Container { selected: Item; values: Item[] }
        export function create(flag: boolean): Container {
          return { selected: flag ? { value: 1 } : { value: 2 }, values: [{ value: 3 }] };
        }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain(
      'return Container { selected: if flag { Item { value: 1.0, } } else { Item { value: 2.0, } }, values: vec![Item { value: 3.0, }], };',
    );
  });

  it('constructs generic structural records with substituted nested target types', () => {
    const result = lower(
      'generic-object.ts',
      `
        interface Item { label: string }
        interface Box<Value> { value: Value; optional?: Value }
        export function create(): Box<Item> { return { value: { label: 'flight' } }; }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('struct Box<Value: Clone> {\n  pub value: Value,\n  pub optional: Option<Value>,\n}');
    expect(output).toContain('pub fn create() -> Box<Item>');
    expect(output).toContain('return Box<Item> { value: Item { label: "flight".to_owned(), }, optional: None, };');
  });

  it('interns anonymous structural types by canonical shape and constructs optional values', () => {
    const result = lower(
      'anonymous-object.ts',
      `
        function first(): { value: number; label?: string } { return { value: 1, label: 'first' }; }
        function second(): { label?: string; value: number } { return { value: 2 }; }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output.match(/struct AnonymousObjectRecord/gu)).toHaveLength(1);
    expect(output).not.toContain('struct AnonymousObjectRecord_2');
    expect(output).toContain('return AnonymousObjectRecord { value: 1.0, label: Some("first".to_owned()), };');
    expect(output).toContain('return AnonymousObjectRecord { value: 2.0, label: None, };');
  });

  it('builds an object from its own shape when the position it is passed to knows nothing', () => {
    const computed = lower(
      'computed-object.ts',
      'export function create(key: string): object { return { [key]: 1 }; }',
    );
    const spread = lower(
      'spread-object.ts',
      'export function create(value: { count: number }): { count: number } { return { ...value }; }',
    );
    const open = lower('open-object.ts', 'export function create(): object { return { value: 1 }; }');
    const duplicate = lower(
      'duplicate-object.ts',
      'export function create(): { value: number } { return { value: 1, value: 2 }; }',
    );

    expect(() => emitIrModuleRust(computed.module)).toThrow(
      'structural object compatibility computed-property-indeterminate',
    );
    expect(() => emitIrModuleRust(spread.module)).toThrow(
      'structural object compatibility spread-membership-indeterminate',
    );
    // A return type of `object` says nothing about what is being built, so the literal's own shape is
    // what it is built from — a record with the fields it states, rather than a refusal.
    expect(emitIrModuleRust(open.module).contents).toContain('pub struct AnonymousObjectRecord {');
    expect(() => emitIrModuleRust(duplicate.module)).toThrow(
      'structural object compatibility duplicate-property-requires-normalization',
    );
  });

  it('emits shared traceable provenance with an optional upstream commit', () => {
    const module = lower('value.ts', 'export const value = 1;').module;
    const commit = '0123456789abcdef0123456789abcdef01234567';

    expect(emitIrModuleRust(module).contents.split('\n')[0]).toBe(
      '// Generated by @flighthq/tool-compiler from @flighthq/math/packages/math/src/value.ts#Value. Do not edit.',
    );
    expect(emitIrModuleRust(module, { upstreamCommit: commit }).contents.split('\n')[0]).toBe(
      `// Generated by @flighthq/tool-compiler from @flighthq/math/packages/math/src/value.ts#Value at ${commit}. Do not edit.`,
    );
  });

  it('emits explicit type and value runtime bindings and rejects incomplete symbol spaces first', () => {
    const supported = lower(
      'external-types.ts',
      'export function preserve(values: Map<string, number>, bytes: Uint8Array, task: Promise<number>): Promise<number> { values; bytes; return task; }',
    );
    const missing = lower('external-missing.ts', 'export type fooBar = WeakMap; export type foo_bar = WeakMap;');
    const boundValue = lower(
      'external-value-bound.ts',
      'export function maximum(left: number, right: number): number { return Math.max(left, right); }',
    );
    const values = lower(
      'external-values.ts',
      'export function create(): Promise<number> { const values = new Map<string, number>(); values; return Promise.resolve(1); }',
    );
    const output = emitIrModuleRust(supported.module).contents;
    const valueOutput = emitIrModuleRust(values.module).contents;

    expect(output).toContain('values: std::collections::HashMap<String, f64>');
    expect(output).toContain('bytes: Vec<u8>');
    expect(output).toContain('task: FlightTask<f64>');
    expect(valueOutput).toContain('std::collections::HashMap::new()');
    expect(valueOutput).toContain('FlightTask::resolve(1.0)');
    expect(() => emitIrModuleRust(missing.module)).toThrow(
      'runtime external symbol binding plan is incomplete (missing: WeakMap[type])',
    );
    // `Math` binds through its members rather than as a symbol, because it has no target name of
    // its own: `Math.max` is `f64::max` and there is nothing to call `Math`.
    expect(emitIrModuleRust(boundValue.module).contents).toContain('return f64::max(left, right);');
  });

  it('elects C-style for lowering and default-parameter declaration expansion', () => {
    const loop = lower(
      'loop.ts',
      'export function total(limit: number): number { let total = 0; for (let index = 0; index < limit; index++) { total += index; } return total; }',
    );
    const defaults = lower(
      'defaults.ts',
      'export function scale(value: number, factor: number = 2): number { return value * factor; }',
    );
    const output = emitIrModuleRust(loop.module).contents;

    expect(output).toContain('let mut index: f64 = 0.0;');
    expect(output).toContain('while index < limit');
    expect(output).toContain('index += 1.0;');
    expect(emitIrModuleRust(defaults.module).contents).toContain('factor: Option<f64>');
  });

  it('emits one overload implementation and calls its expanded default ABI', () => {
    const result = lower(
      'overload-default.ts',
      `
        function choose(value: number): number;
        function choose(value: number, radix?: number): number;
        function choose(value: number, radix = 10): number { return value + radix; }
        export function read(): number { return choose(1); }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output.match(/fn choose/gu)).toHaveLength(1);
    expect(output).toContain('fn choose(value: f64, radix: Option<f64>) -> f64');
    expect(output).toContain('let radix = radix.unwrap_or_else(|| 10.0);');
    expect(output).toContain('return choose(1.0, None);');
  });

  it('emits one class method overload implementation and calls its expanded default ABI', () => {
    const result = lower(
      'method-overload-default.ts',
      `
        export class Picker {
          choose(value: number): number;
          choose(value: number, radix?: number): number;
          choose(value: number, radix = 10): number { return value + radix; }
        }
        export function read(picker: Picker): number { return picker.choose(1); }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output.match(/fn choose/gu)).toHaveLength(1);
    expect(output).toContain('pub fn choose(&self, value: f64, radix: Option<f64>) -> f64');
    expect(output).toContain('return picker.choose(1.0, None);');
  });

  it('refuses an overloaded constructor until Rust initialization lowering owns its ABI', () => {
    const result = lower(
      'constructor-overload-default.ts',
      `
        export class Box {
          constructor(value: number);
          constructor(value: number, radix?: number);
          constructor(value: number, radix = 10) { value; radix; }
        }
        export function create(): Box { return new Box(1); }
      `,
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'class Box constructor requires Rust initialization lowering',
    );
  });

  it('refuses local constructor calls until Rust initialization lowering owns the factory', () => {
    const result = lower(
      'local-constructor.ts',
      'export class Box {} export function create(): Box { return new Box(); }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'class constructor calls require Rust initialization lowering',
    );
  });

  it('refuses runtime constructor arities absent from the versioned Rust ABI plan', () => {
    const result = lower(
      'runtime-constructor-argument.ts',
      'export function create(): Uint8Array { return new Uint8Array(3); }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'runtime external constructor ABI plan is incomplete (missing: Uint8Array[value](1))',
    );
  });

  it('elects fixed array binding lowering and reports residual destructuring semantics', () => {
    const fixed = lower(
      'array-binding.ts',
      'export function select(values: [number, number, number]): number { const [first, , third]: [number, number, number] = values; third; return first; }',
    );
    const rest = lower(
      'array-rest.ts',
      'export function select(values: [number, ...number[]]): number[] { const [first, ...rest]: [number, ...number[]] = values; first; return rest; }',
    );
    const defaulted = lower(
      'array-default.ts',
      'export function select(values: [number?]): number { const [first = 0]: [number?] = values; return first; }',
    );
    const requiredDefault = lower(
      'array-required-default.ts',
      'export function select(values: [number | undefined]): number { const [first = 0]: [number | undefined] = values; return first; }',
    );
    const dynamicIndex = lower(
      'tuple-index.ts',
      'export function select(values: [number], index: number): number { return values[index]; }',
    );
    const nestedDefault = lower(
      'array-nested-default.ts',
      'export function select(values: [[number]?]): number { const [[first] = [1]]: [[number]?] = values; return first; }',
    );
    const fixedRest = lower(
      'array-fixed-rest.ts',
      'export function select(values: [number, string, boolean]): [string, boolean] { const [first, ...rest]: [number, string, boolean] = values; first; return rest; }',
    );
    const emptyRest = lower(
      'array-empty-rest.ts',
      'export function select(values: [number]): [] { const [first, ...rest]: [number] = values; first; return rest; }',
    );
    const optionalRest = lower(
      'array-optional-rest.ts',
      'export function select(values: [number, string?]): [string?] { const [first, ...rest]: [number, string?] = values; first; return rest; }',
    );
    const mixedRest = lower(
      'array-mixed-rest.ts',
      'export function select(values: [number, string, ...boolean[]]): [string, ...boolean[]] { const [first, ...rest]: [number, string, ...boolean[]] = values; first; return rest; }',
    );
    const iteration = lower(
      'array-iteration.ts',
      'export function visit(rows: Array<[number, number]>): number { for (const [first, second] of rows) { second; return first; } return 0; }',
    );
    const output = emitIrModuleRust(fixed.module).contents;

    expect(output).toContain('let array_pattern_value: (f64, f64, f64) = values;');
    expect(output).toContain('let first: f64 = array_pattern_value.0;');
    expect(output).toContain('let third: f64 = array_pattern_value.2;');
    expect(emitIrModuleRust(defaulted.module).contents).toContain(
      'let first: f64 = array_pattern_value.0.unwrap_or_else(|| 0.0);',
    );
    expect(emitIrModuleRust(requiredDefault.module).contents).toContain(
      'let first: f64 = array_pattern_value.0.unwrap_or_else(|| 0.0);',
    );
    expect(emitIrModuleRust(rest.module).contents).toContain('let rest: Vec<f64> = array_pattern_value.1;');
    expect(emitIrModuleRust(nestedDefault.module).contents).toContain('unwrap_or_else(|| (1.0,))');
    expect(emitIrModuleRust(fixedRest.module).contents).toContain(
      'let rest: (String, bool) = (array_pattern_value.1, array_pattern_value.2);',
    );
    expect(emitIrModuleRust(emptyRest.module).contents).toContain('let rest: () = ();');
    expect(emitIrModuleRust(optionalRest.module).contents).toContain(
      'let rest: (Option<String>,) = (array_pattern_value.1,);',
    );
    expect(emitIrModuleRust(mixedRest.module).contents).toContain(
      'let rest: (String, Vec<bool>) = (array_pattern_value.1, array_pattern_value.2);',
    );
    expect(emitIrModuleRust(iteration.module).contents).toContain(
      'for array_pattern_value in rows {\n    let first: f64 = array_pattern_value.0;\n    let second: f64 = array_pattern_value.1;',
    );
    expect(() => emitIrModuleRust(dynamicIndex.module)).toThrow(
      'tuple projection requires one statically known nonnegative integer index',
    );
  });

  it('elects flat object binding lowering and clones closed residual object-rest fields', () => {
    const flat = lower(
      'object-binding.ts',
      `
        type Shape = { value: number; other: boolean };
        export function select(source: Shape): number {
          const { value }: Shape = source;
          return value;
        }
      `,
    );
    const rest = lower(
      'object-rest.ts',
      `
        type Shape = { value: number; other: boolean };
        export function select(source: Shape): void {
          const { value, ...rest }: Shape = source;
          value;
          rest.other;
        }
      `,
    );
    const output = emitIrModuleRust(flat.module).contents;

    expect(output).toContain('let object_pattern_value: Shape = source;');
    expect(output).toContain('let value: f64 = object_pattern_value.value;');
    const restOutput = emitIrModuleRust(rest.module).contents;
    expect(restOutput).toContain('struct ObjectRestRecord {\n  pub other: bool,\n}');
    expect(restOutput).toContain('ObjectRestRecord { other: object_pattern_value.other.clone(), }');
  });

  it('interns identical object-rest residual shapes once at module scope', () => {
    const result = lower(
      'object-rest-interning.ts',
      `
        type Shape = { value: number; other: boolean };
        function first(source: Shape): void { const { value, ...rest }: Shape = source; rest.other; }
        function second(source: Shape): void { const { value, ...rest }: Shape = source; rest.other; }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output.match(/struct ObjectRestRecord/g)).toHaveLength(1);
    expect(output.match(/ObjectRestRecord \{/g)).toHaveLength(3);
  });

  it('interns residual record shapes independently of source property order', () => {
    const result = lower(
      'object-rest-order.ts',
      `
        type First = { removed: number; alpha: boolean; beta: string };
        type Second = { removed: number; beta: string; alpha: boolean };
        function first(source: First): void { const { removed, ...rest }: First = source; removed; rest.alpha; }
        function second(source: Second): void { const { removed, ...rest }: Second = source; removed; rest.beta; }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output.match(/struct ObjectRestRecord/g)).toHaveLength(1);
    expect(output).not.toContain('struct ObjectRestRecord_2');
  });

  it('elects function-scoped variable hoisting after destructuring normalization', () => {
    const named = lower(
      'variable-hoisting.ts',
      'export function select(): number { { var value: number = 1; } return value; }',
    );
    const pattern = lower(
      'variable-pattern-hoisting.ts',
      'export function select(values: [number, string]): string { var [first, second]: [number, string] = values; first; return second; }',
    );
    const iteration = lower(
      'variable-iteration-hoisting.ts',
      'export function visit(values: number[]): void { for (var value of values) value += 1; }',
    );
    const namedOutput = emitIrModuleRust(named.module).contents;
    const patternOutput = emitIrModuleRust(pattern.module).contents;
    const iterationOutput = emitIrModuleRust(iteration.module).contents;

    expect(namedOutput).toContain('let value: f64;\n  {\n    value = 1.0;\n  }\n  return value;');
    expect(patternOutput).toContain(
      'let first: f64;\n  let second: String;\n  let array_pattern_value: (f64, String) = values;\n  first = array_pattern_value.0;\n  second = array_pattern_value.1;',
    );
    expect(iterationOutput).toContain(
      'let mut value: f64;\n  for variable_hoisting_iteration_value in values {\n    value = variable_hoisting_iteration_value;\n    value += 1.0;',
    );
  });

  it('emits contextual fixed tuple expressions with explicit optional positions', () => {
    const result = lower(
      'tuple-expression.ts',
      "export function create(): [number, string?] { const present: [number, string?] = [1, 'flight']; const value: [number, string?] = [2]; present; return value; }",
    );

    expect(result.diagnostics).toEqual([]);
    expect(emitIrModuleRust(result.module).contents).toContain(
      'let present: (f64, Option<String>) = (1.0, Some("flight".to_owned()));',
    );
    expect(emitIrModuleRust(result.module).contents).toContain('let value: (f64, Option<String>) = (2.0, None);');
  });

  it('emits statically ordered for-in keys, from a literal or from a written closed shape', () => {
    const fixed = lower(
      'static-for-in.ts',
      "export function first(): string { for (const key in { second: 2, 10: 10, 2: 2, first: 1 }) return key; return ''; }",
    );
    const declared = lower(
      'declared-for-in.ts',
      "interface Values { value: number } export function first(values: Values): string { for (const key in values) return key; return ''; }",
    );
    const open = lower(
      'open-for-in.ts',
      "interface Values { value?: number } export function first(values: Values): string { for (const key in values) return key; return ''; }",
    );

    expect(emitIrModuleRust(fixed.module).contents).toContain(
      'for key in ["2".to_owned(), "10".to_owned(), "second".to_owned(), "first".to_owned()]',
    );
    expect(emitIrModuleRust(declared.module).contents).toContain('for key in ["value".to_owned()]');
    // An optional property means a key that may not be present, so the shape is not closed.
    expect(() => emitIrModuleRust(open.module)).toThrow('object key iteration requires closed key evidence');
  });

  it('refuses effectful static-key object iteration until structural-object evaluation is elected', () => {
    const result = lower(
      'effectful-for-in.ts',
      'function mark(): number { return 1; } export function visit(): void { for (const key in { value: mark() }) key; }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'effectful object key iteration requires Rust structural-object evaluation lowering',
    );
  });

  it('emits optional property, element, and call projections from neutral type evidence', () => {
    const property = lower(
      'optional-property.ts',
      'interface Value { count: number } export function count(value: Value | undefined): number | undefined { return value?.count; }',
    );
    const element = lower(
      'optional-element.ts',
      'export function first(values: number[] | undefined, index: number): number | undefined { return values?.[index]; }',
    );
    const call = lower(
      'optional-call.ts',
      'export function invoke(callback: ((value: number) => number) | undefined): number | undefined { return callback?.(1); }',
    );
    const staticallyPresent = lower(
      'statically-present-element.ts',
      'export function first(values: number[]): number { return values?.[0]; }',
    );

    expect(emitIrModuleRust(property.module).contents).toContain(
      'value.as_ref().map(|optional_chain_value| optional_chain_value.count.clone())',
    );
    expect(emitIrModuleRust(element.module).contents).toContain(
      'values.as_ref().and_then(|optional_chain_value| optional_chain_value.get(index as usize).cloned())',
    );
    expect(emitIrModuleRust(call.module).contents).toContain(
      'callback.as_ref().map(|optional_chain_value| optional_chain_value(1.0))',
    );
    expect(emitIrModuleRust(staticallyPresent.module).contents).toContain('return values[0.0 as usize];');
  });

  it('represents observable entry undefined only inside a nullable Rust domain', () => {
    const nullable = lower(
      'nullable-entry.ts',
      'export function read(): number | undefined { var value: number | undefined; return value; }',
    );
    const nonnullable = lower(
      'nonnullable-entry.ts',
      'export function read(): number { var value: number; return value; }',
    );

    expect(emitIrModuleRust(nullable.module).contents).toContain('let mut value: Option<f64> = None;');
    expect(() => emitIrModuleRust(nonnullable.module)).toThrow(
      'function-scoped variable value may be read before initialization; undefined-preserving lowering is required',
    );
  });

  it('emits expression-position destructuring with the original aggregate completion value', () => {
    const result = lower(
      'assignment-completion.ts',
      'export function assign(tuple: [number]): [number] { let value = 0; return ([value] = tuple); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('let destructuring_assignment_value: (f64,) = tuple;');
    expect(output).toContain('value = destructuring_assignment_value.0;');
    expect(output).toContain('destructuring_assignment_value }');
    expect(output).not.toContain('({ let destructuring_assignment_value');
  });

  it('propagates abrupt completion from an idiomatic Rust statement-value block', () => {
    const result = lower(
      'assignment-abrupt-completion.ts',
      'export function assign(tuple: [number]): [number] { let value = 0; return ([value] = tuple); }',
    );
    const declaration = result.module.declarations[0];
    const returned = declaration?.kind === 'function' ? declaration.body[1] : undefined;
    const carrier = returned?.kind === 'return' ? returned.expression : undefined;
    if (carrier?.kind !== 'call' || carrier.callee.kind !== 'function') {
      throw new Error('Expected statement-value carrier');
    }
    const body = carrier.callee.body as IrStatement[];
    body.unshift({
      condition: { kind: 'literal', value: true },
      consequent: {
        expression: {
          elements: [{ expression: { kind: 'literal', value: 7 }, optional: false }],
          kind: 'tuple',
        },
        kind: 'return',
      },
      kind: 'if',
    });

    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('return { if true {');
    expect(output).toContain('return (7.0,);');
    expect(output).not.toContain('(|');
  });

  it('clones fixed tuple spread fields through collision-free sequential evaluation carriers', () => {
    const result = lower(
      'tuple-spread.ts',
      `
        function marker(value: number): number { return value; }
        function optional(): [boolean?] { return []; }
        export function combine(tupleSpreadElement: number, tupleSpreadValue: [number, string]): [number, number, string, boolean?] {
          const output: [number, number, string, boolean?] = [marker(tupleSpreadElement), ...tupleSpreadValue, ...optional()];
          marker(tupleSpreadValue[0]);
          return output;
        }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(result.diagnostics).toEqual([]);
    expect(output).toContain(
      '{ let tuple_spread_element_2 = marker(tuple_spread_element); let tuple_spread_value_2 = &(tuple_spread_value); let tuple_spread_value_3 = &(optional()); (tuple_spread_element_2, tuple_spread_value_2.0.clone(), tuple_spread_value_2.1.clone(), tuple_spread_value_3.0.clone()) }',
    );
    expect(output).toContain('marker(tuple_spread_value.0);');
  });

  it('refuses tuple spread fields without clone-safe Rust ownership evidence', () => {
    const result = lower(
      'tuple-spread-object.ts',
      'type Item = { value: number }; export function copy(values: [Item]): [Item] { const copied: [Item] = [...values]; return copied; }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'fixed tuple spread source index 0 lacks clone-safe Rust ownership evidence',
    );
  });

  it('reports pass-named failures from the elected lowering plan', () => {
    const result = lower(
      'unsafe-loop.ts',
      'export function loop(): void { for (let index = 0; index < 1; index++) { try { continue; } finally { index; } } }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'Compiler lowering pass c-style-for failed for @flighthq/math/packages/math/src/unsafe-loop.ts: continue across a finally block requires completion-record lowering',
    );
  });

  it('preserves labeled exits through C-style loops and switch state machines', () => {
    const loop = lower(
      'labeled-for.ts',
      'export function scan(): void { outer: for (let index = 0; index < 2; index++) { switch (index) { case 0: continue outer; default: break outer; } } }',
    );
    const stateMachine = lower(
      'labeled-switch-state.ts',
      'export function scan(running: boolean, choice: number): void { outer: while running { switch (choice) { case 0: { const local = choice; local; } case 1: continue outer; default: break outer; } } }',
    );
    const nested = lower(
      'nested-labeled-for.ts',
      'export function scan(): void { outer: for (let index = 0; index < 2; index++) { for (let inner = 0; inner < 2; inner++) { continue outer; } } }',
    );
    const loopOutput = emitIrModuleRust(loop.module).contents;
    const stateOutput = emitIrModuleRust(stateMachine.module).contents;
    const nestedOutput = emitIrModuleRust(nested.module).contents;

    expect(loopOutput).toContain("'outer: while index < 2.0");
    expect(loopOutput).toMatch(/index \+= 1\.0;\s+continue 'outer;/u);
    expect(loopOutput).toContain("break 'outer;");
    expect(stateOutput).toContain('switch_fallthrough_state');
    expect(stateOutput).toContain("'outer: while running");
    expect(stateOutput).toContain("continue 'outer;");
    expect(stateOutput).toContain("break 'outer;");
    expect(nestedOutput).toMatch(/index \+= 1\.0;\s+continue 'outer;/u);
    expect(nestedOutput).not.toMatch(/inner \+= 1\.0;\s+continue 'outer;/u);
  });

  it('emits numeric enums with their computed discriminants', () => {
    const numeric = lower('mode.ts', 'export enum Mode { A = 1, B, C = Mode.A << 3, D }');

    expect(emitIrModuleRust(numeric.module).contents).toContain('D = 9,');
  });

  it('emits type-only imports and their references from one type-space identity', () => {
    const result = lower(
      'type-import.ts',
      "import type { sourceType as localType } from './types.js'; export type Alias = localType;",
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('use crate::types::SourceType as LocalType;');
    expect(output).toContain('pub type Alias = LocalType;');
  });

  it('keeps local bindings distinct from same-named module constants', () => {
    const result = lower(
      'guard.ts',
      'export const limit: number = 4; export function check(value: number): number { const limit: number = 9; if (value > limit) throw "too big"; return limit; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('const LIMIT: f64 = 4.0;');
    expect(output).toContain('let limit: f64 = 9.0;');
    expect(output).toContain('if value > limit {');
    expect(output).toContain('panic!("{:?}",');
    expect(output).not.toContain('panic!("{{:?}}"');
  });

  it('restores module bindings after nested local shadowing', () => {
    const result = lower(
      'scope.ts',
      'export const limit: number = 4; export function read(flag: boolean): number { if flag { const limit: number = 9; return limit; } return limit; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('return limit;');
    expect(output).toContain('return LIMIT;');
  });

  it('keeps parameters and nested closure parameters local when they shadow module constants', () => {
    const result = lower(
      'parameters.ts',
      'export const limit: number = 4; export function read(limit: number): number { return limit; } export function makeReader(): (limit: number) => number { return (limit: number): number => limit; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('pub fn read(limit: f64) -> f64 {\n  return limit;');
    expect(output).toContain('return Rc::new(move |limit| limit);');
    expect(output.match(/return LIMIT;/gu)).toBeNull();
  });

  it('emits supported assignment, binary, and prefix operators from closed target mappings', () => {
    const result = lower(
      'operators.ts',
      'export function operators(left: number, right: number, disabled: boolean): boolean { let value: number = left; value += right; return value === right && !disabled; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('value += right;');
    expect(output).toContain('return (value == right) && !disabled;');
  });

  it('emits string concatenation as format! and refuses non-direct operator domains', () => {
    const strings = lower(
      'string-operators.ts',
      'export function join(left: string, right: string): string { return left + right; }',
    );
    const unknown = lower(
      'unknown-operators.ts',
      'export function both(left: any, right: boolean): boolean { return left && right; }',
    );
    const loose = lower(
      'loose-equality.ts',
      'export function equal(left: number, right: number): boolean { return left == right; }',
    );

    expect(emitIrModuleRust(strings.module).contents).toContain('format!("{}{}", left, right)');
    expect(() => emitIrModuleRust(unknown.module)).toThrow(
      'operator && on unknown and boolean requires Rust type-directed lowering',
    );
    expect(() => emitIrModuleRust(loose.module)).toThrow(
      'operator == on number and number requires Rust type-directed lowering',
    );
  });

  it('emits exponentiation as f64::powf and bitwise operators with i32 casts', () => {
    const power = lower('power.ts', 'export function power(a: number, b: number): number { return a ** b; }');
    const powerAssign = lower(
      'power-assign.ts',
      'export function power(a: number, b: number): number { let x: number = a; x **= b; return x; }',
    );
    const bitAnd = lower('bit-and.ts', 'export function bitAnd(a: number, b: number): number { return a & b; }');
    const bitAndAssign = lower(
      'bit-and-assign.ts',
      'export function bitAnd(a: number, b: number): number { let x: number = a; x &= b; return x; }',
    );

    expect(emitIrModuleRust(power.module).contents).toContain('return f64::powf(a, b);');
    expect(emitIrModuleRust(powerAssign.module).contents).toContain('x = f64::powf(x, b);');
    expect(emitIrModuleRust(bitAnd.module).contents).toContain('((a as i32) & (b as i32)) as f64');
    expect(emitIrModuleRust(bitAndAssign.module).contents).toContain('x = (((x as i32) & (b as i32)) as f64)');
  });

  it('rejects module facades and emits normalized switch fallthrough', () => {
    const barrel = lower('barrel.ts', "export * from './other.js';");
    const fallthrough = lower(
      'switch.ts',
      'export function choose(a: number): number { switch (a) { case 1: case 2: return 2; default: return 0; } }',
    );
    const output = emitIrModuleRust(fallthrough.module).contents;

    expect(() => emitIrModuleRust(barrel.module)).toThrow('module-facade lowering');
    expect(output).toContain('let switch_value = a;');
    expect(output).toContain('if switch_value == 1.0 {\n      return 2.0;\n    }\n    else if switch_value == 2.0');
  });

  it('emits binding-sensitive switch fallthrough through an identity-safe state loop', () => {
    const result = lower(
      'switch-binding-state.ts',
      'function mark(): void {} export function choose(a: number): number { switch (a) { case 1: mark(); case 2: const local: number = a; return local; default: return 0; } }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('let mut switch_fallthrough_state: f64 = -1.0;');
    expect(output).toContain('while switch_fallthrough_state >= 0.0');
    expect(output.match(/let local/g)).toHaveLength(1);
  });

  it.each([
    [
      'keyword unary',
      'export function type(a: number): string { return typeof a; }',
      'typeof requires Rust semantic lowering',
    ],
    [
      'postfix unary',
      'export function increment(a: number): number { return a++; }',
      'postfix ++ requires value-preserving Rust lowering',
    ],
    [
      'prefix update unary',
      'export function increment(a: number): number { return ++a; }',
      'prefix ++ requires value-preserving Rust lowering',
    ],
    [
      'prefix unary void',
      'export function discard(a: number): void { void a; }',
      'void requires Rust semantic lowering',
    ],
  ])('refuses unsupported %s operators explicitly', (family, source, message) => {
    const result = lower(`${family.replaceAll(' ', '-')}-operator.ts`, source);

    expect(() => emitIrModuleRust(result.module)).toThrow(message);
  });

  it('emits nullable and optional parameters but rejects bare undefined expressions', () => {
    const nullable = lower(
      'nullable.ts',
      'export function nullable(value: number | null): number | null { return value; }',
    );
    const optional = lower('optional.ts', 'export function optional(value?: number): number { return 0; }');
    const undefinedNullable = lower(
      'undefined-nullable.ts',
      'export function undefinedNullable(value: number | undefined): number { return 0; }',
    );
    const nullableReturn = lower(
      'nullable-return.ts',
      'export function nullableReturn(): number | null { return null; }',
    );
    const undefinedValue = lower('missing.ts', 'export function missing(): undefined { return undefined; }');

    expect(emitIrModuleRust(nullable.module).contents).toContain('pub fn nullable(value: Option<f64>) -> Option<f64>');
    expect(emitIrModuleRust(optional.module).contents).toContain('pub fn optional(value: Option<f64>) -> f64');
    expect(emitIrModuleRust(undefinedNullable.module).contents).toContain(
      'pub fn undefined_nullable(value: Option<f64>) -> f64',
    );
    expect(emitIrModuleRust(nullableReturn.module).contents).toContain(
      'pub fn nullable_return() -> Option<f64> {\n  return None;',
    );
    expect(() => emitIrModuleRust(undefinedValue.module)).toThrow(
      'undefined expressions require Rust Option-aware lowering',
    );
  });

  it('emits fixed optional-parameter call carriers as Rust Some and None', () => {
    const result = lower(
      'optional-call.ts',
      'function choose(value?: number): number { return 0; } export function read(): number { choose(); return choose(1); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('fn choose(value: Option<f64>) -> f64');
    expect(output).toContain('choose(None);');
    expect(output).toContain('return choose(Some(1.0));');
  });

  it('combines distinct optional and default Rust call carriers', () => {
    const result = lower(
      'mixed-call.ts',
      'function choose(first?: number, second = 2): number { return second; } export function read(): number { return choose(); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('fn choose(first: Option<f64>, second: Option<f64>) -> f64');
    expect(output).toContain('return choose(None, None);');
  });

  it('preserves distinct undefined and null carriers for optional nullable parameters and arguments', () => {
    const result = lower(
      'optional-nullable.ts',
      `
        function choose(value?: number | null): void { value; }
        export function invoke(value: number | null): void { choose(); choose(1); choose(null); choose(value); }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('fn choose(value: Option<Option<f64>>) -> ()');
    expect(output).toContain('choose(None);');
    expect(output).toContain('choose(Some(Some(1.0)));');
    expect(output).toContain('choose(Some(None));');
    expect(output).toContain('choose(Some(value));');
  });

  it('refuses a type domain that still collapses null and undefined into one Rust sentinel', () => {
    const result = lower(
      'ambiguous-nullish.ts',
      'export function preserve(value: number | null | undefined): number | null | undefined { return value; }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'types containing both null and undefined require distinct Rust sentinels',
    );
  });

  it('refuses dynamic and missing calls while erasing fixed extras after their evaluation', () => {
    const spread = lower(
      'spread-call.ts',
      'function choose(first: number, second?: number): number { return first; } export function read(values: [number]): number { return choose(...values); }',
    );
    const extra = lower(
      'extra-call.ts',
      'function choose(first?: number): number { return 0; } export function read(): number { return choose(1, 2); }',
    );
    const missing = lower(
      'missing-call.ts',
      'function choose(first: number, second?: number): number { return first; } export function read(): number { return choose(); }',
    );
    const property = lower(
      'property-extra-call.ts',
      'export class Picker { choose(value: number): number { return value; } } export function read(picker: Picker): number { return picker.choose(1, 2); }',
    );

    expect(() => emitIrModuleRust(spread.module)).toThrow(
      'spread calls into optional or default parameters require Rust ABI expansion lowering',
    );
    const output = emitIrModuleRust(extra.module).contents;
    expect(output).toContain('let call_argument0 = 1.0;');
    expect(output).toContain('let call_argument1 = 2.0;');
    expect(output).toContain('choose(Some(call_argument0))');
    expect(output).not.toContain('choose(Some(1.0), 2.0)');
    expect(output.indexOf('call_argument0 = 1.0')).toBeLessThan(output.indexOf('call_argument1 = 2.0'));
    expect(output.indexOf('call_argument1 = 2.0')).toBeLessThan(output.indexOf('choose(Some(call_argument0))'));
    expect(() => emitIrModuleRust(missing.module)).toThrow('missing required call argument at position 0');
    expect(() => emitIrModuleRust(property.module)).toThrow('fixed extra call arguments remain after erasure');
  });

  it('emits contextual undefined option values as Rust None', () => {
    const result = lower(
      'contextual-undefined.ts',
      `
        function fallback(value = 1): number { return value; }
        function optional(value?: number): number { return 0; }
        export function maybe(): number | undefined {
          fallback((undefined as number | undefined));
          optional((undefined as number | undefined));
          return undefined;
        }
      `,
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('fallback(None);');
    expect(output).toContain('optional(None);');
    expect(output).toContain('return None;');
  });

  it('emits structurally flattened generic interface inheritance', () => {
    const result = lower(
      'interface-inheritance.ts',
      'interface Base<Value> { value: Value; } export interface Child extends Base<number> { own: boolean; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('pub struct Child {\n  pub value: f64,\n  pub own: bool,\n}');
  });

  it('emits a local binding named undefined without confusing it with the ambient value', () => {
    const result = lower(
      'local-undefined.ts',
      'export function read(value: number): number { const undefined: number = value; return undefined; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('let undefined: f64 = value;');
    expect(output).toContain('return undefined;');
  });

  it('uses binding identity to keep renamed declarations and references aligned', () => {
    const result = lower('rename.ts', 'export function read(): number { return read(); }');
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const renamed = {
      ...result.module,
      declarations: [{ ...declaration, binding: { ...declaration.binding, name: 'renamed' } }],
    };
    const output = emitIrModuleRust(renamed).contents;

    expect(output).toContain('pub fn renamed() -> f64');
    expect(output).toContain('return renamed();');
  });

  it('allocates collision-free Rust names for shadowed and case-normalized bindings', () => {
    const result = lower(
      'collisions.ts',
      'export function choose(fooBar: number, foo_bar: number): number { { const fooBar: number = foo_bar; fooBar; } return fooBar + foo_bar; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('pub fn choose(foo_bar: f64, foo_bar_2: f64) -> f64');
    expect(output).toContain('let foo_bar_3: f64 = foo_bar_2;');
    expect(output).toContain('foo_bar_3;');
    expect(output).toContain('return foo_bar + foo_bar_2;');
  });

  it('keeps a public target name fixed while renaming an internal collision', () => {
    const result = lower(
      'internal-collision.ts',
      'function fooBar(value: number): number { return value; } export function foo_bar(value: number): number { return fooBar(value); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('fn foo_bar_2(value: f64) -> f64');
    expect(output).toContain('pub fn foo_bar(value: f64) -> f64');
    expect(output).toContain('return foo_bar_2(value);');
  });

  it('refuses public value and type collisions introduced by Rust normalization', () => {
    const values = lower(
      'value-collisions.ts',
      'export function fooBar(value: number): number { return value; } export function foo_bar(value: number): number { return value + 1; }',
    );
    const result = lower('type-collisions.ts', 'export type fooBar = number; export type foo_bar = fooBar;');

    try {
      emitIrModuleRust(values.module);
      expect.unreachable('Expected public Rust target names to collide');
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
      expect(error).toMatchObject({
        backend: 'rust',
        code: 'unsupported-ir',
        kind: 'backend-emission',
        message: expect.stringContaining('public declarations share fixed Rust target name foo_bar'),
      });
    }
    expect(() => emitIrModuleRust(result.module)).toThrow('public declarations share fixed Rust target name FooBar');
  });

  it('lowers class state and expands default-parameter ABI at declarations and calls', () => {
    const staticField = lower('config.ts', 'export class Config { static limit: number = 3; value: number = 1; }');
    const computedStatic = lower('computed.ts', 'export class Config { static limit: number = 1 + 2; }');
    const defaultParameter = lower(
      'default.ts',
      'function choose(first: number, second: number = first + 1): number { return second; } export function read(): number { return choose(1); }',
    );

    // A static field is one value shared by the type, which Rust has as an associated constant — but
    // only for a constant initializer, since an associated constant has nowhere to run an expression.
    expect(emitIrModuleRust(staticField.module).contents).toContain('pub const LIMIT: f64 = 3.0;');
    expect(() => emitIrModuleRust(computedStatic.module)).toThrow('static fields require a constant initializer');
    const output = emitIrModuleRust(defaultParameter.module).contents;
    expect(output).toContain('fn choose(first: f64, second: Option<f64>)');
    expect(output).toContain('let second = second.unwrap_or_else(|| (first + 1.0));');
    expect(output).toContain('return choose(1.0, None);');
  });

  it('declines the neutral task lowering and emits native async instead', () => {
    // The state-machine lowering exists for a target with no suspension of its own. Rust has one, so
    // it emits `async fn` and `.await` and lets rustc build the machine. This is the first place the
    // backend-elected pass library actually diverges between targets.
    const module = lower(
      'drain.ts',
      'export async function drain(task: Promise<number>, again: boolean): Promise<number> { let last: number = 0; while again { last = await task; again = false; } return last; }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('pub async fn drain(task: FlightTask<f64>, mut again: bool) -> f64 {');
    // `.await` consumes the future; the source's await does not consume the promise, so a task the
    // loop reaches again is cloned.
    expect(output).toContain('last = task.clone().await;');
  });

  it('refuses an async function whose declared return is not a task type', () => {
    const module = lower('broken.ts', 'export async function broken(value: number): Promise<number> { return value; }');
    const declaration = module.module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected a function declaration');
    const rewritten = {
      ...module.module,
      declarations: [{ ...declaration, returns: { kind: 'primitive' as const, name: 'number' as const } }],
    };

    expect(() => emitIrModuleRust(rewritten)).toThrow('an async function must return a task type');
  });

  it('elects a shared receiver for a method that only observes its own state', () => {
    // `&mut self` on every method makes each call exclusive, so two reads of one value cannot
    // overlap. The evidence for which methods need exclusivity is already in their bodies.
    const module = lower(
      'counter.ts',
      'export class Counter { total: number; step: number; read(): number { return this.total; } bump(): void { this.total = this.total + this.step; } nested(): void { if this.step > 0 { this.total = 1; } } }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('pub fn read(&self) -> f64 {');
    expect(output).toContain('pub fn bump(&mut self) -> () {');
    // A mutation nested inside control flow is still a mutation.
    expect(output).toContain('pub fn nested(&mut self) -> () {');
    // Calling a method that mutates needs the same receiver the callee needs, transitively: a
    // `&self` method calling a `&mut self` one is a Rust error, not a style question.
    const transitive = lower(
      'transitive.ts',
      'export class Counter { total: number = 0; bump(): void { this.total = 1; } twice(): void { this.bump(); } thrice(): void { this.twice(); } read(): number { return this.total; } }',
    );
    const transitiveOutput = emitIrModuleRust(transitive.module).contents;
    expect(transitiveOutput).toContain('pub fn twice(&mut self) -> () {');
    expect(transitiveOutput).toContain('pub fn thrice(&mut self) -> () {');
    expect(transitiveOutput).toContain('pub fn read(&self) -> f64 {');

    // A compound assignment writes through its target the same way a plain one does.
    expect(
      emitIrModuleRust(
        lower('bump.ts', 'export class Counter { total: number = 0; tick(): void { this.total += 1; } }').module,
      ).contents,
    ).toContain('pub fn tick(&mut self) -> () {');
  });

  it('emits a string enum as unit variants carrying their source values both ways', () => {
    const module = lower('lane.ts', "export enum Lane { Fast = 'fast', Safe = 'safe' }");
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('pub enum Lane {');
    expect(output).toContain('      Lane::Fast => "fast",');
    expect(output).toContain('      "safe" => Some(Lane::Safe),');
    // The source language treats the value as the enum, so both directions are emitted.
    expect(output).toContain("pub fn as_str(&self) -> &'static str {");
    expect(output).toContain('pub fn from_str(value: &str) -> Option<Self> {');
  });

  it('refuses an enum whose members do not share one discriminant domain', () => {
    const module = lower('mixed.ts', "export enum Mixed { First = 1, Second = 'second' }");

    expect(() => emitIrModuleRust(module.module)).toThrow('requires one discriminant domain for Rust');
  });

  it('turns field initializers into an associated constructor in the plan order', () => {
    // Rust has no implicit constructor, so a field initializer is a constructor obligation. The
    // neutral plan already decides when each field is initialized; this emits that decision.
    const module = lower(
      'counter.ts',
      "export class Counter { private step: number = 1; readonly label: string = 'counter'; advance(by: number): number { return by + this.step; } }",
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('pub fn new() -> Self {');
    expect(output).toContain('      step: 1.0,');
    expect(output).toContain('      label: "counter".to_owned(),');
  });

  it('refuses a class that initializes only some of its fields', () => {
    const module = lower('partial.ts', 'export class Partial { first: number = 1; second: number; }');

    expect(() => emitIrModuleRust(module.module)).toThrow('partially initializes its fields');
  });

  it('elects mut for a parameter the body rebinds, and only for that one', () => {
    // Rust rejects an assignment to a parameter that is not `mut`, so emitting without it produced
    // source that could not compile — and pinning bytes cannot catch that. Emitting `mut` on every
    // parameter would instead warn on each one that is only read, so the evidence decides.
    const module = lower(
      'rebind.ts',
      'export function drain(again: boolean, kept: number): number { again = false; return again ? kept : kept; }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('pub fn drain(mut again: bool, kept: f64) -> f64 {');
  });

  it('emits an implemented shape as a trait and puts its methods in the impl block', () => {
    // A shape a class implements is a contract on behaviour, which Rust spells as a trait. A shape
    // nothing implements is data, which stays a struct — emitting that as a trait would make an
    // ordinary object type unconstructible.
    const module = lower(
      'trait.ts',
      'export interface Advancer { advance(by: number): number; } export class Counter implements Advancer { step: number = 1; advance(by: number): number { return by + this.step; } reset(): void { this.step = 1; } }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('pub trait Advancer {');
    expect(output).toContain('  fn advance(&self, by: f64) -> f64;');
    expect(output).toContain('impl Advancer for Counter {');
    // The trait's method is in the trait impl and the class's own method is in the inherent one.
    expect(output).toContain('impl Counter {');
    expect(output).toContain('  pub fn reset(&mut self) -> () {');
  });

  it('turns a trait data property into the accessor that reads it', () => {
    // A Rust trait holds no data. Fields and methods live in different namespaces, so the accessor
    // keeps the property's own name and reads the field of the same name.
    const module = lower(
      'data-trait.ts',
      'export interface Advancer { step: number; } export class Counter implements Advancer { step: number = 1; }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('  fn step(&self) -> f64;');
    expect(output).toContain('impl Advancer for Counter {');
    expect(output).toContain('    self.step.clone()');
  });

  it('refuses an optional trait data property, which has no single accessor shape yet', () => {
    const module = lower(
      'optional-trait.ts',
      'export interface Advancer { step?: number; } export class Counter implements Advancer { step: number = 1; }',
    );

    expect(() => emitIrModuleRust(module.module)).toThrow('requires Rust optional accessor lowering');
  });

  it('coalesces an Option-shaped operand and refuses one that is not', () => {
    // Rust has no `??`; the shape is `unwrap_or_else`, which needs an Option. An optional chain
    // produces one. Wrapping an ordinary value would claim a nullability the emitted type lacks.
    const optional = lower(
      'coalesce.ts',
      'export interface Holder { value: number } export function read(holder: Holder | undefined): number { return holder?.value ?? 0; }',
    );
    const plain = lower(
      'plain-coalesce.ts',
      'export function read(first: number, second: number): number { return first ?? second; }',
    );

    expect(emitIrModuleRust(optional.module).contents).toContain('.unwrap_or_else(|| 0.0)');
    // An operand that cannot be absent has no Option to open, so coalescing it means nothing.
    expect(() => emitIrModuleRust(plain.module)).toThrow('requires an Option-shaped left operand for Rust');
  });

  it('opens an Option where narrowing proved a value, and refuses where nothing did', () => {
    const narrowed = lower(
      'narrowed.ts',
      'export function widen(value: number | undefined, fallback: number): number { if value === undefined { return fallback; } return value; }',
    );
    const open = lower('open.ts', 'export function widen(value: number | undefined): number { return value; }');

    const output = emitIrModuleRust(narrowed.module).contents;
    expect(output).toContain('if value.is_none() {');
    // Copied out rather than taken: the source's narrowing proves the value is there, and does not
    // consume the place it was proved in.
    expect(output).toContain('return value.clone().unwrap();');
    // Unwrapping without the proof is a panic waiting to happen, so it refuses instead.
    expect(() => emitIrModuleRust(open.module)).toThrow('requires Rust narrowing evidence');
  });

  it('unwraps narrowed optional parameters in expressions after an is_some guard', () => {
    const addResult = lower(
      'addopt.ts',
      'export function addOptional(a: number, b?: number): number { if (b !== undefined) { return a + b; } return a; }',
    );
    const addOutput = emitIrModuleRust(addResult.module).contents;
    expect(addOutput).toContain('return a + b.clone().unwrap();');

    const greetResult = lower(
      'greetopt.ts',
      'export function greetOptional(name?: string): string { if (name !== undefined) { return `Hello, ${name}!`; } return "Hello, stranger!"; }',
    );
    const greetOutput = emitIrModuleRust(greetResult.module).contents;
    expect(greetOutput).toContain('name.clone().unwrap()');
  });

  it('extracts the narrowed primitive from a union identifier after typeof guards', () => {
    const twoMember = lower(
      'two-union.ts',
      'export function describe(value: string | number): string { if (typeof value === "string") { return value.toUpperCase(); } return `number ${value}`; }',
    );
    const twoOutput = emitIrModuleRust(twoMember.module).contents;
    expect(twoOutput).toContain('*value.as_f64()');

    const threeMember = lower(
      'three-union.ts',
      'export function format(value: string | number | boolean): string { if (typeof value === "string") { return value; } if (typeof value === "number") { return `${value}`; } return value ? "yes" : "no"; }',
    );
    const threeOutput = emitIrModuleRust(threeMember.module).contents;
    expect(threeOutput).toContain('*value.as_f64()');
    expect(threeOutput).toContain('*value.as_bool()');
  });

  it('clones array element access in variable initializers to prevent move-out', () => {
    const module = lower(
      'array-init.ts',
      'export function first(items: string[]): string { if (items.length === 0) { return ""; } const head: string = items[0]!; return head; }',
    );
    const output = emitIrModuleRust(module.module).contents;
    expect(output).toContain('items[0].clone()');
  });

  it('reads an array length as len and an indexed element through get', () => {
    // Rust spells a collection's length `len()` and counts in `usize`, and its `[]` panics where the
    // source language returns undefined. Emitting `.length` and `[]` produced Rust that neither
    // compiles nor means the same thing.
    const module = lower(
      'array-access.ts',
      'export function size(values: readonly number[]): number { return values.length; } export function at(values: readonly number[], index: number): number { return values[index] ?? 0; }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('return values.len() as f64;');
    expect(output).toContain('values.get(index as usize).cloned().unwrap_or_else(|| 0.0)');
  });

  it('wraps returned closures in Rc::new with move and emits function types as Rc<dyn Fn>', () => {
    const result = lower(
      'callback.ts',
      'export function makeAdder(base: number): (x: number) => number { return (x: number): number => base + x; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('use std::rc::Rc;');
    expect(output).toContain('Rc<dyn Fn(f64) -> f64>');
    expect(output).toContain('Rc::new(move |x| base + x)');
  });

  it('wraps variable-assigned closures in Rc::new with move when typed as function', () => {
    const result = lower(
      'callback-var.ts',
      'export function apply(values: number[]): number { const double: (x: number) => number = (x: number): number => x * 2; return double(values[0]!); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('Rc::new(move |x| x * 2.0)');
    expect(output).toContain('Rc<dyn Fn(f64) -> f64>');
  });

  it('wraps closure-captured mutable bindings in Rc<Cell<T>> with clone block', () => {
    const result = lower(
      'cell-capture.ts',
      'export function counter(): () => number { let count = 0; return (): number => { count += 1; return count; }; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('use std::cell::Cell;');
    expect(output).toContain('Rc<Cell<f64>>');
    expect(output).toContain('Rc::new(Cell::new(0.0))');
    expect(output).toContain('Rc::clone(&count)');
    expect(output).toContain('count.set(count.get() + 1.0)');
    expect(output).toContain('count.get()');
    expect(output).not.toContain('let mut count');
  });

  it('emits Rc<Cell<T>> for shared mutable state between closure and outer scope', () => {
    const result = lower(
      'cell-shared.ts',
      'export function accumulate(values: number[]): number { let total = 0; const add: (n: number) => void = (n: number): void => { total += n; }; for (const v of values) { add(v); } return total; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('let total: Rc<Cell<f64>>');
    expect(output).toContain('total.set(total.get() + n)');
    expect(output).toContain('return total.get()');
  });

  it('does not cell-wrap bindings captured by immediately-invoked closures', () => {
    const result = lower(
      'iife-destructure.ts',
      'export function assign(tuple: [number]): [number] { let value = 0; return ([value] = tuple); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).not.toContain('Cell');
    expect(output).toContain('value = destructuring_assignment_value.0');
  });

  it('folds Math.max spread into iterator fold with NEG_INFINITY identity', () => {
    const result = lower(
      'spread-max.ts',
      'export function widest(values: number[]): number { return Math.max(...values); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('values.iter().cloned().fold(f64::NEG_INFINITY, f64::max)');
    expect(output).not.toContain('spreading');
  });

  it('folds Math.min spread into iterator fold with INFINITY identity', () => {
    const result = lower(
      'spread-min.ts',
      'export function narrowest(values: number[]): number { return Math.min(...values); }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('values.iter().cloned().fold(f64::INFINITY, f64::min)');
  });

  it('emits nullable binding coalesce as Option unwrap_or_else', () => {
    const result = lower(
      'nullable-coalesce.ts',
      'export function fallback(value: number | undefined, def: number): number { return value ?? def; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('Option<f64>');
    expect(output).toContain('.unwrap_or_else(|| def)');
  });

  it('emits declare fields with Default::default in constructor', () => {
    const result = lower(
      'declare-field.ts',
      'export class Config { declare label: string; declare readonly flags: number; value: number = 0; public getLabel(): string { return this.label; } public getFlags(): number { return this.flags; } }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('label: String');
    expect(output).toContain('flags: f64');
    expect(output).toContain('value: f64');
    expect(output).toContain('label: Default::default()');
    expect(output).toContain('flags: Default::default()');
    expect(output).toContain('value: 0.0');
    expect(output).toContain('self.label.clone()');
    expect(output).not.toContain('self.flags.clone()');
  });

  it('emits abstract fields as trait method signatures with subclass getters', () => {
    const result = lower(
      'abstract-field.ts',
      'export abstract class Component { abstract name: string; abstract readonly version: number; public describe(): string { return this.name; } } export class Button extends Component { name: string = "button"; readonly version: number = 1; }',
    );
    const output = emitIrModuleRust(result.module).contents;

    expect(output).toContain('trait Component');
    expect(output).toContain('fn name(&self) -> String;');
    expect(output).toContain('fn version(&self) -> f64;');
    expect(output).toContain('fn describe(&self) -> String {');
    expect(output).toContain('self.name()');
    expect(output).toContain('impl Component for Button');
    expect(output).toContain('self.name.clone()');
    expect(output).not.toContain('self.version.clone()');
  });

  it('emits primitive union enums with typeof narrowing and ambient member dispatch', () => {
    const module = lower(
      'typeof-union.ts',
      'export function describe(value: string | number): string { if (typeof value === "string") { return value.toUpperCase(); } return "number"; }',
    );
    const output = emitIrModuleRust(module.module).contents;

    expect(output).toContain('enum StrOrF64');
    expect(output).toContain('Str(String)');
    expect(output).toContain('F64(f64)');
    expect(output).toContain('matches!(value, StrOrF64::Str(_))');
    expect(output).toContain('value.as_str().to_uppercase()');
  });

  it('emits array element binding as Option when used with nullish coalesce', () => {
    const result = lower(
      'array-element-coalesce.ts',
      'export function firstOf<Value>(values: Value[], fallback: Value): Value { const first: Value = values[0]; return first ?? fallback; }',
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('Option<Value>');
    expect(output).toContain('values.get(0).cloned()');
    expect(output).toContain('unwrap_or_else');
  });

  it('emits concrete class inheritance as composition with base field delegation', () => {
    const result = lower(
      'class-inheritance.ts',
      'class Base { value: number; constructor(value: number) { this.value = value; } doubled(): number { return this.value * 2; } } class Child extends Base { label: string; constructor(value: number, label: string) { super(value); this.label = label; } getDoubled(): number { return this.doubled(); } } export function run(v: number, l: string): number { const c: Child = new Child(v, l); return c.getDoubled(); }',
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('base: Base,');
    expect(output).toContain('base: Base::new(value),');
    expect(output).toContain('label: label,');
    expect(output).toContain('self.base.doubled()');
    expect(output).not.toContain('inheritance requires');
  });
});
