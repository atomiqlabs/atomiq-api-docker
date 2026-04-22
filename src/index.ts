import "dotenv/config";
import { mkdirSync } from "fs";
import * as path from "path";
import express from "express";
import morgan from "morgan";
import {BitcoinNetwork, SwapperFactory} from "@atomiqlabs/sdk";
import {SqliteStorageManager, SqliteUnifiedStorage} from "@atomiqlabs/storage-sqlite";
import {StarknetInitializer} from "@atomiqlabs/chain-starknet";
import {SwapperApi} from "@atomiqlabs/sdk/api";
import {SolanaInitializer} from "@atomiqlabs/chain-solana";
import cors from "cors";
import {loadConfig, logLevelToNumber} from "./config";
import {createAuthMiddleware} from "./auth";
import {createRateLimitMiddleware} from "./rateLimit";
import {AlpenInitializer, BotanixInitializer, CitreaInitializer, GoatInitializer} from "@atomiqlabs/chain-evm";
import {startServer} from "./server";


const config = loadConfig();
const logLevelNumber = logLevelToNumber(config.logLevel);
(global as any).atomiqLogLevel = logLevelNumber;

const bitcoinNetwork = config.bitcoinNetwork === "MAINNET"
    ? BitcoinNetwork.MAINNET
    : config.bitcoinNetwork === "TESTNET4"
        ? BitcoinNetwork.TESTNET4
        : BitcoinNetwork.TESTNET3;

const chains = [
    StarknetInitializer,
    SolanaInitializer,
    BotanixInitializer,
    CitreaInitializer,
    AlpenInitializer,
    GoatInitializer
] as const;

const Factory = new SwapperFactory(chains);
const storageDir = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? ".");
mkdirSync(storageDir, {recursive: true});
const resolveStoragePath = (fileName: string) => path.join(storageDir, fileName);

const swapper = Factory.newSwapper({
    chains: {
        STARKNET: config.starknetRpc == null ? null! : {
            rpcUrl: config.starknetRpc
        },
        SOLANA: config.solanaRpc == null ? null! : {
            rpcUrl: config.solanaRpc
        },
        BOTANIX: config.botanixRpc == null ? null! : {
            rpcUrl: config.botanixRpc
        },
        CITREA: config.citreaRpc == null ? null! : {
            rpcUrl: config.citreaRpc
        },
        ALPEN: config.alpenRpc == null ? null! : {
            rpcUrl: config.alpenRpc
        },
        GOAT: config.goatRpc == null ? null! : {
            rpcUrl: config.goatRpc
        }
    },
    bitcoinNetwork,
    swapStorage: chainId => new SqliteUnifiedStorage(resolveStoragePath("CHAIN_" + chainId + ".sqlite3")),
    chainStorageCtor: name => new SqliteStorageManager(resolveStoragePath("STORE_" + name + ".sqlite3")),
});

const api = new SwapperApi(swapper);

const app = express();
app.set("trust proxy", config.trustProxy);
if (logLevelNumber>=2) app.use(morgan("combined"));
if (logLevelNumber>=3) app.use((req, res, next) => {
    console.log({
        time: new Date().toISOString(),
        remoteAddress: req.socket.remoteAddress,
        remoteFamily: req.socket.remoteFamily,
        host: req.headers.host,
        xff: req.headers['x-forwarded-for'],
        ua: req.headers['user-agent'],
        method: req.method,
        url: req.originalUrl,
    });
    next();
});
app.use(express.json());
if (config.cors) {
    app.use(cors(config.cors));
}

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

function scheduleSyncTimer() {
    let run: () => Promise<void>;
    run = async () => {
        try {
            await api.sync();
        } catch (e) {
            console.error("Main: Swaps sync timer, error while syncing: ", e);
        }
        setTimeout(run, config.swapsSyncIntervalSeconds * 1000);
    }
    setTimeout(run, config.swapsSyncIntervalSeconds * 1000);
}

function scheduleLpReloadTimer() {
    let run: () => Promise<void>;
    run = async () => {
        try {
            await api.reloadLps();
        } catch (e) {
            console.error("Main: LP reload timer, error while reloading LPs: ", e);
        }
        setTimeout(run, config.reloadLpIntervalSeconds * 1000);
    }
    setTimeout(run, config.reloadLpIntervalSeconds * 1000);
}

async function main() {
    console.log("Initializing SwapperApi...");
    await api.init();
    scheduleLpReloadTimer();
    scheduleSyncTimer();
    console.log("SwapperApi initialized.");

    console.log(`Log level: ${config.logLevel} (${logLevelToNumber(config.logLevel)})`);
    console.log(`Auth paths: ${config.auth.length}`);
    console.log(`Global rate limit: ${config.rateLimit.maxRequests} req / ${config.rateLimit.windowMs}ms`);
    console.log(`Trust proxy: ${config.trustProxy}`);
    console.log(`Storage directory: ${storageDir}`);
    console.log(`Chains: ${swapper.getSmartChains().join(", ")}`);
    console.log(`Bitcoin network: ${config.bitcoinNetwork}`);

    startServer(app, config);
}

main().catch(err => {
    console.error("Failed to start:", err);
    process.exit(1);
});
