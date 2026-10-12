"""Independent reference oracle for the 2048 Infinite engine, CONTRACT-001 v1.

Python 3 standard library only. Written from docs/CONTRACTS.md and the
chief-frozen CONTRACT-001 decisions (see README.md in this directory); it does
not derive from any TypeScript engine code.

State shape mirrors the public GameState JSON:
  {"schemaVersion": 1, "engineVersion": "1.0.0", "rulesetVersion": "...",
   "board": {"size": n, "cells": [Exponent | None, ...]},
   "score": Decimal, "acceptedMoves": int, "revision": int,
   "rng": {"algorithm": "xoshiro128ss-v1", "words": [u32, u32, u32, u32]},
   "status": "active" | "completed" | "forfeited", "celebrated2048": bool}
Exponents and scores are decimal strings; arithmetic uses Python int (bigint).
No function mutates its inputs.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sys

# Exact decimal strings of huge tile values/scores (Python 3.11+ caps int->str
# conversion at 4300 digits by default).
if hasattr(sys, "set_int_max_str_digits"):
    sys.set_int_max_str_digits(0)

MASK32 = 0xFFFFFFFF
TWO_POW_32 = 1 << 32

ALGORITHM_ID = "xoshiro128ss-v1"
SEED_PREFIX = "2048-infinite/v1:"
SCHEMA_VERSION = 1
ENGINE_VERSION = "1.0.0"
CLASSIC_RULESET = "classic-v1"
PRACTICE_RULESET = "practice-v1"
DIRECTIONS = ("up", "right", "down", "left")
DEFAULT_FOUR_WEIGHT = 1
CELEBRATION_EXPONENT = 11  # 2 ** 11 == 2048

_DECIMAL_RE = re.compile(r"^(0|[1-9][0-9]*)$")
_EXPONENT_RE = re.compile(r"^[1-9][0-9]*$")


# --------------------------------------------------------------------------
# Seed derivation (decision 1)
# --------------------------------------------------------------------------

def seed_digest(seed: str) -> bytes:
    """SHA-256 of the UTF-8 bytes of "2048-infinite/v1:" + seed."""
    if not isinstance(seed, str):
        raise TypeError("seed must be a str")
    return hashlib.sha256((SEED_PREFIX + seed).encode("utf-8")).digest()


def words_from_digest(digest: bytes) -> list[int]:
    """First 16 bytes -> four little-endian uint32 words; all-zero -> [1,0,0,0]."""
    if len(digest) < 16:
        raise ValueError("digest must have at least 16 bytes")
    words = [int.from_bytes(digest[i * 4:(i + 1) * 4], "little") for i in range(4)]
    if words == [0, 0, 0, 0]:
        return [1, 0, 0, 0]
    return words


def derive_words(seed: str) -> list[int]:
    return words_from_digest(seed_digest(seed))


# --------------------------------------------------------------------------
# xoshiro128** (decision 2)
# --------------------------------------------------------------------------

def _rotl(x: int, k: int) -> int:
    return ((x << k) | (x >> (32 - k))) & MASK32


def _validate_words(words) -> list[int]:
    if not isinstance(words, (list, tuple)) or len(words) != 4:
        raise ValueError("rng words must be four uint32 values")
    out = []
    for w in words:
        if isinstance(w, bool) or not isinstance(w, int) or not 0 <= w <= MASK32:
            raise ValueError("rng word out of uint32 range: %r" % (w,))
        out.append(w)
    if out == [0, 0, 0, 0]:
        raise ValueError("all-zero xoshiro state is invalid")
    return out


class Xoshiro128ss:
    """xoshiro128** over four uint32 words. Counts raw draws for audits."""

    def __init__(self, words):
        self.s = list(_validate_words(words))
        self.draws = 0

    @classmethod
    def from_seed(cls, seed: str) -> "Xoshiro128ss":
        return cls(derive_words(seed))

    def words(self) -> list[int]:
        return list(self.s)

    def next_u32(self) -> int:
        s0, s1, s2, s3 = self.s
        result = (_rotl((s1 * 5) & MASK32, 7) * 9) & MASK32
        t = (s1 << 9) & MASK32
        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = _rotl(s3, 11)
        self.s = [s0, s1, s2, s3]
        self.draws += 1
        return result


# --------------------------------------------------------------------------
# Unbiased bounded draw (decision 3)
# --------------------------------------------------------------------------

def uniform_limit(n: int) -> int:
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= TWO_POW_32:
        raise ValueError("uniform bound must satisfy 1 <= n <= 2^32")
    return TWO_POW_32 - (TWO_POW_32 % n)


def uniform(rng: Xoshiro128ss, n: int, trace: list | None = None) -> int:
    """Rejection sampling into [0, n). Every draw (accepted or rejected)
    advances the PRNG; uniform(1) still consumes exactly one draw."""
    limit = uniform_limit(n)
    while True:
        x = rng.next_u32()
        accepted = x < limit
        if trace is not None:
            trace.append({"raw": x, "accepted": accepted})
        if accepted:
            return x % n


# --------------------------------------------------------------------------
# Board helpers
# --------------------------------------------------------------------------

def _validate_board(board) -> tuple[int, list]:
    size = board["size"]
    cells = board["cells"]
    if isinstance(size, bool) or not isinstance(size, int) or size < 1:
        raise ValueError("invalid board size")
    if len(cells) != size * size:
        raise ValueError("cells length must be size*size")
    for c in cells:
        if c is not None and (not isinstance(c, str) or not _EXPONENT_RE.match(c)):
            raise ValueError("invalid cell exponent: %r" % (c,))
    return size, list(cells)


def empty_indexes(board) -> list[int]:
    _, cells = _validate_board(board)
    return [i for i, c in enumerate(cells) if c is None]


def _line_indexes(size: int, direction: str) -> list[list[int]]:
    """Cell indexes of every line, ordered from the leading edge (the edge
    tiles move toward)."""
    lines = []
    for k in range(size):
        if direction == "left":
            lines.append([k * size + j for j in range(size)])
        elif direction == "right":
            lines.append([k * size + (size - 1 - j) for j in range(size)])
        elif direction == "up":
            lines.append([j * size + k for j in range(size)])
        elif direction == "down":
            lines.append([(size - 1 - j) * size + k for j in range(size)])
        else:
            raise ValueError("invalid direction: %r" % (direction,))
    return lines


def tile_value(exponent: str) -> int:
    return 1 << int(exponent)


def board_mass(board) -> int:
    """Sum of tile values (2 ** exponent) on the board."""
    return sum(tile_value(c) for c in board["cells"] if c is not None)


# --------------------------------------------------------------------------
# Slide / merge (decision 6)
# --------------------------------------------------------------------------

def slide(board, direction: str) -> dict:
    """Deterministic compress-then-merge. Returns
    {"board", "changed", "scoreDelta", "merges"} where merges lists
    {"to": index, "exponent": merged exponent, "value": decimal value}."""
    size, cells = _validate_board(board)
    out = [None] * (size * size)
    delta = 0
    merges = []
    for line in _line_indexes(size, direction):
        tiles = [cells[i] for i in line if cells[i] is not None]
        result = []
        i = 0
        while i < len(tiles):
            if i + 1 < len(tiles) and int(tiles[i]) == int(tiles[i + 1]):
                e = int(tiles[i]) + 1
                result.append(str(e))
                delta += 1 << e
                merges.append({"to": line[len(result) - 1], "exponent": str(e),
                               "value": str(1 << e)})
                i += 2
            else:
                result.append(tiles[i])
                i += 1
        for pos, e in enumerate(result):
            out[line[pos]] = e
    merges.sort(key=lambda m: m["to"])
    changed = out != cells
    return {"board": {"size": size, "cells": out}, "changed": changed,
            "scoreDelta": str(delta), "merges": merges}


def has_adjacent_equal(board) -> bool:
    size, cells = _validate_board(board)
    for r in range(size):
        for c in range(size):
            v = cells[r * size + c]
            if v is None:
                continue
            if c + 1 < size and cells[r * size + c + 1] == v:
                return True
            if r + 1 < size and cells[(r + 1) * size + c] == v:
                return True
    return False


def is_game_over(board) -> bool:
    """No empty cell and no horizontally/vertically adjacent equal exponents."""
    _, cells = _validate_board(board)
    if any(c is None for c in cells):
        return False
    return not has_adjacent_equal(board)


def legal_moves(board) -> list[str]:
    return [d for d in DIRECTIONS if slide(board, d)["changed"]]


# --------------------------------------------------------------------------
# Spawn (decision 4)
# --------------------------------------------------------------------------

def _four_weight(rules) -> int:
    w = DEFAULT_FOUR_WEIGHT if rules is None else rules.get("fourWeight", DEFAULT_FOUR_WEIGHT)
    if isinstance(w, bool) or not isinstance(w, int) or not 0 <= w <= 10:
        raise ValueError("fourWeight must be an integer in [0, 10]")
    return w


def spawn(board, rng: Xoshiro128ss, four_weight: int = DEFAULT_FOUR_WEIGHT,
          trace: list | None = None) -> tuple[dict, dict]:
    """Position draw first (uniform over empties, row-major), then value draw
    uniform(10): exponent "2" if v < four_weight else "1". Advances rng.
    Returns (new_board, spawn_record)."""
    size, cells = _validate_board(board)
    empties = [i for i, c in enumerate(cells) if c is None]
    if not empties:
        raise ValueError("cannot spawn on a full board")
    pos_trace: list = []
    val_trace: list = []
    k = uniform(rng, len(empties), pos_trace)
    pos = empties[k]
    v = uniform(rng, 10, val_trace)
    exponent = "2" if v < four_weight else "1"
    cells[pos] = exponent
    record = {"index": pos, "exponent": exponent, "emptyCount": len(empties),
              "positionDraw": k, "valueDraw": v}
    if trace is not None:
        trace.append({"position": pos_trace, "value": val_trace})
    return {"size": size, "cells": cells}, record


# --------------------------------------------------------------------------
# Game lifecycle (decisions 5 and 7)
# --------------------------------------------------------------------------

class EngineError(Exception):
    """Typed failure mirroring the contract's EngineError codes."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def ruleset_version(size: int) -> str:
    """Default label used by the v1 vectors when rules carry no "version"."""
    return CLASSIC_RULESET if size == 4 else PRACTICE_RULESET


