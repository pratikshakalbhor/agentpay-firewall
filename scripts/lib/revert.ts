import { Interface } from "ethers";

/**
 * @notice Human-readable explanations for the custom errors AgentPay reverts with.
 * Used by the demo scripts and the simulated agent so judges see plain English,
 * not raw selectors.
 */
export const ERROR_MESSAGES: Record<string, string> = {
    ExceedsPerTxCap: "blocked: over the per-transaction cap",
    ExceedsDailyBudget: "blocked: over the daily budget",
    NotAllowlisted: "blocked: recipient is not approved",
    NotAgent: "blocked: caller is not an active agent",
    Frozen: "blocked: the agent or vault is frozen",
    ZeroAmount: "blocked: zero amount",
    InsufficientVaultBalance: "blocked: vault has insufficient balance",
    RequestExpired: "blocked: payment request has expired",
    RequestNotPending: "blocked: no pending payment request",
    ProposalNotReady: "blocked: proposal not yet executable",
    NotAuthorized: "blocked: not authorized",
    TransferFailed: "blocked: token transfer failed",
};

/** @notice Decoded error description (shape of ethers' ErrorDescription). */
type ErrorDescriptionLike = { name?: string; args?: readonly unknown[] };

/**
 * @notice JSON.stringify that survives bigint.
 * Error arguments are bigints (uint128 caps, uint256 amounts) and plain
 * JSON.stringify throws "Do not know how to serialize a BigInt" on them.
 */
function stringifyArgs(args: readonly unknown[]): string {
    const json = JSON.stringify(args, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
    );
    // JSON.stringify can still return undefined (e.g. for a lone undefined arg).
    return json === undefined ? String(args) : json;
}

/**
 * @notice Collect raw revert data candidates (0x…) from an ethers error.
 *
 * ethers v6 nests the revert payload in different places depending on where the
 * failure happened: `error.data` for a simulated call that reverted, or
 * `error.info.error.data` when the node answered with an RPC error. Hardhat also
 * embeds it in the message text, e.g.
 * `reverted with an unrecognized custom error (return data: 0x06fb10a9)`.
 *
 * Structured `data` fields are returned before hex found in message text, since
 * they are the more reliable source.
 */
export function revertDataCandidates(error: unknown): string[] {
    const structured: string[] = [];
    const fromMessages: string[] = [];
    const seen = new Set<unknown>();

    const isHex = (value: unknown): value is string =>
        typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value);

    const visit = (node: unknown, depth: number): void => {
        if (node === null || typeof node !== "object" || depth > 6 || seen.has(node)) return;
        seen.add(node);
        const record = node as Record<string, unknown>;

        if (isHex(record.data)) {
            structured.push(record.data);
        } else if (record.data !== null && typeof record.data === "object") {
            // Hardhat's provider error nests the selector inside `data`:
            // { message: "VM Exception ... 'NotAllowlisted()'", data: "0x06fb10a9" }
            visit(record.data, depth + 1);
        }

        const message = record.message;
        if (typeof message === "string") {
            for (const match of message.matchAll(/0x[0-9a-fA-F]{8,}/g)) {
                fromMessages.push(match[0]);
            }
        }

        for (const key of ["error", "info", "cause", "errors"]) {
            visit(record[key], depth + 1);
        }
    };

    visit(error, 0);
    return [...new Set([...structured, ...fromMessages])];
}

/**
 * @notice Turn a caught revert into one plain-English line, e.g.
 * `blocked: over the per-transaction cap (ExceedsPerTxCap args=[...])`.
 * Falls back to the raw error message when nothing decodes.
 */
export function describeRevert(iface: Interface, error: unknown): string {
    const err = error as { message?: string; reason?: string };

    for (const data of revertDataCandidates(error)) {
        let desc: ErrorDescriptionLike | null = null;
        try {
            desc = iface.parseError(data) as ErrorDescriptionLike | null;
        } catch {
            desc = null; // not an error this ABI knows about — try the next candidate
        }
        if (desc && desc.name) {
            const friendly = ERROR_MESSAGES[desc.name] ?? desc.name;
            const detail = desc.args ? ` args=${stringifyArgs(desc.args)}` : "";
            return `${friendly} (${desc.name}${detail})`;
        }
    }

    return err.message ?? err.reason ?? String(error);
}
