# Auth & Rate Limiting Design for atomiq-api-docker

**Date:** 2026-04-10
**Context:** Meeting between Marci and Adam (CTO) — production-readiness for the Dockerized swap API.

## Problem

The atomiq-api-docker Express server exposes all swap endpoints publicly with no authentication or rate limiting. For production deployment by wallet providers, we need:

1. Backend-to-backend auth (wallet backend -> swap API)
2. End-user auth (wallet client -> swap API)
3. Configurable rate limiting (global default + per-auth overrides)

## Design: Unified YAML Config + Separated Auth & Rate Limit Middlewares

### Overview

A unified `config.yaml` replaces the current `.env` for all server configuration. Two separate middlewares handle concerns independently:

1. **Auth middleware** — resolves which auth path matched, attaches metadata (including rate limit override) to the request
2. **Rate limit middleware** — reads the metadata; applies the override if present, otherwise falls back to the global rate limit

### Unified Configuration

File: `config.yaml` in the project root.

```yaml
# Server
port: 3000

# Chains
starknetRpc: "https://starknet-sepolia.g.alchemy.com/..."
solanaRpc: "https://api.devnet.solana.com"
bitcoinNetwork: TESTNET   # TESTNET | MAINNET

# Global rate limit (applies when no auth-based override matches)
rateLimit:
  windowMs: 60000
  maxRequests: 10

# Auth paths — ordered array, first match wins
auth:
  - type: apiKey
    name: "Wallet Backend"
    apiKey: "sk_live_abc123..."
    header: x-api-key              # optional, defaults to x-api-key
    rateLimit: null                 # null = no rate limit

  - type: jwt
    name: "Premium Users"
    publicKey: "-----BEGIN PUBLIC KEY-----\n..."
    algorithms: [RS256]
    claims:                         # optional JWT claim matching
      user_tier: "swapper"
    rateLimit:
      windowMs: 60000
      maxRequests: 200

  - type: jwt
    name: "Standard Users"
    publicKey: "-----BEGIN PUBLIC KEY-----\n..."
    algorithms: [RS256]
    claims:
      permissions:
        includes: "swap_permission"
    rateLimit:
      windowMs: 60000
      maxRequests: 60

  - type: none
    name: "Public"
    # no rateLimit specified = uses global rateLimit
```

### Config Rules

**Top-level fields:**
- `port`: Server port (required)
- `starknetRpc`, `solanaRpc`: Chain RPC URLs (null to disable a chain)
- `bitcoinNetwork`: `TESTNET` or `MAINNET`
- `rateLimit`: Global default rate limit applied to all requests unless overridden

**Auth entry fields:**
- `type`: `"apiKey"` | `"jwt"` | `"none"`
- `name`: Label for logging
- `rateLimit`: Override for this auth path. Three states:
  - Object `{ windowMs, maxRequests }` — use this specific limit
  - `null` — no rate limit at all
  - Omitted — fall back to global `rateLimit`
- `header` (apiKey only): Which header to check. Defaults to `x-api-key`
- `publicKey` (jwt only): PEM-encoded public key for signature verification
- `algorithms` (jwt only): Allowed signing algorithms (e.g., `[RS256]`)
- `claims` (jwt only): Optional claim matchers (see below)

**Array order matters:** first successful match applies. Multiple entries of the same type supported.

### JWT Claim Matching

The optional `claims` field lets you constrain which JWTs are accepted beyond just signature verification. Two match modes:

**Exact match** — claim value must equal the specified value:
```yaml
claims:
  user_tier: "swapper"        # jwt.user_tier === "swapper"
  role: "admin"               # jwt.role === "admin"
```

**Array includes** — claim array must contain the specified value:
```yaml
claims:
  permissions:
    includes: "swap_permission"   # jwt.permissions.includes("swap_permission")
```

Both can be combined. All specified claims must match (AND logic). If `claims` is omitted, any valid JWT signed by the public key is accepted.

### Middleware Architecture

Two middlewares, applied in order before all routes:

```
Request arrives
    |
[Auth Middleware]
    |
    For each auth entry (in order):
      apiKey? -> check header value
      jwt?    -> verify signature + check claims
      none?   -> always matches
    |
    MATCHED -> attach to req:
      req.auth = { name, type }
      req.rateLimitOverride = entry's rateLimit value (object, null, or undefined)
    |
    NO MATCH -> 401 Unauthorized (stop here)
    |
[Rate Limit Middleware]
    |
    Read req.rateLimitOverride:
      object  -> apply that specific limit
      null    -> skip rate limiting entirely
      undefined -> apply global rateLimit from config
    |
    Rate limit exceeded? -> 429 Too Many Requests
    Otherwise -> continue to route handler
```

**Rate limit details:**
- Single rate limit bucket keyed by client IP address, the actual rate limits of the request apply
- In-memory storage (no Redis — single-instance Docker container)

### Startup Behavior

- `config.yaml` is required — server fails fast with a clear error if missing or malformed
- Validated at startup: required fields present, auth entries well-formed, JWT public keys parseable
- Logs: port, enabled chains, auth path count, global rate limit

### Response Codes

| Scenario | Status | Body |
|----------|--------|------|
| No auth entry matched | 401 | `{"error": "Unauthorized"}` |
| JWT invalid/expired/claims mismatch | 401 | `{"error": "Unauthorized"}` |
| Rate limit exceeded | 429 | `{"error": "Rate limit exceeded", "retryAfter": <seconds>}` |
| Auth matched, within limit | Pass through to route handler |

### File Changes

1. **`src/config.ts`** (new) — Config loader:
   - Reads and validates `config.yaml`
   - Exports typed config object used by index.ts, auth, and rate limiter

2. **`src/auth.ts`** (new) — Auth middleware:
   - Iterates auth entries, matches request
   - Attaches `req.auth` and `req.rateLimitOverride`
   - Returns 401 on no match

3. **`src/rateLimit.ts`** (new) — Rate limit middleware:
   - Reads `req.rateLimitOverride`
   - Applies appropriate rate limit or skips
   - Returns 429 when exceeded

4. **`src/index.ts`** (modify) — Wire up:
   - Replace `.env` reads with config object
   - Apply auth middleware, then rate limit middleware, before routes
   - Remove dotenv import

5. **`config.yaml.example`** (new) — Example config for operators

6. **`.env` / `.env.example`** (remove) — Replaced by config.yaml

### Dependencies

- `yaml` — YAML parsing
- `jsonwebtoken` + `@types/jsonwebtoken` — JWT signature verification
- `express-rate-limit` — Express rate limiter

### Out of Scope

- Token generation/issuance
- User management or sessions
- Redis/external store for rate limits
- Per-endpoint auth rules (all endpoints share same auth config)
- CORS handling (future addition to the same config structure)
- Custom logging destinations (stdout only, as discussed)
