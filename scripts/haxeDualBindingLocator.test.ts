import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHaxeDualBindingCppSymbolLocator,
  createHaxeDualBindingJavaScriptExportLocator,
} from './haxeDualBindingLocator.js';

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('createHaxeDualBindingJavaScriptExportLocator', () => {
  it('answers present only for exports the loaded module really has', async () => {
    const directory = temporaryDirectory('haxe-dual-binding-js-');
    writeFileSync(
      path.join(directory, 'tiny.mjs'),
      'export function draw() {}\nexport const Surface = { name: "Surface" };\nexport const Undefined = undefined;\n',
    );

    const resolve = await createHaxeDualBindingJavaScriptExportLocator(['./tiny.mjs'], {
      moduleDirectories: [directory],
    });

    expect(resolve({ exportedName: 'draw', specifier: './tiny.mjs' })).toEqual({ status: 'present' });
    expect(resolve({ exportedName: 'Surface', specifier: './tiny.mjs' })).toEqual({ status: 'present' });
    expect(resolve({ exportedName: 'Undefined', specifier: './tiny.mjs' })).toEqual({
      detail: './tiny.mjs exports no Undefined',
      status: 'absent',
    });
    expect(resolve({ exportedName: 'absent', specifier: './tiny.mjs' })).toEqual({
      detail: './tiny.mjs exports no absent',
      status: 'absent',
    });
  });

  it('answers absent for a module that cannot be loaded, and unchecked for one it was never asked for', async () => {
    const directory = temporaryDirectory('haxe-dual-binding-js-');
    writeFileSync(path.join(directory, 'broken.mjs'), 'throw new Error("this module cannot load");\n');

    const resolve = await createHaxeDualBindingJavaScriptExportLocator(['./broken.mjs'], {
      moduleDirectories: [directory],
    });

    const broken = resolve({ exportedName: 'draw', specifier: './broken.mjs' });
    expect(broken.status).toBe('absent');
    expect(broken).toHaveProperty('detail', expect.stringContaining('this module cannot load'));
    expect(resolve({ exportedName: 'draw', specifier: './never-asked.mjs' })).toEqual({
      detail:
        './never-asked.mjs was not among the specifiers the locator was asked to load, so its export was never asked for',
      status: 'skipped',
    });
  });
});

describe('createHaxeDualBindingCppSymbolLocator', () => {
  it('derives the reference from the carrier, so a declared but undefined callable answers absent', () => {
    const directory = temporaryDirectory('haxe-dual-binding-cpp-');
    writeFileSync(
      path.join(directory, 'tiny.hpp'),
      `#pragma once
namespace flight::dual {
struct Surface { int width = 0; };
void draw(int value);
void neverDefined(int value);
}
`,
    );
    writeFileSync(
      path.join(directory, 'tiny.cpp'),
      '#include "tiny.hpp"\nnamespace flight::dual { void draw(int value) { (void)value; } }\n',
    );
    const resolve = createHaxeDualBindingCppSymbolLocator({
      includeDirectories: [directory],
      slicePaths: [path.join(directory, 'tiny.cpp')],
    });

    expect(
      resolve({ carrier: 'interface', include: 'tiny.hpp', namespace: 'flight::dual', spelling: 'Surface' }),
    ).toEqual({ status: 'present' });
    expect(resolve({ carrier: 'class', include: 'tiny.hpp', namespace: 'flight::dual', spelling: 'Surface' })).toEqual({
      status: 'present',
    });
    expect(resolve({ carrier: 'function', include: 'tiny.hpp', namespace: 'flight::dual', spelling: 'draw' })).toEqual({
      status: 'present',
    });

    const undefinedSymbol = resolve({
      carrier: 'function',
      include: 'tiny.hpp',
      namespace: 'flight::dual',
      spelling: 'neverDefined',
    });
    expect(undefinedSymbol.status).toBe('absent');
    expect(undefinedSymbol).toHaveProperty('detail', expect.stringContaining('neverDefined'));

    const undeclared = resolve({
      carrier: 'interface',
      include: 'tiny.hpp',
      namespace: 'flight::dual',
      spelling: 'Missing',
    });
    expect(undeclared.status).toBe('absent');
    expect(undeclared).toHaveProperty('detail', expect.stringContaining('Missing'));
  });

  it('spells a global symbol without a namespace and reports it unchecked when there is no compiler', () => {
    const directory = temporaryDirectory('haxe-dual-binding-cpp-');
    writeFileSync(path.join(directory, 'global.hpp'), 'void globalDraw(int value);\n');
    writeFileSync(
      path.join(directory, 'global.cpp'),
      '#include "global.hpp"\nvoid globalDraw(int value) { (void)value; }\n',
    );
    const resolve = createHaxeDualBindingCppSymbolLocator({
      includeDirectories: [directory],
      slicePaths: [path.join(directory, 'global.cpp')],
    });
    const skipped = createHaxeDualBindingCppSymbolLocator({ compiler: null, includeDirectories: [] });

    expect(resolve({ carrier: 'function', include: 'global.hpp', namespace: '', spelling: 'globalDraw' })).toEqual({
      status: 'present',
    });
    expect(
      skipped({ carrier: 'interface', include: 'tiny.hpp', namespace: 'flight::dual', spelling: 'Surface' }),
    ).toEqual({
      detail: 'no C++ compiler is installed, so no header or slice could be asked for this symbol',
      status: 'skipped',
    });
  });
});
