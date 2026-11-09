// noVNC ships ESM only and does not publish TypeScript declarations. Keep this
// surface deliberately small: the Nexus console only uses the public RFB API.
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RfbOptions {
    credentials?: RfbCredentials;
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
