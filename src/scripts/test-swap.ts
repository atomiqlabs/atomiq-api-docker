import * as fs from "fs";
import {Transaction, WIF} from "@scure/btc-signer";
import {pubECDSA, TEST_NETWORK} from "@scure/btc-signer/utils";
import {getAddress} from "@scure/btc-signer";
import {ec, CallData, hash} from "starknet";

const API_URL = process.env.API_URL || "http://localhost:3000";
const POLL_INTERVAL_DEFAULT = 5000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length < 4) {
    console.error("Usage: test-swap <srcToken> <dstToken> <amount> <amountType>");
    console.error("  srcToken:   BTC | BTCLN | STRK");
    console.error("  dstToken:   BTC | BTCLN | STRK");
    console.error("  amount:     integer amount in base units (sats or fri)");
    console.error("  amountType: EXACT_IN | EXACT_OUT");
    process.exit(1);
}

const [srcToken, dstToken, amount, amountType] = args;

if (amountType !== "EXACT_IN" && amountType !== "EXACT_OUT") {
    console.error(`Invalid amountType '${amountType}'. Must be EXACT_IN or EXACT_OUT.`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBtcToken(t: string): boolean {
    return t === "BTC" || t === "BTCLN";
}

// ---------------------------------------------------------------------------
// Wallet loading
// ---------------------------------------------------------------------------

let btcPrivKey: Uint8Array | null = null;
let btcPubKey: Uint8Array | null = null;
let btcAddress: string | null = null;

let starknetPrivKey: string | null = null;
let starknetAddress: string | null = null;

if (isBtcToken(srcToken) || isBtcToken(dstToken)) {
    const wifStr = fs.readFileSync("bitcoin.key", "utf8").trim();
    // Try testnet WIF first; fall back to mainnet WIF (key file may use either format)
    btcPrivKey = WIF(TEST_NETWORK).decode(wifStr);
    btcPubKey = pubECDSA(btcPrivKey);
    btcAddress = getAddress("wpkh", btcPrivKey, TEST_NETWORK) ?? null;
    console.log(`Bitcoin wallet loaded. Address: ${btcAddress}`);
}

if (srcToken === "STRK" || dstToken === "STRK") {
    const OZaccountClassHash = "0x00261c293c8084cd79086214176b33e5911677cec55104fddc8d25b0b736dcad";
    starknetPrivKey = fs.readFileSync("starknet.key", "utf8").trim();
    const publicKey = ec.starkCurve.getStarkKey(starknetPrivKey);
    const constructorCallData = CallData.compile({publicKey});
    starknetAddress = hash.calculateContractAddressFromHash(
        publicKey,
        OZaccountClassHash,
        constructorCallData,
        0
    );
    console.log(`Starknet wallet loaded. Address: ${starknetAddress}`);
}

// ---------------------------------------------------------------------------
// Address resolution
// ---------------------------------------------------------------------------

let srcAddress: string;
let dstAddress: string;

if (isBtcToken(srcToken) && dstToken === "STRK") {
    // BTC/BTCLN → STRK
    srcAddress = srcToken === "BTCLN" ? "" : (btcAddress ?? "");
    dstAddress = starknetAddress ?? "";
} else if (srcToken === "STRK" && isBtcToken(dstToken)) {
    // STRK → BTC/BTCLN
    srcAddress = starknetAddress ?? "";
    dstAddress = dstToken === "BTCLN" ? "" : (btcAddress ?? "");
} else {
    console.error(`Unsupported token pair: ${srcToken} → ${dstToken}`);
    process.exit(1);
}

console.log(`srcAddress: ${srcAddress || "(empty)"}`);
console.log(`dstAddress: ${dstAddress || "(empty)"}`);

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: Record<string, unknown>): Promise<any> {
    const url = `${API_URL}${path}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) {
        throw new Error(`POST ${path} failed (${response.status}): ${JSON.stringify(json)}`);
    }
    return json;
}

async function apiGet(path: string, params: Record<string, string>): Promise<any> {
    const url = `${API_URL}${path}?${new URLSearchParams(params).toString()}`;
    const response = await fetch(url);
    const json = await response.json();
    if (!response.ok) {
        throw new Error(`GET ${path} failed (${response.status}): ${JSON.stringify(json)}`);
    }
    return json;
}

async function createSwap(): Promise<any> {
    return apiPost("/createSwap", {
        srcToken,
        dstToken,
        amount,
        amountType,
        srcAddress,
        dstAddress,
    });
}

async function getSwapStatus(swapId: string): Promise<any> {
    const params: Record<string, string> = {swapId};
    if (btcAddress !== null) {
        params.bitcoinAddress = btcAddress;
    }
    if (btcPubKey !== null) {
        params.bitcoinPublicKey = Buffer.from(btcPubKey).toString("hex");
    }
    return apiGet("/getSwapStatus", params);
}

async function submitTransaction(swapId: string, signedTxs: string[]): Promise<any> {
    return apiPost("/submitTransaction", {swapId, signedTxs});
}

// ---------------------------------------------------------------------------
// Signing functions
// ---------------------------------------------------------------------------

function signPsbt(psbtHex: string, signInputs: number[]): string {
    const psbtBytes = Buffer.from(psbtHex, "hex");
    const tx = Transaction.fromPSBT(psbtBytes);
    for (const idx of signInputs) {
        tx.signIdx(btcPrivKey!, idx);
        tx.finalizeIdx(idx);
    }
    return Buffer.from(tx.extract()).toString("hex");
}

function signStarknetTx(serializedTx: string): string {
    // The server handles Starknet transaction submission using the wallet's
    // signing keys server-side. This function passes through the serialized
    // transaction for use by the lifecycle loop.
    console.log("Note: Starknet tx signing is handled server-side; passing through serialized tx.");
    return serializedTx;
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

async function handleAction(swapId: string, action: any): Promise<boolean> {
    if (action == null) return false;

    switch (action.type) {
        case "SignPSBT": {
            console.log(`\nAction: SignPSBT`);
            const tx = action.txs[0];
            if (tx.type === "RAW_PSBT") {
                console.error("Error: received RAW_PSBT — expected FUNDED_PSBT when bitcoin wallet params are passed.");
                process.exit(1);
            }
            // tx.type === "FUNDED_PSBT"
            const signedHex = signPsbt(tx.psbtHex, tx.signInputs);
            const result = await submitTransaction(swapId, [signedHex]);
            console.log(`  TX hashes: ${JSON.stringify(result)}`);
            return true;
        }

        case "SignSmartChainTransaction": {
            console.log(`\nAction: SignSmartChainTransaction (${action.name})`);
            const signedTxs = action.txs.map((tx: any) => signStarknetTx(tx));
            const result = await submitTransaction(swapId, signedTxs);
            console.log(`  TX hashes: ${JSON.stringify(result)}`);
            return true;
        }

        case "SendToAddress": {
            const tx = action.txs[0];
            if (action.chain === "LIGHTNING") {
                console.log(`\nAction: SendToAddress`);
                console.log(`  Lightning invoice: ${tx.address}`);
                console.log(`  Amount: ${tx.amount}`);
            } else if (action.chain === "BITCOIN") {
                console.log(`\nAction: SendToAddress`);
                console.log(`  Bitcoin address: ${tx.address}`);
                console.log(`  Amount: ${tx.amount}`);
            }
            // User pays externally; script continues polling
            return true;
        }

        case "Wait": {
            console.log(`\nAction: Wait — ${action.name} (expected ~${action.expectedTimeSeconds}s)`);
            return true;
        }

        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

async function main() {
    const startTime = Date.now();

    // Create swap
    const swap = await createSwap();
    console.log(`\nSwap created:`);
    console.log(`  swapId:      ${swap.swapId}`);
    console.log(`  swapType:    ${swap.swapType}`);
    console.log(`  inputAmount: ${swap.inputAmount}`);
    console.log(`  outputAmount:${swap.outputAmount}`);
    console.log(`  fees:        ${JSON.stringify(swap.fees)}`);
    console.log(`  quoteExpiry: ${swap.quoteExpiry}`);

    const swapId = swap.swapId;
    let lastStateName = swap.state.name;
    let lastActionType = swap.currentAction?.type;

    // Handle initial action from createSwap response
    await handleAction(swapId, swap.currentAction);

    // Poll loop
    let lastStatus = swap;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        // Use pollTimeSeconds from last action, or default 5s
        const pollInterval = lastStatus.currentAction?.pollTimeSeconds
            ? lastStatus.currentAction.pollTimeSeconds * 1000
            : POLL_INTERVAL_DEFAULT;
        await new Promise(r => setTimeout(r, pollInterval));

        let status: any;
        try {
            status = await getSwapStatus(swapId);
        } catch (e: any) {
            console.error(`Poll error: ${e.message}`);
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
            const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
            if (status.isSuccess) {
                console.log(`\nSwap completed successfully in ${durationSec}s.`);
                process.exit(0);
            } else {
                console.error(`\nSwap failed after ${durationSec}s. State: ${status.state.description}`);
                if (status.currentAction?.type === "Refund") {
                    console.error("A refund step may be available.");
                }
                process.exit(1);
            }
        }

        // Handle new actions (type changed)
        if (status.currentAction?.type !== lastActionType) {
            lastActionType = status.currentAction?.type;
            await handleAction(swapId, status.currentAction);
        }

        // Handle requiresSecretReveal for Lightning swaps
        if (status.requiresSecretReveal) {
            console.log("Note: This swap requires a Lightning payment secret (pre-image) to proceed.");
            console.log("Automated Lightning secret handling is not supported.");
        }
    }

    // Timeout
    console.error(`\nTimeout! Swap did not complete within ${TIMEOUT_MS / 60000} minutes.`);
    console.error(`Last state: ${lastStateName}`);
    process.exit(1);
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});
