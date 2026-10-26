# 0067 - `quickservicets docs <name> --full` also takes a docs page name

- Date: 2026-10-26
- Spec: 0837-cli-docs-command
- Status: accepted

## Context
Spec 0837 R4 says `quickservicets docs <topic> --full` prints the full docs page the topic links to, and R2 says an
unknown topic exits 1. AC4 runs `quickservicets docs queues --full` and expects the queues guide, but `queues` is not one
of the nine agent topics (spec 0833 R1), and the `features` topic links several pages, the queues guide among them.

## Options considered
- A: With `--full`, resolve the name as a topic first (its first `Full docs:` link is its main page), then as a bundled
  page path (`guides/queues`) or a page's last segment (`queues`, looked up in guides, getting started, recipes,
  tutorial and reference, in that order); without `--full`, only topics are accepted — AC4 works, R2 is unchanged for
  plain topics, and every bundled page is reachable offline.
- B: Add a `queues` topic — makes AC4 literal, but adds a tenth topic the other specs do not list.
- C: Accept only topic names — AC4 fails.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The CLI package bundles every docs page as Markdown in `docs-pages/` (written by `bun run agents:generate`, which
`bun run docs:reference` now runs too). An unknown name with `--full` exits 1 with
`Unknown topic or page <name>. Topics: <list>` and the closest topic or page name.
