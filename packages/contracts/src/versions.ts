/** CONTRACT-001 version constants. Any change requires a reviewed CONTRACT-00N from chief. */
export const CONTRACT_VERSION = "CONTRACT-001/v1";
export const SCHEMA_VERSION = 1 as const; // GameState.schemaVersion
export const ENGINE_VERSION = "1.0.0";
export const RNG_ALGORITHM = "xoshiro128ss-v1" as const;
export const SEED_NAMESPACE = "2048-infinite/v1:"; // game spawns
export const BOT_SEED_NAMESPACE = "2048-infinite/bot/v1:"; // bot tie-breaking, never the game stream
export const REPLAY_SCHEMA_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const; // WebSocket envelope
export const ELO_ALGORITHM_VERSION = "elo-v1";
export const API_BASE = "/api/v1";
