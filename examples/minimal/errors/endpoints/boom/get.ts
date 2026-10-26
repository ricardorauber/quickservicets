/** Fails on purpose, so the report shows up. */
export default () => {
  throw new Error("The payment provider timed out");
};
