import { describe, expect, it } from 'vitest';

import { classifyCommandCitation, collectCommandCitations } from './documentedCommandCitations.js';
import type { CommandCitation } from './documentedCommandCitations.js';

const scriptNames = new Set(['check', 'docs:check', 'test:coverage']);

function citation(overrides: Partial<CommandCitation> = {}): CommandCitation {
  return { command: 'check', line: 1, source: 'AGENTS.md', workspaceScoped: false, ...overrides };
}

describe('collectCommandCitations', () => {
  it('finds every citation with its one-based line and source', () => {
    const contents = ['# Title', '', 'Run `npm run check` before handoff.', 'Then `npm run docs:check`.'].join('\n');

    expect(collectCommandCitations('AGENTS.md', contents)).toEqual([
      { command: 'check', line: 3, source: 'AGENTS.md', workspaceScoped: false },
      { command: 'docs:check', line: 4, source: 'AGENTS.md', workspaceScoped: false },
    ]);
  });

  it('finds several citations on one line', () => {
    expect(
      collectCommandCitations('README.md', 'npm run check and npm run test:coverage').map((c) => c.command),
    ).toEqual(['check', 'test:coverage']);
  });

  it('marks workspace-scoped and prefix-scoped citations', () => {
    const contents = ['npm run test --workspace=packages/compiler-patch', 'npm run build --prefix ../..'].join('\n');

    expect(collectCommandCitations('agents/index.md', contents).map((c) => c.workspaceScoped)).toEqual([true, true]);
  });

  it('reads colons, digits, underscores and dashes as part of the command name', () => {
    expect(collectCommandCitations('AGENTS.md', 'npm run _scripts:build').map((c) => c.command)).toEqual([
      '_scripts:build',
    ]);
  });

  it('returns nothing for prose that never cites a command', () => {
    expect(collectCommandCitations('AGENTS.md', 'The check gate runs every stage.')).toEqual([]);
  });
});

describe('classifyCommandCitation', () => {
  it('resolves a citation naming a real script', () => {
    expect(classifyCommandCitation(citation({ command: 'docs:check' }), scriptNames)).toBe('resolved');
  });

  it('reports a citation naming no script', () => {
    expect(classifyCommandCitation(citation({ command: 'order:check' }), scriptNames)).toBe('missing');
  });

  it('separates a workspace-scoped citation from a missing one', () => {
    expect(classifyCommandCitation(citation({ command: 'test', workspaceScoped: true }), scriptNames)).toBe(
      'workspace-scoped',
    );
  });

  it('separates a placeholder from a missing citation', () => {
    expect(classifyCommandCitation(citation({ command: '<name>' }), scriptNames)).toBe('metasyntactic');
    expect(classifyCommandCitation(citation({ command: 'X' }), scriptNames)).toBe('metasyntactic');
  });

  it('classifies a placeholder before considering workspace scope', () => {
    expect(classifyCommandCitation(citation({ command: 'X', workspaceScoped: true }), scriptNames)).toBe(
      'metasyntactic',
    );
  });
});
