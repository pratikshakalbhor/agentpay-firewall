import { ethers, network } from "hardhat";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import dotenv from "dotenv";

dotenv.config();

/// @notice ETH is represented as the zero address in AgentPay.
const ETH = ethers.ZeroAddress;

/** @notice Demo policy caps (same on local and sepolia). */
const ETH_PER_TX_CAP = ethers.parseEther("0.002");   // 0.002 ETH per transaction
const ETH_DAILY_BUDGET = ethers.parseEther("0.01");  // 0.01 ETH per 24h window
const USDC_PER_TX_CAP = 10n * 1_000_000n;            // 10 USDC (6 decimals)
const USDC_DAILY_BUDGET = 50n * 1_000_000n;          // 50 USDC

/** @notice Vault funding. Env override VAULT_FUND_ETH; defaults: 0.05 sepolia, 1 local. */
function vaultFund(isLocal: boolean): bigint {
    const env = process.env.VAULT_FUND_ETH;
    if (env) return ethers.parseEther(env);
    return isLocal ? ethers.parseEther("1") : ethers.parseEther("0.05");
}

/** @notice Gas sent to each funded demo key. Env override DEMO_KEY_GAS_ETH; default 0.002. */
function demoKeyGas(): bigint {
    const env = process.env.DEMO_KEY_GAS_ETH;
    if (env) return ethers.parseEther(env);
    return ethers.parseEther("0.002");
}

/** @notice changeDelay: env override, else 30s local / 600s sepolia. */
function changeDelay(isLocal: boolean): bigint {
    if (process.env.CHANGE_DELAY_SECONDS) {
        return BigInt(process.env.CHANGE_DELAY_SECONDS);
    }
    return isLocal ? 30n : 600n;
}

function usdcUnits(amount: number): bigint {
    return BigInt(amount) * 1_000_000n; // 6 decimals
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRIABLE = /replacement transaction underpriced|nonce too low|nonce expires|transaction nonce|insufficient funds for gas|nonce too high|already known/;

/** @notice Send a transaction and wait for confirmation before returning.
 *  Retries up to 3 times (3s apart) on transient nonce/RPC errors so back-to-back
 *  sends on a public RPC cannot reuse the same nonce.
 */
async function sendTx(
    label: string,
    fn: () => Promise<ethers.TransactionResponse>
): Promise<ethers.TransactionResponse> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const tx = await fn();
            await tx.wait();
            console.log(`  ${label} confirmed (tx ${tx.hash})`);
            return tx;
        } catch (err: any) {
            lastErr = err;
            const msg = String(err?.message || err);
            const retriable = RETRIABLE.test(msg);
            if (!retriable || attempt === 3) throw err;
            console.log(`  retry ${attempt}/3 after 3s for "${label}": ${msg}`);
            await sleepMs(3000);
        }
    }
    throw lastErr;
}

/** @notice Deploy a contract, waiting for both address availability and deployment receipt.
 *  Retries up to 3 times (3s apart) on transient nonce/RPC errors.
 */
async function deployContract(
    label: string,
    fn: () => Promise<ethers.Contract>
): Promise<ethers.Contract> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const contract = await fn();
            await contract.waitForDeployment();
            const deployTx = await (contract as any).deployTransaction;
            if (deployTx) {
                await deployTx.wait();
            }
            console.log(`  ${label} deployed at ${contract.target}`);
            return contract;
        } catch (err: any) {
            lastErr = err;
            const msg = String(err?.message || err);
            const retriable = RETRIABLE.test(msg);
            if (!retriable || attempt === 3) throw err;
            console.log(`  retry ${attempt}/3 after 3s for "${label}": ${msg}`);
            await sleepMs(3000);
        }
    }
    throw lastErr;
}

