import {Transaction} from "@scure/btc-signer";
import {bitcoinWallet, evmWallet, solanaWallet, starknetWallet, starknetWalletDeloymentPayload} from "./libs/wallets";
import {json} from "starknet";
import {Buffer} from "buffer";
import {Keypair, Transaction as SolanaTransaction} from "@solana/web3.js";
import {Transaction as EthersTransaction} from "ethers";

const API_URL = process.env.API_URL || "http://localhost:3000";
const POLL_INTERVAL_DEFAULT = 5000;
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// --- Arg parsing ---
// Always use chain prefix for a given token!
const [srcToken, dstToken, amount, amountType] = process.argv.slice(2);
if (!srcToken || !dstToken || !amount || !amountType) {
    console.error("Usage: test-swap <srcToken> <dstToken> <amount> <amountType>");
    console.error("Example: npx ts-node src/scripts/test-swap.ts BITCOIN-BTC STARKNET-STRK 3000 EXACT_IN");
    throw new Error("Invalid params");
}

function getAddressForToken(tokenId: string) {
    const chain = tokenId.split("-")[0];
    switch(chain) {
        case "LIGHTNING":
            throw new Error("Lightning swaps are not supported");
        case "BITCOIN":
            return bitcoinWallet.address;
        case "STARKNET":
            return starknetWallet.address;
        case "SOLANA":
            return solanaWallet.publicKey.toBase58();
        default:
            // Assume all the other chains are EVM
            return evmWallet.address;
    }
}

// --- API helpers ---
async function api(method: "GET" | "POST", path: string, data: Record<string, any>): Promise<any> {
    // console.debug(`${method} ${path}: `, data);

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

// --- Action handler ---
async function handleAction(swapId: string, action: any): Promise<void> {
    if (!action) return;

    switch (action.type) {
        case "SignPSBT": {
            console.log(`\nAction: SignPSBT (${action.name}) — type: ${action.txs[0].type}`);

            const signedTxs = action.txs.map((tx: {psbtHex: string, type: string, signInputs: number[]}) => {
                if (tx.type === "RAW_PSBT") throw new Error("ERROR: Received RAW_PSBT — expected FUNDED_PSBT");

                const psbt = Transaction.fromPSBT(Buffer.from(tx.psbtHex, "hex"));
                for(let signInput of tx.signInputs) psbt.signIdx(bitcoinWallet.privateKey, signInput);
                return Buffer.from(psbt.toPSBT()).toString("hex");
            });

            console.log("  Submitting signed transactions...");
            const result = await api("POST", "/submitTransaction", {swapId, signedTxs});
            console.log(`  TX: ${result.txHashes?.join(", ")}`);
            break;
        }
        case "SignSmartChainTransaction": {
            console.log(`\nAction: ${action.name}`);

            const signedTxs: string[] = [];
            for(let tx of action.txs) {
                switch(action.chain) {
                    case "SOLANA": {
                        // Deserialize
                        const parsed = JSON.parse(tx);
                        const additionalSigners: Keypair[] = parsed.signers.map(
                            (key: string) => Keypair.fromSecretKey(Buffer.from(key, "hex"))
                        );
                        const parsedTx = SolanaTransaction.from(Buffer.from(parsed.tx, "hex"));
                        parsedTx.lastValidBlockHeight = parsed.lastValidBlockheight;

                        /// Sign
                        parsedTx.sign(solanaWallet, ...additionalSigners);

                        // Serialize
                        signedTxs.push(parsedTx.serialize().toString("hex"));
                        break;
                    }
                    case "STARKNET": {
                        // Deserialize
                        const parsed = JSON.parse(tx);
                        for(let type in parsed.details.resourceBounds) for(let param in parsed.details.resourceBounds[type]) {
                            parsed.details.resourceBounds[type][param] = BigInt(parsed.details.resourceBounds[type][param]);
                        }

                        // Sign
                        if (parsed.type === "INVOKE") {
                            parsed.signed = await starknetWallet.buildInvocation(parsed.tx, parsed.details);
                        } else if (parsed.type === "DEPLOY_ACCOUNT") {
                            // Build account deployment payload and deploy your account type. The API cannot deploy
                            //  the exact payload that you could readily use because it doesn't know the type of your
                            //  account, hence you need to use your own account deployment payload!
                            // In this case a simple OpenZeppelin account with a single public key is used
                            parsed.signed = await starknetWallet.buildAccountDeployPayload(
                                starknetWalletDeloymentPayload, // Create the deployment payload ourselves
                                parsed.details // We can use the details from the API, these contain fee rates, nonce and other info
                            )
                        } else throw new Error(`Unrecognized Starknet tx type: ${parsed.type}`);

                        // Serialize
                        signedTxs.push(JSON.stringify(parsed, (_, value) => typeof(value)==="bigint" ? value.toString() : value));
                        break;
                    }
                    default:
                        // Consider all the rest as EVM
                        // Deserialize
                        const parsedTx = EthersTransaction.from(tx);

                        // Sign & Serialize
                        signedTxs.push(await evmWallet.signTransaction(parsedTx));
                        break;
                }
            }

            const result = await api("POST", "/submitTransaction", {swapId, signedTxs});
            console.log(`  TX: ${result.txHashes?.join(", ")}`);
            break;
        }
        case "SendToAddress": {
            action.txs.forEach((tx: {address: string, name: string, amount: {amount: string, symbol: string}}) => {
                console.log(`\nAction: ${action.name}`);
                console.log(`  Address: ${tx.address}`);
                console.log(`  Amount: ${tx.amount.amount} ${tx.amount.symbol ?? ""}`);
                console.log("  (waiting for external payment...)");
            });
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

    const srcAddress = getAddressForToken(srcToken);
    const dstAddress = getAddressForToken(dstToken);

    console.log(`\nCreating swap: ${srcToken} → ${dstToken}, ${amount} (${amountType})`);
    console.log(`  src: ${srcAddress || "(empty)"}  dst: ${dstAddress || "(empty)"}`);

    const swap = await api("POST", "/createSwap", {srcToken, dstToken, amount, amountType, srcAddress, dstAddress});
    const swapId = swap.swapId;
    console.log(`\nSwap created: ${swapId} (${swap.swapType})`);
    console.log(`  ${swap.quote.inputAmount.amount} ${swap.quote.inputAmount.symbol} → ${swap.quote.outputAmount.amount} ${swap.quote.outputAmount.symbol}`);
    console.log(`  Fees: swap=${swap.quote.fees.swap.amount} ${swap.quote.fees.swap.symbol}${swap.quote.fees.networkOutput ? `, network_output=${swap.quote.fees.networkOutput.amount} ${swap.quote.fees.networkOutput.symbol}` : ""}`);
    console.log(`  Expires in ${Math.round((swap.quote.expiry - Date.now()) / 1000)}s`);

    let lastState: string = swap.state.name;
    let lastActionType = null;

    // Poll loop
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        let status;
        try {
            status = await api("GET", "/getSwapStatus", {
                swapId,
                bitcoinAddress: bitcoinWallet.address,
                bitcoinPublicKey: bitcoinWallet.publicKey
            });
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

        const interval = status.currentAction?.pollTimeSeconds ? status.currentAction.pollTimeSeconds * 1000 : POLL_INTERVAL_DEFAULT;
        await new Promise(r => setTimeout(r, interval));
    }

    console.error(`\nTimeout after ${TIMEOUT_MS / 60000}min. Last state: ${lastState}`);
    process.exit(1);
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
