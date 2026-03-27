import * as fs from "fs";
import {SingleAddressBitcoinWallet, BitcoinNetwork} from "@atomiqlabs/sdk";
import {StarknetKeypairWallet} from "@atomiqlabs/chain-starknet";
import {SolanaKeypairWallet} from "@atomiqlabs/chain-solana";
import {Keypair} from "@solana/web3.js";
import {BaseWallet, SigningKey} from "ethers";
import {RpcProvider} from "starknet";

if (fs.existsSync("bitcoin.key")) {
    const wallet = new SingleAddressBitcoinWallet(null as any, BitcoinNetwork.TESTNET, fs.readFileSync("bitcoin.key", "utf8").trim());
    console.log(`Bitcoin:  ${wallet.getReceiveAddress()}`);
}

if (fs.existsSync("starknet.key")) {
    const rpc = new RpcProvider({nodeUrl: "https://starknet-sepolia.public.blastapi.io/rpc/v0_9"});
    const wallet = new StarknetKeypairWallet(rpc, fs.readFileSync("starknet.key", "utf8").trim());
    console.log(`Starknet: ${wallet.address}`);
}

if (fs.existsSync("solana.key")) {
    const wallet = new SolanaKeypairWallet(Keypair.fromSecretKey(fs.readFileSync("solana.key")));
    console.log(`Solana:   ${wallet.publicKey.toString()}`);
}

if (fs.existsSync("evm.key")) {
    const wallet = new BaseWallet(new SigningKey(fs.readFileSync("evm.key", "utf8").trim()));
    console.log(`EVM:      ${wallet.address}`);
}
