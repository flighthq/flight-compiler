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
// own. Naming that header from the emitter does not work: it would be included before `structural_ref.hpp`
// declares the names it provides, and `#pragma once` makes the nested include a no-op. A toolchain that is not installed, or a runtime that is not rehydrated, is reported and skipped
// rather than failed, exactly as the emitted-source lane does.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
// The fixtures that exercise an assertion whose validity the runtime decides, and the header each one
// emits. A fixture that pins a refusal instead has no header to compile and is asserted here by what it
// pinned; the emitted-source lane compiles everything else.
const compiledFixtures: readonly Readonly<{ fixture: string; header: string }>[] = [
  { fixture: 'contextualUnionRemap', header: 'contextual_union_remap.hpp' },
  { fixture: 'structuralAssertionOwner', header: 'structural_assertion_owner.hpp' },
  { fixture: 'unionMemberAliasAssertion', header: 'union_member_alias_assertion.hpp' },
  { fixture: 'importedAmbientAlias', header: 'imported_ambient_alias.hpp' },
  { fixture: 'partialNamedShape', header: 'partial_named_shape.hpp' },
  { fixture: 'intersectionMergedShape', header: 'intersection_merged_shape.hpp' },
  { fixture: 'collectionArgumentMatchingDomain', header: 'collection_argument_matching_domain.hpp' },
  { fixture: 'assertionClassHeritageRecovery', header: 'assertion_class_heritage_recovery.hpp' },
  { fixture: 'assertionClassOneValueNarrowing', header: 'assertion_class_one_value_narrowing.hpp' },
  { fixture: 'closedKeyWriteDispatch', header: 'closed_key_write_dispatch.hpp' },
];
const refusalFixture = 'structuralAssertionOwnerUnproven';
const runtime = resolveDependency(root, 'flight-cpp');
const includeDirectories = runtime === undefined ? [] : collectCppRuntimeIncludeDirectories(runtime.directory);
const toolchain = findCppCompilerToolchain();
const compilable = toolchain !== undefined && includeDirectories.length > 0;

describe('structural assertion emission', () => {
  it.skipIf(!compilable).each(compiledFixtures)('compiles the emitted assertion of $fixture', ({ fixture, header }) => {
    if (toolchain === undefined) throw new Error('the C++ toolchain was not found');
    const emitted = path.join(goldenDirectory, fixture, 'cpp');
    const arguments_ = createCppSyntaxOnlyArguments(toolchain, path.join(emitted, header), [
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
