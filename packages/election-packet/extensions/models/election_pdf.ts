/** Local PDF export of the neutral compiler's HTML. No arbitrary HTML or voter profiles. */
import { dirname, isAbsolute, join } from "node:path";
import { z } from "npm:zod@4.1.12";
import { Packet, renderPacket } from "./election_packet.ts";

const Globals = z.object({ outputRoot: z.string().refine(isAbsolute) })
  .strict();
const Args = z.object({
  // Swamp merges declared globals into method inputs before validation.
  outputRoot: z.string().refine(isAbsolute).optional(),
  packet: Packet,
  outputStem: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 /-]*$/).refine((s) =>
    s.split("/").every((p) => p.length > 0 && p.trim() === p)
  ),
}).strict();
type Context = {
  globalArgs: z.infer<typeof Globals>;
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};
const Receipt = z.object({
  files: z.array(z.string()),
  renderer: z.literal("WeasyPrint 68.0"),
});

export const model = {
  type: "@mgreten/election-pdf",
  version: "2026.11.02.1",
  globalArguments: Globals,
  resources: {
    receipt: {
      description: "Local PDF paths, not evidence of sharing or delivery",
      schema: Receipt,
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    export: {
      description:
        "Render reviewed evidence into concise and appendix PDFs using pinned WeasyPrint via uvx; refuse overwrites and symlink descendants",
      arguments: Args,
      execute: async (input: z.infer<typeof Args>, ctx: Context) => {
        const args = Args.parse(input);
        const doc = renderPacket(args.packet);
        const root = await Deno.realPath(
          Globals.parse(ctx.globalArgs).outputRoot,
        );
        const paths = [
          join(root, `${args.outputStem}.pdf`),
          join(root, `${args.outputStem} - Evidence.pdf`),
        ];
        const parentParts = args.outputStem.split("/").slice(0, -1);
        let parent = root;
        for (const part of parentParts) {
          parent = join(parent, part);
          const info = await Deno.lstat(parent);
          if (!info.isDirectory || info.isSymlink) {
            throw new Error(
              "Output parents must be existing directories without symlinks",
            );
          }
        }
        for (const path of paths) {
          try {
            await Deno.lstat(path);
          } catch (e) {
            if (e instanceof Deno.errors.NotFound) continue;
            throw e;
          }
          throw new Error(`Refusing to overwrite ${path}`);
        }
        const bytes: Uint8Array[] = [];
        for (const text of [doc.html, doc.appendixHtml]) {
          const child = new Deno.Command("uvx", {
            args: [
              "--from",
              "weasyprint==68.0",
              "weasyprint",
              "--encoding",
              "utf-8",
              "-",
              "-",
            ],
            cwd: dirname(paths[0]),
            signal: ctx.signal,
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
          }).spawn();
          const result = child.output();
          const writer = child.stdin.getWriter();
          await writer.write(new TextEncoder().encode(text));
          await writer.close();
          const output = await result;
          if (
            !output.success ||
            new TextDecoder().decode(output.stdout.slice(0, 5)) !== "%PDF-"
          ) {
            throw new Error(
              `PDF export failed: ${new TextDecoder().decode(output.stderr)}`,
            );
          }
          bytes.push(output.stdout);
        }
        // All rendering finishes before creating destination files. Never replace an existing file.
        const created: string[] = [];
        try {
          for (let i = 0; i < paths.length; i++) {
            const file = await Deno.open(paths[i], {
              createNew: true,
              write: true,
              mode: 0o664,
            });
            created.push(paths[i]);
            try {
              let offset = 0;
              while (offset < bytes[i].length) {
                offset += await file.write(bytes[i].subarray(offset));
              }
              await file.sync();
            } finally {
              file.close();
            }
          }
        } catch (e) {
          for (const path of created) await Deno.remove(path);
          throw e;
        }
        return {
          dataHandles: [
            await ctx.writeResource("receipt", "receipt", {
              files: paths,
              renderer: "WeasyPrint 68.0",
            }),
          ],
        };
      },
    },
  },
};
