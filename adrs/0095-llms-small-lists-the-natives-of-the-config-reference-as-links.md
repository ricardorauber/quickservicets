# 0095 - `llms-small.txt` lists the natives of the config reference as links to their pages

- Date: 2026-11-04
- Spec: 0307-dev-services-compose-generation
- Status: accepted

## Context
`llms-small.txt` must stay under 200 KB (spec 0838), and it holds the whole config reference, whose native features section repeats every option table of every native. Before this block it had 22 bytes left. Spec 0307 adds the `dev` native, enabled by default, and specs 0310 and 0320 add `deploy` and `connections`; their options, the `services` commands and the new tags would push the file over its limit.

## Options considered
- A: In `llms-small.txt` only, keep every core key of the config reference and replace each native's option table with one line: its key, its summary and a link to its reference page (which lists its options). The website and `llms-full.txt` keep the full page. Frees about 90 KB and scales with more natives.
- B: Raise the limit. Breaks the promise that the small file fits small context windows.
- C: Drop the config reference from `llms-small.txt`. Loses the core keys agents need most.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `smallConfigReference` in `docs/scripts/llms.ts` shortens the config page inside `llms-small.txt`; a test checks the core keys stay and each native is one linked line.
- The file drops to about 117 KB and stays under its limit as natives are added.
