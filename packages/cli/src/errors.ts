/** An error in the project's source (entities, endpoints, hooks) found while building. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}
