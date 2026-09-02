// Core stack (design §11.4): buckets, CloudFront, the pointer parameter, the fleet secret, the budget.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { NAMES } from "./names.ts";

export interface CoreStackProps extends cdk.StackProps {
  /** Notification address for the budget. When absent the budget is skipped with a synth warning. */
  budgetEmail?: string;
}

export class CoreStack extends cdk.Stack {
  readonly artifactsBucket: cdk.aws_s3.Bucket;
  readonly blobBucket: cdk.aws_s3.Bucket;
  readonly snapshotBucket: cdk.aws_s3.Bucket;
  readonly webBucket: cdk.aws_s3.Bucket;
  readonly distribution: cdk.aws_cloudfront.Distribution;
  readonly pointer: cdk.aws_ssm.StringParameter;
  readonly fleetSecret: cdk.aws_secretsmanager.Secret;
  /** `https://<distribution domain>` — the page origin and the store base. */
  readonly webOrigin: string;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);

    const s3 = cdk.aws_s3;
    const privateBucket = (name: string, extra: cdk.aws_s3.BucketProps = {}) =>
      new s3.Bucket(this, name, {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        ...extra,
      });

    this.artifactsBucket = privateBucket("Artifacts");

    this.blobBucket = privateBucket("Blobs", {
      lifecycleRules: [{ id: "expire-one-year", expiration: cdk.Duration.days(365) }],
      cors: [
        {
          // Presigned PUTs come straight from browsers; the presigned URL is the authorization,
          // and the origin cannot be the distribution's own domain without a dependency cycle.
          allowedOrigins: ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag", "x-amz-checksum-sha256"],
          maxAge: 3600,
        },
      ],
    });

    this.snapshotBucket = privateBucket("Snapshots", {
      lifecycleRules: [{ id: "expire-one-day", expiration: cdk.Duration.days(1) }],
    });

    this.webBucket = privateBucket("Web");

    const cf = cdk.aws_cloudfront;
    const origins = cdk.aws_cloudfront_origins;
    this.distribution = new cf.Distribution(this, "Distribution", {
      comment: "Tabframe: page and content-addressed blob store",
      defaultRootObject: "index.html",
      priceClass: cf.PriceClass.PRICE_CLASS_100,
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        "blob/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.blobBucket),
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cf.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          compress: false,
        },
      },
      // A request that lands a moment before an upload completes must not pin a 404 (design §7.1).
      errorResponses: [
        { httpStatus: 403, ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, ttl: cdk.Duration.seconds(0) },
      ],
    });
    this.webOrigin = `https://${this.distribution.distributionDomainName}`;

    // The pointer starts off (decision D20). The fleet functions rewrite it out of band; CloudFormation
    // only touches it again if this template value changes.
    this.pointer = new cdk.aws_ssm.StringParameter(this, "Pointer", {
      parameterName: NAMES.pointerParam,
      stringValue: JSON.stringify({ state: "off" }),
      description: "Tabframe active control plane pointer (managed by the fleet functions)",
    });

    this.fleetSecret = new cdk.aws_secretsmanager.Secret(this, "FleetSecret", {
      description: "Tabframe fleet secret: gates the control plane's private endpoints",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    if (props.budgetEmail) {
      const subscribers = [{ subscriptionType: "EMAIL", address: props.budgetEmail }];
      new cdk.aws_budgets.CfnBudget(this, "Budget", {
        budget: {
          budgetName: "tabframe-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: 100, unit: "USD" },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 50,
              thresholdType: "PERCENTAGE",
            },
            subscribers,
          },
          {
            notification: {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers,
          },
          {
            notification: {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers,
          },
          {
            notification: {
              notificationType: "FORECASTED",
              comparisonOperator: "GREATER_THAN",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers,
          },
        ],
      });
    } else {
      cdk.Annotations.of(this).addWarningV2(
        "tabframe:budget-skipped",
        "TABFRAME_BUDGET_EMAIL is not set; the $100/month budget was not created.",
      );
    }

    new cdk.CfnOutput(this, "WebOrigin", { value: this.webOrigin });
    new cdk.CfnOutput(this, "BlobBucketName", { value: this.blobBucket.bucketName });
    new cdk.CfnOutput(this, "SnapshotBucketName", { value: this.snapshotBucket.bucketName });
    new cdk.CfnOutput(this, "WebBucketName", { value: this.webBucket.bucketName });
    new cdk.CfnOutput(this, "ArtifactsBucketName", { value: this.artifactsBucket.bucketName });
    new cdk.CfnOutput(this, "PointerParameter", { value: this.pointer.parameterName });
  }
}
