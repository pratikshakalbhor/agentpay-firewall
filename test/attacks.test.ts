import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { loadAgentPayFixture, AgentPayContract, asAp, ETH } from "./fixture";

describe("attacks", () => {
    it("compromised owner: guardian cancels malicious loosening within the delay", async () => {
        const { owner, guardian, agent, merchant, attacker, agentPay } = await loadFixture(loadAgentPayFixture);
        const compromised = asAp(agentPay, owner); // attacker holds the owner key
        const a = asAp(agentPay, agent);

        const base = await agentPay.proposalCount();
        await compromised.proposeAddAllowlist(agent.address, attacker.address); // id base
        await compromised.proposeSetPerTxCap(agent.address, ETH, ethers.parseEther("1")); // id base + 1

        // within the delay nothing changed: attacker still not allowlisted, cap unchanged
        expect(await agentPay.allowlist(agent.address, attacker.address)).to.be.false;
        expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.01"));

        await expect(
            a.agentPay(ETH, attacker.address, ethers.parseEther("0.005"), "steal")
        ).to.be.revertedWithCustomError(agentPay, "NotAllowlisted");
        await expect(
            a.agentPay(ETH, merchant.address, ethers.parseEther("0.02"), "over old cap")
        ).to.be.revertedWithCustomError(agentPay, "ExceedsPerTxCap");

        const beforeVault = await ethers.provider.getBalance(agentPay.target);
        await a.agentPay(ETH, merchant.address, ethers.parseEther("0.005"), "normal"); // only normal-limit spending

        // guardian cancels both proposals within the delay
        await asAp(agentPay, guardian).cancelProposal(base);
        await asAp(agentPay, guardian).cancelProposal(base + 1n);

        // after the delay has passed, execution is rejected
        await time.increase(601);
        await expect(agentPay.executeProposal(base)).to.be.revertedWithCustomError(agentPay, "ProposalNotReady");
        await expect(agentPay.executeProposal(base + 1n)).to.be.revertedWithCustomError(
            agentPay,
            "ProposalNotReady"
        );

        // nothing was drained beyond the normal daily limit
        expect(await agentPay.allowlist(agent.address, attacker.address)).to.be.false;
        expect((await agentPay.policies(agent.address, ETH)).perTxCap).to.eq(ethers.parseEther("0.01"));
        expect((await agentPay.policies(agent.address, ETH)).spent).to.eq(ethers.parseEther("0.005"));
        expect(await ethers.provider.getBalance(agentPay.target)).to.eq(beforeVault - ethers.parseEther("0.005"));
        // Note: a compromised owner can still withdraw funds directly (by design);
        // this test covers the agent channel only, which is what the delay mitigates.
    });

    it("compromised agent: drain is bounded by the daily budget and only reaches allowlisted recipients", async () => {
        const { owner, agentPay, merchant, attacker } = await loadFixture(loadAgentPayFixture);
        const o = asAp(agentPay, owner);

        // the attacker has the agent key: give it a normal agent policy
        const base = await agentPay.proposalCount();
        await o.proposeAddAgent(attacker.address);
        await o.proposeSetPerTxCap(attacker.address, ETH, ethers.parseEther("0.01"));
        await o.proposeSetDailyBudget(attacker.address, ETH, ethers.parseEther("0.05"));
        await o.proposeAddAllowlist(attacker.address, merchant.address);
        await time.increase(601);
        const count = await agentPay.proposalCount();
        for (let id = base; id < count; id++) {
            await agentPay.executeProposal(id);
        }

        const a = asAp(agentPay, attacker);
        const max = ethers.parseEther("0.01");
        let drained = 0n;
        for (let i = 0; i < 10; i++) {
            try {
                await a.agentPay(ETH, merchant.address, max, "drain");
                drained += max;
            } catch {
                break;
            }
        }

        expect(drained).to.eq(ethers.parseEther("0.05")); // == dailyBudget, never above
        expect((await agentPay.policies(attacker.address, ETH)).spent).to.eq(ethers.parseEther("0.05"));

        // non-allowlisted recipients are rejected even for the compromised agent
        await expect(
            a.agentPay(ETH, attacker.address, ethers.parseEther("0.001"), "steal")
        ).to.be.revertedWithCustomError(agentPay, "NotAllowlisted");
    });

    it("reentrancy: a malicious recipient re-entering agentPay / approveRequest fails", async () => {
        const { agent, owner, agentPay } = await loadFixture(loadAgentPayFixture);
        const receiver = await (
            await ethers.getContractFactory("ReentrantReceiver")
        ).deploy(agentPay.target);

        // make the receiver an allowlisted recipient so the transfer actually happens
        const allowId = await agentPay.proposalCount();
        await asAp(agentPay, owner).proposeAddAllowlist(agent.address, receiver.target);
        await time.increase(601);
        await agentPay.executeProposal(allowId);

        // agentPay: the re-entrant call from receive() is blocked by ReentrancyGuard
        const beforeVault = await ethers.provider.getBalance(agentPay.target);
        await expect(
            asAp(agentPay, agent).agentPay(ETH, receiver.target, ethers.parseEther("0.001"), "reentrancy")
        ).to.be.revertedWithCustomError(agentPay, "TransferFailed");
        expect(await ethers.provider.getBalance(agentPay.target)).to.eq(beforeVault);

        // approveRequest: the re-entrant call from receive() is blocked too
        await asAp(agentPay, agent).requestPayment(ETH, receiver.target, ethers.parseEther("0.02"), "reentrancy");
        const id = (await agentPay.requestCount()) - 1n;
        await expect(asAp(agentPay, owner).approveRequest(id)).to.be.revertedWithCustomError(
            agentPay,
            "TransferFailed"
        );
        expect((await agentPay.requests(id)).executed).to.be.false;
    });
});
