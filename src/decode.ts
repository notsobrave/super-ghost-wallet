import { hexToString, isAddress, isHex, type Hex } from "viem";
import type { DecodedRequest, SiweFields } from "./types.js";

/**
 * Pure decoders: turn raw request params into a human/agent-readable
 * summary attached to the log entry. Best-effort — a failed decode never
 * blocks the signature itself.
 */

/** EIP-4361 first line: "<domain> wants you to sign in with your Ethereum account:" */
const SIWE_HEAD = /^(?<domain>\S+) wants you to sign in with your Ethereum account:\r?\n(?<address>0x[0-9a-fA-F]{40})/;

function parseSiwe(text: string): SiweFields | undefined {
  const head = SIWE_HEAD.exec(text);
  if (!head?.groups) return undefined;
  const field = (label: string) =>
    new RegExp(`^${label}: (.+)$`, "m").exec(text)?.[1];
  const chainId = field("Chain ID");
  const lines = text.split(/\r?\n/);
  // Statement = first non-empty line between the address and the URI block.
  const statement = lines
    .slice(2, lines.findIndex((l) => l.startsWith("URI: ")))
    .find((l) => l.trim() !== "");
  return {
    domain: head.groups.domain,
    address: head.groups.address,
    statement,
    uri: field("URI"),
    chainId: chainId ? Number(chainId) : undefined,
    nonce: field("Nonce"),
    issuedAt: field("Issued At"),
  };
}

export function decodePersonalSign(params: unknown): DecodedRequest | undefined {
  if (!Array.isArray(params)) return undefined;
  const raw = params.find(
    (p): p is string =>
      typeof p === "string" && !isAddress(p, { strict: false }),
  );
  if (raw === undefined) return undefined;
  let text = raw;
  if (isHex(raw)) {
    try {
      text = hexToString(raw as Hex);
    } catch {
      return { kind: "message", summary: `(binary) ${raw.slice(0, 66)}…` };
    }
  }
  const siwe = parseSiwe(text);
  return siwe
    ? {
        kind: "siwe",
        summary: `SIWE sign-in for ${siwe.domain} (nonce ${siwe.nonce ?? "?"})`,
        siwe,
      }
    : { kind: "message", summary: text.length > 200 ? `${text.slice(0, 200)}…` : text };
}

export function decodeTypedData(params: unknown): DecodedRequest | undefined {
  if (!Array.isArray(params)) return undefined;
  const raw = params.find((p) => typeof p === "object" || (typeof p === "string" && p.trim().startsWith("{")));
  if (raw === undefined) return undefined;
  try {
    const typed = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
    const primaryType = String(typed.primaryType ?? "?");
    const domain = (typed.domain ?? {}) as Record<string, unknown>;
    const domainName = domain.name !== undefined ? String(domain.name) : undefined;
    return {
      kind: "typed-data",
      summary: `EIP-712 ${primaryType}${domainName ? ` @ ${domainName}` : ""}`,
      primaryType,
      domainName,
    };
  } catch {
    return undefined;
  }
}

export function decodeTransaction(params: unknown): DecodedRequest | undefined {
  if (!Array.isArray(params) || typeof params[0] !== "object" || params[0] === null)
    return undefined;
  const tx = params[0] as Record<string, unknown>;
  const value = typeof tx.value === "string" ? BigInt(tx.value) : 0n;
  const eth = Number(value) / 1e18;
  return {
    kind: "transaction",
    summary: `tx to ${tx.to ?? "(deploy)"}${eth ? ` value ${eth} ETH` : ""}${tx.data && tx.data !== "0x" ? " with calldata" : ""}`,
  };
}

export function decodeRequest(method: string, params: unknown): DecodedRequest | undefined {
  try {
    switch (method) {
      case "personal_sign":
        return decodePersonalSign(params);
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4":
        return decodeTypedData(params);
      case "eth_sendTransaction":
        return decodeTransaction(params);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
