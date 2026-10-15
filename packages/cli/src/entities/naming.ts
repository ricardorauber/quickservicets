const COLLECTION_NAME = /^[a-z][a-z0-9-]*$/;

export function isValidCollectionName(name: string): boolean {
  return COLLECTION_NAME.test(name);
}

export function splitWords(pascalName: string): string[] {
  return pascalName.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[0-9]+/g) ?? [pascalName];
}

export function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

export function deriveCollectionName(entityName: string): string {
  const words = splitWords(entityName).map((word) => word.toLowerCase());
  const last = words.length - 1;
  words[last] = pluralize(words[last] ?? "");
  return words.join("-");
}

export function toCamelCase(collectionName: string): string {
  return collectionName.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function toSnakeCase(collectionName: string): string {
  return collectionName.replaceAll("-", "_");
}
