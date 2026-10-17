import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import {
    loadAgentPayFixture,
    AgentPayContract,
    USDCContract,
    asAp,
    ETH,
} from "./fixture";

describe("payments", () => {
    it("agent pays an allowlisted merchant in ETH within limits", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const amount = ethers.parseEther("0.005");

        const beforeVault = await ethers.provider.getBalance(agentPay.target);
        const beforeMerchant = await ethers.provider.getBalance(merchant.address);

        await expect(a.agentPay(ETH, merchant.address, amount, "coffee"))
            .to.emit(agentPay, "PaymentExecuted")
            .withArgs(agent.address, ETH, merchant.address, amount, "coffee");

        expect(await ethers.provider.getBalance(agentPay.target)).to.eq(beforeVault - amount);
        expect(await ethers.provider.getBalance(merchant.address)).to.eq(beforeMerchant + amount);

        const p = await agentPay.policies(agent.address, ETH);
        expect(p.active).to.be.true;
        expect(p.spent).to.eq(amount);
    });

    it("agent pays an allowlisted merchant in USDC within limits", async () => {
        const { agent, merchant, usdc, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const amount = 10n * 1_000_000n; // 10 USDC, exactly at the per-tx cap

        const beforeVault = await usdc.balanceOf(agentPay.target);
        const beforeMerchant = await usdc.balanceOf(merchant.address);

        await expect(a.agentPay(usdc.target, merchant.address, amount, "invoice"))
            .to.emit(agentPay, "PaymentExecuted")
            .withArgs(agent.address, usdc.target, merchant.address, amount, "invoice");

        expect(await usdc.balanceOf(agentPay.target)).to.eq(beforeVault - amount);
        expect(await usdc.balanceOf(merchant.address)).to.eq(beforeMerchant + amount);

        const p = await agentPay.policies(agent.address, usdc.target);
        expect(p.spent).to.eq(amount);
    });

    it("spent accumulates across payments and stays inside the daily budget", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);

        for (let i = 0; i < 4; i++) {
            await a.agentPay(ETH, merchant.address, ethers.parseEther("0.01"), `one${i}`); // spent 0.04
        }
        const p = await agentPay.policies(agent.address, ETH);
        expect(p.spent).to.eq(ethers.parseEther("0.04"));

        // 0.01 more exactly reaches the budget
        await a.agentPay(ETH, merchant.address, ethers.parseEther("0.01"), "three");
        const p2 = await agentPay.policies(agent.address, ETH);
        expect(p2.spent).to.eq(ethers.parseEther("0.05"));

        // anything more exceeds the daily budget
        await expect(a.agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "four")).to.be.revertedWithCustomError(
            agentPay,
            "ExceedsDailyBudget"
        );
    });

    it("owner can withdraw ETH from the vault", async () => {
        const { owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const amount = ethers.parseEther("1");

        const beforeVault = await ethers.provider.getBalance(agentPay.target);
        const beforeOwner = await ethers.provider.getBalance(owner.address);

        const tx = await o.withdraw(ETH, owner.address, amount);
        await tx.wait();

        await expect(tx).to.emit(agentPay, "Withdrawal").withArgs(owner.address, ETH, amount);

        expect(await ethers.provider.getBalance(agentPay.target)).to.eq(beforeVault - amount);
        // the owner receives the withdrawal minus transaction gas
        const afterOwner = await ethers.provider.getBalance(owner.address);
        expect(afterOwner).to.be.gte(beforeOwner);
        expect(afterOwner).to.be.lte(beforeOwner + amount);
    });

    it("owner can withdraw USDC from the vault", async () => {
        const { owner, merchant, usdc, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const amount = 100n * 1_000_000n; // 100 USDC

        const beforeVault = await usdc.balanceOf(agentPay.target);
        const beforeMerchant = await usdc.balanceOf(merchant.address);

        await expect(o.withdraw(usdc.target, merchant.address, amount))
            .to.emit(agentPay, "Withdrawal")
            .withArgs(merchant.address, usdc.target, amount);

        expect(await usdc.balanceOf(agentPay.target)).to.eq(beforeVault - amount);
        expect(await usdc.balanceOf(merchant.address)).to.eq(beforeMerchant + amount);
    });

    it("anyone can deposit ETH via receive() and depositETH()", async () => {
        const { attacker, agentPay } = await loadFixture(loadAgentPayFixture);
        const amount = ethers.parseEther("0.1");

        await expect(attacker.sendTransaction({ to: agentPay.target, value: amount })).to.emit(
            agentPay,
            "DepositETH"
        );

        await expect(asAp(agentPay, attacker).depositETH({ value: amount }))
            .to.emit(agentPay, "DepositETH")
            .withArgs(attacker.address, amount);
    });
});
