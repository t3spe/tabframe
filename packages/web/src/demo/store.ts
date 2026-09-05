// The demo's in-page store: hash → bytes, bounded to about two frames of tiles so a dashboard left
// on the demo all afternoon does not grow without bound. Reads refresh an entry, so the seeded
// program files and whatever the page keeps showing stay; tiles nobody asks for again go first.

export const DEMO_STORE_CAP = 1500;

export class BoundedBlobMap extends Map<string, Uint8Array> {
  override get(key: string): Uint8Array | undefined {
    const v = super.get(key);
    if (v !== undefined) {
      super.delete(key);
      super.set(key, v);
    }
    return v;
  }
  override set(key: string, value: Uint8Array): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > DEMO_STORE_CAP) {
      const oldest = this.keys().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}
