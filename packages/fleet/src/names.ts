// The names the stacks create and the fleet code addresses at run time. Explicit names break what
// would otherwise be token cycles in the stacks (session → rotate → session URL) and give the
// operator scripts stable targets.

export const NAMES = {
  alarmTopic: "tabframe-alarms",
  canaryFunction: "tabframe-canary",
  imageName: "tabframe",
  sessionFunction: "tabframe-session",
  rotateFunction: "tabframe-rotate",
  hourlyRule: "tabframe-rotate-hourly",
  pointerParam: "/tabframe/pointer",
  microvmLogGroup: "/aws/lambda/microvms/tabframe",
  baseImageName: "al2023-1",
} as const;

/** The control plane's ports: browsers reach `public` through the proxy, the fleet reaches `private`. */
export const PORTS = { public: 8080, private: 8081 } as const;

export const REGION_DEFAULT = "us-west-2";

/** Where the platform delivers the MicroVM lifecycle hooks, on the private port. */
export const HOOK_BASE = "/aws/lambda-microvms/runtime/v1";
