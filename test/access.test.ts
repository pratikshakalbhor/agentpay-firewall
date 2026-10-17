import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { loadAgentPayFixture, AgentPayContract, asAp, ETH } from "./fixture";

describe("access", () => {
    it("agent cannot withdraw", async () => {
        const { agent, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(asAp(agentPay, agent).withdraw(ETH, agent.address, 1)).to.be.reverted;
    });

    it("agent cannot change policy", async () => {
        const { agent, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(asAp(agentPay, agent).proposeSetPerTxCap(agent.address, ETH, 1)).to.be.reverted;
    });

    it("agent cannot approve its own request", async () => {
        const { agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        await a.requestPayment(ETH, merchant.address, ethers.parseEther("0.02"), "self approve");
        await expect(asAp(agentPay, agent).approveRequest(0)).to.be.reverted;
    });

    it("agent cannot unfreeze", async () => {
        const { owner, agent, agentPay } = await loadFixture(loadAgentPayFixture);
        await asAp(agentPay, owner).freezeAgent(agent.address);
        await expect(asAp(agentPay, agent).unfreezeAgent(agent.address)).to.be.reverted;
    });

    it("guardian can freeze agents and cancel proposals", async () => {
        const { owner, guardian, agent, agentPay } = await loadFixture(loadAgentPayFixture);

        await asAp(agentPay, guardian).freezeAgent(agent.address);
        await expect(
            asAp(agentPay, agent).agentPay(ETH, agent.address, 1, "x")
        ).to.be.revertedWithCustomError(agentPay, "Frozen");

        const id = await agentPay.proposalCount();
        await asAp(agentPay, owner).proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("1"));
        await asAp(agentPay, guardian).cancelProposal(id);
        await expect(agentPay.executeProposal(id)).to.be.revertedWithCustomError(
            agentPay,
            "ProposalNotReady"
        );
        expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.01"));
    });

    it("guardian cannot unfreeze, withdraw or change policy", async () => {
        const { guardian, agent, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        await asAp(agentPay, owner).freezeAgent(agent.address);
        await expect(asAp(agentPay, guardian).unfreezeAgent(agent.address)).to.be.reverted;
        await expect(asAp(agentPay, guardian).withdraw(ETH, guardian.address, 1)).to.be.reverted;
        await expect(
            asAp(agentPay, guardian).proposeSetPerTxCap(agent.address, ETH, 1)
        ).to.be.reverted;
    });

    it("a random address can do nothing privileged", async () => {
        const { attacker, agent, agentPay } = await loadFixture(loadAgentPayFixture);
        await expect(
            asAp(agentPay, attacker).freezeAgent(agent.address)
        ).to.be.revertedWithCustomError(agentPay, "NotAuthorized");
        await expect(asAp(agentPay, attacker).withdraw(ETH, attacker.address, 1)).to.be.reverted;
        await expect(asAp(agentPay, attacker).cancelProposal(0)).to.be.revertedWithCustomError(
            agentPay,
            "NotAuthorized"
        );
    });

    it("owner can unfreeze after a freeze", async () => {
        const { owner, agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        await asAp(agentPay, owner).freezeAgent(agent.address);
        await asAp(agentPay, owner).unfreezeAgent(agent.address);
        await asAp(agentPay, agent).agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "after unfreeze");
    });

    it("owner can transfer ownership in two steps; guardian cannot", async () => {
        const { owner, agent, guardian, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);

        expect(await agentPay.pendingOwner()).to.eq(ethers.ZeroAddress);

        await expect(o.transferOwnership(ethers.ZeroAddress)).to.be.reverted;
        await expect(o.transferOwnership(agent.address))
            .to.emit(agentPay, "OwnershipTransferStarted")
            .withArgs(owner.address, agent.address);
        expect(await agentPay.pendingOwner()).to.eq(agent.address);

        // only the pending owner may accept
        await expect(asAp(agentPay, guardian).acceptOwnership()).to.be.reverted;
        await expect(asAp(agentPay, agent).acceptOwnership())
            .to.emit(agentPay, "OwnershipTransferred")
            .withArgs(owner.address, agent.address);
        expect(await agentPay.owner()).to.eq(agent.address);

        // the old owner lost privileges, the new owner has them
        await expect(asAp(agentPay, owner).freezeAll()).to.be.reverted;
        await asAp(agentPay, agent).freezeAll();

        // hand ownership back (the fixture reverts anyway)
        await asAp(agentPay, agent).transferOwnership(owner.address);
        await asAp(agentPay, owner).acceptOwnership();
    });
});
