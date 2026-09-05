// The compiler flags every program is built with and the memory maximum the SDK documents. No
// imports: the program build, the sandbox's test fixtures, and the web editor all read these.

/**
 * The reference memory maximum in 64 KiB pages (16 MiB): what shipped programs declare. The
 * machine's cap on a declared maximum is higher (core's DEFAULT_TASK_LIMITS.memoryPagesMax).
 */
export const MEMORY_PAGES_REFERENCE = 256;

/** A bump allocator and no collector: every task runs in a fresh instance, so nothing needs freeing. */
export const ASC_RUNTIME = ["--runtime", "stub"];

/** The build's flags: speed, the stub runtime, no assertions, the reference memory maximum. */
export const ASC_FLAGS = [
  "-O3",
  ...ASC_RUNTIME,
  "--noAssert",
  "--maximumMemory",
  String(MEMORY_PAGES_REFERENCE),
];
