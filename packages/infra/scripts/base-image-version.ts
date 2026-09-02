// Operator script: prints the latest AVAILABLE al2023-1 version for `cdk deploy -c baseImageVersion=N`.
import { resolveBaseImageVersion, SdkVersionLister } from "../lib/base-image.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const arn = `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
console.log(await resolveBaseImageVersion(new SdkVersionLister(), arn));
