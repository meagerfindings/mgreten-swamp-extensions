import { z } from "npm:zod@4";

const SonyHostSchema = z.string().max(15).refine((value) => {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    return Number(part) <= 255;
  });
}, "Sony host must be an IPv4 address.");

export const SonyIdentifyArgsSchema = z.object({
  host: SonyHostSchema,
});

export const SonyInterfaceSchema = z.object({
  modelName: z.string().min(1).max(256),
  serverName: z.string().max(256),
  interfaceVersion: z.string().min(1).max(128),
  productName: z.string().min(1).max(256),
  productCategory: z.string().min(1).max(256),
}).strict();

export type SonyInterface = z.infer<typeof SonyInterfaceSchema>;
export type SonyFetcher = (input: URL, init: RequestInit) => Promise<Response>;

export class SonyApiError extends Error {
  readonly httpStatus?: number;
  readonly rpcErrorCode?: number;

  constructor(
    message: string,
    details: { readonly httpStatus?: number; readonly rpcErrorCode?: number } =
      {},
  ) {
    super(message);
    this.name = "SonyApiError";
    this.httpStatus = details.httpStatus;
    this.rpcErrorCode = details.rpcErrorCode;
  }
}

const REQUEST_ID = 33;
const RESPONSE_LIMIT = 16 * 1024;
const SONY_REQUEST = {
  method: "getInterfaceInformation",
  id: REQUEST_ID,
  params: [],
  version: "1.0",
} as const;

function safeRpcErrorCode(value: unknown): number | undefined {
  if (
    !Array.isArray(value) || value.length !== 2 || typeof value[1] !== "string"
  ) {
    return undefined;
  }
  const code: unknown = value[0];
  return typeof code === "number" && Number.isSafeInteger(code) &&
      code >= 0 && code <= 65_535
    ? code
    : undefined;
}

function envelopeRpcErrorCode(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  return Object.hasOwn(envelope, "error")
    ? safeRpcErrorCode(envelope.error)
    : undefined;
}

async function readBoundedRpcErrorCode(
  response: Response,
): Promise<number | undefined> {
  try {
    return envelopeRpcErrorCode(
      JSON.parse(await boundedResponseText(response)) as unknown,
    );
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
}

function jsonRpcError(code: number | undefined): SonyApiError {
  return new SonyApiError(
    code === undefined
      ? "Sony API returned a JSON-RPC error."
      : `Sony API returned a JSON-RPC error (code ${code}).`,
    code === undefined ? {} : { rpcErrorCode: code },
  );
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength && /^\d+$/.test(contentLength) &&
    Number(contentLength) > RESPONSE_LIMIT
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Sony API response exceeded the 16384-byte limit.");
  }
  if (!response.body) {
    throw new Error("Sony API returned an empty response body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Sony API response exceeded the 16384-byte limit.");
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Sony API response was not valid UTF-8.");
  }
}

function parseEnvelope(value: unknown): SonyInterface {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sony API returned a malformed JSON-RPC response.");
  }

  const envelope = value as Record<string, unknown>;
  if (Object.hasOwn(envelope, "error")) {
    throw jsonRpcError(safeRpcErrorCode(envelope.error));
  }
  if (
    envelope.id !== REQUEST_ID || !Array.isArray(envelope.result) ||
    envelope.result.length !== 1
  ) {
    throw new Error(
      "Sony API returned an unexpected getInterfaceInformation result.",
    );
  }
  const parsed = SonyInterfaceSchema.safeParse(envelope.result[0]);
  if (!parsed.success) {
    throw new Error("Sony API returned malformed interface information.");
  }
  return parsed.data;
}

export async function identifySony(
  host: string,
  timeoutMs: number,
  fetcher: SonyFetcher = fetch,
): Promise<SonyInterface> {
  const validatedHost = SonyHostSchema.parse(host);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetcher(new URL(`http://${validatedHost}/sony/system`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(SONY_REQUEST),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new Error(`Sony API request timed out after ${timeoutMs} ms.`);
      }
      throw new Error("Sony API request failed.");
    }

    if (!response.ok) {
      const rpcErrorCode = await readBoundedRpcErrorCode(response);
      throw new SonyApiError(
        rpcErrorCode === undefined
          ? `Sony API returned HTTP ${response.status}.`
          : `Sony API returned HTTP ${response.status} with JSON-RPC error code ${rpcErrorCode}.`,
        {
          httpStatus: response.status,
          ...(rpcErrorCode === undefined ? {} : { rpcErrorCode }),
        },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Sony API returned invalid JSON.");
      }
      throw error;
    }
    return parseEnvelope(payload);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
