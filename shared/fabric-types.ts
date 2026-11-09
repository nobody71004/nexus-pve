/**
 * Relay Fabric is a controller for a small, ordered TCP relay chain:
 * entry -> zero or more middle hops -> exit -> origin.  Every hop talks to the
 * next over a private WireGuard interface; only the entry port is public.
 * The contracts here never contain private keys.
 */

export type RelayHealth = "online" | "degraded" | "offline" | "connecting";
export type RelayTransport = "wireguard";
export type RelayObfuscation = "none" | "tls";

export interface RelayNodeConfig {
  hostId: string;
  label: string;
  /** Free-form location shown in the chain, e.g. "Ashburn, VA". */
  region: string;
  /** Public address clients reach for this hop. Defaults to the SSH host. */
  publicHost?: string;
  /** WireGuard UDP listen port on this node. */
  wgPort: number;
}

export interface RelayChain {
  id: string;
  name: string;
  /** Ordered entry -> ... -> exit. */
  nodes: RelayNodeConfig[];
  originHost: string;
  originPort: number;
  /** Public TCP port exposed on the entry node. */
  entryPort: number;
  /** Private TCP port each hop listens on over the WireGuard interface. */
  relayPort: number;
  mtu: number;
  transport: RelayTransport;
  /** Opt-in public-entry TLS camouflage. None by default. */
  obfuscation: RelayObfuscation;
  createdAt: number;
  updatedAt: number;
}

export interface RelayChainInput {
  id?: string;
  name: string;
  nodes: RelayNodeConfig[];
  originHost: string;
  originPort: number;
  entryPort: number;
  relayPort: number;
  mtu: number;
  transport: RelayTransport;
  obfuscation?: RelayObfuscation;
}

/** Minimal host view used by the fabric UI; no secrets or SSH details leak. */
export interface RelayHost {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  color: string;
}

export type RelayRole = "entry" | "relay" | "exit";

export interface RelayPlanHop {
  index: number;
  hostId: string;
  label: string;
  role: RelayRole;
  publicHost: string;
  wgAddress: string;
  listen: string;
  forwardTo: string;
}

export interface RelayPlan {
  chainId: string;
  hops: RelayPlanHop[];
  origin: string;
  transport: RelayTransport;
  encryption: string;
  obfuscation: string;
  warnings: string[];
}

export interface RelayNodeStatus {
  hostId: string;
  health: RelayHealth;
  latencyMs: number;
  wgActive: boolean;
  relayActive: boolean;
  peers: number;
  listener: boolean;
  tls?: boolean;
  tlsFingerprint?: string;
  error?: string;
  checkedAt: number;
}

export interface RelayOverview {
  chain: RelayChain | null;
  hosts: RelayHost[];
  statuses: RelayNodeStatus[];
  plan: RelayPlan | null;
  error?: string;
  checkedAt: number;
}

export interface RelayDeployOutput {
  hostId: string;
  label: string;
  ok: boolean;
  output: string;
}

export interface RelayDeployResult {
  ok: boolean;
  chain: RelayChain;
  outputs: RelayDeployOutput[];
  error?: string;
}

export interface RelayRemoveResult {
  ok: boolean;
  outputs: RelayDeployOutput[];
  error?: string;
}

/**
 * A loopback WebSocket URL plus a single-use token. The VNC TCP connection is
 * carried inside the existing SSH session; the renderer never sees credentials.
 */
export interface VncSession {
  id: string;
  hostId: string;
  wsUrl: string;
  expiresAt: number;
}

/**
 * Read-only probe of a host's VNC listeners. It never opens a session and keeps
 * loopback and exposed sockets separate, so the console can pick a safe port.
 */
export interface VncPreflight {
  hostId: string;
  host: string;
  hostname?: string;
  checkedAt: number;
  latencyMs: number;
  /** Every port in 5900-5999 with a listening socket. */
  ports: number[];
  /** Ports bound to 127.0.0.1/::1, safe for the SSH tunnel. */
  loopbackPorts: number[];
  /** Ports bound to a wildcard or public address, reachable beyond loopback. */
  exposedPorts: number[];
  /** Port the console should open: loopback first, then wildcard, else 5900. */
  suggestedPort: number;
  /** Detected daemon name, e.g. "wayvnc". */
  daemon?: string;
  ok: boolean;
  detail: string;
  error?: string;
}
