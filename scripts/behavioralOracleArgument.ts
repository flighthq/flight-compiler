export function isDateArgument(value: unknown): value is { date: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'date' in value &&
    typeof (value as Readonly<{ date?: unknown }>).date === 'number'
  );
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRecordArgument(value: unknown): value is Readonly<Record<string, unknown>> & { $type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$type' in value &&
    typeof value.$type === 'string' &&
    !('$stringEnum' in value)
  );
}

export function isRejectedTaskArgument(value: unknown): value is { rejects: unknown } {
  return typeof value === 'object' && value !== null && 'rejects' in value;
}

export function isStringEnumArgument(value: unknown): value is { $stringEnum: string; variant: string; value: string } {
  return (
    typeof value === 'object' && value !== null && '$stringEnum' in value && 'variant' in value && 'value' in value
  );
}

export function isTaskArgument(value: unknown): value is { task: unknown } {
  return typeof value === 'object' && value !== null && 'task' in value;
}
