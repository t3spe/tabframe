// The IAM shapes the stacks share, so a tightening lands in one place. A role's statements render
// in the order they are added, so callers keep the order the deployed policies have.
import * as cdk from "aws-cdk-lib";

type Grantee = cdk.aws_iam.IGrantable;

function allow(grantee: Grantee, actions: string[], resources: string[]): void {
  grantee.grantPrincipal.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({ actions, resources }),
  );
}

export interface LauncherGrant {
  /** The one image RunMicrovm is allowed on. */
  launchImageArn: string;
  /** Get and Terminate keep the image-wide resource until the API's resource model for a MicroVM is pinned down. */
  anyImageArn: string;
  /** Whether the launcher also mints proxy tokens (rotate does; the control plane does not). */
  mintsTokens: boolean;
}

/**
 * Launch MicroVMs from the one image and manage them. ListMicrovms and PassNetworkConnector are
 * granted on "*": the managed connectors live in the "aws" account, and a wildcard on their ARN
 * pattern was still denied at deploy.
 */
export function grantMicrovmLauncher(grantee: Grantee, grant: LauncherGrant): void {
  allow(grantee, ["lambda:RunMicrovm"], [grant.launchImageArn]);
  allow(
    grantee,
    [
      "lambda:GetMicrovm",
      "lambda:TerminateMicrovm",
      ...(grant.mintsTokens ? ["lambda:CreateMicrovmAuthToken"] : []),
      "lambda:GetMicrovmImage",
    ],
    [grant.anyImageArn],
  );
  allow(grantee, ["lambda:ListMicrovms"], ["*"]);
  allow(grantee, ["lambda:PassNetworkConnector"], ["*"]);
}

/** Mint proxy tokens for, and look at, MicroVMs; never launch or terminate one. */
export function grantMicrovmTokens(grantee: Grantee, anyImageArn: string): void {
  allow(grantee, ["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm"], [anyImageArn]);
}

export function grantPointer(
  grantee: Grantee,
  pointerArn: string,
  access: "read" | "readwrite",
): void {
  const actions =
    access === "read" ? ["ssm:GetParameter"] : ["ssm:GetParameter", "ssm:PutParameter"];
  allow(grantee, actions, [pointerArn]);
}

/** PassRole limited to the one role; a PassedToService condition is not honored by RunMicrovm. */
export function grantPassRole(grantee: Grantee, role: cdk.aws_iam.IRole): void {
  allow(grantee, ["iam:PassRole"], [role.roleArn]);
}

/** Write to the one log group; one statement shared by every role that logs there. */
export function logsStatement(logGroup: cdk.aws_logs.ILogGroup): cdk.aws_iam.PolicyStatement {
  return new cdk.aws_iam.PolicyStatement({
    actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
  });
}
