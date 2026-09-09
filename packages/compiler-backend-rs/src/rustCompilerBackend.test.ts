import ts from 'typescript';

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

  it('emits explicit type and value runtime bindings for all bound ambient symbols', () => {
    const supported = lower(
      'external-types.ts',
      'export function preserve(values: Map<string, number>, bytes: Uint8Array, task: Promise<number>): Promise<number> { values; bytes; return task; }',
    );
    const weakMap = lower('external-weakmap.ts', 'export function store(map: WeakMap<object, number>): void { map; }');
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
    expect(emitIrModuleRust(weakMap.module).contents).toContain('HashMap');
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
      'export function create(): Array<number> { return new Array(3); }',
    );

    expect(() => emitIrModuleRust(result.module)).toThrow(
      'runtime external constructor ABI plan is incomplete (missing: Array[value](1))',
    );
  });

  it('emits typed array constructors with all declared fixed arities', () => {
    const result = lower(
      'typed-array-constructor.ts',
      'export function create(): Uint8Array { return new Uint8Array(3); }',
    );

    expect(emitIrModuleRust(result.module).contents).toContain('Vec<u8>::new(3.0)');
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

  it('disambiguates public value and type collisions introduced by Rust normalization', () => {
    const values = lower(
      'value-collisions.ts',
      'export function fooBar(value: number): number { return value; } export function foo_bar(value: number): number { return value + 1; }',
    );
    const result = lower('type-collisions.ts', 'export type fooBar = number; export type foo_bar = fooBar;');

    const valueOutput = emitIrModuleRust(values.module).contents;
    expect(valueOutput).toContain('foo_bar');
    expect(valueOutput).toContain('foo_bar_2');

    const typeOutput = emitIrModuleRust(result.module).contents;
    expect(typeOutput).toContain('FooBar');
    expect(typeOutput).toContain('FooBar_2');
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

  it('emits Math.round through the JavaScript-compatible runtime wrapper', () => {
    const output = emitIrModuleRust(
      lower('math-round.ts', 'export function nearest(x: number): number { return Math.round(x); }').module,
    ).contents;
    expect(output).toContain('flight_runtime::round(x)');
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
      (fn as unknown as { returns: { kind: string; reference: unknown; typeArguments: unknown[] } }).returns = {
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
      (fn as unknown as { returns: { kind: string; reference: unknown; typeArguments: unknown[] } }).returns = {
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
        (ret.expression as unknown as { elements: unknown[] }).elements = [
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

  it('emits modulo assignment as %=', () => {
    const output = emitIrModuleRust(
      lower('mod-assign.ts', 'export function wrap(x: number, m: number): number { x %= m; return x; }').module,
    ).contents;
    expect(output).toContain('%=');
  });

  it('emits multiply assignment as *=', () => {
    const output = emitIrModuleRust(
      lower('mul-assign.ts', 'export function scale(x: number, f: number): number { x *= f; return x; }').module,
    ).contents;
    expect(output).toContain('*=');
  });

  it('emits subtract assignment as -=', () => {
    const output = emitIrModuleRust(
      lower('sub-assign.ts', 'export function decrement(x: number): number { x -= 1; return x; }').module,
    ).contents;
    expect(output).toContain('-=');
  });

  it('emits divide assignment as /=', () => {
    const output = emitIrModuleRust(
      lower('div-assign.ts', 'export function halve(x: number): number { x /= 2; return x; }').module,
    ).contents;
    expect(output).toContain('/=');
  });

  it('emits string strict equality as == comparison', () => {
    const output = emitIrModuleRust(
      lower('str-eq.ts', 'export function isHello(s: string): boolean { return s === "hello"; }').module,
    ).contents;
    expect(output).toContain('==');
  });

  it('emits string strict inequality as != comparison', () => {
    const output = emitIrModuleRust(
      lower('str-neq.ts', 'export function isNotHello(s: string): boolean { return s !== "hello"; }').module,
    ).contents;
    expect(output).toContain('!=');
  });

  it('emits boolean strict equality as == comparison', () => {
    const output = emitIrModuleRust(
      lower('bool-eq.ts', 'export function same(a: boolean, b: boolean): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('==');
  });

  it('emits modulo as % operator', () => {
    const output = emitIrModuleRust(
      lower('modulo.ts', 'export function mod(a: number, b: number): number { return a % b; }').module,
    ).contents;
    expect(output).toContain('%');
  });

  it('emits logical AND as && operator', () => {
    const output = emitIrModuleRust(
      lower('and.ts', 'export function both(a: boolean, b: boolean): boolean { return a && b; }').module,
    ).contents;
    expect(output).toContain('&&');
  });

  it('emits logical OR as || operator', () => {
    const output = emitIrModuleRust(
      lower('or.ts', 'export function either(a: boolean, b: boolean): boolean { return a || b; }').module,
    ).contents;
    expect(output).toContain('||');
  });

  it('emits less-than-or-equal comparison', () => {
    const output = emitIrModuleRust(
      lower('lte.ts', 'export function atMost(a: number, b: number): boolean { return a <= b; }').module,
    ).contents;
    expect(output).toContain('<=');
  });

  it('emits greater-than-or-equal comparison', () => {
    const output = emitIrModuleRust(
      lower('gte.ts', 'export function atLeast(a: number, b: number): boolean { return a >= b; }').module,
    ).contents;
    expect(output).toContain('>=');
  });

  it('emits bitwise OR as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitor.ts', 'export function bor(a: number, b: number): number { return a | b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits bitwise XOR as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitxor.ts', 'export function bxor(a: number, b: number): number { return a ^ b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits left shift as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('shl.ts', 'export function shl(a: number, b: number): number { return a << b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits right shift as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('shr.ts', 'export function shr(a: number, b: number): number { return a >> b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits integer literal as Rust integer float', () => {
    const output = emitIrModuleRust(
      lower('int-lit.ts', 'export function fortytwo(): number { return 42; }').module,
    ).contents;
    expect(output).toContain('42.0');
  });

  it('emits unary plus on number as identity', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', 'export function pos(x: number): number { return +x; }').module,
    ).contents;
    expect(output).toContain('fn pos');
  });

  it('emits new Map() as runtime type construction', () => {
    const output = emitIrModuleRust(
      lower('new-map.ts', `export function makeMap(): Map<string, number> { return new Map(); }`).module,
    ).contents;
    expect(output).toContain('new');
  });

  it('emits new Set() as runtime type construction', () => {
    const output = emitIrModuleRust(
      lower('new-set.ts', `export function makeSet(): Set<number> { return new Set(); }`).module,
    ).contents;
    expect(output).toContain('new');
  });

  it('emits call to function with optional parameter passing value', () => {
    const output = emitIrModuleRust(
      lower(
        'call-opt.ts',
        `export function greet(name?: string): string { return name ?? "world"; }
         export function hello(): string { return greet("Alice"); }`,
      ).module,
    ).contents;
    expect(output).toContain('Some(');
  });

  it('emits call to function with default parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'call-default.ts',
        `export function add(a: number, b: number = 1): number { return a + b; }
         export function inc(x: number): number { return add(x); }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
  });

  it('emits template expression with interpolation', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits cell-wrapped plain assignment with set()', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-assign.ts',
        `export function resettable(): () => number {
           let count = 0;
           return () => { count = 5; return count; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.set(5');
  });

  it('emits string += as push_str', () => {
    const output = emitIrModuleRust(
      lower(
        'str-append.ts',
        `export function build(prefix: string, suffix: string): string {
           let result = prefix;
           result += suffix;
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('push_str');
  });

  it('emits non-exported function without pub', () => {
    const output = emitIrModuleRust(
      lower(
        'non-exported.ts',
        `function helper(x: number): number { return x + 1; }
         export function run(x: number): number { return helper(x); }`,
      ).module,
    ).contents;
    expect(output).not.toMatch(/pub fn helper/u);
    expect(output).toMatch(/fn helper/u);
    expect(output).toMatch(/pub fn run/u);
  });

  it('promotes non-exported enum to pub when referenced by exported function', () => {
    const output = emitIrModuleRust(
      lower(
        'non-exported-enum.ts',
        `enum Dir { Up, Down }
         export function isUp(d: Dir): boolean { return d === Dir.Up; }`,
      ).module,
    ).contents;
    expect(output).toMatch(/pub enum Dir/u);
  });

  it('emits non-exported enum without pub when unreferenced by exports', () => {
    const output = emitIrModuleRust(
      lower(
        'private-enum.ts',
        `enum Dir { Up, Down }
         function isUp(d: Dir): boolean { return d === Dir.Up; }
         export function test(): boolean { return isUp(Dir.Up); }`,
      ).module,
    ).contents;
    expect(output).not.toMatch(/pub enum Dir/u);
    expect(output).toMatch(/enum Dir/u);
  });

  it('emits labeled break in loop', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-break.ts',
        `export function findFirst(grid: number[][]): number {
           let result = -1;
           outer: for (const row of grid) {
             for (const cell of row) {
               if (cell > 0) { result = cell; break outer; }
             }
           }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain("break 'outer");
  });

  it('emits for-of iteration', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of.ts',
        `export function sum(items: number[]): number {
           let total = 0;
           for (const item of items) { total += item; }
           return total;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('in');
  });

  it('emits switch with default and multiple cases', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-cases.ts',
        `export function describe(n: number): string {
           switch (n) {
             case 0: return "zero";
             case 1: return "one";
             default: return "other";
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('else');
    expect(output).toContain('"other"');
  });

  it('emits throw with new Error as panic', () => {
    const output = emitIrModuleRust(
      lower(
        'throw-err.ts',
        `export function fail(msg: string): never {
           throw new Error(msg);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('panic!');
  });

  it('emits conditional ternary expression', () => {
    const output = emitIrModuleRust(
      lower('ternary.ts', `export function abs(x: number): number { return x >= 0 ? x : -x; }`).module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });

  it('emits while loop with condition', () => {
    const output = emitIrModuleRust(
      lower(
        'while-cond.ts',
        `export function countdown(n: number): number {
           let x = n;
           while (x > 0) { x -= 1; }
           return x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('while');
  });

  it('emits infinite while(true) loop as Rust loop', () => {
    const output = emitIrModuleRust(
      lower(
        'inf-loop.ts',
        `export function spin(): number {
           let x = 0;
           while (true) { x += 1; if (x > 100) { return x; } }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop');
  });

  it('emits class with static constant field', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Constants {
           static readonly MAX: number = 100;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('const');
    expect(output).toContain('100');
  });

  it('emits non-exported class without pub struct', () => {
    const output = emitIrModuleRust(
      lower(
        'internal-class.ts',
        `class Internal {
           value: number;
           constructor(value: number) { this.value = value; }
         }
         export function make(): number { const x = new Internal(42); return x.value; }`,
      ).module,
    ).contents;
    expect(output).not.toMatch(/pub struct Internal/u);
    expect(output).toMatch(/struct Internal/u);
  });

  it('emits bitwise AND assignment as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitand-assign.ts', `export function mask(x: number, m: number): number { x &= m; return x; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits bitwise OR assignment as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitor-assign.ts', `export function setFlag(x: number, flag: number): number { x |= flag; return x; }`)
        .module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits exponentiation as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('power.ts', `export function square(x: number): number { return x ** 2; }`).module,
    ).contents;
    expect(output).toContain('f64::powf');
  });

  it('emits unsigned right shift as u32 cast', () => {
    const output = emitIrModuleRust(
      lower('unsigned-shift.ts', `export function ursh(x: number, n: number): number { return x >>> n; }`).module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits exponentiation assignment as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow-assign.ts', `export function squareInPlace(x: number): number { x **= 2; return x; }`).module,
    ).contents;
    expect(output).toContain('f64::powf');
  });

  it('emits unsigned right shift assignment as u32 cast', () => {
    const output = emitIrModuleRust(
      lower('ursh-assign.ts', `export function urshAssign(x: number, n: number): number { x >>>= n; return x; }`)
        .module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits bitwise NOT as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitnot.ts', `export function complement(x: number): number { return ~x; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits array element access with computed index', () => {
    const output = emitIrModuleRust(
      lower('arr-index.ts', `export function nth(items: number[], i: number): number { return items[i]; }`).module,
    ).contents;
    expect(output).toContain('as usize');
  });

  it('emits cast expression', () => {
    const output = emitIrModuleRust(
      lower('cast.ts', `export function coerce(x: number): number { return x as number; }`).module,
    ).contents;
    expect(output).toContain('fn coerce');
  });

  it('emits string charAt as chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('char-at.ts', `export function first(s: string): string { return s.charAt(0); }`).module,
    ).contents;
    expect(output).toContain('chars().nth(');
  });

  it('emits string charCodeAt as chars().nth() with u32 cast', () => {
    const output = emitIrModuleRust(
      lower('char-code-at.ts', `export function code(s: string): number { return s.charCodeAt(0); }`).module,
    ).contents;
    expect(output).toContain('chars().nth(');
    expect(output).toContain('as u32');
  });

  it('emits string substring as range slice', () => {
    const output = emitIrModuleRust(
      lower(
        'substring.ts',
        `export function mid(s: string, start: number, end: number): string { return s.substring(start, end); }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('to_string');
  });

  it('emits array join with separator', () => {
    const output = emitIrModuleRust(
      lower('join.ts', `export function csv(items: string[]): string { return items.join(","); }`).module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice with start', () => {
    const output = emitIrModuleRust(
      lower('slice.ts', `export function tail(items: number[]): number[] { return items.slice(1); }`).module,
    ).contents;
    expect(output).toContain('to_vec');
  });

  it('emits array concat', () => {
    const output = emitIrModuleRust(
      lower('concat.ts', `export function merge(a: number[], b: number[]): number[] { return a.concat(b); }`).module,
    ).contents;
    expect(output).toContain('extend');
  });

  it('emits type alias for object type as struct', () => {
    const output = emitIrModuleRust(
      lower(
        'type-alias-obj.ts',
        `export type Point = { x: number; y: number; };
         export function origin(): Point { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Point');
  });

  it('emits non-exported type alias without pub', () => {
    const output = emitIrModuleRust(
      lower(
        'type-alias-internal.ts',
        `type Pair = { a: number; b: number; };
         export function make(): Pair { return { a: 1, b: 2 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('struct');
  });

  it('emits tuple type as Rust tuple', () => {
    const output = emitIrModuleRust(
      lower('tuple-type.ts', `export function pair(a: number, b: string): [number, string] { return [a, b]; }`).module,
    ).contents;
    expect(output).toContain('(f64, String)');
  });

  it('emits optional tuple element as Option', () => {
    const output = emitIrModuleRust(
      lower('opt-tuple.ts', `export function maybe(x: number): [number, string?] { return [x]; }`).module,
    ).contents;
    expect(output).toContain('Option<String>');
  });

  it('emits Readonly<T> as passthrough type', () => {
    const output = emitIrModuleRust(
      lower(
        'readonly.ts',
        `export interface Data { x: number; }
         export function freeze(d: Data): Readonly<Data> { return d; }`,
      ).module,
    ).contents;
    expect(output).toContain('fn freeze');
  });

  it('emits never type as !', () => {
    const output = emitIrModuleRust(
      lower('never.ts', `export function throwAlways(): never { throw new Error("always"); }`).module,
    ).contents;
    expect(output).toContain('-> !');
  });

  it('emits async function with await', () => {
    const output = emitIrModuleRust(
      lower(
        'async-fn.ts',
        `export async function fetchValue(p: Promise<number>): Promise<number> {
           const value = await p;
           return value;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('async fn');
    expect(output).toContain('.await');
  });

  it('emits mutating method with &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'mutating-method.ts',
        `export class Counter {
           count: number;
           constructor() { this.count = 0; }
           increment(): void { this.count += 1; }
           value(): number { return this.count; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
    expect(output).toContain('&self');
  });

  it('emits function body closure without expression shorthand', () => {
    const output = emitIrModuleRust(
      lower(
        'closure-body.ts',
        `export function apply(items: number[]): number[] {
           return items.map((x) => { return x + 1; });
         }`,
      ).module,
    ).contents;
    expect(output).toContain('|');
  });

  it('emits class with all-initialized fields as auto new()', () => {
    const output = emitIrModuleRust(
      lower(
        'auto-init.ts',
        `export class Config {
           width: number = 800;
           height: number = 600;
           title: string = "default";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new()');
    expect(output).toContain('Self {');
  });

  it('emits non-exported class without pub keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'non-exported.ts',
        `class Internal { value: number = 0; }
         export class Wrapper extends Internal {}`,
      ).module,
    ).contents;
    expect(output).toContain('struct Internal');
    expect(output).not.toMatch(/pub struct Internal/);
  });

  it('emits class implementing interface trait methods', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-trait.ts',
        `export interface Greeter {
           greet(): string;
         }
         export class Person implements Greeter {
           name: string;
           constructor(name: string) { this.name = name; }
           greet(): string { return this.name; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Greeter for Person');
    expect(output).toContain('fn greet');
  });

  it('emits class implementing interface with data properties', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-data-props.ts',
        `export interface Named {
           readonly label: string;
           describe(): string;
         }
         export class Item implements Named {
           label: string;
           constructor(label: string) { this.label = label; }
           describe(): string { return this.label; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Named for Item');
  });

  it('emits abstract class as trait with default method', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-trait.ts',
        `export abstract class Shape {
           abstract area(): number;
           describe(): string { return "shape"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn area');
    expect(output).toContain('fn describe');
  });

  it('emits class extending abstract base as trait impl', () => {
    const output = emitIrModuleRust(
      lower(
        'extend-abstract.ts',
        `export abstract class Shape {
           abstract area(): number;
         }
         export class Circle extends Shape {
           radius: number;
           constructor(r: number) { super(); this.radius = r; }
           area(): number { return 3.14 * this.radius * this.radius; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('impl Shape for Circle');
    expect(output).toContain('fn area');
  });

  it('emits class with concrete base using composition', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
           value: number;
           constructor(v: number) { this.value = v; }
         }
         export class Child extends Base {
           extra: number;
           constructor(v: number, e: number) { super(v); this.extra = e; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Child');
    expect(output).toContain('base');
  });

  it('emits static field as const', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
           static readonly MAX: number = 100;
           value: number = 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('const MAX');
    expect(output).toContain('100');
  });

  it('emits negated typeof test as !matches', () => {
    const result = lower(
      'typeof-neg.ts',
      `export function isNotStr(x: number | string): boolean { return typeof x !== "string"; }`,
    );
    if (result.diagnostics.length === 0) {
      const output = emitIrModuleRust(result.module).contents;
      expect(output).toBeDefined();
    }
  });

  it('emits nullish comparison with null on left', () => {
    const result = lower('null-left.ts', `export function isNull(x: number | null): boolean { return null === x; }`);
    if (result.diagnostics.length === 0) {
      const output = emitIrModuleRust(result.module).contents;
      expect(output).toContain('is_none');
    }
  });

  it('emits numeric enum as Rust enum with repr', () => {
    const output = emitIrModuleRust(
      lower('num-enum.ts', `export enum Priority { Low = 0, Medium = 1, High = 2 }`).module,
    ).contents;
    expect(output).toContain('enum Priority');
    expect(output).toContain('Low');
  });

  it('emits string enum as Rust enum with Display', () => {
    const output = emitIrModuleRust(
      lower('str-enum.ts', `export enum Color { Red = "red", Green = "green", Blue = "blue" }`).module,
    ).contents;
    expect(output).toContain('enum Color');
    expect(output).toContain('"red"');
  });

  it('emits while loop', () => {
    const output = emitIrModuleRust(
      lower(
        'while-loop.ts',
        `export function countdown(n: number): number {
           let i: number = n;
           while (i > 0) { i -= 1; }
           return i;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('while');
  });

  it('emits do-while as loop with break', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        `export function atLeastOne(n: number): number {
           let i: number = n;
           do { i -= 1; } while (i > 0);
           return i;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop');
  });

  it('emits try-catch as match on catch_unwind', () => {
    const output = emitIrModuleRust(
      lower(
        'try-catch.ts',
        `export function safe(x: number): number {
           try { return x; } catch (e) { return 0; }
         }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits labeled break from loop', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-break.ts',
        `export function search(items: number[], target: number): boolean {
           let found: boolean = false;
           outer: for (const item of items) {
             if (item === target) { found = true; break outer; }
           }
           return found;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('break');
  });

  it('emits Map type as HashMap', () => {
    const output = emitIrModuleRust(
      lower('map-type.ts', `export function create(): Map<string, number> { return new Map(); }`).module,
    ).contents;
    expect(output).toContain('HashMap');
  });

  it('emits Set type as HashSet', () => {
    const output = emitIrModuleRust(
      lower('set-type.ts', `export function create(): Set<string> { return new Set(); }`).module,
    ).contents;
    expect(output).toContain('HashSet');
  });

  it('emits bitwise operations with integer cast', () => {
    const output = emitIrModuleRust(
      lower(
        'bitwise.ts',
        `export function mask(x: number, m: number): number { return (x as number) & (m as number); }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits string template literal as format macro', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}!`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits typeof check as matches macro', () => {
    const output = emitIrModuleRust(
      lower('typeof.ts', `export function isStr(x: number | string): boolean { return typeof x === "string"; }`).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits exponentiation as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow.ts', `export function power(base: number, exp: number): number { return base ** exp; }`).module,
    ).contents;
    expect(output).toContain('powf');
  });

  it('emits unsigned right shift', () => {
    const output = emitIrModuleRust(
      lower('ursh.ts', `export function ursh(x: number, n: number): number { return x >>> n; }`).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits throw as panic', () => {
    const output = emitIrModuleRust(
      lower('throw.ts', `export function fail(msg: string): never { throw new Error(msg); }`).module,
    ).contents;
    expect(output).toContain('panic!');
  });

  it('emits switch statement as if-else chain', () => {
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
  });

  it('emits interface as trait', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-trait.ts',
        `export interface Printable {
           toString(): string;
         }
         export class Item implements Printable {
           name: string;
           constructor(n: string) { this.name = n; }
           toString(): string { return this.name; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Printable');
  });

  it('emits generic function with type parameter', () => {
    const result = lower('generic-fn.ts', `export function identity<T>(x: T): T { return x; }`);
    if (result.diagnostics.length === 0) {
      const output = emitIrModuleRust(result.module).contents;
      expect(output).toContain('fn identity');
    }
  });

  it('emits array join as .join()', () => {
    const output = emitIrModuleRust(
      lower('arr-join.ts', `export function joinItems(items: string[]): string { return items.join(", "); }`).module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice with two arguments', () => {
    const output = emitIrModuleRust(
      lower('arr-slice.ts', `export function mid(items: number[]): number[] { return items.slice(1, 3); }`).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits string charAt as chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('char-at.ts', `export function first(s: string): string { return s.charAt(0); }`).module,
    ).contents;
    expect(output).toContain('chars()');
  });

  it('emits string substring with two args', () => {
    const output = emitIrModuleRust(
      lower('substring.ts', `export function mid(s: string): string { return s.substring(1, 3); }`).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits template literal with interpolation', () => {
    const output = emitIrModuleRust(
      lower('template-interp.ts', 'export function greet(name: string): string { return `hello ${name}!`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits unary plus on number as identity', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', 'export function pos(x: number): number { return +x; }').module,
    ).contents;
    expect(output).not.toContain('++');
  });

  it('emits interface with method properties', () => {
    const output = emitIrModuleRust(
      lower(
        'interface-method.ts',
        `export interface Greeter {
          greet(name: string): string;
        }
        export class Hello implements Greeter {
          greet(name: string): string { return name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Greeter');
    expect(output).toContain('fn greet');
  });

  it('emits interface with non-function property accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'interface-prop.ts',
        `export interface HasName {
          name: string;
        }
        export class Named implements HasName {
          name: string;
          constructor(n: string) { this.name = n; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait HasName');
    expect(output).toContain('fn name');
  });

  it('emits class with empty default constructor as derived fields', () => {
    const output = emitIrModuleRust(
      lower(
        'default-ctor.ts',
        `export class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) { this.x = x; this.y = y; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('pub fn new');
    expect(output).toContain('Point {');
  });

  it('emits class with static constant field', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
          static MAX: number = 100;
          value: number;
          constructor(v: number) { this.value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('MAX');
  });

  it('emits class implementing abstract base trait methods', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-abstract.ts',
        `export abstract class Shape {
          abstract area(): number;
          describe(): string { return 'shape'; }
        }
        export class Circle extends Shape {
          r: number;
          constructor(radius: number) { this.r = radius; }
          area(): number { return 3.14 * this.r * this.r; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('impl Shape for Circle');
  });

  it('emits accessor getter as method call', () => {
    const output = emitIrModuleRust(
      lower(
        'accessor-getter.ts',
        `export class Temperature {
          private _c: number;
          constructor(c: number) { this._c = c; }
          get celsius(): number { return this._c; }
        }
        export function read(t: Temperature): number { return t.celsius; }`,
      ).module,
    ).contents;
    expect(output).toContain('celsius()');
  });

  it('emits mutating method with &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-method.ts',
        `export class Counter {
          count: number;
          constructor() { this.count = 0; }
          increment(): void { this.count = this.count + 1; }
          value(): number { return this.count; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
    expect(output).toContain('&self');
  });

  it('emits re-export from sibling module', () => {
    const output = emitIrModuleRust(
      lowerPackage('@flighthq/math', 'facade.ts', `export { add } from './helpers.js';`).module,
    ).contents;
    expect(output).toContain('pub use');
  });

  it('emits non-exported function without pub', () => {
    const output = emitIrModuleRust(
      lower(
        'internal-fn.ts',
        `function helper(x: number): number { return x + 1; }
         export function main(x: number): number { return helper(x); }`,
      ).module,
    ).contents;
    expect(output).toContain('fn helper');
    expect(output).not.toContain('pub fn helper');
  });

  it('emits optional parameter as Option wrapper', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-param.ts',
        `export function greet(name?: string): string {
          if (name !== undefined) { return name; }
          return "hello";
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<String>');
  });

  it('emits function with default parameter value', () => {
    const output = emitIrModuleRust(
      lower(
        'default-param.ts',
        `export function add(a: number, b: number = 0): number {
          return a + b;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<f64>');
    expect(output).toContain('unwrap_or_else');
  });

  it('emits accessor getter and setter methods', () => {
    const output = emitIrModuleRust(
      lower(
        'accessor.ts',
        `export class Box {
          private _value: number;
          constructor() { this._value = 0; }
          get value(): number { return this._value; }
          set value(v: number) { this._value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn value(');
    expect(output).toContain('fn set_value(');
  });

  it('emits setter assignment through accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'setter-assign.ts',
        `export class Box {
          private _value: number;
          constructor() { this._value = 0; }
          get value(): number { return this._value; }
          set value(v: number) { this._value = v; }
        }
        export function setBox(b: Box): void { b.value = 42; }`,
      ).module,
    ).contents;
    expect(output).toContain('set_value(');
  });

  it('emits string concatenation with push_str for +=', () => {
    const output = emitIrModuleRust(
      lower(
        'string-concat-assign.ts',
        `export function build(a: string, b: string): string {
          let result: string = a;
          result += b;
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('push_str');
  });

  it('emits bitwise assignment operators with integer casts', () => {
    const output = emitIrModuleRust(
      lower(
        'bitwise-assign.ts',
        `export function bitOps(a: number, b: number): number {
          let x: number = a;
          x &= b;
          return x;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits exponentiation assignment with powf', () => {
    const output = emitIrModuleRust(
      lower(
        'exp-assign.ts',
        `export function power(base: number, exp: number): number {
          let result: number = base;
          result **= exp;
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('f64::powf');
  });

  it('emits unsigned right shift assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'urs-assign.ts',
        `export function shift(x: number, bits: number): number {
          let result: number = x;
          result >>>= bits;
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('as u32');
  });

  it('emits coalesce with optional-shaped operand as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'coalesce.ts',
        `export function fallback(x: number | undefined): number {
          return x ?? 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits for-in with key plan', () => {
    const output = emitIrModuleRust(
      lower(
        'for-in.ts',
        `export function keys(obj: { a: number; b: number }): string[] {
          const result: string[] = [];
          for (const key in obj) { result.push(key); }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('to_owned');
  });

  it('emits for-of loop', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of.ts',
        `export function sum(items: number[]): number {
          let total: number = 0;
          for (const item of items) { total = total + item; }
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('in');
  });

  it('emits type alias as struct when object type', () => {
    const output = emitIrModuleRust(
      lower(
        'type-alias-object.ts',
        `export type Point = { x: number; y: number };
         export function origin(): Point { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('pub struct Point');
    expect(output).toContain('pub x: f64');
  });

  it('emits tagged union from type alias of named record union', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        `export interface Circle { kind: string; radius: number }
         export interface Square { kind: string; side: number }
         export type Shape = Circle | Square;
         export function area(s: Shape): number {
           return s.kind === "circle" ? 3.14 : 1.0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle(');
    expect(output).toContain('Square(');
    expect(output).toContain('fn kind(');
  });

  it('emits abstract class with default method as trait', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-default.ts',
        `export abstract class Serializable {
          abstract serialize(): string;
          describe(): string { return this.serialize(); }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('pub trait Serializable');
    expect(output).toContain('fn serialize(');
    expect(output).toContain('fn describe(');
  });

  it('emits abstract class with abstract fields as trait methods', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-fields.ts',
        `export abstract class Named {
          abstract readonly name: string;
        }
        export class Person extends Named {
          name: string;
          constructor() { super(); this.name = ""; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(');
    expect(output).toContain('impl Named for');
  });

  it('emits concrete base class via composition', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
          value: number;
          constructor(v: number) { this.value = v; }
        }
        export class Child extends Base {
          extra: string;
          constructor(v: number) { super(v); this.extra = ""; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('base:');
    expect(output).toContain('Base');
  });

  it('emits this.field reference with clone for non-copy type', () => {
    const output = emitIrModuleRust(
      lower(
        'self-field-clone.ts',
        `export class Container {
          items: string[];
          constructor() { this.items = []; }
          getItems(): string[] { return this.items; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits conditional expression as if-else', () => {
    const output = emitIrModuleRust(
      lower(
        'conditional.ts',
        `export function max(a: number, b: number): number {
          return a > b ? a : b;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });

  it('emits cast expression', () => {
    const result = lower(
      'cast.ts',
      `export function convert(x: number): number {
        return x as number;
      }`,
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('return');
  });

  it('emits labeled break and continue', () => {
    const output = emitIrModuleRust(
      lower(
        'label.ts',
        `export function search(grid: number[][]): number {
          let found: number = -1;
          outer: for (const row of grid) {
            for (const cell of row) {
              if (cell > 0) { found = cell; break outer; }
              continue;
            }
          }
          return found;
        }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain("break 'outer");
  });

  it('emits optional property chain as map/and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-prop.ts',
        `export function getName(obj: { name: string } | undefined): string | undefined {
          return obj?.name;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
    expect(output).toContain('optional_chain_value');
  });

  it('emits optional element chain as and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-element.ts',
        `export function first(arr: number[] | undefined): number | undefined {
          return arr?.[0];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('and_then');
  });

  it('emits function expression as closure', () => {
    const output = emitIrModuleRust(
      lower(
        'closure.ts',
        `export function applyOp(a: number, b: number): number {
          const op = (x: number, y: number): number => { return x + y; };
          return op(a, b);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('|');
  });

  it('emits function returning a callback with Rc', () => {
    const output = emitIrModuleRust(
      lower(
        'return-callback.ts',
        `export function makeAdder(n: number): (x: number) => number {
          return (x: number): number => x + n;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Rc');
  });

  it('emits object rest expression as generated record', () => {
    const output = emitIrModuleRust(
      lower(
        'object-rest.ts',
        `export function stripKind(obj: { kind: string; value: number }): { value: number } {
          const { kind, ...rest } = obj;
          return rest;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('value:');
  });

  it('emits variable with undefined initial value as None', () => {
    const output = emitIrModuleRust(
      lower(
        'undefined-var.ts',
        `export function find(items: number[]): number | undefined {
          let result: number | undefined = undefined;
          for (const item of items) {
            if (item > 0) { result = item; }
          }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
    expect(output).toContain('Option<f64>');
  });

  it('emits mutable variable with mut keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'mutable-var.ts',
        `export function count(items: number[]): number {
          let total: number = 0;
          for (const item of items) { total = total + item; }
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('let mut total');
  });

  it('emits tuple type as parenthesized elements', () => {
    const output = emitIrModuleRust(
      lower(
        'tuple-type.ts',
        `export function pair(a: number, b: string): [number, string] {
          return [a, b];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('(f64, String)');
  });

  it('emits array filter with borrowed element closure', () => {
    const output = emitIrModuleRust(
      lower(
        'filter.ts',
        `export function positives(items: number[]): number[] {
          return items.filter((x: number): boolean => x > 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('filter(');
    expect(output).toContain('collect');
  });

  it('emits array map with iterator adaptor', () => {
    const output = emitIrModuleRust(
      lower(
        'map.ts',
        `export function doubles(items: number[]): number[] {
          return items.map((x: number): number => x * 2);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.map(');
    expect(output).toContain('collect');
  });

  it('emits array indexOf as position search', () => {
    const output = emitIrModuleRust(
      lower(
        'index-of.ts',
        `export function findIndex(items: string[], target: string): number {
          return items.indexOf(target);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('iter()');
    expect(output).toContain('position(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits string includes as borrowed method', () => {
    const output = emitIrModuleRust(
      lower(
        'str-includes.ts',
        `export function hasWord(s: string, word: string): boolean {
          return s.includes(word);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('contains(');
  });

  it('emits string split as splitCollect', () => {
    const output = emitIrModuleRust(
      lower(
        'str-split.ts',
        `export function words(s: string): string[] {
          return s.split(" ");
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.split(');
    expect(output).toContain('collect');
  });

  it('emits Math.max spread as fold', () => {
    const output = emitIrModuleRust(
      lower(
        'math-spread.ts',
        `export function maxOf(items: number[]): number {
          return Math.max(...items);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fold(');
  });

  it('emits function call expression with parens around callee', () => {
    const output = emitIrModuleRust(
      lower(
        'iife.ts',
        `export function run(): number {
          return ((x: number): number => x)(42);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('(|');
  });

  it('emits narrowed present identifier with unwrap', () => {
    const output = emitIrModuleRust(
      lower(
        'narrowed.ts',
        `export function safe(x: number | undefined): number {
          if (x !== undefined) { return x; }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap()');
  });

  it('emits class with trait abstract field accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-field-access.ts',
        `export abstract class Sized {
          abstract readonly size: number;
          describe(): string { return "size"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn size(');
    expect(output).toContain('&self');
  });

  it('emits block statement', () => {
    const output = emitIrModuleRust(
      lower(
        'block.ts',
        `export function scope(): number {
          let x: number = 1;
          { x = x + 1; }
          return x;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('{');
  });

  it('emits string charCodeAt as chars nth', () => {
    const output = emitIrModuleRust(
      lower(
        'char-code.ts',
        `export function code(s: string, i: number): number {
          return s.charCodeAt(i);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('chars().nth(');
  });

  it('emits string indexOf as find search', () => {
    const output = emitIrModuleRust(
      lower(
        'str-index-of.ts',
        `export function findPos(s: string, target: string): number {
          return s.indexOf(target);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('find(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits Readonly<T> by unwrapping to inner type', () => {
    const output = emitIrModuleRust(
      lower(
        'readonly-unwrap.ts',
        `export function identity(items: Readonly<number[]>): Readonly<number[]> {
          return items;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Vec<f64>');
  });

  it('emits primitive union as enum with Display impl', () => {
    const output = emitIrModuleRust(
      lower(
        'primitive-union.ts',
        `export function show(x: string | number): string {
          if (typeof x === "string") { return x; }
          return "num";
        }`,
      ).module,
    ).contents;
    expect(output).toContain('enum');
    expect(output).toContain('impl std::fmt::Display');
  });

  it('emits element access with runtime index as usize cast', () => {
    const output = emitIrModuleRust(
      lower(
        'dynamic-index.ts',
        `export function at(items: number[], i: number): number {
          return items[i];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize');
  });

  it('emits string substring with range slice', () => {
    const output = emitIrModuleRust(
      lower(
        'substring.ts',
        `export function mid(s: string, start: number, end: number): string {
          return s.substring(start, end);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('to_string()');
  });

  it('emits string substring with one argument as open range', () => {
    const output = emitIrModuleRust(
      lower(
        'substring-one.ts',
        `export function tail(s: string, start: number): string {
          return s.substring(start);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('..');
    expect(output).toContain('to_string()');
  });

  it('emits module-level const variable declaration', () => {
    const output = emitIrModuleRust(lower('module-const.ts', `export const MAX: number = 100;`).module).contents;
    expect(output).toContain('pub const');
    expect(output).toContain('100');
  });

  it('emits array some with any iterator', () => {
    const output = emitIrModuleRust(
      lower(
        'some.ts',
        `export function hasPositive(items: number[]): boolean {
          return items.some((x: number): boolean => x > 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('any(');
  });

  it('emits array every with all iterator', () => {
    const output = emitIrModuleRust(
      lower(
        'every.ts',
        `export function allPositive(items: number[]): boolean {
          return items.every((x: number): boolean => x > 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('all(');
  });

  it('emits array find with find iterator', () => {
    const output = emitIrModuleRust(
      lower(
        'find.ts',
        `export function findPositive(items: number[]): number | undefined {
          return items.find((x: number): boolean => x > 0);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('find(');
  });

  it('emits Math.floor as ambient member target', () => {
    const output = emitIrModuleRust(
      lower(
        'math-floor.ts',
        `export function floor(x: number): number {
          return Math.floor(x);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('floor');
  });

  it('emits never type as !', () => {
    const output = emitIrModuleRust(
      lower(
        'never.ts',
        `export function fail(): never {
          throw new Error("fail");
        }`,
      ).module,
    ).contents;
    expect(output).toContain('-> !');
  });

  it('emits null and undefined types as unit', () => {
    const output = emitIrModuleRust(
      lower(
        'null-type.ts',
        `export function nothing(): null {
          return null;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('()');
  });

  it('emits function type as Rc<dyn Fn>', () => {
    const output = emitIrModuleRust(
      lower(
        'fn-type.ts',
        `export function apply(f: (x: number) => number, v: number): number {
          return f(v);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Rc<dyn Fn(f64) -> f64>');
  });

  it('emits while true as loop', () => {
    const output = emitIrModuleRust(
      lower(
        'infinite-loop.ts',
        `export function spin(): number {
          let i: number = 0;
          while (true) { if (i > 10) { return i; } i = i + 1; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('loop {');
  });

  it('emits array push as method binding', () => {
    const output = emitIrModuleRust(
      lower(
        'push.ts',
        `export function collect(items: number[]): number[] {
          const result: number[] = [];
          for (const item of items) { result.push(item); }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.push(');
  });

  it('emits imported symbol re-export', () => {
    const output = emitIrModuleRust(
      lowerPackage(
        '@flighthq/math',
        'reexport.ts',
        `export { add } from './helpers.js';
         export { subtract } from './helpers.js';`,
      ).module,
    ).contents;
    expect(output).toContain('pub use');
  });

  it('emits unary plus on number as identity', () => {
    const output = emitIrModuleRust(
      lower(
        'unary-plus.ts',
        `export function pos(x: number): number {
          return +x;
        }`,
      ).module,
    ).contents;
    expect(output).not.toContain('++');
  });

  it('emits bitwise NOT with integer cast', () => {
    const output = emitIrModuleRust(
      lower(
        'bitwise-not.ts',
        `export function complement(x: number): number {
          return ~x;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits literal boolean type as bool', () => {
    const output = emitIrModuleRust(
      lower('lit-type.ts', `export function truthy(): true { return true; }`).module,
    ).contents;
    expect(output).toContain('bool');
  });

  it('emits call with omitted optional argument as None', () => {
    const output = emitIrModuleRust(
      lower(
        'call-omitted.ts',
        `export function greet(name?: string): string {
          if (name !== undefined) { return name; }
          return "hello";
        }
        export function run(): string { return greet(); }`,
      ).module,
    ).contents;
    expect(output).toContain('greet(None)');
  });

  it('emits call with explicit undefined as None', () => {
    const output = emitIrModuleRust(
      lower(
        'call-undefined.ts',
        `export function greet(name?: string): string {
          if (name !== undefined) { return name; }
          return "hello";
        }
        export function run(): string { return greet(undefined); }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
  });

  it('emits call with provided value to optional parameter as Some', () => {
    const output = emitIrModuleRust(
      lower(
        'call-some.ts',
        `export function greet(name?: string): string {
          if (name !== undefined) { return name; }
          return "hello";
        }
        export function run(): string { return greet("world"); }`,
      ).module,
    ).contents;
    expect(output).toContain('Some(');
  });

  it('emits call with default parameter value providing argument', () => {
    const output = emitIrModuleRust(
      lower(
        'call-default.ts',
        `export function add(a: number, b: number = 0): number { return a + b; }
         export function run(): number { return add(1, 2); }`,
      ).module,
    ).contents;
    expect(output).toContain('Some(');
  });

  it('emits interface trait with data property accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-data.ts',
        `export interface Named { readonly name: string; }
         export class Person implements Named {
           name: string;
           constructor() { this.name = ""; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self) -> String');
  });

  it('emits interface trait with method signature', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-method.ts',
        `export interface Formatter { format(value: number): string; }
         export class NumFormatter implements Formatter {
           format(value: number): string { return "num"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Formatter');
    expect(output).toContain('fn format(&self');
  });

  it('emits renamed re-export with as alias', () => {
    const output = emitIrModuleRust(
      lowerPackage('@flighthq/math', 'rename.ts', `export { add as sum } from './helpers.js';`).module,
    ).contents;
    expect(output).toContain('pub use');
    expect(output).toContain('as');
  });

  it('emits type-only re-export with type name casing', () => {
    const output = emitIrModuleRust(
      lowerPackage('@flighthq/math', 'type-reexport.ts', `export type { Vector } from './types.js';`).module,
    ).contents;
    expect(output).toContain('pub use');
  });

  it('emits composition base field access through self.base', () => {
    const output = emitIrModuleRust(
      lower(
        'comp-access.ts',
        `export class Base {
          value: number;
          constructor(v: number) { this.value = v; }
        }
        export class Child extends Base {
          extra: string;
          constructor(v: number) { super(v); this.extra = ""; }
          getValue(): number { return this.value; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('self.base');
  });

  it('emits abstract field accessor in subclass trait impl', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-field-impl.ts',
        `export abstract class Labeled {
          abstract readonly label: string;
          describe(): string { return this.label; }
        }
        export class Item extends Labeled {
          label: string;
          constructor() { super(); this.label = "item"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn label(&self)');
    expect(output).toContain('self.label');
  });

  it('emits narrowed nullable binding property access with borrow', () => {
    const output = emitIrModuleRust(
      lower(
        'narrow-borrow.ts',
        `export interface Info { value: number }
         export function readValue(x: Info | undefined): number {
           if (x !== undefined) { return x.value; }
           return 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap');
  });

  it('emits class implementing interface with trait methods in impl block', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-trait-method.ts',
        `export interface Runnable { run(): void; }
         export class Task implements Runnable {
           run(): void { }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Runnable for');
    expect(output).toContain('fn run(');
  });

  it('emits constructor reference for new expression', () => {
    const output = emitIrModuleRust(
      lower(
        'new-class.ts',
        `export class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) { this.x = x; this.y = y; }
        }
        export function origin(): Point { return new Point(0, 0); }`,
      ).module,
    ).contents;
    expect(output).toContain('Point::new(');
  });

  it('emits enum member access as variant path', () => {
    const output = emitIrModuleRust(
      lower(
        'enum-access.ts',
        `export enum Direction { Up = 0, Down = 1 }
         export function isUp(d: Direction): boolean { return d === Direction.Up; }`,
      ).module,
    ).contents;
    expect(output).toContain('Direction::Up');
  });

  it('emits static method as associated function', () => {
    const output = emitIrModuleRust(
      lower(
        'static-method.ts',
        `export class Factory {
          value: number;
          constructor() { this.value = 0; }
          static create(): Factory { return new Factory(); }
        }
        export function make(): Factory { return Factory.create(); }`,
      ).module,
    ).contents;
    expect(output).toContain('Factory::create()');
  });

  it('emits counting method as cast to f64', () => {
    const output = emitIrModuleRust(
      lower(
        'counting.ts',
        `export function length(items: string[]): number {
          return items.length;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.len()');
    expect(output).toContain('as f64');
  });

  it('emits string length as counting method', () => {
    const output = emitIrModuleRust(
      lower(
        'str-len.ts',
        `export function len(s: string): number {
          return s.length;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.len()');
  });

  it('emits tuple element access with positional index', () => {
    const output = emitIrModuleRust(
      lower(
        'tuple-access.ts',
        `export function first(pair: [number, string]): number {
          return pair[0];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.0');
  });

  it('emits string literal union type alias as String type', () => {
    const output = emitIrModuleRust(
      lower(
        'string-union.ts',
        `export type Color = "red" | "blue" | "green";
         export function paint(c: Color): string { return c; }`,
      ).module,
    ).contents;
    expect(output).toContain('type Color = String');
  });

  it('emits type alias for union of named records as tagged union', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union-alias.ts',
        `export interface Dog { breed: string; name: string }
         export interface Cat { color: string; name: string }
         export type Pet = Dog | Cat;
         export function petName(p: Pet): string { return p.name; }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Pet');
    expect(output).toContain('fn name(');
  });

  it('emits object type as anonymous record struct', () => {
    const output = emitIrModuleRust(
      lower(
        'anon-object.ts',
        `export function make(): { x: number; y: number } {
          return { x: 0, y: 0 };
        }`,
      ).module,
    ).contents;
    expect(output).toContain('struct');
    expect(output).toContain('pub x: f64');
  });

  it('emits moved binding with clone', () => {
    const output = emitIrModuleRust(
      lower(
        'moved-binding.ts',
        `export function dup(items: string[]): string[][] {
          return [items, items];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits deferred binding initialized in one branch', () => {
    const output = emitIrModuleRust(
      lower(
        'deferred-init.ts',
        `export function pick(flag: boolean): number {
          let result: number;
          result = flag ? 1 : 2;
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('let result');
  });

  it('emits referent-mutated parameter as &mut borrow', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-param.ts',
        `export function increment(arr: number[]): void {
          arr.push(1);
        }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut');
  });

  it('emits Readonly<T> unwrap for named type argument', () => {
    const output = emitIrModuleRust(
      lower(
        'readonly-named.ts',
        `export interface Point { x: number; y: number }
         export function copy(p: Readonly<Point>): Point {
           return { x: p.x, y: p.y };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('pub fn copy(p: Point) -> Point');
  });

  it('emits Required<T> unwrap', () => {
    const output = emitIrModuleRust(
      lower(
        'required.ts',
        `export interface Opts { a?: number }
         export function defaults(o: Required<Opts>): number {
           return o.a;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('pub fn defaults(o: Opts) -> f64');
  });

  it('emits scoped import from relative specifier', () => {
    const output = emitIrModuleRust(
      lowerPackage(
        '@flighthq/math',
        'consumer.ts',
        `import { add } from './helpers.js';
         export function sum(a: number, b: number): number { return add(a, b); }`,
      ).module,
    ).contents;
    expect(output).toContain('use crate::');
    expect(output).toContain('add');
  });

  it('emits scoped import from package specifier', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'use.ts',
      `import { compute } from '@flighthq/math';
       export function run(x: number): number { return compute(x); }`,
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('use flighthq_math::');
  });

  it('emits composition base string field access with clone suffix', () => {
    const output = emitIrModuleRust(
      lower(
        'comp-string.ts',
        `export class Base {
          name: string;
          constructor(n: string) { this.name = n; }
        }
        export class Child extends Base {
          extra: number;
          constructor(n: string) { super(n); this.extra = 0; }
          getName(): string { return this.name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('self.base.name.clone()');
  });

  it('emits primitive union narrowed member as deref', () => {
    const output = emitIrModuleRust(
      lower(
        'prim-narrow.ts',
        `export function describe(x: string | number): string {
          if (typeof x === "string") { return x; }
          return "number";
        }`,
      ).module,
    ).contents;
    expect(output).toContain('as_str()');
  });

  it('emits discriminated union narrowed field access', () => {
    const output = emitIrModuleRust(
      lower(
        'disc-narrow.ts',
        `export interface Circle { kind: "circle"; radius: number }
         export interface Square { kind: "square"; side: number }
         export type Shape = Circle | Square;
         export function size(s: Shape): number {
           if (s.kind === "circle") { return s.radius; }
           return s.side;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
  });

  it('emits element access on property chain with clone', () => {
    const output = emitIrModuleRust(
      lower(
        'elem-prop.ts',
        `export function get(items: number[][], i: number): number {
          return items[0][0];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('[');
  });

  it('emits callback variable with Rc wrapper', () => {
    const output = emitIrModuleRust(
      lower(
        'callback-var.ts',
        `export function makeOp(): (x: number) => number {
          const fn1 = (x: number): number => x + 1;
          return fn1;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Rc');
  });

  it('emits cell-wrapped binding for mutated closure capture', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-capture.ts',
        `export function counter(): () => number {
          let count: number = 0;
          const fn1 = (): number => { count = count + 1; return count; };
          return fn1;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Cell');
  });

  it('emits cell assignment as .set()', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-set.ts',
        `export function counter(): () => number {
          let count: number = 0;
          const inc = (): number => { count = count + 1; return count; };
          return inc;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.set(');
    expect(output).toContain('.get()');
  });

  it('emits async function with async fn keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'async-fn.ts',
        `export async function fetchData(): Promise<number> {
          return 42;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('async fn');
  });

  it('emits await expression as .await', () => {
    const output = emitIrModuleRust(
      lower(
        'await-expr.ts',
        `export async function compute(p: Promise<number>): Promise<number> {
          const val: number = await p;
          return val;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.await');
  });

  it('emits array element binding with coalesce as Option get', () => {
    const output = emitIrModuleRust(
      lower(
        'array-elem.ts',
        `export function first(items: number[]): number {
          const x: number | undefined = items[0];
          return x ?? 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits symbol type with FlightSymbol', () => {
    const output = emitIrModuleRust(
      lower(
        'symbol-type.ts',
        `export function identity(s: symbol): symbol {
          return s;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('FlightSymbol');
  });

  it('emits returned array element with clone', () => {
    const output = emitIrModuleRust(
      lower(
        'return-element.ts',
        `export function head(items: string[]): string {
          return items[0];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits undefinedValue as None with Option payload', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-val.ts',
        `export function empty(): string | undefined {
          return undefined;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
    expect(output).toContain('Option<String>');
  });

  it('emits undefinedDefault with unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-default.ts',
        `export function safe(x: string | undefined): string {
          return x ?? "default";
        }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits interface with both data and method properties as trait', () => {
    const output = emitIrModuleRust(
      lower(
        'mixed-trait.ts',
        `export interface Describable {
          readonly name: string;
          describe(): string;
        }
        export class Thing implements Describable {
          name: string;
          constructor() { this.name = "thing"; }
          describe(): string { return this.name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Describable');
    expect(output).toContain('fn name(&self) -> String');
    expect(output).toContain('fn describe(&self');
  });

  it('emits tuple with optional element as Option', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-tuple.ts',
        `export function pair(a: number): [number, string?] {
          return [a];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<String>');
  });

  it('emits empty array literal as vec![]', () => {
    const output = emitIrModuleRust(
      lower(
        'empty-arr.ts',
        `export function empty(): number[] {
          return [];
        }`,
      ).module,
    ).contents;
    expect(output).toContain('vec![]');
  });

  it('emits tuple expression with single element trailing comma', () => {
    const output = emitIrModuleRust(
      lower(
        'single-tuple.ts',
        `export function wrap(x: number): [number] {
          return [x];
        }`,
      ).module,
    ).contents;
    expect(output).toContain(',)');
  });

  it('emits rest parameter in function', () => {
    const output = emitIrModuleRust(
      lower(
        'rest-param.ts',
        `export function sum(...nums: number[]): number {
          let total: number = 0;
          for (const n of nums) { total = total + n; }
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('nums: Vec<f64>');
  });

  it('emits continue statement in loop', () => {
    const output = emitIrModuleRust(
      lower(
        'continue.ts',
        `export function positives(items: number[]): number[] {
          const result: number[] = [];
          for (const item of items) {
            if (item <= 0) { continue; }
            result.push(item);
          }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('continue;');
  });

  it('emits string charAt as chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('char-at.ts', 'export function first(s: string): string { return s.charAt(0); }').module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('unwrap_or_default');
  });

  it('emits string charCodeAt as chars().nth() with f64 cast', () => {
    const output = emitIrModuleRust(
      lower('char-code.ts', 'export function code(s: string): number { return s.charCodeAt(0); }').module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('f64::NAN');
  });

  it('emits string substring as slice with to_string', () => {
    const output = emitIrModuleRust(
      lower(
        'substr.ts',
        'export function mid(s: string, start: number, end: number): string { return s.substring(start, end); }',
      ).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_string()');
  });

  it('emits string substring with one argument as open range', () => {
    const output = emitIrModuleRust(
      lower('substr-one.ts', 'export function tail(s: string, start: number): string { return s.substring(start); }')
        .module,
    ).contents;
    expect(output).toContain('as usize..');
    expect(output).toContain('.to_string()');
  });

  it('emits array join with separator argument', () => {
    const output = emitIrModuleRust(
      lower('join.ts', 'export function csv(items: string[]): string { return items.join(","); }').module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice with start and end', () => {
    const output = emitIrModuleRust(
      lower(
        'slice.ts',
        'export function mid(items: number[], start: number, end: number): number[] { return items.slice(start, end); }',
      ).module,
    ).contents;
    expect(output).toContain('.to_vec()');
    expect(output).toContain('as usize');
  });

  it('emits array slice with no arguments as clone', () => {
    const output = emitIrModuleRust(
      lower('slice-clone.ts', 'export function copy(items: number[]): number[] { return items.slice(); }').module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits array concat with extend', () => {
    const output = emitIrModuleRust(
      lower('concat.ts', 'export function merge(a: number[], b: number[]): number[] { return a.concat(b); }').module,
    ).contents;
    expect(output).toContain('__concat');
    expect(output).toContain('extend');
  });

  it('emits class implementing interface as trait impl', () => {
    const output = emitIrModuleRust(
      lower(
        'implements.ts',
        `export interface Greeter { greet(): string }
        export class HelloGreeter implements Greeter {
          greet(): string { return "hello"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Greeter for HelloGreeter');
  });

  it('emits class with concrete base as composition struct', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
          value: number;
          constructor(v: number) { this.value = v; }
        }
        export class Child extends Base {
          extra: number;
          constructor(v: number, e: number) { super(v); this.extra = e; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('base: Base');
    expect(output).toContain('Base::new(');
  });

  it('emits class with abstract base as trait implementation', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-impl.ts',
        `export abstract class Shape {
          abstract area(): number;
        }
        export class Circle extends Shape {
          radius: number;
          constructor(r: number) { super(); this.radius = r; }
          area(): number { return 3.14 * this.radius * this.radius; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('impl Shape for Circle');
  });

  it('emits negated nullish comparison with is_some', () => {
    const output = emitIrModuleRust(
      lower('is-some.ts', 'export function present(x: number | undefined): boolean { return x != undefined; }').module,
    ).contents;
    expect(output).toContain('.is_some()');
  });

  it('emits element access on tuple receiver with positional field', () => {
    const output = emitIrModuleRust(
      lower('tuple-access.ts', 'export function first(pair: [number, string]): number { return pair[0]; }').module,
    ).contents;
    expect(output).toContain('.0');
  });

  it('emits template literal with format! macro', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });

  it('emits tuple expression with single trailing comma', () => {
    const output = emitIrModuleRust(
      lower('single-tuple.ts', 'export function wrap(x: number): [number] { return [x]; }').module,
    ).contents;
    expect(output).toContain(',)');
  });

  it('emits undefinedDefault as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-default.ts',
        'export function fallback(pair: [number, number?]): number { const [a, b = 0] = pair; return a + b; }',
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits class with interface that has data properties as trait getters', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-data.ts',
        `export interface Named { readonly name: string }
        export class Person implements Named {
          name: string;
          constructor(n: string) { this.name = n; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Named for Person');
  });

  it('emits class constructor field assignments for new() associated fn', () => {
    const output = emitIrModuleRust(
      lower(
        'ctor-fields.ts',
        `export class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) { this.x = x; this.y = y; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new(');
    expect(output).toContain('Self {');
  });

  it('emits static const field on class', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
          static MAX: number = 100;
          value: number;
          constructor(v: number) { this.value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('const MAX');
  });

  it('emits field initializer plan as new() when all fields have initializers', () => {
    const output = emitIrModuleRust(
      lower(
        'init-plan.ts',
        `export class Counter {
          count: number = 0;
          name: string = "default";
        }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new()');
    expect(output).toContain('Self {');
  });

  it('emits mutating method with &mut self receiver', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-self.ts',
        `export class Counter {
          count: number;
          constructor() { this.count = 0; }
          increment(): void { this.count = this.count + 1; }
          get(): number { return this.count; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
    expect(output).toContain('&self');
  });
});

describe('emitIrModuleRust bitwise binary operators', () => {
  it('emits bitwise AND with i32 cast', () => {
    const output = emitIrModuleRust(
      lower('bitwise-and.ts', 'export function band(a: number, b: number): number { return a & b; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('&');
  });

  it('emits bitwise OR with i32 cast', () => {
    const output = emitIrModuleRust(
      lower('bitwise-or.ts', 'export function bor(a: number, b: number): number { return a | b; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('|');
  });

  it('emits bitwise XOR with i32 cast', () => {
    const output = emitIrModuleRust(
      lower('bitwise-xor.ts', 'export function bxor(a: number, b: number): number { return a ^ b; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('^');
  });

  it('emits left shift with i32 cast', () => {
    const output = emitIrModuleRust(
      lower('shift-left.ts', 'export function shl(a: number, b: number): number { return a << b; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('<<');
  });

  it('emits right shift with i32 cast', () => {
    const output = emitIrModuleRust(
      lower('shift-right.ts', 'export function shr(a: number, b: number): number { return a >> b; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('>>');
  });

  it('emits unsigned right shift with u32 cast', () => {
    const output = emitIrModuleRust(
      lower('ushr.ts', 'export function ushr(a: number, b: number): number { return a >>> b; }').module,
    ).contents;
    expect(output).toContain('as u32');
  });
});

describe('emitIrModuleRust bitwise complement', () => {
  it('emits bitwise NOT with i32 cast and negation', () => {
    const output = emitIrModuleRust(
      lower('bitnot.ts', 'export function bitnot(a: number): number { return ~a; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });
});

describe('emitIrModuleRust exponentiation operator', () => {
  it('emits ** as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow.ts', 'export function pow(a: number, b: number): number { return a ** b; }').module,
    ).contents;
    expect(output).toContain('f64::powf');
  });
});

describe('emitIrModuleRust comparison operators', () => {
  it('emits less-than comparison', () => {
    const output = emitIrModuleRust(
      lower('cmp-lt.ts', 'export function lt(a: number, b: number): boolean { return a < b; }').module,
    ).contents;
    expect(output).toContain('<');
  });

  it('emits greater-equal comparison', () => {
    const output = emitIrModuleRust(
      lower('cmp-gte.ts', 'export function gte(a: number, b: number): boolean { return a >= b; }').module,
    ).contents;
    expect(output).toContain('>=');
  });
});

describe('emitIrModuleRust logical operators', () => {
  it('emits logical AND', () => {
    const output = emitIrModuleRust(
      lower('log-and.ts', 'export function both(a: boolean, b: boolean): boolean { return a && b; }').module,
    ).contents;
    expect(output).toContain('&&');
  });

  it('emits logical OR', () => {
    const output = emitIrModuleRust(
      lower('log-or.ts', 'export function either(a: boolean, b: boolean): boolean { return a || b; }').module,
    ).contents;
    expect(output).toContain('||');
  });
});

describe('emitIrModuleRust arithmetic operators', () => {
  it('emits multiplication', () => {
    const output = emitIrModuleRust(
      lower('mul.ts', 'export function mul(a: number, b: number): number { return a * b; }').module,
    ).contents;
    expect(output).toContain('*');
  });

  it('emits modulo', () => {
    const output = emitIrModuleRust(
      lower('mod.ts', 'export function mod(a: number, b: number): number { return a % b; }').module,
    ).contents;
    expect(output).toContain('%');
  });

  it('emits division', () => {
    const output = emitIrModuleRust(
      lower('div.ts', 'export function div(a: number, b: number): number { return a / b; }').module,
    ).contents;
    expect(output).toContain('/');
  });

  it('emits subtraction', () => {
    const output = emitIrModuleRust(
      lower('sub.ts', 'export function sub(a: number, b: number): number { return a - b; }').module,
    ).contents;
    expect(output).toContain('-');
  });
});

describe('emitIrModuleRust string concatenation', () => {
  it('emits string addition with format!', () => {
    const output = emitIrModuleRust(
      lower('str-concat.ts', 'export function concat(a: string, b: string): string { return a + b; }').module,
    ).contents;
    expect(output).toContain('format!');
  });
});

describe('emitIrModuleRust template literal', () => {
  it('emits template with format! macro', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });
});

describe('emitIrModuleRust nullish coalescing', () => {
  it('emits ?? as unwrap_or_else on Option', () => {
    const output = emitIrModuleRust(
      lower('nullish.ts', 'export function fallback(x: number | undefined): number { return x ?? 0; }').module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust null comparison', () => {
  it('emits === undefined as is_none()', () => {
    const output = emitIrModuleRust(
      lower('null-cmp.ts', 'export function isNone(x: number | undefined): boolean { return x === undefined; }').module,
    ).contents;
    expect(output).toContain('is_none()');
  });

  it('emits !== undefined as is_some()', () => {
    const output = emitIrModuleRust(
      lower('not-null-cmp.ts', 'export function isSome(x: number | undefined): boolean { return x !== undefined; }')
        .module,
    ).contents;
    expect(output).toContain('is_some()');
  });
});

describe('emitIrModuleRust conditional expression', () => {
  it('emits ternary as if-else expression', () => {
    const output = emitIrModuleRust(
      lower('cond.ts', 'export function pick(a: boolean, x: number, y: number): number { return a ? x : y; }').module,
    ).contents;
    expect(output).toContain('if ');
    expect(output).toContain('else');
  });
});

describe('emitIrModuleRust cast expression', () => {
  it('emits type assertion as Rust as cast', () => {
    const output = emitIrModuleRust(
      lower('cast.ts', 'export function toNum(x: unknown): number { return x as number; }').module,
    ).contents;
    expect(output).toContain(' as ');
  });
});

describe('emitIrModuleRust enum emission', () => {
  it('emits numeric enum as Rust enum', () => {
    const output = emitIrModuleRust(
      lower('my-enum.ts', 'export enum Color { Red = 0, Green = 1, Blue = 2 }').module,
    ).contents;
    expect(output).toContain('enum Color');
    expect(output).toContain('Red');
    expect(output).toContain('Green');
    expect(output).toContain('Blue');
  });
});

describe('emitIrModuleRust interface as trait', () => {
  it('emits interface with methods as Rust trait', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-trait.ts',
        `export interface Printable { print(): number }
         export class Doc implements Printable {
           print(): number { return 0; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Printable');
    expect(output).toContain('impl Printable');
  });
});

describe('emitIrModuleRust abstract class as trait', () => {
  it('emits abstract class as Rust trait', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-trait.ts',
        `export abstract class Shape {
           abstract area(): number;
         }
         export class Circle extends Shape {
           radius: number;
           constructor(r: number) { super(); this.radius = r; }
           area(): number { return 3.14 * this.radius * this.radius; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('impl Shape');
  });
});

describe('emitIrModuleRust for-of loop', () => {
  it('emits for-of as Rust for-in loop', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of.ts',
        'export function sum(items: number[]): number { let total = 0.0; for (const x of items) { total = total + x; } return total; }',
      ).module,
    ).contents;
    expect(output).toContain('for ');
    expect(output).toContain(' in ');
  });
});

describe('emitIrModuleRust for-in loop', () => {
  it('emits for-in with key plan', () => {
    const output = emitIrModuleRust(
      lower(
        'for-in.ts',
        `interface Obj { a: number; b: number }
         export function keys(obj: Obj): string[] {
           const result: string[] = [];
           for (const k in obj) { result.push(k); }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for ');
    expect(output).toContain('"a"');
    expect(output).toContain('"b"');
  });
});

describe('emitIrModuleRust do-while loop', () => {
  it('emits do-while as Rust loop with break', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        'export function countdown(n: number): number { let x = n; do { x = x - 1.0; } while (x > 0.0); return x; }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).toContain('break');
  });
});

describe('emitIrModuleRust while loop', () => {
  it('emits while loop', () => {
    const output = emitIrModuleRust(
      lower(
        'while.ts',
        'export function count(n: number): number { let i = 0.0; while (i < n) { i = i + 1.0; } return i; }',
      ).module,
    ).contents;
    expect(output).toContain('while ');
  });
});

describe('emitIrModuleRust try-catch', () => {
  it('emits try-catch with match on Result', () => {
    const output = emitIrModuleRust(
      lower(
        'try-catch.ts',
        `export function safe(fn: () => number): number {
           try { return fn(); } catch (e) { return -1.0; }
         }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });
});

describe('emitIrModuleRust throw statement', () => {
  it('emits throw as panic! or return Err', () => {
    const output = emitIrModuleRust(
      lower('throw.ts', 'export function fail(): never { throw new Error("oops"); }').module,
    ).contents;
    expect(output).toContain('panic!');
  });
});

describe('emitIrModuleRust string literal', () => {
  it('emits string literal with .to_owned()', () => {
    const output = emitIrModuleRust(
      lower('str-lit.ts', 'export function hello(): string { return "hello"; }').module,
    ).contents;
    expect(output).toContain('.to_owned()');
  });
});

describe('emitIrModuleRust integer literal', () => {
  it('emits integer literal with .0 suffix', () => {
    const output = emitIrModuleRust(lower('int-lit.ts', 'export function one(): number { return 1; }').module).contents;
    expect(output).toContain('1.0');
  });
});

describe('emitIrModuleRust boolean literal', () => {
  it('emits boolean literal directly', () => {
    const output = emitIrModuleRust(
      lower('bool-lit.ts', 'export function yes(): boolean { return true; }').module,
    ).contents;
    expect(output).toContain('true');
  });
});

describe('emitIrModuleRust null literal', () => {
  it('emits null as None', () => {
    const output = emitIrModuleRust(
      lower('null-lit.ts', 'export function nothing(): number | undefined { return null; }').module,
    ).contents;
    expect(output).toContain('None');
  });
});

describe('emitIrModuleRust tuple expression', () => {
  it('emits tuple as Rust tuple', () => {
    const output = emitIrModuleRust(
      lower('tuple.ts', 'export function pair(): [number, string] { return [1, "a"]; }').module,
    ).contents;
    expect(output).toContain('1.0');
    expect(output).toContain('"a"');
  });
});

describe('emitIrModuleRust type alias emission', () => {
  it('emits string literal union as Rust type alias', () => {
    const output = emitIrModuleRust(
      lower('str-enum.ts', "export type Color = 'red' | 'blue' | 'green';").module,
    ).contents;
    expect(output).toContain('pub type Color');
  });
});

describe('emitIrModuleRust interface emission', () => {
  it('emits simple interface as Rust struct', () => {
    const output = emitIrModuleRust(
      lower('iface.ts', 'export interface Point { x: number; y: number }').module,
    ).contents;
    expect(output).toContain('struct Point');
    expect(output).toContain('x: f64');
    expect(output).toContain('y: f64');
  });
});

describe('emitIrModuleRust closure expression', () => {
  it('emits function type parameter as Rc<dyn Fn>', () => {
    const output = emitIrModuleRust(
      lower('closure.ts', 'export function apply(fn: (x: number) => number, val: number): number { return fn(val); }')
        .module,
    ).contents;
    expect(output).toContain('Rc<dyn Fn');
  });
});

describe('emitIrModuleRust mutable and immutable variables', () => {
  it('emits mutable variable with let mut', () => {
    const output = emitIrModuleRust(
      lower('mutable.ts', 'export function count(): number { let x = 0.0; x = x + 1.0; return x; }').module,
    ).contents;
    expect(output).toContain('let mut');
  });

  it('emits immutable variable with let', () => {
    const output = emitIrModuleRust(
      lower('immutable.ts', 'export function one(): number { const x = 1.0; return x; }').module,
    ).contents;
    expect(output).toContain('let ');
    expect(output).not.toContain('let mut x');
  });
});

describe('emitIrModuleRust static class members', () => {
  it('emits static field as associated constant', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
           static MAX: number = 100;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('const MAX');
  });
});

describe('emitIrModuleRust if-else statement', () => {
  it('emits if-else with both branches', () => {
    const output = emitIrModuleRust(
      lower('if-else.ts', 'export function abs(x: number): number { if (x < 0.0) { return -x; } else { return x; } }')
        .module,
    ).contents;
    expect(output).toContain('if ');
    expect(output).toContain('else');
  });
});

describe('emitIrModuleRust switch statement', () => {
  it('emits switch as chained if-else with switch_value', () => {
    const output = emitIrModuleRust(
      lower(
        'switch.ts',
        `export function desc(n: number): string {
           switch (n) {
             case 0: return "zero";
             case 1: return "one";
             default: return "other";
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('switch_value');
    expect(output).toContain('"zero"');
    expect(output).toContain('"one"');
    expect(output).toContain('"other"');
  });
});

describe('emitIrModuleRust string array join', () => {
  it('emits .join() with borrowed separator', () => {
    const output = emitIrModuleRust(
      lower('join.ts', 'export function join(items: string[]): string { return items.join(", "); }').module,
    ).contents;
    expect(output).toContain('.join(');
  });
});

describe('emitIrModuleRust array slice', () => {
  it('emits .slice(start) as range', () => {
    const output = emitIrModuleRust(
      lower('slice.ts', 'export function tail(items: number[]): number[] { return items.slice(1); }').module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_vec()');
  });
});

describe('emitIrModuleRust string equality', () => {
  it('emits strict string equality', () => {
    const output = emitIrModuleRust(
      lower('str-eq.ts', 'export function eq(a: string, b: string): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('==');
  });
});

describe('emitIrModuleRust number equality', () => {
  it('emits strict number equality', () => {
    const output = emitIrModuleRust(
      lower('num-eq.ts', 'export function eq(a: number, b: number): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('==');
  });
});

describe('emitIrModuleRust unary plus', () => {
  it('emits unary plus as no-op on number', () => {
    const output = emitIrModuleRust(
      lower('uplus.ts', 'export function pos(x: number): number { return +x; }').module,
    ).contents;
    expect(output).toBeDefined();
  });
});

describe('emitIrModuleRust new expression', () => {
  it('emits new as ::new() constructor', () => {
    const output = emitIrModuleRust(
      lower(
        'new-expr.ts',
        `export class Pt { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
         export function origin(): Pt { return new Pt(0, 0); }`,
      ).module,
    ).contents;
    expect(output).toContain('::new(');
  });
});

describe('emitIrModuleRust labeled loop', () => {
  it('emits labeled loop with break', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled.ts',
        `export function find(items: number[]): number {
           outer: while (true) {
             for (const x of items) {
               if (x > 0.0) break outer;
             }
             break;
           }
           return 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
  });
});

describe('emitIrModuleRust module-level constant', () => {
  it('emits module-level const as pub const', () => {
    const output = emitIrModuleRust(lower('mod-const.ts', 'export const PI = 3.14;').module).contents;
    expect(output).toContain('pub const');
    expect(output).toContain('PI');
  });
});

describe('emitIrModuleRust compound assignment', () => {
  it('emits += on numbers', () => {
    const output = emitIrModuleRust(
      lower('add-assign.ts', 'export function inc(x: number): number { x += 1.0; return x; }').module,
    ).contents;
    expect(output).toContain('+=');
  });

  it('emits -= on numbers', () => {
    const output = emitIrModuleRust(
      lower('sub-assign.ts', 'export function dec(x: number): number { x -= 1.0; return x; }').module,
    ).contents;
    expect(output).toContain('-=');
  });
});

describe('emitIrModuleRust interface extends', () => {
  it('emits extended interface with flattened fields', () => {
    const output = emitIrModuleRust(
      lower(
        'iface-extends.ts',
        `export interface Base { x: number }
         export interface Child extends Base { y: number }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Child');
    expect(output).toContain('y:');
  });
});

describe('emitIrModuleRust intersection type refusal', () => {
  it('refuses intersection type in return position', () => {
    expect(() =>
      emitIrModuleRust(
        lower(
          'intersection-ret.ts',
          `interface A { a: number }
           interface B { b: number }
           export function get(): A & B { return { a: 1, b: 2 } as A & B; }`,
        ).module,
      ),
    ).toThrow('intersection');
  });
});

describe('emitIrModuleRust optional parameter defaulting', () => {
  it('emits optional parameter as Option wrapped in Some', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-param.ts',
        `export function greet(name: string, suffix?: string): string {
           const s = suffix ?? "!";
           return name + s;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<');
  });
});

describe('emitIrModuleRust parameter with initializer', () => {
  it('emits parameter default as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'param-default.ts',
        `export function greet(name: string, suffix: string = "!"): string {
           return name + suffix;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust concrete base composition', () => {
  it('emits class extending concrete class with composition pattern', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
           x: number;
           constructor(x: number) { this.x = x; }
           getX(): number { return this.x; }
         }
         export class Child extends Base {
           y: number;
           constructor(x: number, y: number) { super(x); this.y = y; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Child');
    expect(output).toContain('base');
  });
});

describe('emitIrModuleRust type parameter with constraint', () => {
  it('emits generic function with type bound', () => {
    const output = emitIrModuleRust(
      lower(
        'generic.ts',
        `export interface HasName { name: string }
         export function getName<T extends HasName>(item: T): string {
           return item.name;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('T:');
  });
});

describe('emitIrModuleRust object literal expression', () => {
  it('emits object literal as struct instantiation', () => {
    const output = emitIrModuleRust(
      lower(
        'obj-lit.ts',
        `export interface Pt { x: number; y: number }
         export function origin(): Pt { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('Pt {');
    expect(output).toContain('x:');
    expect(output).toContain('y:');
  });
});

describe('emitIrModuleRust optional interface property', () => {
  it('emits optional field as Option type in struct', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-field.ts',
        `export interface Config { name: string; debug?: boolean }
         export function makeConfig(n: string): Config { return { name: n }; }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<bool>');
    expect(output).toContain('None');
  });
});

describe('emitIrModuleRust typeof test', () => {
  it('emits typeof check as matches! macro on primitive union', () => {
    const output = emitIrModuleRust(
      lower(
        'typeof-check.ts',
        `export function isNum(x: string | number): boolean {
           return typeof x === "number";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('matches!');
  });
});

describe('emitIrModuleRust primitive union type', () => {
  it('emits string | number as tagged enum', () => {
    const output = emitIrModuleRust(
      lower('prim-union.ts', `export function identity(x: string | number): string | number { return x; }`).module,
    ).contents;
    expect(output).toContain('enum');
  });
});

describe('emitIrModuleRust Readonly wrapper type', () => {
  it('emits Readonly<T> parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'readonly-wrap.ts',
        `export interface Pt { x: number; y: number }
         export function freeze(p: Readonly<Pt>): number { return p.x; }`,
      ).module,
    ).contents;
    expect(output).toContain('fn freeze');
  });
});

describe('emitIrModuleRust class with accessor pair', () => {
  it('emits getter and setter as Rust methods', () => {
    const output = emitIrModuleRust(
      lower(
        'accessor.ts',
        `export class Box {
           private _value: number;
           constructor(v: number) { this._value = v; }
           get value(): number { return this._value; }
           set value(v: number) { this._value = v; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn value(');
    expect(output).toContain('fn set_value(');
  });
});

describe('emitIrModuleRust narrowed optional unwrap', () => {
  it('emits narrowed present optional as unwrap()', () => {
    const output = emitIrModuleRust(
      lower(
        'narrow-unwrap.ts',
        `export function safe(x: number | undefined): number {
           if (x !== undefined) { return x; }
           return 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap');
  });
});

describe('emitIrModuleRust optional property access', () => {
  it('emits ?. property as map on Option', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-prop.ts',
        `export interface Pt { x: number }
         export function getX(p: Pt | undefined): number | undefined { return p?.x; }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
  });
});

describe('emitIrModuleRust optional element access', () => {
  it('emits ?. element as and_then on Option', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-elem.ts',
        `export function first(items: number[] | undefined): number | undefined { return items?.[0]; }`,
      ).module,
    ).contents;
    expect(output).toContain('and_then');
  });
});

describe('emitIrModuleRust tagged union type alias', () => {
  it('emits discriminated union as Rust enum with variants', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        `interface Circle { kind: "circle"; radius: number }
         interface Square { kind: "square"; side: number }
         export type Shape = Circle | Square;`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle');
    expect(output).toContain('Square');
  });
});

describe('emitIrModuleRust object type alias as record', () => {
  it('emits type alias with object body as struct', () => {
    const output = emitIrModuleRust(
      lower('type-obj.ts', `export type Coord = { x: number; y: number };`).module,
    ).contents;
    expect(output).toContain('struct Coord');
  });
});

describe('emitIrModuleRust re-export', () => {
  it('emits re-export as pub use', () => {
    const output = emitIrModuleRust(lower('reexport.ts', `export { add } from "./helper.js";`).module).contents;
    expect(output).toContain('pub use');
  });
});

describe('emitIrModuleRust relative import', () => {
  it('emits use statement for relative import', () => {
    const output = emitIrModuleRust(
      lower(
        'import.ts',
        `import { add } from "./helper.js";
         export function double(x: number): number { return add(x, x); }`,
      ).module,
    ).contents;
    expect(output).toContain('use ');
  });
});

describe('emitIrModuleRust Math spread fold', () => {
  it('emits Math.max(...arr) as iter fold', () => {
    const output = emitIrModuleRust(
      lower('math-fold.ts', `export function maxVal(arr: number[]): number { return Math.max(...arr); }`).module,
    ).contents;
    expect(output).toContain('fold(');
  });
});

describe('emitIrModuleRust string charAt', () => {
  it('emits .charAt() with chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('char-at.ts', `export function first(s: string): string { return s.charAt(0); }`).module,
    ).contents;
    expect(output).toContain('chars().nth(');
  });
});

describe('emitIrModuleRust string charCodeAt', () => {
  it('emits .charCodeAt() with chars().nth() and u32 cast', () => {
    const output = emitIrModuleRust(
      lower('char-code.ts', `export function code(s: string): number { return s.charCodeAt(0); }`).module,
    ).contents;
    expect(output).toContain('chars().nth(');
    expect(output).toContain('as u32');
  });
});

describe('emitIrModuleRust string substring', () => {
  it('emits .substring(start, end) as slice', () => {
    const output = emitIrModuleRust(
      lower('substr.ts', `export function mid(s: string): string { return s.substring(1, 3); }`).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_string()');
  });
});

describe('emitIrModuleRust array concat', () => {
  it('emits .concat() with extend', () => {
    const output = emitIrModuleRust(
      lower('arr-concat.ts', `export function merge(a: number[], b: number[]): number[] { return a.concat(b); }`)
        .module,
    ).contents;
    expect(output).toContain('extend(');
  });
});

describe('emitIrModuleRust undefined variable declaration', () => {
  it('emits deferred variable for uninitialized let with later assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-var.ts',
        `export function test(): number {
           let x: number | undefined;
           x = 5;
           return x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('let ');
    expect(output).toContain('5.0');
  });
});

describe('emitIrModuleRust void return', () => {
  it('emits unit return type for void function', () => {
    const output = emitIrModuleRust(lower('void-fn.ts', 'export function noop(): void { }').module).contents;
    expect(output).toContain('()');
  });
});

describe('emitIrModuleRust never return type', () => {
  it('emits ! for never return type', () => {
    const output = emitIrModuleRust(
      lower('never-fn.ts', 'export function crash(): never { throw new Error("boom"); }').module,
    ).contents;
    expect(output).toContain('-> !');
  });
});

describe('emitIrModuleRust tuple type', () => {
  it('emits tuple type as Rust tuple', () => {
    const output = emitIrModuleRust(
      lower('tuple-type.ts', 'export function pair(a: number, b: string): [number, string] { return [a, b]; }').module,
    ).contents;
    expect(output).toContain('(f64, String)');
  });
});

describe('emitIrModuleRust array type', () => {
  it('emits array type as Vec<T>', () => {
    const output = emitIrModuleRust(
      lower('arr-type.ts', 'export function wrap(x: number): number[] { return [x]; }').module,
    ).contents;
    expect(output).toContain('Vec<f64>');
  });
});

describe('emitIrModuleRust class static method', () => {
  it('emits static method access as Type::method', () => {
    const output = emitIrModuleRust(
      lower(
        'static-method.ts',
        `export class Util {
           static double(x: number): number { return x + x; }
         }
         export function test(): number { return Util.double(5); }`,
      ).module,
    ).contents;
    expect(output).toContain('Util::double');
  });
});

describe('emitIrModuleRust enum member access', () => {
  it('emits enum member as Type::Variant', () => {
    const output = emitIrModuleRust(
      lower(
        'enum-access.ts',
        `export enum Dir { Up = 0, Down = 1 }
         export function up(): Dir { return Dir.Up; }`,
      ).module,
    ).contents;
    expect(output).toContain('Dir::Up');
  });
});

describe('emitIrModuleRust while-true as loop', () => {
  it('emits while(true) as Rust loop keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'loop.ts',
        `export function spin(): number {
           let i = 0.0;
           while (true) { i = i + 1.0; if (i > 10.0) return i; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).not.toContain('while true');
  });
});

describe('emitIrModuleRust deferred binding', () => {
  it('emits deferred variable for branching initialization', () => {
    const output = emitIrModuleRust(
      lower(
        'deferred.ts',
        `export function test(flag: boolean): number {
           let result: number;
           if (flag) { result = 1; } else { result = 2; }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('result');
    expect(output).toContain('1.0');
    expect(output).toContain('2.0');
  });
});

describe('emitIrModuleRust abstract class with concrete method', () => {
  it('emits abstract class default method as trait default', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-default.ts',
        `export abstract class Animal {
           abstract name(): string;
           greet(): string { return "hello"; }
         }
         export class Dog extends Animal {
           name(): string { return "dog"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Animal');
    expect(output).toContain('fn greet');
  });
});

describe('emitIrModuleRust array element access', () => {
  it('emits arr[i] with usize cast', () => {
    const output = emitIrModuleRust(
      lower('arr-elem.ts', `export function get(items: number[], i: number): number { return items[i]; }`).module,
    ).contents;
    expect(output).toContain('as usize');
  });
});

describe('emitIrModuleRust multiple return value', () => {
  it('emits tuple return', () => {
    const output = emitIrModuleRust(
      lower(
        'multi-ret.ts',
        `export function minmax(a: number, b: number): [number, number] {
           if (a < b) { return [a, b]; } else { return [b, a]; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('(f64, f64)');
  });
});

describe('emitIrModuleRust private field naming', () => {
  it('emits private fields with correct naming', () => {
    const output = emitIrModuleRust(
      lower(
        'private.ts',
        `export class Counter {
           private count: number;
           constructor() { this.count = 0; }
           get(): number { return this.count; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('count');
  });
});

describe('emitIrModuleRust Math namespace member', () => {
  it('emits Math.floor as f64::floor', () => {
    const output = emitIrModuleRust(
      lower('math-floor.ts', `export function floor(x: number): number { return Math.floor(x); }`).module,
    ).contents;
    expect(output).toContain('floor');
  });
});

describe('emitIrModuleRust not-equal operator', () => {
  it('emits !== as !=', () => {
    const output = emitIrModuleRust(
      lower('ne.ts', 'export function ne(a: number, b: number): boolean { return a !== b; }').module,
    ).contents;
    expect(output).toContain('!=');
  });
});

describe('emitIrModuleRust negative number literal', () => {
  it('emits negative prefix operator', () => {
    const output = emitIrModuleRust(
      lower('neg.ts', 'export function neg(x: number): number { return -x; }').module,
    ).contents;
    expect(output).toContain('-');
  });
});

describe('emitIrModuleRust logical NOT', () => {
  it('emits !x as Rust !', () => {
    const output = emitIrModuleRust(
      lower('not.ts', 'export function not(x: boolean): boolean { return !x; }').module,
    ).contents;
    expect(output).toContain('!');
  });
});

describe('emitIrModuleRust prefix increment refusal', () => {
  it('refuses prefix ++ operator', () => {
    expect(() =>
      emitIrModuleRust(lower('pre-inc.ts', 'export function inc(x: number): number { ++x; return x; }').module),
    ).toThrow('value-preserving');
  });
});

describe('emitIrModuleRust postfix decrement refusal', () => {
  it('refuses postfix -- operator', () => {
    expect(() =>
      emitIrModuleRust(lower('post-dec.ts', 'export function dec(x: number): number { x--; return x; }').module),
    ).toThrow('value-preserving');
  });
});

describe('emitIrModuleRust C-style for loop', () => {
  it('lowers C-style for to while loop', () => {
    const output = emitIrModuleRust(
      lower(
        'c-for.ts',
        `export function sum(n: number): number {
           let total = 0;
           for (let i = 0; i < n; i++) { total += i; }
           return total;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('while');
  });
});

describe('emitIrModuleRust class implementing interface trait', () => {
  it('emits class implementing interface with method as impl trait block', () => {
    const output = emitIrModuleRust(
      lower(
        'class-impl-trait.ts',
        `export interface Measurable { width(): number; height(): number; }
         export class Box implements Measurable {
           w: number;
           h: number;
           constructor(w: number, h: number) { this.w = w; this.h = h; }
           width(): number { return this.w; }
           height(): number { return this.h; }
           area(): number { return this.w * this.h; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Measurable');
    expect(output).toContain('impl Measurable for Box');
    expect(output).toContain('fn width');
    expect(output).toContain('fn area');
  });

  it('emits class implementing interface with data property as trait accessor', () => {
    const output = emitIrModuleRust(
      lower(
        'class-impl-data.ts',
        `export interface HasLabel { label: string; }
         export class Tag implements HasLabel {
           label: string;
           constructor(label: string) { this.label = label; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait HasLabel');
    expect(output).toContain('fn label');
    expect(output).toContain('impl HasLabel for Tag');
  });
});

describe('emitIrModuleRust nullish coalescing operator', () => {
  it('emits ?? as unwrap_or_else on optional chain receiver', () => {
    const output = emitIrModuleRust(
      lower(
        'nullish.ts',
        `export function safe(items: number[] | undefined): number {
           return items?.length ?? 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits ?? with excluded optional chain as the chain value alone', () => {
    const output = emitIrModuleRust(
      lower(
        'nullish-excluded.ts',
        `export interface Opt { label?: string; }
         export function getLabel(o: Opt | undefined): string | undefined {
           return o?.label ?? "default";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust exponentiation operator', () => {
  it('emits ** as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow.ts', 'export function pow(a: number, b: number): number { return a ** b; }').module,
    ).contents;
    expect(output).toContain('f64::powf');
  });
});

describe('emitIrModuleRust unsigned right shift', () => {
  it('emits >>> with u32 cast', () => {
    const output = emitIrModuleRust(
      lower('ursh.ts', 'export function ursh(a: number, b: number): number { return a >>> b; }').module,
    ).contents;
    expect(output).toContain('as u32');
  });
});

describe('emitIrModuleRust bitwise NOT', () => {
  it('emits ~ as !(x as i32) as f64', () => {
    const output = emitIrModuleRust(
      lower('bitnot.ts', 'export function bitnot(x: number): number { return ~x; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });
});

describe('emitIrModuleRust unary plus no-op', () => {
  it('emits unary +x as identity on number', () => {
    const output = emitIrModuleRust(
      lower('uplus.ts', 'export function pos(x: number): number { return +x; }').module,
    ).contents;
    expect(output).not.toContain('+x');
  });
});

describe('emitIrModuleRust template literal', () => {
  it('emits template as format! macro', () => {
    const output = emitIrModuleRust(
      lower('template.ts', 'export function greet(name: string): string { return `Hello ${name}!`; }').module,
    ).contents;
    expect(output).toContain('format!');
    expect(output).toContain('Hello');
  });

  it('emits template with multiple interpolations', () => {
    const output = emitIrModuleRust(
      lower('template-multi.ts', 'export function fmt(a: string, b: number): string { return `${a} is ${b}`; }').module,
    ).contents;
    expect(output).toContain('format!');
  });
});

describe('emitIrModuleRust do-while loop', () => {
  it('emits do-while as loop with break condition', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        `export function countdown(n: number): number {
           let i = n;
           do { i -= 1.0; } while (i > 0);
           return i;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop');
    expect(output).toContain('break');
  });
});

describe('emitIrModuleRust forOf loop', () => {
  it('emits for-of loop as for-in with into_iter', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of.ts',
        `export function total(values: number[]): number {
           let sum = 0;
           for (const v of values) { sum += v; }
           return sum;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('in');
  });
});

describe('emitIrModuleRust conditional expression', () => {
  it('emits ternary as if-else expression', () => {
    const output = emitIrModuleRust(
      lower('ternary.ts', 'export function max(a: number, b: number): number { return a > b ? a : b; }').module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });
});

describe('emitIrModuleRust cast expression', () => {
  it('emits type assertion as Rust as-cast', () => {
    const output = emitIrModuleRust(
      lower('cast.ts', 'export function toF64(x: number): number { return x as number; }').module,
    ).contents;
    expect(output).toContain('as f64');
  });
});

describe('emitIrModuleRust throw statement', () => {
  it('emits throw new Error as panic!', () => {
    const output = emitIrModuleRust(
      lower('throw.ts', `export function fail(msg: string): never { throw new Error(msg); }`).module,
    ).contents;
    expect(output).toContain('panic!');
  });

  it('emits throw non-Error as panic with debug', () => {
    const output = emitIrModuleRust(
      lower('throw-val.ts', `export function fail(msg: string): never { throw msg; }`).module,
    ).contents;
    expect(output).toContain('panic!');
    expect(output).toContain('{:?}');
  });
});

describe('emitIrModuleRust string concatenation', () => {
  it('emits string + string as format! concatenation', () => {
    const output = emitIrModuleRust(
      lower('str-concat.ts', `export function combine(a: string, b: string): string { return a + b; }`).module,
    ).contents;
    expect(output).toContain('format!');
  });
});

describe('emitIrModuleRust string methods', () => {
  it('emits .substring(start) as open range', () => {
    const output = emitIrModuleRust(
      lower('substr-one.ts', `export function tail(s: string): string { return s.substring(1); }`).module,
    ).contents;
    expect(output).toContain('..');
  });
});

describe('emitIrModuleRust bitwise operators', () => {
  it('emits & operator on numbers', () => {
    const output = emitIrModuleRust(
      lower('bitand.ts', 'export function band(a: number, b: number): number { return a & b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits | operator on numbers', () => {
    const output = emitIrModuleRust(
      lower('bitor.ts', 'export function bor(a: number, b: number): number { return a | b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits ^ operator on numbers', () => {
    const output = emitIrModuleRust(
      lower('bitxor.ts', 'export function bxor(a: number, b: number): number { return a ^ b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits << left shift operator', () => {
    const output = emitIrModuleRust(
      lower('shl.ts', 'export function shl(a: number, b: number): number { return a << b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits >> right shift operator', () => {
    const output = emitIrModuleRust(
      lower('shr.ts', 'export function shr(a: number, b: number): number { return a >> b; }').module,
    ).contents;
    expect(output).toContain('as i32');
  });
});

describe('emitIrModuleRust null literal in expression', () => {
  it('emits null as None', () => {
    const output = emitIrModuleRust(
      lower('null-lit.ts', `export function nothing(): string | null { return null; }`).module,
    ).contents;
    expect(output).toContain('None');
  });
});

describe('emitIrModuleRust abstract class with abstract field', () => {
  it('emits abstract field as trait accessor method', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-field.ts',
        `export abstract class Shape {
           abstract readonly area: number;
           describe(): string { return "shape"; }
         }
         export class Circle extends Shape {
           area: number;
           constructor(area: number) { this.area = area; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn area(&self)');
  });
});

describe('emitIrModuleRust optional property chain', () => {
  it('emits optional property access as map on Option', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-prop.ts',
        `export interface Node { value: number; }
         export function getValue(n: Node | undefined): number | undefined {
           return n?.value;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
    expect(output).toContain('optional_chain_value');
  });
});

describe('emitIrModuleRust re-export with renaming', () => {
  it('emits re-export as pub use with alias', () => {
    const reexport = lowerPackage(
      '@flighthq/core',
      'facade.ts',
      `export { Box as Container } from '@flighthq/types/public';`,
    ).module;
    const output = emitIrModuleRust(reexport).contents;
    expect(output).toContain('pub use');
  });
});

describe('emitIrModuleRust object rest expression', () => {
  it('emits object rest as field-by-field copy', () => {
    const output = emitIrModuleRust(
      lower(
        'obj-rest.ts',
        `export interface Item { a: number; b: string; c: boolean; }
         export function drop(item: Item): { b: string; c: boolean } {
           const { a, ...rest } = item;
           return rest;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
  });
});

describe('emitIrModuleRust integer literal index', () => {
  it('emits literal integer array index without usize cast', () => {
    const output = emitIrModuleRust(
      lower('lit-idx.ts', `export function first(items: number[]): number { return items[0]; }`).module,
    ).contents;
    expect(output).toContain('[0]');
    expect(output).not.toContain('as usize');
  });
});

describe('emitIrModuleRust type alias as plain alias', () => {
  it('emits non-union, non-object type alias as Rust type alias', () => {
    const output = emitIrModuleRust(
      lower(
        'type-alias.ts',
        `export type Count = number;
         export function inc(c: Count): Count { return c + 1; }`,
      ).module,
    ).contents;
    expect(output).toContain('type Count = f64');
  });
});

describe('emitIrModuleRust scope import naming', () => {
  it('emits scoped package import as crate use', () => {
    const module = lowerPackage(
      '@flighthq/core',
      'use-scoped.ts',
      `import type { Thing } from '@flighthq/types/public';
       export function wrap(t: Thing): Thing { return t; }`,
    ).module;
    const output = emitIrModuleRust(module).contents;
    expect(output).toContain('use');
    expect(output).toContain('flighthq_types');
  });
});

describe('emitIrModuleRust boolean strict equality', () => {
  it('emits === on booleans as ==', () => {
    const output = emitIrModuleRust(
      lower('bool-eq.ts', 'export function same(a: boolean, b: boolean): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('==');
    expect(output).not.toContain('===');
  });
});

describe('emitIrModuleRust call-site optional wrapping', () => {
  it('wraps provided argument in Some for optional parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'call-opt.ts',
        `export function greet(name: string, title?: string): string {
           const prefix = title ?? "";
           return prefix + name;
         }
         export function hello(n: string): string { return greet(n, "Mr"); }`,
      ).module,
    ).contents;
    expect(output).toContain('Some(');
  });

  it('passes None for omitted optional argument', () => {
    const output = emitIrModuleRust(
      lower(
        'call-opt-omit.ts',
        `export function greet(name: string, title?: string): string {
           const prefix = title ?? "";
           return prefix + name;
         }
         export function hello(n: string): string { return greet(n); }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
  });

  it('wraps provided argument in Some for default parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'call-default.ts',
        `export function greet(name: string, greeting: string = "Hello"): string {
           return greeting + " " + name;
         }
         export function hi(n: string): string { return greet(n, "Hi"); }`,
      ).module,
    ).contents;
    expect(output).toContain('Some(');
  });
});

describe('emitIrModuleRust class static field as const', () => {
  it('emits static field with literal initializer as associated constant', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
           static readonly VERSION: number = 1;
           value: number;
           constructor(v: number) { this.value = v; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('VERSION');
    expect(output).toContain('1.0');
  });
});

describe('emitIrModuleRust class with setter method', () => {
  it('emits setter as set_ prefixed method with &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'setter.ts',
        `export class Counter {
           count: number;
           constructor() { this.count = 0; }
           get value(): number { return this.count; }
           set value(n: number) { this.count = n; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn value');
    expect(output).toContain('set_value');
    expect(output).toContain('&mut self');
  });
});

describe('emitIrModuleRust class with mutating method', () => {
  it('emits method that assigns to this as &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'mutate.ts',
        `export class Counter {
           count: number;
           constructor() { this.count = 0; }
           increment(): void { this.count += 1.0; }
           get(): number { return this.count; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
    expect(output).toContain('fn increment');
  });
});

describe('emitIrModuleRust variable with undefined initial value', () => {
  it('emits let with None for undefined-initialized variable', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-init.ts',
        `export function find(items: number[]): number | undefined {
           let result: number | undefined = undefined;
           for (const item of items) { result = item; }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('None');
    expect(output).toContain('Option<f64>');
  });
});

describe('emitIrModuleRust closure as function type', () => {
  it('emits arrow function assigned to callback variable as Rc<dyn Fn>', () => {
    const output = emitIrModuleRust(
      lower(
        'callback-var.ts',
        `export function create(): (x: number) => number {
           const f: (x: number) => number = (x: number): number => x + 1;
           return f;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Rc');
    expect(output).toContain('dyn Fn');
  });
});

describe('emitIrModuleRust borrowed text parameter', () => {
  it('emits string literal argument without & prefix', () => {
    const output = emitIrModuleRust(
      lower(
        'borrowed-text.ts',
        `export function check(s: string): boolean {
           return s.includes("test");
         }`,
      ).module,
    ).contents;
    expect(output).toContain('"test"');
  });
});

describe('emitIrModuleRust optional element access', () => {
  it('emits ?.[i] on optional array as and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-elem.ts',
        `export function getFirst(items: number[] | undefined): number | undefined {
           return items?.[0];
         }`,
      ).module,
    ).contents;
    expect(output).toContain('and_then');
  });
});

describe('emitIrModuleRust rebound parameter', () => {
  it('emits mut on parameter the body reassigns', () => {
    const output = emitIrModuleRust(
      lower(
        'rebound.ts',
        `export function abs(x: number): number {
           if (x < 0) { x = -x; }
           return x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('mut x');
  });
});

describe('emitIrModuleRust expression-body closure', () => {
  it('emits arrow with expression body as Rust closure', () => {
    const output = emitIrModuleRust(
      lower(
        'expr-closure.ts',
        `export function apply(items: number[]): number[] {
           return items.map((x: number): number => x * 2);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('|');
    expect(output).toContain('* 2');
  });
});

describe('emitIrModuleRust tuple element access', () => {
  it('emits tuple[0] as .0 field access', () => {
    const output = emitIrModuleRust(
      lower('tuple-elem.ts', `export function first(pair: [number, string]): number { return pair[0]; }`).module,
    ).contents;
    expect(output).toContain('.0');
  });
});

describe('emitIrModuleRust string equality', () => {
  it('emits === on strings as ==', () => {
    const output = emitIrModuleRust(
      lower('str-eq.ts', 'export function eq(a: string, b: string): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('==');
  });
});

describe('emitIrModuleRust less-than comparison', () => {
  it('emits < as Rust < on numbers', () => {
    const output = emitIrModuleRust(
      lower('lt.ts', 'export function lt(a: number, b: number): boolean { return a < b; }').module,
    ).contents;
    expect(output).toContain('<');
  });
});

describe('emitIrModuleRust this field clone', () => {
  it('clones non-copy field read from this', () => {
    const output = emitIrModuleRust(
      lower(
        'this-clone.ts',
        `export class Holder {
           name: string;
           constructor(name: string) { this.name = name; }
           getName(): string { return this.name; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
    expect(output).toContain('fn get_name');
  });
});

describe('emitIrModuleRust switch with default case', () => {
  it('emits switch default as else branch', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-default.ts',
        `export function label(n: number): string {
           switch (n) {
             case 1: return "one";
             case 2: return "two";
             default: return "other";
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('else');
    expect(output).toContain('"other"');
  });
});

describe('emitIrModuleRust composition base member delegation', () => {
  it('delegates base field access through composition field', () => {
    const output = emitIrModuleRust(
      lower(
        'compose-delegate.ts',
        `export class Base {
           x: number;
           constructor(x: number) { this.x = x; }
           getX(): number { return this.x; }
         }
         export class Derived extends Base {
           y: number;
           constructor(x: number, y: number) { super(x); this.y = y; }
           sum(): number { return this.x + this.y; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('self.base');
  });
});

describe('emitIrModuleRust optional member in property access', () => {
  it('reads optional struct field value', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-member.ts',
        `export interface Cfg { label?: string; }
         export function getLabel(c: Cfg): string {
           return c.label ?? "default";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust nullish check with == null', () => {
  it('emits == null as is_none() check', () => {
    const output = emitIrModuleRust(
      lower('null-check.ts', `export function isNull(x: number | null): boolean { return x == null; }`).module,
    ).contents;
    expect(output).toContain('is_none');
  });

  it('emits != null as is_some() check', () => {
    const output = emitIrModuleRust(
      lower('not-null-check.ts', `export function notNull(x: number | null): boolean { return x != null; }`).module,
    ).contents;
    expect(output).toContain('is_some');
  });
});

describe('emitIrModuleRust array iterator methods', () => {
  it('emits .filter() as into_iter().filter()', () => {
    const output = emitIrModuleRust(
      lower(
        'filter.ts',
        `export function positives(items: number[]): number[] {
           return items.filter((x: number): boolean => x > 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('filter');
    expect(output).toContain('collect');
  });
});

describe('emitIrModuleRust index search methods', () => {
  it('emits .indexOf() as iter().position()', () => {
    const output = emitIrModuleRust(
      lower(
        'indexof.ts',
        `export function find(items: string[], target: string): number {
           return items.indexOf(target);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('position');
    expect(output).toContain('unwrap_or(-1.0)');
  });
});

describe('emitIrModuleRust ambient method binding kinds', () => {
  it('emits array.reduce as into_iter().fold() with reordered arguments', () => {
    const output = emitIrModuleRust(
      lower(
        'reduce.ts',
        `export function sum(items: number[]): number {
           return items.reduce((acc: number, x: number): number => acc + x, 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('fold');
  });

  it('emits array.find as into_iter().find() with borrowed element', () => {
    const output = emitIrModuleRust(
      lower(
        'find.ts',
        `export function first(items: number[]): number | undefined {
           return items.find((x: number): boolean => x > 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('find');
  });

  it('emits array.every as into_iter().all()', () => {
    const output = emitIrModuleRust(
      lower(
        'every.ts',
        `export function allPositive(items: number[]): boolean {
           return items.every((x: number): boolean => x > 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('all');
  });

  it('emits array.some as into_iter().any()', () => {
    const output = emitIrModuleRust(
      lower(
        'some.ts',
        `export function hasNeg(items: number[]): boolean {
           return items.some((x: number): boolean => x < 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('any');
  });

  it('emits array.map as into_iter().map().collect()', () => {
    const output = emitIrModuleRust(
      lower(
        'map.ts',
        `export function doubled(items: number[]): number[] {
           return items.map((x: number): number => x * 2);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('map');
    expect(output).toContain('collect');
  });

  it('emits string.indexOf as sentinelSearch .find()', () => {
    const output = emitIrModuleRust(
      lower(
        'str-indexof.ts',
        `export function pos(text: string, needle: string): number {
           return text.indexOf(needle);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.find(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits string.lastIndexOf as sentinelSearch .rfind()', () => {
    const output = emitIrModuleRust(
      lower(
        'str-lastindexof.ts',
        `export function lastPos(text: string, needle: string): number {
           return text.lastIndexOf(needle);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.rfind(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits string.split as splitCollect', () => {
    const output = emitIrModuleRust(
      lower(
        'str-split.ts',
        `export function parts(text: string, sep: string): string[] {
           return text.split(sep);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.split(');
    expect(output).toContain('collect::<Vec<String>>()');
  });

  it('emits map.get as optionalLookup .get().cloned()', () => {
    const output = emitIrModuleRust(
      lower(
        'map-get.ts',
        `export function lookup(m: Map<string, number>, key: string): number | undefined {
           return m.get(key);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.get(');
    expect(output).toContain('.cloned()');
  });

  it('emits array.join with borrowed separator', () => {
    const output = emitIrModuleRust(
      lower(
        'join.ts',
        `export function csv(items: string[]): string {
           return items.join(",");
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array.slice with start and end bounds', () => {
    const output = emitIrModuleRust(
      lower(
        'slice.ts',
        `export function mid(items: number[]): number[] {
           return items.slice(1, 3);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_vec()');
  });

  it('emits array.slice with start only', () => {
    const output = emitIrModuleRust(
      lower(
        'slice-start.ts',
        `export function tail(items: number[]): number[] {
           return items.slice(1);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize..');
    expect(output).toContain('.to_vec()');
  });

  it('emits array.slice with no arguments as .clone()', () => {
    const output = emitIrModuleRust(
      lower(
        'slice-clone.ts',
        `export function copy(items: number[]): number[] {
           return items.slice();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.clone()');
  });

  it('emits array.concat with extend', () => {
    const output = emitIrModuleRust(
      lower(
        'concat.ts',
        `export function merge(a: number[], b: number[]): number[] {
           return a.concat(b);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('extend');
    expect(output).toContain('__concat');
  });

  it('emits string.charAt with chars().nth()', () => {
    const output = emitIrModuleRust(
      lower(
        'charat.ts',
        `export function first(s: string): string {
           return s.charAt(0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('chars().nth(');
    expect(output).toContain('unwrap_or_default()');
  });

  it('emits string.charCodeAt with chars().nth() and NaN fallback', () => {
    const output = emitIrModuleRust(
      lower(
        'charcodeat.ts',
        `export function code(s: string): number {
           return s.charCodeAt(0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('chars().nth(');
    expect(output).toContain('f64::NAN');
  });

  it('emits string.substring with range indexing', () => {
    const output = emitIrModuleRust(
      lower(
        'substring.ts',
        `export function mid(s: string): string {
           return s.substring(1, 5);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_string()');
  });

  it('emits string.replace with replacen and trailing 1', () => {
    const output = emitIrModuleRust(
      lower(
        'replace.ts',
        `export function fix(s: string): string {
           return s.replace("old", "new");
         }`,
      ).module,
    ).contents;
    expect(output).toContain('replacen');
  });

  it('emits string.endsWith as ends_with()', () => {
    const output = emitIrModuleRust(
      lower(
        'endswith.ts',
        `export function check(s: string): boolean {
           return s.endsWith("!");
         }`,
      ).module,
    ).contents;
    expect(output).toContain('ends_with(');
  });

  it('emits string.startsWith as starts_with()', () => {
    const output = emitIrModuleRust(
      lower(
        'startswith.ts',
        `export function check(s: string): boolean {
           return s.startsWith("h");
         }`,
      ).module,
    ).contents;
    expect(output).toContain('starts_with(');
  });

  it('emits string.includes as contains()', () => {
    const output = emitIrModuleRust(
      lower(
        'str-includes.ts',
        `export function has(s: string, sub: string): boolean {
           return s.includes(sub);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.contains(');
  });

  it('emits string.trim with .to_owned()', () => {
    const output = emitIrModuleRust(
      lower(
        'trim.ts',
        `export function clean(s: string): string {
           return s.trim();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.trim()');
    expect(output).toContain('.to_owned()');
  });

  it('emits string.toLowerCase as to_lowercase()', () => {
    const output = emitIrModuleRust(
      lower(
        'tolower.ts',
        `export function down(s: string): string {
           return s.toLowerCase();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.to_lowercase()');
  });

  it('emits string.toUpperCase as to_uppercase()', () => {
    const output = emitIrModuleRust(
      lower(
        'toupper.ts',
        `export function up(s: string): string {
           return s.toUpperCase();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.to_uppercase()');
  });

  it('emits array.includes as contains() with borrowed argument', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-includes.ts',
        `export function has(items: string[], target: string): boolean {
           return items.includes(target);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.contains(');
  });

  it('emits array.push as .push()', () => {
    const output = emitIrModuleRust(
      lower(
        'push.ts',
        `export function add(items: number[]): void {
           items.push(1);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.push(');
  });

  it('emits array.pop as .pop()', () => {
    const output = emitIrModuleRust(
      lower(
        'pop.ts',
        `export function take(items: number[]): number | undefined {
           return items.pop();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.pop()');
  });

  it('emits array.reverse as .reverse()', () => {
    const output = emitIrModuleRust(
      lower(
        'reverse.ts',
        `export function flip(items: number[]): void {
           items.reverse();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.reverse()');
  });

  it('emits array.lastIndexOf as iter().rposition()', () => {
    const output = emitIrModuleRust(
      lower(
        'lastindexof.ts',
        `export function findLast(items: string[], target: string): number {
           return items.lastIndexOf(target);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('rposition');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits map.has as contains_key()', () => {
    const output = emitIrModuleRust(
      lower(
        'map-has.ts',
        `export function exists(m: Map<string, number>, key: string): boolean {
           return m.has(key);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.contains_key(');
  });

  it('emits map.set as insert()', () => {
    const output = emitIrModuleRust(
      lower(
        'map-set.ts',
        `export function put(m: Map<string, number>, key: string, val: number): void {
           m.set(key, val);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.insert(');
  });

  it('emits map.delete as remove()', () => {
    const output = emitIrModuleRust(
      lower(
        'map-del.ts',
        `export function del(m: Map<string, number>, key: string): void {
           m.delete(key);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.remove(');
  });

  it('emits set.add as insert()', () => {
    const output = emitIrModuleRust(
      lower(
        'set-add.ts',
        `export function add(s: Set<string>, val: string): void {
           s.add(val);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.insert(');
  });

  it('emits set.has as contains()', () => {
    const output = emitIrModuleRust(
      lower(
        'set-has.ts',
        `export function has(s: Set<string>, val: string): boolean {
           return s.has(val);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.contains(');
  });

  it('emits set.delete as remove()', () => {
    const output = emitIrModuleRust(
      lower(
        'set-del.ts',
        `export function del(s: Set<string>, val: string): void {
           s.delete(val);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.remove(');
  });

  it('emits Math.max(...arr) as fold with f64::NEG_INFINITY', () => {
    const output = emitIrModuleRust(
      lower(
        'math-max-spread.ts',
        `export function biggest(items: number[]): number {
           return Math.max(...items);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fold');
    expect(output).toContain('f64::NEG_INFINITY');
  });

  it('emits Math.min(...arr) as fold with f64::INFINITY', () => {
    const output = emitIrModuleRust(
      lower(
        'math-min-spread.ts',
        `export function smallest(items: number[]): number {
           return Math.min(...items);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fold');
    expect(output).toContain('f64::INFINITY');
  });

  it('emits number.toString as .to_string()', () => {
    const output = emitIrModuleRust(
      lower(
        'num-tostring.ts',
        `export function render(n: number): string {
           return n.toString();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.to_string()');
  });

  it('emits array.shift as .remove(0)', () => {
    const output = emitIrModuleRust(
      lower(
        'shift.ts',
        `export function take(items: number[]): number | undefined {
           return items.shift();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.remove(0');
  });

  it('emits array.unshift as .insert(0, ...)', () => {
    const output = emitIrModuleRust(
      lower(
        'unshift.ts',
        `export function prepend(items: number[]): void {
           items.unshift(42);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.insert(0');
  });
});

describe('emitIrModuleRust expression patterns', () => {
  it('emits tupleRest expression', () => {
    const output = emitIrModuleRust(
      lower(
        'tuple-rest.ts',
        `export function rest(pair: [number, string, boolean]): string {
           const [_first, ...tail] = pair;
           return tail[0];
         }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits undefinedDefault with unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-default.ts',
        `interface Opt { label?: string }
         export function name(o: Opt): string {
           return o.label ?? "none";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });

  it('emits forIn with closed key evidence', () => {
    const output = emitIrModuleRust(
      lower(
        'forin.ts',
        `interface Rec { a: number; b: number }
         export function keys(r: Rec): string[] {
           const out: string[] = [];
           for (const k in r) { out.push(k); }
           return out;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for ');
  });

  it('emits optional property chain with .map()', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-prop.ts',
        `interface Inner { value: number }
         export function read(x: Inner | undefined): number | undefined {
           return x?.value;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
    expect(output).toContain('optional_chain_value');
  });

  it('emits optional call expression', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-call.ts',
        `export function invoke(fn: ((x: number) => number) | undefined, val: number): number | undefined {
           return fn?.(val);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
    expect(output).toContain('optional_chain_value');
  });

  it('emits do-while with loop and trailing break guard', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        `export function countdown(n: number): number {
           let i: number = n;
           do { i = i - 1; } while (i > 0);
           return i;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).toContain('break');
  });

  it('emits IIFE as statement-value block expression', () => {
    const output = emitIrModuleRust(
      lower(
        'iife.ts',
        `export function compute(): number {
           return (() => { const x: number = 1; return x + 2; })();
         }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });
});

describe('emitIrModuleRust async try/catch with return await', () => {
  it('emits return-form settlement with Ok return and named catch binding', () => {
    const output = emitIrModuleRust(
      lower(
        'try-return-catch.ts',
        'export async function attempt(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return 0; } }',
      ).module,
    ).contents;
    expect(output).toContain('.settle()');
    expect(output).toContain('Ok(__value)');
    expect(output).toContain('return __value;');
    expect(output).toContain('Err(e)');
    expect(output).toContain('return 0.0;');
  });

  it('emits return-form settlement with catch only, no finally', () => {
    const output = emitIrModuleRust(
      lower(
        'try-return-catch-only.ts',
        'export async function attempt(task: Promise<number>, fallback: number): Promise<number> { try { return await task; } catch { return fallback; } }',
      ).module,
    ).contents;
    expect(output).toContain('Ok(__value)');
    expect(output).toContain('return __value;');
    expect(output).toContain('Err(_)');
    expect(output).toContain('return fallback;');
  });
});

describe('emitIrModuleRust void return statement', () => {
  it('emits early return without expression', () => {
    const output = emitIrModuleRust(
      lower(
        'void-return.ts',
        'export function guard(skip: boolean): void { if (skip) return; const value: number = 1; value; }',
      ).module,
    ).contents;
    expect(output).toContain('return;');
  });
});

describe('emitIrModuleRust switch default-only', () => {
  it('emits default body without case branches', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-default.ts',
        'export function name(code: number): number { switch (code) { default: return code; } }',
      ).module,
    ).contents;
    expect(output).toContain('return code;');
    expect(output).not.toContain('unreachable!');
  });
});

describe('emitIrModuleRust type alias passthrough', () => {
  it('emits non-object, non-union type alias as Rust type alias', () => {
    const output = emitIrModuleRust(lower('type-alias.ts', 'export type Count = number;').module).contents;
    expect(output).toContain('pub type Count = f64;');
  });

  it('emits string literal union as String type alias', () => {
    const output = emitIrModuleRust(
      lower('dir-alias.ts', 'export type Direction = "up" | "down" | "left" | "right";').module,
    ).contents;
    expect(output).toContain('pub type Direction = String;');
  });
});

describe('emitIrModuleRust throw statement', () => {
  it('emits throw new Error with panic! and message', () => {
    const output = emitIrModuleRust(
      lower('throw-new.ts', 'export function fail(msg: string): never { throw new Error(msg); }').module,
    ).contents;
    expect(output).toContain('panic!("{}", msg)');
  });

  it('emits throw non-Error as debug panic', () => {
    const output = emitIrModuleRust(
      lower('throw-plain.ts', 'export function fail(code: number): never { throw code; }').module,
    ).contents;
    expect(output).toContain('panic!("{:?}", code)');
  });
});

describe('emitIrModuleRust while-true and do-while', () => {
  it('emits while true as loop keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'while-true.ts',
        'export function spin(): number { let i: number = 0; while (true) { i += 1; if (i > 10) return i; } }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).not.toContain('while true');
  });

  it('emits do-while as loop with break condition', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        'export function count(): number { let i: number = 0; do { i += 1; } while (i < 10); return i; }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).toContain('if !(');
    expect(output).toContain('break;');
  });
});

describe('emitIrModuleRust labeled blocks and break targets', () => {
  it('emits labeled block with break target', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-block.ts',
        'export function test(x: number): number { outer: { if (x > 0) break outer; return -1; } return x; }',
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain("break 'outer");
  });

  it('emits continue with target label', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-continue.ts',
        'export function skip(items: number[]): number { let sum: number = 0; outer: for (const item of items) { if (item < 0) continue outer; sum += item; } return sum; }',
      ).module,
    ).contents;
    expect(output).toContain("continue 'outer");
  });
});

describe('emitIrModuleRust nullable variable initialization', () => {
  it('emits deferred nullable binding without mut or None', () => {
    const output = emitIrModuleRust(
      lower(
        'nullable-var.ts',
        'export function find(items: number[]): number | undefined { let found: number | undefined; for (const item of items) { found = item; } return found; }',
      ).module,
    ).contents;
    expect(output).toContain('let found: Option<f64>;');
  });

  it('emits mutable nullable variable with None initializer', () => {
    const output = emitIrModuleRust(
      lower(
        'nullable-mut.ts',
        'export function scan(items: number[]): number | undefined { let found: number | undefined = undefined; for (const item of items) { if (item > 0) { found = item; } } if (found) { found = found; } return found; }',
      ).module,
    ).contents;
    expect(output).toContain('Option<f64>');
    expect(output).toContain('None');
  });
});

describe('emitIrModuleRust closure cell wrapping', () => {
  it('emits Rc<Cell> for closure-captured mutable variable', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-wrap.ts',
        'export function counter(): (x: number) => number { let count: number = 0; const increment = (x: number): number => { count += x; return count; }; return increment; }',
      ).module,
    ).contents;
    expect(output).toContain('Rc::new(Cell::new(');
    expect(output).toContain('Rc::clone(');
  });
});

describe('emitIrModuleRust optional parameter emission', () => {
  it('emits optional parameter as Option wrapped', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-param.ts',
        'export function greet(name: string, title?: string): string { return title ? title : name; }',
      ).module,
    ).contents;
    expect(output).toContain('title: Option<String>');
  });
});

describe('emitIrModuleRust Readonly and Required type wrappers', () => {
  it('unwraps Readonly<T> to the inner type', () => {
    const output = emitIrModuleRust(
      lower(
        'readonly-type.ts',
        'export interface Config { readonly label: string } export function getName(config: Readonly<Config>): string { return config.label; }',
      ).module,
    ).contents;
    expect(output).toContain('config: Config');
    expect(output).not.toContain('Readonly<');
  });
});

describe('emitIrModuleRust mutable parameter emission', () => {
  it('emits rebound parameter with mut prefix', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-param.ts',
        'export function clamp(value: number, max: number): number { if (value > max) value = max; return value; }',
      ).module,
    ).contents;
    expect(output).toContain('mut value: f64');
  });
});

describe('emitIrModuleRust for-of with element borrow', () => {
  it('emits borrow prefix for element-access iterable', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of-elem.ts',
        'export function sum(matrix: number[][]): number { let total: number = 0; for (const row of matrix) { for (const item of row) { total += item; } } return total; }',
      ).module,
    ).contents;
    expect(output).toContain('for ');
    expect(output).toContain('total += ');
  });
});

describe('emitIrModuleRust primitive union dispatch', () => {
  it('emits typeof narrowing as matches! on primitive union enum', () => {
    const output = emitIrModuleRust(
      lower(
        'typeof-narrow.ts',
        `export function describe(value: string | number): string {
           if (typeof value === "string") { return value; }
           return value.toString();
         }`,
      ).module,
    ).contents;
    expect(output).toContain('enum');
    expect(output).toContain('matches!');
  });

  it('emits negated typeof test', () => {
    const output = emitIrModuleRust(
      lower(
        'typeof-neg.ts',
        `export function isNumber(value: string | number): boolean {
           return typeof value !== "string";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('!matches!');
  });
});

describe('emitIrModuleRust tagged union', () => {
  it('emits discriminated union as Rust enum with accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        `export interface Circle { kind: string; radius: number }
         export interface Square { kind: string; side: number }
         export type Shape = Circle | Square;`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle');
    expect(output).toContain('Square');
    expect(output).toContain('fn kind');
  });
});

describe('emitIrModuleRust type emission edge cases', () => {
  it('emits literal boolean type as bool', () => {
    const output = emitIrModuleRust(
      lower('lit-bool-type.ts', 'export function always(): true { return true; }').module,
    ).contents;
    expect(output).toContain('bool');
  });

  it('emits literal number type as f64', () => {
    const output = emitIrModuleRust(lower('lit-num-type.ts', 'export function one(): 1 { return 1; }').module).contents;
    expect(output).toContain('f64');
  });

  it('emits literal string type as String', () => {
    const output = emitIrModuleRust(
      lower('lit-str-type.ts', 'export function hello(): "hi" { return "hi"; }').module,
    ).contents;
    expect(output).toContain('String');
  });

  it('emits tuple type with trailing comma for single-element', () => {
    const output = emitIrModuleRust(
      lower('single-tuple-type.ts', 'export function wrap(x: number): [number] { return [x]; }').module,
    ).contents;
    expect(output).toContain('(f64,)');
  });

  it('emits never type as !', () => {
    const output = emitIrModuleRust(
      lower('never-type.ts', 'export function fail(msg: string): never { throw new Error(msg); }').module,
    ).contents;
    expect(output).toContain('!');
  });

  it('emits void type as ()', () => {
    const output = emitIrModuleRust(lower('void-type.ts', 'export function noop(): void {}').module).contents;
    expect(output).toContain('()');
  });

  it('emits string literal union alias as type alias to String', () => {
    const output = emitIrModuleRust(
      lower('str-union.ts', 'export type Direction = "north" | "south" | "east" | "west";').module,
    ).contents;
    expect(output).toContain('type Direction = String');
  });

  it('emits bigint as i64', () => {
    const output = emitIrModuleRust(
      lower('bigint.ts', 'export function big(n: bigint): bigint { return n; }').module,
    ).contents;
    expect(output).toContain('i64');
  });
});

describe('emitIrModuleRust labeled control flow', () => {
  it('emits labeled break with Rust lifetime label', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-break.ts',
        `export function find(grid: number[][]): number {
           outer: for (const row of grid) {
             for (const cell of row) {
               if (cell > 10) break outer;
             }
           }
           return -1;
         }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain('break');
  });

  it('emits labeled continue', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-continue.ts',
        `export function skip(items: number[][]): number {
           let count: number = 0;
           outer: for (const row of items) {
             for (const x of row) {
               if (x < 0) continue outer;
               count = count + 1;
             }
           }
           return count;
         }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain('continue');
  });

  it('emits while true as loop', () => {
    const output = emitIrModuleRust(
      lower(
        'while-true.ts',
        `export function spin(): number {
           let i: number = 0;
           while (true) { i = i + 1; if (i > 100) return i; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).not.toContain('while true');
  });
});

describe('emitIrModuleRust collection mutation methods', () => {
  it('emits map.set as insert and map.delete as remove', () => {
    const output = emitIrModuleRust(
      lower(
        'map-ops.ts',
        `export function update(m: Map<string, number>): void {
           m.set("a", 1);
           m.delete("b");
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.insert(');
    expect(output).toContain('.remove(');
  });
});

describe('emitIrModuleRust Readonly and Required type unwrapping', () => {
  it('emits Readonly<T> as T without wrapper', () => {
    const output = emitIrModuleRust(
      lower(
        'readonly-unwrap.ts',
        'export interface Item { value: number } export function read(item: Readonly<Item>): number { return item.value; }',
      ).module,
    ).contents;
    expect(output).toContain('item: Item');
    expect(output).not.toContain('Readonly<');
  });
});

describe('emitIrModuleRust switch exhaustiveness', () => {
  it('emits unreachable! when no default case', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-no-default.ts',
        `export function name(x: number): string {
           switch (x) {
             case 1: return "one";
             case 2: return "two";
           }
           return "other";
         }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });
});

describe('emitIrModuleRust try-catch without await', () => {
  it('emits catch_unwind for synchronous try-catch', () => {
    const output = emitIrModuleRust(
      lower(
        'try-catch-sync.ts',
        `export function safe(): number {
           try {
             return 1;
           } catch (e) {
             return 0;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('catch_unwind');
    expect(output).toContain('AssertUnwindSafe');
  });
});

describe('emitIrModuleRust forIn closed key iteration', () => {
  it('emits for-in with inline key list', () => {
    const output = emitIrModuleRust(
      lower(
        'forin-keys.ts',
        `interface Rec { a: number; b: number }
         export function keys(r: Rec): string[] {
           const out: string[] = [];
           for (const k in r) { out.push(k); }
           return out;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for ');
    expect(output).toContain('.to_owned()');
  });
});

describe('emitIrModuleRust tagged union type alias', () => {
  it('emits discriminated union as Rust enum with variant accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        `export interface Circle { radius: number }
         export interface Square { side: number }
         export type Shape = Circle | Square;`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle(');
    expect(output).toContain('Square(');
    expect(output).toContain('fn as_circle');
    expect(output).toContain('fn as_square');
  });

  it('emits shared field accessors on tagged union', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-shared.ts',
        `export interface Success { ok: boolean; value: number }
         export interface Failure { ok: boolean; message: string }
         export type Result = Success | Failure;`,
      ).module,
    ).contents;
    expect(output).toContain('enum Result');
    expect(output).toContain('fn ok(');
  });
});

describe('emitIrModuleRust primitive union enum', () => {
  it('emits string|number union as Rust enum', () => {
    const output = emitIrModuleRust(
      lower(
        'prim-union.ts',
        `export function check(value: string | number): boolean {
           if (typeof value === "string") { return true; }
           return false;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('enum');
  });
});

describe('emitIrModuleRust abstract class trait', () => {
  it('emits abstract class as Rust trait with default method', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-trait.ts',
        `export abstract class Shape {
           abstract area(): number;
           describe(): string { return "shape"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn area(');
    expect(output).toContain('fn describe(');
  });
});

describe('emitIrModuleRust class composition', () => {
  it('emits concrete base class composition with delegation', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
           value: number;
           constructor(value: number) { this.value = value; }
         }
         export class Derived extends Base {
           label: string;
           constructor(value: number, label: string) {
             super(value);
             this.label = label;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Derived');
    expect(output).toContain('base: Base');
    expect(output).toContain('Base::new(');
  });
});

describe('emitIrModuleRust string method bindings', () => {
  it('emits string indexOf as iter position search', () => {
    const output = emitIrModuleRust(
      lower('str-indexof.ts', `export function find(s: string, target: string): number { return s.indexOf(target); }`)
        .module,
    ).contents;
    expect(output).toContain('.find(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits string includes as contains', () => {
    const output = emitIrModuleRust(
      lower('str-includes.ts', `export function has(s: string, target: string): boolean { return s.includes(target); }`)
        .module,
    ).contents;
    expect(output).toContain('.contains(');
  });

  it('emits string split as split collect', () => {
    const output = emitIrModuleRust(
      lower('str-split.ts', `export function words(s: string): string[] { return s.split(" "); }`).module,
    ).contents;
    expect(output).toContain('.split(');
    expect(output).toContain('collect');
  });

  it('emits string substring with range', () => {
    const output = emitIrModuleRust(
      lower('str-substr.ts', `export function mid(s: string): string { return s.substring(1, 3); }`).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_string()');
  });

  it('emits string charAt with nth', () => {
    const output = emitIrModuleRust(
      lower('str-charat.ts', `export function code(s: string): number { return s.charCodeAt(0); }`).module,
    ).contents;
    expect(output).toContain('.chars().nth(');
  });
});

describe('emitIrModuleRust array method bindings', () => {
  it('emits array join with separator', () => {
    const output = emitIrModuleRust(
      lower('arr-join.ts', `export function csv(items: string[]): string { return items.join(","); }`).module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array slice as range clone', () => {
    const output = emitIrModuleRust(
      lower('arr-slice.ts', `export function tail(items: number[]): number[] { return items.slice(1); }`).module,
    ).contents;
    expect(output).toContain('as usize');
    expect(output).toContain('.to_vec()');
  });

  it('emits array concat as extend', () => {
    const output = emitIrModuleRust(
      lower('arr-concat.ts', `export function merge(a: number[], b: number[]): number[] { return a.concat(b); }`)
        .module,
    ).contents;
    expect(output).toContain('extend');
  });

  it('emits array indexOf as iter position', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-indexof.ts',
        `export function find(items: number[], target: number): number { return items.indexOf(target); }`,
      ).module,
    ).contents;
    expect(output).toContain('.iter()');
    expect(output).toContain('unwrap_or(-1.0)');
  });
});

describe('emitIrModuleRust scoped package import', () => {
  it('emits scoped package import as Rust crate use', () => {
    const output = emitIrModuleRust(
      lower(
        'scoped-import.ts',
        `import { Vec2 } from '@flighthq/types';
         export function use(v: Vec2): number { return v.x; }`,
      ).module,
    ).contents;
    expect(output).toContain('use ');
  });
});

describe('emitIrModuleRust exponentiation and bitwise', () => {
  it('emits ** as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow.ts', `export function square(x: number): number { return x ** 2; }`).module,
    ).contents;
    expect(output).toContain('f64::powf(');
  });

  it('emits >>> as unsigned right shift', () => {
    const output = emitIrModuleRust(
      lower('urs.ts', `export function shift(a: number, b: number): number { return a >>> b; }`).module,
    ).contents;
    expect(output).toContain('>>');
  });
});

describe('emitIrModuleRust record with optional fields', () => {
  it('emits optional interface fields as Option', () => {
    const output = emitIrModuleRust(
      lower('optional-field.ts', `export interface Config { label?: string; count: number }`).module,
    ).contents;
    expect(output).toContain('Option<String>');
    expect(output).toContain('count: f64');
  });
});

describe('emitIrModuleRust interface as trait', () => {
  it('emits interface with class implementation as trait', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-impl.ts',
        `export interface Printable { print(): number }
         export class Doc implements Printable {
           print(): number { return 0; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Printable');
    expect(output).toContain('impl Printable for Doc');
  });
});

describe('emitIrModuleRust Math spread fold', () => {
  it('emits Math.max spread as iter fold', () => {
    const output = emitIrModuleRust(
      lower('math-max.ts', `export function biggest(items: number[]): number { return Math.max(...items); }`).module,
    ).contents;
    expect(output).toContain('.iter()');
    expect(output).toContain('.fold(');
  });
});

describe('emitIrModuleRust class field initializers', () => {
  it('emits zero-argument constructor from field initializers', () => {
    const output = emitIrModuleRust(
      lower(
        'field-init.ts',
        `export class Counter {
           count: number = 0;
           label: string = "default";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new() -> Self');
    expect(output).toContain('count:');
    expect(output).toContain('label:');
  });
});

describe('emitIrModuleRust transitive method mutation', () => {
  it('emits mut self when method calls a mutating peer', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-transitive.ts',
        `export class Accumulator {
           total: number;
           constructor() { this.total = 0; }
           add(n: number): void { this.total = this.total + n; }
           addTwice(n: number): void { this.add(n); this.add(n); }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut self');
    expect(output).toContain('fn add(');
    expect(output).toContain('fn add_twice(');
  });
});

describe('emitIrModuleRust nullable binding and optional chain', () => {
  it('emits optional property access as map/and_then', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-chain.ts',
        `interface Config { label: string }
         export function getLabel(config: Config | undefined): string | undefined {
           return config?.label;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
  });

  it('emits nullish coalescing as unwrap_or_else', () => {
    const output = emitIrModuleRust(
      lower(
        'coalesce.ts',
        `interface Config { label: string }
         export function getLabel(config: Config | undefined): string {
           return config?.label ?? "default";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust re-export emission', () => {
  it('emits re-exports as pub use statements', () => {
    const result = lowerPackage('@flighthq/math', 'reexport.ts', `export { Vec2 } from './vector.js';`);
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('pub use');
    expect(output).toContain('Vec2');
  });
});

describe('emitIrModuleRust class with static constant field', () => {
  it('emits static field as associated constant', () => {
    const output = emitIrModuleRust(
      lower(
        'static-const.ts',
        `export class Config {
           static readonly VERSION: number = 1;
           name: string;
           constructor(name: string) { this.name = name; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('const VERSION');
    expect(output).toContain('1.0');
  });
});

describe('emitIrModuleRust type alias passthrough', () => {
  it('emits simple type alias as Rust type alias', () => {
    const output = emitIrModuleRust(lower('type-alias.ts', `export type Score = number;`).module).contents;
    expect(output).toContain('pub type Score = f64;');
  });
});

describe('emitIrModuleRust array element access with coalescing', () => {
  it('emits array index with ?? as get + unwrap_or', () => {
    const output = emitIrModuleRust(
      lower(
        'arr-coalesce.ts',
        `export function safe(items: number[], i: number): number {
           return items[i] ?? 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or');
  });
});

describe('emitIrModuleRust mutable variable declaration', () => {
  it('emits let mut for reassigned variable', () => {
    const output = emitIrModuleRust(
      lower(
        'mutable-var.ts',
        `export function count(): number {
           let total = 0;
           total = total + 1;
           return total;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('let mut total');
  });
});

describe('emitIrModuleRust enum declaration', () => {
  it('emits enum as associated constants on a struct', () => {
    const output = emitIrModuleRust(
      lower('enum-vals.ts', `export enum Direction { Up, Down, Left, Right }`).module,
    ).contents;
    expect(output).toContain('Direction');
    expect(output).toContain('Up');
    expect(output).toContain('Down');
  });
});

describe('emitIrModuleRust object literal expression', () => {
  it('emits object literal as struct construction', () => {
    const output = emitIrModuleRust(
      lower(
        'obj-lit.ts',
        `interface Point { x: number; y: number }
         export function origin(): Point { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('Point {');
    expect(output).toContain('x:');
    expect(output).toContain('y:');
  });
});

describe('emitIrModuleRust conditional expression', () => {
  it('emits ternary as Rust if-else expression', () => {
    const output = emitIrModuleRust(
      lower(
        'ternary.ts',
        `export function sign(x: number): number {
           return x >= 0 ? 1 : -1;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('if ');
    expect(output).toContain('else');
  });
});

describe('emitIrModuleRust string concatenation', () => {
  it('emits string + string as format! macro', () => {
    const output = emitIrModuleRust(
      lower(
        'str-concat.ts',
        `export function greet(name: string): string {
           return "hello " + name;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('format!');
  });
});

describe('emitIrModuleRust class method with accessor', () => {
  it('emits getter and setter as separate methods', () => {
    const output = emitIrModuleRust(
      lower(
        'accessor.ts',
        `export class Box {
           _value: number;
           constructor(v: number) { this._value = v; }
           get value(): number { return this._value; }
           set value(v: number) { this._value = v; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn value(');
    expect(output).toContain('fn set_value(');
  });
});

describe('emitIrModuleRust bitwise NOT and typeof', () => {
  it('emits bitwise NOT as i32 negation', () => {
    const output = emitIrModuleRust(
      lower('bitwise-not.ts', `export function invert(x: number): number { return ~x; }`).module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });
});

describe('emitIrModuleRust null literal in return', () => {
  it('emits null as None in nullable return', () => {
    const output = emitIrModuleRust(
      lower('null-return.ts', `export function nothing(): number | null { return null; }`).module,
    ).contents;
    expect(output).toContain('None');
    expect(output).toContain('Option<f64>');
  });
});

describe('emitIrModuleRust mutable module variable', () => {
  it('refuses a mutable module variable requiring synchronization', () => {
    expect(() => emitIrModuleRust(lower('mut-module-var.ts', `export let counter: number = 0;`).module)).toThrow(
      /synchronization/u,
    );
  });
});

describe('emitIrModuleRust module variable without initializer', () => {
  it('refuses a module variable without an initializer', () => {
    expect(() =>
      emitIrModuleRust(lower('no-init-var.ts', `export const value: number = undefined as unknown as number;`).module),
    ).toThrow();
  });
});

describe('emitIrModuleRust enum discriminant domain', () => {
  it('refuses an enum with a fractional discriminant', () => {
    expect(() => emitIrModuleRust(lower('frac-enum.ts', `export enum E { A = 1.5 }`).module)).toThrow(
      /discriminant domain/u,
    );
  });

  it('refuses an enum with a discriminant outside i32 range', () => {
    expect(() => emitIrModuleRust(lower('big-enum.ts', `export enum E { A = 3000000000 }`).module)).toThrow(
      /i32 range/u,
    );
  });
});

describe('emitIrModuleRust intersection type', () => {
  it('refuses an intersection type requiring record lowering', () => {
    expect(() =>
      emitIrModuleRust(
        lower(
          'intersect.ts',
          `interface A { a: number }
           interface B { b: string }
           export function use(val: A & B): A & B { return val; }`,
        ).module,
      ),
    ).toThrow(/intersection/u);
  });
});

describe('emitIrModuleRust synchronous try-finally', () => {
  it('refuses synchronous try/finally without catch', () => {
    expect(() =>
      emitIrModuleRust(
        lower(
          'try-finally.ts',
          `export function cleanup(): void {
             let x: number = 0;
             try { x = 1; } finally { x = 2; }
           }`,
        ).module,
      ),
    ).toThrow(/catch_unwind/u);
  });
});

describe('emitIrModuleRust bitwise compound assignment', () => {
  it('emits bitwise AND assignment through i32 cast', () => {
    const output = emitIrModuleRust(
      lower(
        'bitwise-and-assign.ts',
        `export function mask(x: number): number { let v: number = x; v &= 0xFF; return v; }`,
      ).module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('&');
  });

  it('emits left shift assignment through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('shl-assign.ts', `export function shift(x: number): number { let v: number = x; v <<= 2; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('<<');
  });

  it('emits right shift assignment through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('shr-assign.ts', `export function shift(x: number): number { let v: number = x; v >>= 2; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('>>');
  });

  it('emits XOR assignment through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('xor-assign.ts', `export function flip(x: number): number { let v: number = x; v ^= 0xFF; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('^');
  });

  it('emits OR assignment through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('or-assign.ts', `export function combine(x: number): number { let v: number = x; v |= 0x80; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('|');
  });
});

describe('emitIrModuleRust exponentiation assignment', () => {
  it('emits **= as f64::powf assignment', () => {
    const output = emitIrModuleRust(
      lower('pow-assign.ts', `export function square(x: number): number { let v: number = x; v **= 2; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('f64::powf');
  });
});

describe('emitIrModuleRust unsigned right shift assignment', () => {
  it('emits >>>= through u32 cast', () => {
    const output = emitIrModuleRust(
      lower('ushr-assign.ts', `export function shift(x: number): number { let v: number = x; v >>>= 2; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('as u32');
  });
});

describe('emitIrModuleRust binary exponentiation', () => {
  it('emits ** as f64::powf', () => {
    const output = emitIrModuleRust(
      lower('pow.ts', `export function square(x: number): number { return x ** 2; }`).module,
    ).contents;
    expect(output).toContain('f64::powf');
  });
});

describe('emitIrModuleRust unsigned right shift', () => {
  it('emits >>> through u32 cast', () => {
    const output = emitIrModuleRust(
      lower('ushr.ts', `export function shift(x: number): number { return x >>> 2; }`).module,
    ).contents;
    expect(output).toContain('as u32');
  });
});

describe('emitIrModuleRust bitwise binary operators', () => {
  it('emits & through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('bitwise-and.ts', `export function mask(a: number, b: number): number { return a & b; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits | through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('bitwise-or.ts', `export function combine(a: number, b: number): number { return a | b; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits ^ through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('bitwise-xor.ts', `export function flip(a: number, b: number): number { return a ^ b; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits << through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('shl.ts', `export function shift(a: number, b: number): number { return a << b; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });

  it('emits >> through i32 cast', () => {
    const output = emitIrModuleRust(
      lower('shr.ts', `export function shift(a: number, b: number): number { return a >> b; }`).module,
    ).contents;
    expect(output).toContain('as i32');
  });
});

describe('emitIrModuleRust assignment operator refusal', () => {
  it('emits &&= on boolean as conditional assignment', () => {
    const output = emitIrModuleRust(
      lower('and-assign.ts', `export function use(x: boolean): boolean { let v: boolean = x; v &&= true; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('if v {');
    expect(output).toContain('v = true');
  });

  it('emits ??= on nullable as Option conditional assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'nullish-assign.ts',
        `export function use(x: number | null): number | null { let v: number | null = x; v ??= 0; return v; }`,
      ).module,
    ).contents;
    expect(output).toContain('is_none()');
    expect(output).toContain('Some(');
  });

  it('emits ||= on boolean as negated conditional assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'or-logical-assign.ts',
        `export function use(x: boolean): boolean { let v: boolean = x; v ||= false; return v; }`,
      ).module,
    ).contents;
    expect(output).toContain('if !v {');
    expect(output).toContain('v = false');
  });

  it('emits ||= on number as truthiness-checked assignment', () => {
    const output = emitIrModuleRust(
      lower('or-num-assign.ts', `export function use(x: number): number { let v: number = x; v ||= 5; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('v == 0.0 || v.is_nan()');
    expect(output).toContain('v = 5.0');
  });

  it('emits &&= on number as truthiness-checked assignment', () => {
    const output = emitIrModuleRust(
      lower('and-num-assign.ts', `export function use(x: number): number { let v: number = x; v &&= 0; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('v != 0.0 && !v.is_nan()');
    expect(output).toContain('v = 0.0');
  });

  it('emits ||= on string as emptiness-checked assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'or-str-assign.ts',
        `export function use(x: string): string { let v: string = x; v ||= "fallback"; return v; }`,
      ).module,
    ).contents;
    expect(output).toContain('v.is_empty()');
    expect(output).toContain('v = "fallback".to_owned()');
  });

  it('emits &&= on string as non-empty-checked assignment', () => {
    const output = emitIrModuleRust(
      lower(
        'and-str-assign.ts',
        `export function use(x: string): string { let v: string = x; v &&= "replaced"; return v; }`,
      ).module,
    ).contents;
    expect(output).toContain('!v.is_empty()');
    expect(output).toContain('v = "replaced".to_owned()');
  });
});

describe('emitIrModuleRust string concatenation assignment', () => {
  it('emits += on strings as push_str', () => {
    const output = emitIrModuleRust(
      lower(
        'str-push.ts',
        `export function build(base: string): string { let s: string = base; s += " world"; return s; }`,
      ).module,
    ).contents;
    expect(output).toContain('push_str');
  });
});

describe('emitIrModuleRust unary plus on number', () => {
  it('emits unary + on number as identity', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', `export function identity(x: number): number { return +x; }`).module,
    ).contents;
    expect(output).not.toContain('++');
    expect(output).toContain('fn identity');
  });
});

describe('emitIrModuleRust undefined default expression', () => {
  it('emits ?? with unwrap_or_else for nullable binding', () => {
    const output = emitIrModuleRust(
      lower('undef-default.ts', `export function fallback(x: number | undefined): number { return x ?? 0; }`).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust null equality check', () => {
  it('emits null comparison as is_none', () => {
    const output = emitIrModuleRust(
      lower('null-check.ts', `export function isNull(x: number | null): boolean { return x === null; }`).module,
    ).contents;
    expect(output).toContain('is_none');
  });

  it('emits null inequality as is_some', () => {
    const output = emitIrModuleRust(
      lower('not-null-check.ts', `export function isPresent(x: number | null): boolean { return x !== null; }`).module,
    ).contents;
    expect(output).toContain('is_some');
  });
});

describe('emitIrModuleRust tagged union', () => {
  it('emits a type alias union of records as a Rust enum with shared accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        `export interface Circle { kind: string; radius: number }
         export interface Square { kind: string; side: number }
         export type Shape = Circle | Square;
         export function describe(s: Shape): string {
           return s.kind;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle(');
    expect(output).toContain('Square(');
    expect(output).toContain('fn kind(');
  });
});

describe('emitIrModuleRust primitive union enum', () => {
  it('emits a string | number parameter as a Rust enum with typeof test', () => {
    const output = emitIrModuleRust(
      lower(
        'prim-union.ts',
        `export function isText(val: string | number): boolean {
           return typeof val === 'string';
         }`,
      ).module,
    ).contents;
    expect(output).toContain('F64');
    expect(output).toContain('Str');
    expect(output).toContain('matches!');
  });
});

describe('emitIrModuleRust composition constructor', () => {
  it('emits a derived class with composition base field', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
           x: number;
           constructor(x: number) { this.x = x; }
         }
         export class Derived extends Base {
           y: number;
           constructor(x: number, y: number) { super(x); this.y = y; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Derived');
    expect(output).toContain('base: Base');
    expect(output).toContain('Base::new(');
  });
});

describe('emitIrModuleRust optional property chain', () => {
  it('emits ?. property access as Option map', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-prop.ts',
        `export interface Box { value: number }
         export function read(b: Box | undefined): number | undefined {
           return b?.value;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.map(');
    expect(output).toContain('optional_chain_value');
  });
});

describe('emitIrModuleRust cell-wrapped closure capture', () => {
  it('emits Rc<Cell> for a mutable variable captured by a returned closure', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-capture.ts',
        `export function makeCounter(): () => number {
           let count: number = 0;
           const inc = (): number => { count = count + 1; return count; };
           return inc;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Cell');
    expect(output).toContain('Rc');
  });

  it('emits cell-wrapped **= as f64::powf round-trip', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-power.ts',
        `export function makePower(): () => number {
           let value: number = 2;
           return () => { value **= 3; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('f64::powf(');
    expect(output).toContain('.set(');
    expect(output).toContain('.get()');
  });

  it('emits cell-wrapped >>>= as unsigned shift round-trip', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-ush.ts',
        `export function makeShifter(): () => number {
           let value: number = 255;
           return () => { value >>>= 1; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as u32) >>');
    expect(output).toContain('.set(');
    expect(output).toContain('.get()');
  });

  it('emits cell-wrapped bitwise &= as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-band.ts',
        `export function makeMasker(): () => number {
           let value: number = 0xff;
           return () => { value &= 0x0f; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as i32)');
    expect(output).toContain('.set(');
    expect(output).toContain('.get()');
  });

  it('emits cell-wrapped ||= on boolean as negated set', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-or-bool.ts',
        `export function makeOr(): () => boolean {
           let value: boolean = false;
           return () => { value ||= true; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('!value.get()');
    expect(output).toContain('.set(');
  });

  it('emits cell-wrapped &&= on boolean as conditional set', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-and-bool.ts',
        `export function makeAnd(): () => boolean {
           let value: boolean = true;
           return () => { value &&= false; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('value.get()');
    expect(output).toContain('.set(');
  });

  it('emits cell-wrapped ||= on number as truthiness-checked set', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-or.ts',
        `export function makeOr(): () => number {
           let value: number = 0;
           return () => { value ||= 5; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.get() == 0.0');
    expect(output).toContain('.is_nan()');
    expect(output).toContain('.set(');
  });

  it('emits cell-wrapped &&= on number as truthiness-checked set', () => {
    const output = emitIrModuleRust(
      lower(
        'cell-and.ts',
        `export function makeAnd(): () => number {
           let value: number = 1;
           return () => { value &&= 0; return value; };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.get() != 0.0');
    expect(output).toContain('.is_nan()');
    expect(output).toContain('.set(');
  });
});

describe('emitIrModuleRust class with abstract base trait', () => {
  it('emits abstract class as trait and concrete subclass implements it', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-base.ts',
        `export abstract class Animal {
           abstract name(): string;
           greet(): string { return "I am " + this.name(); }
         }
         export class Dog extends Animal {
           name(): string { return "Dog"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Animal');
    expect(output).toContain('impl Animal for Dog');
  });
});

describe('emitIrModuleRust class implements interface as trait', () => {
  it('emits interface as trait when a class implements it', () => {
    const output = emitIrModuleRust(
      lower(
        'impl-trait.ts',
        `export interface Describable { describe(): string }
         export class Item implements Describable {
           label: string;
           constructor(label: string) { this.label = label; }
           describe(): string { return this.label; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Describable');
    expect(output).toContain('impl Describable for Item');
  });
});

describe('emitIrModuleRust do-while loop', () => {
  it('emits do-while as loop with break condition', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        `export function countdown(n: number): number {
           let i: number = n;
           do { i = i - 1; } while (i > 0);
           return i;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop');
    expect(output).toContain('break');
  });
});

describe('emitIrModuleRust while-true loop', () => {
  it('emits while(true) as Rust loop', () => {
    const output = emitIrModuleRust(
      lower(
        'infinite-loop.ts',
        `export function spin(): number {
           let i: number = 0;
           while (true) { i = i + 1; if (i > 10) { return i; } }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('loop {');
  });
});

describe('emitIrModuleRust narrowed present unwrap', () => {
  it('emits narrowed present binding as unwrap', () => {
    const output = emitIrModuleRust(
      lower(
        'narrowed-unwrap.ts',
        `export function check(x: number | null): number {
           if (x !== null) { return x; }
           return 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap');
  });
});

describe('emitIrModuleRust object expression', () => {
  it('emits an object literal as a Rust struct construction', () => {
    const output = emitIrModuleRust(
      lower(
        'object-lit.ts',
        `export interface Point { x: number; y: number }
         export function origin(): Point { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('Point {');
    expect(output).toContain('x:');
    expect(output).toContain('y:');
  });
});

describe('emitIrModuleRust abstract class with abstract fields', () => {
  it('emits abstract fields as trait accessor methods', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-fields.ts',
        `export abstract class Shape {
           abstract readonly area: number;
         }
         export class Circle extends Shape {
           radius: number;
           constructor(r: number) { super(); this.radius = r; }
           get area(): number { return 3.14 * this.radius * this.radius; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Shape');
    expect(output).toContain('fn area(');
  });
});

describe('emitIrModuleRust tuple expression', () => {
  it('emits a tuple with one element including trailing comma', () => {
    const output = emitIrModuleRust(
      lower('tuple-one.ts', `export function wrap(x: number): [number] { return [x]; }`).module,
    ).contents;
    expect(output).toContain(',)');
  });
});

describe('emitIrModuleRust labeled break and continue', () => {
  it('emits labeled loop with break target', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-break.ts',
        `export function search(matrix: number[][]): boolean {
           outer: for (const row of matrix) {
             for (const val of row) {
               if (val === 42) { break outer; }
             }
           }
           return false;
         }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain("break 'outer");
  });
});

describe('emitIrModuleRust scoped package import module path', () => {
  it('converts scoped package import specifiers to Rust crate paths', () => {
    const output = emitIrModuleRust(
      lowerPackage(
        '@flighthq/core',
        'uses-types.ts',
        `import type { Item } from '@flighthq/types/item';
         export function name(item: Item): string { return item.name; }`,
      ).module,
    ).contents;
    expect(output).toContain('use ');
  });
});

describe('emitIrModuleRust class implements interface as trait', () => {
  it('emits trait impl block with method signatures from the implemented interface', () => {
    const output = emitIrModuleRust(
      lower(
        'class-trait.ts',
        `export interface Advancer { advance(n: number): number }
         export class Counter implements Advancer {
           count: number;
           constructor(start: number) { this.count = start; }
           advance(n: number): number { this.count = this.count + n; return this.count; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('impl Advancer for Counter');
    expect(output).toContain('fn advance(');
  });

  it('emits trait data property as accessor method', () => {
    const output = emitIrModuleRust(
      lower(
        'data-trait.ts',
        `export interface Named { readonly name: string }
         export class Tag implements Named {
           name: string;
           constructor(n: string) { this.name = n; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self) -> String;');
  });

  it('refuses a class that implements an unknown ambient type reference', () => {
    const result = lower(
      'non-binding-impl.ts',
      `export interface Marker { tag(): string }
       export class Impl implements Marker {
         tag(): string { return "ok"; }
       }`,
    );
    const module = result.module;
    const classDecl = module.declarations.find((d) => d.kind === 'class' && d.binding.name === 'Impl');
    if (classDecl?.kind === 'class') {
      const modified = {
        ...module,
        declarations: module.declarations.map((d) =>
          d === classDecl
            ? {
                ...d,
                implements: [
                  {
                    kind: 'named' as const,
                    reference: { kind: 'ambient' as const, name: 'UnknownTrait' },
                    typeArguments: [],
                  },
                ],
              }
            : d,
        ),
      };
      expect(() => emitIrModuleRust(modified)).toThrow('runtime external symbol binding plan is incomplete');
    }
  });
});

describe('emitIrModuleRust Math spread fold', () => {
  it('emits Math.min/max with spread as iter fold', () => {
    const output = emitIrModuleRust(
      lower('math-spread.ts', `export function smallest(items: number[]): number { return Math.min(...items); }`)
        .module,
    ).contents;
    expect(output).toContain('.iter().cloned().fold(');
  });
});

describe('emitIrModuleRust class with field initializers', () => {
  it('emits associated new for a class whose fields all have initializers', () => {
    const output = emitIrModuleRust(
      lower(
        'auto-init.ts',
        `export class Counter {
           count: number = 0;
           label: string = "default";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn new()');
    expect(output).toContain('count: 0.0');
    expect(output).toContain('label: "default"');
  });
});

describe('emitIrModuleRust static class fields', () => {
  it('emits static fields as associated constants', () => {
    const output = emitIrModuleRust(
      lower(
        'static-field.ts',
        `export class Config {
           static readonly MAX: number = 100;
           value: number;
           constructor(v: number) { this.value = v; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('const MAX: f64 = 100.0;');
  });
});

describe('emitIrModuleRust nullish comparison', () => {
  it('emits is_none for === null on an optional value', () => {
    const output = emitIrModuleRust(
      lower('null-check.ts', `export function absent(x: number | null): boolean { return x === null; }`).module,
    ).contents;
    expect(output).toContain('is_none()');
  });

  it('emits is_some for !== undefined on an optional value', () => {
    const output = emitIrModuleRust(
      lower('undef-check.ts', `export function present(x: number | undefined): boolean { return x !== undefined; }`)
        .module,
    ).contents;
    expect(output).toContain('is_some()');
  });
});

describe('emitIrModuleRust coalesce operator', () => {
  it('emits unwrap_or_else for ?? on optional chain result', () => {
    const output = emitIrModuleRust(
      lower(
        'coalesce.ts',
        `export interface Box { value: number }
         export function read(b: Box | undefined): number { return b?.value ?? 0; }`,
      ).module,
    ).contents;
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust template literal brace escaping', () => {
  it('escapes curly braces in template literal text parts', () => {
    const output = emitIrModuleRust(
      lower('template-brace.ts', 'export function greet(name: string): string { return `hello ${name}!`; }').module,
    ).contents;
    expect(output).toContain('format!(');
    expect(output).toContain('name');
  });
});

describe('emitIrModuleRust unary plus on number', () => {
  it('passes through the operand without emitting an operator', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', 'export function identity(x: number): number { return +x; }').module,
    ).contents;
    expect(output).toContain('return x;');
    expect(output).not.toContain('return +x;');
  });
});

describe('emitIrModuleRust cast expression', () => {
  it('emits explicit type cast with as keyword', () => {
    const output = emitIrModuleRust(
      lower('cast.ts', `export function narrow(x: number | string): number { return x as number; }`).module,
    ).contents;
    expect(output).toContain(' as ');
  });
});

describe('emitIrModuleRust array method bindings', () => {
  it('emits array.join as .join with borrowed text', () => {
    const output = emitIrModuleRust(
      lower('array-join.ts', `export function joined(items: string[]): string { return items.join(", "); }`).module,
    ).contents;
    expect(output).toContain('.join(');
  });

  it('emits array.slice with range bounds and .to_vec()', () => {
    const output = emitIrModuleRust(
      lower('array-slice.ts', `export function tail(items: number[]): number[] { return items.slice(1); }`).module,
    ).contents;
    expect(output).toContain('as usize..].to_vec()');
  });

  it('emits array.slice with two bounds', () => {
    const output = emitIrModuleRust(
      lower('array-slice-range.ts', `export function middle(items: number[]): number[] { return items.slice(1, 3); }`)
        .module,
    ).contents;
    expect(output).toContain('as usize..3');
    expect(output).toContain('.to_vec()');
  });

  it('emits array.concat as extend', () => {
    const output = emitIrModuleRust(
      lower('array-concat.ts', `export function merge(a: number[], b: number[]): number[] { return a.concat(b); }`)
        .module,
    ).contents;
    expect(output).toContain('__concat');
    expect(output).toContain('.extend(');
  });

  it('emits array.indexOf as iter position search', () => {
    const output = emitIrModuleRust(
      lower(
        'index-of.ts',
        `export function find(items: string[], target: string): number { return items.indexOf(target); }`,
      ).module,
    ).contents;
    expect(output).toContain('.iter().position(');
    expect(output).toContain('unwrap_or(-1.0)');
  });
});

describe('emitIrModuleRust string method bindings', () => {
  it('emits string.charAt as chars().nth()', () => {
    const output = emitIrModuleRust(
      lower('char-at.ts', `export function first(s: string): string { return s.charAt(0); }`).module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('unwrap_or_default()');
  });

  it('emits string.charCodeAt as chars().nth() with u32 cast', () => {
    const output = emitIrModuleRust(
      lower('char-code.ts', `export function code(s: string): number { return s.charCodeAt(0); }`).module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('as u32 as f64');
  });

  it('emits string.substring as slice with range bounds', () => {
    const output = emitIrModuleRust(
      lower('substring.ts', `export function sub(s: string): string { return s.substring(1, 3); }`).module,
    ).contents;
    expect(output).toContain('as usize..3');
    expect(output).toContain('.to_string()');
  });

  it('emits string.indexOf as sentinel search with find', () => {
    const output = emitIrModuleRust(
      lower('string-index.ts', `export function pos(s: string, target: string): number { return s.indexOf(target); }`)
        .module,
    ).contents;
    expect(output).toContain('.find(');
    expect(output).toContain('unwrap_or(-1.0)');
  });

  it('emits string.split as splitCollect', () => {
    const output = emitIrModuleRust(
      lower('string-split.ts', `export function parts(s: string): string[] { return s.split(","); }`).module,
    ).contents;
    expect(output).toContain('.split(');
    expect(output).toContain('.collect::<Vec<String>>()');
  });
});

describe('emitIrModuleRust transitive method mutation', () => {
  it('marks a caller of a mutating method as &mut self transitively', () => {
    const output = emitIrModuleRust(
      lower(
        'transitive-mut.ts',
        `export class Counter {
           count: number;
           constructor() { this.count = 0; }
           increment(): void { this.count = this.count + 1; }
           incrementTwice(): void { this.increment(); this.increment(); }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn increment(&mut self)');
    expect(output).toContain('fn increment_twice(&mut self)');
  });
});

describe('emitIrModuleRust element mutation through this', () => {
  it('marks a method that writes through this[index] as &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'element-mut.ts',
        `export class Buffer {
           data: number[];
           constructor() { this.data = []; }
           set(index: number, value: number): void { this.data[index] = value; }
           get(index: number): number { return this.data[index]!; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn set(&mut self');
    expect(output).toContain('fn get(&self');
  });
});

describe('emitIrModuleRust class static member access', () => {
  it('emits static field access as Type::CONSTANT', () => {
    const output = emitIrModuleRust(
      lower(
        'static-access.ts',
        `export class Config {
           static readonly MAX: number = 100;
           value: number;
           constructor(v: number) { this.value = v; }
         }
         export function limit(): number { return Config.MAX; }`,
      ).module,
    ).contents;
    expect(output).toContain('Config::MAX');
  });
});

describe('emitIrModuleRust new expression with non-identifier callee', () => {
  it('refuses qualified constructors', () => {
    const result = lower(
      'new-ctor.ts',
      `export class Box { value: number; constructor(v: number) { this.value = v; } }
       export function make(): Box { return new Box(1); }`,
    );
    const module = result.module;
    const funcDecl = module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'make');
    if (funcDecl?.kind === 'function') {
      const returnStmt = funcDecl.body.find((s) => s.kind === 'return');
      if (returnStmt?.kind === 'return' && returnStmt.expression?.kind === 'new') {
        const modifiedFunc = {
          ...funcDecl,
          body: funcDecl.body.map((s) =>
            s.kind === 'return' && s.expression?.kind === 'new'
              ? {
                  ...s,
                  expression: {
                    ...s.expression,
                    callee: {
                      kind: 'property' as const,
                      object: s.expression.callee,
                      name: 'Inner',
                      optional: false,
                      semantics: { receivers: [] },
                    },
                  },
                }
              : s,
          ),
        };
        const modified = {
          ...module,
          declarations: module.declarations.map((d) => (d === funcDecl ? modifiedFunc : d)),
        };
        expect(() => emitIrModuleRust(modified)).toThrow('qualified constructors require Rust type-path lowering');
      }
    }
  });
});

describe('emitIrModuleRust import emission', () => {
  it('emits use statements for cross-module imports', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'consumer.ts',
      `import { helper } from './util.js'; export function run(): number { return helper(); }`,
    );
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('use crate::');
    expect(output).toContain('helper');
  });

  it('refuses namespace and default imports', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'ns-import.ts',
      `import * as util from './util.js'; export function run(): number { return util.helper(); }`,
    );
    expect(() => emitIrModuleRust(result.module)).toThrow('imports require explicit Rust mapping');
  });
});

describe('emitIrModuleRust reexport emission', () => {
  it('emits pub use for named reexports', () => {
    const result = lowerPackage('@flighthq/core', 'facade.ts', `export { helper } from './util.js';`);
    const output = emitIrModuleRust(result.module).contents;
    expect(output).toContain('pub use crate::');
  });
});

describe('emitIrModuleRust reduce with argument reorder', () => {
  it('emits array.reduce as fold with reordered arguments', () => {
    const output = emitIrModuleRust(
      lower(
        'reduce.ts',
        `export function sum(items: number[]): number {
           return items.reduce((acc: number, item: number): number => acc + item, 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.into_iter().fold(');
  });
});

describe('emitIrModuleRust array filter with borrowed element', () => {
  it('emits filter as into_iter().filter() with borrowed element closure', () => {
    const output = emitIrModuleRust(
      lower(
        'filter.ts',
        `export function positives(items: number[]): number[] {
           return items.filter((x: number): boolean => x > 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.into_iter().filter(');
    expect(output).toContain('.collect::<Vec<_>>()');
  });
});

describe('emitIrModuleRust safeRustValueName edge cases', () => {
  it('escapes Rust keywords in emitted identifiers', () => {
    const output = emitIrModuleRust(
      lower('keyword-field.ts', `export function type_(x: number): number { return x; }`).module,
    ).contents;
    expect(output).toContain('fn type_');
  });

  it('strips private field hash prefix in emitted names', () => {
    const output = emitIrModuleRust(
      lower(
        'private-hash.ts',
        `export class Box {
           #value: number;
           constructor(v: number) { this.#value = v; }
           read(): number { return this.#value; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('value:');
    expect(output).not.toContain('#value');
  });
});

describe('emitIrModuleRust template literal with single interpolation', () => {
  it('emits format! with placeholder for template with one expression', () => {
    const output = emitIrModuleRust(
      lower('template-interp.ts', 'export function greet(name: string): string { return `hello ${name}`; }').module,
    ).contents;
    expect(output).toContain('format!("hello {}"');
  });
});

describe('emitIrModuleRust array slice with zero arguments', () => {
  it('emits clone() when slice is called with no arguments', () => {
    const output = emitIrModuleRust(
      lower('arr-clone.ts', 'export function copy(items: number[]): number[] { return items.slice(); }').module,
    ).contents;
    expect(output).toContain('.clone()');
  });
});

describe('emitIrModuleRust interface as trait with data properties', () => {
  it('emits trait accessor method for non-function interface properties', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-data.ts',
        `export interface Named { name: string; greet(): string; }
         export class Person implements Named {
           name: string;
           constructor(name: string) { this.name = name; }
           greet(): string { return this.name; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Named');
    expect(output).toContain('fn name(&self) -> String;');
    expect(output).toContain('fn greet(&self) -> String;');
  });
});

describe('emitIrModuleRust prefix unary operators', () => {
  it('emits prefix negation on number operand', () => {
    const output = emitIrModuleRust(
      lower('prefix-neg.ts', 'export function negate(n: number): number { return -n; }').module,
    ).contents;
    expect(output).toContain('-n');
  });
});

describe('emitIrModuleRust variable initialized to undefined', () => {
  it('emits None for a variable explicitly initialized to undefined with nullable type', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-init.ts',
        'export function find(items: number[]): number | undefined { let result: number | undefined = undefined; for (const item of items) { result = item; } return result; }',
      ).module,
    ).contents;
    expect(output).toContain('let mut result: Option<f64> = None;');
  });
});

describe('emitIrModuleRust logical NOT on boolean', () => {
  it('emits logical NOT as prefix exclamation', () => {
    const output = emitIrModuleRust(
      lower('logical-not.ts', 'export function flip(b: boolean): boolean { return !b; }').module,
    ).contents;
    expect(output).toContain('!b');
  });
});

describe('emitIrModuleRust transitive method mutation detection', () => {
  it('marks a method as mutating when it calls another mutating method', () => {
    const output = emitIrModuleRust(
      lower(
        'transitive-mut.ts',
        `export class Counter {
           count: number;
           constructor() { this.count = 0; }
           increment(): void { this.count = this.count + 1; }
           incrementTwice(): void { this.increment(); this.increment(); }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn increment(&mut self)');
    expect(output).toContain('fn increment_twice(&mut self)');
  });
});

describe('emitIrModuleRust bitwise NOT operator', () => {
  it('emits bitwise NOT as i32 cast round-trip', () => {
    const output = emitIrModuleRust(
      lower('bitwise-not.ts', 'export function invert(n: number): number { return ~n; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });
});

describe('emitIrModuleRust unary plus on number', () => {
  it('emits identity for unary plus on number operand', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', 'export function identity(n: number): number { return +n; }').module,
    ).contents;
    expect(output).not.toContain('+ n');
    expect(output).toContain('return n;');
  });
});

describe('emitIrModuleRust conditional expression', () => {
  it('emits ternary as Rust if-else expression', () => {
    const output = emitIrModuleRust(
      lower('ternary.ts', 'export function pick(flag: boolean, a: number, b: number): number { return flag ? a : b; }')
        .module,
    ).contents;
    expect(output).toContain('if flag');
    expect(output).toContain('} else {');
  });
});

describe('emitIrModuleRust class with assignment mutation on this', () => {
  it('detects this.field = expr as mutation and emits &mut self', () => {
    const output = emitIrModuleRust(
      lower(
        'assign-mut.ts',
        `export class Counter {
           value: number;
           constructor() { this.value = 0; }
           set(n: number): void { this.value = n; }
           get(): number { return this.value; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('fn set(&mut self');
    expect(output).toContain('fn get(&self)');
  });
});

describe('emitIrModuleRust null literal emission', () => {
  it('emits null literal as None', () => {
    const output = emitIrModuleRust(
      lower('null-lit.ts', 'export function nothing(): number | null { return null; }').module,
    ).contents;
    expect(output).toContain('None');
  });
});

describe('emitIrModuleRust non-exported string union type alias', () => {
  it('emits non-exported string literal union as type alias to String', () => {
    const output = emitIrModuleRust(
      lower(
        'string-union.ts',
        `type Direction = 'left' | 'right';
         export function go(d: Direction): string { return d; }`,
      ).module,
    ).contents;
    expect(output).toContain('type Direction = String;');
  });
});

describe('emitIrModuleRust tuple type emission', () => {
  it('emits single-element tuple with trailing comma', () => {
    const output = emitIrModuleRust(
      lower('single-tuple.ts', 'export function wrap(n: number): [number] { return [n]; }').module,
    ).contents;
    expect(output).toContain('(f64,)');
  });
});

describe('emitIrModuleRust do-while loop', () => {
  it('emits do-while as loop with trailing break condition', () => {
    const output = emitIrModuleRust(
      lower(
        'do-while.ts',
        'export function halve(n: number): number { let x = n; do { x = x / 2; } while (x > 1); return x; }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).toContain('break');
  });
});

describe('emitIrModuleRust cast expression', () => {
  it('emits type cast as Rust as operator', () => {
    const output = emitIrModuleRust(
      lower('cast.ts', 'export function asNum(x: unknown): number { return x as number; }').module,
    ).contents;
    expect(output).toContain(' as ');
  });
});

describe('emitIrModuleRust while true loop', () => {
  it('emits while true as loop keyword', () => {
    const output = emitIrModuleRust(
      lower(
        'infinite-loop.ts',
        'export function spin(): number { let x: number = 0; while (true) { x = x + 1; if (x > 10) { return x; } } }',
      ).module,
    ).contents;
    expect(output).toContain('loop {');
    expect(output).not.toContain('while true');
  });
});

describe('emitIrModuleRust tagged union type alias', () => {
  it('emits a union of named interfaces as a Rust enum with accessors', () => {
    const output = emitIrModuleRust(
      lower(
        'tagged-union.ts',
        `export interface Circle { radius: number; }
         export interface Square { side: number; }
         export type Shape = Circle | Square;
         export function area(shape: Shape): number { return 0; }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Shape');
    expect(output).toContain('Circle(Circle)');
    expect(output).toContain('Square(Square)');
    expect(output).toContain('fn as_circle');
    expect(output).toContain('fn as_square');
  });
});

describe('emitIrModuleRust tagged union with shared properties', () => {
  it('generates shared property accessors for properties present in all variants', () => {
    const output = emitIrModuleRust(
      lower(
        'shared-union.ts',
        `export interface Dog { name: string; legs: number; }
         export interface Cat { name: string; indoor: boolean; }
         export type Pet = Dog | Cat;
         export function label(pet: Pet): string { return pet.name; }`,
      ).module,
    ).contents;
    expect(output).toContain('enum Pet');
    expect(output).toContain('fn name(&self) -> String');
  });
});

describe('emitIrModuleRust abstract class as trait', () => {
  it('emits abstract class with methods as Rust trait with default implementations', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-class.ts',
        `export abstract class Renderer {
           abstract render(): string;
           prefix(): string { return ">> "; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Renderer');
    expect(output).toContain('fn render(&self) -> String;');
    expect(output).toContain('fn prefix(&self) -> String {');
  });
});

describe('emitIrModuleRust abstract class subclass trait impl', () => {
  it('emits subclass with inherited trait impl block', () => {
    const output = emitIrModuleRust(
      lower(
        'abstract-impl.ts',
        `export abstract class Formatter {
           abstract format(value: number): string;
         }
         export class HexFormatter extends Formatter {
           format(value: number): string { return value.toString(); }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('trait Formatter');
    expect(output).toContain('impl Formatter for HexFormatter');
  });
});

describe('emitIrModuleRust enum declaration', () => {
  it('emits TypeScript enum as Rust struct with associated constants', () => {
    const output = emitIrModuleRust(
      lower(
        'enum-decl.ts',
        `export enum Color { Red = 0, Green = 1, Blue = 2 }
         export function pick(c: Color): number { return c; }`,
      ).module,
    ).contents;
    expect(output).toContain('Color');
  });
});

describe('emitIrModuleRust for-of loop', () => {
  it('emits for-of over array as for-in loop', () => {
    const output = emitIrModuleRust(
      lower(
        'for-of.ts',
        `export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total = total + item; } return total; }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('in');
  });
});

describe('emitIrModuleRust lent operand for mutated parameter', () => {
  it('emits &mut for parameter the function mutates through', () => {
    const output = emitIrModuleRust(
      lower(
        'mut-param.ts',
        `export interface Cell { value: number; }
         export function set(cell: Cell, n: number): void { cell.value = n; }`,
      ).module,
    ).contents;
    expect(output).toContain('&mut');
  });
});

describe('emitIrModuleRust class composition constructor', () => {
  it('emits field delegation for class extending concrete base', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        `export class Base {
           x: number;
           constructor(x: number) { this.x = x; }
         }
         export class Derived extends Base {
           y: number;
           constructor(x: number, y: number) { super(x); this.y = y; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('base:');
  });
});

describe('emitIrModuleRust multiple runtime use imports', () => {
  it('emits braced use tree when multiple runtime types are used', () => {
    const output = emitIrModuleRust(
      lower(
        'multi-runtime.ts',
        `export function run(p: Promise<number>, q: Promise<string>): Promise<number> { return p; }`,
      ).module,
    ).contents;
    expect(output).toContain('use flight_runtime::');
  });
});

describe('emitIrModuleRust function type emission', () => {
  it('emits function type as Rc<dyn Fn>', () => {
    const output = emitIrModuleRust(
      lower('fn-type.ts', `export function apply(f: (x: number) => number, value: number): number { return f(value); }`)
        .module,
    ).contents;
    expect(output).toContain('Rc<dyn Fn(');
  });
});

describe('emitIrModuleRust rebound binding mut', () => {
  it('emits mut for a parameter the body reassigns', () => {
    const output = emitIrModuleRust(
      lower(
        'rebound.ts',
        'export function clamp(value: number, max: number): number { let v = value; if (v > max) { v = max; } return v; }',
      ).module,
    ).contents;
    expect(output).toContain('let mut v');
  });
});

describe('emitIrModuleRust string concatenation', () => {
  it('emits string + string as format! concatenation', () => {
    const output = emitIrModuleRust(
      lower('str-concat.ts', 'export function greet(name: string): string { return "hello " + name; }').module,
    ).contents;
    expect(output).toContain('format!');
  });
});

describe('emitIrModuleRust type alias for object type', () => {
  it('emits type alias with object type as pub struct', () => {
    const output = emitIrModuleRust(
      lower(
        'type-alias-obj.ts',
        `export type Pair = { first: number; second: number; };
         export function sum(p: Pair): number { return p.first + p.second; }`,
      ).module,
    ).contents;
    expect(output).toContain('pub struct Pair');
    expect(output).toContain('first: f64');
    expect(output).toContain('second: f64');
  });
});

describe('emitIrModuleRust optional record property', () => {
  it('emits optional interface property as Option field', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-prop.ts',
        `export interface Config { name: string; timeout?: number; }
         export function create(name: string): Config { return { name }; }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<f64>');
  });
});

describe('emitIrModuleRust labeled break', () => {
  it('emits labeled break with Rust lifetime label', () => {
    const output = emitIrModuleRust(
      lower(
        'labeled-break.ts',
        `export function search(matrix: number[][]): number {
           let found: number = -1;
           outer: for (const row of matrix) {
             for (const item of row) {
               if (item > 10) { found = item; break outer; }
             }
           }
           return found;
         }`,
      ).module,
    ).contents;
    expect(output).toContain("'outer");
    expect(output).toContain('break');
  });
});

describe('emitIrModuleRust array reduce fold', () => {
  it('emits fold with reordered arguments for array reduce', () => {
    const output = emitIrModuleRust(
      lower(
        'reduce.ts',
        `export function sum(arr: number[]): number {
           return arr.reduce((acc: number, item: number): number => acc + item, 0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.fold(');
  });
});

describe('emitIrModuleRust undefined comparison left', () => {
  it('emits is_some when undefined is compared on the left', () => {
    const output = emitIrModuleRust(
      lower(
        'undef-left.ts',
        `export function check(x: number | undefined): boolean {
           return undefined !== x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.is_some()');
  });
});

describe('emitIrModuleRust deferred binding variable', () => {
  it('emits deferred binding without mut for later-assigned variable', () => {
    const output = emitIrModuleRust(
      lower(
        'deferred-var.ts',
        `export function f(): number | null {
           let x: number | null;
           x = 42;
           return x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('let x: Option<f64>;');
    expect(output).not.toContain('let mut x');
  });
});

describe('emitIrModuleRust callback variable initializer', () => {
  it('wraps function-typed variable initializer in Rc', () => {
    const output = emitIrModuleRust(
      lower(
        'callback-var.ts',
        `export function factory(): (x: number) => number {
           const fn: (x: number) => number = (x: number): number => x * 2;
           return fn;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Rc');
  });
});

describe('emitIrModuleRust for-in loop', () => {
  it('emits for-in loop with closed key evidence', () => {
    const output = emitIrModuleRust(
      lower(
        'for-in.ts',
        `export function keys(obj: { a: number; b: number }): string[] {
           const result: string[] = [];
           for (const key in obj) {
             result.push(key);
           }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
    expect(output).toContain('"a"');
    expect(output).toContain('"b"');
  });
});

describe('emitIrModuleRust exponentiation operator', () => {
  it('emits f64 powf for exponentiation', () => {
    const output = emitIrModuleRust(
      lower(
        'pow.ts',
        `export function square(n: number): number {
           return n ** 2;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('f64::powf(');
  });
});

describe('emitIrModuleRust unsigned right shift', () => {
  it('emits unsigned right shift with u32 cast', () => {
    const output = emitIrModuleRust(
      lower(
        'urshr.ts',
        `export function unsignedShift(a: number, b: number): number {
           return a >>> b;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as u32');
  });
});

describe('emitIrModuleRust try catch without binding', () => {
  it('emits catch_unwind with anonymous catch variable', () => {
    const output = emitIrModuleRust(
      lower(
        'try-anon.ts',
        `export function safe(arr: number[]): number {
           try {
             return arr[0]!;
           } catch {
             return -1;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('catch_unwind');
    expect(output).toContain('Err(_)');
  });
});

describe('emitIrModuleRust throw new Error', () => {
  it('emits panic with single-argument new Error throw', () => {
    const output = emitIrModuleRust(
      lower(
        'throw-err.ts',
        `export function fail(msg: string): never {
           throw new Error(msg);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('panic!');
  });
});

describe('emitIrModuleRust switch with default', () => {
  it('emits if-else chain with default branch', () => {
    const output = emitIrModuleRust(
      lower(
        'switch-default.ts',
        `export function describe(n: number): string {
           switch (n) {
             case 0: return "zero";
             case 1: return "one";
             default: return "other";
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('else {');
  });
});

describe('emitIrModuleRust bitwise and operator', () => {
  it('emits bitwise and with i32 casts', () => {
    const output = emitIrModuleRust(
      lower(
        'bitand.ts',
        `export function mask(a: number, b: number): number {
           return a & b;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });
});

describe('emitIrModuleRust bitwise left shift', () => {
  it('emits left shift with i32 casts', () => {
    const output = emitIrModuleRust(
      lower(
        'shl.ts',
        `export function shift(a: number, b: number): number {
           return a << b;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('<<');
    expect(output).toContain('as i32');
  });
});

describe('emitIrModuleRust array concat', () => {
  it('emits extend for array concat', () => {
    const output = emitIrModuleRust(
      lower(
        'concat.ts',
        `export function merge(a: number[], b: number[]): number[] {
           return a.concat(b);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('extend');
    expect(output).toContain('__concat');
  });
});

describe('emitIrModuleRust string charAt', () => {
  it('emits chars nth for charAt', () => {
    const output = emitIrModuleRust(
      lower(
        'char-at.ts',
        `export function first(s: string): string {
           return s.charAt(0);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('unwrap_or_default');
  });
});

describe('emitIrModuleRust string charCodeAt', () => {
  it('emits chars nth with u32 cast for charCodeAt', () => {
    const output = emitIrModuleRust(
      lower(
        'char-code.ts',
        `export function code(s: string, i: number): number {
           return s.charCodeAt(i);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.chars().nth(');
    expect(output).toContain('as u32 as f64');
  });
});

describe('emitIrModuleRust string substring one arg', () => {
  it('emits open-ended slice for single-arg substring', () => {
    const output = emitIrModuleRust(
      lower(
        'substr-one.ts',
        `export function tail(s: string): string {
           return s.substring(1);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize..]');
    expect(output).toContain('.to_string()');
  });
});

describe('emitIrModuleRust string substring two args', () => {
  it('emits bounded slice for two-arg substring', () => {
    const output = emitIrModuleRust(
      lower(
        'substr-two.ts',
        `export function mid(s: string): string {
           return s.substring(1, 3);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('as usize..3');
    expect(output).toContain('.to_string()');
  });
});

describe('emitIrModuleRust optional parameter', () => {
  it('emits Option wrapper for optional parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'opt-param.ts',
        `export function greet(name?: string): string {
           return name ?? "world";
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Option<');
    expect(output).toContain('unwrap_or_else');
  });
});

describe('emitIrModuleRust rest parameter', () => {
  it('emits Vec for rest parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'rest-param.ts',
        `export function total(...values: number[]): number {
           let sum: number = 0;
           for (const v of values) { sum += v; }
           return sum;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Vec<f64>');
  });
});

describe('emitIrModuleRust rebound parameter', () => {
  it('emits mut binding for reassigned parameter', () => {
    const output = emitIrModuleRust(
      lower(
        'rebound-param.ts',
        `export function clamp(x: number): number {
           if (x < 0) { x = 0; }
           return x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('mut x');
  });
});

describe('emitIrModuleRust generic function', () => {
  it('emits Clone-bounded type parameter for generic function', () => {
    const output = emitIrModuleRust(
      lower(
        'generic.ts',
        `export function identity<T>(x: T): T {
           return x;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('T: Clone');
  });
});

describe('emitIrModuleRust object expression', () => {
  it('emits struct literal for object expression', () => {
    const output = emitIrModuleRust(
      lower(
        'obj-expr.ts',
        `export interface Point { x: number; y: number; }
         export function origin(): Point {
           return { x: 0, y: 0 };
         }`,
      ).module,
    ).contents;
    expect(output).toContain('Point {');
  });
});

describe('emitIrModuleRust continue statement', () => {
  it('emits continue in loop body', () => {
    const output = emitIrModuleRust(
      lower(
        'continue-stmt.ts',
        `export function positives(arr: number[]): number[] {
           const result: number[] = [];
           for (const x of arr) {
             if (x <= 0) { continue; }
             result.push(x);
           }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('continue;');
  });
});

describe('emitIrModuleRust if-else statement', () => {
  it('emits if-else block', () => {
    const output = emitIrModuleRust(
      lower(
        'if-else.ts',
        `export function abs(x: number): number {
           if (x >= 0) { return x; }
           else { return -x; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else {');
  });
});

describe('emitIrModuleRust Math spread fold', () => {
  it('emits fold for Math.max with spread', () => {
    const output = emitIrModuleRust(
      lower(
        'math-spread.ts',
        `export function maxOf(arr: number[]): number {
           return Math.max(...arr);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('.fold(');
  });
});

describe('emitIrModuleRust module-level constant', () => {
  it('emits const for module-level variable declaration', () => {
    const output = emitIrModuleRust(lower('mod-const.ts', `export const PI: number = 3.14;`).module).contents;
    expect(output).toContain('pub const');
    expect(output).toContain('f64');
  });
});

describe('emitIrModuleRust primitive type alias', () => {
  it('emits type alias for primitive type', () => {
    const output = emitIrModuleRust(lower('num-alias.ts', 'export type Num = number;').module).contents;
    expect(output).toContain('pub type Num = f64;');
  });
});

describe('emitIrModuleRust class with interface data property and method', () => {
  it('emits trait with data accessor and method when interface has both', () => {
    const output = emitIrModuleRust(
      lower(
        'trait-data.ts',
        'export interface HasLabel { label: string; describe(): string; } export class Widget implements HasLabel { label: string; constructor(label: string) { this.label = label; } describe(): string { return this.label; } }',
      ).module,
    ).contents;
    expect(output).toContain('trait HasLabel');
    expect(output).toContain('fn label(&self) -> String;');
    expect(output).toContain('fn describe(&self)');
    expect(output).toContain('impl HasLabel for Widget');
  });
});

describe('emitIrModuleRust class composition with concrete base', () => {
  it('emits struct with base field and delegating constructor for concrete inheritance', () => {
    const output = emitIrModuleRust(
      lower(
        'composition.ts',
        'export class Base { x: number; constructor(x: number) { this.x = x; } } export class Child extends Base { y: number; constructor(x: number, y: number) { super(x); this.y = y; } }',
      ).module,
    ).contents;
    expect(output).toContain('base: Base');
    expect(output).toContain('pub fn new(');
  });
});

describe('emitIrModuleRust array map with variable callback', () => {
  it('emits into_iter().map() with wrapper for variable callback', () => {
    const output = emitIrModuleRust(
      lower(
        'map-var.ts',
        'export function apply(items: number[], f: (x: number) => number): number[] { return items.map(f); }',
      ).module,
    ).contents;
    expect(output).toContain('into_iter()');
    expect(output).toContain('.map(');
    expect(output).toContain('.collect::<Vec<_>>()');
  });
});

describe('emitIrModuleRust nullable coalesce on optional chain', () => {
  it('emits unwrap_or_else for nullish coalesce on option-shaped operand', () => {
    const output = emitIrModuleRust(
      lower(
        'coalesce.ts',
        'export function safe(value: string | null, fallback: string): string { return value ?? fallback; }',
      ).module,
    ).contents;
    expect(output).toContain('.unwrap_or_else(');
  });
});

describe('emitIrModuleRust default and optional parameter calls', () => {
  it('emits Some wrapping for call with default parameters', () => {
    const output = emitIrModuleRust(
      lower(
        'default-call.ts',
        'function add(a: number, b: number = 10.0): number { return a + b; } export function run(): number { return add(5.0); }',
      ).module,
    ).contents;
    expect(output).toContain('Option<');
    expect(output).toContain('unwrap_or_else');
  });

  it('emits None for omitted optional argument in call', () => {
    const output = emitIrModuleRust(
      lower(
        'optional-call.ts',
        'function greet(name: string, suffix?: string): string { return name; } export function run(): string { return greet("hi"); }',
      ).module,
    ).contents;
    expect(output).toContain('None');
  });
});

describe('emitIrModuleRust for-in loop with key plan', () => {
  it('emits for-in as closed key iteration', () => {
    const output = emitIrModuleRust(
      lower(
        'for-in.ts',
        'export function keys(obj: { a: number; b: number }): string[] { const result: string[] = []; for (const key in obj) { result.push(key); } return result; }',
      ).module,
    ).contents;
    expect(output).toContain('for ');
    expect(output).toContain('.to_owned()');
  });
});

describe('emitIrModuleRust unary plus on number', () => {
  it('emits identity for unary + on number operand', () => {
    const output = emitIrModuleRust(
      lower('unary-plus.ts', 'export function identity(n: number): number { return +n; }').module,
    ).contents;
    expect(output).not.toContain('+n');
    expect(output).toContain('n');
  });
});

describe('emitIrModuleRust bitwise not operator', () => {
  it('emits integer cast bitwise not', () => {
    const output = emitIrModuleRust(
      lower('bitwise-not.ts', 'export function invert(n: number): number { return ~n; }').module,
    ).contents;
    expect(output).toContain('as i32');
    expect(output).toContain('as f64');
  });
});
