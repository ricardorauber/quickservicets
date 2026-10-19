export type User = {
  /** @unique @format email */
  email: string;
  /** @minLength 1 @maxLength 100 */
  name: string;
  /** @default 'member' */
  role: "member" | "admin";
  /** @integer @min 0 @max 150 */
  age?: number;
};
