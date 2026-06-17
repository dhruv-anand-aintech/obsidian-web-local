import Fastify from "fastify";
import cors from "@fastify/cors";
import { execFile } from "node:child_process";
import type { ExtensionActionRequest, OpenResourceRequest, UpdateNoteRequest } from "@obsidian-web-local/shared";
import { runExtensionAction } from "./extension-host.js";
import { buildPluginHostStatus } from "./plugin-host.js";
import { getNoteDetail, getVaultDetail, listVaults, updateNoteDetail } from "./vault-service.js";

const server = Fastify({
  logger: true
});

function openWithPlatform(target: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", target] : [target];

  return new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

server.register(cors, {
  origin: [/^http:\/\/127\.0\.0\.1:5173$/, /^http:\/\/127\.0\.0\.1:5174$/, /^http:\/\/127\.0\.0\.1:4173$/]
});

server.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.status(500).send({
    error: error instanceof Error ? error.message : "Unexpected helper error"
  });
});

server.get("/api/health", async () => ({
  ok: true
}));

server.get("/api/plugin-host", async () => buildPluginHostStatus());

server.get("/api/vaults", async () => ({
  vaults: await listVaults()
}));

server.get<{ Params: { vaultId: string } }>("/api/vaults/:vaultId", async (request, reply) => {
  const vault = await getVaultDetail(request.params.vaultId);

  if (!vault) {
    reply.status(404);
    return { error: "Vault not found" };
  }

  return vault;
});

server.get<{ Params: { vaultId: string }; Querystring: { path?: string } }>(
  "/api/vaults/:vaultId/note",
  async (request, reply) => {
    const notePath = request.query.path;

    if (!notePath) {
      reply.status(400);
      return { error: "Missing note path" };
    }

    const note = await getNoteDetail(request.params.vaultId, notePath);

    if (!note) {
      reply.status(404);
      return { error: "Note not found" };
    }

    return note;
  }
);

server.put<{ Params: { vaultId: string }; Body: UpdateNoteRequest }>(
  "/api/vaults/:vaultId/note",
  async (request, reply) => {
    const notePath = request.body?.path;
    const content = request.body?.content;

    if (!notePath || typeof content !== "string") {
      reply.status(400);
      return { error: "Missing note path or content" };
    }

    const result = await updateNoteDetail(request.params.vaultId, notePath, content);
    if (!result) {
      reply.status(404);
      return { error: "Note not found" };
    }

    return result;
  }
);

server.post<{ Params: { vaultId: string }; Body: ExtensionActionRequest }>(
  "/api/vaults/:vaultId/extension-action",
  async (request, reply) => {
    if (!request.body?.pluginId || !request.body?.actionId) {
      reply.status(400);
      return { error: "Missing plugin action payload" };
    }

    const vault = await getVaultDetail(request.params.vaultId);
    if (!vault) {
      reply.status(404);
      return { error: "Vault not found" };
    }

    return runExtensionAction(vault.path, vault.pluginManifests, request.body);
  }
);

server.post<{ Body: OpenResourceRequest }>("/api/open-resource", async (request, reply) => {
  const target = request.body?.target;
  const kind = request.body?.kind;

  if (!target || (kind !== "url" && kind !== "path")) {
    reply.status(400);
    return { error: "Missing or invalid open target" };
  }

  await openWithPlatform(target);

  return { ok: true };
});

async function start() {
  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: Number(process.env.OBSIDIAN_WEB_LOCAL_PORT ?? "3001")
    });
    server.log.info(`helper listening at ${address}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

void start();
