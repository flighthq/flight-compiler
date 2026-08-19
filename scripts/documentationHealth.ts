import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

for (const warning of warnings) process.stderr.write(`Documentation health warning: ${warning}\n`);
if (errors.length > 0) {
  process.stderr.write(`Documentation health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(`Documentation health passed for ${String(markdownFiles.length)} Markdown files.\n`);

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
