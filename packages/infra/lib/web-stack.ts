// Web stack (design §11.4): the built page goes to the web bucket with a config.json naming the
// session URL, and the distribution is invalidated. Depends on Core (bucket, distribution) and
// Fleet (session URL), so it deploys last: Core → Image → Fleet → Web.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CoreStack } from "./core-stack.ts";
import type { FleetStack } from "./fleet-stack.ts";

export interface WebStackProps extends cdk.StackProps {
  core: CoreStack;
  fleet: FleetStack;
  /** The built bundle directory (packages/web/dist). */
  distDir: string;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const deploy = cdk.aws_s3_deployment;
    new deploy.BucketDeployment(this, "Web", {
      destinationBucket: props.core.webBucket,
      sources: [
        deploy.Source.asset(props.distDir),
        deploy.Source.jsonData("config.json", { sessionUrl: props.fleet.sessionUrl.url }),
      ],
      distribution: props.core.distribution,
      distributionPaths: ["/*"],
      prune: true,
      memoryLimit: 512,
    });
    new cdk.CfnOutput(this, "PageUrl", { value: props.core.webOrigin });
    new cdk.CfnOutput(this, "ConfigSessionUrl", { value: props.fleet.sessionUrl.url });
  }
}
