# Auth & Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API key auth, JWT auth, and per-auth rate limiting to the atomiq-api-docker Express server, configured via a unified `config.yaml`.

**Architecture:** A YAML config file replaces `.env` for server settings, auth paths, and rate limits. Two Express middlewares (auth → rate limit) run in sequence before all swap routes. The auth middleware resolves which config entry matched and attaches rate limit metadata to the request. The rate limit middleware reads that metadata and applies the appropriate limit per client IP.

**Tech Stack:** Express 5, `yaml` (YAML parsing), `jsonwebtoken` (JWT verification), TypeScript

---

## File Structure

**Create:**
- `src/config.ts` — YAML config loader, types, validation
- `src/auth.ts` — Auth middleware (apiKey, jwt, none) + Express Request type augmentation
- `src/rateLimit.ts` — In-memory per-IP rate limit middleware
- `config.yaml.example` — Example config for operators

**Modify:**
- `src/index.ts` — Wire config + middlewares, remove dotenv
- `package.json` — Add yaml, jsonwebtoken; remove dotenv

**Remove:**
- `.env.example` — Replaced by `config.yaml.example`

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new dependencies**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
npm install yaml jsonwebtoken
npm install --save-dev @types/jsonwebtoken
```

- [ ] **Step 2: Remove dotenv**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
npm uninstall dotenv
```

- [ ] **Step 3: Verify package.json**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
cat package.json | grep -E '"yaml"|"jsonwebtoken"|"dotenv"'
```

Expected: `yaml` and `jsonwebtoken` present, `dotenv` absent.

- [ ] **Step 4: Commit**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
git add package.json package-lock.json
git commit -m "feat: add yaml and jsonwebtoken deps, remove dotenv"
```

---

### Task 2: Create `src/config.ts`

**Files:**
- Create: `src/config.ts`

- [ ] **Step 1: Create config.ts with types and loader**

```typescript
import {readFileSync} from "fs";
import {parse} from "yaml";
import path from "path";

export interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
}

export interface ApiKeyAuthEntry {
    type: "apiKey";
    name: string;
    apiKey: string;
    header?: string;
    rateLimit?: RateLimitConfig | null;
}

export interface JwtAuthEntry {
    type: "jwt";
    name: string;
    publicKey: string;
    algorithms: string[];
    claims?: Record<string, string | { includes: string }>;
    rateLimit?: RateLimitConfig | null;
}

export interface NoneAuthEntry {
    type: "none";
    name: string;
    rateLimit?: RateLimitConfig | null;
}

export type AuthEntry = ApiKeyAuthEntry | JwtAuthEntry | NoneAuthEntry;

export interface Config {
    port: number;
    starknetRpc: string | null;
    solanaRpc: string | null;
    bitcoinNetwork: "TESTNET" | "MAINNET";
    rateLimit: RateLimitConfig;
    auth: AuthEntry[];
}

export function loadConfig(): Config {
    const configPath = path.resolve(process.cwd(), "config.yaml");

    let raw: string;
    try {
        raw = readFileSync(configPath, "utf-8");
    } catch {
        throw new Error(`config.yaml not found at ${configPath}`);
    }

    const doc = parse(raw);
    if (!doc || typeof doc !== "object") {
        throw new Error("config.yaml is empty or malformed");
    }

    if (typeof doc.port !== "number") {
        throw new Error("config.yaml: 'port' is required and must be a number");
    }

    if (!doc.bitcoinNetwork || !["TESTNET", "MAINNET"].includes(doc.bitcoinNetwork)) {
        throw new Error("config.yaml: 'bitcoinNetwork' must be TESTNET or MAINNET");
    }

    if (!doc.rateLimit || typeof doc.rateLimit.windowMs !== "number" || typeof doc.rateLimit.maxRequests !== "number") {
        throw new Error("config.yaml: 'rateLimit' with windowMs and maxRequests is required");
    }

    if (!Array.isArray(doc.auth) || doc.auth.length === 0) {
        throw new Error("config.yaml: 'auth' must be a non-empty array");
    }

    for (const [i, entry] of doc.auth.entries()) {
        if (!entry.name || typeof entry.name !== "string") {
            throw new Error(`config.yaml: auth[${i}] must have a 'name' string`);
        }
        if (!["apiKey", "jwt", "none"].includes(entry.type)) {
            throw new Error(`config.yaml: auth[${i}] '${entry.name}' has invalid type '${entry.type}' (must be apiKey, jwt, or none)`);
        }
        if (entry.type === "apiKey") {
            if (!entry.apiKey || typeof entry.apiKey !== "string") {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' (apiKey) must have an 'apiKey' string`);
            }
        }
        if (entry.type === "jwt") {
            if (!entry.publicKey || typeof entry.publicKey !== "string") {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' (jwt) must have a 'publicKey' string`);
            }
            if (!Array.isArray(entry.algorithms) || entry.algorithms.length === 0) {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' (jwt) must have a non-empty 'algorithms' array`);
            }
        }
        if (entry.rateLimit !== undefined && entry.rateLimit !== null) {
            if (typeof entry.rateLimit.windowMs !== "number" || typeof entry.rateLimit.maxRequests !== "number") {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' rateLimit must have windowMs and maxRequests`);
            }
        }
    }

    return {
        port: doc.port,
        starknetRpc: doc.starknetRpc ?? null,
        solanaRpc: doc.solanaRpc ?? null,
        bitcoinNetwork: doc.bitcoinNetwork,
        rateLimit: doc.rateLimit,
        auth: doc.auth,
    };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
