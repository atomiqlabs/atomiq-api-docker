import "dotenv/config";
import fs from "fs";
import {Keypair} from "@solana/web3.js";
import {Account, CallData, DeployAccountContractPayload, ec, hash} from "starknet";
import {BaseWallet, SigningKey, Wallet} from "ethers";
import {getAddress, NETWORK, TEST_NETWORK, WIF} from "@scure/btc-signer";
import {pubECDSA, randomPrivateKeyBytes} from "@scure/btc-signer/utils";

// Solana signer via `@solana/web3.js`
const solanaKey = fs.existsSync("solana.key") ? fs.readFileSync("solana.key") : Keypair.generate().secretKey;
fs.writeFileSync("solana.key", solanaKey);
const solanaWallet = Keypair.fromSecretKey(solanaKey);
console.log("Solana wallet address: "+solanaWallet.publicKey.toString());

// Starknet signer via `starknet`
const OZaccountClassHash = '0x00261c293c8084cd79086214176b33e5911677cec55104fddc8d25b0b736dcad';
const starknetKey = fs.existsSync("starknet.key")
    ? fs.readFileSync("starknet.key").toString()
    : "0x"+Buffer.from(ec.starkCurve.utils.randomPrivateKey()).toString("hex");
fs.writeFileSync("starknet.key", starknetKey);
const starknetPublicKey = ec.starkCurve.getStarkKey(starknetKey);
const OZaccountConstructorCallData = CallData.compile({ publicKey: starknetPublicKey });
const OZcontractAddress = hash.calculateContractAddressFromHash(
    starknetPublicKey,
    OZaccountClassHash,
    OZaccountConstructorCallData,
    0
);
const starknetWalletDeloymentPayload: DeployAccountContractPayload = {
    classHash: OZaccountClassHash,
    constructorCalldata: OZaccountConstructorCallData,
    addressSalt: starknetPublicKey,
    contractAddress: OZcontractAddress
}
const starknetWallet = new Account({
    provider: {},
    address: OZcontractAddress,
    signer: starknetKey,
    cairoVersion: "1"
})
console.log("Starknet wallet address: "+starknetWallet.address);

// EVM signer via `ethers`
const evmKey = fs.existsSync("evm.key")
    ? fs.readFileSync("evm.key").toString()
    : Wallet.createRandom().privateKey;
fs.writeFileSync("evm.key", evmKey);
const evmWallet = new BaseWallet(new SigningKey(evmKey));
console.log("EVM wallet address: "+evmWallet.address);

// Bitcoin signer via `@scure/btc-signer`
const bitcoinKey = fs.existsSync("bitcoin.key")
    ? fs.readFileSync("bitcoin.key").toString()
    : WIF().encode(randomPrivateKeyBytes());
fs.writeFileSync("bitcoin.key", bitcoinKey);
const bitcoinPrivateKey = WIF().decode(bitcoinKey);
const bitcoinPublicKey = Buffer.from(pubECDSA(bitcoinPrivateKey)).toString("hex");
const bitcoinWallet = {
    privateKey: bitcoinPrivateKey,
    publicKey: bitcoinPublicKey,
    address: getAddress("wpkh", bitcoinPrivateKey, process.env.BITCOIN_NETWORK==="MAINNET" ? NETWORK : TEST_NETWORK)
};
console.log("Bitcoin wallet address: "+bitcoinWallet.address);

export {
    solanaWallet,
    starknetWalletDeloymentPayload,
    starknetWallet,
    evmWallet,
    bitcoinWallet
};
