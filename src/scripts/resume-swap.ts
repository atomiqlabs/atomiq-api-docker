import * as fs from "fs";
import {SingleAddressBitcoinWallet, BitcoinNetwork} from "@atomiqlabs/sdk";
import {StarknetKeypairWallet} from "@atomiqlabs/chain-starknet";
import {Transaction} from "@scure/btc-signer";
import {RpcProvider} from "starknet";

const API_URL = process.env.API_URL || "http://localhost:3000";
const POLL_INTERVAL_DEFAULT = 5000;
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// --- Arg parsing ---
const swapId = process.argv[2];
if (!swapId) {
    console.error("Usage: resume-swap <swapId>");
    console.error("Example: npx ts-node src/scripts/resume-swap.ts 85232492c45c...");
    process.exit(1);
}

// --- Load wallets (if key files exist) ---
let btcWallet: SingleAddressBitcoinWallet | null = null;
let starkWallet: StarknetKeypairWallet | null = null;

if (fs.existsSync("bitcoin.key")) {
    const wif = fs.readFileSync("bitcoin.key", "utf8").trim();
    btcWallet = new SingleAddressBitcoinWallet(null as any, BitcoinNetwork.TESTNET, wif);
    console.log(`Bitcoin wallet: ${btcWallet.getReceiveAddress()}`);
}

if (fs.existsSync("starknet.key")) {
    const privKey = fs.readFileSync("starknet.key", "utf8").trim();
    const rpc = new RpcProvider({nodeUrl: process.env.STARKNET_RPC || "https://starknet-sepolia.public.blastapi.io/rpc/v0_9"});
    starkWallet = new StarknetKeypairWallet(rpc, privKey);
    console.log(`Starknet wallet: ${starkWallet.address}`);
}

// --- API helper ---
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

function getStatusParams(): Record<string, string> {
    const params: Record<string, string> = {swapId};
    if (btcWallet) {
        params.bitcoinAddress = btcWallet.getReceiveAddress();
        params.bitcoinPublicKey = btcWallet.getPublicKey();
    }
    return params;
}

// --- Action handler ---
async function handleAction(action: any): Promise<void> {
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
    console.log(`\nResuming swap: ${swapId}`);

    let status = await api("GET", "/getSwapStatus", getStatusParams());

    // Print current state
    console.log(`\nSwap status:`);
    console.log(`  Type:    ${status.swapType}`);
    console.log(`  State:   ${status.state.name} — ${status.state.description}`);
    console.log(`  Input:   ${status.quote.inputAmount.amount} ${status.quote.inputAmount.symbol}`);
    console.log(`  Output:  ${status.quote.outputAmount.amount} ${status.quote.outputAmount.symbol}`);
    console.log(`  Finished: ${status.isFinished}  Success: ${status.isSuccess}  Failed: ${status.isFailed}  Expired: ${status.isExpired}`);

    if (status.currentAction) {
        console.log(`  Action:  ${status.currentAction.type} (${status.currentAction.name})`);
    } else {
        console.log(`  Action:  none`);
    }

    if (status.isFinished) {
        if (status.isSuccess) {
            console.log(`\nSwap already completed successfully!`);
            process.exit(0);
        }
        console.error(`\nSwap already finished: ${status.state.name} — ${status.state.description}`);
        process.exit(1);
    }

    // Handle current action if needed
    let lastState = status.state.name;
    let lastActionType = status.currentAction?.type;
    await handleAction(status.currentAction);

    // Poll loop
    console.log(`\nPolling for updates...`);
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const interval = status.currentAction?.pollTimeSeconds ? status.currentAction.pollTimeSeconds * 1000 : POLL_INTERVAL_DEFAULT;
        await new Promise(r => setTimeout(r, interval));

        try {
            status = await api("GET", "/getSwapStatus", getStatusParams());
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
            await handleAction(status.currentAction);
        }
    }

    console.error(`\nTimeout after ${TIMEOUT_MS / 60000}min. Last state: ${lastState}`);
    process.exit(1);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