async function main() {
    const isLocal = network.name === "localhost" || network.name === "hardhat";
    const chainId = Number(network.config.chainId ?? (isLocal ? 31337 : 11155111));
    const delay = changeDelay(isLocal);
    const fund = vaultFund(isLocal);

    console.log(`Network: ${network.name} (chainId ${chainId})`);
    console.log(`changeDelay: ${delay}s, vault funding: ${ethers.formatEther(fund)} ETH`);

    const [owner] = await ethers.getSigners();
    if (!owner) throw new Error("No owner signer configured");

    // ------------------------------------------------------------------
    // Estimate total ETH needed BEFORE sending anything
    // ------------------------------------------------------------------
    const gasMoney = demoKeyGas();
    let demoKeyCount = 0;
    if (isLocal) {
        demoKeyCount = 4; // guardian, agent, merchant, attacker
    } else if (network.name === "sepolia") {
        demoKeyCount = 1; // agent only
    }
    const demoKeyFunding = gasMoney * BigInt(demoKeyCount);
    const estimatedTotal = fund + demoKeyFunding;
    const deployerBal = await ethers.provider.getBalance(owner.address);

    console.log(`Estimated ETH needed: vault ${ethers.formatEther(fund)} + demo keys ${ethers.formatEther(demoKeyFunding)} (${demoKeyCount} x ${ethers.formatEther(gasMoney)}) = ${ethers.formatEther(estimatedTotal)} ETH`);
    console.log(`Deployer balance: ${ethers.formatEther(deployerBal)} ETH`);

    if (deployerBal < estimatedTotal) {
        const shortfall = estimatedTotal - deployerBal;
        console.error(`STOP: deployer short by ${ethers.formatEther(shortfall)} ETH. Fund ${owner.address} first.`);
        process.exit(1);
    }

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------
    let agent: ethers.Wallet;
    let guardian: ethers.Wallet;
    let attacker: ethers.Wallet;
    let merchant: string; // address only is enough (merchant only receives)
    const demoKeys: Record<string, string> = {};

    if (isLocal) {
        // Throwaway wallets funded from the owner for the local demo.
        const makeWallet = async () => {
            const w = ethers.Wallet.createRandom().connect(ethers.provider);
            await sendTx(`fund wallet ${w.address}`, () =>
                owner.sendTransaction({ to: w.address, value: gasMoney })
            );
            return w;
        };
        guardian = await makeWallet();
        agent = await makeWallet();
        merchant = (await makeWallet()).address;
        attacker = await makeWallet();
    } else {
        // Sepolia: owner from PRIVATE_KEY, throwaway demo keys for agent/guardian/attacker.
        if (!process.env.PRIVATE_KEY) {
            throw new Error("PRIVATE_KEY must be set for sepolia deployment");
        }
        guardian = ethers.Wallet.createRandom().connect(ethers.provider);
        agent = ethers.Wallet.createRandom().connect(ethers.provider);
        attacker = ethers.Wallet.createRandom().connect(ethers.provider);
        merchant = ethers.Wallet.createRandom().connect(ethers.provider).address;

        // Sepolia: fund ONLY the demo agent key with gas (guardian/attacker need no on-chain role in this demo).
        await sendTx("fund demo agent key", () =>
            owner.sendTransaction({ to: agent.address, value: gasMoney })
        );
        console.log(`Funded demo agent key ${agent.address} with ${ethers.formatEther(gasMoney)} ETH`);

        demoKeys.guardian = guardian.privateKey;
        demoKeys.agent = agent.privateKey;
        demoKeys.attacker = attacker.privateKey;

        // Persist throwaway demo keys (gitignored) so the demo/agent can reuse them.
        const keysPath = join(process.cwd(), "demo-keys.json");
        writeFileSync(
            keysPath,
            JSON.stringify(
                {
                    network: network.name,
                    note: "THROW AWAY DEMO KEYS — NOT FOR PRODUCTION USE",
                    ...demoKeys,
                },
                null,
                2
            )
        );
        console.log(`Saved throwaway demo keys to ${keysPath} (gitignored)`);
    }

    // ------------------------------------------------------------------
    // Deploy contracts
    // ------------------------------------------------------------------
    const usdc = await deployContract("MockUSDC", () =>
        ethers
            .getContractFactory("MockUSDC")
            .then((f: ethers.ContractFactory) => f.deploy())
    );
    const usdcAddress = await usdc.getAddress();
    console.log(`MockUSDC deployed: ${usdcAddress}`);

    const agentPay = await deployContract("AgentPay", () =>
        ethers
            .getContractFactory("AgentPay")
            .then((f: ethers.ContractFactory) => f.deploy(guardian.address, delay))
    );
    const agentPayAddress = await agentPay.getAddress();
    console.log(`AgentPay deployed: ${agentPayAddress} (guardian=${guardian.address}, changeDelay=${delay}s)`);

    // ------------------------------------------------------------------
    // Fund the vault
    // ------------------------------------------------------------------
    await sendTx("fund vault", () =>
        owner.sendTransaction({ to: agentPayAddress, value: fund })
    );
    console.log(`Vault funded with ${ethers.formatEther(fund)} ETH`);

    // Mint USDC to owner, approve AgentPay, deposit into vault.
    const usdcFund = usdcUnits(1000);
    await sendTx("mint USDC to owner", () =>
        usdc.mint(owner.address, usdcFund)
    );
    await sendTx("approve AgentPay USDC", () =>
        usdc.connect(owner).approve(agentPayAddress, usdcFund)
    );
    const apOwner = agentPay.connect(owner);
    await sendTx("deposit USDC into vault", () =>
        apOwner.depositToken(usdcAddress, usdcFund)
    );
    console.log(`Deposited ${ethers.formatUnits(usdcFund, 6)} USDC into the vault`);

    // ------------------------------------------------------------------
    // Bootstrap policy (loosening changes are queued behind changeDelay).
    // AgentPay has no instant bootstrap path, so we propose then execute
    // after the delay. On local we fast-forward with evm_increaseTime.
    // ------------------------------------------------------------------
    console.log("Proposing policy (queued behind changeDelay)...");
    await sendTx("proposeAddAgent", () => apOwner.proposeAddAgent(agent.address));
    await sendTx("proposeSetPerTxCap ETH", () =>
        apOwner.proposeSetPerTxCap(agent.address, ETH, ETH_PER_TX_CAP)
    );
    await sendTx("proposeSetDailyBudget ETH", () =>
        apOwner.proposeSetDailyBudget(agent.address, ETH, ETH_DAILY_BUDGET)
    );
    await sendTx("proposeSetPerTxCap USDC", () =>
        apOwner.proposeSetPerTxCap(agent.address, usdcAddress, USDC_PER_TX_CAP)
    );
    await sendTx("proposeSetDailyBudget USDC", () =>
        apOwner.proposeSetDailyBudget(agent.address, usdcAddress, USDC_DAILY_BUDGET)
    );
    await sendTx("proposeAddAllowlist merchant", () =>
        apOwner.proposeAddAllowlist(agent.address, merchant)
    );

    if (isLocal) {
        await ethers.provider.send("evm_increaseTime", [Number(delay) + 1]);
        await ethers.provider.send("evm_mine", []);
        console.log(`Fast-forwarded ${delay + 1n}s (past the changeDelay)`);
    } else {
        console.log(`Waiting ${delay}s for the changeDelay before executing proposals...`);
        await sleepMs(Number(delay) * 1000);
    }

    const proposalCount = await apOwner.proposalCount();
    for (let id = 0n; id < proposalCount; id++) {
        await sendTx(`executeProposal ${id}`, () => apOwner.executeProposal(id));
    }
    console.log(`Executed ${proposalCount} proposals — agent is onboarded and the merchant is allowlisted.`);

    // ------------------------------------------------------------------
    // Write frontend/deployment.json and frontend/abi.json
    // ------------------------------------------------------------------
    const frontendDir = join(process.cwd(), "frontend");
    if (!existsSync(frontendDir)) mkdirSync(frontendDir, { recursive: true });

    const deployment: Record<string, unknown> = {
        chainId,
        network: network.name,
        rpc: isLocal ? "http://127.0.0.1:8545" : (network.config.url ?? ""),
        agentPay: agentPayAddress,
        usdc: usdcAddress,
        owner: owner.address,
        guardian: guardian.address,
        agent: agent.address,
        merchant,
        attacker: attacker.address,
        changeDelay: Number(delay),
        policies: {
            ETH: {
                perTxCap: ETH_PER_TX_CAP.toString(),
                dailyBudget: ETH_DAILY_BUDGET.toString(),
            },
            USDC: {
                perTxCap: USDC_PER_TX_CAP.toString(),
                dailyBudget: USDC_DAILY_BUDGET.toString(),
            },
        },
    };

    // Only local/sepolia: the throwaway DEMO agent key, clearly labelled.
    if (isLocal || network.name === "sepolia") {
        (deployment as Record<string, unknown>).demoAgentKey_TESTNET_ONLY = agent.privateKey;
    }

    writeFileSync(join(frontendDir, "deployment.json"), JSON.stringify(deployment, null, 2));

    const agentPayArtifact = await ethers.getContractFactory("AgentPay");
    const abi = agentPayArtifact.interface.formatJson();
    writeFileSync(join(frontendDir, "abi.json"), abi);

    console.log("Wrote frontend/deployment.json and frontend/abi.json");

    // ------------------------------------------------------------------
    // Summary (no private keys printed)
    // ------------------------------------------------------------------
    const safe = { ...deployment };
    delete (safe as Record<string, unknown>).demoAgentKey_TESTNET_ONLY;
    console.log("\n=== Deployment summary ===");
    console.log(JSON.stringify(safe, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
