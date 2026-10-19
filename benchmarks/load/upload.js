// upload: POST /media, multipart/form-data with a ~50 KB PNG in the "file" part.
import http from "k6/http";
import { BASE_URL, expectStatus, options as makeOptions, summary } from "./lib.js";

const png = open("./fixtures/upload.png", "b");
export const options = makeOptions(["upload_media"]);

export default function () {
  const res = http.post(`${BASE_URL}/media`, { file: http.file(png, "upload.png", "image/png") }, { tags: { endpoint: "upload_media", name: "upload_media" } });
  expectStatus(res, 201, "upload_media");
}

export function handleSummary(data) {
  return summary(data);
}