def new_game(rules, seed: str, trace: list | None = None) -> dict:
    """rules: {"size": int, "fourWeight": int (default 1), "version": str (optional;
    defaults to classic-v1 for 4x4 and practice-v1 otherwise)}."""
    size = rules["size"]
    if isinstance(size, bool) or not isinstance(size, int) or size < 2:
        raise ValueError("invalid size")
    fw = _four_weight(rules)
    rng = Xoshiro128ss.from_seed(seed)
    board = {"size": size, "cells": [None] * (size * size)}
    spawns = []
    for _ in range(2):
        board, rec = spawn(board, rng, fw, trace)
        spawns.append(rec)
    state = {
        "schemaVersion": SCHEMA_VERSION,
        "engineVersion": ENGINE_VERSION,
        "rulesetVersion": rules.get("version") or ruleset_version(size),
        "board": board,
        "score": "0",
        "acceptedMoves": 0,
        "revision": 0,
        "rng": {"algorithm": ALGORITHM_ID, "words": rng.words()},
        "status": "active",
        "celebrated2048": False,
    }
    if trace is not None:
        trace.append({"spawns": spawns})
    return state


def apply_move(state, direction: str, rules=None) -> dict:
    """Returns {"state", "changed", "scoreDelta", "spawn", "draws"}.
    A no-op returns the identical (deep-copied) state, consumes zero draws.
    Raises EngineError("GAME_NOT_ACTIVE") unless status is "active"
    (CONTRACT-001 frozen decision 7). rules may carry "moveCap" (int or None):
    reaching it after a changed move sets status "completed" (decision 6)."""
    validate_state(state)
    if state["status"] != "active":
        raise EngineError("GAME_NOT_ACTIVE", "game is %s" % state["status"])
    fw = _four_weight(rules)
    move_cap = None if rules is None else rules.get("moveCap")
    slid = slide(state["board"], direction)
    if not slid["changed"]:
        return {"state": copy.deepcopy(state), "changed": False, "scoreDelta": "0",
                "spawn": None, "merges": [], "draws": 0}
    rng = Xoshiro128ss(state["rng"]["words"])
    board, rec = spawn(slid["board"], rng, fw)
    new_state = copy.deepcopy(state)
    new_state["board"] = board
    new_state["score"] = str(int(state["score"]) + int(slid["scoreDelta"]))
    new_state["acceptedMoves"] = state["acceptedMoves"] + 1
    new_state["revision"] = state["revision"] + 1
    new_state["rng"] = {"algorithm": ALGORITHM_ID, "words": rng.words()}
    if not state["celebrated2048"] and any(
            c is not None and int(c) >= CELEBRATION_EXPONENT for c in board["cells"]):
        new_state["celebrated2048"] = True
    if is_game_over(board) or (move_cap is not None and new_state["acceptedMoves"] >= move_cap):
        new_state["status"] = "completed"
    return {"state": new_state, "changed": True, "scoreDelta": slid["scoreDelta"],
            "spawn": rec, "merges": slid["merges"], "draws": rng.draws}


