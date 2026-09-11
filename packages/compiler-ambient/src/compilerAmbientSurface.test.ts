import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createCompilerAmbientSurfaceSource, getCompilerAmbientSurfaceFileName } from './compilerAmbientSurface.js';

describe('createCompilerAmbientSurfaceSource', () => {
  it('parses as TypeScript declarations, since a checker is what reads it', () => {
    const source = ts.createSourceFile(
      '/surface.d.ts',
      createCompilerAmbientSurfaceSource(),
      ts.ScriptTarget.Latest,
      true,
    );

    // A surface that does not parse would silently type nothing, which reads exactly like no surface.
    // The parse diagnostics are internal, so the check is that every declaration survived.
    expect(source.statements.some((statement) => statement.kind === ts.SyntaxKind.Unknown)).toBe(false);
    expect(source.statements.length).toBeGreaterThan(20);
  });

  it('declares the members the operator layer depends on', () => {
    const source = createCompilerAmbientSurfaceSource();

    // These are the members whose absence collapsed ordinary expressions to unknown.
    expect(source).toContain('map<U>(project: (value: T, index: number) => U): U[];');
    expect(source).toContain('join(separator?: string): string;');
    expect(source).toContain('indexOf(search: string, position?: number): number;');
    expect(source).toContain('asin(value: number): number;');
    expect(source).toContain('exp(value: number): number;');
    expect(source).toContain('log(value: number): number;');
    expect(source).toContain('for(key: string): symbol;');
    expect(source).toContain('keys(value: object): string[];');
    expect(source).toContain('stringify(value: unknown, replacer?: unknown, space?: number | string): string;');
    expect(source).toContain('toUpperCase(): string;');
    expect(source).toContain('interface WeakMap<K extends object, V>');
  });

  it('declares the portable binary, text, regexp, URL, and internationalization surfaces', () => {
    const source = createCompilerAmbientSurfaceSource();

    expect(source).toContain('new (byteLength: number): ArrayBuffer;');
    expect(source).toContain('readonly byteLength: number;');
    expect(source).toContain('getFloat64(byteOffset: number, littleEndian?: boolean): number;');
    expect(source).toContain('decode(input?: Uint8Array): string;');
    expect(source).toContain('exec(value: string): RegExpExecArray | null;');
    expect(source).toContain('new (pattern: string | RegExp, flags?: string): RegExp;');
    expect(source).toContain('declare function parseInt(value: string, radix?: number): number;');
    expect(source).toContain('new (url: string, base?: string | URL): URL;');
    expect(source).toContain('declare namespace Intl');
    expect(source).toContain('class RelativeTimeFormat');
  });

  it('declares the typed array index signatures the type-directed operator layer requires', () => {
    const source = createCompilerAmbientSurfaceSource();

    expect(source).toContain('interface Uint8Array');
    expect(source).toContain('interface Int8Array');
    expect(source).toContain('interface Float32Array');
    expect(source).toContain('interface Uint8ClampedArray');
    expect(source).toContain('[index: number]: number;');
    expect(source).toContain('subarray(begin?: number, end?: number): Uint8Array;');
    expect(source).toContain('slice(begin?: number, end?: number): Float32Array;');
    expect(source).toContain('readonly buffer: ArrayBuffer;');
    expect(source).toContain('new (buffer: ArrayBuffer): Uint16Array;');
  });

  it('returns the same text every call, because it is analysis input rather than state', () => {
    expect(createCompilerAmbientSurfaceSource()).toBe(createCompilerAmbientSurfaceSource());
  });
});

describe('getCompilerAmbientSurfaceFileName', () => {
  it('names the file the surface is presented as, which is the boundary readers check against', () => {
    // A node reached through the surface does not belong to the module being lowered, and every
    // reader that walks back to a declaration compares against this name to tell.
    expect(getCompilerAmbientSurfaceFileName()).toMatch(/\.d\.ts$/u);
    expect(getCompilerAmbientSurfaceFileName()).toBe(getCompilerAmbientSurfaceFileName());
  });
});
