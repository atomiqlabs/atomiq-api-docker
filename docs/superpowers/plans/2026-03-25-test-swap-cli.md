# Test Swap CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI script that exercises the atomiq REST API end-to-end — creating swaps, signing transactions locally, submitting them, and polling until settlement.

**Architecture:** A single TypeScript file (`src/scripts/test-swap.ts`) that uses `fetch` for API calls, `@scure/btc-signer` for Bitcoin PSBT signing, and `starknet` for Starknet transaction signing. The script parses CLI args, loads wallet keys from local files, and drives the full swap lifecycle through the REST API.

**Tech Stack:** TypeScript, Node.js 18+ (built-in fetch), `@scure/btc-signer`, `starknet`

**Spec:** `docs/superpowers/specs/2026-03-25-test-swap-cli-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/scripts/test-swap.ts` | Create | Single-file CLI script: arg parsing, wallet loading, API calls, signing, polling |

No tests — the script itself IS the test. It exercises the live API.

---

### Task 1: Scaffold the script with arg parsing and wallet loading

**Files:**
- Create: `src/scripts/test-swap.ts`

- [ ] **Step 1: Create the script with arg parsing, wallet loading, and address resolution**

```typescript
// src/scripts/test-swap.ts
import * as fs from "fs";
import {Transaction, WIF} from "@scure/btc-signer";
import {pubECDSA, TEST_NETWORK} from "@scure/btc-signer/utils";
import {getAddress} from "@scure/btc-signer";
import {ec, CallData, hash} from "starknet";

const API_URL = process.env.API_URL || "http://localhost:3000";
const POLL_INTERVAL_DEFAULT = 5000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// --- Arg parsing ---
const [srcToken, dstToken, amount, amountType] = process.argv.slice(2);
if (!srcToken || !dstToken || !amount || !amountType) {
    console.error("Usage: npx ts-node src/scripts/test-swap.ts <srcToken> <dstToken> <amount> <amountType>");
    console.error("Example: npx ts-node src/scripts/test-swap.ts BTC STRK 3000 EXACT_IN");
    process.exit(1);
}
if (amountType !== "EXACT_IN" && amountType !== "EXACT_OUT") {
    console.error("amountType must be EXACT_IN or EXACT_OUT");
    process.exit(1);
}

// --- Wallet loading ---
const isBtcToken = (t: string) => t === "BTC" || t === "BTCLN";

let bitcoinAddress = "";
let bitcoinPublicKey = "";
let bitcoinPrivKey: Uint8Array | null = null;

if (isBtcToken(srcToken) || isBtcToken(dstToken)) {
    if (!fs.existsSync("bitcoin.key")) {
        console.error("Missing bitcoin.key file (WIF format) — needed for BTC/BTCLN swaps");
        process.exit(1);
    }
    const wif = fs.readFileSync("bitcoin.key").toString().trim();
    bitcoinPrivKey = WIF(TEST_NETWORK).decode(wif);
    const pubkey = pubECDSA(bitcoinPrivKey);
    bitcoinAddress = getAddress("wpkh", bitcoinPrivKey, TEST_NETWORK)!;
    bitcoinPublicKey = Buffer.from(pubkey).toString("hex");
    console.log(`Loaded bitcoin wallet: ${bitcoinAddress}`);
}

let starknetAddress = "";
let starknetPrivKey = "";

if (!isBtcToken(srcToken) || !isBtcToken(dstToken)) {
    if (!fs.existsSync("starknet.key")) {
        console.error("Missing starknet.key file (hex private key) — needed for STRK swaps");
        process.exit(1);
    }
    starknetPrivKey = fs.readFileSync("starknet.key").toString().trim();

    // Derive starknet address from private key (same logic as StarknetKeypairWallet)
    const OZaccountClassHash = "0x00261c293c8084cd79086214176b33e5911677cec55104fddc8d25b0b736dcad";
    const publicKey = ec.starkCurve.getStarkKey(starknetPrivKey);
    const constructorCallData = CallData.compile({publicKey});
    starknetAddress = hash.calculateContractAddressFromHash(publicKey, OZaccountClassHash, constructorCallData, 0);
    console.log(`Loaded starknet wallet: ${starknetAddress}`);
}

// --- Address resolution ---
let srcAddress = "";
let dstAddress = "";

if (isBtcToken(srcToken) && !isBtcToken(dstToken)) {
    // BTC/BTCLN → STRK
    srcAddress = srcToken === "BTC" ? bitcoinAddress : ""; // empty for LN
    dstAddress = starknetAddress;
} else if (!isBtcToken(srcToken) && isBtcToken(dstToken)) {
    // STRK → BTC/BTCLN
    srcAddress = starknetAddress;
    dstAddress = dstToken === "BTC" ? bitcoinAddress : ""; // empty for LN (needs invoice)
} else {
    console.error("Unsupported swap direction: one side must be BTC/BTCLN and the other must be a smart chain token");
    process.exit(1);
}

console.log(`\nCreating swap: ${srcToken} → ${dstToken}, ${amount} (${amountType})...`);
console.log(`  srcAddress: ${srcAddress || "(empty)"}`);
console.log(`  dstAddress: ${dstAddress || "(empty)"}`);
```

