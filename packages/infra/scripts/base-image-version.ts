// Prints the latest AVAILABLE al2023-1 version, for `cdk deploy -c baseImageVersion=N`.
import { assertTabframeIdentity } from "../../fleet/src/identity.ts";
import { NAMES, REGION_DEFAULT } from "../../fleet/src/names.ts";
import { resolveBaseImageVersion, SdkVersionLister } from "../lib/base-image.ts";

assertTabframeIdentity(process.env);
const region = process.env.AWS_REGION ?? REGION_DEFAULT;
const arn = `arn:aws:lambda:${region}:aws:microvm-image:${NAMES.baseImageName}`;
console.log(await resolveBaseImageVersion(new SdkVersionLister(), arn));
