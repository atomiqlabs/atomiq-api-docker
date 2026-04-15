import { readFileSync } from "fs";
import { parse } from "yaml";
import * as path from "path";

export interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
}

export interface ApiKeyAuthEntry {
    type: "apiKey";
    name: string;
    apiKey: string;
    header?: string;
    rateLimit?: RateLimitConfig | null;
}

export interface JwtAuthEntry {
    type: "jwt";
    name: string;
    publicKey: string;
    algorithms: string[];
    claims?: Record<string, string | { includes: string }>;
    rateLimit?: RateLimitConfig | null;
}

export interface NoneAuthEntry {
    type: "none";
    name: string;
    rateLimit?: RateLimitConfig | null;
}

export type AuthEntry = ApiKeyAuthEntry | JwtAuthEntry | NoneAuthEntry;

export interface CorsConfig {
    origin: string | string[];
    methods?: string[];
    allowedHeaders?: string[];
}

export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVEL_MAP: Record<LogLevel, 0 | 1 | 2 | 3> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

export function logLevelToNumber(level: LogLevel): 0 | 1 | 2 | 3 {
    return LOG_LEVEL_MAP[level];
}

export interface Config {
    logLevel: LogLevel;

    starknetRpc: string | null;
    solanaRpc: string | null;
    botanixRpc: string | null;
    citreaRpc: string | null;
    alpenRpc: string | null;
    goatRpc: string | null;
    bitcoinNetwork: "TESTNET" | "TESTNET3" | "TESTNET4" | "MAINNET";

    swapsSyncIntervalSeconds: number;
    reloadLpIntervalSeconds: number;

    port: number;
    rateLimit: RateLimitConfig;
    auth: AuthEntry[];
    cors: CorsConfig | null;
}

export function loadConfig(): Config {
    const configPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), "config.yaml");

    let raw: string;
    try {
        raw = readFileSync(configPath, "utf-8");
    } catch {
        throw new Error(`config.yaml not found at ${configPath}`);
    }

    const doc = parse(raw);
    if (!doc || typeof doc !== "object") {
        throw new Error("config.yaml is empty or malformed");
    }

    if (typeof doc.port !== "number") {
        throw new Error("config.yaml: 'port' is required and must be a number");
    }

    if (!doc.bitcoinNetwork || !["TESTNET", "TESTNET3", "TESTNET4", "MAINNET"].includes(doc.bitcoinNetwork)) {
        throw new Error("config.yaml: 'bitcoinNetwork' must be TESTNET or MAINNET");
    }

    const validLogLevels = ["error", "warn", "info", "debug"];
    if (doc.logLevel !== undefined && !validLogLevels.includes(doc.logLevel)) {
        throw new Error(`config.yaml: 'logLevel' must be one of: ${validLogLevels.join(", ")}`);
    }

    if (!doc.rateLimit || typeof doc.rateLimit.windowMs !== "number" || typeof doc.rateLimit.maxRequests !== "number") {
        throw new Error("config.yaml: 'rateLimit' with windowMs and maxRequests is required");
    }

    if (!Array.isArray(doc.auth) || doc.auth.length === 0) {
        throw new Error("config.yaml: 'auth' must be a non-empty array");
    }

    for (const [i, entry] of doc.auth.entries()) {
        if (!entry.name || typeof entry.name !== "string") {
            throw new Error(`config.yaml: auth[${i}] must have a 'name' string`);
        }
        if (!["apiKey", "jwt", "none"].includes(entry.type)) {
            throw new Error(`config.yaml: auth[${i}] '${entry.name}' has invalid type '${entry.type}' (must be apiKey, jwt, or none)`);
        }
        if (entry.type === "apiKey") {
            if (!entry.apiKey || typeof entry.apiKey !== "string") {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' (apiKey) must have an 'apiKey' string`);
            }
        }
        if (entry.type === "jwt") {
            if (!entry.publicKey || typeof entry.publicKey !== "string") {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' (jwt) must have a 'publicKey' string`);
            }
            if (!Array.isArray(entry.algorithms) || entry.algorithms.length === 0) {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' (jwt) must have a non-empty 'algorithms' array`);
            }
        }
        if (entry.rateLimit !== undefined && entry.rateLimit !== null) {
            if (typeof entry.rateLimit.windowMs !== "number" || typeof entry.rateLimit.maxRequests !== "number") {
                throw new Error(`config.yaml: auth[${i}] '${entry.name}' rateLimit must have windowMs and maxRequests`);
            }
        }
    }

    // Validate cors if present
    let cors: CorsConfig | null = null;
    if (doc.cors != null) {
        if (typeof doc.cors.origin !== "string" && !Array.isArray(doc.cors.origin)) {
            throw new Error("config.yaml: 'cors.origin' must be a string or array of strings");
        }
        cors = doc.cors;
    }

    if (doc.swapsSyncIntervalSeconds!=null && typeof doc.swapsSyncIntervalSeconds !== "number") {
        throw new Error("config.yaml: 'swapsSyncIntervalSeconds' if defined, must be a number");
    }
    if (doc.reloadLpIntervalSeconds!=null && typeof doc.reloadLpIntervalSeconds !== "number") {
        throw new Error("config.yaml: 'reloadLpIntervalSeconds' if defined, must be a number");
    }

    return {
        port: doc.port,
        starknetRpc: doc.starknetRpc ?? null,
        solanaRpc: doc.solanaRpc ?? null,
        botanixRpc: doc.botanixRpc ?? null,
        citreaRpc: doc.citreaRpc ?? null,
        alpenRpc: doc.alpenRpc ?? null,
        goatRpc: doc.goatRpc ?? null,
        bitcoinNetwork: doc.bitcoinNetwork,
        logLevel: doc.logLevel ?? "info",
        rateLimit: doc.rateLimit,
        auth: doc.auth,
        cors,

        swapsSyncIntervalSeconds: doc.swapsSyncIntervalSeconds ?? 300,
        reloadLpIntervalSeconds: doc.reloadLpIntervalSeconds ?? 300,
    };
}
