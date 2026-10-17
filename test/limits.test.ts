import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { loadAgentPayFixture, AgentPayContract, USDCContract, asAp, ETH } from "./fixture";

describe("limits", () => {
    it("reverts NotAgent for non-agents", async () => {
        const { attacker, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(
            asAp(agentPay, attacker).agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "x")
        ).to.be.revertedWithCustomError(agentPay, "NotAgent");
    });

    it("reverts Frozen when globally frozen", async () => {
        const { owner, guardian, agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        await asAp(agentPay, guardian).freezeAll();
        await expect(
            asAp(agentPay, agent).agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "x")
        ).to.be.revertedWithCustomError(agentPay, "Frozen");
        await asAp(agentPay, owner).unfreezeAll();
        await asAp(agentPay, agent).agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "x"); // ok again
    });

    it("reverts Frozen when the agent itself is frozen", async () => {
        const { owner, guardian, agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        await asAp(agentPay, guardian).freezeAgent(agent.address);
        await expect(
            asAp(agentPay, agent).agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "x")
        ).to.be.revertedWithCustomError(agentPay, "Frozen");
        await asAp(agentPay, owner).unfreezeAgent(agent.address);
        await asAp(agentPay, agent).agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "x"); // ok again
    });

    it("reverts NotAllowlisted for non-allowlisted recipients", async () => {
        const { agent, attacker, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(
            asAp(agentPay, agent).agentPay(ETH, attacker.address, ethers.parseEther("0.001"), "x")
        ).to.be.revertedWithCustomError(agentPay, "NotAllowlisted");
    });

    it("reverts ExceedsPerTxCap above the per-transaction cap", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(
            asAp(agentPay, agent).agentPay(ETH, merchant.address, ethers.parseEther("0.02"), "x")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsPerTxCap");
    });

    it("reverts ExceedsDailyBudget above the daily budget", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        for (let i = 0; i < 5; i++) {
            await a.agentPay(ETH, merchant.address, ethers.parseEther("0.01"), "daily"); // spent == 0.05 == budget
        }
        await expect(
            a.agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "over")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsDailyBudget");
    });

    it("reverts ZeroAmount", async () => {
        const { agent, merchant, agentPay, usdc } = await loadFixture(loadAgentPayFixture);
        await expect(
            asAp(agentPay, agent).agentPay(ETH, merchant.address, 0, "x")
        ).to.be.revertedWithCustomError(agentPay, "ZeroAmount");
        await expect(
            asAp(agentPay, agent).agentPay(usdc.target, merchant.address, 0, "x")
        ).to.be.revertedWithCustomError(agentPay, "ZeroAmount");
        await expect(asAp(agentPay, agent).depositToken(usdc.target, 0)).to.be.revertedWithCustomError(
            agentPay,
            "ZeroAmount"
        );
    });

    it("reverts InsufficientVaultBalance on over-large owner withdrawal", async () => {
        const { owner, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(
            asAp(agentPay, owner).withdraw(ETH, owner.address, ethers.parseEther("20"))
        ).to.be.revertedWithCustomError(agentPay, "InsufficientVaultBalance");
    });

    it("the daily spending window resets after 24h", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const cap = ethers.parseEther("0.01");

        for (let i = 0; i < 5; i++) {
            await a.agentPay(ETH, merchant.address, cap, "daily"); // spent == 0.05 == budget
        }
        await expect(
            a.agentPay(ETH, merchant.address, cap, "over")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsDailyBudget");

        await time.increase(86401); // new window starts
        await a.agentPay(ETH, merchant.address, cap, "reset"); // ok again
        const p = await agentPay.policies(agent.address, ETH);
        expect(p.spent).to.eq(cap);
        expect(p.windowStart).to.be.gt(0);
    });

    it("partial spends accumulate within a window", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);

        for (let i = 0; i < 4; i++) {
            await a.agentPay(ETH, merchant.address, ethers.parseEther("0.01"), String.fromCharCode(97 + i)); // spent 0.04
        }
        const p = await agentPay.policies(agent.address, ETH);
        expect(p.spent).to.eq(ethers.parseEther("0.04"));

        await a.agentPay(ETH, merchant.address, ethers.parseEther("0.01"), "e"); // spent 0.05 exactly
        expect((await agentPay.policies(agent.address, ETH)).spent).to.eq(ethers.parseEther("0.05"));

        await expect(
            a.agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "f")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsDailyBudget");
    });

    it("the drip attack stops at the daily budget", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const drip = ethers.parseEther("0.001"); // 1/10 of the per-tx cap, 1/50 of the budget

        let successes = 0;
        for (let i = 0; i < 60; i++) {
            try {
                await a.agentPay(ETH, merchant.address, drip, "drip");
                successes++;
            } catch {
                break;
            }
        }

        expect(successes).to.eq(50);
        expect((await agentPay.policies(agent.address, ETH)).spent).to.eq(ethers.parseEther("0.05"));
        await expect(
            a.agentPay(ETH, merchant.address, drip, "drip")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsDailyBudget");
    });
});
