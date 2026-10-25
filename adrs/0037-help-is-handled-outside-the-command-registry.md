# 0037 - `quickservice help` is handled outside the command registry

- Date: 2026-10-25
- Spec: 0149-cli-command-registry
- Status: accepted

## Context
Spec 0149 moves every built-in command into a registry and derives the CLI reference from it, with "every current
command, its output and its exit codes unchanged" and a reference page listing "the same commands with the same usage
and descriptions" (R2, AC1). It also asks for `quickservice help` and `quickservice --help` (R7), which did not exist,
and for usage errors on missing required arguments (R6), while `quickservice migration add` without a name already
printed `Usage: quickservice migration add <Name>` and exited with 1.

## Options considered
- A: Handle `help` and `--help` in the dispatcher before the registry, like `--version`, and reserve the name `help` so
  no feature command can take it; keep `migration add`'s argument optional in its definition so its own message stays
  the same. The reference keeps exactly the commands it listed, and the intro of the CLI page mentions `help`.
- B: Define `help` as a registry command and mark `<Name>` required — the reference gains a command and
  `migration add` without a name prints the generic `Missing argument <Name>` with the usage, changing a documented
  output.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`run.ts` answers `help` and `--help` before looking up commands; `loadFeatureCommands` treats `help` as a built-in name
in the conflict check. `migration add` still checks its name in `run`.
