/** postMessage protocol between MAIN world (inpage) and ISOLATED world (content). */
export const BRIDGE_NS = "__super-ghost-wallet__";

export interface BridgeMessage {
  [BRIDGE_NS]: true;
  type: "config" | "persist" | "get-config";
  config?: unknown;
}

export function isBridgeMessage(data: unknown): data is BridgeMessage {
  return (
    typeof data === "object" && data !== null && (data as never)[BRIDGE_NS] === true
  );
}

export function post(type: BridgeMessage["type"], config?: unknown) {
  const msg: BridgeMessage = { [BRIDGE_NS]: true, type };
  if (config !== undefined) msg.config = config;
  window.postMessage(msg, "*");
}
