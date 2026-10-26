/** The custom events of the project, with their payloads. */
declare module "@quickservicets/core" {
  interface EventMap {
    "post.published": { postId: string };
  }
}

export {};
