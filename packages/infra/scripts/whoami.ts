// Guard: every AWS-touching task depends on this. It refuses to run against anything but the
// dedicated Tabframe account, and never prints an unmasked account id.
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { maskAccount } from "./mask.ts";

function fail(message: string): never {
  console.error(`whoami FAILED: ${message}`);
  process.exit(1);
}

const profile = process.env.AWS_PROFILE;
if (profile !== "tabframe") fail(`AWS_PROFILE is ${profile ?? "unset"}, expected "tabframe"`);

const expected = process.env.TABFRAME_ACCOUNT_ID;
if (!expected || !/^\d{12}$/.test(expected)) fail("TABFRAME_ACCOUNT_ID missing from .env.local");

const region = process.env.AWS_REGION ?? "";
if (region !== "us-west-2") fail(`AWS_REGION is ${region || "unset"}, expected us-west-2`);

const sts = new STSClient({});
const identity = await sts.send(new GetCallerIdentityCommand({}));
if (identity.Account !== expected) {
  fail(`caller account ${maskAccount(identity.Account)} is not the Tabframe account`);
}
console.log(
  `whoami ok: account ${maskAccount(identity.Account)}, ${maskAccount(identity.Arn)}, region ${region}`,
);
