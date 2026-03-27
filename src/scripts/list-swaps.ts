const API_URL = process.env.API_URL || "http://localhost:3000";

const signer = process.argv[2];
if (!signer) {
    console.error("Usage: list-swaps <signerAddress>");
    process.exit(1);
}

async function main() {
    const res = await fetch(`${API_URL}/listSwaps?${new URLSearchParams({signer})}`);
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
