export function selectFirstKey(): string {
  for (const key in { second: 2, 10: 10, 2: 2, first: 1 }) return key;
  return '';
}
