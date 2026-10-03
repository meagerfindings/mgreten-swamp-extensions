/** Canva REST integration: vault-backed OAuth and resumable local image uploads. @module */
import { z } from "npm:zod@4";
import { isAbsolute, join, relative, resolve } from "node:path";

const id = z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/);
const key = z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/);
const secret = z.string().min(1).meta({ sensitive: true });
const scope = z.enum([
  "asset:read",
  "asset:write",
  "folder:read",
  "folder:write",
]);
const globals = z.object({
  clientId: z.string().min(1),
  clientSecret: secret.optional().meta({ sensitive: true }),
  redirectUri: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)));
  }, "Use HTTPS, or HTTP loopback, without query/fragment/credentials"),
  assetRoot: z.string().min(1),
});
const authSchema = z.object({
  connectionId: z.uuid(),
  clientId: z.string(),
  redirectUri: z.string(),
  status: z.enum(["awaiting", "exchanging", "ready", "refreshing"]),
  scopes: z.array(scope),
  state: secret,
  verifier: secret,
  createdAt: z.iso.datetime(),
  authorizationUrl: z.url(),
  accessToken: secret.optional().meta({ sensitive: true }),
  refreshToken: secret.optional().meta({ sensitive: true }),
  expiresAt: z.iso.datetime().optional(),
});
const itemSchema = z.object({
  path: z.string(),
  name: z.string().min(1).max(50),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(50_000_000 - 1),
  status: z.enum(["ready", "uncertain", "submitted", "complete", "failed"]),
  jobId: id.optional(),
  assetId: id.optional(),
  errorCode: z.string().optional(),
});
const batchSchema = z.object({
  requestId: key,
  connectionId: z.uuid(),
  assetRoot: z.string(),
  items: z.array(itemSchema).min(1).max(100),
});
const folderSchema = z.object({
  requestId: key,
  connectionId: z.uuid(),
  name: z.string().min(1).max(255),
  parentId: id,
  status: z.enum(["uncertain", "complete"]),
  folderId: id.optional(),
});
const moveSchema = z.object({
  requestId: key,
  connectionId: z.uuid(),
  itemId: id,
  folderId: id,
  status: z.enum(["uncertain", "complete"]),
});
const pageSchema = z.object({
  folderId: id,
  items: z.array(
    z.object({ type: z.enum(["folder", "image"]), id, name: z.string() }),
  ),
  continuation: z.string().optional(),
  truncated: z.boolean(),
});
const jobSchema = z.object({
  job: z.object({
    id,
    status: z.enum(["in_progress", "success", "failed"]),
    asset: z.object({ id, type: z.literal("image") }).optional(),
    error: z.object({ code: z.string() }).optional(),
  }),
});
type Auth = z.infer<typeof authSchema>;
type Batch = z.infer<typeof batchSchema>;
type Item = z.infer<typeof itemSchema>;
type Handle = { name: string };
type Context = {
  globalArgs: z.infer<typeof globals>;
  repoDir: string;
  signal?: AbortSignal;
  logger: { info(message: string, values?: Record<string, unknown>): void };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<Handle>;
};

async function digest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function readImage(root: string, path: string): Promise<Uint8Array> {
  if (isAbsolute(path)) {
    throw new Error("Asset paths must be relative to assetRoot");
  }
  const real = await Deno.realPath(join(root, path));
  const rel = relative(root, real);
  if (
    !rel || rel === ".." ||
    rel.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("Asset path escapes assetRoot (including symlinks)");
  }
  const file = await Deno.open(real, { read: true });
  try {
    const stat = await file.stat();
    if (!stat.isFile || stat.size <= 0 || stat.size >= 50_000_000) {
      throw new Error(
        "Images must be nonempty regular files smaller than 50 MB",
      );
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = await file.read(bytes.subarray(offset));
      if (count === null) throw new Error("Image changed while reading");
      offset += count;
    }
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) =>
      bytes[i] === b
    );
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) {
      throw new Error(
        "Only PNG/JPEG image bytes are supported; export SVG to PNG first",
      );
    }
    return bytes;
  } finally {
    file.close();
  }
}

