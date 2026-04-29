# atomiq-api-docker

A dockerized HTTP API for the [Atomiq](https://atomiq.exchange) cross-chain DEX.

It lets you offer trustless swaps between **Bitcoin / Lightning** and smart chains (**Starknet, Solana, Botanix, Citrea, Alpen, Goat**) without bundling the full Atomiq SDK into every mobile, extension, or web client.

This document is written for integrators at wallet companies (think Xverse, Leather, or Phantom-style wallets), but it's just as useful if you simply want to run `atomiq-api-docker` as part of your own infrastructure and expose swaps to your users.

> The repo also contains helper scripts in `scripts/` (`create-swap.ts`, `process-swap.ts`, `generate-jwt.ts`, `test-all-directions.ts`). Those are a reference client / test harness, not part of the API surface. This README focuses on the **API** you deploy.

---

## Contents

- [What this service is](#what-this-service-is)
- [System architecture](#system-architecture)
- [Where Atomiq liquidity comes from](#where-atomiq-liquidity-comes-from)
- [Quick start](#quick-start)
- [Configuration (`config.yaml`)](#configuration-configyaml)
- [Authentication model](#authentication-model)
- [Rate limiting](#rate-limiting)
- [HTTPS and certificate reload](#https-and-certificate-reload)
- [API reference](#api-reference)
- [Swap lifecycle](#swap-lifecycle)
- [Action types returned by `getSwapStatus`](#action-types-returned-by-getswapstatus)
- [Lightning and LNURL](#lightning-and-lnurl)
- [Persistence](#persistence)
- [Background maintenance timers](#background-maintenance-timers)
- [Error handling](#error-handling)
- [Security notes](#security-notes)

---

## What this service is

`atomiq-api-docker` is a thin, stateful HTTP layer over the Atomiq SDK:

- Exposes **10 HTTP endpoints** (quoting, creating, listing, polling, submitting swaps).
- Holds the **local swap database** (SQLite files mounted into the container) and keeps them in sync in the background.
- Provides **API-key** and **JWT** auth with per-path rate-limit overrides, so the same instance can serve both a trusted backend and untrusted public clients.
- Supports **HTTPS with hot certificate reload**, so you can run it directly with `certbot`-based TLS/SSL certificate provisioning

### What it deliberately is not

- **Not a custodian.** Atomiq swaps are trustless HTLC / PSBT / SPV-vault flows — the API never holds user keys. All signing happens in the **client wallet**; the API only generates unsigned transactions and submits signed ones.
- **Not a UI.** It is a backend service. You build the wallet UX around it.

---

## System architecture

At a glance, the API sits between a wallet client and the Atomiq liquidity network plus the underlying chains. It coordinates quotes from LPs, reads from and submits transactions to Bitcoin and the smart chains, and persists swap state locally. The wallet client meanwhile keeps custody of keys and signs whatever the swap flow requires, as the API itself never holds funds or signing material.

![System architecture](docs/docker-swap-backend.svg)


Typical deployment: the wallet backend runs the container on an internal network, and terminates TLS on it directly (or behind a reverse proxy).

---

## Quick start

### Prerequisites

- Docker 24+ with the Docker Compose plugin (`docker compose` v2).

### 1. Build the image

```bash
sh build.sh
# equivalent to: docker build -t atomiqlabs/api .
```

The final image is Alpine-based, ~280 MB.

### 2. Create `config/config.yaml`

Start from `config/config.yaml.example`:

```bash
cp config/config.yaml.example config/config.yaml
```

Minimum viable config (testnet, public access, no TLS):

```yaml
port: 3000
logLevel: info

starknetRpc: "https://rpc.starknet.lava.build/"
solanaRpc:   "https://api.devnet.solana.com"
botanixRpc: null
citreaRpc: null
alpenRpc: null
goatRpc: null
bitcoinNetwork: TESTNET

cors:
  origin: "*"

rateLimit:
  windowMs: 60000
  maxRequests: 200

auth:
  - type: none
    name: "Public"
```

#### Setting up RPC endpoints

Before the service can talk to a smart chain, you need to give it an RPC URL for that chain. Three common options:

1. **Public / community RPCs** — free endpoints like `https://api.mainnet-beta.solana.com` or `https://rpc.starknet.lava.build/`. Easiest to start with, but typically rate-limited and not reliable enough for production.
2. **Hosted providers** — services like Alchemy, Infura, QuickNode, Helius (Solana), Lava, etc. give you a private URL with a generous free tier and paid plans once traffic grows.
3. **Self-hosted node** — run your own full node and point the API at it. Most control, most operational overhead.

Whichever you pick, paste the URL into the matching key in `config.yaml`. Leave a key out, or set it to `null`, to disable that chain entirely.

A few things to double-check:

- Make sure the **network of each RPC matches the rest of your config** — e.g. don't combine a mainnet Solana RPC with `bitcoinNetwork: TESTNET`. See more details on network compatibility [here](https://docs.atomiq.exchange/developers/quick-start/).
- **Mainnet Bitcoin** is configured by network name only (`bitcoinNetwork: MAINNET`) and does not need an RPC.

### 3. Run

Use the bundled `docker-compose.yml`:

```bash
docker compose up -d
# if this doesn't work, try: docker-compose up -d
```

This starts the service on port `3000`, mounts `./config` read-only, and persists the SQLite swap databases in the host `./storage` directory so they survive container restarts — see [Persistence](#persistence). The bundled compose file also sets `CONFIG_PATH=/src/config/config.yaml` and `STORAGE_DIR=/src/storage`.

You can check the API server's logs with:

```bash
docker compose logs -f
# if this doesn't work, try: docker-compose logs -f
```

On startup you should see:

```
Initializing SwapperApi...
SwapperApi initialized.
Chains: STARKNET, SOLANA, ...
atomiq-api listening on port 3000
  POST /createSwap
  GET  /listSwaps
  ...
```

### 4. Smoke test

```bash
curl "http://localhost:3000/getSupportedTokens?side=INPUT"
```

---

## Configuration (`config.yaml`)

The service reads its entire runtime config from a single YAML file. It is configured using the `CONFIG_PATH` environment variable, by default the file is located in `config/config.yaml`:

Top-level keys:

| Key                                                                               | Type                                          | Default                 | Description                                                                                        |
|-----------------------------------------------------------------------------------|-----------------------------------------------|-------------------------|----------------------------------------------------------------------------------------------------|
| `port`                                                                            | number                                        | **required**            | TCP port the server binds to.                                                                      |
| `logLevel`                                                                        | `error`\|`warn`\|`info`\|`debug`              | `info`                  | `info` = morgan HTTP logs; `debug` = verbose per-request log line incl. IP, XFF, UA.               |
| `bitcoinNetwork`                                                                  | `MAINNET`\|`TESTNET`\|`TESTNET3`\|`TESTNET4`  | **required**            | Which Bitcoin network the SDK connects to. `TESTNET` is an alias for `TESTNET3`.                   |
| `starknetRpc` / `solanaRpc` / `botanixRpc` / `citreaRpc` / `alpenRpc` / `goatRpc` | string or null                                | null (disabled)         | RPC URL per smart chain. Omit / set to null to disable that chain.                                 |
| `swapsSyncIntervalSeconds`                                                        | number                                        | 300                     | Interval between background `SwapperApi.sync()` calls (purges expired swaps, refreshes state).     |
| `reloadLpIntervalSeconds`                                                         | number                                        | 300                     | Interval between background LP reloads (re-discovers dropped LPs).                                 |
| `cors`                                                                            | object or null                                | null (disabled)         | Passed through to the [`cors`](https://github.com/expressjs/cors) middleware.                      |
| `rateLimit`                                                                       | `{ windowMs, maxRequests }`                   | **required**            | Global fallback rate limit (applied when an auth path does not override).                          |
| `auth`                                                                            | array                                         | **required**, non-empty | Ordered list of auth paths — see below.                                                            |
| `https`                                                                           | `{ keyPath, certPath }` or null               | null (HTTP)             | TLS config. Paths are resolved relative to the config file.                                        |
| `trustProxy`                                                                      | boolean                                      | `false`                       | When running the API behind a reverse proxy, set this to `true` to properly parse the user's IP addresses |

---

## Authentication model

`auth` is an **ordered array** — the first entry that matches a request wins. Each entry can optionally set its own `rateLimit` (or `null` to disable rate limiting entirely on that path).

Three entry types:

```yaml
auth:
  # 1. Backend-to-backend: trusted wallet backend
  - type: apiKey
    name: "Wallet Backend"
    apiKey: "replace-with-long-random-secret"
    header: x-api-key          # optional, default x-api-key
    rateLimit: null             # null = no rate limit on this path

  # 2. End-user auth: JWT signed by your auth service
  - type: jwt
    name: "Premium Users"
    publicKey: "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
    algorithms: [RS256]         # or [ES256], etc.
    claims:                     # optional — all claims must match
      user_tier: "swapper"
    rateLimit:
      windowMs: 60000
      maxRequests: 200

  # 3. Open fallback (uses global rateLimit)
  - type: none
    name: "Public"
```

### API-key auth

Any client that can present the configured shared secret in a header (default `x-api-key`) is authorized on this path.

```http
GET /listSwaps?signer=0x... HTTP/1.1
x-api-key: replace-with-long-random-secret
```

Treat the API key as a shared secret. Whether you ship it to a trusted backend, embed it in a first-party frontend, or hand it to an operator depends on your threat model — just never expose it to clients you do not control.

### JWT auth

Requests are authorized by a signed JWT in the `Authorization: Bearer <jwt>` header. The service verifies the signature against the public key in `config.yaml`, enforces the standard `exp` claim, and checks any additional `claims` you require on the auth entry.

The `claims` field lets you gate an auth path on arbitrary JWT payload fields, so the same instance can serve different user tiers from a single signing authority. Two forms are supported:

- **Exact match** — the JWT payload must contain the field with that exact value:

  ```yaml
  claims:
    user_tier: "swapper"
  ```

- **Array-includes** — the JWT payload's array field must contain the given value:

  ```yaml
  claims:
    permissions:
      includes: "swap_permission"
  ```

All listed claims must match for the entry to authorize the request; otherwise the auth chain falls through to the next entry.

How the JWT is minted is out of scope — issue it from any auth system whose public key you can paste into `config.yaml`. A bundled helper script (`scripts/generate-jwt.ts`) generates a key pair and signs a test JWT for local development.

### Public / no-auth

`type: none` matches any request. Put it last if you want to offer anonymous access; omit it if all traffic must be authenticated.

---

## Rate limiting

Uses in-memory bucketing per client IP, with a fixed window.

- Each auth entry can set its own `rateLimit: { windowMs, maxRequests }` or explicitly `null` (no limit — typical for `apiKey` backend traffic).
- If an auth entry has **no** `rateLimit` key, the **global** `rateLimit` from the top level applies.
- Exceeding the limit returns `429 { error: "Rate limit exceeded", retryAfter }`.

---

## HTTPS and certificate reload

Set `https` in the config to run TLS directly:

```yaml
https:
  keyPath: "./tls/server.key"
  certPath: "./tls/server.cert"
```

Both paths are resolved relative to the `config.yaml` file. With the bundled compose layout that means you can keep the certificate, key, or symlinks to them under `config/tls/` and mount the whole config directory into the container read-only.

The server watches both files with a 1 s poll interval. On any change it schedules a **60 s-delayed reload** (debounced) via `server.setSecureContext(...)` — Node keeps serving existing connections during the swap. This is designed to work cleanly with Let's Encrypt / certbot renewal hooks: the renewal hook writes both files, the server picks them up within a minute without a restart.

---

## Running behind reverse proxy

Set the `trustProxy` config option if you run the API behind a reverse proxy and want to correctly resolve client IP addresses (important for rate limitting)

```yaml
trustProxy: true
```

You can also let the reverse proxy handle the HTTPS connections and then don't have to setup the `https` for the API

---

## API reference

All endpoints live at the root (`/`). Names and shapes come directly from the SDK's `SwapperApi.endpoints`. `GET` endpoints read their parameters from the query string; `POST` endpoints read a JSON body.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/getSupportedTokens` | Tokens usable as input or output. |
| `GET`  | `/getSwapCounterTokens` | Tokens that can pair with a given token. |
| `GET`  | `/getSwapLimits` | Min / max amounts between a token pair. |
| `GET`  | `/parseAddress` | Parse an address / invoice / LNURL / URI. |
| `GET`  | `/getSpendableBalance` | Wallet balance net of fees, for a given token. |
| `POST` | `/createSwap` | Request a quote and open a swap. |
| `GET`  | `/getSwapStatus` | Poll for the next action the wallet must take. |
| `POST` | `/submitTransaction` | Submit signed transactions back. |
| `GET`  | `/listSwaps` | All swaps for a signer (optionally scoped by chain). |
| `GET`  | `/listActionableSwaps` | Swaps that currently need the user's attention. |

### Token identifiers

Tokens are identified by the string containing the network and the ticker, generally `<network>-<ticker>`. Typical values:

- `BITCOIN-BTC` (on-chain Bitcoin)
- `LIGHTNING-BTC` (Lightning BTC)
- `STARKNET-STRK`, `STARKNET-ETH`, `STARKNET-<erc20-address>`
- `SOLANA-SOL`, `SOLANA-<spl-mint>`
- `CITREA-CBTC`, `BOTANIX-BTC`, etc.

Use `GET /getSupportedTokens` to enumerate what the current LP set supports.

### `POST /createSwap`

Creates a swap and returns a quote.

Request body:

| Field | Type | Required | Notes                                                                                                           |
|---|---|---|-----------------------------------------------------------------------------------------------------------------|
| `srcToken` | string | ✓ | e.g. `BITCOIN-BTC`, `STARKNET-STRK`.                                                                            |
| `dstToken` | string | ✓ |                                                                                                                 |
| `amount` | bigint (as string) | ✓ | Base units.                                                                                                     |
| `amountType` | `EXACT_IN` \| `EXACT_OUT` | ✓ |                                                                                                                 |
| `srcAddress` | string | (✓ for smart → BTC/LN) | Also supports LNURL-withdraw link when `srcToken = LIGHTNING-BTC`.                                                    |
| `dstAddress` | string | ✓ | Destination on the output chain. Also: LNURL-pay link, Lightning invoice, etc. when `dstToken = LIGHTNING-BTC`. |
| `gasAmount` | bigint | optional | Gas token to drop on the destination chain.                                                                     |
| `paymentHash` | hex string | optional | Client-supplied payment hash for Lightning swaps (so the client can retain the preimage).                       |
| `description` / `descriptionHash` | string / hex | optional | Lightning invoice metadata.                                                                                     |
| `expirySeconds` | number | optional | Custom quote expiry.                                                                                            |

Response body is a **swap record**:

```jsonc
{
  "swapId": "…",
  "swapType": "FROM_BTC_LN_AUTO",
  "state": { "number": 1, "name": "CREATED", "description": "…" },
  "quote": {
    "inputAmount":  { "amount": "0.00003", "rawAmount": "3000", "decimals": 8, "symbol": "BTC", "chain": "BITCOIN" },
    "outputAmount": { "amount": "4.21",    "rawAmount": "4210000000000000000", "decimals": 18, "symbol": "STRK", "chain": "STARKNET" },
    "fees": {
      "swap":          { "amount": "0.000001", "rawAmount": "100", "decimals": 8, "symbol": "BTC", "chain": "BITCOIN" },
      "networkOutput": { "amount": "…", "rawAmount": "…", "decimals": 0, "symbol": "…", "chain": "…" }
    },
    "expiry": 1713360000000
  },
  "createdAt": 1713359700000,
  "steps": [ /* SwapExecutionStep[] — hints for UX, see below */ ]
}
```

#### Swap execution steps

`steps` is a UX hint that describes the swap as a linear sequence of stages the user progresses through. Each step declares which side of the swap it belongs to (`source` / `destination`), the relevant `chain`, a human-readable `title` / `description`, and a `status` that advances as the swap moves forward. Steps are best used to render a progress strip in the wallet UI; the actionable state lives in `currentAction` returned by `getSwapStatus`.

| `type` | Meaning | Statuses |
|---|---|---|
| `Setup` | Destination-side setup required before the swap can continue (e.g. creating the destination HTLC / escrow). | `awaiting`, `completed`, `soft_expired`, `expired` |
| `Payment` | The user's payment that initiates or funds the swap on the source side. | `inactive`, `awaiting`, `received`, `confirmed`, `soft_expired`, `expired` |
| `Settlement` | Payout / settlement on the destination side. | `inactive`, `waiting_lp`, `awaiting_automatic`, `awaiting_manual`, `soft_settled`, `soft_expired`, `settled`, `expired` |
| `Refund` | Source-side refund path after a failed swap. | `inactive`, `awaiting`, `refunded` |

Bitcoin `Payment` steps additionally include a `confirmations: { current, target, etaSeconds }` progress object once the funding transaction has been seen on-chain. All step objects carry `initTxId`, `settleTxId`, `setupTxId`, or `refundTxId` fields as the relevant transactions are broadcast — these are convenient to link into a block explorer.

### `GET /getSwapStatus`

Polled continuously by the client. Returns the **current action** the wallet must perform.

Query parameters:

| Field | Type | Required | Notes |
|---|---|---|---|
| `swapId` | string | ✓ | |
| `secret` | hex | optional | Lightning preimage to reveal — see [Lightning and LNURL](#lightning-and-lnurl). |
| `bitcoinAddress` | string | optional | Needed when the swap will produce a PSBT for the client's BTC wallet. |
| `bitcoinPublicKey` | hex | optional | Must be passed together with `bitcoinAddress`. |
| `bitcoinFeeRate` | number | optional | sat/vB override for PSBT building. |
| `signer` | string | optional | Alternative smart-chain signer for refunds / manual settlement. |

Response extends the swap record with:

```jsonc
{
  "swapId": "…",
  "swapType": "FROM_BTC_LN_AUTO",
  "state": { "number": 1, "name": "CREATED", "description": "…" },
  "quote": {
    "inputAmount":  { "amount": "0.00003", "rawAmount": "3000", "decimals": 8, "symbol": "BTC", "chain": "BITCOIN" },
    "outputAmount": { "amount": "4.21",    "rawAmount": "4210000000000000000", "decimals": 18, "symbol": "STRK", "chain": "STARKNET" },
    "fees": {
      "swap":          { "amount": "0.000001", "rawAmount": "100", "decimals": 8, "symbol": "BTC", "chain": "BITCOIN" },
      "networkOutput": { "amount": "…", "rawAmount": "…", "decimals": 0, "symbol": "…", "chain": "…" }
    },
    "expiry": 1713360000000
  },
  "createdAt": 1713359700000,
  "steps": [ /* SwapExecutionStep[] — hints for UX */ ]
  "isFinished": false,
  "isSuccess":  false,
  "isFailed":   false,
  "isExpired":  false,
  "currentAction": { "type": "SendToAddress" },
  "requiresSecretReveal": false
}
```

See [Action types](#action-types-returned-by-getswapstatus) for the shapes of `currentAction`.

### `POST /submitTransaction`

Submits client-signed transactions.

```jsonc
{ "swapId": "…", "signedTxs": ["<hex>", "<hex>"] }
```

- **SignPSBT** → each `signedTxs[i]` is the **hex-encoded or base64-encoded signed PSBT**.
- **SignSmartChainTransaction** → the format depends on the chain:
  - **Solana**: hex-encoded serialized Solana transaction (use `partialSign`, the LP may already have co-signed).
  - **Starknet**: JSON-stringified envelope (`{ type, signed, details, ... }`) as returned by the action, with a populated `signed` field.
  - **EVM** (Botanix / Citrea / Alpen / Goat): hex-encoded Ethereum raw-transaction string.

Response:

```jsonc
{ "txHashes": ["0x…"] }
```

See `scripts/process-swap.ts` for a full, per-chain signing reference implementation.

### `GET /listSwaps` / `GET /listPendingSwaps`

```
?signer=<address>&chainId=STARKNET
```

- `signer` is a smart-chain address — required.
- `chainId` is optional; when omitted, swaps from all chains are returned.
- `listPendingSwaps` filters down to swaps which are pending (the set you probably want for a "needs your attention" badge in the wallet UI).

### `GET /getSupportedTokens` / `GET /getSwapCounterTokens` / `GET /getSwapLimits`

Quote-time helpers:

- `getSupportedTokens?side=INPUT|OUTPUT` — tokens you can put on that side of a swap.
- `getSwapCounterTokens?token=STARKNET-STRK&side=INPUT` — tokens that can pair with STRK when STRK is the input.
- `getSwapLimits?srcToken=…&dstToken=…` — `{ input: { min, max? }, output: { min, max? } }`.

### `GET /parseAddress`

```
?address=<string>
```

Normalizes any address-like input the wallet paste field might receive: on-chain addresses, Lightning invoices, LNURL-pay / LNURL-withdraw links, Bitcoin URIs. Returns the parsed `type`, `address`, and — for LNURLs — min/max/amount and the deserialized LNURL payload.

### `GET /getSpendableBalance`

```
?wallet=<address>&token=<tokenId>[&targetChain=STARKNET][&gasDrop=true][&feeRate=…][&minBitcoinFeeRate=…][&feeMultiplier=…]
```

Net spendable balance of a wallet for a given token, accounting for chain fees. Bitcoin and smart-chain tokens accept different optional parameters — see the [`getSpendableBalance`](../../atomiq-sdk/openapi.json) entry in the OpenAPI spec for the authoritative list of query parameters and the chain-specific `feeRate` format.

Lightning balances are **not** supported by this endpoint (the SDK throws).

---

## Swap lifecycle

The flow is the same for every direction: create → poll → sign → submit → repeat until finished.

```mermaid
sequenceDiagram
    autonumber
    participant W as Client Wallet
    participant A as atomiq-api-docker
    participant LP as Atomiq LP
    participant C as Source/Destination chain

    W->>A: POST /createSwap<br/>{ srcToken, dstToken, amount, ... }
    A->>LP: RFQ request
    LP-->>A: quote
    A-->>W: { swapId, quote, state: CREATED }

    loop Poll every action.pollTimeSeconds (default 5s)
        W->>A: GET /getSwapStatus?swapId=<br/>+ bitcoin wallet info if needed
        A->>A: swap._sync()
        A-->>W: { state, currentAction, isFinished, requiresSecretReveal }

        alt currentAction = SignPSBT
            W->>W: sign PSBT (BTC key)
            W->>A: POST /submitTransaction<br/>{ signedTxs: [psbtHex] }
            A->>C: broadcast
            A-->>W: { txHashes }
        else currentAction = SignSmartChainTransaction
            W->>W: sign smart-chain tx
            W->>A: POST /submitTransaction
            A->>C: broadcast
            A-->>W: { txHashes }
        else currentAction = SendToAddress
            W->>C: pay address externally<br/>(or LNURL flow)
        else currentAction = Wait
            Note over W,A: Just keep polling until<br/>isFinished=true or next action becomes available
        else requiresSecretReveal = true
            W->>A: GET /getSwapStatus?swapId=…&secret=<preimage>
        end
    end

    Note over W,A: isFinished=true ⇒ stop polling.<br/>isSuccess / isFailed / isExpired<br/>describes the terminal state.
```

### Minimal client-side loop (pseudocode)

```ts
const { swapId } = await post("/createSwap", { srcToken, dstToken, amount, amountType, dstAddress });

for (;;) {
  const s = await get("/getSwapStatus", { swapId, bitcoinAddress, bitcoinPublicKey });
  if (s.isFinished) break;

  if (s.requiresSecretReveal) {
    await get("/getSwapStatus", { swapId, secret: preimageHex });
    continue;
  }

  const action = s.currentAction;
  switch (action?.type) {
    case "SignPSBT":                    /* sign with BTC key */; break;
    case "SignSmartChainTransaction":   /* sign per action.chain */; break;
    case "SendToAddress":               /* show address to user */; break;
    case "Wait":                        /* no-op */; break;
  }
  if (signedTxs) await post("/submitTransaction", { swapId, signedTxs });

  await sleep((action?.pollTimeSeconds ?? 5) * 1000);
}
```

`scripts/process-swap.ts` is the canonical reference implementation — it handles Solana `partialSign`, Starknet invoke vs. deploy-account, EVM raw transactions, PSBT input selection, and LNURL settlement.

---

## Action types returned by `getSwapStatus`

`currentAction` is one of (all common fields: `type`, `name`, `pollTimeSeconds`):

| `type` | Wallet must… | Key fields |
|---|---|---|
| `SignPSBT` | Sign Bitcoin PSBTs. | `txs: [{ psbtHex, type, signInputs: number[] }]` |
| `SignSmartChainTransaction` | Sign chain-native transactions. | `chain: "SOLANA"\|"STARKNET"\|"BOTANIX"\|...`, `txs: string[]` (chain-specific envelope) |
| `SendToAddress` | Pay an address out of band (usually BTC / Lightning). | `txs: [{ address, amount: ApiAmount, name }]` |
| `Wait` | Do nothing, just poll. | `expectedTimeSeconds` |

Pass the client's BTC `bitcoinAddress` + `bitcoinPublicKey` on every `/getSwapStatus` call — the API needs them to build funded PSBTs for the Bitcoin → smart chain direction.

---

## Lightning and LNURL

Two ways to handle Lightning LNURL links:

### a) Recommended: client-side LNURL

Prefer resolving LNURLs on the client (wallet UI) and passing the resulting lightning invoice / payee info to `/createSwap`. This minimizes the trust the client places on the middleware: the API never sees a link that, if replaced, could redirect funds.

### b) Supported: pass LNURLs directly

You can pass an LNURL-withdraw link as `srcAddress` (for `LIGHTNING-BTC → *`) or an LNURL-pay link as `dstAddress` (for `* → LIGHTNING-BTC`) — the SDK resolves them internally, which implies you trust the API server to resolve them properly.

---

### Preimage reveal

For `LIGHTNING-BTC → smart-chain` flows, the client usually generates a random 32-byte preimage and passes `paymentHash = sha256(preimage)` into `/createSwap`. When `/getSwapStatus` returns `requiresSecretReveal: true`, the client reveals the preimage by calling `/getSwapStatus?swapId=…&secret=<hex>`. The API then broadcasts this secret over Nostr to allow for automatic settlement or uses it to generate proper settlement transactions which are then returned to the user for signing.

---

## Persistence

The container writes SQLite files into the directory pointed to by `STORAGE_DIR`. By default this uses the `./storage` directory.

- `CHAIN_atomiqsdk-1-<CHAINID>.sqlite3` — one per active smart chain; swap state for that chain.
- `STORE_<name>.sqlite3` — additional SDK state (e.g. `solAccounts`).

The bundled `docker-compose.yml` mounts `./config` read-only into `/src/config`, mounts `./storage` into `/src/storage`, and sets `CONFIG_PATH=/src/config/config.yaml` plus `STORAGE_DIR=/src/storage`.

---

## Background maintenance timers

`atomiq-api-docker` runs two timers (configurable):

| Timer | Interval key | Default | Purpose |
|---|---|---|---|
| Swap sync | `swapsSyncIntervalSeconds` | 300 s | Calls `SwapperApi.sync()`. Refreshes state for active swaps and **purges expired swaps** from the local DB. |
| LP reload | `reloadLpIntervalSeconds` | 300 s | Re-discovers Atomiq LPs, so a dropped LP can rejoin the quote pool without restarting the container. |

Errors in either timer are logged and the timer continues.

---

## Error handling

All endpoints return JSON. Errors come in two shapes:

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ "error": "<message>" }` | Validation error or SDK rejected the request. |
| 401 | `{ "error": "Unauthorized" }` | No auth entry matched. |
| 429 | `{ "error": "Rate limit exceeded", "retryAfter": <seconds> }` | Per-IP, per-auth-path or global bucket exhausted. |

Rate-limit state is per IP. If you use a reverse proxy in front set the `trustProxy` config option to `true` in the config.

---

## Security notes

[//]: # (- **Never expose the API-key path to end users.** The API key grants no-rate-limit access to every endpoint. Use JWT for clients.)
- **JWT `exp` field** — the JWT authentication path enforces `exp`, so you can use it to tune expiration of the JWT.
- **Public key rotation** — changing `auth[].publicKey` requires a restart. Plan a rollover window by temporarily listing both the old and new key as two JWT auth entries.
- **CORS** — `origin: "*"` is fine for public endpoints but in production you should restrict it to your wallet front-end origin(s).
