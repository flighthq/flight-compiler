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
    expect(source).toContain('toUpperCase(): string;');
    expect(source).toContain('interface WeakMap<K extends object, V>');
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