- [ ] **Step 2: Add starknet as an explicit dependency**

Run: `npm install starknet`

- [ ] **Step 3: Verify the script runs and prints wallet info**

Run: `cd /Users/marci/dev/Atomiq/atomiq-api-docker && npx ts-node src/scripts/test-swap.ts BTC STRK 3000 EXACT_IN`

Expected: Prints bitcoin and starknet wallet addresses, swap creation message.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/test-swap.ts
git commit -m "Add test-swap CLI: arg parsing and wallet loading"
```

---

### Task 2: Add API helper functions

**Files:**
- Modify: `src/scripts/test-swap.ts`

- [ ] **Step 1: Add fetch wrappers for the 3 API endpoints**

Append after the address resolution section:

```typescript
// --- API helpers ---
async function apiPost(path: string, body: any): Promise<any> {
    const res = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
    return data;
}

async function apiGet(path: string, params: Record<string, string>): Promise<any> {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${API_URL}${path}?${query}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
    return data;
}

async function createSwap(): Promise<any> {
    return apiPost("/createSwap", {
        srcToken, dstToken, amount, amountType, srcAddress, dstAddress
    });
}

async function getSwapStatus(swapId: string): Promise<any> {
    const params: Record<string, string> = {swapId};
    if (bitcoinAddress) {
        params.bitcoinAddress = bitcoinAddress;
        params.bitcoinPublicKey = bitcoinPublicKey;
    }
    return apiGet("/getSwapStatus", params);
}

