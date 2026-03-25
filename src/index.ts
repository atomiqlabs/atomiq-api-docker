import "dotenv/config";
import express from "express";
import {SwapperFactory, BitcoinNetwork} from "@atomiqlabs/sdk";
import {SqliteUnifiedStorage, SqliteStorageManager} from "@atomiqlabs/storage-sqlite";
import {StarknetInitializer} from "@atomiqlabs/chain-starknet";
import {SwapperApi, InputSchemaField} from "@atomiqlabs/sdk/api";

const port = process.env.PORT || 3000;
const starknetRpc = process.env.STARKNET_RPC || "https://starknet-sepolia.public.blastapi.io/rpc/v0_9";
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

// Validate and coerce input against endpoint's inputSchema
// Always coerce strings to declared types (query params are strings, and POST bodies might be too)
// Recursively validates nested objects (via properties) and array elements (via items)
function validateAndCoerce(
    raw: any,
    schema: Record<string, InputSchemaField<any>>,
    prefix: string = ""
): {input: any; error: string | null} {
    const input = {...raw};
    const path = (field: string) => prefix ? `${prefix}.${field}` : field;

    for (const [field, rule] of Object.entries(schema)) {
        const value = input[field];

        if (rule.required && (value === undefined || value === null || value === "")) {
            return {input, error: `Missing required field: '${path(field)}' — ${rule.description}`};
        }

        if (value === undefined || value === null || value === "") continue;

        switch (rule.type) {
            case "number": {
                const num = Number(value);
                if (isNaN(num)) return {input, error: `Field '${path(field)}' must be a number`};
                input[field] = num;
                break;
            }
            case "boolean": {
                if (value === true || value === "true") input[field] = true;
                else if (value === false || value === "false") input[field] = false;
                else return {input, error: `Field '${path(field)}' must be a boolean`};
                break;
            }
            case "array": {
                if (!Array.isArray(value)) return {input, error: `Field '${path(field)}' must be an array`};
                if (rule.items) {
                    for (let i = 0; i < value.length; i++) {
                        const itemRule = rule.items as InputSchemaField<any>;
                        // Validate element type and coerce
                        switch (itemRule.type) {
                            case "string":
                                if (typeof value[i] !== "string")
                                    return {input, error: `Field '${path(field)}[${i}]' must be a string`};
                                break;
                            case "number": {
                                const num = Number(value[i]);
                                if (isNaN(num))
                                    return {input, error: `Field '${path(field)}[${i}]' must be a number`};
                                value[i] = num;
                                break;
                            }
                            case "object":
                                if (typeof value[i] !== "object" || Array.isArray(value[i]))
                                    return {input, error: `Field '${path(field)}[${i}]' must be an object`};
                                if (itemRule.properties) {
                                    const nested = validateAndCoerce(value[i], itemRule.properties as Record<string, InputSchemaField<any>>, `${path(field)}[${i}]`);
                                    if (nested.error) return nested;
                                    value[i] = nested.input;
                                }
                                break;
                        }
                    }
                }
                break;
            }
            case "object": {
                if (typeof value !== "object" || Array.isArray(value))
                    return {input, error: `Field '${path(field)}' must be an object`};
                if (rule.properties) {
                    const nested = validateAndCoerce(value, rule.properties as Record<string, InputSchemaField<any>>, path(field));
                    if (nested.error) return nested;
                    input[field] = nested.input;
                }
                break;
            }
        }
    }
    return {input, error: null};
}

// Wire up SwapperApi endpoints
for (const [name, endpoint] of Object.entries(api.endpoints)) {
    const path = "/" + name;
    const handler = async (req: express.Request, res: express.Response) => {
        try {
            const {input, error} = validateAndCoerce(
                endpoint.type === "GET" ? req.query : req.body,
                endpoint.inputSchema as Record<string, InputSchemaField<any>>
            );
            if (error) {
                res.status(400).json({error});
                return;
            }
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
