export function dayName(day: number): string {
  switch (day) {
    case 0:
      return 'Sunday';
    case 1:
      return 'Monday';
    case 2:
      return 'Tuesday';
    case 3:
      return 'Wednesday';
    case 4:
      return 'Thursday';
    case 5:
      return 'Friday';
    case 6:
      return 'Saturday';
    default:
      return 'Unknown';
  }
}

export function classifyChar(code: number): string {
  if (code >= 48 && code <= 57) return 'digit';
  if (code >= 65 && code <= 90) return 'upper';
  if (code >= 97 && code <= 122) return 'lower';
  return 'other';
}