npx tsc --noEmit src/config.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
git add src/config.ts
git commit -m "feat: add config.yaml loader with types and validation"
```

---

### Task 3: Create `src/auth.ts`

**Files:**
- Create: `src/auth.ts`

- [ ] **Step 1: Create auth.ts with middleware**

```typescript
import {RequestHandler} from "express";
import jwt from "jsonwebtoken";
import {AuthEntry, Config, RateLimitConfig} from "./config";

declare global {
    namespace Express {
        interface Request {
            auth?: { name: string; type: string };
            rateLimitOverride?: RateLimitConfig | null;
        }
    }
}

function matchClaims(payload: any, claims: Record<string, any>): boolean {
    for (const [key, expected] of Object.entries(claims)) {
        const actual = payload[key];
        if (typeof expected === "object" && expected !== null && "includes" in expected) {
            if (!Array.isArray(actual) || !actual.includes(expected.includes)) return false;
        } else {
            if (actual !== expected) return false;
        }
    }
    return true;
}

function tryMatch(req: any, entry: AuthEntry): boolean {
    switch (entry.type) {
        case "apiKey": {
            const header = entry.header || "x-api-key";
            const value = req.headers[header.toLowerCase()];
            return value === entry.apiKey;
        }
        case "jwt": {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
            const token = authHeader.slice(7);
            try {
                const payload = jwt.verify(token, entry.publicKey, {
                    algorithms: entry.algorithms as jwt.Algorithm[],
                });
                if (entry.claims && !matchClaims(payload, entry.claims)) return false;
                return true;
            } catch {
                return false;
            }
        }
        case "none":
            return true;
        default:
            return false;
    }
}

export function createAuthMiddleware(config: Config): RequestHandler {
    return (req, res, next) => {
        for (const entry of config.auth) {
            if (tryMatch(req, entry)) {
                req.auth = { name: entry.name, type: entry.type };
                req.rateLimitOverride = entry.rateLimit;
                next();
                return;
            }
        }
        res.status(401).json({ error: "Unauthorized" });
    };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
npx tsc --noEmit src/auth.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
git add src/auth.ts
git commit -m "feat: add auth middleware with apiKey, jwt, and none strategies"
```

---

### Task 4: Create `src/rateLimit.ts`

**Files:**
- Create: `src/rateLimit.ts`

- [ ] **Step 1: Create rateLimit.ts with middleware**

```typescript
import {RequestHandler} from "express";
import {RateLimitConfig} from "./config";

const buckets = new Map<string, { count: number; resetAt: number }>();

export function createRateLimitMiddleware(globalConfig: RateLimitConfig): RequestHandler {
    return (req, res, next) => {
        const override = req.rateLimitOverride;

        // null = no rate limit for this auth path
        if (override === null) {
            next();
            return;
        }

        const config = override || globalConfig;
        const ip = req.ip || "unknown";
        const now = Date.now();

        let bucket = buckets.get(ip);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + config.windowMs };
            buckets.set(ip, bucket);
        }

        bucket.count++;

        if (bucket.count > config.maxRequests) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.status(429).json({ error: "Rate limit exceeded", retryAfter });
            return;
        }

        next();
    };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
