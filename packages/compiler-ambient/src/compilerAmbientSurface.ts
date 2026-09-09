// The ambient surface generated code may assume, described in TypeScript so the analysis checker can
// type ordinary source against it.
//
// This is the other projection of what the backends' runtime binding tables already name. A table
// says `Promise` becomes `FlightTask`; this says what `Promise` has on it. Without the second half
// the checker cannot type a callback parameter, cannot say what `join` returns, and every operator
// over those values collapses to unknown — which is the difference between compiling a library whose
// every type is written out and compiling ordinary application code.
//
// Authored here rather than taken from a published library definition: the repository does not carry
// third-party definition files, and a surface this compiler must bind member by member is better
// stated deliberately than inherited wholesale. It is intentionally smaller than the language's real
// library — a member absent here is a member the compiler has not decided how to lower.
export function createCompilerAmbientSurfaceSource(): string {
  return ambientSurfaceSource;
}

// The file the surface is presented to the checker as. A node reached through it does not belong to
// the module being lowered, and every reader that walks back to a declaration has to be able to tell.

// The file the surface is presented to the checker as. A node reached through it does not belong to
// the module being lowered, and every reader that walks back to a declaration compares against this
// to tell.
export function getCompilerAmbientSurfaceFileName(): string {
  return ambientSurfaceFileName;
}

