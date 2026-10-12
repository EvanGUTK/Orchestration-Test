# Independent engine oracle (QA-001, CONTRACT-001 v1)

An independent Python 3 (stdlib only) reference implementation of the engine's
deterministic core, plus frozen golden vectors that the TypeScript engine and
the quality suites must reproduce byte-for-byte. Written from
`docs/CONTRACTS.md` and the chief-frozen CONTRACT-001 decisions only; no
TypeScript engine code was read. Covers acceptance row **ENG-10** and supports
ENG-01..08.

| File | Purpose |
| --- | --- |
| `reference_engine.py` | Seed derivation, xoshiro128**, `uniform`, `spawn`, `new_game`, `slide`, `apply_move`, `is_game_over`, `legal_moves`, `canonical_json`, `checksum` |
| `generate_vectors.py` | Deterministic generator for `../vectors/engine-v1.json` (`--check` verifies only) |
| `test_reference_engine.py` | unittest: all 11 `tests/fixtures/slide-v1.json` vectors, invariants, vector-file regeneration |
| `../vectors/engine-v1.json` | Frozen golden vectors |
| `../vectors/.gitattributes` | Forces LF so the byte comparison survives `core.autocrlf=true` checkouts |

## Run / regenerate

From the repository root:

```bash
python3 -m unittest discover -s tests/acceptance/oracle -v
python3 tests/acceptance/oracle/generate_vectors.py --check   # must print OK
python3 tests/acceptance/oracle/generate_vectors.py           # rewrite (only after a reviewed contract change)
```

Output is UTF-8, LF, 2-space indent, insertion key order, no randomness, no
clocks. Changing `engine-v1.json` means changing CONTRACT-001: bump the file
name (`engine-v2.json`) rather than editing v1 in place.

## Frozen rules implemented

1. **Seed**: `SHA-256(UTF-8("2048-infinite/v1:" + seed))`, first 16 bytes ->
   four little-endian uint32 words; `[0,0,0,0]` -> `[1,0,0,0]`.
2. **xoshiro128\*\*** (`xoshiro128ss-v1`): standard reference algorithm; state
   `[s0,s1,s2,s3]`. Cross-checked against the published output for state
   `[1,2,3,4]` (`11520, 0, 5927040, 70819200, ...`), also in the vectors.
3. **uniform(n)**, `1 <= n <= 2^32`: `limit = 2^32 - (2^32 mod n)`; draw until
   `x < limit`; return `x mod n`. Every raw draw, rejected or not, advances state.
4. **spawn**: empties in row-major order; position `empties[uniform(len)]`
   first, then `v = uniform(10)`; exponent `"2"` (tile 4) if `v < fourWeight`
   else `"1"` (tile 2); default `fourWeight = 1`.
5. **newGame**: empty board, `rng = derive(seed)`, two spawns; score `"0"`,
   counters 0, `active`, `celebrated2048: false`. `rulesetVersion` is
   `classic-v1` for 4x4 and `practice-v1` otherwise; `engineVersion` `1.0.0`.
6. **slide**: per line compress toward the direction, merge equal neighbours
   from the leading edge, each tile merges once; `scoreDelta = sum 2^(e+1)`.
7. **applyMove**: unchanged slide -> identical state, zero draws, `changed:false`,
   `scoreDelta "0"`. Otherwise slid board, `score += delta`, one spawn,
   `acceptedMoves += 1`, `revision += 1`, `celebrated2048` set once when any
   exponent `>= 11`, `status = "completed"` when no empty cell and no
   orthogonally adjacent equal exponents.
8. **Canonical JSON** (key order exactly as below, no whitespace):
   `{"schemaVersion":1,"engineVersion":"1.0.0","rulesetVersion":...,"board":{"size":4,"cells":[...]},"score":"0","acceptedMoves":0,"revision":0,"rng":{"algorithm":"xoshiro128ss-v1","words":[a,b,c,d]},"status":"active","celebrated2048":false}`;
   checksum = lowercase hex SHA-256 of its UTF-8 bytes.

## Vector sections (`engine-v1.json`)

| Key | Contents |
| --- | --- |
| `seedDerivation` | seeds `0`, `1`, `abc`, `2048-infinite`, `ünïcødé`, `challenge:2026-10-12` -> hash input hex, SHA-256, words |
| `xoshiro` | state `[1,2,3,4]` and seeds `0`, `abc`: initial words, first 20 outputs, words after |
| `uniform.sequences` | from `derive("abc")`, fresh per n: 10 results for n in 1, 2, 3, 10, 16, 15, 2^32-1, 2^31+1, 2^32 with every raw draw, rejected draws, draws consumed, words after |
| `uniform.rejectionCase` | seed `rejection-0`, n = 2^31+1 (limit 2^31+1): 4 rejected raw draws then an accepted one, words after |
| `newGame` | sizes 3, 4, 8 x seeds `0`, `abc`, `2048-infinite`: spawn trace, full state, `canonicalJson`, `checksum` |
| `moveSequences` | 4x4 seeds `0` and `abc`, 40 fixed directions; per step direction, changed, scoreDelta, spawn, raw draws consumed, score/counters/status, rng words, checksum; `noOpSteps`; initial and final canonical state |
| `highValue` | hand-built 4x4: `53,53` and `4095,4095` slide left -> `54`, `4096`; scoreDelta `2^54 + 2^4096` (1234 digits, plus its SHA-256); applyMove result (celebrates, since exponent >= 11) with checksum |
| `transitions` | first 2048 celebration; already-celebrated stays true; a move that completes the game; completed board has no legal moves; full-but-mergeable board stays active |

## How to consume

- **Engine (ENGINE-001..003)**: load the JSON in Vitest; for each case feed the
  same inputs to the TS API and assert exact equality of words, outputs,
  cells, decimal strings and `checksum`. Compare `canonicalJson` as a string,
  not as parsed objects; key order and spacing are part of the contract.
  Replay each `moveSequences` entry from `initial.state` and assert every step's
  `checksum` and `rngWords`; a no-op step must leave `rngWords` unchanged.
- **Quality (QA-002+)**: acceptance and property tests read the same file;
  replay/import tests may use `moveSequences[*].steps[*].checksum` as recorded
  per-move checksums. Backend/DB tests can round-trip `highValue` states through
  JSON/SQLite and require identical checksums (ENG-05).
- The oracle can generate new expectations for any ad-hoc state
  (`apply_move`, `checksum`), but frozen files are the source of truth.

## Ambiguities and the literal reading chosen

Sent to chief as a `question` on QA-001; override here if the chief rules otherwise.

1. `uniform(1)` consumes exactly one raw draw (decision 3 is "repeat ... until"),
   so a spawn with a single empty cell still advances the PRNG for its position.
   Implementations must not short-circuit `n == 1`.
2. `applyMove` on a `completed`/`forfeited` state is unspecified. The oracle
   does not gate on status; no vector exercises it. Recommend a typed rejection
   in the engine.
3. `rulesetVersion` is keyed only on board size, so a 4x4 practice game is
   labelled `classic-v1`.
4. `fourWeight` is assumed to be an integer in `[0, 10]`.
5. `celebrated2048` and `completed` are evaluated on the post-spawn board
   (equivalent for celebration, since spawns are exponents 1 and 2).
6. Rejections cannot practically occur for spawn-sized n (probability at most
   64/2^32 per draw), so the rejection demo uses n = 2^31+1. The all-zero seed
   substitution likewise cannot be shown with a real seed; it is unit-tested on
   the digest-to-words helper.
7. Domain events (motion/merge/spawn ordering) are outside this oracle; `slide`
   only reports merge destinations, sorted row-major.
