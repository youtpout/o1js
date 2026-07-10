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
| Inventaire de la surface `Snarky.*` | ✅ | ~35 fonctions : `run.*` (RunState), `field.*` (assertEqual/readVar/…), `gates.*` (generic, ecAdd, rangeCheck0/1, xor, rotate, lookup, foreignFieldAdd/Mul, raw, addRuntimeTableConfig), `constraintSystem.*` (rows/digest/toJson), `poseidon.*` (update/sponge/hashToGroup), `circuit.*` (compile/prove/verify/keypair), `group.scaleFastUnpack` — mapping quasi 1:1 sur le crate snarky |
| Exposer le crate `snarky` via kimchi-napi (Node) — **cœur fait** | 🟨 | proof-systems `bc2b5fb265` : `kimchi-napi/src/snarky.rs` — create/set_primary_input_size/add_{boolean,equal,square,r1cs}/finalize/digest/to_gate_vector/compute_witness (Fp+Fq), lincoms en `(constant?, coeffs bytes[], indices u32[])`. Reste : les gates kimchi custom (generic/poseidon/ec/range/xor/rot/ff — recopier depuis kimchi-stubs), add_row générique |
| Surface NAPI complète (gates kimchi custom) | ✅ | proof-systems `ecf260e026` : add_basic, add_poseidon, add_ec_add_complete, add_range_check0/1, add_lookup + `add_row` générique (gate type numérique dans l'ordre de déclaration de `GateType` kimchi : 0=Zero…13=Rot64) ; lincoms en objet JS `NapiLinCom {constant?, coeffs: bytes[], indices: u32[]}` |
| Builder `@o1js/native` depuis notre proof-systems (sans `src/mina`) | ✅ | `PROOF_SYSTEMS_ROOT=~/Projects/proof-systems npm run build:native` bypasse `src/mina` (napi build direct) ; **smoke test Node validé** : create → add_basic_constraint(kind) → finalize → digest → gate vector natif |
| Encodage FFI JS | ✅ | lincoms en buffers plats parallèles (`sizes u32[]`, `has_constant u8[]`, `constants`, `coeffs` 32o/élément, `indices u32[]`) — les typed arrays dans des objets JS ne passent pas avec napi-rs |
| Exposer via kimchi-wasm (navigateur) | 🟨 | pickles fait (`kimchi-wasm/src/pickles.rs` : prove recorded + verify side-loaded, miroir NAPI) ; la surface snarky CS reste à dupliquer |
| Adaptateur TS `src/native/snarky.ts` | ✅ | `NativeFpConstraintSystem` : aplatissement des arbres `FieldVar` (`flattenFieldVar` = `Cvar.to_constant_and_terms`), encodeur batch, toutes les contraintes, `toJson` via le sérialiseur kimchi, `computeWitness` (bigints JS → colonnes calculées en Rust). **Smoke test complet validé** (rows/digest/json/witness) |
| Brancher `Provable`/`constraintSystem()` d'o1js sur l'adaptateur | 🟨 | **preuve Pickles Rust depuis du vrai code o1js** : `rust-pickles-recorded.ts` intercepte `Snarky.field.*`/`gates.generic` en mode witness-gen (valeurs via readVar/asProver), enregistre le circuit en JSON RecordedCircuit et le prouve via `rust_pickles_prove_recorded_base/_n1` (@o1js/native). Smoke : `./run src/tests/rust-pickles-recorded.ts` — base 3.7s, N1 12.4s, verify standalone. Reste : recorders poseidon/EC/range-check, intégration ZkProgram |
| Parité de VK : circuits o1js compilés via natif == via js_of_ocaml | ⬜ | même critère que la parité mina ; bloquant pour la compatibilité on-chain |
| **Porter Pickles en Rust** (step/wrap, side-loaded keys, feature flags) | 🟨 | crate `pickles` : base-case + récursion N1/N2 e2e, verify standalone side-loaded (`verify.rs`), circuits enregistrés pilotés depuis JS (`recorded.rs`) exposés NAPI+WASM ; reste : récursion pilotée depuis JS, gates optionnels dans RecordedConstraint, feature flags |
| Logique transactionnelle : basculer sur mina-tx-type/mina-hasher/mina-signer Rust | ⬜ | compléter les crates existants si besoin |
| Retirer le submodule `src/mina` + la chaîne js_of_ocaml | ⬜ | étape finale |

## Repères

- proof-systems local : `~/Projects/proof-systems` (branche `snarky-rs`,
  dernier commit utile `2aecbfd819`).
- Le crate kimchi-napi du workspace est le point d'extension naturel pour la
  surface snarky Node ; kimchi-wasm pour le navigateur.
- Node ≥ 22 requis pour @napi-rs/cli 3.x (installé globalement sous
  `~/.nvm/versions/node/v22.11.0`).
