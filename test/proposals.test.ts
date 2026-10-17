import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { loadAgentPayFixture, AgentPayContract, asAp, ETH } from "./fixture";

describe("proposals", () => {
    it("tightening is instant", async () => {
        const { owner, agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const a = asAp(agentPay, agent);

        await o.proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("0.005")); // lower cap: instant
        expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.005"));

        await expect(
            a.agentPay(ETH, merchant.address, ethers.parseEther("0.006"), "x")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsPerTxCap");
        await a.agentPay(ETH, merchant.address, ethers.parseEther("0.005"), "ok"); // fits the new cap

        // tightening the daily budget is instant too
        await o.proposeSetDailyBudget(agent.address, ETH, ethers.parseEther("0.005"));
        await expect(
            a.agentPay(ETH, merchant.address, ethers.parseEther("0.001"), "over")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsDailyBudget");
    });

    it("loosening is queued and cannot execute before eta", async () => {
        const { owner, agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const a = asAp(agentPay, agent);

        const id = await agentPay.proposalCount();
        await o.proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("0.02")); // raise: queued

        expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.01")); // unchanged now
        await expect(
            a.agentPay(ETH, merchant.address, ethers.parseEther("0.015"), "x")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsPerTxCap");
        await expect(agentPay.executeProposal(id)).to.be.revertedWithCustomError(agentPay, "ProposalNotReady");

        const proposal = await agentPay.proposals(id);
        expect(proposal.eta).to.be.gt(await time.latest());
    });

    it("a proposal can be cancelled by the owner or the guardian", async () => {
        const cases: Array<[string, import("ethers").Signer]> = [
            ["owner", null as unknown as import("ethers").Signer],
            ["guardian", null as unknown as import("ethers").Signer],
        ];
        for (const [label] of cases) {
            const { owner, guardian, agent, agentPay } = await loadFixture(loadAgentPayFixture);
            const signer = label === "owner" ? owner : guardian;
            const other = label === "owner" ? guardian : owner;

            const id = await agentPay.proposalCount();
            await asAp(agentPay, owner).proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("0.02"));
            await asAp(agentPay, signer).cancelProposal(id);
            await expect(agentPay.executeProposal(id)).to.be.revertedWithCustomError(
                agentPay,
                "ProposalNotReady"
            );
            expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.01"));

            // the other party cannot cancel an already cancelled proposal
            await expect(asAp(agentPay, other).cancelProposal(id)).to.be.revertedWithCustomError(
                agentPay,
                "ProposalNotReady"
            );
        }
    });

    it("a proposal executes after eta", async () => {
        const { owner, agent, merchant, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const a = asAp(agentPay, agent);

        const id = await agentPay.proposalCount();
        await o.proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("0.02"));
        await time.increase(601);
        await expect(agentPay.executeProposal(id)).to.emit(agentPay, "ProposalExecuted");

        expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.02"));
        await a.agentPay(ETH, merchant.address, ethers.parseEther("0.015"), "after loosen"); // ok under new cap
    });

    it("adding an allowlist entry is queued", async () => {
        const { owner, agent, attacker, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const a = asAp(agentPay, agent);

        const id = await agentPay.proposalCount();
        await o.proposeAddAllowlist(agent.address, attacker.address);
        expect(await agentPay.allowlist(agent.address, attacker.address)).to.be.false;
        await expect(
            a.agentPay(ETH, attacker.address, ethers.parseEther("0.001"), "x")
        ).to.be.revertedWithCustomError(agentPay, "NotAllowlisted");
        await expect(agentPay.executeProposal(id)).to.be.revertedWithCustomError(agentPay, "ProposalNotReady");

        await time.increase(601);
        await agentPay.executeProposal(id);
        expect(await agentPay.allowlist(agent.address, attacker.address)).to.be.true;
        await a.agentPay(ETH, attacker.address, ethers.parseEther("0.001"), "now allowed");
    });

    it("adding an agent is queued", async () => {
        const { owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);
        const [,,,,, newAgent] = await ethers.getSigners();

        const id = await agentPay.proposalCount();
        await o.proposeAddAgent(newAgent.address);
        expect(await agentPay.isAgent(newAgent.address)).to.be.false;
        await expect(
            asAp(agentPay, newAgent).agentPay(ETH, owner.address, 1, "x")
        ).to.be.revertedWithCustomError(agentPay, "NotAgent");
        await time.increase(601);
        await agentPay.executeProposal(id);
        expect(await agentPay.isAgent(newAgent.address)).to.be.true;
    });

    it("changing the guardian is queued", async () => {
        const { owner, guardian, attacker, agentPay } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);

        const id = await agentPay.proposalCount();
        await o.proposeChangeGuardian(attacker.address);
        expect(await agentPay.guardian()).to.eq(guardian.address);
        await expect(agentPay.executeProposal(id)).to.be.revertedWithCustomError(agentPay, "ProposalNotReady");

        await time.increase(601);
        await agentPay.executeProposal(id);
        expect(await agentPay.guardian()).to.eq(attacker.address);

        // the old guardian lost privileges, the new guardian gained them
        await expect(asAp(agentPay, guardian).freezeAgent(owner.address)).to.be.reverted;
        await asAp(agentPay, attacker).freezeAgent(owner.address);
        await asAp(agentPay, owner).unfreezeAgent(owner.address); // restore
    });
});
