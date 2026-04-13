import {Transaction} from "@scure/btc-signer";
import {bitcoinWallet, evmWallet, solanaWallet, starknetWallet, starknetWalletDeloymentPayload} from "./libs/wallets";
import {Buffer} from "buffer";
import {Keypair, Transaction as SolanaTransaction} from "@solana/web3.js";
import {Transaction as EthersTransaction} from "ethers";

const API_URL = process.env.API_URL || "http://localhost:3000";

export async function processSwap(swapId: string, swapSecret?: string): Promise<void> {
    // Polling loop
    let shouldRevealSecret: boolean = false;
    let lastState: string | undefined;
    let lastActionType: string | undefined;
    while(true) {
        const res = await fetch(API_URL+"/getSwapStatus?"+new URLSearchParams({
            swapId: swapId,
            bitcoinAddress: bitcoinWallet.address,
            bitcoinPublicKey: bitcoinWallet.publicKey,
            ...(shouldRevealSecret ? {secret: swapSecret} : {})
        }).toString());
        if(res.status !== 200) throw new Error(`Invalid response, got response code: ${res.status}, body: `+(await res.text()));
        const status: any = await res.json();

        // Display state changes
        if(status.state.name !== lastState) {
            console.log(`\n[${lastState} → ${status.state.name}] ${status.state.description}`);
            lastState = status.state.name;
        }

        // Check if it is finished
        if(status.isFinished) {
            console.log(`\nSwap of ${status.quote.inputAmount.amount} ${status.quote.inputAmount.symbol} → ${status.quote.outputAmount.amount} ${status.quote.outputAmount.symbol} has finished, state: ${status.state.name}`);
            return;
        }

        // Check if it's time to reveal the swap secret
        if(!shouldRevealSecret && status.requiresSecretReveal) {
            shouldRevealSecret = true;
            console.log(`\nRevealing secret preimage: ${swapSecret}`);
            continue; // Immediately poll next to reveal the secret
        }

        // Handle actions
        // First check if the action returned is actually different
        if (status.currentAction?.type !== lastActionType || status.currentAction?.type==="Wait") {
            lastActionType = status.currentAction?.type;
            // Handle all the actions here
            const action = status.currentAction;
            console.log(`\nAction: ${action?.name ?? "None"} (${action?.type ?? "-"}):`);

            switch (action?.type) {
                case "SignPSBT": {
                    // Sign all the bitcoin PSBTs
                    const signedTxs = action.txs.map((tx: {psbtHex: string, type: string, signInputs: number[]}) => {
                        // Deserialize
                        const psbt = Transaction.fromPSBT(Buffer.from(tx.psbtHex, "hex"));

                        // Sign
                        for(let signInput of tx.signInputs) psbt.signIdx(bitcoinWallet.privateKey, signInput);

                        // Serialize
                        return Buffer.from(psbt.toPSBT()).toString("hex");
                    });

                    // Submit
                    console.log("  Submitting signed transactions...");
                    const response = await fetch(API_URL+"/submitTransaction", {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({swapId, signedTxs})
                    });
                    if(!response.ok) throw new Error(`Submit transactions error (${response.status}): `+await response.text());
                    const result: any = await response.json();
                    console.log(`  Transaction IDs: ${result.txHashes?.join(", ")}`);
                    break;
                }
                case "SignSmartChainTransaction": {
                    // Sign all the smart chain transactions
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

                                // Sign
                                // IMPORTANT to use the `partialSign` here, as the TX might already be signed by the LP
                                parsedTx.partialSign(solanaWallet, ...additionalSigners);

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

                    console.log("  Submitting signed transactions...");
                    const response = await fetch(API_URL+"/submitTransaction", {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({swapId, signedTxs})
                    });
                    if(!response.ok) throw new Error(`Submit transactions error (${response.status}): `+await response.text());
                    const result: any = await response.json();
                    console.log(`  TX: ${result.txHashes?.join(", ")}`);
                    break;
                }
                case "SendToAddress": {
                    // Manual payment to address is required (i.e. for lightning network swaps)
                    action.txs.forEach((tx: {address: string, name: string, amount: {amount: string, symbol: string}}) => {
                        console.log("  Waiting for external payment...");
                        console.log(`  Address: ${tx.address}`);
                        console.log(`  Amount: ${tx.amount.amount} ${tx.amount.symbol}`);
                    });
                    break;
                }
                case "Wait": {
                    console.log(`  Waiting: ${action.name} (~${action.expectedTimeSeconds}s)`);
                    break;
                }
            }
        }

        // Wait before next poll, 5 seconds by default
        await new Promise(resolve => setTimeout(resolve, (status.currentAction?.pollTimeSeconds ?? 5)*1000));
    }
}

// Handle command line arguments
if(require.main === module) {
    const swapId = process.argv[2];
    const swapSecret = process.argv[3];
    if (!swapId) {
        console.error("Usage: resume-swap <swapId> [swapSecret]");
        console.error("Example: npx ts-node scripts/simple-process-swap.ts 85232492c45c...");
    } else {
        processSwap(swapId, swapSecret).catch(e => console.error(e));
    }
}
