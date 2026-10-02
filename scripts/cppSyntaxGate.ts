import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectCppRuntimeIncludeDirectories,
  createCppSyntaxOnlyArguments,
  findCppCompilerToolchain,
} from './cppToolchain.js';
import { resolveDependency } from './dependencyLock.js';

// Handing emitted C++ to the target's own compiler, for tests that need to know whether what the
// backend wrote is C++ at all. A passing emission is not that answer: a presence test can be chosen
// for the wrong carrier and still read as plausible text, which is how two regressions reached main
// with every test green. This gate is the missing question.
//
// It is deliberately narrow. The compiler is the target's, not the repository's, so the gate reports
// `available: false` rather than failing when no toolchain or no pinned runtime is present -- a missing
// toolchain is an environment fact, and turning it into a red test would punish every machine that has
// not run `npm run rehydrate`. The same reason makes the answer a value rather than a throw: a caller
// decides whether a rejection is its assertion or its skip.
export interface CppSyntaxGateResult {
  readonly diagnostic: string;
  readonly ok: boolean;
}

export interface CppSyntaxGate {
  // False when the toolchain or the pinned runtime includes are absent, which is the caller's cue to
  // skip rather than to assert.
  readonly available: boolean;
  checkCppSourceSyntax(contents: string, label: string): CppSyntaxGateResult;
}

export function createCppSyntaxGate(repositoryRoot: string): CppSyntaxGate {
  const toolchain = findCppCompilerToolchain();
  const includeDirectories = collectCppRuntimeIncludeDirectories(
    resolveDependency(repositoryRoot, 'flight-cpp').directory,
  );
  const available = toolchain !== undefined && includeDirectories.length > 0;
  if (!toolchain || !available) {
    return {
      available: false,
      checkCppSourceSyntax() {
        return { diagnostic: 'the C++ toolchain or the pinned runtime is not available', ok: false };
      },
    };
  }
  return {
    available: true,
    checkCppSourceSyntax(contents: string, label: string): CppSyntaxGateResult {
      // One directory per check, so two checks cannot see each other's headers and the emitted file keeps
      // the name it declares. The directory is removed whatever the compiler answers.
      const directory = mkdtempSync(path.join(tmpdir(), 'flight-cpp-syntax-gate-'));
      const header = path.join(directory, `${label.replaceAll(/[^A-Za-z0-9_]/gu, '_') || 'emitted'}.hpp`);
      try {
        writeFileSync(header, contents, 'utf8');
        execFileSync(
          toolchain.command,
          createCppSyntaxOnlyArguments(toolchain, header, [...includeDirectories, directory]),
          { cwd: directory, encoding: 'utf8', stdio: 'pipe' },
        );
        return { diagnostic: '', ok: true };
      } catch (error) {
        return {
          diagnostic: String((error as { stderr?: string }).stderr ?? error),
          ok: false,
        };
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  };
}
