import * as fs from "fs";
import {SingleAddressBitcoinWallet, BitcoinNetwork} from "@atomiqlabs/sdk";
import {StarknetKeypairWallet} from "@atomiqlabs/chain-starknet";
import {Transaction} from "@scure/btc-signer";
import {RpcProvider} from "starknet";

const API_URL = process.env.API_URL || "http://localhost:3000";
const POLL_INTERVAL_DEFAULT = 5000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// --- Arg parsing ---
const [srcToken, dstToken, amount, amountType] = process.argv.slice(2);
if (!srcToken || !dstToken || !amount || !amountType) {
    console.error("Usage: test-swap <srcToken> <dstToken> <amount> <amountType>");
    console.error("Example: npx ts-node src/scripts/test-swap.ts BTC STRK 3000 EXACT_IN");
    process.exit(1);
}
if (amountType !== "EXACT_IN" && amountType !== "EXACT_OUT") {
    console.error("amountType must be EXACT_IN or EXACT_OUT");
    process.exit(1);
}

const isBtcToken = (t: string) => t === "BTC" || t === "BTCLN";

// --- Wallet loading (using SDK helpers) ---
let btcWallet: SingleAddressBitcoinWallet | null = null;
let starkWallet: StarknetKeypairWallet | null = null;

if (isBtcToken(srcToken) || isBtcToken(dstToken)) {
    const wif = fs.readFileSync("bitcoin.key", "utf8").trim();
    btcWallet = new SingleAddressBitcoinWallet(null as any, BitcoinNetwork.TESTNET, wif);
    console.log(`Bitcoin wallet: ${btcWallet.getReceiveAddress()}`);
}

if (srcToken === "STRK" || dstToken === "STRK") {
    const privKey = fs.readFileSync("starknet.key", "utf8").trim();
    const rpc = new RpcProvider({nodeUrl: process.env.STARKNET_RPC || "https://starknet-sepolia.public.blastapi.io/rpc/v0_9"});
    starkWallet = new StarknetKeypairWallet(rpc, privKey);
    console.log(`Starknet wallet: ${starkWallet.address}`);
}

// --- Address resolution ---
let srcAddress = "";
let dstAddress = "";

if (isBtcToken(srcToken) && !isBtcToken(dstToken)) {
    srcAddress = srcToken === "BTC" ? btcWallet!.getReceiveAddress() : "";
    dstAddress = starkWallet!.address;
} else if (!isBtcToken(srcToken) && isBtcToken(dstToken)) {
    srcAddress = starkWallet!.address;
    dstAddress = dstToken === "BTC" ? btcWallet!.getReceiveAddress() : "";
} else {
    console.error("One side must be BTC/BTCLN and the other a smart chain token");
    process.exit(1);
}

// --- API helpers ---
async function api(method: "GET" | "POST", path: string, data: Record<string, any>): Promise<any> {
    const url = method === "GET"
        ? `${API_URL}${path}?${new URLSearchParams(data).toString()}`
        : `${API_URL}${path}`;
    const res = await fetch(url, method === "POST" ? {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data)
    } : undefined);
    const json: any = await res.json();
    if (!res.ok) throw new Error(json.error || `${method} ${path} failed (${res.status})`);
    return json;
}

function getStatusParams(swapId: string): Record<string, string> {
    const params: Record<string, string> = {swapId};
    if (btcWallet) {
        params.bitcoinAddress = btcWallet.getReceiveAddress();
        params.bitcoinPublicKey = btcWallet.getPublicKey();
    }
    return params;
}

