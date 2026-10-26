/** @changes */
export type Task = {
  title: string;
  status: "open" | "done";
  owner?: string;
};