npx tsc --noEmit src/rateLimit.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
git add src/rateLimit.ts
git commit -m "feat: add in-memory rate limit middleware with per-auth overrides"
```

---

### Task 5: Modify `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace index.ts contents**

Replace the entire file with:

```typescript
import express from "express";
import morgan from "morgan";
import {SwapperFactory, BitcoinNetwork} from "@atomiqlabs/sdk";
import {SqliteUnifiedStorage, SqliteStorageManager} from "@atomiqlabs/storage-sqlite";
import {StarknetInitializer} from "@atomiqlabs/chain-starknet";
import {SwapperApi} from "@atomiqlabs/sdk/api";
import {SolanaInitializer} from "@atomiqlabs/chain-solana";
import {loadConfig} from "./config";
import {createAuthMiddleware} from "./auth";
import {createRateLimitMiddleware} from "./rateLimit";


(global as any).atomiqLogLevel = 3;

const config = loadConfig();

const bitcoinNetwork = config.bitcoinNetwork === "MAINNET" ? BitcoinNetwork.MAINNET : BitcoinNetwork.TESTNET;

const chains = [StarknetInitializer, SolanaInitializer] as const;

const Factory = new SwapperFactory(chains);

const swapper = Factory.newSwapper({
    chains: {
        STARKNET: config.starknetRpc == null ? null! : {
            rpcUrl: config.starknetRpc
        },
        SOLANA: config.solanaRpc == null ? null! : {
            rpcUrl: config.solanaRpc
        }
    },
    bitcoinNetwork,
    swapStorage: chainId => new SqliteUnifiedStorage("CHAIN_" + chainId + ".sqlite3"),
    chainStorageCtor: name => new SqliteStorageManager("STORE_" + name + ".sqlite3"),
});

const api = new SwapperApi(swapper);

const app = express();
app.use(morgan("combined"));
app.use(express.json());

// Health check (before auth — always accessible)
app.get("/health", (_req, res) => {
    res.json({status: "ok"});
});

// Auth + Rate limiting
app.use(createAuthMiddleware(config));
app.use(createRateLimitMiddleware(config.rateLimit));

// Wire up SwapperApi endpoints
for (const [name, endpoint] of Object.entries(api.endpoints)) {
    const path = "/" + name;
    const handler = async (req: express.Request, res: express.Response) => {
        try {
            const result = await endpoint.callbackRaw(
                endpoint.type === "GET" ? req.query : req.body
            );
            res.json(result);
        } catch (err: any) {
            console.warn(err);
            res.status(400).json({error: err.message});
        }
    };

    if (endpoint.type === "GET") {
        app.get(path, handler);
    } else {
        app.post(path, handler);
    }
    console.log(`  ${endpoint.type} ${path}`);
}

async function main() {
    console.log("Initializing SwapperApi...");
    await api.init();
    console.log("SwapperApi initialized.");

    console.log(`Auth paths: ${config.auth.length}`);
    console.log(`Global rate limit: ${config.rateLimit.maxRequests} req / ${config.rateLimit.windowMs}ms`);
    console.log(`Chains: Starknet=${config.starknetRpc ? "enabled" : "disabled"}, Solana=${config.solanaRpc ? "enabled" : "disabled"}`);
    console.log(`Bitcoin network: ${config.bitcoinNetwork}`);

    app.listen(config.port, () => {
        console.log(`atomiq-api listening on port ${config.port}`);
    });
}

main().catch(err => {
    console.error("Failed to start:", err);
    process.exit(1);
});
```

Changes from original:
- Removed `import "dotenv/config"`
- Replaced `process.env.*` reads with `config.*` from `loadConfig()`
- Added `createAuthMiddleware` and `createRateLimitMiddleware` as `app.use()` after health check, before swap routes
- Added startup log lines for auth path count, rate limit, chains, and network

