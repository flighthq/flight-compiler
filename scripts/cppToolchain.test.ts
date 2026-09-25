import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectCppRuntimeIncludeDirectories,
  createCppCompilerToolchain,
  createCppExecutableArguments,
  createCppSyntaxOnlyArguments,
  findCppCompilerToolchain,
  getCppExecutableName,
} from './cppToolchain.js';

describe('C++ toolchain invocation', () => {
  it('renders GNU syntax-only and executable builds', () => {
    const toolchain = createCppCompilerToolchain('/opt/bin/clang++');

    expect(createCppSyntaxOnlyArguments(toolchain, 'fixture.hpp', ['/runtime', '/support'])).toEqual([
      '-std=c++20',
      '-fsyntax-only',
      '-pthread',
      '-I',
      '/runtime',
      '-I',
      '/support',
      '-x',
      'c++-header',
      'fixture.hpp',
    ]);
    expect(createCppExecutableArguments(toolchain, 'main.cpp', 'oracle', ['/runtime'])).toEqual([
      '-std=c++20',
      '-pthread',
      '-I',
      '/runtime',
      '-o',
      'oracle',
      'main.cpp',
    ]);
    expect(getCppExecutableName(toolchain, 'oracle')).toBe('oracle');
  });

  it('renders MSVC syntax-only and executable builds', () => {
    const toolchain = createCppCompilerToolchain('C:\\toolchain\\cl.exe');

    expect(createCppSyntaxOnlyArguments(toolchain, 'fixture.hpp', ['C:\\runtime'])).toEqual([
      '/nologo',
      '/std:c++20',
      '/permissive-',
      '/EHsc',
      '/Zs',
      '/TP',
      '/IC:\\runtime',
      'fixture.hpp',
    ]);
    expect(createCppExecutableArguments(toolchain, 'main.cpp', 'oracle.exe', ['C:\\runtime'])).toContain(
      '/Fe:oracle.exe',
    );
    expect(getCppExecutableName(toolchain, 'oracle')).toBe('oracle.exe');
  });

  it('honors an explicit family and requires configured compilers', () => {
    const resolved = findCppCompilerToolchain(
      { FLIGHT_CPP_CXX: 'clang-cl', FLIGHT_CPP_CXX_FAMILY: 'msvc' },
      'linux',
      ({ command }) => command === 'clang-cl',
    );

    expect(resolved).toEqual({ command: 'clang-cl', family: 'msvc' });
    expect(() => findCppCompilerToolchain({ FLIGHT_CPP_REQUIRE_CXX: '1' }, 'linux', () => false)).toThrow(
      'required C++ compiler <auto> is not available',
    );
    expect(() => findCppCompilerToolchain({ FLIGHT_CPP_CXX_FAMILY: 'unknown' }, 'linux', () => false)).toThrow(
      'FLIGHT_CPP_CXX_FAMILY must be gnu or msvc',
    );
  });
});

describe('collectCppRuntimeIncludeDirectories', () => {
  it('reports the runtime headers and the generated SDK glue that exists beside them', () => {
    const runtime = mkdtempSync(path.join(tmpdir(), 'flight-cpp-runtime-'));
    try {
      expect(collectCppRuntimeIncludeDirectories(runtime)).toEqual([]);

      mkdirSync(path.join(runtime, 'include'));
      expect(collectCppRuntimeIncludeDirectories(runtime)).toEqual([path.join(runtime, 'include')]);

      // The generated table proves a structural widening and binds an owner's members. It is a build
      // output, so a checkout that materialized the runtime without it is still a checkout to compile
      // against -- the emitted header names neither, and the runtime reaches the table itself.
      mkdirSync(path.join(runtime, 'generated', 'include'), { recursive: true });
      expect(collectCppRuntimeIncludeDirectories(runtime)).toEqual([
        path.join(runtime, 'include'),
        path.join(runtime, 'generated', 'include'),
      ]);
    } finally {
      rmSync(runtime, { force: true, recursive: true });
    }
  });
});