/** Build an isolated model with injectable transport and pacing for tests. */
export function createCanvaModel(
  transport: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  pause: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
) {
  async function request(
    ctx: Context,
    path: string,
    init: RequestInit = {},
    token?: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const timeout = AbortSignal.timeout(30_000);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await transport(`https://api.canva.com/rest/v1/${path}`, {
        ...init,
        headers,
        signal,
        redirect: "error",
      });
    } catch {
      throw new Error(
        "Canva request interrupted; inspect persisted intent before retrying a mutation",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const wait = response.headers.get("Retry-After");
      throw new Error(
        `Canva ${path.split("?")[0]} failed (HTTP ${response.status})${
          wait ? "; honor Retry-After before retrying" : ""
        }; no automatic mutation retry`,
      );
    }
    return response;
  }

  async function auth(ctx: Context, needed: string[] = []): Promise<Auth> {
    const stored = await ctx.readResource("oauth-session");
    if (!stored) {
      throw new Error(
        "Authorize Canva first with beginAuthorization and completeAuthorization",
      );
    }
    const value = authSchema.parse(stored);
    if (
      value.clientId !== ctx.globalArgs.clientId ||
      value.redirectUri !== ctx.globalArgs.redirectUri
    ) {
      throw new Error(
        "OAuth configuration changed; authorize a new connection",
      );
    }
    if (value.status !== "ready" || !value.accessToken || !value.expiresAt) {
      throw new Error(
        "OAuth is not ready; interrupted token exchanges require reauthorization, not blind retry",
      );
    }
    if (Date.parse(value.expiresAt) <= Date.now() + 60_000) {
      throw new Error("Access token expires soon; run refreshAuthorization");
    }
    if (
      needed.some((s) => !value.scopes.includes(s as z.infer<typeof scope>))
    ) throw new Error("Authorize with the required asset/folder scopes");
    return value;
  }

  function connection(expected: string, session: Auth): void {
    if (expected !== session.connectionId) {
      throw new Error(
        "Intent belongs to another OAuth connection; do not reuse it across accounts",
      );
    }
  }

  async function tokens(
    ctx: Context,
    session: Auth,
    parameters: URLSearchParams,
  ): Promise<Auth> {
    if (!ctx.globalArgs.clientSecret) {
      throw new Error("Configure clientSecret using a vault expression");
    }
    const credentials = btoa(
      `${ctx.globalArgs.clientId}:${ctx.globalArgs.clientSecret}`,
    );
    const response = await request(ctx, "oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters.toString(),
    });
    const value = z.object({
      access_token: secret,
      refresh_token: secret,
      expires_in: z.number().int().positive(),
      token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
      scope: z.string().optional(),
    }).parse(await response.json());
    const granted = value.scope === undefined
      ? session.scopes
      : value.scope.split(" ").filter(Boolean).map((s) => scope.parse(s));
    return {
      ...session,
      status: "ready",
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      scopes: granted,
      expiresAt: new Date(Date.now() + value.expires_in * 1000).toISOString(),
    };
  }

  async function page(
    ctx: Context,
    session: Auth,
    folderId: string,
    continuation?: string,
  ) {
    const query = new URLSearchParams({
      limit: "100",
      item_types: "folder,image",
    });
    if (continuation) query.set("continuation", continuation);
    const response = await request(
      ctx,
      `folders/${encodeURIComponent(folderId)}/items?${query}`,
      {},
      session.accessToken,
    );
    const result = z.object({
      items: z.array(z.union([
        z.object({
          type: z.literal("folder"),
          folder: z.object({ id, name: z.string() }),
        }),
        z.object({
          type: z.literal("image"),
          image: z.object({ id, name: z.string() }),
        }),
      ])),
      continuation: z.string().min(1).optional(),
    }).parse(await response.json());
    return pageSchema.parse({
      folderId,
      items: result.items.map((item) => ({
        type: item.type,
        ...(item.type === "folder" ? item.folder : item.image),
      })),
      continuation: result.continuation,
      truncated: !!result.continuation,
    });
  }

  async function observe(
    ctx: Context,
    session: Auth,
    item: Item,
  ): Promise<Item> {
    const response = await request(
      ctx,
      `asset-uploads/${encodeURIComponent(item.jobId!)}`,
      {},
      session.accessToken,
    );
    const { job } = jobSchema.parse(await response.json());
    if (job.id !== item.jobId) {
      throw new Error("Canva returned a different upload job ID");
    }
    if (job.status === "success") {
      if (!job.asset) {
        throw new Error("Successful upload job lacks an image asset");
      }
      return { ...item, status: "complete", assetId: job.asset.id };
    }
    if (job.status === "failed") {
      return {
        ...item,
        status: "failed",
        errorCode: job.error?.code ?? "upload_failed",
      };
    }
    return { ...item, status: "submitted" };
  }

  return {
    type: "@mgreten/canva",
    version: "2026.10.03.1",
    globalArguments: globals,
    resources: {
      auth: {
        description:
          "OAuth session; secret fields require Swamp vault protection",
        schema: authSchema,
        lifetime: "infinite",
        garbageCollection: 1,
      },
      batch: {
        description:
          "Frozen local upload manifest and durable per-image intent/job/asset receipts",
        schema: batchSchema,
        lifetime: "infinite",
        garbageCollection: 5,
      },
      folder: {
        description: "Folder creation intent and receipt",
        schema: folderSchema,
        lifetime: "infinite",
        garbageCollection: 5,
      },
      move: {
        description: "Folder move intent and reconciled receipt",
        schema: moveSchema,
        lifetime: "infinite",
        garbageCollection: 5,
      },
      page: {
        description:
          "One folder page with explicit continuation and truncation",
        schema: pageSchema,
        lifetime: "1d",
        garbageCollection: 5,
      },
    },
    methods: {
      beginAuthorization: {
        description:
          "Create a new PKCE session and browser URL; invalidates prior connection-bound intents",
        arguments: z.object({
          scopes: z.array(scope).min(1).default([
            "asset:read",
            "asset:write",
            "folder:read",
            "folder:write",
          ]),
        }),
        execute: async (
          args: { scopes: z.infer<typeof scope>[] },
          ctx: Context,
        ) => {
          ctx.logger.info("Preparing Canva authorization");
          const verifier = randomSecret(), state = randomSecret();
          const hash = new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ),
          );
          const challenge = btoa(String.fromCharCode(...hash)).replaceAll(
            "+",
            "-",
          ).replaceAll("/", "_").replaceAll("=", "");
          const url = new URL("https://www.canva.com/api/oauth/authorize");
          const scopes = [...new Set(args.scopes)];
          url.search = new URLSearchParams({
            client_id: ctx.globalArgs.clientId,
            redirect_uri: ctx.globalArgs.redirectUri,
            response_type: "code",
            code_challenge_method: "S256",
            code_challenge: challenge,
            state,
            scope: scopes.join(" "),
          }).toString();
          const value = authSchema.parse({
            connectionId: crypto.randomUUID(),
            clientId: ctx.globalArgs.clientId,
            redirectUri: ctx.globalArgs.redirectUri,
            status: "awaiting",
            scopes,
            state,
            verifier,
            createdAt: new Date().toISOString(),
            authorizationUrl: url.href,
          });
          const handle = await ctx.writeResource(
            "auth",
            "oauth-session",
            value,
          );
          ctx.logger.info("Prepared Canva browser authorization URL");
          return { dataHandles: [handle] };
        },
      },
      completeAuthorization: {
        description:
          "Validate callback URI/state/expiry and exchange a one-use authorization code; no retries",
        arguments: z.object({ callbackUrl: secret }),
        execute: async (args: { callbackUrl: string }, ctx: Context) => {
          ctx.logger.info("Completing Canva authorization");
          const stored = await ctx.readResource("oauth-session");
          if (!stored) throw new Error("Begin authorization first");
          const session = authSchema.parse(stored);
          const callback = new URL(args.callbackUrl),
            expected = new URL(ctx.globalArgs.redirectUri);
          if (
            session.status !== "awaiting" ||
            session.clientId !== ctx.globalArgs.clientId ||
            session.redirectUri !== ctx.globalArgs.redirectUri ||
            Date.now() - Date.parse(session.createdAt) > 10 * 60_000 ||
            callback.origin !== expected.origin ||
            callback.pathname !== expected.pathname || callback.hash ||
            callback.username || callback.password ||
            callback.searchParams.getAll("state").length !== 1 ||
            callback.searchParams.get("state") !== session.state ||
            callback.searchParams.getAll("code").length !== 1 ||
            !callback.searchParams.get("code") ||
            callback.searchParams.has("error")
          ) {
            throw new Error(
              "Invalid/expired OAuth callback or consumed session; begin authorization again",
            );
          }
          if (!ctx.globalArgs.clientSecret) {
            throw new Error("Configure clientSecret using a vault expression");
          }
          await ctx.writeResource("auth", "oauth-session", {
            ...session,
            status: "exchanging",
          });
          const value = await tokens(
            ctx,
            session,
            new URLSearchParams({
              grant_type: "authorization_code",
              code: callback.searchParams.get("code")!,
              code_verifier: session.verifier,
              redirect_uri: session.redirectUri,
            }),
          );
          const handle = await ctx.writeResource(
            "auth",
            "oauth-session",
            value,
          );
          ctx.logger.info("Connected Canva account");
          return { dataHandles: [handle] };
        },
      },
      refreshAuthorization: {
        description:
          "Rotate a one-use refresh token and persist the replacement; interrupted exchanges require reauthorization",
        arguments: z.object({}),
        execute: async (_args: Record<string, never>, ctx: Context) => {
          ctx.logger.info("Refreshing Canva authorization");
          const stored = await ctx.readResource("oauth-session");
          if (!stored) throw new Error("Authorize first");
          const session = authSchema.parse(stored);
          if (
            session.status !== "ready" || !session.refreshToken ||
            session.clientId !== ctx.globalArgs.clientId ||
            session.redirectUri !== ctx.globalArgs.redirectUri ||
            !ctx.globalArgs.clientSecret
          ) throw new Error("Cannot refresh this connection; reauthorize");
          await ctx.writeResource("auth", "oauth-session", {
            ...session,
            status: "refreshing",
          });
          const value = await tokens(
            ctx,
            session,
            new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: session.refreshToken,
            }),
          );
          const handle = await ctx.writeResource(
            "auth",
            "oauth-session",
            value,
          );
          ctx.logger.info("Refreshed Canva authorization");
          return { dataHandles: [handle] };
        },
      },
      prepareUploads: {
        description:
          "Freeze up to 100 PNG/JPEG paths, names and byte hashes without uploading; reuse IDs only for identical manifests",
        arguments: z.object({
          requestId: key,
          files: z.array(
            z.object({
              path: z.string().min(1),
              name: z.string().min(1).max(50),
            }),
          ).min(1).max(100),
        }),
        execute: async (
          args: { requestId: string; files: { path: string; name: string }[] },
          ctx: Context,
        ) => {
          ctx.logger.info("Preparing Canva image batch", {
            count: args.files.length,
          });
          const session = await auth(ctx, ["asset:write"]);
          const root = await Deno.realPath(
            resolve(ctx.repoDir, ctx.globalArgs.assetRoot),
          );
          const items: Item[] = [];
          for (const file of args.files) {
            const bytes = await readImage(root, file.path);
            items.push({
              ...file,
              sha256: await digest(bytes),
              bytes: bytes.length,
              status: "ready",
            });
          }
          if (new Set(items.map((item) => item.sha256)).size !== items.length) {
            throw new Error("Duplicate image bytes in batch");
          }
          const value = batchSchema.parse({
            requestId: args.requestId,
            connectionId: session.connectionId,
            assetRoot: root,
            items,
          });
          const previous = await ctx.readResource(`batch-${args.requestId}`);
          if (previous) {
            const old = batchSchema.parse(previous);
            const identity = (batch: Batch) =>
              JSON.stringify({
                ...batch,
                items: batch.items.map((
                  {
                    status: _s,
                    jobId: _j,
                    assetId: _a,
                    errorCode: _e,
                    ...item
                  },
                ) => item),
              });
            if (identity(old) !== identity(value)) {
              throw new Error(
                "requestId already binds a different manifest/connection",
              );
            }
            return { dataHandles: [] };
          }
          const handle = await ctx.writeResource(
            "batch",
            `batch-${args.requestId}`,
            value,
          );
          ctx.logger.info("Prepared Canva image batch", {
            count: items.length,
          });
          return { dataHandles: [handle] };
        },
      },
      uploadBatch: {
        description:
          "Upload frozen images sequentially, persist intent before POST, resume known jobs once, and never retry uncertain effects",
        arguments: z.object({ requestId: key, confirmUpload: z.literal(true) }),
        execute: async (
          args: { requestId: string; confirmUpload: true },
          ctx: Context,
        ) => {
          if (args.confirmUpload !== true) {
            throw new Error("Explicit confirmUpload is required");
          }
          ctx.logger.info("Processing Canva image batch");
          const session = await auth(ctx, ["asset:write", "asset:read"]);
          const stored = await ctx.readResource(`batch-${args.requestId}`);
          if (!stored) throw new Error("Prepare uploads first");
          const batch = batchSchema.parse(stored);
          connection(batch.connectionId, session);
          const root = await Deno.realPath(
            resolve(ctx.repoDir, ctx.globalArgs.assetRoot),
          );
          if (root !== batch.assetRoot) {
            throw new Error("Configured assetRoot changed");
          }
          // Validate every file before the first external write, including on resume.
          for (const item of batch.items) {
            const bytes = await readImage(root, item.path);
            if (
              bytes.length !== item.bytes || await digest(bytes) !== item.sha256
            ) {
              throw new Error(
                "Prepared image bytes changed; prepare a new approved batch",
              );
            }
          }
          if (batch.items.some((item) => item.status === "uncertain")) {
            throw new Error(
              "Uncertain upload intent; reconcile provider job with recoverUpload before retrying",
            );
          }
          const handles: Handle[] = [];
          for (let index = 0; index < batch.items.length; index++) {
            let item = batch.items[index];
            if (item.status === "complete" || item.status === "failed") {
              continue;
            }
            if (ctx.signal?.aborted) throw new Error("Batch cancelled");
            if (Date.parse(session.expiresAt!) <= Date.now() + 60_000) {
              throw new Error(
                "Access token expires soon; refresh before resuming this batch",
              );
            }
            if (item.status === "ready") {
              const bytes = await readImage(root, item.path);
              if (await digest(bytes) !== item.sha256) {
                throw new Error("Image changed before upload");
              }
              batch.items[index] = { ...item, status: "uncertain" };
              await ctx.writeResource(
                "batch",
                `batch-${args.requestId}`,
                batch,
              );
              const response = await request(ctx, "asset-uploads", {
                method: "POST",
                body: bytes as BodyInit,
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Asset-Upload-Metadata": JSON.stringify({
                    name_base64: btoa(
                      String.fromCharCode(
                        ...new TextEncoder().encode(item.name),
                      ),
                    ),
                  }),
                },
              }, session.accessToken);
              const { job } = jobSchema.parse(await response.json());
              item = { ...item, status: "submitted", jobId: job.id };
              batch.items[index] = item;
              handles.push(
                await ctx.writeResource(
                  "batch",
                  `batch-${args.requestId}`,
                  batch,
                ),
              );
              // 30 uploads/minute; conservative pacing also applies before the next GET.
              await pause(2100);
            }
            batch.items[index] = await observe(ctx, session, item);
            handles.push(
              await ctx.writeResource(
                "batch",
                `batch-${args.requestId}`,
                batch,
              ),
            );
          }
          ctx.logger.info("Recorded Canva batch progress", {
            complete: batch.items.filter((item) =>
              item.status === "complete"
            ).length,
          });
          return { dataHandles: handles };
        },
      },
      recoverUpload: {
        description:
          "Bind a manually verified provider job to an uncertain upload; reads the job, never submits another upload",
        arguments: z.object({
          requestId: key,
          index: z.number().int().nonnegative(),
          jobId: id,
          confirmJobBelongsToIntent: z.literal(true),
        }),
        execute: async (
          args: {
            requestId: string;
            index: number;
            jobId: string;
            confirmJobBelongsToIntent: true;
          },
          ctx: Context,
        ) => {
          if (args.confirmJobBelongsToIntent !== true) {
            throw new Error("Manual job/intent verification is required");
          }
          ctx.logger.info("Reconciling uncertain Canva upload");
          const session = await auth(ctx, ["asset:read"]);
          const batch = batchSchema.parse(
            await ctx.readResource(`batch-${args.requestId}`),
          );
          connection(batch.connectionId, session);
          const item = batch.items[args.index];
          if (!item || item.status !== "uncertain") {
            throw new Error("Only uncertain intents can be recovered");
          }
          batch.items[args.index] = await observe(ctx, session, {
            ...item,
            status: "submitted",
            jobId: args.jobId,
          });
          const handle = await ctx.writeResource(
            "batch",
            `batch-${args.requestId}`,
            batch,
          );
          ctx.logger.info("Reconciled Canva upload job");
          return { dataHandles: [handle] };
        },
      },
      createFolder: {
        description:
          "Create one confirmed folder under a stable requestId; refuse ambiguous creation retries",
        arguments: z.object({
          requestId: key,
          name: z.string().min(1).max(255),
          parentId: id.default("root"),
          confirmCreate: z.literal(true),
        }),
        execute: async (
          args: {
            requestId: string;
            name: string;
            parentId: string;
            confirmCreate: true;
          },
          ctx: Context,
        ) => {
          if (args.confirmCreate !== true) {
            throw new Error("Explicit confirmCreate is required");
          }
          ctx.logger.info("Creating Canva folder");
          const session = await auth(ctx, ["folder:write"]);
          const name = `folder-${args.requestId}`;
          const previous = await ctx.readResource(name);
          if (previous) {
            const value = folderSchema.parse(previous);
            connection(value.connectionId, session);
            if (value.name !== args.name || value.parentId !== args.parentId) {
              throw new Error(
                "Folder requestId already binds different inputs",
              );
            }
            if (value.status !== "complete") {
              throw new Error(
                "Uncertain folder creation; inspect Canva before creating anything else",
              );
            }
            return { dataHandles: [] };
          }
          const intent = folderSchema.parse({
            requestId: args.requestId,
            connectionId: session.connectionId,
            name: args.name,
            parentId: args.parentId,
            status: "uncertain",
          });
          await ctx.writeResource("folder", name, intent);
          const response = await request(ctx, "folders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: args.name,
              parent_folder_id: args.parentId,
            }),
          }, session.accessToken);
          const result = z.object({
            folder: z.object({ id, name: z.string() }),
          }).parse(await response.json());
          if (result.folder.name !== args.name) {
            throw new Error("Created folder name does not match intent");
          }
          const handle = await ctx.writeResource("folder", name, {
            ...intent,
            status: "complete",
            folderId: result.folder.id,
          });
          ctx.logger.info("Created Canva folder");
          return { dataHandles: [handle] };
        },
      },
      listFolderItems: {
        description:
          "Read one image/folder page; continuation and truncated indicate remaining items",
        arguments: z.object({
          folderId: id,
          continuation: z.string().optional(),
        }),
        execute: async (
          args: { folderId: string; continuation?: string },
          ctx: Context,
        ) => {
          ctx.logger.info("Reading Canva folder page");
          const session = await auth(ctx, ["folder:read"]);
          const value = await page(
            ctx,
            session,
            args.folderId,
            args.continuation,
          );
          const handle = await ctx.writeResource(
            "page",
            `page-${args.folderId}`,
            value,
          );
          ctx.logger.info("Read Canva folder page", {
            count: value.items.length,
            truncated: value.truncated,
          });
          return { dataHandles: [handle] };
        },
      },
      moveItem: {
        description:
          "Move an image/folder with persisted intent; reconcile membership before repeating an uncertain move",
        arguments: z.object({
          requestId: key,
          itemId: id,
          folderId: id,
          confirmMove: z.literal(true),
        }),
        execute: async (
          args: {
            requestId: string;
            itemId: string;
            folderId: string;
            confirmMove: true;
          },
          ctx: Context,
        ) => {
          if (args.confirmMove !== true) {
            throw new Error("Explicit confirmMove is required");
          }
          ctx.logger.info("Organizing Canva item");
          const session = await auth(ctx, ["folder:read", "folder:write"]);
          const name = `move-${args.requestId}`;
          const previous = await ctx.readResource(name);
          const intent = moveSchema.parse({
            requestId: args.requestId,
            connectionId: session.connectionId,
            itemId: args.itemId,
            folderId: args.folderId,
            status: "uncertain",
          });
          if (previous) {
            const value = moveSchema.parse(previous);
            connection(value.connectionId, session);
            if (
              value.itemId !== args.itemId || value.folderId !== args.folderId
            ) throw new Error("Move requestId already binds different inputs");
            if (value.status === "complete") return { dataHandles: [] };
            let continuation: string | undefined;
            for (let count = 0; count < 20; count++) {
              const result = await page(
                ctx,
                session,
                args.folderId,
                continuation,
              );
              if (result.items.some((item) => item.id === args.itemId)) {
                const handle = await ctx.writeResource("move", name, {
                  ...intent,
                  status: "complete",
                });
                return { dataHandles: [handle] };
              }
              continuation = result.continuation;
              if (!continuation) break;
            }
            throw new Error(
              "Uncertain move not confirmed in bounded folder scan; inspect Canva; no POST retried",
            );
          }
          await ctx.writeResource("move", name, intent);
          const response = await request(ctx, "folders/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to_folder_id: args.folderId,
              item_id: args.itemId,
            }),
          }, session.accessToken);
          await response.body?.cancel();
          const handle = await ctx.writeResource("move", name, {
            ...intent,
            status: "complete",
          });
          ctx.logger.info("Organized Canva item");
          return { dataHandles: [handle] };
        },
      },
    },
  };
}

/** Production model; credentials and pending PKCE/token material are vault-sensitive. */
export const model = {
  ...createCanvaModel(),
  type: "@mgreten/canva",
};
