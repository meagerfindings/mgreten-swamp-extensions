import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.14";
import { createCanvaModel, model } from "./canva.ts";

type Context = Parameters<typeof model.methods.beginAuthorization.execute>[1];
const scopes = [
  "asset:read",
  "asset:write",
  "folder:read",
  "folder:write",
] as const;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

function fixture() {
  const store = new Map<string, Record<string, unknown>>();
  const writes: {
    spec: string;
    name: string;
    value: Record<string, unknown>;
  }[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: {
      clientId: "EXAMPLE-CLIENT",
      clientSecret: "fake-secret",
      redirectUri: "https://example.com/callback",
      assetRoot: ".",
    },
    repoDir: "/unused",
    logger: {
      info: (message, values) => logs.push(JSON.stringify({ message, values })),
    },
    readResource: (name) =>
      Promise.resolve(structuredClone(store.get(name) ?? null)),
    writeResource: (spec, name, value) => {
      const schema =
        model.resources[spec as keyof typeof model.resources].schema;
      const parsed = schema.parse(value);
      assertEquals(
        Object.keys(parsed).sort(),
        Object.keys(value).filter((k) => value[k] !== undefined).sort(),
      );
      store.set(name, structuredClone(parsed));
      writes.push({ spec, name, value: structuredClone(parsed) });
      return Promise.resolve({ name });
    },
  };
  const ready = () =>
    store.set("oauth-session", {
      connectionId: "11111111-1111-4111-8111-111111111111",
      clientId: ctx.globalArgs.clientId,
      redirectUri: ctx.globalArgs.redirectUri,
      status: "ready",
      scopes: [...scopes],
      state: "fake-state",
      verifier: "fake-verifier",
      createdAt: new Date().toISOString(),
      authorizationUrl: "https://example.com/authorize",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  return { ctx, store, writes, logs, ready };
}

async function images(
  action: (f: ReturnType<typeof fixture>) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  const f = fixture();
  f.ctx.repoDir = root;
  f.ready();
  try {
    await Deno.writeFile(`${root}/logo.png`, png);
    await Deno.writeFile(
      `${root}/photo.jpg`,
      new Uint8Array([255, 216, 255, 2]),
    );
    await action(f);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function prepare(
  m: ReturnType<typeof createCanvaModel>,
  ctx: Context,
  two = false,
) {
  await m.methods.prepareUploads.execute({
    requestId: "kit-v1",
    files: [
      { path: "logo.png", name: "Logo é" },
      ...(two ? [{ path: "photo.jpg", name: "Photo" }] : []),
    ],
  }, ctx);
}

Deno.test("PKCE challenge is independently derived; secret schema and logs are safe", async () => {
  const f = fixture();
  const m = createCanvaModel(() => {
    throw new Error("unexpected network");
  });
  await m.methods.beginAuthorization.execute({ scopes: [...scopes] }, f.ctx);
  const session = f.store.get("oauth-session")!;
  const url = new URL(String(session.authorizationUrl));
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(session.verifier)),
    ),
  );
  const expected = btoa(String.fromCharCode(...hash)).replaceAll("+", "-")
    .replaceAll("/", "_").replaceAll("=", "");
  assertEquals(
    url.origin + url.pathname,
    "https://www.canva.com/api/oauth/authorize",
  );
  assertEquals(url.searchParams.get("code_challenge"), expected);
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("state"), session.state);
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "https://example.com/callback",
  );
  for (
    const name of ["verifier", "state", "accessToken", "refreshToken"] as const
  ) {
    assertEquals(
      model.resources.auth.schema.shape[name].meta()?.sensitive,
      true,
    );
  }
  assertEquals(f.logs.join().includes(String(session.verifier)), false);
  assertEquals(f.logs.join().includes("fake-secret"), false);
  assertThrows(() =>
    model.globalArguments.parse({
      ...f.ctx.globalArgs,
      redirectUri: "http://example.com/callback",
    })
  );
});

