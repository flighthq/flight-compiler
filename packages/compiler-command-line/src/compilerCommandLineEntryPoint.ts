#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type { CompilerCommandLineSource, CompilerCommandLineWorkspacePackage } from '../../compiler-types/src/index.js';
import { validateCompilerCommandLineCheckRequest, compileCompilerCommandLineRequest } from './compilerCommandLine.js';

// The edge, and the only place in the compiler that reads a directory or writes a file on its own.
// Everything above it decides; this reads, writes, and reports an exit code. It is a function rather
// than work at import so that importing the package still does nothing, which is the rule everywhere
// else too.
export function compileCompilerCommandLineDirectory(argv: readonly string[]): number {
  return argv[0] === commandLineCheckCommand
    ? validateCompilerCommandLineCheckDirectory(argv.slice(1))
    : compileCompilerCommandLineRequest(
        { argv },
        {
          listSourceFiles: listTypeScriptSources,
          write: (text) => process.stdout.write(text),
          writeError: (text) => process.stderr.write(text),
          writeOutputFile: (directory, relativePath, contents) => {
            const target = path.join(directory, relativePath);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, contents);
          },
        },
      ).exitCode;
}

// The check edge. It reads what a check needs to read and writes only what the caller asked for: the
// report file when `--report` names one. There is no output-directory capability here at all, so a check
// cannot write generated sources however it is invoked.
export function validateCompilerCommandLineCheckDirectory(argv: readonly string[]): number {
  return validateCompilerCommandLineCheckRequest(
    { argv },
    {
      listSourceFiles: listTypeScriptSources,
      listWorkspacePackages: listWorkspacePackages,
      readBaseline: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      write: (text) => process.stdout.write(text),
      writeError: (text) => process.stderr.write(text),
      writeReportFile: (file, contents) => {
        mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        writeFileSync(file, contents);
      },
    },
  ).exitCode;
}

// A directory that is not there reads as nothing to compile rather than as a stack trace: a mistyped path
// is an ordinary thing to do and the report already says what it found.
function listTypeScriptSources(directory: string): readonly CompilerCommandLineSource[] {
  return (existsSync(directory) ? readdirSync(directory, { recursive: true, withFileTypes: true }) : [])
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => {
      const sourcePath = path.join(entry.parentPath, entry.name);
      return {
        contents: readFileSync(sourcePath, 'utf8'),
        moduleName: normalizePathPortable(path.relative(directory, sourcePath)),
        sourcePath,
      };
    })
    .sort((left, right) => (left.moduleName < right.moduleName ? -1 : 1));
}

// Every package under `<workspace>/packages`, or the workspace itself when it has no packages directory.
// Nothing declares an environment mark yet -- the eligibility lane that will read them is not landed -- so
// every package is unmarked and the default scope is the whole workspace. A package with no manifest is
// still a package: its directory name is what the report can call it.
function listWorkspacePackages(workspaceDirectory: string): readonly CompilerCommandLineWorkspacePackage[] {
  const packagesDirectory = path.join(workspaceDirectory, 'packages');
  if (!existsSync(packagesDirectory)) {
    return [{ environments: [], name: path.basename(workspaceDirectory), root: workspaceDirectory }];
  }
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const root = path.join(packagesDirectory, entry.name);
      const manifest = path.join(root, 'package.json');
      return {
        environments: [],
        name: existsSync(manifest) ? readPackageManifestName(manifest, entry.name) : entry.name,
        root,
      };
    })
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

function readPackageManifestName(manifest: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : fallback;
  } catch {
    // A manifest that cannot be read names nothing; the directory still does.
    return fallback;
  }
}

const commandLineCheckCommand = 'check';

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = compileCompilerCommandLineDirectory(process.argv.slice(2));
}
