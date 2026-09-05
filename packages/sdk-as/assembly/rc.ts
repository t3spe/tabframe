// Return codes of the tf imports (design §5.3): the sandbox's values (packages/sandbox/src/fs.ts);
// a test compiles a program that reports them and compares.
export namespace RC {
  /** The path does not exist. */
  export const notFound: i32 = -1;
  /** A bad path, offset, or pointer; a write to a relative path lands here, not in capExceeded. */
  export const badArgs: i32 = -2;
  /** The task's write budget — files or bytes — is spent. */
  export const capExceeded: i32 = -3;
}
