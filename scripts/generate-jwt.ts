import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import * as jwt from "jsonwebtoken";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JwtSpec {
    payload: string | Buffer | object;
    options?: jwt.SignOptions;
}

function printUsage(): void {
    console.error("Usage: npx ts-node --project tsconfig.scripts.json scripts/generate-jwt.ts <payload-json|spec-json> [private-key]");
    console.error('Example payload: npx ts-node --project tsconfig.scripts.json scripts/generate-jwt.ts \'{"sub":"demo","scope":["swaps"]}\'');
    console.error('Example spec: npx ts-node --project tsconfig.scripts.json scripts/generate-jwt.ts \'{"payload":{"sub":"demo"},"options":{"expiresIn":"1h"}}\'');
}

function parseJsonArg(raw: string): JsonValue {
    try {
        return JSON.parse(raw) as JsonValue;
    } catch (error) {
        throw new Error(`Invalid JSON argument: ${(error as Error).message}`);
    }
}

function normalizePemInput(rawKey: string): string {
    return rawKey
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .trim();
}

function encodePemSingleLine(pem: string): string {
    return pem
        .trim()
        .replace(/\r?\n/g, "\\n");
}

function isPlainObject(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJwtSpec(value: JsonValue): JwtSpec {
    if (isPlainObject(value) && "payload" in value) {
        const payload = value.payload;
        if (payload === undefined) {
            throw new Error("JWT spec JSON must include a 'payload' field");
        }

        const optionsValue = value.options;
        if (optionsValue !== undefined && !isPlainObject(optionsValue)) {
            throw new Error("JWT spec 'options' must be a JSON object");
        }

        return {
            payload: payload as string | Buffer | object,
            options: optionsValue as jwt.SignOptions | undefined,
        };
    }

    return {
        payload: value as string | Buffer | object,
    };
}

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
    return key.export({ format: "pem", type }) as string;
}

function inferAlgorithm(privateKey: KeyObject): jwt.Algorithm {
    switch (privateKey.asymmetricKeyType) {
        case "rsa":
            return "RS256";
        case "rsa-pss":
            return "PS256";
        case "ed25519":
        case "ed448":
            throw new Error("Ed25519/Ed448 keys are not supported by the installed jsonwebtoken version");
        case "ec": {
            const namedCurve = privateKey.asymmetricKeyDetails?.namedCurve;
            switch (namedCurve) {
                case "prime256v1":
                case "secp256r1":
                    return "ES256";
                case "secp384r1":
                    return "ES384";
                case "secp521r1":
                    return "ES512";
                default:
                    throw new Error(`Unsupported EC curve for JWT signing: ${namedCurve ?? "unknown"}`);
            }
        }
        default:
            throw new Error(`Unsupported private key type for JWT signing: ${privateKey.asymmetricKeyType ?? "unknown"}`);
    }
}

function resolveSigningKey(rawKey?: string): {
    privateKey: KeyObject;
    privateKeyPem: string;
    publicKeyPem: string;
    algorithm: jwt.Algorithm;
} {
    if (rawKey == null) {
        const generated = generateKeyPairSync("ec", {
            namedCurve: "prime256v1",
            publicKeyEncoding: { format: "pem", type: "spki" },
            privateKeyEncoding: { format: "pem", type: "pkcs8" },
        });

        return {
            privateKey: createPrivateKey(generated.privateKey),
            privateKeyPem: generated.privateKey,
            publicKeyPem: generated.publicKey,
            algorithm: "ES256",
        };
    }

    const privateKeyPem = normalizePemInput(rawKey);
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKeyPem = exportPem(createPublicKey(privateKey), "spki");

    return {
        privateKey,
        privateKeyPem,
        publicKeyPem,
        algorithm: inferAlgorithm(privateKey),
    };
}

function signJwt(spec: JwtSpec, privateKey: KeyObject, defaultAlgorithm: jwt.Algorithm): string {
    const options: jwt.SignOptions = {
        ...spec.options,
        algorithm: spec.options?.algorithm ?? defaultAlgorithm,
    };

    return jwt.sign(spec.payload, privateKey, options);
}

export function main(): void {
    const [specArg, privateKeyArg] = process.argv.slice(2);
    if (!specArg) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    try {
        const spec = toJwtSpec(parseJsonArg(specArg));
        const signingKey = resolveSigningKey(privateKeyArg);
        const token = signJwt(spec, signingKey.privateKey, signingKey.algorithm);

        console.log("Signing private key:");
        console.log(signingKey.privateKeyPem);
        console.log("Signing private key (single-line PEM):");
        console.log(encodePemSingleLine(signingKey.privateKeyPem));
        console.log();
        console.log("Signing public key:");
        console.log(signingKey.publicKeyPem);
        console.log("Signing public key (single-line PEM):");
        console.log(encodePemSingleLine(signingKey.publicKeyPem));
        console.log();
        console.log("JWT token:");
        console.log(token);
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}
