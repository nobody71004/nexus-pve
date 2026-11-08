import type { NexusBridge } from "../../shared/types";
import { createMockBridge } from "./mock";

const unavailable = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error("Nexus bridge unavailable — open this UI inside the desktop app.")),
  },
) as NexusBridge;

export const isMockBridge = !window.nexus;

export const bridge: NexusBridge = window.nexus ?? (import.meta.env.DEV ? createMockBridge() : unavailable);
