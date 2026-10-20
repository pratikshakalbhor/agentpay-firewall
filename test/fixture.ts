import { ethers } from "hardhat";
import { BaseContract, BigNumberish, Addressable } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// @notice ETH token address (the vault accepts ETH as token == address(0))
export const ETH = ethers.ZeroAddress;

/**
 * @notice An address as accepted by ethers: a plain hex string or any
 * Addressable (e.g. a contract object, whose `.target` is `string | Addressable`).
 * ethers resolves either form, so the test helpers accept both.
 */
export type Address = string | Addressable;

/**
 * @notice Typed view of the AgentPay contract used by the tests.
 * Extends BaseContract (not Contract) so the method signatures below do not
 * collide with Contract's index signature. Amounts are BigNumberish, which is
 * what ethers accepts at runtime (bigint or number literal).
 */
export interface AgentPayContract extends BaseContract {
    proposeSetPerTxCap(agent: Address, token: Address, newCap: BigNumberish): Promise<any>;
    proposeSetDailyBudget(agent: Address, token: Address, newBudget: BigNumberish): Promise<any>;
    proposeAddAllowlist(agent: Address, recipient: Address): Promise<any>;
    proposeAddAgent(agent: Address): Promise<any>;
    proposeChangeGuardian(newGuardian: Address): Promise<any>;
    executeProposal(id: BigNumberish): Promise<any>;
    cancelProposal(id: BigNumberish): Promise<any>;
    freezeAgent(agent: Address): Promise<any>;
    freezeAll(): Promise<any>;
    unfreezeAgent(agent: Address): Promise<any>;
    unfreezeAll(): Promise<any>;
    withdraw(token: Address, to: Address, amount: BigNumberish): Promise<any>;
    depositToken(token: Address, amount: BigNumberish): Promise<any>;
    depositETH(overrides?: { value?: BigNumberish }): Promise<any>;
    agentPay(token: Address, to: Address, amount: BigNumberish, reason: string): Promise<any>;
    requestPayment(token: Address, to: Address, amount: BigNumberish, reason: string): Promise<any>;
    approveRequest(id: BigNumberish): Promise<any>;
    rejectRequest(id: BigNumberish): Promise<any>;
    policies(
        agent: Address,
        token: Address
    ): Promise<{
        active: boolean;
        perTxCap: bigint;
        dailyBudget: bigint;
        spent: bigint;
        windowStart: bigint;
    }>;
    allowlist(agent: Address, recipient: Address): Promise<boolean>;
    frozen(agent: Address): Promise<boolean>;
    isAgent(agent: Address): Promise<boolean>;
    requests(id: BigNumberish): Promise<{
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
    owner(): Promise<string>;
    pendingOwner(): Promise<string>;
    transferOwnership(newOwner: Address): Promise<any>;
    acceptOwnership(): Promise<any>;
    proposals(id: BigNumberish): Promise<{
        kind: bigint;
        agent: string;
        token: string;
        recipient: string;
        value: bigint;
        newGuardian: string;
        eta: bigint;
        executed: boolean;
        cancelled: boolean;
    }>;
}

export interface USDCContract extends BaseContract {
    mint(to: Address, amount: BigNumberish): Promise<any>;
    balanceOf(owner: Address): Promise<bigint>;
    transfer(to: Address, amount: BigNumberish): Promise<any>;
    approve(spender: Address, amount: BigNumberish): Promise<any>;
}

export interface AgentPayFixture {
    owner: HardhatEthersSigner;
    guardian: HardhatEthersSigner;
    agent: HardhatEthersSigner;
    merchant: HardhatEthersSigner;
    attacker: HardhatEthersSigner;
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
