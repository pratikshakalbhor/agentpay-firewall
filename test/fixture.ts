import { ethers } from "hardhat";
import { Contract } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// @notice ETH token address (the vault accepts ETH as token == address(0))
export const ETH = ethers.ZeroAddress;

export interface AgentPayContract extends Contract {
    proposeSetPerTxCap(agent: string, token: string, newCap: bigint): Promise<any>;
    proposeSetDailyBudget(agent: string, token: string, newBudget: bigint): Promise<any>;
    proposeAddAllowlist(agent: string, recipient: string): Promise<any>;
    proposeAddAgent(agent: string): Promise<any>;
    proposeChangeGuardian(newGuardian: string): Promise<any>;
    executeProposal(id: bigint): Promise<any>;
    cancelProposal(id: bigint): Promise<any>;
    freezeAgent(agent: string): Promise<any>;
    freezeAll(): Promise<any>;
    unfreezeAgent(agent: string): Promise<any>;
    unfreezeAll(): Promise<any>;
    withdraw(token: string, to: string, amount: bigint): Promise<any>;
    depositToken(token: string, amount: bigint): Promise<any>;
    depositETH(overrides?: { value?: bigint }): Promise<any>;
    agentPay(token: string, to: string, amount: bigint, reason: string): Promise<any>;
    requestPayment(token: string, to: string, amount: bigint, reason: string): Promise<any>;
    approveRequest(id: bigint): Promise<any>;
    rejectRequest(id: bigint): Promise<any>;
    policies(
        agent: string,
        token: string
    ): Promise<{
        active: boolean;
        perTxCap: bigint;
        dailyBudget: bigint;
        spent: bigint;
        windowStart: bigint;
    }>;
    allowlist(agent: string, recipient: string): Promise<boolean>;
    frozen(agent: string): Promise<boolean>;
    isAgent(agent: string): Promise<boolean>;
    requests(id: bigint): Promise<{
        agent: string;
        token: string;
        to: string;
        amount: bigint;
        reason: string;
        createdAt: bigint;
        executed: boolean;
        cancelled: boolean;
    }>;
    requestCount(): Promise<bigint>;
    proposalCount(): Promise<bigint>;
    guardian(): Promise<string>;
    changeDelay(): Promise<bigint>;
    globalFrozen(): Promise<boolean>;
}

export interface USDCContract extends Contract {
    mint(to: string, amount: bigint): Promise<any>;
    balanceOf(owner: string): Promise<bigint>;
    transfer(to: string, amount: bigint): Promise<any>;
    approve(spender: string, amount: bigint): Promise<any>;
}

export interface AgentPayFixture {
    owner: import("ethers").Signer;
    guardian: import("ethers").Signer;
    agent: import("ethers").Signer;
    merchant: import("ethers").Signer;
    attacker: import("ethers").Signer;
    usdc: USDCContract;
    agentPay: AgentPayContract;
}

/// @notice Snapshot-based fixture so every test starts from identical state.
export async function loadFixture<T>(fixture: () => Promise<T>): Promise<T> {
    const snapshotId = await ethers.provider.send("evm_snapshot", []);
    try {
        return await fixture();
    } finally {
        await ethers.provider.send("evm_revert", [snapshotId]);
    }
}

/**
 * @notice Shared fixture (Phase 1 Part B):
 *   owner, guardian, agent, merchant, attacker signers
 *   MockUSDC (6 decimals)
 *   AgentPay with changeDelay = 600 seconds
 *   Vault funded with 10 ETH and 1000 USDC
 *   One agent with:
 *     ETH    perTxCap 0.01  / dailyBudget 0.05
 *     USDC   perTxCap 10    / dailyBudget 50
 *   Merchant allowlisted for the agent.
 *
 * All policy changes are loosening, so they are queued behind the 600s
 * changeDelay, then the delay is passed and every proposal is executed.
 */
export async function loadAgentPayFixture(): Promise<AgentPayFixture> {
    const [owner, guardian, agent, merchant, attacker] = await ethers.getSigners();

    const usdc = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as unknown as USDCContract;
    const agentPay = (await (await ethers.getContractFactory("AgentPay")).deploy(guardian.address, 600)) as unknown as AgentPayContract;

    // Fund the vault: 10 ETH and 1000 USDC
    await owner.sendTransaction({ to: agentPay.target, value: ethers.parseEther("10") });
    await usdc.mint(owner.address, 1000n * 1_000_000n);
    await usdc.approve(agentPay.target, 1000n * 1_000_000n);
    await agentPay.depositToken(usdc.target, 1000n * 1_000_000n);

    const agentPayOwner = agentPay.connect(owner) as unknown as AgentPayContract;

    // All of the below are loosening -> queued behind changeDelay (600s)
    await agentPayOwner.proposeAddAgent(agent.address);
    await agentPayOwner.proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("0.01"));
    await agentPayOwner.proposeSetDailyBudget(agent.address, ETH, ethers.parseEther("0.05"));
    await agentPayOwner.proposeSetPerTxCap(agent.address, usdc.target, 10n * 1_000_000n);
    await agentPayOwner.proposeSetDailyBudget(agent.address, usdc.target, 50n * 1_000_000n);
    await agentPayOwner.proposeAddAllowlist(agent.address, merchant.address);

    await time.increase(601); // pass the changeDelay
    const count = await agentPay.proposalCount();
    for (let id = 0n; id < count; id++) {
        await agentPayOwner.executeProposal(id);
    }

    return { owner, guardian, agent, merchant, attacker, usdc, agentPay };
}

export function asAp(contract: AgentPayContract, signer: import("ethers").Signer): AgentPayContract {
    return contract.connect(signer) as unknown as AgentPayContract;
}