# --------------------------------------------------------------------------
# Validation + canonical JSON + checksum (decision 8)
# --------------------------------------------------------------------------

def validate_state(state) -> None:
    if state.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported schemaVersion")
    for key in ("engineVersion", "rulesetVersion"):
        if not isinstance(state.get(key), str):
            raise ValueError("%s must be a string" % key)
    _validate_board(state["board"])
    if not isinstance(state["score"], str) or not _DECIMAL_RE.match(state["score"]):
        raise ValueError("score must be a canonical decimal string")
    for key in ("acceptedMoves", "revision"):
        v = state[key]
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ValueError("%s must be a nonnegative integer" % key)
    if state["rng"].get("algorithm") != ALGORITHM_ID:
        raise ValueError("unsupported rng algorithm")
    _validate_words(state["rng"]["words"])
    if state["status"] not in ("active", "completed", "forfeited"):
        raise ValueError("invalid status")
    if not isinstance(state["celebrated2048"], bool):
        raise ValueError("celebrated2048 must be a boolean")


def canonical_json(state) -> str:
    """Fixed key order, no whitespace, decimal strings as strings, uint32
    words as numbers, null for empty cells."""
    validate_state(state)
    ordered = {
        "schemaVersion": state["schemaVersion"],
        "engineVersion": state["engineVersion"],
        "rulesetVersion": state["rulesetVersion"],
        "board": {"size": state["board"]["size"], "cells": list(state["board"]["cells"])},
        "score": state["score"],
        "acceptedMoves": state["acceptedMoves"],
        "revision": state["revision"],
        "rng": {"algorithm": state["rng"]["algorithm"], "words": list(state["rng"]["words"])},
        "status": state["status"],
        "celebrated2048": state["celebrated2048"],
    }
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False)


def checksum(state) -> str:
    return hashlib.sha256(canonical_json(state).encode("utf-8")).hexdigest()
