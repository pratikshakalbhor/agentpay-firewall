const { execSync } = require("child_process");

// Runs the full before/after demo sequence on the local hardhat node.
// Each step inherits stdio so the user sees colored output in the terminal.
execSync("npx hardhat run scripts/demo-before.ts --network localhost", { stdio: "inherit" });
execSync("npx hardhat run scripts/demo-after.ts --network localhost", { stdio: "inherit" });
