#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDist = join(repoRoot, "apps", "web", "dist");
const helperEntry = join(repoRoot, "apps", "helper", "dist", "index.js");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);

function usage() {
  return `Usage: obsidian-web-local [options]

Options:
  --open / --no-open          Open the browser client after startup (default: --open)
  --port <port>               Web client port (default: 38200)
  --helper-port <port>        Helper API port (default: 38201)
  --host <host>               Bind host (default: 127.0.0.1)
  --vault-roots <paths>       Vault roots separated by the OS path delimiter
  --help                      Show this help

Examples:
  obsidian-web-local --vault-roots "$HOME/Documents/Obsidian/MyVault"
  obsidian-web-local --no-open --port 4000 --helper-port 4001
`;
}

function parseArgs(argv) {
  const options = {
    open: true,
    host: process.env.OBSIDIAN_WEB_LOCAL_HOST || "127.0.0.1",
    port: Number(process.env.OBSIDIAN_WEB_LOCAL_WEB_PORT || 38200),
    helperPort: Number(process.env.OBSIDIAN_WEB_LOCAL_PORT || 38201),
    vaultRoots: process.env.OBS_VAULT_ROOTS || ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--open":
        options.open = true;
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--port":
        options.port = Number(next);
        index += 1;
        break;
      case "--helper-port":
        options.helperPort = Number(next);
        index += 1;
        break;
      case "--host":
        options.host = next || options.host;
        index += 1;
        break;
      case "--vault-roots":
        options.vaultRoots = next || "";
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive integer");
  }

  if (!Number.isInteger(options.helperPort) || options.helperPort <= 0) {
    throw new Error("--helper-port must be a positive integer");
  }

  return options;
}

function ensureBuilt() {
  const missing = [];
  if (!existsSync(webDist)) missing.push("apps/web/dist");
  if (!existsSync(helperEntry)) missing.push("apps/helper/dist/index.js");

  if (missing.length) {
    throw new Error(`Missing built assets: ${missing.join(", ")}. Run npm run build first.`);
  }
}

function openWithPlatform(target) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(text);
}

function proxyApi(request, response, helperPort) {
  const proxy = httpRequest(
    {
      host: "127.0.0.1",
      port: helperPort,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${helperPort}`
      }
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    }
  );

  proxy.on("error", (error) => {
    sendText(response, 502, `Helper API unavailable: ${error.message}`);
  });

  request.pipe(proxy);
}

function staticPathForUrl(url) {
  const pathname = decodeURIComponent(new URL(url || "/", "http://127.0.0.1").pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const relative = normalized === sep ? "index.html" : normalized.replace(/^[/\\]/, "");
  const candidate = resolve(webDist, relative);
  const distRoot = resolve(webDist);

  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
    return null;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  if (extname(candidate)) {
    return null;
  }

  return join(webDist, "index.html");
}

function serveStatic(request, response) {
  const filePath = staticPathForUrl(request.url);
  if (!filePath) {
    sendText(response, 404, "Not found");
    return;
  }

  const extension = extname(filePath);
  response.writeHead(200, {
    "content-type": mimeTypes.get(extension) || "application/octet-stream",
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  createReadStream(filePath).pipe(response);
}

function waitForHelper(port, timeoutMs = 10000) {
  const startedAt = Date.now();

  return new Promise((resolveReady, rejectReady) => {
    const poll = () => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/health",
          timeout: 1000
        },
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            resolveReady();
            return;
          }
          retry();
        }
      );

      request.on("error", retry);
      request.on("timeout", () => {
        request.destroy();
        retry();
      });
      request.end();
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        rejectReady(new Error(`Helper did not become ready on port ${port}`));
        return;
      }
      setTimeout(poll, 250);
    };

    poll();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureBuilt();

  const helper = spawn(process.execPath, [helperEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      OBSIDIAN_WEB_LOCAL_PORT: String(options.helperPort),
      OBSIDIAN_WEB_LOCAL_WEB_PORT: String(options.port),
      ...(options.vaultRoots ? { OBS_VAULT_ROOTS: options.vaultRoots } : {})
    }
  });

  const stop = () => {
    if (!helper.killed) {
      helper.kill();
    }
  };

  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(143);
  });
  process.on("exit", stop);

  helper.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`Helper exited unexpectedly: ${signal || code}`);
      process.exit(code || 1);
    }
  });

  await waitForHelper(options.helperPort);

  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      proxyApi(request, response, options.helperPort);
      return;
    }

    if (request.url === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "public, max-age=86400" });
      response.end();
      return;
    }

    serveStatic(request, response);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, resolveListen);
  });

  const url = `http://${options.host}:${options.port}/`;
  console.log(`Obsidian Web Local: ${url}`);
  console.log(`Helper API: http://127.0.0.1:${options.helperPort}/api/health`);

  if (options.open) {
    openWithPlatform(url);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
