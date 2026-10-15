export class EntityParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityParseError";
  }
}
