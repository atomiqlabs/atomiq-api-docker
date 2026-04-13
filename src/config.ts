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

export interface Config {
    port: number;
    starknetRpc: string | null;
    solanaRpc: string | null;
    bitcoinNetwork: "TESTNET" | "MAINNET";
    rateLimit: RateLimitConfig;
    auth: AuthEntry[];
}

export function loadConfig(): Config {
    const configPath = path.resolve(process.cwd(), "config.yaml");

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

    if (!doc.bitcoinNetwork || !["TESTNET", "MAINNET"].includes(doc.bitcoinNetwork)) {
        throw new Error("config.yaml: 'bitcoinNetwork' must be TESTNET or MAINNET");
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

    return {
        port: doc.port,
        starknetRpc: doc.starknetRpc ?? null,
        solanaRpc: doc.solanaRpc ?? null,
        bitcoinNetwork: doc.bitcoinNetwork,
        rateLimit: doc.rateLimit,
        auth: doc.auth,
    };
}
