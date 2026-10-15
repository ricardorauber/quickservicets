import { BuildError } from "../errors.ts";

export class EntityParseError extends BuildError {
  constructor(message: string) {
    super(message);
    this.name = "EntityParseError";
  }
}
