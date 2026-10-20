import { expect } from "chai";
import { Interface } from "ethers";
import { ethers } from "hardhat";
import { ERROR_MESSAGES, describeRevert, revertDataCandidates } from "../scripts/lib/revert";

/**
 * The demo and the simulated agent print these messages live in front of the
 * judges, so the wording and the decoding paths are pinned by tests.
 */
describe("revert decoder (demo error messages)", () => {
    let iface: Interface;

    before(async () => {
        const factory = await ethers.getContractFactory("AgentPay");
        iface = factory.interface;
    });

    it("maps every AgentPay custom error to a plain-English message", () => {
        for (const name of Object.keys(ERROR_MESSAGES)) {
            const data = iface.encodeErrorResult(name, []);
            const msg = describeRevert(iface, { data, message: "execution reverted" });
            expect(msg, name).to.contain(ERROR_MESSAGES[name]);
            expect(msg, name).to.contain(name);
        }
    });

    it("decodes Hardhat's provider error, where data is nested in an object", () => {
        const selector = iface.encodeErrorResult("NotAllowlisted", []);
        const hardhatStyle = {
            message: "Error: VM Exception while processing transaction: reverted with custom error 'NotAllowlisted()'",
            data: { message: "VM Exception while processing transaction", data: selector },
        };
        expect(describeRevert(iface, hardhatStyle)).to.contain("blocked: recipient is not approved");
    });

    it("decodes the selector embedded in an error message text", () => {
        const selector = iface.encodeErrorResult("ExceedsDailyBudget", []);
        const msg = describeRevert(iface, {
            message: `reverted with an unrecognized custom error (return data: ${selector})`,
        });
        expect(msg).to.contain("blocked: over the daily budget");
    });

    it("formats bigint args instead of throwing", () => {
        // AgentPay's errors take no arguments today; guard the case where one ever does,
        // because plain JSON.stringify throws on bigint.
        expect(() => JSON.stringify([{ requested: 3_000_000_000_000_000n }])).to.throw();

        const withArgs = new Interface(["error ExceedsPerTxCap(uint128 requested, uint128 cap)"]);
        const data = withArgs.encodeErrorResult("ExceedsPerTxCap", [
            3_000_000_000_000_000n,
            2_000_000_000_000_000n,
        ]);
        const msg = describeRevert(withArgs, { data });
        expect(msg).to.contain("blocked: over the per-transaction cap");
        expect(msg).to.contain("3000000000000000");
    });

    it("falls back to the raw message when nothing decodes", () => {
        expect(describeRevert(iface, { message: "execution reverted: nope" })).to.equal(
            "execution reverted: nope"
        );
        expect(describeRevert(iface, { data: "0xdeadbeef", message: "raw message" })).to.equal(
            "raw message"
        );
    });

    it("returns structured revert data before hex found in message text", () => {
        const selector = iface.encodeErrorResult("Frozen", []);
        const candidates = revertDataCandidates({
            data: selector,
            message: `boom (return data: 0xdeadbeef)`,
        });
        expect(candidates[0]).to.equal(selector);
    });
});
