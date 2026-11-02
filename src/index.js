import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 80;
const VALID_ROBES = new Set(["blue", "brown", "white", "yellow"]);

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({ status: "ok", provider: "cloudflare-durable-objects" });
		}

		if (url.pathname !== "/ws") {
			return new Response("Use /ws for the room connection or /health for status.", { status: 404 });
		}

		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("WebSocket upgrade required", { status: 426 });
		}

		const room = url.searchParams.get("room") || "default";
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
			return new Response("Invalid room", { status: 400 });
		}

		const roomId = env.GAME_ROOMS.idFromName(room);
		return env.GAME_ROOMS.get(roomId).fetch(request);
	}
};

export class GameRoom extends DurableObject {
	async fetch(request) {
		const url = new URL(request.url);
		const player = {
			id: safeText(url.searchParams.get("id"), 64) || crypto.randomUUID(),
			name: safeText(url.searchParams.get("name"), 25) || "Phật tử",
			robe: VALID_ROBES.has(url.searchParams.get("robe")) ? url.searchParams.get("robe") : "blue",
			x: safeNumber(url.searchParams.get("x"), 0, -50, 50),
			y: safeNumber(url.searchParams.get("y"), 0, -1, 20),
			z: safeNumber(url.searchParams.get("z"), 25.5, -50, 50),
			rotY: safeNumber(url.searchParams.get("rotY"), Math.PI, -100, 100),
			action: "idle"
		};

		const currentPlayers = this.ctx.getWebSockets()
			.map(socket => socket.deserializeAttachment())
			.filter(existing => existing && existing.id !== player.id);
		if (currentPlayers.length >= MAX_PLAYERS_PER_ROOM) {
			return new Response("Room is full", { status: 429 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(player);

		server.send(JSON.stringify({ type: "cf_welcome", players: currentPlayers }));
		this.broadcast({ type: "cf_player_joined", player }, server);

		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(socket, message) {
		if (typeof message !== "string") return;

		let update;
		try {
			update = JSON.parse(message);
		} catch {
			return;
		}
		if (update.type !== "move") return;

		const player = socket.deserializeAttachment();
		if (!player) return;
		player.x = safeNumber(update.x, player.x, -50, 50);
		player.y = safeNumber(update.y, player.y, -1, 20);
		player.z = safeNumber(update.z, player.z, -50, 50);
		player.rotY = safeNumber(update.rotY, player.rotY, -100, 100);
		player.action = safeText(update.action, 32) || "idle";
		socket.serializeAttachment(player);

		this.broadcast({ type: "cf_player_moved", ...player }, socket);
	}

	webSocketClose(socket) {
		const player = socket.deserializeAttachment();
		if (player) this.broadcast({ type: "cf_player_left", id: player.id });
	}

	webSocketError(socket) {
		const player = socket.deserializeAttachment();
		if (player) this.broadcast({ type: "cf_player_left", id: player.id });
	}

	broadcast(message, excludedSocket = null) {
		const payload = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === excludedSocket) continue;
			try {
				socket.send(payload);
			} catch {
				socket.close(1011, "Realtime delivery failed");
			}
		}
	}
}

function safeText(value, maxLength) {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeNumber(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
