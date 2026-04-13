import express from "express";
import morgan from "morgan";
import {SwapperFactory, BitcoinNetwork} from "@atomiqlabs/sdk";
import {SqliteUnifiedStorage, SqliteStorageManager} from "@atomiqlabs/storage-sqlite";
import {StarknetInitializer} from "@atomiqlabs/chain-starknet";
import {SwapperApi} from "@atomiqlabs/sdk/api";
import {SolanaInitializer} from "@atomiqlabs/chain-solana";
import {loadConfig} from "./config";
import {createAuthMiddleware} from "./auth";
import {createRateLimitMiddleware} from "./rateLimit";


(global as any).atomiqLogLevel = 3;

const config = loadConfig();

const bitcoinNetwork = config.bitcoinNetwork === "MAINNET" ? BitcoinNetwork.MAINNET : BitcoinNetwork.TESTNET;

const chains = [StarknetInitializer, SolanaInitializer] as const;

const Factory = new SwapperFactory(chains);

const swapper = Factory.newSwapper({
    chains: {
        STARKNET: config.starknetRpc == null ? null! : {
            rpcUrl: config.starknetRpc
        },
        SOLANA: config.solanaRpc == null ? null! : {
            rpcUrl: config.solanaRpc
        }
    },
    bitcoinNetwork,
    swapStorage: chainId => new SqliteUnifiedStorage("CHAIN_" + chainId + ".sqlite3"),
    chainStorageCtor: name => new SqliteStorageManager("STORE_" + name + ".sqlite3"),
});

const api = new SwapperApi(swapper);

const app = express();
app.use(morgan("combined"));
app.use(express.json());

// Health check (before auth — always accessible)
app.get("/health", (_req, res) => {
    res.json({status: "ok"});
});

// Auth + Rate limiting
app.use(createAuthMiddleware(config));
app.use(createRateLimitMiddleware(config.rateLimit));

// Wire up SwapperApi endpoints
for (const [name, endpoint] of Object.entries(api.endpoints)) {
    const path = "/" + name;
    const handler = async (req: express.Request, res: express.Response) => {
        try {
            const result = await endpoint.callbackRaw(
                endpoint.type === "GET" ? req.query : req.body
            );
            res.json(result);
        } catch (err: any) {
            console.warn(err);
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

    console.log(`Auth paths: ${config.auth.length}`);
    console.log(`Global rate limit: ${config.rateLimit.maxRequests} req / ${config.rateLimit.windowMs}ms`);
    console.log(`Chains: Starknet=${config.starknetRpc ? "enabled" : "disabled"}, Solana=${config.solanaRpc ? "enabled" : "disabled"}`);
    console.log(`Bitcoin network: ${config.bitcoinNetwork}`);

    app.listen(config.port, () => {
        console.log(`atomiq-api listening on port ${config.port}`);
    });
}

main().catch(err => {
    console.error("Failed to start:", err);
    process.exit(1);
});