// --- Action handler ---
async function handleAction(swapId: string, action: any): Promise<void> {
    if (!action) return;

    switch (action.type) {
        case "SignPSBT": {
            const tx = action.txs[0];
            console.log(`\nAction: SignPSBT (${action.name}) — type: ${tx.type}`);
            if (tx.type === "RAW_PSBT") {
                console.error("ERROR: Received RAW_PSBT — expected FUNDED_PSBT");
                process.exit(1);
            }
            const psbt = Transaction.fromPSBT(Buffer.from(tx.psbtHex, "hex"));
            await btcWallet!.signPsbt(psbt as any, tx.signInputs);
            const signedHex = Buffer.from(psbt.toPSBT()).toString("hex");
            console.log("  Signing and submitting...");
            const result = await api("POST", "/submitTransaction", {swapId, signedTxs: [signedHex]});
            console.log(`  TX: ${result.txHashes?.join(", ")}`);
            break;
        }
        case "SignSmartChainTransaction": {
            console.log(`\nAction: ${action.name}`);
            console.log("  Note: Starknet tx signing — passing through to server");
            const result = await api("POST", "/submitTransaction", {swapId, signedTxs: action.txs});
            console.log(`  TX: ${result.txHashes?.join(", ")}`);
            break;
        }
        case "SendToAddress": {
            const tx = action.txs[0];
            const label = action.chain === "LIGHTNING" ? "Lightning invoice" : "Bitcoin address";
            console.log(`\nAction: ${action.name}`);
            console.log(`  ${label}: ${tx.address}`);
            console.log(`  Amount: ${tx.amount?.amount ?? tx.amount} ${tx.amount?.symbol ?? ""}`);
            console.log("  (waiting for external payment...)");
            break;
        }
        case "Wait": {
            console.log(`  Waiting: ${action.name} (~${action.expectedTimeSeconds}s)`);
            break;
        }
    }
}

// --- Main ---
async function main() {
    const startTime = Date.now();
    console.log(`\nCreating swap: ${srcToken} → ${dstToken}, ${amount} (${amountType})`);
    console.log(`  src: ${srcAddress || "(empty)"}  dst: ${dstAddress || "(empty)"}`);

    const swap = await api("POST", "/createSwap", {srcToken, dstToken, amount, amountType, srcAddress, dstAddress});
    const swapId = swap.swapId;
    console.log(`\nSwap created: ${swapId.slice(0, 12)}... (${swap.swapType})`);
    console.log(`  ${swap.quote.inputAmount.amount} ${swap.quote.inputAmount.symbol} → ${swap.quote.outputAmount.amount} ${swap.quote.outputAmount.symbol}`);
    console.log(`  Fees: swap=${swap.quote.fees.swap.rawAmount} sats${swap.quote.fees.networkOutput ? `, network=${swap.quote.fees.networkOutput.rawAmount} sats` : ""}`);
    console.log(`  Expires in ${Math.round((swap.quote.expiry - Date.now()) / 1000)}s`);

    // Get status with wallet params (to get FUNDED_PSBT instead of RAW_PSBT)
    let status = await api("GET", "/getSwapStatus", getStatusParams(swapId));
    let lastState = status.state.name;
    let lastActionType = status.currentAction?.type;
    await handleAction(swapId, status.currentAction);

    // Poll loop
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const interval = status.currentAction?.pollTimeSeconds ? status.currentAction.pollTimeSeconds * 1000 : POLL_INTERVAL_DEFAULT;
        await new Promise(r => setTimeout(r, interval));

        try {
            status = await api("GET", "/getSwapStatus", getStatusParams(swapId));
        } catch (e: any) {
            console.error(`  Poll error: ${e.message}`);
            continue;
        }

        if (status.state.name !== lastState) {
            console.log(`\n[${lastState} → ${status.state.name}] ${status.state.description}`);
            lastState = status.state.name;
        }

        if (status.isFinished) {
            const dur = ((Date.now() - startTime) / 1000).toFixed(0);
            if (status.isSuccess) {
                console.log(`\nSwap completed in ${dur}s!`);
                console.log(`  ${status.quote.inputAmount.amount} ${status.quote.inputAmount.symbol} → ${status.quote.outputAmount.amount} ${status.quote.outputAmount.symbol}`);
                process.exit(0);
            }
            console.error(`\nSwap failed after ${dur}s: ${status.state.name} — ${status.state.description}`);
            process.exit(1);
        }

        if (status.currentAction?.type !== lastActionType) {
            lastActionType = status.currentAction?.type;
            await handleAction(swapId, status.currentAction);
        }
    }

    console.error(`\nTimeout after ${TIMEOUT_MS / 60000}min. Last state: ${lastState}`);
    process.exit(1);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
