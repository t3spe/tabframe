// Image stack (design §9.3, §11.3, §11.4): the MicroVM image, its build role, and the two execution
// roles. Nothing fleet-related is baked into the image, which keeps Core → Image → Fleet acyclic.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { NAMES, PORTS } from "../../fleet/src/names.ts";
import type { FoundationStack } from "./foundation-stack.ts";
import { grantMicrovmLauncher, grantPassRole, grantPointer, logsStatement } from "./grants.ts";
import { anyImageArn, baseImageArn, imageArn, managedConnectorArn, parameterArn } from "./names.ts";

export interface ImageStackProps extends cdk.StackProps {
  foundation: FoundationStack;
  /** Version of the managed al2023-1 base image; resolved by scripts/base-image-version.ts. */
  baseImageVersion: string;
  /** Directory zipped as the code artifact: Dockerfile, main.js, programs/. */
  stagingDir: string;
}

/** Both execution roles trust lambda.amazonaws.com for sts:AssumeRole and sts:TagSession (MicroVMs security guide). */
function microvmServicePrincipal(): cdk.aws_iam.IPrincipal {
  return new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com").withSessionTags();
}

export class ImageStack extends cdk.Stack {
  readonly image: cdk.aws_lambda.CfnMicrovmImage;
  readonly imageArn: string;
  readonly buildRole: cdk.aws_iam.Role;
  readonly controlPlaneRole: cdk.aws_iam.Role;
  /** The cloud cores' execution role; its construct id and output keep the deployed name "CoreRole". */
  readonly cloudCoreRole: cdk.aws_iam.Role;
  readonly logGroup: cdk.aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props: ImageStackProps) {
    super(scope, id, props);
    const { foundation } = props;
    const iam = cdk.aws_iam;

    this.logGroup = new cdk.aws_logs.LogGroup(this, "MicrovmLogs", {
      logGroupName: NAMES.microvmLogGroup,
      retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logs = logsStatement(this.logGroup);

    const artifact = new cdk.aws_s3_assets.Asset(this, "ImageArtifact", { path: props.stagingDir });

    this.buildRole = new iam.Role(this, "BuildRole", {
      assumedBy: microvmServicePrincipal(),
      description: "Tabframe MicroVM image build: read the code artifact, write build logs",
    });
    artifact.grantRead(this.buildRole);
    this.buildRole.addToPolicy(logs);

    this.cloudCoreRole = new iam.Role(this, "CoreRole", {
      assumedBy: microvmServicePrincipal(),
      description: "Tabframe cloud core: logs only",
    });
    this.cloudCoreRole.addToPolicy(logs);

    this.controlPlaneRole = new iam.Role(this, "ControlPlaneRole", {
      assumedBy: microvmServicePrincipal(),
      description: "Tabframe control plane: presign blobs, snapshots, pointer, manage cores",
    });
    this.controlPlaneRole.addToPolicy(logs);
    foundation.blobBucket.grantPut(this.controlPlaneRole);
    foundation.blobBucket.grantRead(this.controlPlaneRole);
    // Put and read, never delete: a compromised control plane must not be able to erase the
    // lineage a heal boots from.
    foundation.snapshotBucket.grantPut(this.controlPlaneRole);
    foundation.snapshotBucket.grantRead(this.controlPlaneRole);
    grantPointer(this.controlPlaneRole, parameterArn(this, NAMES.pointerParam), "read");
    grantMicrovmLauncher(this.controlPlaneRole, {
      launchImageArn: imageArn(this),
      anyImageArn: anyImageArn(this),
      mintsTokens: false,
    });
    grantPassRole(this.controlPlaneRole, this.cloudCoreRole);

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
        { key: "TABFRAME_BLOB_BUCKET", value: foundation.blobBucket.bucketName },
        { key: "TABFRAME_SNAPSHOT_BUCKET", value: foundation.snapshotBucket.bucketName },
        { key: "TABFRAME_POINTER_PARAM", value: NAMES.pointerParam },
        { key: "TABFRAME_CORE_ROLE_ARN", value: this.cloudCoreRole.roleArn },
        { key: "TABFRAME_IMAGE_ARN", value: this.imageArn },
        { key: "TABFRAME_PUBLIC_PORT", value: String(PORTS.public) },
        { key: "TABFRAME_PRIVATE_PORT", value: String(PORTS.private) },
        { key: "TABFRAME_MODE", value: "image" },
        { key: "TABFRAME_SANDBOX_WORKER", value: "/app/node-worker.js" },
        { key: "TABFRAME_HOST", value: "0.0.0.0" },
      ],
      // Hooks are ENABLED/DISABLED flags; the platform delivers them at `HOOK_BASE/<hook>` on the
      // private port.
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
    new cdk.CfnOutput(this, "CoreRoleArn", { value: this.cloudCoreRole.roleArn });
  }
}
