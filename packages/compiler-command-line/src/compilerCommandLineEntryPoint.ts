#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { isCompilerInventoryFailure, readGitCommit } from '../../compiler-inventory/src/index.js';
import type {
  CompilerCommandLineSource,
  WorkspaceSource,
  WorkspaceSourceEntry,
} from '../../compiler-types/src/index.js';
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

// The check edge. It hands the run the workspace to read and writes only what the caller asked for: the
// report file when `--report` names one. There is no output-directory capability here at all, so a check
// cannot write generated sources however it is invoked.
export function validateCompilerCommandLineCheckDirectory(argv: readonly string[]): number {
  return validateCompilerCommandLineCheckRequest(
    { argv },
    {
      readBaseline: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      // The revision is the one fact here that needs another process, so it is read where processes are
      // read and nowhere else. A workspace that is not a checkout is an ordinary thing to check -- the
      // consumer smoke makes one -- so the failure is an absent revision rather than a failed run.
      readUpstreamRevision: (workspace) => {
        try {
          return readGitCommit(workspace);
        } catch (error) {
          if (!isCompilerInventoryFailure(error)) throw error;
          return undefined;
        }
      },
      workspaceSource: fileSystemWorkspaceSource(),
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

// The inventory reads a workspace through a four-operation capability, and its own filesystem
// implementation is not exported from that package's barrel, so the edge that owns filesystem access in
// this package supplies the same four operations. It is the reader's shape, not a second reading of the
// workspace: which fields mean what stays in the inventory.
function fileSystemWorkspaceSource(): WorkspaceSource {
  return {
    isDirectory: (candidate) => existsSync(candidate) && statSync(candidate).isDirectory(),
    isFile: (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    listDirectory: (directory): readonly WorkspaceSourceEntry[] =>
      readdirSync(directory, { withFileTypes: true }).map((entry) => ({
        isDirectory: entry.isDirectory(),
        name: entry.name,
      })),
    readTextFile: (file) => readFileSync(file, 'utf8'),
  };
}

const commandLineCheckCommand = 'check';

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = compileCompilerCommandLineDirectory(process.argv.slice(2));
}