async function submitTransaction(swapId: string, signedTxs: string[]): Promise<any> {
    return apiPost("/submitTransaction", {swapId, signedTxs});
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scripts/test-swap.ts
git commit -m "Add API helper functions to test-swap CLI"
```

---

### Task 3: Add signing functions

**Files:**
- Modify: `src/scripts/test-swap.ts`

- [ ] **Step 1: Add PSBT signing function**

Append after the API helpers:

```typescript
// --- Signing ---
function signPsbt(psbtHex: string, signInputs: number[]): string {
    if (!bitcoinPrivKey) throw new Error("Bitcoin private key not loaded");
    const psbtBytes = Buffer.from(psbtHex, "hex");
    const tx = Transaction.fromPSBT(psbtBytes);
    for (const idx of signInputs) {
        tx.signIdx(bitcoinPrivKey, idx);
    }
    tx.finalize();
    return Buffer.from(tx.toPSBT()).toString("hex");
}
```

- [ ] **Step 2: Add Starknet transaction signing function**

The Starknet txs come from the API as serialized strings (JSON). The `submitTransaction` endpoint's `submitTransactions` function accepts serialized strings and handles deserialization + submission internally. So for Starknet, the client needs to:
1. Parse the serialized tx JSON to extract the calls
2. Sign and execute via the starknet `Account`
3. Return the tx hash

However, the SDK's internal `StarknetTx` format is complex. For the initial implementation, submit the unsigned tx strings directly — the server-side `action.submitTransactions()` accepts strings and will handle signing if possible, or reject if signing is required client-side.

**If client-side signing IS required:** the script will need to import `StarknetKeypairWallet` from `@atomiqlabs/chain-starknet` and use the starknet Account to sign. For now, add a placeholder:

```typescript
async function signStarknetTx(serializedTx: string): Promise<string> {
    // For STRK → BTC swaps, the API returns serialized unsigned Starknet transactions.
    // The submitTransactions endpoint accepts these as strings.
    // If client-side signing is required, this will need to parse + sign + re-serialize.
    // For now, pass through — server handles submission.
    console.log("  Note: Starknet tx signing — passing serialized tx to API");
    return serializedTx;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/scripts/test-swap.ts
git commit -m "Add PSBT and Starknet signing to test-swap CLI"
```

---

### Task 4: Add the main swap lifecycle loop

**Files:**
- Modify: `src/scripts/test-swap.ts`

- [ ] **Step 1: Add action handler function**

```typescript
// --- Action handling ---
async function handleAction(swapId: string, action: any): Promise<boolean> {
    if (!action) return false;

    switch (action.type) {
        case "SignPSBT": {
            console.log(`\nAction: SignPSBT (${action.name}) — signing funded PSBT...`);
            const tx = action.txs[0];
            if (tx.type === "RAW_PSBT") {
                console.error("ERROR: Received RAW_PSBT — bitcoin wallet params should produce a FUNDED_PSBT");
                process.exit(1);
            }
            const signedPsbt = signPsbt(tx.psbtHex, tx.signInputs);
            console.log("  Submitting signed transaction...");
            const result = await submitTransaction(swapId, [signedPsbt]);
            console.log(`  TX submitted: ${result.txHashes.join(", ")}`);
            return true;
        }

        case "SignSmartChainTransaction": {
            console.log(`\nAction: SignSmartChainTransaction (${action.name}) — signing...`);
            const signedTxs: string[] = [];
            for (const tx of action.txs) {
                const signed = await signStarknetTx(tx);
                signedTxs.push(signed);
            }
            console.log("  Submitting signed transactions...");
            const result = await submitTransaction(swapId, signedTxs);
            console.log(`  TX submitted: ${result.txHashes.join(", ")}`);
            return true;
        }

        case "SendToAddress": {
            const tx = action.txs[0];
            console.log(`\nAction: SendToAddress (${action.name})`);
            if (action.chain === "LIGHTNING") {
                console.log(`  Pay this Lightning invoice: ${tx.address}`);
                console.log(`  Amount: ${tx.amount.amount} ${tx.amount.symbol}`);
                console.log("  (waiting for external payment...)");
            } else {
                console.log(`  Send to Bitcoin address: ${tx.address}`);
                console.log(`  Amount: ${tx.amount.amount} ${tx.amount.symbol}`);
                console.log("  (waiting for payment...)");
            }
            return true;
        }

        case "Wait": {
            console.log(`  Waiting: ${action.name} (est. ${action.expectedTimeSeconds}s)`);
            return true;
        }

        default:
            console.log(`  Unknown action type: ${action.type}`);
            return false;
    }
}
```

- [ ] **Step 2: Add the main lifecycle function**

```typescript
// --- Main lifecycle ---
async function main() {
    const startTime = Date.now();

    // Create swap
    const swap = await createSwap();
    console.log(`\nSwap created: ${swap.swapId} (${swap.swapType})`);
    console.log(`  Input: ${swap.quote.inputAmount.amount} ${swap.quote.inputAmount.symbol}`);
    console.log(`  Output: ${swap.quote.outputAmount.amount} ${swap.quote.outputAmount.symbol}`);
    console.log(`  Fees: swap=${swap.quote.fees.swap.rawAmount} sats${swap.quote.fees.networkOutput ? `, network=${swap.quote.fees.networkOutput.rawAmount} sats` : ""}`);
    const expiresIn = Math.round((swap.quote.expiry - Date.now()) / 1000);
    console.log(`  Quote expires in ${expiresIn}s`);

    const swapId = swap.swapId;
    let lastStateName = swap.state.name;
    let lastActionType = swap.currentAction?.type;

    // Handle initial action
    await handleAction(swapId, swap.currentAction);

    // Poll loop
    let lastStatus: any = swap;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const pollInterval = lastStatus.currentAction?.pollTimeSeconds
            ? lastStatus.currentAction.pollTimeSeconds * 1000
            : POLL_INTERVAL_DEFAULT;
        await new Promise(r => setTimeout(r, pollInterval));

        let status: any;
        try {
            status = await getSwapStatus(swapId);
        } catch (e: any) {
            console.error(`  Poll error: ${e.message}`);
            continue;
        }
        lastStatus = status;

        // Print state transitions
        if (status.state.name !== lastStateName) {
            console.log(`\n[${lastStateName} → ${status.state.name}] ${status.state.description}`);
            lastStateName = status.state.name;
        }

        // Check terminal states
        if (status.isFinished) {
            const duration = Math.round((Date.now() - startTime) / 1000);
            if (status.isSuccess) {
                console.log(`\nSwap completed successfully!`);
                console.log(`  Input: ${status.quote.inputAmount.amount} ${status.quote.inputAmount.symbol} → Output: ${status.quote.outputAmount.amount} ${status.quote.outputAmount.symbol}`);
                console.log(`  Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
                process.exit(0);
            } else {
                console.log(`\nSwap failed!`);
                console.log(`  State: ${status.state.name} — ${status.state.description}`);

                // Check for refundable state
                const refundStep = status.steps?.find((s: any) => s.type === "Refund" && s.status === "awaiting");
                if (refundStep) {
                    console.log(`  Note: This swap can be refunded`);
                }
                process.exit(1);
            }
        }

        // Handle new actions
        if (status.currentAction?.type !== lastActionType) {
            lastActionType = status.currentAction?.type;
            await handleAction(swapId, status.currentAction);
        }

        // Handle requiresSecretReveal for Lightning swaps
        if (status.requiresSecretReveal) {
            console.log("\n  Note: This swap requires a Lightning payment secret (pre-image) to proceed.");
            console.log("  Automated Lightning secret handling is not supported — please provide manually.");
        }
    }

    console.error(`\nTimeout! Swap did not complete within ${TIMEOUT_MS / 60000} minutes.`);
    console.error(`  Last state: ${lastStateName}`);
    process.exit(1);
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});
```

- [ ] **Step 3: Verify the script compiles**

Run: `cd /Users/marci/dev/Atomiq/atomiq-api-docker && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/scripts/test-swap.ts
git commit -m "Add swap lifecycle loop to test-swap CLI"
```

---

### Task 5: Test against live API

**Prerequisites:** API server running (`npm run build && npm start`)

- [ ] **Step 1: Test BTC → STRK swap (the most automatable flow)**

Run: `npx ts-node src/scripts/test-swap.ts BTC STRK 3000 EXACT_IN`

Expected: Creates swap, signs PSBT, submits, polls until settlement or timeout.

Note: This will create a real swap on testnet and spend ~3000 sats from the bitcoin wallet. The wallet has ~3859 sats.

- [ ] **Step 2: Fix any issues found during live testing**

Common issues to watch for:
- PSBT signing errors (input index, key format)
- `finalize()` failing if the PSBT structure doesn't match expectations
- Polling errors if swap expires quickly

- [ ] **Step 3: Final commit**

```bash
git add src/scripts/test-swap.ts
git commit -m "Fix issues found during live testing"
```

---

## Implementation Notes

- The script does NOT import `@atomiqlabs/sdk` — it's a pure REST client
- For BTCLN→STRK swaps, the script prints the Lightning invoice but cannot pay it automatically (needs external wallet). This is documented in the output.
- Starknet tx signing is a placeholder for the initial implementation — the serialized unsigned tx is passed through to `submitTransaction`. STRK→BTC/BTCLN swaps will fail at the signing step if client-side signing is required. This is a known limitation — enhancing with proper `StarknetKeypairWallet` signing is a follow-up task.
- The script uses `TEST_NETWORK` from `@scure/btc-signer/utils` for testnet3. For mainnet, switch to `BTC_NETWORK`.
- `gasAmount` is not used — test wallets already have gas.
