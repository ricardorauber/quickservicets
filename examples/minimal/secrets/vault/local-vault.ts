import { readFileSync } from "node:fs";
import { defineSecretProvider, SecretNotFoundError } from "@quickservicets/core";

/**
 * A project provider for `local://<path>[#<key>]` backed by a JSON file of secrets by path, read on every resolution
 * with a ttl of one minute, so editing the file rotates a secret without a restart.
 */
export function localVault(file: string) {
  return defineSecretProvider({
    name: "local-vault",
    schemes: ["local"],
    resolve(reference) {
      const secrets = JSON.parse(readFileSync(file, "utf8")) as Record<string, string | Record<string, string>>;
      const entry = secrets[reference.path];
      if (entry === undefined) throw new SecretNotFoundError(reference);
      return typeof entry === "string" ? { value: entry, ttl: "1m" } : { values: entry, ttl: "1m" };
    },
  });
}