Deno.test("OAuth exchanges exact form with pre-effect state and rejects callback replay", async () => {
  const f = fixture();
  const m = createCanvaModel((url, init) => {
    assertEquals(String(url), "https://api.canva.com/rest/v1/oauth/token");
    assertEquals(f.store.get("oauth-session")!.status, "exchanging");
    assertEquals(init?.redirect, "error");
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      `Basic ${btoa("EXAMPLE-CLIENT:fake-secret")}`,
    );
    const form = new URLSearchParams(String(init?.body));
    assertEquals(form.get("grant_type"), "authorization_code");
    assertEquals(
      form.get("code_verifier"),
      f.store.get("oauth-session")!.verifier,
    );
    assertEquals(form.get("redirect_uri"), f.ctx.globalArgs.redirectUri);
    assertEquals(form.get("code"), "fake-code");
    return Promise.resolve(
      json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
  });
  await m.methods.beginAuthorization.execute({ scopes: [...scopes] }, f.ctx);
  const callback = `https://example.com/callback?code=fake-code&state=${
    f.store.get("oauth-session")!.state
  }`;
  await m.methods.completeAuthorization.execute(
    { callbackUrl: callback },
    f.ctx,
  );
  assertEquals(f.store.get("oauth-session")!.status, "ready");
  assertEquals(f.store.get("oauth-session")!.accessToken, "new-access");
  await assertRejects(
    () =>
      m.methods.completeAuthorization.execute({ callbackUrl: callback }, f.ctx),
    Error,
    "consumed",
  );
});

Deno.test("wrong state, callback origin/path, duplicate code, credentials and expired sessions never reach token API", async () => {
  const f = fixture();
  const m = createCanvaModel(() => {
    throw new Error("network must not run");
  });
  await m.methods.beginAuthorization.execute({ scopes: [...scopes] }, f.ctx);
  const state = f.store.get("oauth-session")!.state;
  for (
    const url of [
      `https://example.com/callback?code=x&state=WRONG`,
      `https://attacker.example/callback?code=x&state=${state}`,
      `https://example.com/other?code=x&state=${state}`,
      `https://example.com/callback?code=x&code=y&state=${state}`,
      `https://user:pass@example.com/callback?code=x&state=${state}`,
    ]
  ) {
    await assertRejects(
      () =>
        m.methods.completeAuthorization.execute({ callbackUrl: url }, f.ctx),
      Error,
      "Invalid/expired",
    );
  }
  f.store.get("oauth-session")!.createdAt = new Date(Date.now() - 601_000)
    .toISOString();
  await assertRejects(
    () =>
      m.methods.completeAuthorization.execute({
        callbackUrl: `https://example.com/callback?code=x&state=${state}`,
      }, f.ctx),
    Error,
    "Invalid/expired",
  );
});

Deno.test("refresh persists replacement tokens and a failed refresh cannot be blindly repeated", async () => {
  const f = fixture();
  f.ready();
  let calls = 0;
  const m = createCanvaModel((_url, init) => {
    calls++;
    assertEquals(f.store.get("oauth-session")!.status, "refreshing");
    assertEquals(
      new URLSearchParams(String(init?.body)).get("refresh_token"),
      "fake-refresh",
    );
    return Promise.resolve(
      json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "bearer",
        expires_in: 3600,
      }),
    );
  });
  await m.methods.refreshAuthorization.execute({}, f.ctx);
  assertEquals(f.store.get("oauth-session")!.refreshToken, "rotated-refresh");
  assertEquals(
    f.store.get("oauth-session")!.connectionId,
    "11111111-1111-4111-8111-111111111111",
  );
  const fail = createCanvaModel(() => {
    calls++;
    return Promise.reject(new Error("fake transport secret"));
  });
  await assertRejects(
    () => fail.methods.refreshAuthorization.execute({}, f.ctx),
    Error,
    "interrupted",
  );
  await assertRejects(
    () => fail.methods.refreshAuthorization.execute({}, f.ctx),
    Error,
    "reauthorize",
  );
  assertEquals(calls, 2);
});

