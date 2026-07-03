# Migration o1js → proof-systems direct (sans mina)

Objectif : o1js référence **proof-systems** (branche `snarky-rs`,
`~/Projects/proof-systems`) directement et le submodule `src/mina` disparaît.
Le projet mina n'est **plus modifié** — sa branche `snarky-rs` sert uniquement
de harnais de validation (tests de parité gate à gate du constraint system
Rust contre l'OCaml canonique, voir `mina/src/lib/snarky/CLAUDE.md`).

## Acquis (sessions précédentes, côté proof-systems)

- Crate `snarky` complet : DSL (`SnarkyCircuit`/`RunState`), gadgets
  (poseidon/sponge, curve, group_map, bits/number/integer, merkle), 15 tests.
- `SnarkyConstraintSystem` : 16/17 variantes de contraintes mina supportées,
  **parité gate à gate validée** contre `plonk_constraint_system.ml`.
- FFI OCaml complète dans kimchi-stubs (réutilisable comme référence pour la
  surface NAPI/WASM).
- Crates `mina-signer`, `mina-hasher`, `mina-tx-type` déjà dans le workspace.

## État des lieux o1js (branche `rust`)

- `src/mina` : submodule mina (~3.4.0-alpha1) — **la dépendance à éliminer**.
  Fournit via js_of_ocaml : Pickles (récursion), le DSL snarky sous Provable,
  la logique transactionnelle.
- `src/bindings/ocaml/jsoo_exports` : la couche d'export js_of_ocaml.
- `src/native/native.ts` : **chargeur NAPI déjà en place** — package
  `@o1js/native-{platform}-{arch}` (= kimchi-napi de proof-systems),
  `@napi-rs/cli` en devDeps. Les rails de la migration existent déjà.

## Plan

| Étape | Statut | Notes |
|---|---|---|
| Inventaire précis de la surface `Snarky.*` consommée par o1js (`src/bindings/js`, `src/lib/provable`) | ⬜ | quelles fonctions js_of_ocaml sont réellement appelées (exists, asProver, constraintSystem, poseidon…) |
| Exposer le crate `snarky` via kimchi-napi (Node) | ⬜ | même surface que les stubs OCaml : create/add_*/finalize/digest/to_gate_vector/compute_witness ; cvars aplatis `(constant, [(coeff, idx)])` |
| Exposer via kimchi-wasm (navigateur) | ⬜ | même API, wasm-bindgen |
| Brancher `Provable`/`constraintSystem()` d'o1js sur la surface native | ⬜ | derrière un flag (`O1JS_REQUIRE_NATIVE_BINDINGS` existe déjà) pour comparer avec la voie js_of_ocaml |
| Parité de VK : circuits o1js compilés via natif == via js_of_ocaml | ⬜ | même critère que la parité mina ; bloquant pour la compatibilité on-chain |
| **Porter Pickles en Rust** (step/wrap, side-loaded keys, feature flags) | ⬜ | LE gros chantier — sans lui, pas de ZkProgram/SmartContract sans mina |
| Logique transactionnelle : basculer sur mina-tx-type/mina-hasher/mina-signer Rust | ⬜ | compléter les crates existants si besoin |
| Retirer le submodule `src/mina` + la chaîne js_of_ocaml | ⬜ | étape finale |

## Repères

- proof-systems local : `~/Projects/proof-systems` (branche `snarky-rs`,
  dernier commit utile `2aecbfd819`).
- Le crate kimchi-napi du workspace est le point d'extension naturel pour la
  surface snarky Node ; kimchi-wasm pour le navigateur.
- Node ≥ 22 requis pour @napi-rs/cli 3.x (installé globalement sous
  `~/.nvm/versions/node/v22.11.0`).
