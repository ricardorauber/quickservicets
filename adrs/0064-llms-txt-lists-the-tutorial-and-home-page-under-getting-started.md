# 0064 - `llms.txt` lists the tutorial and the home page under Getting started

- Date: 2026-10-26
- Spec: 0834-llms-txt
- Status: accepted

## Context
Spec 0834 R1 names five sections for `llms.txt` (`Agent guides`, `Getting started`, `Guides`, `Reference`, `Recipes`),
and R6 requires every page to appear in it. The site also has the home page and a `Tutorial` sidebar group, which none
of the five sections names. R2 and R6 also ask for no `import ` line in `llms-full.txt`, while many pages show
TypeScript code that starts with `import`.

## Options considered
- A: List the home page and the tutorial pages under `Getting started` (the tutorial follows it in the sidebar and is
  the next step of learning), keeping the five sections; check for `import ` lines and component tags outside code
  blocks only, since code samples are content — every page appears, the sections stay as specified.
- B: Add a sixth `Tutorial` section — mirrors the sidebar, but changes the specified structure.
- C: Leave the tutorial out — keeps five sections, but breaks R6.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`docs/scripts/llms.ts` puts pages of `index.mdx` and `tutorial/` in `Getting started`; `unrenderedLines` ignores code
blocks and inline code. The spec could name the tutorial explicitly in R1.