Deno.test("all image paths preflight before writes; traversal/symlinks/SVG and duplicates are rejected", async () => {
  await images(async (f) => {
    const m = createCanvaModel();
    await Deno.writeTextFile(`${f.ctx.repoDir}/logo.svg`, "<svg/>");
    await assertRejects(
      () =>
        m.methods.prepareUploads.execute({
          requestId: "bad",
          files: [{ path: "logo.svg", name: "Bad" }],
        }, f.ctx),
      Error,
      "PNG/JPEG",
    );
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeFile(`${outside}/outside.png`, png);
      await Deno.symlink(
        `${outside}/outside.png`,
        `${f.ctx.repoDir}/escape.png`,
      );
      await assertRejects(
        () =>
          m.methods.prepareUploads.execute({
            requestId: "bad",
            files: [{ path: "escape.png", name: "Bad" }],
          }, f.ctx),
        Error,
        "escapes",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
    await assertRejects(
      () =>
        m.methods.prepareUploads.execute({
          requestId: "bad",
          files: [{ path: `${f.ctx.repoDir}/logo.png`, name: "Bad" }],
        }, f.ctx),
      Error,
      "relative",
    );
    await assertRejects(
      () =>
        m.methods.prepareUploads.execute({
          requestId: "bad",
          files: [{ path: "logo.png", name: "One" }, {
            path: "logo.png",
            name: "Two",
          }],
        }, f.ctx),
      Error,
      "Duplicate",
    );
    assertEquals(f.writes.length, 0);
  });
});

Deno.test("frozen manifest reprepare preserves progress and rejects changed names", async () => {
  await images(async (f) => {
    const m = createCanvaModel();
    await prepare(m, f.ctx);
    await prepare(m, f.ctx);
    assertEquals(f.writes.length, 1);
    await assertRejects(
      () =>
        m.methods.prepareUploads.execute({
          requestId: "kit-v1",
          files: [{ path: "logo.png", name: "Renamed" }],
        }, f.ctx),
      Error,
      "different manifest",
    );
  });
});

Deno.test("uploads bytes with UTF-8 metadata after durable intent, saves IDs, and doesn't duplicate completed uploads", async () => {
  await images(async (f) => {
    const pauses: number[] = [];
    let posts = 0;
    const m = createCanvaModel((url, init) => {
      const batch = f.store.get("batch-kit-v1")!;
      const items = batch.items as { status: string }[];
      if (init?.method === "POST") {
        const index = posts++;
        assertEquals(items[index].status, "uncertain");
        const headers = new Headers(init.headers);
        assertEquals(headers.get("Content-Type"), "application/octet-stream");
        assertEquals(headers.get("Authorization"), "Bearer fake-access");
        if (index === 0) {
          assertEquals(new Uint8Array(init.body as Uint8Array), png);
          const encoded =
            JSON.parse(headers.get("Asset-Upload-Metadata")!).name_base64;
          assertEquals(
            new TextDecoder().decode(
              Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
            ),
            "Logo é",
          );
        }
        return Promise.resolve(
          json({ job: { id: `job-${index}`, status: "in_progress" } }),
        );
      }
      const index = String(url).endsWith("job-0") ? 0 : 1;
      return Promise.resolve(
        json({
          job: {
            id: `job-${index}`,
            status: "success",
            asset: { id: `asset-${index}`, type: "image" },
          },
        }),
      );
    }, (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });
    await prepare(m, f.ctx, true);
    await m.methods.uploadBatch.execute({
      requestId: "kit-v1",
      confirmUpload: true,
    }, f.ctx);
    const items = f.store.get("batch-kit-v1")!.items as {
      status: string;
      assetId: string;
    }[];
    assertEquals(items.map((i) => [i.status, i.assetId]), [[
      "complete",
      "asset-0",
    ], ["complete", "asset-1"]]);
    await m.methods.uploadBatch.execute({
      requestId: "kit-v1",
      confirmUpload: true,
    }, f.ctx);
    assertEquals(posts, 2);
    assertEquals(pauses, [2100, 2100]);
  });
});

Deno.test("known pending jobs resume with GET only and failed jobs remain explicit", async () => {
  await images(async (f) => {
    let posts = 0, reads = 0;
    const m = createCanvaModel((_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return Promise.resolve(
          json({ job: { id: "job-1", status: "in_progress" } }),
        );
      }
      reads++;
      return Promise.resolve(
        json({
          job: {
            id: "job-1",
            status: reads === 1 ? "in_progress" : "failed",
            ...(reads > 1 ? { error: { code: "import_failed" } } : {}),
          },
        }),
      );
    }, () => Promise.resolve());
    await prepare(m, f.ctx);
    await m.methods.uploadBatch.execute({
      requestId: "kit-v1",
      confirmUpload: true,
    }, f.ctx);
    await m.methods.uploadBatch.execute({
      requestId: "kit-v1",
      confirmUpload: true,
    }, f.ctx);
    await m.methods.uploadBatch.execute({
      requestId: "kit-v1",
      confirmUpload: true,
    }, f.ctx);
    assertEquals(posts, 1);
    assertEquals(reads, 2);
    const item =
      (f.store.get("batch-kit-v1")!.items as Record<string, unknown>[])[0];
    assertEquals(item.status, "failed");
    assertEquals(item.errorCode, "import_failed");
  });
});

