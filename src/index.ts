import express from "express";
import {SwapperFactory, BitcoinNetwork} from "@atomiqlabs/sdk";
import {SqliteUnifiedStorage, SqliteStorageManager} from "@atomiqlabs/storage-sqlite";
import {StarknetInitializer} from "@atomiqlabs/chain-starknet";
import {SwapperApi} from "@atomiqlabs/sdk/api";

const port = process.env.PORT || 3000;
const starknetRpc = process.env.STARKNET_RPC || "https://starknet-mainnet.public.blastapi.io/rpc/v0_8";
const bitcoinNetwork = process.env.BITCOIN_NETWORK === "MAINNET" ? BitcoinNetwork.MAINNET : BitcoinNetwork.TESTNET;

const chains = [StarknetInitializer] as const;

const Factory = new SwapperFactory(chains);

const swapper = Factory.newSwapper({
    chains: {
        STARKNET: {
            rpcUrl: starknetRpc
        }
    },
    bitcoinNetwork,
    swapStorage: chainId => new SqliteUnifiedStorage("CHAIN_" + chainId + ".sqlite3"),
    chainStorageCtor: name => new SqliteStorageManager("STORE_" + name + ".sqlite3"),
});

const api = new SwapperApi(swapper);

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
    res.json({status: "ok"});
});

// Wire up SwapperApi endpoints
for (const [name, endpoint] of Object.entries(api.endpoints)) {
    const path = "/" + name;
    const handler = async (req: express.Request, res: express.Response) => {
        try {
            const input = endpoint.type === "GET" ? req.query : req.body;
            const result = await endpoint.callback(input);
            res.json(result);
        } catch (err: any) {
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

    app.listen(port, () => {
        console.log(`atomiq-api listening on port ${port}`);
    });
}

main().catch(err => {
    console.error("Failed to start:", err);
    process.exit(1);
});
