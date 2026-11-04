# 0100 - Connection pool sizes use the option `max`

- Date: 2026-11-04
- Spec: 0320-connection-pool-modes
- Status: accepted

## Context
Spec 0320 R1 names the pool size option `max` (for the native and, by R8, for each entry of `connections.databases`), while AC6 writes the example as `connections: { pool: 5, databases: { orders: { pool: 2 } } }`.

## Options considered
- A: Keep `max` as R1 and R8 define it, and read AC6's `pool` as the pool size `max`; one name for the option everywhere, matching `postgresAdapter({ max })`.
- B: Add `pool` as a second name for the same option. Two names for one setting, and two variables.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- AC6 is verified with `connections: { max: 5, databases: { orders: { max: 2 } } }`.