Deno.test("lost upload response stays uncertain, retry is blocked, manual recovery never POSTs", async () => {
  await images(async (f) => {
    let calls = 0;
    const m = createCanvaModel(() => {
      calls++;
      throw new Error("lost response");
    }, () => Promise.resolve());
    await prepare(m, f.ctx);
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "interrupted",
    );
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "Uncertain",
    );
    assertEquals(calls, 1);
    const recovery = createCanvaModel((url, init) => {
      assertEquals(
        String(url),
        "https://api.canva.com/rest/v1/asset-uploads/recovered-job",
      );
      assertEquals(init?.method, undefined);
      return Promise.resolve(
        json({
          job: {
            id: "recovered-job",
            status: "success",
            asset: { id: "recovered-asset", type: "image" },
          },
        }),
      );
    });
    await recovery.methods.recoverUpload.execute({
      requestId: "kit-v1",
      index: 0,
      jobId: "recovered-job",
      confirmJobBelongsToIntent: true,
    }, f.ctx);
    assertEquals(
      (f.store.get("batch-kit-v1")!.items as Record<string, unknown>[])[0]
        .assetId,
      "recovered-asset",
    );
  });
});

Deno.test("failure to persist a known upload job cannot cause a duplicate POST", async () => {
  await images(async (f) => {
    let posts = 0;
    const m = createCanvaModel(() => {
      posts++;
      return Promise.resolve(
        json({ job: { id: "job-1", status: "in_progress" } }),
      );
    }, () => Promise.resolve());
    await prepare(m, f.ctx);
    const write = f.ctx.writeResource;
    f.ctx.writeResource = (spec, name, value) => {
      if (
        spec === "batch" &&
        (value.items as { status: string }[])[0].status === "submitted"
      ) throw new Error("disk failure");
      return write(spec, name, value);
    };
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "disk failure",
    );
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "Uncertain",
    );
    assertEquals(posts, 1);
  });
});

Deno.test("changed later files, OAuth connection and missing scopes stop before upload writes", async () => {
  await images(async (f) => {
    const m = createCanvaModel(() => {
      throw new Error("unexpected network");
    });
    await prepare(m, f.ctx, true);
    await Deno.writeFile(
      `${f.ctx.repoDir}/photo.jpg`,
      new Uint8Array([255, 216, 255, 3]),
    );
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "bytes changed",
    );
    f.store.get("oauth-session")!.connectionId =
      "22222222-2222-4222-8222-222222222222";
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "another OAuth",
    );
    f.store.get("oauth-session")!.scopes = ["folder:read"];
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "required",
    );
    assertEquals(f.writes.length, 1);
  });
});

Deno.test("HTTP 429 response never exposes body credentials or automatically retries", async () => {
  await images(async (f) => {
    let calls = 0;
    const m = createCanvaModel(() => {
      calls++;
      return Promise.resolve(
        new Response("fake-access", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
      );
    });
    await prepare(m, f.ctx);
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "HTTP 429",
    );
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "Uncertain",
    );
    assertEquals(calls, 1);
    assertEquals(f.logs.join().includes("fake-access"), false);
  });
});

