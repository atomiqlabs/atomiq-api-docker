# Auth & Rate Limiting Design for atomiq-api-docker

**Date:** 2026-04-10
**Context:** Meeting between Marci and Adam (CTO) — production-readiness for the Dockerized swap API.

## Problem

The atomiq-api-docker Express server exposes all swap endpoints publicly with no authentication or rate limiting. For production deployment by wallet providers, we need:

1. Backend-to-backend auth (wallet backend -> swap API)
2. End-user auth (wallet client -> swap API)
3. Per-auth-path rate limiting
4. Backwards compatibility (no config = current behavior)

## Design: Single Middleware with Flat Config Array

### Overview

A single Express middleware runs before all routes. It checks an ordered array of auth path configs. First match wins. Each auth path has its own rate limit settings.

### Auth Types

**API Key** — Static string in config. Checked via request header. Intended for server-to-server communication where the key stays hidden on the backend.

**JWT** — Verify-only (we never generate tokens). Configured with a public key. Accepts any JWT signed by that key. Intended for end-user clients. Multiple JWT entries with different keys enable tiered access (e.g., premium vs standard users).

**None** — Catch-all for unauthenticated access. Typically paired with a very restrictive rate limit.

### Configuration

File: `auth.config.json` in the project root (hardcoded path, no env var).

```jsonc
{
  "auth": [
    {
      "type": "apiKey",
      "name": "Wallet Backend",
      "apiKey": "sk_live_abc123...",
      "header": "x-api-key",
      "rateLimit": null
    },
    {
      "type": "jwt",
      "name": "Premium Users",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
      "algorithms": ["RS256"],
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 200
      }
    },
    {
      "type": "jwt",
      "name": "Standard Users",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
      "algorithms": ["RS256"],
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 60
      }
    },
    {
      "type": "none",
      "name": "Public",
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 10
      }
    }
  ]
}
```

**Config rules:**
- `type`: `"apiKey"` | `"jwt"` | `"none"`
- `name`: Label for logging (identifies which path matched)
- `rateLimit`: Object with `windowMs` and `maxRequests`, or `null` to disable
- `header`: For apiKey type, which header to check (defaults to `x-api-key`)
- `algorithms`: For JWT type, allowed signing algorithms
- Array order matters: first successful match applies
- Multiple entries of the same type are supported (e.g., multiple JWT tiers)

### Middleware Flow

```
Request arrives
    |
For each auth entry in config (in order):
    |
    apiKey? -> Check header matches -> if yes: MATCHED
    jwt?    -> Check Bearer token, verify signature -> if yes: MATCHED
    none?   -> Always matches (catch-all)
    |
If MATCHED:
    -> Apply that entry's rate limit (if configured)
    -> Rate limit exceeded? -> 429 Too Many Requests
    -> Otherwise -> attach auth info to req, continue to route
    |
If NO MATCH (all entries tried, none matched):
    -> 401 Unauthorized
```

**Behaviors:**
- Empty config array or missing config file: all requests pass through (backwards compatible)
- Auth info attached to `req.auth = { name, type }` for downstream logging
- Each auth entry gets its own independent rate limit bucket
- Rate limit buckets keyed by client IP address
- Rate limiting is in-memory (no Redis — single-instance Docker container)
- JWT verification uses `jsonwebtoken` library
- Rate limiting uses `express-rate-limit` library

### Startup Behavior

- `auth.config.json` exists: load, validate, log auth path count
- `auth.config.json` missing: no auth, no rate limiting (current behavior)
- `auth.config.json` malformed: fail fast with clear error

### Response Codes

| Scenario | Status | Body |
|----------|--------|------|
| No auth entry matched | 401 | `{"error": "Unauthorized"}` |
| JWT malformed/expired/wrong sig | 401 | `{"error": "Unauthorized"}` |
| Rate limit exceeded | 429 | `{"error": "Rate limit exceeded", "retryAfter": <seconds>}` |
| Auth matched, within limit | Pass through to route handler |

### File Changes

1. **`src/auth.ts`** (new) — Auth middleware module:
   - Loads and validates `auth.config.json` at startup
   - Exports a single middleware function
   - Contains match logic (apiKey check, JWT verify, none)
   - Creates per-entry rate limiters
   - Attaches `req.auth` with `{ name, type }`

2. **`src/index.ts`** (modify) — Wire up middleware:
   - Import and apply auth middleware before route registration
   - Minimal change (~3 lines)

3. **`auth.config.json.example`** (new) — Example config for operators:
   - Shows all three auth types
   - Operators copy to `auth.config.json` and customize

### Dependencies

- `jsonwebtoken` + `@types/jsonwebtoken` — JWT signature verification
- `express-rate-limit` — Proven Express rate limiter

### Out of Scope

- Token generation/issuance
- User management or sessions
- Redis/external store for rate limits
- Per-endpoint auth rules (all endpoints share same auth config)
- CORS handling (future addition to the same config structure)
- Custom logging destinations (stdout only, as discussed)
