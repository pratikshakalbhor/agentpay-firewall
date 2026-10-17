import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { loadAgentPayFixture, AgentPayContract, asAp, ETH } from "./fixture";

describe("requests", () => {
    it("an over-cap request is queued and moves no funds", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const amount = ethers.parseEther("0.02"); // above the 0.01 ETH per-tx cap

        const before = await ethers.provider.getBalance(agentPay.target);

        await expect(a.requestPayment(ETH, merchant.address, amount, "big invoice"))
            .to.emit(agentPay, "PaymentRequested")
            .withArgs(0, agent.address, ETH, merchant.address, amount, "big invoice");

        expect(await ethers.provider.getBalance(agentPay.target)).to.eq(before);
        expect((await agentPay.requests(0)).executed).to.be.false;
        expect((await agentPay.requestCount())).to.eq(1n);
    });

    it("owner approves an over-cap request (bypasses per-tx cap, keeps allowlist + budget)", async () => {
        const { agent, merchant, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const amount = ethers.parseEther("0.02");

        await a.requestPayment(ETH, merchant.address, amount, "big invoice");

        const beforeVault = await ethers.provider.getBalance(agentPay.target);
        const beforeMerchant = await ethers.provider.getBalance(merchant.address);

        await expect(asAp(agentPay, owner).approveRequest(0))
            .to.emit(agentPay, "PaymentExecuted")
            .withArgs(agent.address, ETH, merchant.address, amount, "big invoice");

        expect(await ethers.provider.getBalance(agentPay.target)).to.eq(beforeVault - amount);
        expect(await ethers.provider.getBalance(merchant.address)).to.eq(beforeMerchant + amount);
        expect((await agentPay.policies(agent.address, ETH)).spent).to.eq(amount);
        expect((await agentPay.requests(0)).executed).to.be.true;
    });

    it("a request for a non-allowlisted recipient is rejected", async () => {
        const { agent, attacker, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        await expect(
            a.requestPayment(ETH, attacker.address, ethers.parseEther("0.02"), "nope")
        ).to.be.revertedWithCustomError(agentPay, "NotAllowlisted");
    });

    it("approval still enforces the daily budget", async () => {
        const { agent, merchant, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        // exhaust the budget first
        for (let i = 0; i < 5; i++) {
            await a.agentPay(ETH, merchant.address, ethers.parseEther("0.01"), "daily");
        }
        // requestPayment does not check the budget, only approveRequest does
        await a.requestPayment(ETH, merchant.address, ethers.parseEther("0.02"), "over budget");
        await expect(asAp(agentPay, owner).approveRequest(0)).to.be.revertedWithCustomError(
            agentPay,
            "ExceedsDailyBudget"
        );
    });

    it("owner can approve a USDC over-cap request", async () => {
        const { agent, merchant, usdc, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const amount = 20n * 1_000_000n; // above the 10 USDC per-tx cap

        await a.requestPayment(usdc.target, merchant.address, amount, "usdc invoice");

        const beforeVault = await usdc.balanceOf(agentPay.target);
        await expect(asAp(agentPay, owner).approveRequest(0))
            .to.emit(agentPay, "PaymentExecuted")
            .withArgs(agent.address, usdc.target, merchant.address, amount, "usdc invoice");

        expect(await usdc.balanceOf(agentPay.target)).to.eq(beforeVault - amount);
        expect(await usdc.balanceOf(merchant.address)).to.eq(amount);
        expect((await agentPay.policies(agent.address, usdc.target)).spent).to.eq(amount);
    });

    it("owner can reject a request", async () => {
        const { agent, merchant, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        await a.requestPayment(ETH, merchant.address, ethers.parseEther("0.02"), "reject me");

        await expect(asAp(agentPay, owner).rejectRequest(0)).to.emit(agentPay, "RequestRejected");
        expect((await agentPay.requests(0)).cancelled).to.be.true;
        await expect(asAp(agentPay, owner).approveRequest(0)).to.be.revertedWithCustomError(
            agentPay,
            "RequestNotPending"
        );
    });

    it("guardian can reject a request", async () => {
        const { agent, merchant, guardian, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        await a.requestPayment(ETH, merchant.address, ethers.parseEther("0.02"), "reject me");

        await expect(asAp(agentPay, guardian).rejectRequest(0)).to.emit(agentPay, "RequestRejected");
        expect((await agentPay.requests(0)).cancelled).to.be.true;
    });

    it("a request expires after 24h and cannot be approved", async () => {
        const { agent, merchant, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        await a.requestPayment(ETH, merchant.address, ethers.parseEther("0.02"), "expire me");

        await time.increase(86401);
        await expect(asAp(agentPay, owner).approveRequest(0)).to.be.revertedWithCustomError(
            agentPay,
            "RequestExpired"
        );
    });

    it("double approval fails", async () => {
        const { agent, merchant, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        await a.requestPayment(ETH, merchant.address, ethers.parseEther("0.02"), "twice");

        await asAp(agentPay, owner).approveRequest(0);
        await expect(asAp(agentPay, owner).approveRequest(0)).to.be.revertedWithCustomError(
            agentPay,
            "RequestNotPending"
        );
    });

    it("frozen agent blocks approveRequest; unfreeze unblocks", async () => {
        const { agent, merchant, owner, guardian, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const o = asAp(agentPay, owner);
        const g = asAp(agentPay, guardian);
        const amount = ethers.parseEther("0.02");

        await a.requestPayment(ETH, merchant.address, amount, "big invoice");

        await g.freezeAgent(agent.address);
        await expect(o.approveRequest(0)).to.be.revertedWithCustomError(agentPay, "Frozen");

        await o.unfreezeAgent(agent.address);
        await expect(o.approveRequest(0))
            .to.emit(agentPay, "PaymentExecuted")
            .withArgs(agent.address, ETH, merchant.address, amount, "big invoice");
        expect((await agentPay.requests(0)).executed).to.be.true;
    });

    it("freezeAll blocks approveRequest", async () => {
        const { agent, merchant, owner, guardian, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const o = asAp(agentPay, owner);
        const g = asAp(agentPay, guardian);
        const amount = ethers.parseEther("0.02");

        await a.requestPayment(ETH, merchant.address, amount, "big invoice");

        await g.freezeAll();
        await expect(o.approveRequest(0)).to.be.revertedWithCustomError(agentPay, "Frozen");
    });
});
