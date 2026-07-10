# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

**o1js v2.14.0** | Last updated: 2026-03-24

o1js is the TypeScript SDK for writing zero-knowledge applications on Mina
Protocol.

Read `AGENT.md` for build commands, architecture, circuit model, common
pitfalls, and file organization. Read `AGENT_LOG.md` for hard-won lessons from
previous agent sessions.

**Rust migration (branch `pickle-rust`):** read `RUST_MIGRATION.md` for the
plan and status of replacing the `src/mina` submodule with direct
proof-systems bindings (snarky-rs / pickles-rs).

Current Pickles VK parity handoff:

- local proof-systems source is expected at `~/Projects/proof-systems`
  on branch `pickle-rs`;
- o1js' OCaml Pickles binding prepends `dummy_constraints()` to every rule;
  Rust now ports that preamble (`proof-systems` commit `9aba71a8f5`);
- step gate histograms now match jsoo exactly for the minimal ZkProgram
  (512 rows, same selector counts);
- VK commitments still do not match (`0/28`) because 10 internal
  wiring/coefficient differences remain inside the dummy preamble;
- use `src/tests/rust-pickles-step-gates-diff.ts` and
  `src/tests/rust-pickles-vk-parity.ts` to continue from this point.
