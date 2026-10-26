import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { AGENT_DOCS_DIR, MAX_TOPIC_LINES, parseTopic, readTopics, TOPIC_NAMES, topicFormatProblems } from "./topics.ts";

const valid = [
  "# Sample",
  "",
  "One line that says what the topic covers.",
  "",
  "Steps.",
  "",
  "Full docs: [Entities](/guides/entities/) and [Tags](/reference/tags/)",
  "",
  "## Do not",
  "",
  "- Do not edit `.generated/`.",
  "",
].join("\n");

describe("topic format", () => {
  test("the folder holds exactly the nine topics, each with a summary line, under the line limit and with a Do not list", () => {
    expect(readdirSync(AGENT_DOCS_DIR).sort()).toEqual(TOPIC_NAMES.map((name) => `${name}.md`).sort());
    const topics = readTopics();
    expect(topics.map((topic) => topic.name)).toEqual([...TOPIC_NAMES]);
    expect(topics.flatMap(topicFormatProblems)).toEqual([]);
    for (const topic of topics) {
      expect(topic.summary.length).toBeGreaterThan(20);
      expect(topic.markdown.split("\n").length).toBeLessThanOrEqual(MAX_TOPIC_LINES);
    }
  });

  test("parses the title, the summary and the Full docs links, the first being the main page", () => {
    const topic = parseTopic("sample", valid);
    expect(topic).toMatchObject({ title: "Sample", summary: "One line that says what the topic covers." });
    expect(topic.fullDocs).toEqual([
      { title: "Entities", path: "/guides/entities/" },
      { title: "Tags", path: "/reference/tags/" },
    ]);
    expect(topicFormatProblems(topic)).toEqual([]);
  });

  test("a missing summary, a long topic, no Full docs line and no Do not list are reported", () => {
    expect(topicFormatProblems(parseTopic("a", valid.replace("One line that says what the topic covers.\n", "Two\nlines\n")))).toEqual([
      'a: the heading must be followed by a one-line summary and a blank line',
    ]);
    const long = valid.replace("Steps.", Array.from({ length: MAX_TOPIC_LINES }, () => "Line.").join("\n"));
    expect(topicFormatProblems(parseTopic("b", long))).toEqual([`b: ${MAX_TOPIC_LINES + 10} lines, more than ${MAX_TOPIC_LINES}`]);
    expect(topicFormatProblems(parseTopic("c", valid.replace(/Full docs: .*\n/, "")))).toEqual(['c: no "Full docs:" line with a link to the docs']);
    expect(topicFormatProblems(parseTopic("d", valid.replace("- Do not edit `.generated/`.", "- Edit carefully.")))).toEqual(['d: no "## Do not" list of "- Do not ..." items']);
  });
});
