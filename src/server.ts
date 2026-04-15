import type { Express } from "express";
import { readFileSync, unwatchFile, watchFile } from "fs";
import * as http from "http";
import * as https from "https";
import type { Config, HttpsConfig } from "./config";

const TLS_RELOAD_DELAY_MS = 60_000;
const TLS_WATCH_INTERVAL_MS = 1_000;

function loadTlsOptions(config: HttpsConfig): https.ServerOptions {
    return {
        key: readFileSync(config.keyPath),
        cert: readFileSync(config.certPath),
    };
}

function attachTlsReloadWatcher(server: https.Server, config: HttpsConfig) {
    let reloadTimer: NodeJS.Timeout | null = null;

    const scheduleReload = () => {
        if (reloadTimer != null) {
            clearTimeout(reloadTimer);
        }

        console.log(`TLS files changed, reloading HTTPS certificate in ${TLS_RELOAD_DELAY_MS / 1000}s...`);
        reloadTimer = setTimeout(() => {
            reloadTimer = null;
            try {
                server.setSecureContext(loadTlsOptions(config));
                console.log("HTTPS certificate reloaded.");
            } catch (err) {
                console.error("Failed to reload HTTPS certificate:", err);
            }
        }, TLS_RELOAD_DELAY_MS);
    };

    watchFile(config.keyPath, {interval: TLS_WATCH_INTERVAL_MS}, scheduleReload);
    watchFile(config.certPath, {interval: TLS_WATCH_INTERVAL_MS}, scheduleReload);

    server.on("close", () => {
        if (reloadTimer != null) {
            clearTimeout(reloadTimer);
        }
        unwatchFile(config.keyPath, scheduleReload);
        unwatchFile(config.certPath, scheduleReload);
    });
}

export function startServer(app: Express, config: Config): http.Server | https.Server {
    if (config.https == null) {
        const server = http.createServer(app);
        server.listen(config.port, () => {
            console.log(`atomiq-api listening on port ${config.port}`);
        });
        return server;
    }

    const server = https.createServer(loadTlsOptions(config.https), app);
    attachTlsReloadWatcher(server, config.https);
    server.listen(config.port, () => {
        console.log(`atomiq-api listening on HTTPS port ${config.port}`);
    });
    return server;
}
