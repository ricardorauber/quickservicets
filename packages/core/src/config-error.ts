/** An invalid or missing configuration value; the message names what to fix. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
