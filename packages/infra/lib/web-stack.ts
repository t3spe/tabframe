// Web stack (design §11.4): the built page goes to the web bucket with a config.json naming the
// session URL, and the distribution is invalidated. Depends on the foundation (bucket, distribution)
// and Fleet (session URL), so it deploys last: Core → Image → Fleet → Web.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { FleetStack } from "./fleet-stack.ts";
import type { FoundationStack } from "./foundation-stack.ts";

export interface WebStackProps extends cdk.StackProps {
  foundation: FoundationStack;
  fleet: FleetStack;
  /** The built bundle directory (packages/web/dist). */
  distDir: string;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const deploy = cdk.aws_s3_deployment;
    new deploy.BucketDeployment(this, "Web", {
      destinationBucket: props.foundation.webBucket,
      sources: [
        deploy.Source.asset(props.distDir),
        deploy.Source.jsonData("config.json", { sessionUrl: props.fleet.sessionUrl.url }),
      ],
      distribution: props.foundation.distribution,
      distributionPaths: ["/*"],
      prune: true,
      // Nothing is content-hashed, so nothing is immutable: every object is revalidated, and a
      // protocol bump reaches a tab on its next load instead of leaning on the reload guard.
      cacheControl: [deploy.CacheControl.fromString("no-cache")],
      memoryLimit: 512,
    });
    new cdk.CfnOutput(this, "PageUrl", { value: props.foundation.webOrigin });
    new cdk.CfnOutput(this, "ConfigSessionUrl", { value: props.fleet.sessionUrl.url });
  }
}
