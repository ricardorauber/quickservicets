import { defineSse } from "@quickservicets/core";

/** Sends three ticks and closes: a streaming route, which needs deploy.lambda.streaming on lambda. */
export default defineSse((stream) => {
  for (let tick = 1; tick <= 3; tick++) stream.send({ tick });
  stream.close();
});
