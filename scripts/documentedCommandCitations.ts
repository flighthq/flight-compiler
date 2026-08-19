// A document that names a command is making a checkable claim, and scripts get renamed under it.
// The failure is quiet in the worst way: a reader runs the command, npm answers "missing script",
// and the document still looks authoritative — so the reader concludes their checkout is broken
// rather than the documentation.
//
// Two citation forms look dead to a naive scan and are not, so both are classified rather than
// dropped: a workspace-scoped citation resolves against that workspace's manifest instead of the
// root one, and a metasyntactic citation is a placeholder standing for any script rather than a
// reference to one. Reporting them keeps the skip visible instead of silently narrowing the
// population.
//
// A citation written as a bare backticked script name with no `npm run` lead is a real reference and
// real rot, and this classification does not see it: a bare token cannot be separated from prose
// without a dictionary that would also match ordinary English. Stated so silence on that form is not
// read as its absence.

export interface CommandCitation {
  readonly command: string;
  readonly line: number;
  readonly source: string;
  readonly workspaceScoped: boolean;
}

export type CommandCitationVerdict = 'metasyntactic' | 'missing' | 'resolved' | 'workspace-scoped';

const metasyntacticCommands = new Set(['<command>', '<name>', '<script>', 'X', 'Y', 'Z']);

export function classifyCommandCitation(
  citation: Readonly<CommandCitation>,
  scriptNames: ReadonlySet<string>,
): CommandCitationVerdict {
  if (metasyntacticCommands.has(citation.command)) return 'metasyntactic';
  if (citation.workspaceScoped) return 'workspace-scoped';
  return scriptNames.has(citation.command) ? 'resolved' : 'missing';
}

export function collectCommandCitations(source: string, contents: string): CommandCitation[] {
  const citations: CommandCitation[] = [];
  contents.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(/npm run (?<command>[A-Za-z0-9:_<>-]+)/gu)) {
      const command = match.groups?.command;
      if (!command) continue;
      const remainder = text.slice((match.index ?? 0) + match[0].length);
      citations.push({
        command,
        line: index + 1,
        source,
        workspaceScoped: /^\s*--(?:workspace|prefix)/u.test(remainder),
      });
    }
  });
  return citations;
}
