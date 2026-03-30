import {createSwap} from "./simple-create-swap";
import {processSwap} from "./simple-process-swap";

const DELAY_BETWEEN_SWAPS_MS = 60_000;

interface SwapDef {
    src: string;
    dst: string;
    amount: string;
    amountType: string;
}

const swaps: SwapDef[] = [
    {src: "BITCOIN-BTC", dst: "STARKNET-STRK", amount: "3000", amountType: "EXACT_IN"},
    {src: "STARKNET-STRK", dst: "BITCOIN-BTC", amount: "3000", amountType: "EXACT_OUT"},
    {src: "BITCOIN-BTC", dst: "SOLANA-SOL", amount: "3000", amountType: "EXACT_IN"},
    {src: "SOLANA-SOL", dst: "BITCOIN-BTC", amount: "3000", amountType: "EXACT_OUT"},
];

function label(i: number, swap: SwapDef): string {
    const srcChain = swap.src.split("-")[1];
    const dstChain = swap.dst.split("-")[1];
    return `[${i + 1}: ${srcChain}->${dstChain}]`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSwap(i: number, swap: SwapDef): Promise<{swap: SwapDef, status: "success" | "failure", error?: string}> {
    const tag = label(i, swap);
    try {
        console.log(`\n${tag} Creating swap: ${swap.src} -> ${swap.dst}, ${swap.amount} ${swap.amountType}`);
        const {swapId, swapSecret} = await createSwap(swap.src, swap.dst, swap.amount, swap.amountType);
        console.log(`${tag} Swap created: ${swapId}`);

        console.log(`${tag} Processing swap...`);
        await processSwap(swapId, swapSecret);
        console.log(`${tag} Swap completed successfully`);

        return {swap, status: "success"};
    } catch (e: any) {
        console.error(`${tag} Swap FAILED: ${e.message}`);
        return {swap, status: "failure", error: e.message};
    }
}

async function main() {
    console.log("=== Atomiq Test Harness ===");
    console.log(`Running ${swaps.length} swaps with ${DELAY_BETWEEN_SWAPS_MS / 1000}s delay between initiations\n`);

    const promises: Promise<{swap: SwapDef, status: "success" | "failure", error?: string}>[] = [];

    for (let i = 0; i < swaps.length; i++) {
        if (i > 0) {
            console.log(`\n--- Waiting ${DELAY_BETWEEN_SWAPS_MS / 1000}s before next swap ---`);
            await sleep(DELAY_BETWEEN_SWAPS_MS);
        }
        promises.push(runSwap(i, swaps[i]));
    }

    const results = await Promise.allSettled(promises);

    // Print summary
    console.log("\n\n========== SUMMARY ==========");
    console.log("Swap".padEnd(25) + "Status".padEnd(12) + "Error");
    console.log("-".repeat(60));
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const tag = label(i, swaps[i]);
        if (r.status === "fulfilled") {
            const line = tag.padEnd(25) + r.value.status.toUpperCase().padEnd(12) + (r.value.error ?? "");
            console.log(line);
        } else {
            const line = tag.padEnd(25) + "FAILURE".padEnd(12) + r.reason?.message;
            console.log(line);
        }
    }
    console.log("=".repeat(60));

    const failures = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && r.value.status === "failure"));
    if (failures.length > 0) {
        console.log(`\n${failures.length}/${results.length} swaps failed.`);
        process.exit(1);
    } else {
        console.log(`\nAll ${results.length} swaps completed successfully.`);
    }
}

main().catch(e => {
    console.error("Test harness fatal error:", e);
    process.exit(1);
});
