export function greet(language: string): string {
  switch (language) {
    case 'en':
      return 'hello';
    case 'es':
      return 'hola';
    case 'fr':
      return 'bonjour';
    default:
      return 'hi';
  }
}

export function priority(level: string): number {
  switch (level) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'critical':
      return 4;
    default:
      return 0;
  }
}
