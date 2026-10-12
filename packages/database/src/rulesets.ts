import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  PRACTICE_RULESET_VERSION,
  RULESETS,
  type Ruleset,
} from "@g2048/contracts";
import { MigrationError } from "./errors.js";

/** Fixed key order for canonical ruleset JSON (the `Ruleset` field order in CONTRACT-001). */
export const CANONICAL_RULESET_KEYS = [
  "version",
  "size",
  "fourWeight",
  "moveCap",
  "undo",
  "historyLimit",
  "ranked",
] as const satisfies readonly (keyof Ruleset)[];

/** Canonical JSON of a built-in ruleset: fixed key order, no whitespace. */
export function canonicalRulesetJson(rules: Ruleset): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_RULESET_KEYS) ordered[key] = rules[key];
  return JSON.stringify(ordered);
}

/**
 * practice-v1 is parameterized per game (size, fourWeight, undo). Its catalogue row stores the
 * immutable template; each practice game stores its effective rules in games.rules_json.
 */
export const PRACTICE_TEMPLATE_JSON = JSON.stringify({
  version: PRACTICE_RULESET_VERSION,
  sizeMin: MIN_BOARD_SIZE,
  sizeMax: MAX_BOARD_SIZE,
  fourWeightMin: 0,
  fourWeightMax: 10,
  moveCap: null,
  historyLimit: 100,
  ranked: false,
});

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type CatalogueRuleset = { version: string; rulesJson: string; digest: string };

export function builtinRulesetCatalogue(): CatalogueRuleset[] {
  const entries: CatalogueRuleset[] = Object.values(RULESETS).map((rules) => {
    const rulesJson = canonicalRulesetJson(rules);
    return { version: rules.version, rulesJson, digest: sha256Hex(rulesJson) };
  });
  entries.push({
    version: PRACTICE_RULESET_VERSION,
    rulesJson: PRACTICE_TEMPLATE_JSON,
    digest: sha256Hex(PRACTICE_TEMPLATE_JSON),
  });
  return entries;
}

/**
 * Inserts any missing built-in rulesets and verifies stored ones byte-for-byte via digest.
 * A changed ruleset under an existing version is an integrity failure (rulesets are immutable;
 * a new rule set needs a new version). Must run inside the caller's write transaction.
 */
export function syncBuiltinRulesets(db: DatabaseSync, now: string): string[] {
  const inserted: string[] = [];
  const select = db.prepare("SELECT rules_json, digest FROM rulesets WHERE version = ?");
  const insert = db.prepare(
    "INSERT INTO rulesets (version, rules_json, digest, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const entry of builtinRulesetCatalogue()) {
    const row = select.get(entry.version) as { rules_json: string; digest: string } | undefined;
    if (!row) {
      insert.run(entry.version, entry.rulesJson, entry.digest, now);
      inserted.push(entry.version);
      continue;
    }
    if (row.digest !== entry.digest || sha256Hex(row.rules_json) !== row.digest) {
      throw new MigrationError(
        `Ruleset ${entry.version} in the database differs from this build (digest mismatch); refusing to start`,
      );
    }
  }
  return inserted;
}
