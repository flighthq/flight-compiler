#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
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
          writeOutputManifest: (directory, relativePath, contents) => {
            const target = path.join(directory, relativePath);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, contents);
          },
          writeProgress: (text) => process.stderr.write(text),
        },
      ).exitCode;
}

// Whether this module was the program the machine ran, rather than one it imported.
//
// A packaged bin is a symlink into the installed package, so the path the shell ran is not the path the
// module lives at: comparing them unresolved makes the installed bin a silent no-op -- the guard fails, the
// module body never runs, and the process still exits 0 with no output, which reads as a clean compile. Both
// sides are resolved through their links, and a path that does not exist is not this module.
export function isCompilerCommandLineEntryPoint(invoked: string | undefined, moduleFile: string): boolean {
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(moduleFile);
  } catch {
    return false;
  }
}

// A packaged command lives below the public compiler manifest and, when installed by a target repository,
// below that target's own manifest. Exact package names make this discovery evidence rather than an
// assumption about the current directory. The source-tree sibling keeps development reports attributable
// to the same public package metadata that release stamping updates.
export function readCompilerCommandLineCheckArtifactRevision(
  artifact: string,
  moduleFile: string = fileURLToPath(import.meta.url),
): string | undefined {
  const packageNames = artifactPackageNames.get(artifact);
  if (!packageNames) return undefined;
  const moduleDirectory = path.dirname(path.resolve(moduleFile));
  const manifestPaths: string[] = [];
  for (let directory = moduleDirectory; ; directory = path.dirname(directory)) {
    manifestPaths.push(path.join(directory, 'package.json'));
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  if (artifact === '@flighthq/tool-compiler') {
    manifestPaths.unshift(path.resolve(moduleDirectory, '..', '..', 'tool-compiler', 'package.json'));
  }
  for (const manifestPath of new Set(manifestPaths)) {
    const manifest = readPackageIdentity(manifestPath);
    if (manifest && packageNames.has(manifest.name)) return manifest.version;
  }
  return undefined;
}

// The check edge. It hands the run the workspace to read and writes only what the caller asked for: the
// report file when `--report` names one. There is no output-directory capability here at all, so a check
// cannot write generated sources however it is invoked.
export function validateCompilerCommandLineCheckDirectory(argv: readonly string[]): number {
  return validateCompilerCommandLineCheckRequest(
    { argv },
    {
      readArtifactRevision: (artifact) => readCompilerCommandLineCheckArtifactRevision(artifact),
      readBaseline: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      readBindingProfile: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      // The revision is the one fact here that needs another process, so it is read where processes are
      // read and nowhere else. A workspace that is not a checkout is an ordinary thing to check -- the
      // consumer smoke makes one -- so the failure is an absent revision rather than a failed run.
      readWorkspaceRoots: (workspace) => readDeclaredPackageNames(path.join(workspace, 'package.json')),
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

// The packages a workspace declares as its own dependencies. Names only: whether a package exists, and what
// it means for one to be missing, is the inventory's question. A manifest that is not there, or cannot be
// read, declares nothing -- and a workspace that declares nothing is treated as its own root set.
function readDeclaredPackageNames(manifest: string): readonly string[] {
  if (!existsSync(manifest)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return [];
    const record = parsed as Readonly<Record<string, unknown>>;
    const names = new Set<string>();
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const value = record[key];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const name of Object.keys(value)) names.add(name);
    }
    return [...names].sort(compareTextCodeUnits);
  } catch {
    return [];
  }
}

function readPackageIdentity(manifestPath: string): Readonly<{ name: string; version: string }> | undefined {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const { name, version } = parsed as Readonly<Record<string, unknown>>;
    if (typeof name !== 'string' || typeof version !== 'string' || version.length === 0 || version !== version.trim()) {
      return undefined;
    }
    return { name, version };
  } catch {
    return undefined;
  }
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

const artifactPackageNames = new Map<string, ReadonlySet<string>>([
  ['@flighthq/tool-compiler', new Set(['@flighthq/tool-compiler'])],
  ['flight-cpp', new Set(['@flighthq/flight-cpp', 'flight-cpp-repository'])],
  ['haxe', new Set(['@flighthq/flight-hx'])],
  ['rust', new Set(['@flighthq/flight-rs'])],
]);

if (isCompilerCommandLineEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = compileCompilerCommandLineDirectory(process.argv.slice(2));
}