Deno.test("folder create uses exact contract, is repeat-safe and rejects request-ID input changes", async () => {
  const f = fixture();
  f.ready();
  let posts = 0;
  const m = createCanvaModel((url, init) => {
    posts++;
    assertEquals(String(url), "https://api.canva.com/rest/v1/folders");
    assertEquals(f.store.get("folder-brand")!.status, "uncertain");
    assertEquals(JSON.parse(String(init?.body)), {
      name: "Brand assets",
      parent_folder_id: "root",
    });
    return Promise.resolve(
      json({ folder: { id: "folder-id", name: "Brand assets" } }),
    );
  });
  const input = {
    requestId: "brand",
    name: "Brand assets",
    parentId: "root",
    confirmCreate: true as const,
  };
  await m.methods.createFolder.execute(input, f.ctx);
  await m.methods.createFolder.execute(input, f.ctx);
  await assertRejects(
    () => m.methods.createFolder.execute({ ...input, name: "Other" }, f.ctx),
    Error,
    "different inputs",
  );
  assertEquals(posts, 1);
  assertEquals(f.store.get("folder-brand")!.folderId, "folder-id");
});

Deno.test("folder listing preserves pagination and filters only images/folders", async () => {
  const f = fixture();
  f.ready();
  const m = createCanvaModel((url) => {
    const u = new URL(String(url));
    assertEquals(u.searchParams.get("continuation"), "cursor+next");
    assertEquals(u.searchParams.get("item_types"), "folder,image");
    return Promise.resolve(
      json({
        items: [{
          type: "image",
          image: {
            id: "asset-1",
            name: "Logo",
            thumbnail: { url: "https://private.example/secret" },
          },
        }],
        continuation: "next-page",
      }),
    );
  });
  await m.methods.listFolderItems.execute({
    folderId: "folder-id",
    continuation: "cursor+next",
  }, f.ctx);
  assertEquals(f.store.get("page-folder-id"), {
    folderId: "folder-id",
    items: [{ type: "image", id: "asset-1", name: "Logo" }],
    continuation: "next-page",
    truncated: true,
  });
});

Deno.test("uncertain move is reconciled from destination pages without another POST", async () => {
  const f = fixture();
  f.ready();
  let posts = 0, reads = 0;
  const m = createCanvaModel((_url, init) => {
    if (init?.method === "POST") {
      posts++;
      assertEquals(JSON.parse(String(init.body)), {
        to_folder_id: "folder-id",
        item_id: "asset-1",
      });
      throw new Error("lost response");
    }
    reads++;
    return Promise.resolve(
      json({
        items: reads === 1
          ? []
          : [{ type: "image", image: { id: "asset-1", name: "Logo" } }],
        ...(reads === 1 ? { continuation: "next" } : {}),
      }),
    );
  });
  const args = {
    requestId: "logo",
    itemId: "asset-1",
    folderId: "folder-id",
    confirmMove: true as const,
  };
  await assertRejects(
    () => m.methods.moveItem.execute(args, f.ctx),
    Error,
    "interrupted",
  );
  await m.methods.moveItem.execute(args, f.ctx);
  await m.methods.moveItem.execute(args, f.ctx);
  assertEquals(posts, 1);
  assertEquals(reads, 2);
  assertEquals(f.store.get("move-logo")!.status, "complete");
});

Deno.test("invalid provider job ID doesn't manufacture a success receipt", async () => {
  await images(async (f) => {
    const m = createCanvaModel(
      (_url, init) =>
        Promise.resolve(json({
          job: init?.method === "POST"
            ? { id: "correct", status: "in_progress" }
            : {
              id: "wrong",
              status: "success",
              asset: { id: "wrong-asset", type: "image" },
            },
        })),
      () => Promise.resolve(),
    );
    await prepare(m, f.ctx);
    await assertRejects(
      () =>
        m.methods.uploadBatch.execute({
          requestId: "kit-v1",
          confirmUpload: true,
        }, f.ctx),
      Error,
      "different upload job",
    );
    const item =
      (f.store.get("batch-kit-v1")!.items as Record<string, unknown>[])[0];
    assertEquals(item.status, "submitted");
    assertEquals(item.assetId, undefined);
  });
});
