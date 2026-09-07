export abstract class Component {
  abstract name: string;
  abstract readonly version: number;

  public describe(): string {
    return this.name;
  }

  public getVersion(): number {
    return this.version;
  }
}

export class Button extends Component {
  name: string = 'button';
  readonly version: number = 1;
}

export class DeclareExample {
  declare label: string;
  value: number = 0;

  public getLabel(): string {
    return this.label;
  }
}
