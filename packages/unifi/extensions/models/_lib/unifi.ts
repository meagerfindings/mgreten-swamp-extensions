// Shared UniFi UDM API client.
// Uses curl via Deno.Command because Deno's fetch cannot skip TLS verification
// and UDM controllers use self-signed certificates.

import { z } from "npm:zod@4";
import { totpCode } from "./totp.ts";

export const UnifiGlobalArgsSchema = z.object({
  host: z.string().describe(
    "UDM IP address or hostname, e.g. 192.0.2.1",
  ),
  username: z.string().describe("Local admin username"),
  password: z.string().meta({ sensitive: true }).describe(
    "Local admin password (use a vault reference)",
  ),
  totpSecret: z.string().meta({ sensitive: true }).optional().describe(
    "Base32 TOTP secret for MFA-enabled accounts (use a vault reference). " +
      "Omit for local-only admin accounts, which bypass SSO MFA.",
  ),
  site: z.string().default("default").describe("UniFi site name"),
});

export type UnifiGlobalArgs = z.infer<typeof UnifiGlobalArgsSchema>;

export interface UnifiClient {
  request<T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<T>;
  cleanup(): Promise<void>;
  baseUrl: string;
  site: string;
}

async function curl(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Response> {
  const args = [
    "-sk",
    "--connect-timeout",
    "10",
    "-X",
    init.method || "GET",
  ];

  if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      args.push("-H", `${key}: ${value}`);
    }
  }

  if (init.body !== undefined) {
    args.push("-d", init.body);
  }

  // Dump response headers to stderr so we can recover status + cookies.
  args.push("-D", "/dev/stderr");
  args.push(url);

  const cmd = new Deno.Command("curl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  const body = new TextDecoder().decode(output.stdout);
  const headerText = new TextDecoder().decode(output.stderr);

  const statusMatch = headerText.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch
    ? parseInt(statusMatch[1])
    : (output.success ? 200 : 500);

  const responseHeaders = new Headers();
  for (const line of headerText.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      responseHeaders.append(
        line.slice(0, colonIdx).trim(),
        line.slice(colonIdx + 1).trim(),
      );
    }
  }

  return new Response(body, { status, headers: responseHeaders });
}

/**
 * Authenticate against a UDM controller and return a UnifiClient.
 * Uses /api/auth/login → captures session cookie + CSRF token.
 */
export async function login(args: UnifiGlobalArgs): Promise<UnifiClient> {
  const baseUrl = `https://${args.host}`;

  const payload: Record<string, unknown> = {
    username: args.username,
    password: args.password,
    remember: true,
  };
  // Accounts with MFA enabled reject password-only logins with
  // MFA_AUTH_REQUIRED; deriving the code in-process keeps the models
  // runnable unattended.
  if (args.totpSecret) {
    payload.token = await totpCode(args.totpSecret);
  }

  const loginResp = await curl(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!loginResp.ok) {
    const text = await loginResp.text();
    const hint = text.includes("MFA_AUTH_REQUIRED")
      ? " — this account requires MFA; set `totpSecret`, or use a local-only admin account"
      : "";
    throw new Error(
      `UniFi login to ${args.host} failed (${loginResp.status})${hint}: ${text}`,
    );
  }

  const csrfToken = loginResp.headers.get("x-csrf-token") || "";
  const setCookie = loginResp.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.length > 0)
    .join("; ");

  return {
    baseUrl,
    site: args.site,
    async request<T = unknown>(
      path: string,
      method = "GET",
      body?: unknown,
    ): Promise<T> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookie,
      };
      if (method !== "GET" && method !== "HEAD") {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const resp = await curl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `UniFi API ${method} ${path} failed (${resp.status}): ${text}`,
        );
      }

      const text = await resp.text();
      if (!text) return undefined as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
    async cleanup() {
      try {
        await curl(`${baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
        });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Build the path prefix for the legacy Network API proxied through the UDM.
 */
export function networkPath(site: string, suffix: string): string {
  return `/proxy/network/api/s/${site}${suffix}`;
}

/**
 * Zod schema for UniFi list responses, which always look like { meta: {...}, data: [...] }.
 */
const UnifiListResponseSchema = z.object({
  meta: z.object({
    rc: z.string().optional(),
    msg: z.string().optional(),
  }).optional(),
  data: z.array(z.unknown()).optional(),
});

/**
 * Generic helper: GET a list endpoint and return the data array.
 */
export async function list<T = Record<string, unknown>>(
  client: UnifiClient,
  endpoint: string,
): Promise<T[]> {
  const raw = await client.request<unknown>(
    networkPath(client.site, endpoint),
    "GET",
  );
  const resp = UnifiListResponseSchema.parse(raw);
  if (resp.meta?.rc && resp.meta.rc !== "ok") {
    throw new Error(`UniFi API returned rc=${resp.meta.rc}: ${resp.meta.msg}`);
  }
  return (resp.data ?? []) as T[];
}