- [ ] **Step 2: Build the project**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
npx tsc
```

Expected: No errors. `dist/` contains compiled JS for all source files.

- [ ] **Step 3: Commit**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
git add src/index.ts
git commit -m "feat: wire auth and rate limit middlewares, replace dotenv with config.yaml"
```

---

### Task 6: Create `config.yaml.example` and Remove `.env.example`

**Files:**
- Create: `config.yaml.example`
- Remove: `.env.example`

- [ ] **Step 1: Create config.yaml.example**

```yaml
# Server
port: 3000

# Chains (set to null to disable a chain)
starknetRpc: "https://starknet-sepolia.g.alchemy.com/..."
solanaRpc: "https://api.devnet.solana.com"
bitcoinNetwork: TESTNET   # TESTNET | MAINNET

# Global rate limit (applies when no auth-based override matches)
rateLimit:
  windowMs: 60000
  maxRequests: 10

# Auth paths — ordered array, first match wins
auth:
  # Backend-to-backend: API key with no rate limit
  - type: apiKey
    name: "Wallet Backend"
    apiKey: "your-api-key-here"
    header: x-api-key              # optional, defaults to x-api-key
    rateLimit: null                 # null = no rate limit

  # JWT auth with elevated rate limit
  - type: jwt
    name: "Premium Users"
    publicKey: "-----BEGIN PUBLIC KEY-----\nYOUR_PUBLIC_KEY_HERE\n-----END PUBLIC KEY-----"
    algorithms: [RS256]
    claims:                         # optional JWT claim matching
      user_tier: "swapper"
    rateLimit:
      windowMs: 60000
      maxRequests: 200

  # JWT auth with array-includes claim matching
  # - type: jwt
  #   name: "Standard Users"
  #   publicKey: "-----BEGIN PUBLIC KEY-----\nYOUR_PUBLIC_KEY_HERE\n-----END PUBLIC KEY-----"
  #   algorithms: [RS256]
  #   claims:
  #     permissions:
  #       includes: "swap_permission"
  #   rateLimit:
  #     windowMs: 60000
  #     maxRequests: 60

  # Public access (uses global rate limit)
  - type: none
    name: "Public"
    # no rateLimit specified = uses global rateLimit
```

- [ ] **Step 2: Remove .env.example**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
rm .env.example
```

- [ ] **Step 3: Commit**

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
git add config.yaml.example
git rm .env.example
git commit -m "feat: add config.yaml.example, remove .env.example"
```

---

### Task 7: Manual Verification

- [ ] **Step 1: Create a local config.yaml for testing**

Copy the example and set real values matching the current `.env`:

```bash
cd /Users/marci/dev/Atomiq/atomiq-api-docker
cp config.yaml.example config.yaml
```

Then edit `config.yaml` — set `starknetRpc` and `solanaRpc` to the actual RPC URLs, and set a known `apiKey` for testing (e.g., `"test-key-123"`).

- [ ] **Step 2: Verify config validation (missing file)**

```bash
cd /tmp && node /Users/marci/dev/Atomiq/atomiq-api-docker/dist/config.js 2>&1 || true
```

Expected: Error about missing config.yaml.

- [ ] **Step 3: Test auth with curl (unauthenticated → 401)**

```bash
curl -s http://localhost:3000/getSwapQuote | jq .
```

Expected: `{"error": "Unauthorized"}` with HTTP 401.

- [ ] **Step 4: Test auth with curl (API key → success)**

```bash
curl -s -H "x-api-key: test-key-123" http://localhost:3000/health
```

Note: `/health` is before auth middleware, so it always returns 200. Test a swap endpoint instead:

```bash
curl -s -H "x-api-key: test-key-123" http://localhost:3000/getSwapQuote | jq .
```

Expected: 400 (missing params) or valid response — not 401.

- [ ] **Step 5: Test rate limiting (hit the limit)**

With the `none` auth entry using global rate limit (10 req/min):

```bash
for i in $(seq 1 12); do
  echo "Request $i: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/getSwapQuote)"
done
```

Expected: First 10 return 401 or 400, requests 11+ return 429 (if `none` entry is present and matches).
