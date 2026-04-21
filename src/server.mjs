import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildFactionDecks } from "./lib/decks.mjs";
import { GameServer } from "./lib/game-server.mjs";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  const rootDir = process.cwd();
  const decks = await buildFactionDecks(rootDir);
  const gameServer = new GameServer(decks);
  const scriptedTest = gameServer.createScriptedTestGame();
  const server = createServer((request, response) => {
    handleRequest(rootDir, gameServer, scriptedTest, request, response).catch((error) => {
      const status = error.status || 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message || "Internal server error" }));
    });
  });

  server.listen(PORT, () => {
    console.log(`Game server listening on http://localhost:${PORT}`);
  });
}

async function handleRequest(rootDir, gameServer, scriptedTest, request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/") {
    return serveFile(path.join(rootDir, "web", "index.html"), "text/html", response);
  }

  if (request.method === "GET" && url.pathname === "/app.js") {
    return serveFile(path.join(rootDir, "web", "app.js"), "text/javascript", response);
  }

  if (request.method === "GET" && url.pathname === "/styles.css") {
    return serveFile(path.join(rootDir, "web", "styles.css"), "text/css", response);
  }

  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    return serveWorkspaceFile(rootDir, url.pathname, response);
  }

  if (request.method === "GET" && url.pathname.startsWith("/output/")) {
    return serveWorkspaceFile(rootDir, url.pathname, response);
  }

  if (request.method === "GET" && url.pathname === "/api/decks") {
    return json(response, { decks: gameServer.listDecks() });
  }

  if (request.method === "GET" && url.pathname === "/api/test-game") {
    return json(response, {
      testGame: {
        gameId: scriptedTest.gameId,
        hostPath: `/?game=${scriptedTest.gameId}&player=${scriptedTest.hostPlayerId}`,
        guestPath: `/?game=${scriptedTest.gameId}&player=${scriptedTest.guestPlayerId}`
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/games") {
    return json(response, gameServer.createGame(), 201);
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/join$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.joinGame(gameId, body.guestToken));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/choose-deck$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.chooseDeck(gameId, body.playerId, body.deckId));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/start$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.startGame(gameId, body.playerId));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/play-card$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.playCard(gameId, body.playerId, body.instanceId, body.zone));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/draw-card$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.drawCard(gameId, body.playerId));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/move-card$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.moveBoardCard(gameId, body.playerId, body.instanceId, body.zone));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/flip-card$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.flipCardFaceUp(gameId, body.playerId, body.instanceId));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/play-from-graveyard$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.playFromGraveyard(gameId, body.playerId, body.instanceId, body.zone));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/use-ability$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.useCardAbility(gameId, body.playerId, body.sourceId, body));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/attack$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.attack(gameId, body.playerId, body));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/resolve-effect$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.resolvePendingEffect(gameId, body.playerId, body.choiceId ?? null));
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/respond-attack$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(
      response,
      gameServer.respondToPendingAttack(gameId, body.playerId, body.defendingReinforcerId ?? null, body.redirectTargetId ?? null)
    );
  }

  if (request.method === "POST" && url.pathname.match(/^\/api\/games\/[^/]+\/end-turn$/)) {
    const gameId = url.pathname.split("/")[3];
    const body = await readJsonBody(request);
    return json(response, gameServer.endTurn(gameId, body.playerId));
  }

  if (request.method === "GET" && url.pathname.match(/^\/api\/games\/[^/]+$/)) {
    const gameId = url.pathname.split("/")[3];
    const playerId = url.searchParams.get("player");
    return json(response, gameServer.getView(gameId, playerId));
  }

  throw Object.assign(new Error("Not found"), { status: 404 });
}

async function serveWorkspaceFile(rootDir, pathname, response) {
  const safePath = path.join(rootDir, pathname.slice(1));
  const contentType = guessContentType(safePath);
  return serveFile(safePath, contentType, response);
}

async function serveFile(filePath, contentType, response) {
  const file = await readFile(filePath);
  response.writeHead(200, { "content-type": contentType });
  response.end(file);
}

function json(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function guessContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
