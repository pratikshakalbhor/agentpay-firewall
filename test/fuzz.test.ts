import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { loadAgentPayFixture, AgentPayContract, asAp, ETH } from "./fixture";

/**
 * @notice Simple seeded (LCG) random generator so the fuzz campaign is deterministic.
 */
class SeededRandom {
    private seed: number;
    constructor(seed: number) {
        this.seed = seed >>> 0;
    }
    next(): number {
        this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
        return this.seed / 4294967296;
    }
    below(max: number): number {
        return Math.floor(this.next() * max);
    }
}

describe("fuzz", () => {
    it("spent never exceeds dailyBudget and only allowlisted recipients get paid", async () => {
        const { agent, merchant, usdc, agentPay } = await loadFixture(loadAgentPayFixture);
        const a = asAp(agentPay, agent);
        const rng = new SeededRandom(20261017);

        const ethCap = ethers.parseEther("0.01");
        const usdcCap = 10n * 1_000_000n;
        const nonAllowlisted = (await ethers.getSigners())[9]; // funded account, not allowlisted

        for (let i = 0; i < 70; i++) {
            const useUSDC = rng.below(2) === 0;
            const token = useUSDC ? usdc.target : ETH;
            const cap = useUSDC ? usdcCap : ethCap;
            const toNonAllowlisted = rng.below(10) < 3;
            const to = toNonAllowlisted ? nonAllowlisted.address : merchant.address;
            const overCap = rng.below(10) < 2;
            const amount = overCap
                ? cap + (cap * BigInt(rng.below(2001))) / 1000n // above the per-tx cap
                : (cap * BigInt(rng.below(1001))) / 1000n; // within the per-tx cap (maybe zero)

            try {
                await a.agentPay(token, to, amount, "fuzz");
                // invariant 1: only allowlisted recipients are ever paid
                expect(to).to.eq(merchant.address);
                // invariant 2: spent in a window never exceeds the daily budget
                const p = await agentPay.policies(agent.address, token);
                expect(p.spent <= p.dailyBudget).to.be.true;
            } catch (err) {
                // reverts are expected for out-of-policy calls
                const message = String(err);
                expect(message).to.match(
                    /NotAllowlisted|ExceedsPerTxCap|ExceedsDailyBudget|ZeroAmount/
                );
            }

            if (i > 0 && i % 10 === 0) {
                await time.increase(86401); // rotate windows mid-campaign
            }
        }
    });
});
