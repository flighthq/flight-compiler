import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { compileCompilerCommandLineRequest } from './compilerCommandLine.js';

// The edge, and the only place in the compiler that reads a directory or writes a file on its own.
// Everything above it decides; this reads, writes, and reports an exit code. It is a function rather
// than work at import so that importing the package still does nothing, which is the rule everywhere
// else too.
export function compileCompilerCommandLineDirectory(argv: readonly string[]): number {
  return compileCompilerCommandLineRequest(
    { argv },
    {
      // A directory that is not there reads as nothing to compile rather than as a stack trace: a
      // mistyped path is an ordinary thing to do and the report already says what it found.
      listSourceFiles: (directory) =>
        (existsSync(directory) ? readdirSync(directory, { recursive: true, withFileTypes: true }) : [])
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
          .sort((left, right) => (left.moduleName < right.moduleName ? -1 : 1)),
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
