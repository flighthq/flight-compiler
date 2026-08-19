import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyCommandCitation, collectCommandCitations } from './documentedCommandCitations.js';
import type { CommandCitationVerdict } from './documentedCommandCitations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors: string[] = [];
const warnings: string[] = [];
const agentsFile = path.join(root, 'AGENTS.md');
const agentsContents = readFileSync(agentsFile, 'utf8');
const agentsLimit = 40_000;
const agentsWarning = Math.floor(agentsLimit * 0.98);

if (agentsContents.length > agentsLimit) {
  errors.push(`AGENTS.md is ${String(agentsContents.length)} characters; maximum is ${String(agentsLimit)}`);
} else if (agentsContents.length > agentsWarning) {
  warnings.push(`AGENTS.md is within 2% of its ${String(agentsLimit)}-character limit`);
}

const claudeContents = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
if (claudeContents !== '@AGENTS.md\n') errors.push('CLAUDE.md must contain only @AGENTS.md and a trailing newline');

const markdownFiles = [
  path.join(root, 'AGENTS.md'),
  path.join(root, 'README.md'),
  ...walkMarkdown(path.join(root, 'agents')),
  ...walkMarkdown(path.join(root, 'docs')),
  path.join(root, 'packages', 'tool-compiler', 'README.md'),
];
for (const file of markdownFiles) checkLocalLinks(file);

const agentIndex = readFileSync(path.join(root, 'agents', 'index.md'), 'utf8');
for (const file of walkMarkdown(path.join(root, 'agents'))) {
  if (path.basename(file) === 'index.md') continue;
  const relative = path.relative(path.join(root, 'agents'), file).replaceAll('\\', '/');
  if (!agentIndex.includes(`(${relative})`)) errors.push(`agents/index.md does not link ${relative}`);
}

// Command citations are checked over every tracked Markdown file rather than the curated list above,
// because a stale command misleads a reader wherever it is written. Each verdict count is printed so
// a zero is readable as measured rather than as never executed.
const scriptNames = new Set(Object.keys(readManifestScripts()));
const citations = trackedMarkdownFiles().flatMap((file) =>
  collectCommandCitations(relative(path.join(root, file)), readFileSync(path.join(root, file), 'utf8')),
);
const verdicts = new Map<CommandCitationVerdict, number>([
  ['metasyntactic', 0],
  ['missing', 0],
  ['resolved', 0],
  ['workspace-scoped', 0],
]);
for (const citation of citations) {
  const verdict = classifyCommandCitation(citation, scriptNames);
  verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
  if (verdict === 'missing') {
    errors.push(`${citation.source}:${String(citation.line)} cites npm run ${citation.command}, which is not a script`);
  }
}

for (const warning of warnings) process.stderr.write(`Documentation health warning: ${warning}\n`);
if (errors.length > 0) {
  process.stderr.write(`Documentation health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  `Documentation health passed for ${String(markdownFiles.length)} Markdown files and ${String(citations.length)} command citations ` +
    `(${String(verdicts.get('resolved') ?? 0)} resolved, ${String(verdicts.get('workspace-scoped') ?? 0)} workspace-scoped, ${String(verdicts.get('metasyntactic') ?? 0)} placeholder).\n`,
);

function readManifestScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

function trackedMarkdownFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' });
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function checkLocalLinks(file: string): void {
  const contents = readFileSync(file, 'utf8');
  const links = contents.matchAll(/\[[^\]]*\]\((?<target>[^)]+)\)/gu);
  for (const link of links) {
    const rawTarget = link.groups?.target;
    if (!rawTarget || /^(?:#|https?:|mailto:)/u.test(rawTarget)) continue;
    const targetWithoutTitle = rawTarget.split(/\s+["']/u, 1)[0] ?? rawTarget;
    const targetPath = targetWithoutTitle.replace(/^<|>$/gu, '').split('#', 1)[0];
    if (!targetPath) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(targetPath));
    if (!existsSync(resolved)) {
      errors.push(`${relative(file)} links missing local target ${targetPath}`);
    }
  }
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}

function walkMarkdown(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files.sort();
}
