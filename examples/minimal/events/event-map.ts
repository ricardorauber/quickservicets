/** The custom events of the project, with their payloads. */
declare module "@quickservice/core" {
  interface EventMap {
    "post.published": { postId: string };
  }
}

export {};
