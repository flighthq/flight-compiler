import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  collectCppRuntimeIncludeDirectories,
  createCppSyntaxOnlyArguments,
  findCppCompilerToolchain,
} from './cppToolchain.js';
import { resolveDependency } from './dependencyLock.js';

// Does the structural-assertion emission actually compile?
//
// A structural assertion is the one emission whose validity is decided by a trait the RUNTIME owns:
// `structural_ref_cast` accepts a conversion when the target's subject is the source's own subject, when
// the target is a readonly partial row, or when the generated key table proves the widening. A unit test
// can only read the text this emitter produces for those cases, so without a compile the whole lane is
// unverified -- and the widening case is exactly the one whose text cannot settle the question.
//
// The runtime reaches its generated table itself, through `__has_include`, so the compile needs the
// runtime's generated include directory on the search path and the emitted header needs no include of its
// own. A toolchain that is not installed, or a runtime that is not rehydrated, is reported and skipped
// rather than failed, exactly as the emitted-source lane does.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
const fixture = 'structuralAssertionOwner';
const refusalFixture = 'structuralAssertionOwnerUnproven';
const runtime = resolveDependency(root, 'flight-cpp');
const includeDirectories = runtime === undefined ? [] : collectCppRuntimeIncludeDirectories(runtime.directory);
const toolchain = findCppCompilerToolchain();
const compilable = toolchain !== undefined && includeDirectories.length > 0;

describe('structural assertion emission', () => {
  it.skipIf(!compilable)('compiles the fixture whose owner answers every member its asserted row reads', () => {
    if (toolchain === undefined) throw new Error('the C++ toolchain was not found');
    const emitted = path.join(goldenDirectory, fixture, 'cpp');
    const header = path.join(emitted, 'structural_assertion_owner.hpp');
    const arguments_ = createCppSyntaxOnlyArguments(toolchain, header, [
      ...includeDirectories,
      path.join(goldenDirectory, 'support', 'cpp'),
    ]);

    expect(() =>
      execFileSync(toolchain.command, arguments_, { cwd: emitted, encoding: 'utf8', stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('pins the missing-cell case as a refusal rather than an emission to compile', () => {
    const directory = path.join(goldenDirectory, refusalFixture);

    expect(existsSync(path.join(directory, 'cpp'))).toBe(false);
    expect(readFileSync(path.join(directory, 'cpp.error.txt'), 'utf8')).toContain(
      'reads extra, which the source type does not declare',
    );
  });
});
