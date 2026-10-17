import { ethers, network } from "hardhat";
import picocolors from "picocolors";

const { green, red, yellow, cyan, gray, bold, white } = picocolors;

/// @notice ETH is the zero token address in AgentPay / the wallet.
const ETH = ethers.ZeroAddress;

async function main() {
    if (network.name !== "localhost") {
        throw new Error("demo:before runs only on the local hardhat node (--network localhost)");
    }

    const [owner] = await ethers.getSigners();
    if (!owner) throw new Error("No owner signer configured");

    console.log(bold(cyan("\n============================================================")));
    console.log(bold(cyan("  DEMO BEFORE — Unprotected (naive) agent wallet")));
    console.log(bold(cyan("============================================================\n")));
    console.log(gray("This wallet models 'we just gave the AI agent a hot wallet':"));
    console.log(gray("the agent key can send ANY amount to ANY address, with no caps,"));
    console.log(gray("no budget, no allowlist, no freeze, and no guardian."));
    console.log(gray("DEMO ONLY — INSECURE BY DESIGN.\n"));

    // ------------------------------------------------------------------
    // Deploy the intentionally insecure wallet
    // ------------------------------------------------------------------
    console.log(bold(yellow("[1] Deploying UnprotectedAgentWallet…")));
    const walletFactory = await ethers.getContractFactory("UnprotectedAgentWallet");
    const wallet = await walletFactory.deploy();
    await wallet.waitForDeployment();
    const walletAddress = await wallet.getAddress();
    console.log(green(`    deployed: ${walletAddress}`));

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------
    console.log(bold(yellow("[2] Setting up roles")));
    const agent = ethers.Wallet.createRandom().connect(ethers.provider);
    const attacker = ethers.Wallet.createRandom().connect(ethers.provider);

    // Fund agent with a little ETH for gas (agent pays gas for agentSend).
    await owner.sendTransaction({ to: agent.address, value: ethers.parseEther("0.1") });
    console.log(gray(`    agent:   ${agent.address}`));
    console.log(gray(`    attacker:${attacker.address}`));

    // Owner designates the agent key.
    const walletOwner = wallet.connect(owner);
    const setAgentTx = await walletOwner.setAgent(agent.address);
    await setAgentTx.wait();
    console.log(green(`    agent key set on the wallet`));

    const walletAgent = wallet.connect(agent);

    // ------------------------------------------------------------------
    // Fund the wallet with 1 ETH (owner deposits)
    // ------------------------------------------------------------------
    console.log(bold(yellow("[3] Funding the wallet with 1 ETH")));
    const fund = ethers.parseEther("1");
    const fundTx = await owner.sendTransaction({ to: walletAddress, value: fund });
    await fundTx.wait();

    const balWalletBefore = await ethers.provider.getBalance(walletAddress);
    const balAttackerBefore = await ethers.provider.getBalance(attacker.address);

    console.log(gray(`    wallet balance before: ${ethers.formatEther(balWalletBefore)} ETH`));
    console.log(gray(`    attacker balance before: ${ethers.formatEther(balAttackerBefore)} ETH`));

    // ------------------------------------------------------------------
    // Injected agent drains the wallet to the attacker
    // ------------------------------------------------------------------
    console.log(bold(yellow("[4] Injected agent sends ALL funds to the attacker")));
    console.log(cyan(`    [agent] plan: drain the entire wallet to ${attacker.address}`));
    console.log(gray(`    amount: ${ethers.formatEther(balWalletBefore)} ETH (everything)`));

    const drainTx = await walletAgent.agentSend(attacker.address, balWalletBefore);
    await drainTx.wait();

    const balWalletAfter = await ethers.provider.getBalance(walletAddress);
    const balAttackerAfter = await ethers.provider.getBalance(attacker.address);

    console.log(green(`    drain transaction executed: ${drainTx.hash}`));
    console.log(gray(`    wallet balance after:  ${ethers.formatEther(balWalletAfter)} ETH`));
    console.log(gray(`    attacker balance after: ${ethers.formatEther(balAttackerAfter)} ETH`));

    // ------------------------------------------------------------------
    // Result table
    // ------------------------------------------------------------------
    const drained = balWalletBefore - balWalletAfter;
    console.log(bold(cyan("\n============================================================")));
    console.log(bold(cyan("  RESULT — BEFORE (unprotected wallet)")));
    console.log(bold(cyan("============================================================")));
    console.log(white(`    wallet drained:  ${ethers.formatEther(drained)} ETH`));
    console.log(white(`    attacker gained: ${ethers.formatEther(balAttackerAfter - balAttackerBefore)} ETH`));
    console.log(white(`    wallet remaining: ${ethers.formatEther(balWalletAfter)} ETH`));
    console.log(red(`    CONCLUSION: with no limits, a compromised agent drains the wallet in one transaction.`));
    console.log(bold(cyan("============================================================\n")));

    if (balWalletAfter !== 0n) {
        throw new Error("FAIL: wallet was not fully drained");
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(red("demo:before failed:"), err);
        process.exit(1);
    });
