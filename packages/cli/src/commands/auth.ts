import { Command } from "commander";
import {
  ABX_SERVICES_API_KEY_VAR,
  ABX_SERVICES_URL,
  creatorAccountPath,
  deviceLogin,
  oauthLogout,
  provisionCreatorWallet,
  readCreatorProjectToken,
  sponsoredOperationStatus,
} from "@artblocks/abx-creator-wallet";

import { accountEnvPath, creatorToken } from "../creator-wallet.js";

export function authCommand(): Command {
  const auth = new Command("auth").description("Manage the shared ABX creator account");
  auth.addCommand(new Command("login")
    .description("Sign in or create an ABX creator account in your browser")
    .option("--no-open", "print the approval URL for a browser you open yourself")
    .action(async (opts: { open: boolean }) => {
      if (!creatorToken()) {
        await deviceLogin({
          baseUrl: ABX_SERVICES_URL,
          envVar: ABX_SERVICES_API_KEY_VAR,
          envPath: creatorAccountPath(true),
          noOpen: !opts.open,
          loginCommand: "abxfs auth login",
        });
      }
      const token = creatorToken();
      if (!token) throw new Error("No creator account credential was saved.");
      const wallet = await provisionCreatorWallet({ env: { [ABX_SERVICES_API_KEY_VAR]: token } });
      console.log(`Creator wallet ${wallet.address}`);
    }));
  auth.addCommand(new Command("logout")
    .description("Revoke the current ABX account API key")
    .action(async () => {
      const token = creatorToken();
      const local = readCreatorProjectToken(accountEnvPath()) === token && token !== undefined;
      const savedPath = local ? accountEnvPath() : creatorAccountPath();
      const result = await oauthLogout({
        baseUrl: ABX_SERVICES_URL,
        envPath: savedPath,
        envVar: ABX_SERVICES_API_KEY_VAR,
        token,
      });
      console.log(result.status === "revoked" ? "Revoked the ABX account API key." : "Already signed out.");
    }));
  auth.addCommand(new Command("operation")
    .description("Read the status of a creator-wallet operation")
    .argument("<id>")
    .action(async (id: string) => {
      const token = creatorToken();
      if (!token) throw new Error("Sign in with abxfs auth login first.");
      // The shared provider looks up the operation by account and ID regardless of the transaction's chain.
      const op = await sponsoredOperationStatus("base-sepolia", id, { env: { [ABX_SERVICES_API_KEY_VAR]: token } });
      console.log(`Creator-wallet operation ${op.operationId} is ${op.state}.`);
      if (op.transactionHash) console.log(`Transaction: ${op.transactionHash}`);
      if (op.errorCode) console.log(`Error: ${op.errorCode}`);
    }));
  return auth;
}
