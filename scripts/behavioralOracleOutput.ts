export function splitBehavioralOracleOutput(output: string): readonly string[] {
  const lines = output.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
