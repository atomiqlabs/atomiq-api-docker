import {RequestHandler} from "express";
import * as jwt from "jsonwebtoken";
import {AuthEntry, Config, RateLimitConfig} from "./config";

declare global {
    namespace Express {
        interface Request {
            auth?: { name: string; type: string };
            rateLimitOverride?: RateLimitConfig | null;
        }
    }
}

function matchClaims(payload: any, claims: Record<string, any>): boolean {
    for (const [key, expected] of Object.entries(claims)) {
        const actual = payload[key];
        if (typeof expected === "object" && expected !== null && "includes" in expected) {
            if (!Array.isArray(actual) || !actual.includes(expected.includes)) return false;
        } else {
            if (actual !== expected) return false;
        }
    }
    return true;
}

function tryMatch(req: any, entry: AuthEntry): boolean {
    switch (entry.type) {
        case "apiKey": {
            const header = entry.header || "x-api-key";
            const value = req.headers[header.toLowerCase()];
            return value === entry.apiKey;
        }
        case "jwt": {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
            const token = authHeader.slice(7);
            try {
                const payload = jwt.verify(token, entry.publicKey, {
                    algorithms: entry.algorithms as jwt.Algorithm[],
                });
                if (entry.claims && !matchClaims(payload, entry.claims)) return false;
                return true;
            } catch {
                return false;
            }
        }
        case "none":
            return true;
        default:
            return false;
    }
}

export function createAuthMiddleware(config: Config): RequestHandler {
    return (req, res, next) => {
        for (const entry of config.auth) {
            if (tryMatch(req, entry)) {
                req.auth = { name: entry.name, type: entry.type };
                req.rateLimitOverride = entry.rateLimit;
                next();
                return;
            }
        }
        res.status(401).json({ error: "Unauthorized" });
    };
}
