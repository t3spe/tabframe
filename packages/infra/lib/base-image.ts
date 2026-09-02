// Resolves the managed base image version to pass as CDK context (design §11.4: "looked up by a script").
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
} from "@aws-sdk/client-lambda-microvms";

export interface ManagedVersion {
  imageVersion: string;
  status: string | undefined;
}

export interface VersionLister {
  listVersions(imageArn: string): Promise<ManagedVersion[]>;
}

export class SdkVersionLister implements VersionLister {
  private readonly client: LambdaMicrovmsClient;
  constructor(client: LambdaMicrovmsClient = new LambdaMicrovmsClient({})) {
    this.client = client;
  }
  async listVersions(imageArn: string): Promise<ManagedVersion[]> {
    const out: ManagedVersion[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListManagedMicrovmImageVersionsCommand({ imageIdentifier: imageArn, nextToken }),
      );
      for (const item of page.items ?? []) {
        if (item.imageVersion) out.push({ imageVersion: item.imageVersion, status: item.status });
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return out;
  }
}

/** Highest-numbered AVAILABLE version, or null when none is available. */
export function pickAvailableVersion(versions: ManagedVersion[]): string | null {
  const available = versions
    .filter((v) => v.status === "AVAILABLE" && /^\d+$/.test(v.imageVersion))
    .map((v) => Number(v.imageVersion))
    .sort((a, b) => b - a);
  const best = available[0];
  return best === undefined ? null : String(best);
}

export async function resolveBaseImageVersion(
  lister: VersionLister,
  imageArn: string,
): Promise<string> {
  const version = pickAvailableVersion(await lister.listVersions(imageArn));
  if (version === null) throw new Error(`no AVAILABLE version for ${imageArn}`);
  return version;
}