const ambientSurfaceSource = `
interface Object {}
interface Function {}
interface IArguments {}
interface RegExp {}

interface Boolean {}

interface Number {
  toFixed(digits?: number): string;
  toString(radix?: number): string;
}

interface NumberConstructor {
  readonly EPSILON: number;
  readonly MAX_SAFE_INTEGER: number;
  readonly MIN_SAFE_INTEGER: number;
  isFinite(value: number): boolean;
  isInteger(value: number): boolean;
  isNaN(value: number): boolean;
  parseFloat(value: string): number;
  parseInt(value: string, radix?: number): number;
}
declare var Number: NumberConstructor;

interface String {
  readonly length: number;
  charAt(index: number): string;
  charCodeAt(index: number): number;
  concat(...values: string[]): string;
  endsWith(search: string): boolean;
  includes(search: string): boolean;
  indexOf(search: string): number;
  lastIndexOf(search: string): number;
  padStart(length: number, fill?: string): string;
  repeat(count: number): string;
  replace(search: string, replacement: string): string;
  slice(start?: number, end?: number): string;
  split(separator: string): string[];
  startsWith(search: string): boolean;
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toUpperCase(): string;
  trim(): string;
}

interface StringConstructor {
  fromCharCode(...codes: number[]): string;
}
declare var String: StringConstructor;

interface ReadonlyArray<T> {
  readonly length: number;
  readonly [index: number]: T;
  concat(...values: readonly T[][]): T[];
  every(predicate: (value: T, index: number) => boolean): boolean;
  filter(predicate: (value: T, index: number) => boolean): T[];
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  findIndex(predicate: (value: T, index: number) => boolean): number;
  forEach(visit: (value: T, index: number) => void): void;
  includes(value: T): boolean;
  indexOf(value: T): number;
  join(separator?: string): string;
  lastIndexOf(value: T): number;
  map<U>(project: (value: T, index: number) => U): U[];
  reduce<U>(fold: (accumulated: U, value: T, index: number) => U, initial: U): U;
  slice(start?: number, end?: number): T[];
  some(predicate: (value: T, index: number) => boolean): boolean;
  [Symbol.iterator](): Iterator<T>;
}

interface Array<T> {
  length: number;
  [index: number]: T;
  concat(...values: readonly T[][]): T[];
  every(predicate: (value: T, index: number) => boolean): boolean;
  fill(value: T, start?: number, end?: number): T[];
  filter(predicate: (value: T, index: number) => boolean): T[];
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  findIndex(predicate: (value: T, index: number) => boolean): number;
  forEach(visit: (value: T, index: number) => void): void;
  includes(value: T): boolean;
  indexOf(value: T): number;
  join(separator?: string): string;
  lastIndexOf(value: T): number;
  map<U>(project: (value: T, index: number) => U): U[];
  pop(): T | undefined;
  push(...values: T[]): number;
  reduce<U>(fold: (accumulated: U, value: T, index: number) => U, initial: U): U;
  reverse(): T[];
  shift(): T | undefined;
  slice(start?: number, end?: number): T[];
  some(predicate: (value: T, index: number) => boolean): boolean;
  sort(compare?: (left: T, right: T) => number): T[];
  splice(start: number, count?: number): T[];
  unshift(...values: T[]): number;
  [Symbol.iterator](): Iterator<T>;
}

interface ArrayConstructor {
  new <T>(length?: number): T[];
  isArray(value: unknown): boolean;
  of<T>(...values: T[]): T[];
}
declare var Array: ArrayConstructor;

interface Iterator<T> {
  next(): { done?: boolean; value: T };
}

interface Iterable<T> {
  [Symbol.iterator](): Iterator<T>;
}

interface IterableIterator<T> extends Iterator<T> {
  [Symbol.iterator](): IterableIterator<T>;
}

interface SymbolConstructor {
  readonly iterator: unique symbol;
}
declare var Symbol: SymbolConstructor;

interface Math {
  readonly E: number;
  readonly PI: number;
  abs(value: number): number;
  ceil(value: number): number;
  cos(value: number): number;
  floor(value: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  pow(base: number, exponent: number): number;
  round(value: number): number;
  sign(value: number): number;
  sin(value: number): number;
  sqrt(value: number): number;
  trunc(value: number): number;
}
declare var Math: Math;

interface Error {
  message: string;
  name: string;
}

interface ErrorConstructor {
  new (message?: string): Error;
}
declare var Error: ErrorConstructor;

interface PromiseLike<T> {
  then<U>(onValue: (value: T) => U | PromiseLike<U>, onError?: (error: unknown) => U | PromiseLike<U>): PromiseLike<U>;
}

interface Promise<T> {
  catch(onError: (error: unknown) => T | PromiseLike<T>): Promise<T>;
  finally(onSettled: () => void): Promise<T>;
  then<U>(onValue: (value: T) => U | PromiseLike<U>, onError?: (error: unknown) => U | PromiseLike<U>): Promise<U>;
}

interface PromiseConstructor {
  new <T>(executor: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T>;
  all<T>(tasks: readonly Promise<T>[]): Promise<T[]>;
  reject<T>(error: unknown): Promise<T>;
  resolve<T>(value: T): Promise<T>;
}
declare var Promise: PromiseConstructor;

interface Map<K, V> {
  readonly size: number;
  clear(): void;
  delete(key: K): boolean;
  forEach(visit: (value: V, key: K) => void): void;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): Map<K, V>;
}

interface MapConstructor {
  new <K, V>(entries?: readonly (readonly [K, V])[]): Map<K, V>;
}
declare var Map: MapConstructor;

interface WeakMap<K extends object, V> {
  delete(key: K): boolean;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): WeakMap<K, V>;
}

interface WeakMapConstructor {
  new <K extends object, V>(entries?: readonly (readonly [K, V])[]): WeakMap<K, V>;
}
declare var WeakMap: WeakMapConstructor;

interface Set<T> {
  readonly size: number;
  add(value: T): Set<T>;
  clear(): void;
  delete(value: T): boolean;
  forEach(visit: (value: T) => void): void;
  has(value: T): boolean;
}

interface SetConstructor {
  new <T>(values?: readonly T[]): Set<T>;
}
declare var Set: SetConstructor;

interface Date {
  getDate(): number;
  getDay(): number;
  getFullYear(): number;
  getHours(): number;
  getMilliseconds(): number;
  getMinutes(): number;
  getMonth(): number;
  getSeconds(): number;
  getTime(): number;
  toISOString(): string;
  toString(): string;
}

interface DateConstructor {
  new (): Date;
  new (value: number): Date;
  now(): number;
}
declare var Date: DateConstructor;

interface JSON {
  parse(text: string): unknown;
  stringify(value: unknown): string;
}
declare var JSON: JSON;

interface Console {
  error(...values: unknown[]): void;
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}
declare var console: Console;

// The mapped and conditional type aliases the language provides — \`Partial\`, \`Record\`, \`Pick\` and
// their relatives — are deliberately absent. The backends already recognise them by name as ambient
// references and decide a spelling from that; declaring them here would make the checker resolve
// them to mapped types the neutral model does not carry, and a declaration that mentions one would
// stop lowering. A surface entry is only worth adding once something can lower what it resolves to.
`;

const ambientSurfaceFileName = '/flight-compiler/ambient-surface.d.ts';
