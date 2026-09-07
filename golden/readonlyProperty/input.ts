interface Config {
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

export function getArea(config: Config): number {
  return config.width * config.height;
}

export function getLabel(config: Config): string {
  return config.label;
}

export function getPerimeter(config: Config): number {
  return 2 * (config.width + config.height);
}
