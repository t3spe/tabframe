// Image stack (design §9.3, §11.3, §11.4): the MicroVM image, its build role, and the two execution
// roles. Nothing fleet-related is baked into the image, which keeps Core → Image → Fleet acyclic.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CoreStack } from "./core-stack.ts";
import {
  anyImageArn,
  baseImageArn,
  imageArn,
  managedConnectorArn,
  NAMES,
  PORTS,
  parameterArn,
} from "./names.ts";

export interface ImageStackProps extends cdk.StackProps {
  core: CoreStack;
  /** Version of the managed al2023-1 base image; resolved by scripts/base-image-version.ts. */
  baseImageVersion: string;
  /** Directory zipped as the code artifact: Dockerfile, main.js, programs/. */
  stagingDir: string;
}

function microvmServicePrincipal(): cdk.aws_iam.IPrincipal {
  // Both roles trust lambda.amazonaws.com for sts:AssumeRole and sts:TagSession (MicroVMs security guide).
  return new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com").withSessionTags();
}

export class ImageStack extends cdk.Stack {
  readonly image: cdk.aws_lambda.CfnMicrovmImage;
  readonly imageArn: string;
  readonly buildRole: cdk.aws_iam.Role;
  readonly controlPlaneRole: cdk.aws_iam.Role;
  readonly coreRole: cdk.aws_iam.Role;
  readonly logGroup: cdk.aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props: ImageStackProps) {
    super(scope, id, props);
    const { core } = props;
    const iam = cdk.aws_iam;

    this.logGroup = new cdk.aws_logs.LogGroup(this, "MicrovmLogs", {
      logGroupName: NAMES.microvmLogGroup,
      retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logsPolicy = new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`],
    });

    const artifact = new cdk.aws_s3_assets.Asset(this, "ImageArtifact", { path: props.stagingDir });

    this.buildRole = new iam.Role(this, "BuildRole", {
      assumedBy: microvmServicePrincipal(),
      description: "Tabframe MicroVM image build: read the code artifact, write build logs",
    });
    artifact.grantRead(this.buildRole);
    this.buildRole.addToPolicy(logsPolicy);

    this.coreRole = new iam.Role(this, "CoreRole", {
      assumedBy: microvmServicePrincipal(),
      description: "Tabframe cloud core: logs only",
    });
    this.coreRole.addToPolicy(logsPolicy);

    this.controlPlaneRole = new iam.Role(this, "ControlPlaneRole", {
      assumedBy: microvmServicePrincipal(),
      description: "Tabframe control plane: presign blobs, snapshots, pointer, manage cores",
    });
    this.controlPlaneRole.addToPolicy(logsPolicy);
    core.blobBucket.grantPut(this.controlPlaneRole);
    core.blobBucket.grantRead(this.controlPlaneRole);
    core.snapshotBucket.grantReadWrite(this.controlPlaneRole);
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [parameterArn(this, NAMES.pointerParam)],
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:GetMicrovmImage",
        ],
        resources: [anyImageArn(this)],
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["lambda:ListMicrovms"], resources: ["*"] }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        // The managed connectors live in the "aws" account; a wildcard on their ARN pattern was still
        // denied at deploy, so this action is granted on "*".
        actions: ["lambda:PassNetworkConnector"],
        resources: ["*"],
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        // PassRole is limited to the one role; a PassedToService condition is not honored by RunMicrovm.
        actions: ["iam:PassRole"],
        resources: [this.coreRole.roleArn],
      }),
    );

    this.imageArn = imageArn(this);
    this.image = new cdk.aws_lambda.CfnMicrovmImage(this, "Image", {
      name: NAMES.imageName,
      description: "Tabframe control plane and cloud core (one image, role from the run payload)",
      baseImageArn: baseImageArn(this),
      baseImageVersion: props.baseImageVersion,
      buildRoleArn: this.buildRole.roleArn,
      codeArtifact: { uri: artifact.s3ObjectUrl },
      cpuConfigurations: [{ architecture: "ARM_64" }],
      resources: [{ minimumMemoryInMiB: 1024 }],
      egressNetworkConnectors: [managedConnectorArn(this, "INTERNET_EGRESS")],
      additionalOsCapabilities: [],
      environmentVariables: [
        { key: "TABFRAME_BLOB_BUCKET", value: core.blobBucket.bucketName },
        { key: "TABFRAME_SNAPSHOT_BUCKET", value: core.snapshotBucket.bucketName },
        { key: "TABFRAME_POINTER_PARAM", value: NAMES.pointerParam },
        { key: "TABFRAME_CORE_ROLE_ARN", value: this.coreRole.roleArn },
        { key: "TABFRAME_IMAGE_ARN", value: this.imageArn },
        { key: "TABFRAME_PUBLIC_PORT", value: String(PORTS.public) },
        { key: "TABFRAME_PRIVATE_PORT", value: String(PORTS.private) },
        { key: "TABFRAME_MODE", value: "image" },
        { key: "TABFRAME_SANDBOX_WORKER", value: "/app/node-worker.js" },
        { key: "TABFRAME_HOST", value: "0.0.0.0" },
      ],
      // Hooks are ENABLED/DISABLED flags; the paths are fixed by the platform at
      // `${HOOK_BASE}/<hook>` on the configured port (private, 8081).
      hooks: {
        port: PORTS.private,
        microvmImageHooks: {
          ready: "ENABLED",
          readyTimeoutInSeconds: 120,
          validate: "ENABLED",
          validateTimeoutInSeconds: 120,
        },
        microvmHooks: {
          run: "ENABLED",
          runTimeoutInSeconds: 60,
          resume: "ENABLED",
          resumeTimeoutInSeconds: 30,
          suspend: "ENABLED",
          suspendTimeoutInSeconds: 30,
          terminate: "ENABLED",
          terminateTimeoutInSeconds: 30,
        },
      },
      logging: { cloudWatch: { logGroup: NAMES.microvmLogGroup } },
      tags: [{ key: "project", value: "tabframe" }],
    });
    this.image.node.addDependency(this.logGroup);
    this.image.node.addDependency(this.buildRole);

    new cdk.CfnOutput(this, "ImageArn", { value: this.imageArn });
    new cdk.CfnOutput(this, "ImageRef", { value: this.image.ref });
    new cdk.CfnOutput(this, "ControlPlaneRoleArn", { value: this.controlPlaneRole.roleArn });
    new cdk.CfnOutput(this, "CoreRoleArn", { value: this.coreRole.roleArn });
  }
}
