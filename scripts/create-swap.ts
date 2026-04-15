import {bitcoinWallet, evmWallet, solanaWallet, starknetWallet} from "./libs/wallets";
import {createHash, randomBytes} from "node:crypto";

const API_URL = process.env.API_URL || "http://localhost:3000";

// Helper to get the address for a given token
function getAddressForToken(tokenId: string) {
    const chain = tokenId.split("-")[0];
    switch(chain) {
        case "LIGHTNING":
            return undefined;
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
// NOTE: When using LNURL-pay or LNURL-withdraw links prefer to handle the LNURL part on the client-side, this
//  minimizes the dependency and trust required on the side of the server
export async function createSwap(
    srcToken: string, dstToken: string,
    amount: string, amountType: string,
    destinationAddress?: string, sourceAddress?: string
): Promise<{swapId: string, swapSecret?: string}> {
    const srcAddress = sourceAddress ?? getAddressForToken(srcToken); // Get the internal wallet for the source chain
    const dstAddress = destinationAddress ?? getAddressForToken(dstToken); // Get the internal wallet for the destination chain

    if(dstAddress==null) throw new Error(`Cannot get internal wallet address for ${dstToken}! Provide it manually as a command line argument!`);

    let swapSecret: string | undefined;
    let paymentHash: string | undefined;
    if(srcToken.startsWith("LIGHTNING")) {
        // Generate random preimage
        const secret = randomBytes(32);
        // Compute sha256 hash of the preimage - this is the swap hash
        paymentHash = createHash("sha256").update(secret).digest().toString("hex");
        swapSecret = secret.toString("hex");
    }

    console.log(`\nCreating swap: ${srcToken} → ${dstToken}, ${amount} (${amountType})`);
    console.log(`  src: ${srcAddress || "(empty)"}  dst: ${dstAddress || "(empty)"}`);

    const response = await fetch(API_URL+"/createSwap", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({srcToken, dstToken, amount, amountType, srcAddress, dstAddress, paymentHash})
    });
    if(!response.ok) throw new Error(`Submit creating swap (${response.status}): `+await response.text());
    const swap: any = await response.json();

    const swapId: string = swap.swapId;
    console.log(`\nSwap created: ${swapId} (${swap.swapType})`);
    console.log(`  ${swap.quote.inputAmount.amount} ${swap.quote.inputAmount.symbol} → ${swap.quote.outputAmount.amount} ${swap.quote.outputAmount.symbol}`);
    console.log(`  Fees: swap=${swap.quote.fees.swap.amount} ${swap.quote.fees.swap.symbol}${swap.quote.fees.networkOutput ? `, network_output=${swap.quote.fees.networkOutput.amount} ${swap.quote.fees.networkOutput.symbol}` : ""}`);
    console.log(`  Expires in ${Math.round((swap.quote.expiry - Date.now()) / 1000)}s`);

    console.log("\nRun the process swap script to execute the swap, swapId:");
    console.log(swapId);

    if(swapSecret!=null) {
        console.log("\nSince you are swapping from lightning, also pass the following secret to the process function:");
        console.log(swapSecret);
    }

    return {swapId, swapSecret};
}

// Handle command line arguments
// Always use chain prefix for a given token!
if(require.main === module) {
    let [srcToken, dstToken, amount, amountType, destinationAddress, sourceAddress] = process.argv.slice(2);
    if (!srcToken || !dstToken || !amount || !amountType) {
        console.error("Usage: test-swap <srcToken> <dstToken> <amount> <amountType> [destinationAddress] [sourceAddress]");
        console.error("Example: npx ts-node scripts/create-swap.ts BITCOIN-BTC STARKNET-STRK 3000 EXACT_IN");
    } else {
        createSwap(
            srcToken, dstToken,
            amount, amountType,
            destinationAddress==="" || destinationAddress==="-" ? undefined : destinationAddress,
            sourceAddress==="" || sourceAddress==="-" ? undefined : sourceAddress
        ).catch(e => console.error(e));
    }
}
