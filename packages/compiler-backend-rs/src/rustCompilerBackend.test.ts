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

  it('emits synchronous try/catch as catch_unwind with panic', () => {
    const result = lower(
      'try-catch-sync.ts',
      'export function tryCatch(action: () => void): string { try { action(); return "ok"; } catch { return "caught"; } }',
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('catch_unwind');
    expect(output).toContain('AssertUnwindSafe');
    expect(output).toContain('Ok(__catch_result) => return __catch_result,');
    expect(output).toContain('Err(_)');
    expect(output).not.toContain('settlement');
  });

  it('emits async try/catch as task settlement match', () => {
    const result = lower(
      'try-catch-async.ts',
      'export async function attempt(task: Promise<number>, fallback: number): Promise<number> { let result: number = 0; try { result = await task; } catch { result = fallback; } return result; }',
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('.settle()');
    expect(output).toContain('Ok(__value)');
    expect(output).toContain('result = __value;');
    expect(output).toContain('Err(_)');
    expect(output).toContain('result = fallback;');
    expect(output).not.toContain('catch_unwind');
  });

  it('emits async try/finally with settlement and re-panic', () => {
    const result = lower(
      'try-finally-async.ts',
      'export async function attempt(task: Promise<number>): Promise<number> { let result: number = 0; let done: boolean = false; try { result = await task; } finally { done = true; } return done ? result : result; }',
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('let __try_result = ');
    expect(output).toContain('.settle();');
    expect(output).toContain('done = true;');
    expect(output).toContain('Ok(__value)');
    expect(output).toContain('Err(__error) => panic!');
  });

  it('emits async try/return/finally with deferred return', () => {
    const result = lower(
      'try-return-finally-async.ts',
      'export async function attempt(task: Promise<number>, log: number[]): Promise<number> { try { return await task; } finally { log.push(1); } }',
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('let __try_result = ');
    expect(output).toContain('.settle();');
    expect(output).toContain('Ok(__value) => return __value,');
    expect(output).toContain('Err(__error) => panic!');
  });

  it('emits array literals as vec! with optional holes as Default::default', () => {
    const output = emitIrModuleRust(lower('array-lit.ts', 'export const items: number[] = [1, 2, 3];').module).contents;
    expect(output).toContain('vec![');
  });

  it('emits string append as push_str and string-plus-string as format!', () => {
    const output = emitIrModuleRust(
      lower(
        'string-append.ts',
        'export function build(base: string, suffix: string): string { let result = base; result += suffix; return result + suffix; }',
      ).module,
    ).contents;
    expect(output).toContain('push_str');
    expect(output).toContain('format!');
  });

  it('emits bitwise assignment operators with i32 casts', () => {
    const output = emitIrModuleRust(
      lower(
        'bitwise-assign.ts',
        'export function bits(a: number, b: number): number { let x = a; x &= b; x |= b; x ^= b; x <<= b; x >>= b; return x; }',
      ).module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });

  it('emits exponentiation assignment as f64::powf', () => {
    const output = emitIrModuleRust(
      lower(
        'pow-assign.ts',
        'export function pow(base: number, exp: number): number { let x = base; x **= exp; return x; }',
      ).module,
    ).contents;
    expect(output).toContain('f64::powf');
  });

  it('emits unsigned right shift assignment with u32 cast', () => {
    const output = emitIrModuleRust(
      lower(
        'urshift-assign.ts',
        'export function shift(a: number, b: number): number { let x = a; x >>>= b; return x; }',
      ).module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits unsigned right shift and bitwise binary operators', () => {
    const output = emitIrModuleRust(
      lower(
        'bitwise-binary.ts',
        'export function ops(a: number, b: number): number { return ((a >>> b) + (a & b) + (a | b) + (a ^ b) + (a << b) + (a >> b)); }',
      ).module,
    ).contents;
    expect(output).toContain('as u32) >>');
    expect(output).toContain('as i32)');
  });

  it('emits array join with borrowed separator', () => {
    const output = emitIrModuleRust(
      lower('array-join.ts', 'export function joined(items: string[]): string { return items.join(", "); }').module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice as range subscript', () => {
    const output = emitIrModuleRust(
      lower(
        'array-slice.ts',
        'export function take(items: number[], start: number, end: number): number[] { return items.slice(start, end); }',
      ).module,
    ).contents;
    expect(output).toContain('.to_vec()');
  });

  it('emits array concat as extend', () => {
    const output = emitIrModuleRust(
      lower('array-concat.ts', 'export function merge(a: number[], b: number[]): number[] { return a.concat(b); }')
        .module,
    ).contents;
    expect(output).toContain('extend');
  });

  it('emits charAt and charCodeAt as chars().nth', () => {
    const output = emitIrModuleRust(
      lower(
        'string-char.ts',
        'export function chars(s: string): string { const c = s.charAt(0); const n: number = s.charCodeAt(0); return c; }',
      ).module,
    ).contents;
    expect(output).toContain('chars().nth(');
  });

  it('emits substring as slice with range', () => {
    const output = emitIrModuleRust(
      lower(
        'string-sub.ts',
        'export function sub(s: string, start: number, end: number): string { return s.substring(start, end); }',
      ).module,
    ).contents;
    expect(output).toContain('.to_string()');
  });

  it('emits cast expressions as Rust as', () => {
    const output = emitIrModuleRust(
      lower('cast.ts', 'export function typed(x: unknown): number { return x as number; }').module,
    ).contents;
    expect(output).toContain(' as ');
  });

  it('emits tuple element access as positional field', () => {
    const output = emitIrModuleRust(
      lower('tuple-access.ts', 'export function first(pair: [number, string]): number { return pair[0]; }').module,
    ).contents;
    expect(output).toContain('.0');
  });

  it('emits static class fields as associated constants', () => {
    const output = emitIrModuleRust(
      lower(
        'static-member.ts',
        'export class Config { static readonly DEFAULT: number = 42; value: number; constructor(v: number) { this.value = v; } } export function read(): number { return Config.DEFAULT; }',
      ).module,
    ).contents;
    expect(output).toContain('Config::');
  });

  it('emits template literals as format! with escaped braces', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}!`; }').module,
    ).contents;
    expect(output).toContain('format!("hello {}!"');
  });

  it('emits tuple construction with trailing comma for single-element tuples', () => {
    const output = emitIrModuleRust(
      lower('tuple-ctor.ts', 'export function pair(a: number, b: string): [number, string] { return [a, b]; }').module,
    ).contents;
    expect(output).toContain('(a, b)');
  });

  it('emits bitwise NOT as !(x as i32) as f64', () => {
    const output = emitIrModuleRust(
      lower('bitwise-not.ts', 'export function invert(x: number): number { return ~x; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });

  it('emits undefined return as None for optional return type', () => {
    const output = emitIrModuleRust(
      lower('undef-return.ts', 'export function maybe(): number | undefined { return undefined; }').module,
    ).contents;
    expect(output).toContain('None');
    expect(output).toContain('Option<f64>');
  });

  it('emits numeric enum with i32 repr and discriminants', () => {
    const output = emitIrModuleRust(
      lower('num-enum.ts', 'export enum Status { Active = 0, Inactive = 1, Pending = 2 }').module,
    ).contents;
    expect(output).toContain('#[repr(i32)]');
    expect(output).toContain('Active = 0,');
    expect(output).toContain('Inactive = 1,');
    expect(output).toContain('Pending = 2,');
  });

  it('emits string enum with as_str and from_str methods', () => {
    const output = emitIrModuleRust(
      lower('str-enum.ts', 'export enum Color { Red = "red", Blue = "blue" }').module,
    ).contents;
    expect(output).toContain('fn as_str(&self)');
    expect(output).toContain('fn from_str(value: &str)');
    expect(output).toContain('"red"');
    expect(output).toContain('"blue"');
  });

  it('emits enum member access as variant path', () => {
    const output = emitIrModuleRust(
      lower(
        'enum-access.ts',
        'export enum Color { Red = 0, Green = 1 } export function pick(): Color { return Color.Red; }',
      ).module,
    ).contents;
    expect(output).toContain('Color::Red');
  });

  it('emits interface without implementor as struct record', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-record.ts',
        'export interface Point { x: number; y: number; } export function origin(): Point { return { x: 0, y: 0 }; }',
      ).module,
    ).contents;
    expect(output).toContain('pub struct Point');
    expect(output).toContain('pub x: f64,');
    expect(output).toContain('pub y: f64,');
  });

  it('emits interface with class implementor as trait', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-trait.ts',
        'export interface Greetable { greet(): string; } export class Person implements Greetable { name: string; constructor(name: string) { this.name = name; } greet(): string { return this.name; } }',
      ).module,
    ).contents;
    expect(output).toContain('pub trait Greetable');
    expect(output).toContain('fn greet(&self) -> String;');
  });

  it('emits do-while as loop with break condition', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        'export function countdown(n: number): number { let i: number = n; do { i = i - 1.0; } while (i > 0.0); return i; }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).toContain('break;');
  });

  it('emits for-of loop as for-in iteration', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of.ts',
        'export function total(items: number[]): number { let s: number = 0.0; for (const item of items) { s = s + item; } return s; }',
      ).module,
    ).contents;
    expect(output).toContain('for ');
    expect(output).toContain(' in ');
  });

  it('emits switch as if-else chain with unreachable default', () => {
    const output = emitIrModuleRust(
      lower(
        'switch.ts',
        'export function name(x: number): string { switch (x) { case 1.0: return "one"; case 2.0: return "two"; default: return "other"; } }',
      ).module,
    ).contents;
    expect(output).toContain('if ');
    expect(output).toContain('else');
  });

  it('emits throw new Error as panic! with message', () => {
    const output = emitIrModuleRust(
      lower('throw.ts', 'export function fail(msg: string): never { throw new Error(msg); }').module,
    ).contents;
    expect(output).toContain('panic!("{}"');
  });

  it('emits while true as loop keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'loop.ts',
        'export function spin(limit: number): number { let i: number = 0.0; while (true) { i = i + 1.0; if (i > limit) { return i; } } }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).not.toContain('while true');
  });

  it('emits while condition as while loop', () => {
    const output = emitIrModuleRust(
      lower(
        'while.ts',
        'export function count(n: number): number { let i: number = 0.0; while (i < n) { i = i + 1.0; } return i; }',
      ).module,
    ).contents;
    expect(output).toContain('while ');
  });

  it('emits type alias for string literal union as String type alias', () => {
    const output = emitIrModuleRust(
      lower('string-union.ts', "export type Direction = 'up' | 'down' | 'left' | 'right';").module,
    ).contents;
    expect(output).toContain('pub type Direction = String;');
  });

  it('emits type alias for object type as struct record', () => {
    const output = emitIrModuleRust(
      lower(
        'type-record.ts',
        'export type Config = { width: number; height: number; }; export function create(): Config { return { width: 100, height: 200 }; }',
      ).module,
    ).contents;
    expect(output).toContain('pub struct Config');
    expect(output).toContain('pub width: f64,');
    expect(output).toContain('pub height: f64,');
  });

  it('emits function type as Rc<dyn Fn>', () => {
    const output = emitIrModuleRust(
      lower('fn-type.ts', 'export function apply(f: (x: number) => number, value: number): number { return f(value); }')
        .module,
    ).contents;
    expect(output).toContain('Rc<dyn Fn(f64) -> f64>');
  });

  it('emits nullable type as Option wrapper', () => {
    const output = emitIrModuleRust(
      lower(
        'nullable.ts',
        'export function maybe(x: number | null): number { if (x === null) { return 0; } return x; }',
      ).module,
    ).contents;
    expect(output).toContain('Option<f64>');
  });

  it('emits default parameter with unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower('default-param.ts', 'export function add(a: number, b: number = 10.0): number { return a + b; }').module,
    ).contents;
    expect(output).toContain('Option<f64>');
    expect(output).toContain('unwrap_or_else');
  });

  it('emits rest parameter with Vec type', () => {
    const output = emitIrModuleRust(
      lower(
        'rest-param.ts',
        'export function sum(...args: number[]): number { let total: number = 0.0; for (const n of args) { total = total + n; } return total; }',
      ).module,
    ).contents;
    expect(output).toContain('args: Vec<f64>');
  });

  it('emits object literal construction with struct initializer', () => {
    const output = emitIrModuleRust(
      lower(
        'object-lit.ts',
        'export interface Rect { width: number; height: number; } export function create(w: number, h: number): Rect { return { width: w, height: h }; }',
      ).module,
    ).contents;
    expect(output).toContain('Rect {');
    expect(output).toContain('width:');
    expect(output).toContain('height:');
  });

  it('emits literal types in return position', () => {
    const output = emitIrModuleRust(
      lower('literal-type.ts', 'export function yes(): true { return true; }').module,
    ).contents;
    expect(output).toContain('-> bool');
  });

  it('emits null literal as None', () => {
    const output = emitIrModuleRust(
      lower('null-lit.ts', 'export function nothing(): null { return null; }').module,
    ).contents;
    expect(output).toContain('None');
  });

  it('emits integer literal as f64 with decimal', () => {
    const output = emitIrModuleRust(lower('int-lit.ts', 'export const VALUE: number = 42;').module).contents;
    expect(output).toContain('42.0');
  });

  it('emits string literal with to_owned()', () => {
    const output = emitIrModuleRust(lower('str-lit.ts', 'export const GREETING: string = "hello";').module).contents;
    expect(output).toContain('"hello".to_owned()');
  });

  it('emits array map as into_iter().map().collect()', () => {
    const output = emitIrModuleRust(
      lower(
        'array-map.ts',
        'export function doubled(items: number[]): number[] { return items.map((x: number): number => x * 2.0); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.map(');
    expect(output).toContain('.collect::<Vec<_>>()');
  });

  it('emits array filter as into_iter().filter().collect()', () => {
    const output = emitIrModuleRust(
      lower(
        'array-filter.ts',
        'export function positives(items: number[]): number[] { return items.filter((x: number): boolean => x > 0.0); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.filter(');
    expect(output).toContain('.collect::<Vec<_>>()');
  });

  it('emits array every as into_iter().all()', () => {
    const output = emitIrModuleRust(
      lower(
        'array-every.ts',
        'export function allPositive(items: number[]): boolean { return items.every((x: number): boolean => x > 0.0); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.all(');
  });

  it('emits array some as into_iter().any()', () => {
    const output = emitIrModuleRust(
      lower(
        'array-some.ts',
        'export function hasNeg(items: number[]): boolean { return items.some((x: number): boolean => x < 0.0); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.any(');
  });

  it('emits array includes as contains with borrowed argument', () => {
    const output = emitIrModuleRust(
      lower(
        'array-includes.ts',
        'export function has(items: string[], needle: string): boolean { return items.includes(needle); }',
      ).module,
    ).contents;
    expect(output).toContain('.contains(');
  });

  it('emits array indexOf as iter().position() with sentinel', () => {
    const output = emitIrModuleRust(
      lower(
        'array-indexof.ts',
        'export function find(items: string[], needle: string): number { return items.indexOf(needle); }',
      ).module,
    ).contents;
    expect(output).toContain('.iter()');
    expect(output).toContain('.position(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits array push and pop', () => {
    const output = emitIrModuleRust(
      lower('array-push-pop.ts', 'export function cycle(items: number[]): void { items.push(1.0); items.pop(); }')
        .module,
    ).contents;
    expect(output).toContain('.push(');
    expect(output).toContain('.pop()');
  });

  it('emits array length as len() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('array-len.ts', 'export function size(items: number[]): number { return items.length; }').module,
    ).contents;
    expect(output).toContain('.len()');
    expect(output).toContain('as f64');
  });

  it('emits string indexOf as find with sentinel', () => {
    const output = emitIrModuleRust(
      lower('string-indexof.ts', 'export function pos(s: string, sub: string): number { return s.indexOf(sub); }')
        .module,
    ).contents;
    expect(output).toContain('.find(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits string split as split().collect()', () => {
    const output = emitIrModuleRust(
      lower('string-split.ts', 'export function parts(s: string, sep: string): string[] { return s.split(sep); }')
        .module,
    ).contents;
    expect(output).toContain('.split(');
    expect(output).toContain('.collect::<Vec<String>>()');
  });

  it('emits string includes as contains', () => {
    const output = emitIrModuleRust(
      lower('string-contains.ts', 'export function has(s: string, sub: string): boolean { return s.includes(sub); }')
        .module,
    ).contents;
    expect(output).toContain('.contains(');
  });

  it('emits string startsWith and endsWith', () => {
    const output = emitIrModuleRust(
      lower(
        'string-prefix.ts',
        'export function check(s: string, p: string): boolean { return s.startsWith(p) && s.endsWith(p); }',
      ).module,
    ).contents;
    expect(output).toContain('.starts_with(');
    expect(output).toContain('.ends_with(');
  });

  it('emits string toLowerCase and toUpperCase', () => {
    const output = emitIrModuleRust(
      lower(
        'string-case.ts',
        'export function cases(s: string): string { const lo = s.toLowerCase(); return lo.toUpperCase(); }',
      ).module,
    ).contents;
    expect(output).toContain('.to_lowercase()');
    expect(output).toContain('.to_uppercase()');
  });

  it('emits string trim with to_owned()', () => {
    const output = emitIrModuleRust(
      lower('string-trim.ts', 'export function clean(s: string): string { return s.trim(); }').module,
    ).contents;
    expect(output).toContain('.trim()');
    expect(output).toContain('.to_owned()');
  });

  it('emits string length as len() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('string-len.ts', 'export function size(s: string): number { return s.length; }').module,
    ).contents;
    expect(output).toContain('.len()');
    expect(output).toContain('as f64');
  });

  it('emits string replace as replacen with count 1', () => {
    const output = emitIrModuleRust(
      lower(
        'string-replace.ts',
        'export function fix(s: string, from: string, to: string): string { return s.replace(from, to); }',
      ).module,
    ).contents;
    expect(output).toContain('.replacen(');
    expect(output).toContain(', 1)');
  });

  it('emits conditional expression as if-else block', () => {
    const output = emitIrModuleRust(
      lower('ternary.ts', 'export function pick(cond: boolean, a: number, b: number): number { return cond ? a : b; }')
        .module,
    ).contents;
    expect(output).toContain('if ');
    expect(output).toContain(' else ');
  });

  it('emits try/catch with catch_unwind', () => {
    const output = emitIrModuleRust(
      lower('try-catch.ts', 'export function safe(): number { try { return 1.0; } catch (e: unknown) { return 0.0; } }')
        .module,
    ).contents;
    expect(output).toContain('catch_unwind');
    expect(output).toContain('AssertUnwindSafe');
  });

  it('emits class methods with &self and &mut self receivers', () => {
    const output = emitIrModuleRust(
      lower(
        'class-methods.ts',
        'export class Counter { count: number; constructor() { this.count = 0.0; } get(): number { return this.count; } increment(): void { this.count = this.count + 1.0; } }',
      ).module,
    ).contents;
    expect(output).toContain('&self');
    expect(output).toContain('&mut self');
    expect(output).toContain('fn get(');
    expect(output).toContain('fn increment(');
  });

  it('emits abstract class as trait with abstract field accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-class.ts',
        'export abstract class Shape { abstract readonly kind: string; describe(): string { return this.kind; } } export class Circle extends Shape { readonly kind: string; radius: number; constructor(r: number) { super(); this.kind = "circle"; this.radius = r; } describe(): string { return this.kind; } }',
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn kind(&self)');
  });

  it('emits break and continue with labeled targets', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled.ts',
        'export function search(matrix: number[][]): number { let result: number = 0.0; outer: for (const row of matrix) { for (const cell of row) { if (cell > 10.0) { result = cell; break outer; } } } return result; }',
      ).module,
    ).contents;
    expect(output).toMatch(/'[a-z_]+:/);
    expect(output).toContain('break');
  });

  it('emits variable module constant with pub const', () => {
    const output = emitIrModuleRust(lower('module-const.ts', 'export const PI: number = 3.14159;').module).contents;
    expect(output).toContain('pub const');
    expect(output).toContain('3.14159');
  });

  it('emits class getter and setter as separate methods', () => {
    const output = emitIrModuleRust(
      lower(
        'accessor.ts',
        'export class Box { private _value: number; constructor(v: number) { this._value = v; } get value(): number { return this._value; } set value(v: number) { this._value = v; } }',
      ).module,
    ).contents;
    expect(output).toContain('fn value(');
    expect(output).toContain('fn set_value(');
  });

  it('emits interface with data properties as trait accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-data-trait.ts',
        'export interface Named { name: string; greet(): string; } export class User implements Named { name: string; constructor(name: string) { this.name = name; } greet(): string { return this.name; } }',
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self) -> String');
    expect(output).toContain('fn greet(&self) -> String');
    expect(output).toContain('impl Named for User');
  });

  it('emits class with field initializer auto-constructor', () => {
    const output = emitIrModuleRust(
      lower('field-init.ts', 'export class Settings { width: number = 100.0; height: number = 200.0; }').module,
    ).contents;
    expect(output).toContain('fn new() -> Self');
    expect(output).toContain('width:');
    expect(output).toContain('height:');
  });

  it('emits mutable variable with mut binding', () => {
    const output = emitIrModuleRust(
      lower('mut-var.ts', 'export function mutate(): number { let x: number = 1.0; x = 2.0; x = 3.0; return x; }')
        .module,
    ).contents;
    expect(output).toContain('let mut ');
  });

  it('emits if-else statement blocks', () => {
    const output = emitIrModuleRust(
      lower(
        'if-else.ts',
        'export function classify(x: number): string { if (x > 0.0) { return "positive"; } else { return "non-positive"; } }',
      ).module,
    ).contents;
    expect(output).toContain('if ');
    expect(output).toContain('else {');
  });

  it('emits block statement with braces', () => {
    const output = emitIrModuleRust(
      lower(
        'block.ts',
        'export function scoped(): number { let x: number = 1.0; { let y: number = 2.0; x = y; } return x; }',
      ).module,
    ).contents;
    expect(output).toContain('{');
    expect(output).toContain('}');
  });

  it('emits array reduce as into_iter().fold()', () => {
    const output = emitIrModuleRust(
      lower(
        'reduce.ts',
        'export function sum(items: number[]): number { return items.reduce((acc: number, x: number): number => acc + x, 0.0); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.fold(');
  });

  it('emits number toString as to_string()', () => {
    const output = emitIrModuleRust(
      lower('num-tostring.ts', 'export function text(n: number): string { return n.toString(); }').module,
    ).contents;
    expect(output).toContain('.to_string()');
  });

  it('emits array reverse as reverse()', () => {
    const output = emitIrModuleRust(
      lower('array-reverse.ts', 'export function flip(items: number[]): void { items.reverse(); }').module,
    ).contents;
    expect(output).toContain('.reverse()');
  });

  it('emits array shift as remove(0)', () => {
    const output = emitIrModuleRust(
      lower('array-shift.ts', 'export function dequeue(items: number[]): void { items.shift(); }').module,
    ).contents;
    expect(output).toContain('.remove(0)');
  });

  it('emits string lastIndexOf as rfind', () => {
    const output = emitIrModuleRust(
      lower(
        'string-lastindexof.ts',
        'export function last(s: string, sub: string): number { return s.lastIndexOf(sub); }',
      ).module,
    ).contents;
    expect(output).toContain('.rfind(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits type alias to simple type', () => {
    const output = emitIrModuleRust(
      lower('type-alias.ts', 'export type Count = number; export function zero(): Count { return 0.0; }').module,
    ).contents;
    expect(output).toContain('pub type Count = f64');
  });

  it('emits class implementing interface with impl for block', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-trait.ts',
        'export interface Runnable { run(): void; } export class Task implements Runnable { done: boolean; constructor() { this.done = false; } run(): void { this.done = true; } }',
      ).module,
    ).contents;
    expect(output).toContain('impl Runnable for Task');
  });

  it('emits async function with async fn keyword', () => {
    const output = emitIrModuleRust(
      lower('async-fn.ts', 'export async function fetch(url: string): Promise<string> { return url; }').module,
    ).contents;
    expect(output).toContain('async fn');
    expect(output).toContain('-> String');
  });

  it('emits expression statement with semicolon', () => {
    const output = emitIrModuleRust(
      lower('expr-stmt.ts', 'export function side(items: number[]): void { items.push(1.0); }').module,
    ).contents;
    expect(output).toContain('.push(');
    expect(output).toMatch(/push\([^)]*\);/);
  });

  it('emits array lastIndexOf as iter().rposition()', () => {
    const output = emitIrModuleRust(
      lower(
        'array-lastindexof.ts',
        'export function lastIdx(items: string[], needle: string): number { return items.lastIndexOf(needle); }',
      ).module,
    ).contents;
    expect(output).toContain('.rposition(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits optional parameter call with None for missing argument', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-call.ts',
        'export function greet(name: string, title?: string): string { return name; } export function test(): string { return greet("world"); }',
      ).module,
    ).contents;
    expect(output).toContain('None');
  });

  it('emits default parameter with Option wrapping in signature', () => {
    const output = emitIrModuleRust(
      lower(
        'default-call.ts',
        'export function add(a: number, b: number = 10.0): number { return a + b; } export function test(): number { return add(5.0); }',
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
    expect(output).toContain('10.0');
  });

  it('emits generic function with type parameters', () => {
    const output = emitIrModuleRust(
      lower('generic-fn.ts', 'export function identity<T>(value: T): T { return value; }').module,
    ).contents;
    expect(output).toContain('<T: Clone>');
    expect(output).toContain('value: T');
    expect(output).toContain('-> T');
  });

  it('emits generic class with type parameters', () => {
    const output = emitIrModuleRust(
      lower(
        'generic-class.ts',
        'export class Wrapper<T> { value: T; constructor(value: T) { this.value = value; } get(): T { return this.value; } }',
      ).module,
    ).contents;
    expect(output).toContain('struct Wrapper<T: Clone>');
    expect(output).toContain('impl<T: Clone>');
  });

  it('emits array find as into_iter().find()', () => {
    const output = emitIrModuleRust(
      lower(
        'array-find.ts',
        'export function first(items: number[]): number | undefined { return items.find((x: number): boolean => x > 0.0); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.find(');
  });

  it('emits Map operations with Rust HashMap methods', () => {
    const output = emitIrModuleRust(
      lower('map-ops.ts', 'export function ops(m: Map<string, number>): void { m.set("a", 1.0); m.delete("b"); }')
        .module,
    ).contents;
    expect(output).toContain('.insert(');
    expect(output).toContain('.remove(');
  });

  it('emits Set operations with Rust HashSet methods', () => {
    const output = emitIrModuleRust(
      lower('set-ops.ts', 'export function ops(s: Set<string>): void { s.add("a"); s.delete("b"); s.has("c"); }')
        .module,
    ).contents;
    expect(output).toContain('.insert(');
    expect(output).toContain('.remove(');
    expect(output).toContain('.contains(');
  });

  it('emits Map has as contains_key', () => {
    const output = emitIrModuleRust(
      lower('map-has.ts', 'export function check(m: Map<string, number>, key: string): boolean { return m.has(key); }')
        .module,
    ).contents;
    expect(output).toContain('.contains_key(');
  });

  it('emits Map size as len() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('map-size.ts', 'export function count(m: Map<string, number>): number { return m.size; }').module,
    ).contents;
    expect(output).toContain('.len()');
    expect(output).toContain('as f64');
  });

  it('emits Set size as len() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('set-size.ts', 'export function count(s: Set<string>): number { return s.size; }').module,
    ).contents;
    expect(output).toContain('.len()');
  });

  it('emits array unshift as insert(0)', () => {
    const output = emitIrModuleRust(
      lower(
        'array-unshift.ts',
        'export function prepend(items: number[], value: number): void { items.unshift(value); }',
      ).module,
    ).contents;
    expect(output).toContain('.insert(0');
  });

  it('emits Map get as get with cloned()', () => {
    const output = emitIrModuleRust(
      lower(
        'map-get.ts',
        'export function lookup(m: Map<string, number>, key: string): number | undefined { return m.get(key); }',
      ).module,
    ).contents;
    expect(output).toContain('.get(');
    expect(output).toContain('.cloned()');
  });

  it('emits class with trait impl for abstract base', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-trait.ts',
        'export abstract class Shape { abstract area(): number; perimeter(): number { return 0.0; } } export class Square extends Shape { side: number; constructor(s: number) { super(); this.side = s; } area(): number { return this.side * this.side; } }',
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('impl Shape for Square');
    expect(output).toContain('fn area(');
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

  it('emits tagged union as Rust enum with variant accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        'interface Circle { radius: number; } interface Rect { width: number; height: number; } export type Shape = Circle | Rect; export function area(s: Shape): number { return 0.0; }',
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle(');
    expect(output).toContain('Rect(');
    expect(output).toContain('fn as_circle(');
    expect(output).toContain('fn as_rect(');
  });

  it('emits primitive union as tagged enum with Display', () => {
    const output = emitIrModuleRust(
      lower('prim-union.ts', 'export function accept(x: string | number): string { return x.toString(); }').module,
    ).contents;
    expect(output).toContain('enum');
    expect(output).toContain('Str(String)');
    expect(output).toContain('F64(f64)');
    expect(output).toContain('impl std::fmt::Display');
  });

  it('emits tuple type as Rust tuple', () => {
    const output = emitIrModuleRust(
      lower(
        'tuple-type.ts',
        'export function swap(pair: [number, string]): [string, number] { return [pair[1], pair[0]]; }',
      ).module,
    ).contents;
    expect(output).toContain('(f64, String)');
    expect(output).toContain('(String, f64)');
  });

  it('emits never type as bang type', () => {
    const output = emitIrModuleRust(
      lower('never-type.ts', 'export function fail(): never { throw new Error("fatal"); }').module,
    ).contents;
    expect(output).toContain('-> !');
  });

  it('emits union with null as Option', () => {
    const output = emitIrModuleRust(
      lower(
        'option-type.ts',
        'export function safe(x: string | null): string { if (x === null) { return "none"; } return x; }',
      ).module,
    ).contents;
    expect(output).toContain('Option<String>');
  });

  it('emits array type as Vec', () => {
    const output = emitIrModuleRust(
      lower('vec-type.ts', 'export function empty(): number[] { return []; }').module,
    ).contents;
    expect(output).toContain('Vec<f64>');
  });

  it('emits boolean primitive type', () => {
    const output = emitIrModuleRust(
      lower('bool-type.ts', 'export function yes(): boolean { return true; }').module,
    ).contents;
    expect(output).toContain('-> bool');
  });

  it('emits void return as unit type', () => {
    const output = emitIrModuleRust(lower('void-type.ts', 'export function noop(): void { }').module).contents;
    expect(output).toContain('-> ()');
  });

  it('emits class with private field visibility', () => {
    const output = emitIrModuleRust(
      lower(
        'private-field.ts',
        'export class Secret { private data: string; constructor(d: string) { this.data = d; } read(): string { return this.data; } }',
      ).module,
    ).contents;
    expect(output).toContain('data: String');
    expect(output).not.toMatch(/pub\s+data/);
  });

  it('emits class with public field visibility', () => {
    const output = emitIrModuleRust(
      lower(
        'public-field.ts',
        'export class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }',
      ).module,
    ).contents;
    expect(output).toContain('pub x: f64');
    expect(output).toContain('pub y: f64');
  });

  it('emits Readonly<T> by unwrapping to inner type', () => {
    const output = emitIrModuleRust(
      lower('readonly-unwrap.ts', 'export function freeze(items: Readonly<number[]>): number { return items[0]; }')
        .module,
    ).contents;
    expect(output).toContain('Vec<f64>');
  });

  it('emits Math.max spread as fold over iter', () => {
    const output = emitIrModuleRust(
      lower('math-spread.ts', 'export function biggest(items: number[]): number { return Math.max(...items); }').module,
    ).contents;
    expect(output).toContain('.iter()');
    expect(output).toContain('.fold(');
    expect(output).toContain('f64::max');
  });

  it('emits Math.min spread as fold over iter', () => {
    const output = emitIrModuleRust(
      lower('math-min-spread.ts', 'export function smallest(items: number[]): number { return Math.min(...items); }')
        .module,
    ).contents;
    expect(output).toContain('.fold(');
    expect(output).toContain('f64::min');
  });

  it('emits this reference as self', () => {
    const output = emitIrModuleRust(
      lower(
        'this-ref.ts',
        'export class Node { value: number; constructor(v: number) { this.value = v; } double(): number { return this.value * 2.0; } }',
      ).module,
    ).contents;
    expect(output).toContain('self.value');
  });

  it('emits Map type as std HashMap', () => {
    const output = emitIrModuleRust(
      lower('map-type.ts', 'export function make(): Map<string, number> { return new Map<string, number>(); }').module,
    ).contents;
    expect(output).toContain('HashMap');
  });

  it('emits array join with borrowed separator', () => {
    const output = emitIrModuleRust(
      lower('arr-join.ts', 'export function join(items: string[]): string { return items.join(", "); }').module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice with range bounds', () => {
    const output = emitIrModuleRust(
      lower('arr-slice.ts', 'export function mid(items: number[]): number[] { return items.slice(1, 3); }').module,
    ).contents;
    expect(output).toContain('.to_vec()');
  });

  it('emits array slice with start only', () => {
    const output = emitIrModuleRust(
      lower('arr-slice-start.ts', 'export function tail(items: number[]): number[] { return items.slice(1); }').module,
    ).contents;
    expect(output).toContain('..].to_vec()');
  });

  it('emits array concat as extend', () => {
    const output = emitIrModuleRust(
      lower('arr-concat.ts', 'export function merge(a: number[], b: number[]): number[] { return a.concat(b); }')
        .module,
    ).contents;
    expect(output).toContain('__concat');
    expect(output).toContain('.extend(');
  });

  it('emits string charAt as chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('str-charat.ts', 'export function first(s: string): string { return s.charAt(0); }').module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('.unwrap_or_default()');
  });

  it('emits string charCodeAt as chars().nth() with u32 cast', () => {
    const output = emitIrModuleRust(
      lower('str-charcodeat.ts', 'export function code(s: string): number { return s.charCodeAt(0); }').module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('u32 as f64');
  });

  it('emits string substring as range slice', () => {
    const output = emitIrModuleRust(
      lower('str-substring.ts', 'export function sub(s: string): string { return s.substring(1, 3); }').module,
    ).contents;
    expect(output).toContain('.to_string()');
  });

  it('emits closure with body statements', () => {
    const output = emitIrModuleRust(
      lower(
        'closure-body.ts',
        'export function run(items: number[]): number[] { return items.map((x: number): number => { const y = x + 1; return y; }); }',
      ).module,
    ).contents;
    expect(output).toContain('|');
    expect(output).toContain('let');
  });

  it('emits class with mutable self for this assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-self.ts',
        'export class Counter { count: number; constructor() { this.count = 0; } increment(): void { this.count = this.count + 1; } }',
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
  });

  it('emits imports from relative specifiers', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'use.ts',
      "import { add } from './math.js'; export function double(x: number): number { return add(x, x); }",
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('use crate::');
  });

  it('emits break and continue with label targets', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-loop.ts',
        'export function scan(grid: number[][]): number { let total = 0; outer: for (const row of grid) { for (const cell of row) { if (cell < 0) continue outer; if (cell > 99) break outer; total = total + cell; } } return total; }',
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain("break 'outer");
    expect(output).toContain("continue 'outer");
  });

  it('emits switch default case as else clause', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-default.ts',
        'export function label(n: number): string { switch (n) { case 1: return "one"; case 2: return "two"; default: return "other"; } }',
      ).module,
    ).contents;
    expect(output).toContain('else {');
    expect(output).toContain('"other"');
  });

  it('emits abstract class with concrete default methods', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-default.ts',
        'export abstract class Shape { abstract area(): number; describe(): string { return "shape"; } }',
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn area(&self) -> f64;');
    expect(output).toContain('fn describe(&self) -> String');
    expect(output).toContain('"shape"');
  });

  it('emits class extending concrete base as composition', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        [
          'export class Base { x: number; constructor(x: number) { this.x = x; } }',
          'export class Child extends Base { y: number; constructor(x: number, y: number) { super(x); this.y = y; } }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('base:');
    expect(output).toContain('Base::new(');
  });

  it('emits class extending stateless abstract base', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-impl.ts',
        [
          'export abstract class Shape { abstract area(): number; }',
          'export class Circle extends Shape { radius: number; constructor(r: number) { super(); this.radius = r; } area(): number { return 3.14 * this.radius * this.radius; } }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('impl Shape for Circle');
  });

  it('emits optional property chain as map/and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-prop.ts',
        'export function name(user: { name: string } | null): string | null { return user?.name; }',
      ).module,
    ).contents;
    expect(output).toContain('.as_ref().');
    expect(output).toContain('optional_chain_value');
  });

  it('emits unary plus on number as identity', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', 'export function id(x: number): number { return +x; }').module,
    ).contents;
    expect(output).not.toContain('+ x');
    expect(output).toContain('return x');
  });

  it('emits indexedAccess type as opaque host type', () => {
    const output = emitIrModuleRust(
      lower(
        'indexed-type.ts',
        'interface Config { host: string } export function get(c: Config[keyof Config]): string { return c; }',
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits symbol primitive type as FlightSymbol', () => {
    const output = emitIrModuleRust(
      lower('symbol-type.ts', 'export function id(s: symbol): symbol { return s; }').module,
    ).contents;
    expect(output).toContain('FlightSymbol');
  });

  it('refuses mutable module variable with synchronization error', () => {
    expect(() => emitIrModuleRust(lower('mod-var-mut.ts', 'export let counter: number = 0;').module)).toThrow(
      'synchronization',
    );
  });

  it('emits type alias with type parameters', () => {
    const output = emitIrModuleRust(
      lower('generic-alias.ts', 'export type Pair<A, B> = { first: A; second: B; };').module,
    ).contents;
    expect(output).toContain('struct Pair');
    expect(output).toContain(': Clone');
  });

  it('emits class with static method accessed via type path', () => {
    const output = emitIrModuleRust(
      lower(
        'static-method.ts',
        'export class Factory { static create(): number { return 42.0; } } export function make(): number { return Factory.create(); }',
      ).module,
    ).contents;
    expect(output).toContain('Factory::create()');
  });

  it('emits object literal with optional property as Some', () => {
    const output = emitIrModuleRust(
      lower(
        'obj-optional.ts',
        'interface Opts { name: string; age?: number; } export function defaults(): Opts { return { name: "test" }; }',
      ).module,
    ).contents;
    expect(output).toContain('age: None');
  });

  it('emits variable with undefined initial value as deferred binding', () => {
    const output = emitIrModuleRust(
      lower('var-undef-init.ts', 'export function maybe(): number | null { let x: number | null; x = 42.0; return x; }')
        .module,
    ).contents;
    expect(output).toContain('let x: Option<f64>');
  });

  it('emits cast expression with as', () => {
    const output = emitIrModuleRust(
      lower('cast-expr.ts', 'export function narrow(x: unknown): number { return x as number; }').module,
    ).contents;
    expect(output).toContain(' as ');
  });

  it('emits tuple element access by index', () => {
    const output = emitIrModuleRust(
      lower('tuple-access.ts', 'export function first(pair: [number, string]): number { return pair[0]; }').module,
    ).contents;
    expect(output).toContain('.0');
  });

  it('emits reexport as pub use', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'barrel.ts',
      "export { add } from './math.js'; export function local(): number { return 1; }",
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('pub use');
  });

  it('emits typeof guard as matches! for primitive unions', () => {
    const output = emitIrModuleRust(
      lower('typeof-guard.ts', 'export function check(x: string | number): boolean { return typeof x === "string"; }')
        .module,
    ).contents;
    expect(output).toContain('matches!');
  });

  it('emits class with field initializers as struct literal new', () => {
    const output = emitIrModuleRust(
      lower(
        'field-init-ctor.ts',
        'export class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }',
      ).module,
    ).contents;
    expect(output).toContain('fn new(');
    expect(output).toContain('Point {');
  });

  it('emits undefinedDefault expression as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower('undef-default.ts', 'export function safe(x: number | undefined): number { return x ?? 0; }').module,
    ).contents;
    expect(output).toContain('.unwrap_or_else(');
  });

  it('emits narrowed present nullable as unwrap', () => {
    const output = emitIrModuleRust(
      lower(
        'narrowed-present.ts',
        'export function value(x: number | null): number { if (x !== null) { return x; } return 0; }',
      ).module,
    ).contents;
    expect(output).toContain('.unwrap()');
  });

  it('emits callback variable as Rc-wrapped closure', () => {
    const output = emitIrModuleRust(
      lower(
        'callback-var.ts',
        'export function run(): number { const fn_: (x: number) => number = (x: number): number => x + 1; return fn_(1); }',
      ).module,
    ).contents;
    expect(output).toContain('Rc::new(');
  });

  it('emits element access with expression index as usize cast', () => {
    const output = emitIrModuleRust(
      lower('elem-expr-idx.ts', 'export function at(items: number[], i: number): number { return items[i]; }').module,
    ).contents;
    expect(output).toContain('as usize');
  });

  it('emits owned operand clone for multi-use binding', () => {
    const output = emitIrModuleRust(
      lower('multi-use.ts', 'export function dup(s: string): string { const a = s; const b = s; return a; }').module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits abstract class trait with abstract field accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-field.ts',
        'export abstract class Named { abstract name: string; greet(): string { return this.name; } }',
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self) -> String;');
    expect(output).toContain('fn greet(&self) -> String');
    expect(output).toContain('self.name()');
  });

  it('emits scoped package import as use crate path', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'consumer.ts',
      "import { Point } from '@flighthq/types/point'; export function use(p: Point): number { return p.x; }",
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('use ');
  });

  it('emits composition base member access through base field', () => {
    const output = emitIrModuleRust(
      lower(
        'comp-access.ts',
        [
          'export class Base { x: number; constructor(x: number) { this.x = x; } }',
          'export class Child extends Base { y: number; constructor(x: number, y: number) { super(x); this.y = y; } get_x(): number { return this.x; } }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('self.base');
  });

  it('emits string replace as replacen with count 1', () => {
    const output = emitIrModuleRust(
      lower('str-replace.ts', 'export function fix(s: string): string { return s.replace("old", "new"); }').module,
    ).contents;
    expect(output).toContain('replacen(');
  });

  it('emits class non-copy self field clone', () => {
    const output = emitIrModuleRust(
      lower(
        'self-field-clone.ts',
        'export class Container { items: string[]; constructor() { this.items = []; } get(): string[] { return this.items; } }',
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits switch with unreachable default when exhaustive', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-exhaust.ts',
        'export function label(n: number): string { switch (n) { case 1: return "one"; case 2: return "two"; } return "none"; }',
      ).module,
    ).contents;
    expect(output).toContain('unreachable!()');
  });

  it('emits assignment operators directly', () => {
    const output = emitIrModuleRust(
      lower('assign-ops.ts', 'export function ops(): number { let x = 10; x += 5; x -= 3; x *= 2; return x; }').module,
    ).contents;
    expect(output).toContain('+=');
    expect(output).toContain('-=');
    expect(output).toContain('*=');
  });

  it('emits clone safety for nested array types', () => {
    const output = emitIrModuleRust(
      lower('nested-array.ts', 'export function wrap(items: number[]): number[][] { return [items]; }').module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits string concatenation with format!', () => {
    const output = emitIrModuleRust(
      lower('str-concat.ts', 'export function greet(name: string): string { return "hello " + name; }').module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits exponentiation as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow-op.ts', 'export function square(x: number): number { return x ** 2; }').module,
    ).contents;
    expect(output).toContain('f64::powf(');
  });

  it('emits unsigned right shift as u32 cast', () => {
    const output = emitIrModuleRust(
      lower('urshift.ts', 'export function shift(x: number): number { return x >>> 2; }').module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits bitwise and as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitwise-and.ts', 'export function mask(a: number, b: number): number { return a & b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits nullish coalesce as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower('nullish.ts', 'export function fallback(x: number | null): number { return x ?? 0; }').module,
    ).contents;
    expect(output).toContain('.unwrap_or_else(');
  });

  it('emits null comparison as is_none/is_some', () => {
    const output = emitIrModuleRust(
      lower('null-cmp.ts', 'export function isNull(x: number | null): boolean { return x === null; }').module,
    ).contents;
    expect(output).toContain('.is_none()');
  });

  it('emits null inequality as is_some', () => {
    const output = emitIrModuleRust(
      lower('not-null.ts', 'export function notNull(x: number | null): boolean { return x !== null; }').module,
    ).contents;
    expect(output).toContain('.is_some()');
  });

  it('emits string += as push_str', () => {
    const output = emitIrModuleRust(
      lower('str-append.ts', 'export function append(): string { let s = "hello"; s += " world"; return s; }').module,
    ).contents;
    expect(output).toContain('.push_str(');
  });

  it('emits exponentiation assignment as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow-assign.ts', 'export function cube(): number { let x = 2.0; x **= 3.0; return x; }').module,
    ).contents;
    expect(output).toContain('f64::powf(');
  });

  it('emits bitwise assignment operators with i32 casts', () => {
    const output = emitIrModuleRust(
      lower('bitwise-assign.ts', 'export function flags(): number { let x = 255; x &= 15; return x; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits unsigned right shift assignment as u32 cast', () => {
    const output = emitIrModuleRust(
      lower('urshift-assign.ts', 'export function shift(): number { let x = 255; x >>>= 2; return x; }').module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits accessor call for setter assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'setter-call.ts',
        [
          'export class Box { _value: number; constructor(v: number) { this._value = v; }',
          '  get value(): number { return this._value; }',
          '  set value(v: number) { this._value = v; }',
          '}',
          'export function update(b: Box): void { b.value = 10; }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('.set_value(');
  });

  it('emits class with field initializer auto-constructor', () => {
    const output = emitIrModuleRust(
      lower('auto-ctor.ts', 'export class Config { name: string = "default"; count: number = 0; }').module,
    ).contents;
    expect(output).toContain('fn new() -> Self');
    expect(output).toContain('"default"');
  });

  it('emits await expression with .await', () => {
    const output = emitIrModuleRust(
      lower(
        'await-expr.ts',
        'export async function fetch(): Promise<number> { const p = Promise.resolve(42); return await p; }',
      ).module,
    ).contents;
    expect(output).toContain('.await');
  });

  it('emits interface data property as trait accessor when class implements', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-data-prop.ts',
        [
          'export interface Named { name: string; greet(): string; }',
          'export class Person implements Named { name: string; constructor(n: string) { this.name = n; } greet(): string { return this.name; } }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self) -> String');
    expect(output).toContain('self.name.clone()');
  });

  it('emits class implementing interface trait with data and method accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-impl-mixed.ts',
        [
          'export interface HasValue { value: number; compute(): number; }',
          'export class Impl implements HasValue { value: number; constructor(v: number) { this.value = v; } compute(): number { return this.value * 2; } }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('impl HasValue for Impl');
  });

  it('emits scoped package import with rename', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'rename.ts',
      "import { Point as Pt } from './geom.js'; export function use(p: Pt): number { return p.x; }",
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('use crate::');
  });

  it('emits array element return as clone', () => {
    const output = emitIrModuleRust(
      lower('elem-return.ts', 'export function first(items: string[]): string { return items[0]; }').module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits function with returned closure as Rc', () => {
    const output = emitIrModuleRust(
      lower(
        'return-closure.ts',
        'export function maker(): (x: number) => number { return (x: number): number => x + 1; }',
      ).module,
    ).contents;
    expect(output).toContain('Rc::new(');
  });

  it('emits tagged union with shared field accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-shared.ts',
        [
          'export interface Circle { kind: string; radius: number; }',
          'export interface Square { kind: string; side: number; }',
          'export type Shape = Circle | Square;',
          'export function getKind(s: Shape): string { return s.kind; }',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('fn kind(&self)');
    expect(output).toContain('match self');
  });

  it('emits primitive union type as enum name', () => {
    const output = emitIrModuleRust(
      lower('prim-union-type.ts', 'export function accept(x: string | number): string | number { return x; }').module,
    ).contents;
    expect(output).toContain('StrOrF64');
  });

  it('emits class with multiple inherent and trait methods', () => {
    const output = emitIrModuleRust(
      lower(
        'multi-method.ts',
        [
          'export interface Measurable { measure(): number; }',
          'export class Widget implements Measurable {',
          '  width: number;',
          '  constructor(w: number) { this.width = w; }',
          '  measure(): number { return this.width; }',
          '  describe(): string { return "widget"; }',
          '}',
        ].join('\n'),
      ).module,
    ).contents;
    expect(output).toContain('impl Measurable for Widget');
    expect(output).toContain('fn describe(');
  });

  it('emits variable bound to function expression as Rc closure', () => {
    const output = emitIrModuleRust(
      lower(
        'fn-var.ts',
        'export function run(): number { const add: (a: number, b: number) => number = (a: number, b: number): number => a + b; return add(1, 2); }',
      ).module,
    ).contents;
    expect(output).toContain('Rc::new(');
  });

  it('emits Math.floor via f64 method', () => {
    const output = emitIrModuleRust(
      lower('math-floor.ts', 'export function floor(x: number): number { return Math.floor(x); }').module,
    ).contents;
    expect(output).toContain('f64::floor');
  });

  it('emits Math.abs via f64 method', () => {
    const output = emitIrModuleRust(
      lower('math-abs.ts', 'export function abs(x: number): number { return Math.abs(x); }').module,
    ).contents;
    expect(output).toContain('f64::abs');
  });

  it('emits Math.sqrt via f64 method', () => {
    const output = emitIrModuleRust(
      lower('math-sqrt.ts', 'export function root(x: number): number { return Math.sqrt(x); }').module,
    ).contents;
    expect(output).toContain('f64::sqrt');
  });

  it('rejects array findIndex without a Rust ambient member binding', () => {
    expect(() =>
      emitIrModuleRust(
        lower(
          'arr-findindex.ts',
          'export function idx(items: number[]): number { return items.findIndex((x: number): boolean => x > 0); }',
        ).module,
      ),
    ).toThrow(/array member findIndex has no Rust binding/);
  });

  it('emits object type as anonymous record struct', () => {
    const output = emitIrModuleRust(
      lower('anon-record.ts', 'export function point(): { x: number; y: number } { return { x: 1, y: 2 }; }').module,
    ).contents;
    expect(output).toContain('pub struct');
    expect(output).toContain('pub x: f64');
    expect(output).toContain('pub y: f64');
  });

  it('emits array with sparse elements as Default::default()', () => {
    const output = emitIrModuleRust(
      lower('sparse-arr.ts', 'export function sparse(): number[] { return [1, 2, 3]; }').module,
    ).contents;
    expect(output).toContain('vec![');
  });

  it('emits comparison operators between numbers', () => {
    const output = emitIrModuleRust(
      lower('compare-ops.ts', 'export function gt(a: number, b: number): boolean { return a > b; }').module,
    ).contents;
    expect(output).toContain('>');
  });

  it('emits logical AND/OR between booleans', () => {
    const output = emitIrModuleRust(
      lower('logical-ops.ts', 'export function both(a: boolean, b: boolean): boolean { return a && b; }').module,
    ).contents;
    expect(output).toContain('&&');
  });

  it('emits strict equality between same types', () => {
    const output = emitIrModuleRust(
      lower('strict-eq.ts', 'export function same(a: number, b: number): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('==');
  });

  it('refuses regexp expressions before lowering', () => {
    const result = lower('regexp.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = { kind: 'regexp', pattern: 'test', flags: '' };
    }
    expect(() => emitIrModuleRust(module)).toThrow('regular expressions');
  });

  it('refuses spread expressions in non-Math contexts', () => {
    const result = lower('spread.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = {
        kind: 'spread',
        expression: { kind: 'literal', value: 1 },
      };
    }
    expect(() => emitIrModuleRust(module)).toThrow('spreading');
  });

  it('refuses class constructor with this reference on right side', () => {
    const result = lower(
      'this-ref.ts',
      `export class Foo {
        x: number;
        y: number;
        constructor(v: number) { this.x = v; this.y = v; }
      }`,
    );
    const module = structuredClone(result.module);
    const cls = module.declarations.find((d: { kind: string }) => d.kind === 'class');
    if (cls?.kind === 'class' && cls.classConstructor) {
      const lastStmt = cls.classConstructor.body[cls.classConstructor.body.length - 1];
      if (lastStmt?.kind === 'expression' && lastStmt.expression.kind === 'assignment') {
        (lastStmt.expression as unknown as { right: unknown }).right = {
          kind: 'property',
          object: { kind: 'identifier', reference: { kind: 'this' }, presence: 'required' },
          name: 'x',
          optional: false,
          semantics: { receivers: [] },
        };
      }
    }
    expect(() => emitIrModuleRust(module)).toThrow('initialization lowering');
  });

  it('refuses enum discriminant outside i32 range', () => {
    const result = lower('big-enum.ts', 'export enum Small { A = 1 }');
    const module = structuredClone(result.module);
    const decl = module.declarations.find((d: { kind: string }) => d.kind === 'enum');
    if (decl?.kind === 'enum') {
      (decl.members[0] as unknown as { value: number }).value = 3_000_000_000;
    }
    expect(() => emitIrModuleRust(module)).toThrow('i32 range');
  });

  it('refuses enum with mixed discriminant domains', () => {
    const result = lower('mixed-enum.ts', 'export enum Mixed { A = 1 }');
    const module = structuredClone(result.module);
    const decl = module.declarations.find((d: { kind: string }) => d.kind === 'enum');
    if (decl?.kind === 'enum') {
      (decl.members as unknown as { name: string; value: number }[]).push({ name: 'B', value: 1.5 });
    }
    expect(() => emitIrModuleRust(module)).toThrow('discriminant domain');
  });

  it('refuses super identifier reference', () => {
    const result = lower('super-ref.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = {
        kind: 'identifier',
        reference: { kind: 'super' },
        presence: 'required',
      };
    }
    expect(() => emitIrModuleRust(module)).toThrow('super');
  });

  it('refuses bare undefined ambient reference', () => {
    const result = lower('undef-ref.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = {
        kind: 'identifier',
        reference: { kind: 'ambient', name: 'undefined' },
        presence: 'required',
      };
    }
    expect(() => emitIrModuleRust(module)).toThrow('Option-aware lowering');
  });

  it('refuses nullish comparison that admits both null and undefined', () => {
    const result = lower(
      'both-nullish.ts',
      'export function check(x: number | undefined): boolean { return x === undefined; }',
    );
    const module = structuredClone(result.module);
    const fn = module.declarations[0];
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (
          stmt.kind === 'return' &&
          stmt.expression?.kind === 'binary' &&
          stmt.expression.semantics.nullishComparison
        ) {
          (stmt.expression.semantics.nullishComparison as unknown as { admitsNull: boolean }).admitsNull = true;
          (stmt.expression.semantics.nullishComparison as unknown as { admitsUndefined: boolean }).admitsUndefined =
            true;
        }
      }
    }
    expect(() => emitIrModuleRust(module)).toThrow('Option-aware lowering');
  });

  it('refuses binding pattern variable declaration', () => {
    const result = lower('binding-pat.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { pattern: unknown }).pattern = { kind: 'array', elements: [] };
    }
    expect(() => emitIrModuleRust(module)).toThrow();
  });

  it('refuses coalesce with non-Option left operand', () => {
    const result = lower(
      'coalesce-non-opt.ts',
      'export function run(x: number | undefined): number { return x ?? 0; }',
    );
    const module = structuredClone(result.module);
    const fn = module.declarations[0];
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'binary' && stmt.expression.operator === '??') {
          (stmt.expression.left as unknown as { kind: string }).kind = 'literal';
          (stmt.expression.left as unknown as { value: number }).value = 5;
        }
      }
    }
    expect(() => emitIrModuleRust(module)).toThrow('Option-shaped');
  });

  it('emits abstract class with state as trait-carrying-state error', () => {
    const result = lower(
      'abstract-state.ts',
      `export abstract class Shape {
        abstract area(): number;
        describe(): string { return "shape"; }
      }`,
    );
    const module = structuredClone(result.module);
    const cls = module.declarations.find((d: { kind: string }) => d.kind === 'class');
    if (cls?.kind === 'class') {
      (cls.fields as unknown as unknown[]).push({
        name: 'count',
        type: { kind: 'primitive', name: 'number' },
        static: false,
        abstract: false,
        optional: false,
        declare: false,
        visibility: 'public',
      });
    }
    expect(() => emitIrModuleRust(module)).toThrow('state a Rust trait cannot hold');
  });

  it('refuses mutable module-scoped variable', () => {
    const result = lower('mut-module.ts', 'export let counter: number = 0;');
    expect(() => emitIrModuleRust(result.module)).toThrow();
  });

  it('emits do-while loop as loop with break condition', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        `export function countdown(n: number): void {
          let i = n;
          do { i = i - 1; } while (i > 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('loop');
    expect(output).toContain('break');
  });

  it('emits template literal as format! macro', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits bitwise NOT as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitnot.ts', 'export function invert(n: number): number { return ~n; }').module,
    ).contents;
    expect(output).toContain('i32');
  });

  it('emits string enum with bidirectional conversion', () => {
    const output = emitIrModuleRust(
      lower('str-enum.ts', 'export enum Direction { Up = "UP", Down = "DOWN" }').module,
    ).contents;
    expect(output).toContain('as_str');
    expect(output).toContain('from_str');
  });

  it('emits tuple rest expression as field access', () => {
    const output = emitIrModuleRust(
      lower(
        'tuple-rest.ts',
        `export function rest(t: [number, string, boolean]): [string, boolean] {
          const [, ...tail] = t;
          return tail;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('f64');
  });

  it('emits conditional ternary as if-else expression', () => {
    const output = emitIrModuleRust(
      lower('ternary.ts', 'export function pick(flag: boolean, a: number, b: number): number { return flag ? a : b; }')
        .module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });

  it('emits array literal as vec! macro', () => {
    const output = emitIrModuleRust(
      lower('arr-lit.ts', 'export function nums(): number[] { return [1, 2, 3]; }').module,
    ).contents;
    expect(output).toContain('vec![');
  });

  it('emits string concatenation assignment as push_str', () => {
    const output = emitIrModuleRust(
      lower(
        'str-concat-assign.ts',
        'export function build(base: string): string { let s = base; s += " world"; return s; }',
      ).module,
    ).contents;
    expect(output).toContain('push_str');
  });

  it('emits bitwise assignment as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bit-assign.ts', 'export function mask(x: number, m: number): number { x &= m; return x; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits exponentiation assignment as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow-assign.ts', 'export function square(x: number): number { x **= 2; return x; }').module,
    ).contents;
    expect(output).toContain('powf');
  });

  it('emits unsigned right shift assignment as u32 cast', () => {
    const output = emitIrModuleRust(
      lower('ursh-assign.ts', 'export function ursh(x: number): number { x >>>= 2; return x; }').module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits exponentiation as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow.ts', 'export function power(base: number, exp: number): number { return base ** exp; }').module,
    ).contents;
    expect(output).toContain('powf');
  });

  it('emits unsigned right shift as u32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('ursh.ts', 'export function ursh(x: number, y: number): number { return x >>> y; }').module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits bitwise AND as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitand.ts', 'export function band(a: number, b: number): number { return a & b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits array join as join method with borrowed separator', () => {
    const output = emitIrModuleRust(
      lower('arr-join.ts', 'export function csv(items: string[]): string { return items.join(","); }').module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice as range indexing', () => {
    const output = emitIrModuleRust(
      lower('arr-slice.ts', 'export function tail(items: number[]): number[] { return items.slice(1); }').module,
    ).contents;
    expect(output).toContain('to_vec()');
  });

  it('emits array slice with two bounds as range indexing', () => {
    const output = emitIrModuleRust(
      lower('arr-slice2.ts', 'export function mid(items: number[]): number[] { return items.slice(1, 3); }').module,
    ).contents;
    expect(output).toContain('..');
    expect(output).toContain('to_vec()');
  });

  it('emits array concat as extend', () => {
    const output = emitIrModuleRust(
      lower('arr-concat.ts', 'export function merge(a: number[], b: number[]): number[] { return a.concat(b); }')
        .module,
    ).contents;
    expect(output).toContain('extend');
  });

  it('emits string charAt as chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('char-at.ts', 'export function first(s: string): string { return s.charAt(0); }').module,
    ).contents;
    expect(output).toContain('chars().nth(');
  });

  it('emits string charCodeAt as chars().nth() with u32 cast', () => {
    const output = emitIrModuleRust(
      lower('char-code.ts', 'export function code(s: string): number { return s.charCodeAt(0); }').module,
    ).contents;
    expect(output).toContain('as u32');
    expect(output).toContain('f64');
  });

  it('emits string substring as range slice', () => {
    const output = emitIrModuleRust(
      lower('substr.ts', 'export function mid(s: string): string { return s.substring(1, 3); }').module,
    ).contents;
    expect(output).toContain('to_string()');
  });

  it('emits labeled break as break with lifetime label', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-break.ts',
        `export function search(matrix: number[][]): boolean {
          outer: for (const row of matrix) {
            for (const cell of row) {
              if (cell === 42) break outer;
            }
          }
          return false;
        }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain('break');
  });

  it('emits switch with default as if-else chain', () => {
    const output = emitIrModuleRust(
      lower(
        'switch.ts',
        `export function describe(n: number): string {
          switch (n) {
            case 0: return "zero";
            case 1: return "one";
            default: return "other";
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });

  it('emits throw new Error as panic! with message', () => {
    const output = emitIrModuleRust(
      lower('throw.ts', 'export function fail(msg: string): never { throw new Error(msg); }').module,
    ).contents;
    expect(output).toContain('panic!');
  });

  it('emits try-catch as catch_unwind', () => {
    const output = emitIrModuleRust(
      lower(
        'try-catch.ts',
        `export function safe(f: () => number): number {
          try { return f(); } catch (e) { return 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('catch_unwind');
  });

  it('emits nullable variable as Option None initialization', () => {
    const output = emitIrModuleRust(
      lower(
        'nullable-var.ts',
        `export function find(items: number[]): number | undefined {
          let result: number | undefined = undefined;
          for (const item of items) { if (item > 0) { result = item; break; } }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
    expect(output).toContain('Option');
  });

  it('emits type parameter with constraint as bound', () => {
    const output = emitIrModuleRust(
      lower('generic-bound.ts', `export function identity<T extends number>(x: T): T { return x; }`).module,
    ).contents;
    expect(output).toContain('f64');
  });

  it('emits while true as loop keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'infinite.ts',
        `export function run(): number {
          let i = 0;
          while (true) { i += 1; if (i > 10) return i; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('loop');
  });

  it('emits function type as Rc<dyn Fn>', () => {
    const output = emitIrModuleRust(
      lower('fn-type.ts', `export function apply(f: (x: number) => number, v: number): number { return f(v); }`).module,
    ).contents;
    expect(output).toContain('Rc<dyn Fn');
  });

  it('emits literal type as primitive Rust type', () => {
    const output = emitIrModuleRust(
      lower('lit-type.ts', `export function truthy(): true { return true; }`).module,
    ).contents;
    expect(output).toContain('bool');
  });

  it('emits tuple type with single element trailing comma', () => {
    const output = emitIrModuleRust(
      lower('tuple-single.ts', `export function wrap(x: number): [number] { return [x]; }`).module,
    ).contents;
    expect(output).toMatch(/\(f64,\)/);
  });

  it('emits never return type as diverging function', () => {
    const output = emitIrModuleRust(
      lower('never.ts', `export function abort(): never { throw new Error("abort"); }`).module,
    ).contents;
    expect(output).toContain('-> !');
  });

  it('emits null literal as None', () => {
    const output = emitIrModuleRust(
      lower('null-lit.ts', `export function nothing(): null { return null; }`).module,
    ).contents;
    expect(output).toContain('None');
  });

  it('emits object type as named struct', () => {
    const output = emitIrModuleRust(
      lower(
        'obj-type.ts',
        `export interface Point { x: number; y: number; }
         export function origin(): Point { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Point');
  });

  it('emits nullish comparison as is_none()', () => {
    const output = emitIrModuleRust(
      lower('nullish-cmp.ts', `export function isAbsent(x: number | null): boolean { return x === null; }`).module,
    ).contents;
    expect(output).toContain('is_none()');
  });

  it('emits negated nullish comparison as is_some()', () => {
    const output = emitIrModuleRust(
      lower('nullish-cmp-neg.ts', `export function isPresent(x: number | null): boolean { return x !== null; }`).module,
    ).contents;
    expect(output).toContain('is_some()');
  });

  it('emits coalesce operator as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower('coalesce.ts', `export function fallback(x: number | null, d: number): number { return x ?? d; }`).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits string concatenation as format! macro', () => {
    const output = emitIrModuleRust(
      lower('str-concat.ts', `export function greet(name: string): string { return "hello " + name; }`).module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits array index as usize cast', () => {
    const output = emitIrModuleRust(
      lower('arr-index.ts', `export function get(items: number[], i: number): number { return items[i]; }`).module,
    ).contents;
    expect(output).toContain('as usize');
  });

  it('emits closure with body as multi-line lambda', () => {
    const output = emitIrModuleRust(
      lower(
        'closure-body.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x) => { const y = x * 2; return y; });
        }`,
      ).module,
    ).contents;
    expect(output).toContain('|x|');
  });

  it('emits class with static constant field', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
          static readonly MAX: number = 100;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('MAX');
    expect(output).toContain('100');
  });

  it('emits class constructor as new() with field assignments', () => {
    const output = emitIrModuleRust(
      lower(
        'ctor-fields.ts',
        `export class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new(');
    expect(output).toContain('Self {');
  });

  it('emits class with field initializers as auto-new()', () => {
    const output = emitIrModuleRust(
      lower(
        'field-init.ts',
        `export class Counter {
          count: number = 0;
          label: string = "default";
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new()');
    expect(output).toContain('Self {');
  });

  it('emits class implementing interface as trait impl', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-iface.ts',
        `export interface Greetable {
          greet(): string;
        }
        export class Person implements Greetable {
          name: string;
          constructor(name: string) { this.name = name; }
          greet(): string { return this.name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Greetable for Person');
  });

  it('emits abstract class as trait with default methods', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract.ts',
        `export abstract class Shape {
          abstract area(): number;
          describe(): string { return "shape"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn describe');
  });

  it('emits class extending abstract class as trait implementation', () => {
    const output = emitIrModuleRust(
      lower(
        'extends-abstract.ts',
        `export abstract class Base {
          abstract value(): number;
        }
        export class Derived extends Base {
          value(): number { return 42; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Base for Derived');
  });

  it('emits cell-wrapped mutable closure variable', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-wrap.ts',
        `export function makeCounter(): () => number {
          let count = 0;
          return () => { count += 1; return count; };
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Cell');
  });

  it('emits optional chain as Option map/and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-chain.ts',
        `export interface Obj { value: number; }
         export function safe(o: Obj | null): number | undefined { return o?.value; }`,
      ).module,
    ).contents;
    expect(output).toContain('Option');
  });

  it('emits array.slice() with no args as clone', () => {
    const output = emitIrModuleRust(
      lower('arr-clone.ts', 'export function copy(items: number[]): number[] { return items.slice(); }').module,
    ).contents;
    expect(output).toContain('clone()');
  });

  it('emits string includes as contains', () => {
    const output = emitIrModuleRust(
      lower('str-includes.ts', 'export function has(s: string, sub: string): boolean { return s.includes(sub); }')
        .module,
    ).contents;
    expect(output).toContain('contains');
  });

  it('emits string indexOf as find with unwrap_or', () => {
    const output = emitIrModuleRust(
      lower('str-indexof.ts', 'export function find(s: string, sub: string): number { return s.indexOf(sub); }').module,
    ).contents;
    expect(output).toContain('unwrap_or');
  });

  it('emits string startsWith as starts_with', () => {
    const output = emitIrModuleRust(
      lower(
        'str-starts.ts',
        'export function check(s: string, prefix: string): boolean { return s.startsWith(prefix); }',
      ).module,
    ).contents;
    expect(output).toContain('starts_with');
  });

  it('emits string split as split().collect()', () => {
    const output = emitIrModuleRust(
      lower('str-split.ts', 'export function parts(s: string, sep: string): string[] { return s.split(sep); }').module,
    ).contents;
    expect(output).toContain('split');
    expect(output).toContain('collect');
  });

  it('emits string trim as trim()', () => {
    const output = emitIrModuleRust(
      lower('str-trim.ts', 'export function clean(s: string): string { return s.trim(); }').module,
    ).contents;
    expect(output).toContain('trim');
  });

  it('emits string toLowerCase as to_lowercase', () => {
    const output = emitIrModuleRust(
      lower('str-lower.ts', 'export function low(s: string): string { return s.toLowerCase(); }').module,
    ).contents;
    expect(output).toContain('to_lowercase');
  });

  it('emits array indexOf as iter().position()', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-indexof.ts',
        'export function find(items: number[], target: number): number { return items.indexOf(target); }',
      ).module,
    ).contents;
    expect(output).toContain('position');
  });

  it('emits array filter as into_iter().filter().collect()', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-filter.ts',
        'export function positives(items: number[]): number[] { return items.filter((x) => x > 0); }',
      ).module,
    ).contents;
    expect(output).toContain('filter');
    expect(output).toContain('collect');
  });

  it('emits array find as into_iter().find()', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-find.ts',
        `export function first(items: number[]): number | undefined {
          return items.find((x) => x > 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('find');
  });

  it('emits array some as into_iter().any()', () => {
    const output = emitIrModuleRust(
      lower('arr-some.ts', 'export function hasPositive(items: number[]): boolean { return items.some((x) => x > 0); }')
        .module,
    ).contents;
    expect(output).toContain('any');
  });

  it('emits array every as into_iter().all()', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-every.ts',
        'export function allPositive(items: number[]): boolean { return items.every((x) => x > 0); }',
      ).module,
    ).contents;
    expect(output).toContain('all');
  });

  it('refuses array forEach as unbound Rust member', () => {
    expect(() =>
      emitIrModuleRust(
        lower(
          'arr-foreach.ts',
          `export function log(items: number[]): void {
            items.forEach((x) => { const _y = x; });
          }`,
        ).module,
      ),
    ).toThrow('has no Rust binding');
  });

  it('emits array.length as .len() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('arr-len.ts', 'export function size(items: number[]): number { return items.length; }').module,
    ).contents;
    expect(output).toContain('len()');
    expect(output).toContain('as f64');
  });

  it('emits string.length as .len() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('str-len.ts', 'export function size(s: string): number { return s.length; }').module,
    ).contents;
    expect(output).toContain('len()');
    expect(output).toContain('as f64');
  });

  it('emits class extending concrete base as composition', () => {
    const output = emitIrModuleRust(
      lower(
        'extends-concrete.ts',
        `export class Base {
          x: number;
          constructor(x: number) { this.x = x; }
        }
        export class Derived extends Base {
          y: number;
          constructor(x: number, y: number) {
            super(x);
            this.y = y;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('base');
    expect(output).toContain('Base');
  });

  it('emits accessor getter as method call', () => {
    const output = emitIrModuleRust(
      lower(
        'getter.ts',
        `export class Box {
          private _value: number;
          constructor(v: number) { this._value = v; }
          get value(): number { return this._value; }
        }
        export function read(b: Box): number { return b.value; }`,
      ).module,
    ).contents;
    expect(output).toContain('value()');
  });

  it('emits accessor setter as set_ method call', () => {
    const output = emitIrModuleRust(
      lower(
        'setter.ts',
        `export class Box {
          private _value: number;
          constructor(v: number) { this._value = v; }
          get value(): number { return this._value; }
          set value(v: number) { this._value = v; }
        }
        export function write(b: Box, v: number): void { b.value = v; }`,
      ).module,
    ).contents;
    expect(output).toContain('set_value');
  });

  it('emits enum member access as variant path', () => {
    const output = emitIrModuleRust(
      lower(
        'enum-access.ts',
        `export enum Color { Red, Green, Blue }
         export function red(): Color { return Color.Red; }`,
      ).module,
    ).contents;
    expect(output).toContain('Color::Red');
  });

  it('emits Math.max spread as fold', () => {
    const output = emitIrModuleRust(
      lower('math-spread.ts', `export function maxOf(items: number[]): number { return Math.max(...items); }`).module,
    ).contents;
    expect(output).toContain('fold');
  });

  it('emits switch without default as if-else with unreachable', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-no-default.ts',
        `export enum Dir { Up, Down }
         export function pick(d: Dir): string {
          switch (d) {
            case Dir.Up: return "up";
            case Dir.Down: return "down";
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('unreachable!()');
  });

  it('emits throw non-Error as debug panic', () => {
    const output = emitIrModuleRust(
      lower('throw-non-error.ts', `export function fail(msg: string): never { throw msg; }`).module,
    ).contents;
    expect(output).toContain('panic!');
    expect(output).toContain('{:?}');
  });

  it('emits class static field access as associated constant', () => {
    const output = emitIrModuleRust(
      lower(
        'static-access.ts',
        `export class Config {
          static readonly MAX: number = 100;
        }
        export function limit(): number { return Config.MAX; }`,
      ).module,
    ).contents;
    expect(output).toContain('Config::MAX');
  });

  it('emits for-in loop with closed key evidence', () => {
    const output = emitIrModuleRust(
      lower(
        'for-in.ts',
        `export interface Dict { a: number; b: number; }
         export function keys(d: Dict): void {
          for (const k in d) { const _x = k; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
  });

  it('emits class method with mutation as &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-method.ts',
        `export class Counter {
          count: number;
          constructor() { this.count = 0; }
          increment(): void { this.count += 1; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
  });

  it('emits class method without mutation as &self', () => {
    const output = emitIrModuleRust(
      lower(
        'immut-method.ts',
        `export class Counter {
          count: number;
          constructor(n: number) { this.count = n; }
          read(): number { return this.count; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('&self');
  });

  it('emits array push as method call', () => {
    const output = emitIrModuleRust(
      lower('arr-push.ts', `export function add(items: number[], v: number): void { items.push(v); }`).module,
    ).contents;
    expect(output).toContain('push');
  });

  it('emits array pop as method call', () => {
    const output = emitIrModuleRust(
      lower('arr-pop.ts', `export function removeLast(items: number[]): number | undefined { return items.pop(); }`)
        .module,
    ).contents;
    expect(output).toContain('pop');
  });

  it('emits Math.floor as f64::floor', () => {
    const output = emitIrModuleRust(
      lower('math-floor.ts', `export function floored(x: number): number { return Math.floor(x); }`).module,
    ).contents;
    expect(output).toContain('floor');
  });

  it('emits Math.abs as f64::abs', () => {
    const output = emitIrModuleRust(
      lower('math-abs.ts', `export function absolute(x: number): number { return Math.abs(x); }`).module,
    ).contents;
    expect(output).toContain('abs');
  });

  it('emits non-exported numeric enum without pub', () => {
    const output = emitIrModuleRust(
      lower(
        'internal-enum.ts',
        `enum Internal { A, B }
         export function pick(n: number): number { return n === 0 ? Internal.A : Internal.B; }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Internal');
    expect(output).not.toMatch(/pub enum Internal/);
  });

  it('emits non-exported string enum without pub', () => {
    const output = emitIrModuleRust(
      lower(
        'internal-str-enum.ts',
        `enum Tag { X = "x", Y = "y" }
         export function getTag(): string { return Tag.X; }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Tag');
    expect(output).not.toMatch(/pub enum Tag/);
  });

  it('refuses postfix increment before lowering', () => {
    expect(() =>
      emitIrModuleRust(
        lower('postfix.ts', 'export function countUp(n: number): number { let x = n; x++; return x; }').module,
      ),
    ).toThrow('postfix ++');
  });

  it('emits substring with one argument as open range', () => {
    const output = emitIrModuleRust(
      lower('substr1.ts', `export function tail(s: string): string { return s.substring(1); }`).module,
    ).contents;
    expect(output).toContain('..');
    expect(output).toContain('to_string()');
  });

  it('emits transitive mutation as &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'transitive-mut.ts',
        `export class Counter {
          count: number;
          constructor() { this.count = 0; }
          increment(): void { this.count += 1; }
          doubleIncrement(): void { this.increment(); this.increment(); }
        }`,
      ).module,
    ).contents;
    expect(output).toMatch(/fn double_increment\(&mut self\)/);
  });

  it('emits class with private static field without pub', () => {
    const output = emitIrModuleRust(
      lower(
        'private-static.ts',
        `export class Config {
          private static readonly SECRET: number = 42;
          static getSecret(): number { return Config.SECRET; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('SECRET');
  });

  it('emits interface as struct when not implemented by class', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-struct.ts',
        `export interface Point { x: number; y: number; }
         export function make(x: number, y: number): Point { return { x, y }; }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Point');
  });

  it('emits class with abstract field as trait getter', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-field.ts',
        `export abstract class Named {
          abstract readonly name: string;
          describe(): string { return this.name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name');
  });

  it('emits class accessor read from external call site', () => {
    const output = emitIrModuleRust(
      lower(
        'accessor-read.ts',
        `export class Temp {
          private _celsius: number;
          constructor(c: number) { this._celsius = c; }
          get celsius(): number { return this._celsius; }
        }
        export function read(t: Temp): number { return t.celsius; }`,
      ).module,
    ).contents;
    expect(output).toContain('celsius()');
  });

  it('emits type alias as Rust type alias', () => {
    const output = emitIrModuleRust(
      lower(
        'type-alias.ts',
        `export type Numeric = number;
         export function add(a: Numeric, b: Numeric): Numeric { return a + b; }`,
      ).module,
    ).contents;
    expect(output).toContain('type Numeric');
  });

  it('emits optional parameter as Option wrapper', () => {
    const output = emitIrModuleRust(
      lower('opt-param.ts', `export function greet(name?: string): string { return name ?? "world"; }`).module,
    ).contents;
    expect(output).toContain('Option<String>');
  });

  it('emits default parameter as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower('default-param.ts', `export function greet(name: string = "world"): string { return name; }`).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits void return as empty tuple', () => {
    const output = emitIrModuleRust(lower('void-return.ts', `export function noop(): void {}`).module).contents;
    expect(output).toContain('()');
  });

  it('emits undefinedDefault expression as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-default.ts',
        `export function orZero(x: number | undefined, fallback: number): number {
          return x !== undefined ? x : fallback;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn or_zero');
  });

  it('refuses intersection type before lowering', () => {
    const module = structuredClone(lower('inter.ts', 'export function id(x: number): number { return x; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      (fn as { returns: { kind: string } }).returns = { kind: 'intersection', types: [] } as never;
    }
    expect(() => emitIrModuleRust(module)).toThrow('intersection types require');
  });

  it('refuses Partial type before lowering', () => {
    const module = structuredClone(lower('partial.ts', 'export function id(x: number): number { return x; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      (fn as { returns: { kind: string; reference: unknown; typeArguments: unknown[] } }).returns = {
        kind: 'named',
        reference: { kind: 'ambient', name: 'Partial' },
        typeArguments: [{ kind: 'primitive', name: 'number' }],
      } as never;
    }
    expect(() => emitIrModuleRust(module)).toThrow('Partial<T> requires');
  });

  it('refuses synchronous try/finally', () => {
    const module = structuredClone(
      lower(
        'try-finally.ts',
        `export function safe(f: () => number): number {
          try { return f(); } catch (e) { return 0; }
        }`,
      ).module,
    );
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      const tryStmt = fn.body.find((s) => s.kind === 'try') as IrStatement & { kind: 'try' };
      if (tryStmt) {
        (tryStmt as { finallyBody: unknown }).finallyBody = {
          kind: 'block',
          statements: [],
        };
      }
    }
    expect(() => emitIrModuleRust(module)).toThrow('synchronous try/finally');
  });

  it('emits unary prefix minus as negation', () => {
    const output = emitIrModuleRust(
      lower('negate.ts', 'export function neg(x: number): number { return -x; }').module,
    ).contents;
    expect(output).toContain('-');
  });

  it('emits logical not as prefix !', () => {
    const output = emitIrModuleRust(
      lower('not.ts', 'export function negate(b: boolean): boolean { return !b; }').module,
    ).contents;
    expect(output).toContain('!');
  });

  it('emits cast expression as Rust as', () => {
    const module = structuredClone(lower('cast.ts', 'export function id(x: number): number { return x; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      const ret = fn.body.find((s) => s.kind === 'return') as IrStatement & { kind: 'return' };
      if (ret?.expression) {
        (ret as { expression: unknown }).expression = {
          kind: 'cast',
          expression: ret.expression,
          type: { kind: 'primitive', name: 'number' },
        };
      }
    }
    const output = emitIrModuleRust(module).contents;
    expect(output).toContain(' as ');
  });

  it('emits unknown type as opaque host value', () => {
    const output = emitIrModuleRust(
      lower('unknown-type.ts', `export function accept(x: unknown): unknown { return x; }`).module,
    ).contents;
    expect(output).toContain('OpaqueHostValue');
  });

  it('emits narrowed nullable property access as unwrap borrow', () => {
    const output = emitIrModuleRust(
      lower(
        'narrow-prop.ts',
        `export interface Item { value: number; }
         export function read(x: Item | null): number {
          if (x !== null) { return x.value; }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap');
  });

  it('emits optional property chain as map/and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-prop.ts',
        `export interface Obj { value: number; }
         export function safe(o: Obj | null): number | undefined { return o?.value; }`,
      ).module,
    ).contents;
    expect(output).toContain('map');
    expect(output).toContain('optional_chain_value');
  });

  it('emits assignment to nullable binding as Some-wrapped', () => {
    const output = emitIrModuleRust(
      lower(
        'nullable-assign.ts',
        `export function update(items: number[]): number | undefined {
          let result: number | undefined = undefined;
          for (const item of items) { result = item; }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Some(');
  });

  it('emits cell-wrapped compound assignment as get/set round-trip', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-compound.ts',
        `export function accumulate(): () => number {
          let sum = 0;
          return () => { sum += 10; return sum; };
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.get()');
    expect(output).toContain('.set(');
  });

  it('emits string replace as Rust replace', () => {
    const output = emitIrModuleRust(
      lower('str-replace.ts', `export function fix(s: string): string { return s.replace("old", "new"); }`).module,
    ).contents;
    expect(output).toContain('replace');
  });

  it('emits string endsWith as ends_with', () => {
    const output = emitIrModuleRust(
      lower('str-ends.ts', `export function check(s: string, suffix: string): boolean { return s.endsWith(suffix); }`)
        .module,
    ).contents;
    expect(output).toContain('ends_with');
  });

  it('emits string toUpperCase as to_uppercase', () => {
    const output = emitIrModuleRust(
      lower('str-upper.ts', `export function up(s: string): string { return s.toUpperCase(); }`).module,
    ).contents;
    expect(output).toContain('to_uppercase');
  });

  it('emits array reduce as into_iter().fold()', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-reduce.ts',
        `export function sum(items: number[]): number {
          return items.reduce((acc, x) => acc + x, 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fold');
  });

  it('emits array map with function reference as wrapper closure', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-map-ref.ts',
        `export function double(x: number): number { return x * 2; }
         export function apply(items: number[]): number[] { return items.map(double); }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('map');
  });

  it('emits class with extends and composition field access', () => {
    const output = emitIrModuleRust(
      lower(
        'composition-field.ts',
        `export class Base {
          x: number;
          constructor(x: number) { this.x = x; }
          getX(): number { return this.x; }
        }
        export class Child extends Base {
          y: number;
          constructor(x: number, y: number) { super(x); this.y = y; }
          sum(): number { return this.x + this.y; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('base');
  });

  it('emits interface with data property as trait accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-data.ts',
        `export interface Named {
          name: string;
          greet(): string;
        }
        export class Person implements Named {
          name: string;
          constructor(name: string) { this.name = name; }
          greet(): string { return this.name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self)');
  });

  it('emits for-of loop over array with borrow prefix', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of-borrow.ts',
        `export function sumArr(matrix: number[][]): number {
          let total = 0;
          for (const row of matrix) { total += row.length; }
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
  });

  it('emits symbol type as FlightSymbol', () => {
    const module = structuredClone(lower('symbol.ts', 'export function id(x: number): number { return x; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      (fn as { returns: { kind: string; name: string } }).returns = { kind: 'primitive', name: 'symbol' } as never;
    }
    const output = emitIrModuleRust(module).contents;
    expect(output).toContain('FlightSymbol');
  });

  it('emits Readonly<T> type as T passthrough', () => {
    const output = emitIrModuleRust(
      lower('readonly.ts', `export function copy(items: Readonly<number[]>): number { return items[0]; }`).module,
    ).contents;
    expect(output).toContain('Vec<f64>');
  });

  it('emits Required<T> type as T passthrough', () => {
    const module = structuredClone(lower('required.ts', 'export function id(x: number): number { return x; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      (fn as { returns: { kind: string; reference: unknown; typeArguments: unknown[] } }).returns = {
        kind: 'named',
        reference: { kind: 'ambient', name: 'Required' },
        typeArguments: [{ kind: 'primitive', name: 'number' }],
      } as never;
    }
    const output = emitIrModuleRust(module).contents;
    expect(output).toContain('f64');
  });

  it('emits array with sparse element as Default::default()', () => {
    const module = structuredClone(lower('sparse.ts', 'export function arr(): number[] { return [1, 2]; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      const ret = fn.body.find((s) => s.kind === 'return') as IrStatement & { kind: 'return' };
      if (ret?.expression?.kind === 'array') {
        (ret.expression as { elements: unknown[] }).elements = [
          ret.expression.elements[0],
          undefined,
          ret.expression.elements[1],
        ];
      }
    }
    const output = emitIrModuleRust(module).contents;
    expect(output).toContain('Default::default()');
  });

  it('emits return with narrowed-present identifier as unwrap', () => {
    const output = emitIrModuleRust(
      lower(
        'narrow-return.ts',
        `export function first(items: number[]): number | undefined {
          const found = items.find((x) => x > 0);
          if (found !== undefined) return found;
          return undefined;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('find');
  });
});
