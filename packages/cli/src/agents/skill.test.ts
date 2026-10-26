import { describe, expect, test } from "bun:test";
import { MAX_DESCRIPTION_LENGTH, MAX_SKILL_BODY_LINES, SKILL_DESCRIPTION, SKILL_RULES, skillMarkdown, skillProblems } from "./skill.ts";
import { readTopics, TOPIC_NAMES } from "./topics.ts";

const markdown = skillMarkdown(readTopics());

describe("skill", () => {
  test("has the frontmatter name and a description naming its triggers", () => {
    expect(markdown).toStartWith(`---\nname: quickservicets\ndescription: ${SKILL_DESCRIPTION}\n---\n`);
    for (const trigger of ["build a backend, API or service with QuickService.ts", "add an entity, endpoint, hook, job or feature to a QuickService.ts project", "a project with a quickservicets.config.ts"]) {
      expect(SKILL_DESCRIPTION).toContain(trigger);
    }
  });

  test("the body has when to use it, the workflow, the rules and every topic with one line", () => {
    for (const heading of ["## When to use it", "## Workflow", "## Rules", "## Topics"]) expect(markdown).toContain(`\n${heading}\n`);
    expect(markdown).toContain("- The service is mostly records with rules");
    expect(markdown).toContain("1. Create the project in any folder, then install: `bunx quickservicets init <name> --db sqlite`");
    for (const rule of SKILL_RULES) expect(markdown).toContain(`- ${rule}\n`);
    expect(markdown).toContain("Never edit `.generated/`");
    for (const name of TOPIC_NAMES) expect(markdown).toMatch(new RegExp(`\\n- \`topics/${name}\\.md\`: \\S`));
  });

  test("the frontmatter and size checks pass, and fail on a long description, a long body or a missing name", () => {
    expect(skillProblems(markdown)).toEqual([]);
    const long = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    expect(skillProblems(markdown.replace(SKILL_DESCRIPTION, long))).toEqual([`the description has ${MAX_DESCRIPTION_LENGTH + 1} characters, more than ${MAX_DESCRIPTION_LENGTH}`]);
    const body = markdown.replace("## Rules\n", `## Rules\n${"line\n".repeat(MAX_SKILL_BODY_LINES)}`);
    expect(skillProblems(body)[0]).toMatch(/^the body has \d+ lines, 200 or more$/);
    expect(skillProblems(markdown.replace("name: quickservicets\n", ""))).toEqual(["the frontmatter has no name"]);
    expect(skillProblems("# No frontmatter\n")).toEqual(["SKILL.md has no frontmatter"]);
  });
});
