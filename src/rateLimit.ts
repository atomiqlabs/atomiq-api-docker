import {RequestHandler} from "express";
import {RateLimitConfig} from "./config";
import "./auth"; // Ensure Express Request augmentation is loaded

const buckets = new Map<string, { count: number; resetAt: number }>();

export function createRateLimitMiddleware(globalConfig: RateLimitConfig): RequestHandler {
    return (req, res, next) => {
        const override = req.rateLimitOverride;

        // null = no rate limit for this auth path
        if (override === null) {
            next();
            return;
        }

        const config = override || globalConfig;
        const ip = req.ip || "unknown";
        const now = Date.now();

        let bucket = buckets.get(ip);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + config.windowMs };
            buckets.set(ip, bucket);
        }

        bucket.count++;

        if (bucket.count > config.maxRequests) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.status(429).json({ error: "Rate limit exceeded", retryAfter });
            return;
        }

        next();
    };
}
