import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectLicenseSignals } from './licenseProvenance.js';

// Fails when licensed text appears anywhere except the files that are supposed to carry it. Every
// exemption is named with its reason and printed on each run, so the gate's escapes stay visible
// rather than becoming an invisible narrowing of what it examines.

interface Exemption {
  readonly path: string;
  readonly reason: string;
}

const exemptions: readonly Exemption[] = [
  { path: 'LICENSE.md', reason: 'the operative license and copyright statement' },
  { path: 'packages/tool-compiler/LICENSE.md', reason: 'the published copy of the operative license' },
  { path: 'package-lock.json', reason: 'generated dependency metadata, not authored text' },
  { path: 'scripts/licenseProvenance.ts', reason: 'defines the phrases, so it necessarily contains them' },
  { path: 'scripts/licenseProvenance.test.ts', reason: 'fixtures are the phrases the rules must catch' },
];

// The last two exemptions are the detector's self-reference, and they are the gate's real blind spot:
// licensed text pasted into those two files would not be reported. They are named and printed rather
// than filtered silently so the hole stays the size of two files a reviewer can read.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownAttribution = readOwnAttribution();
const exemptPaths = new Set(exemptions.map((exemption) => exemption.path));
const errors: string[] = [];
const scanned = trackedTextFiles().filter((file) => !exemptPaths.has(file));

for (const file of scanned) {
  for (const signal of collectLicenseSignals(readFileSync(path.join(root, file), 'utf8'), ownAttribution)) {
    errors.push(`${file}:${String(signal.line)} [${signal.rule}] ${signal.detail}`);
  }
}

for (const exemption of exemptions) {
  process.stdout.write(`License provenance exemption: ${exemption.path} — ${exemption.reason}\n`);
}

if (errors.length > 0) {
  process.stderr.write(`License provenance failed with ${String(errors.length)} finding(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write(
    'Licensed text creates an attribution obligation. Remove it, or record how to obtain the artifact and its content hash instead.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `License provenance passed for ${String(scanned.length)} tracked and untracked files, attributed to ${ownAttribution}.\n`,
);

function readOwnAttribution(): string {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { author?: string };
  const author = manifest.author;
  if (author === undefined || author.length === 0) {
    process.stderr.write('The root manifest declares no author, so no copyright line can be recognized as our own.\n');
    process.exit(1);
  }
  // The manifest carries the full attribution phrase; a copyright line names the person in it.
  return author.split(' and ', 1)[0] ?? author;
}

// The population includes files that are not committed yet. A tracked-only scan passes on the file
// somebody just pasted a licensed header into, which is exactly when the answer matters — measured:
// a planted vendor header went unreported until `--others` was added. Ignored paths stay out via
// `--exclude-standard`, and binary or generated trees are excluded by extension rather than by
// directory, so a new directory cannot silently fall outside the scan.
function trackedTextFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.(?:cjs|js|json|md|mjs|ts|tsx|yaml|yml)$/u.test(line))
    .sort();
}
