import { DurableObject } from "cloudflare:workers";

const MAX_USERS_PER_ROOM = 100;
const MAX_TEXT = 500;
const MAX_FRAME = 2048;
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") return Response.json({ status: "ok" });
		if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("WebSocket upgrade required", { status: 426 });
		}

		const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
		if (allowed.length && !allowed.includes(request.headers.get("Origin"))) {
			return new Response("Forbidden origin", { status: 403 });
		}

		const claims = await verifyToken(url.searchParams.get("token"), env.CHAT_SECRET);
		if (!claims) return new Response("Invalid or expired token", { status: 401 });

		// Danh tính chỉ lấy từ token đã ký, ghi đè mọi thứ client gửi lên
		const doUrl = new URL(request.url);
		doUrl.search = "";
		doUrl.searchParams.set("uid", String(claims.uid));
		doUrl.searchParams.set("name", String(claims.name || ""));
		doUrl.searchParams.set("room", claims.room);

		const stub = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(claims.room), { locationHint: "apac" });
		return stub.fetch(new Request(doUrl, request));
	}
};

export class ChatRoom extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		// Heartbeat: không đánh thức DO khi đang ngủ
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(request) {
		const url = new URL(request.url);
		const user = {
			uid: safeText(url.searchParams.get("uid"), 64),
			name: safeText(url.searchParams.get("name"), 50) || "Khách",
			room: safeText(url.searchParams.get("room"), 64),
			windowStart: 0,
			count: 0
		};
		if (!user.uid || !user.room) return new Response("Bad request", { status: 400 });

		if (this.onlineUsers(null, user.uid).size >= MAX_USERS_PER_ROOM) {
			return new Response("Room is full", { status: 429 });
		}

		// Một user chỉ giữ một kết nối: đóng kết nối cũ (tránh socket ma khi reconnect)
		for (const s of this.ctx.getWebSockets()) {
			if (s.deserializeAttachment()?.uid === user.uid) s.close(1000, "Replaced by new connection");
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(user);

		const users = [...this.onlineUsers().entries()].map(([uid, name]) => ({ uid, name }));
		server.send(JSON.stringify({ type: "welcome", users, online: users.length }));
		this.broadcast({ type: "presence", online: users.length });

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(socket, message) {
		if (typeof message !== "string" || message.length > MAX_FRAME) return;

		let data;
		try { data = JSON.parse(message); } catch { return; }
		if (!data || data.type !== "chat") return;

		const user = socket.deserializeAttachment();
		if (!user) return;

		const text = safeText(data.text, MAX_TEXT);
		if (!text) return;

		// Rate limit: tối đa RATE_MAX tin / RATE_WINDOW_MS
		const now = Date.now();
		if (now - user.windowStart > RATE_WINDOW_MS) {
			user.windowStart = now;
			user.count = 0;
		}
		user.count++;
		socket.serializeAttachment(user);
		if (user.count > RATE_MAX) {
			socket.send(JSON.stringify({ type: "error", code: "rate_limited" }));
			return;
		}

		const msg = { type: "message", id: crypto.randomUUID(), uid: user.uid, name: user.name, text, ts: now };
		this.broadcast(msg);
		await this.persist(msg, user.room);
	}

	webSocketClose(socket) { this.handleLeave(socket); }
	webSocketError(socket) { this.handleLeave(socket); }

	handleLeave(socket) {
		const user = socket.deserializeAttachment();
		if (!user) return;
		// Chỉ báo "rời" khi user không còn kết nối nào khác (tránh race khi reconnect)
		const online = this.onlineUsers(socket);
		if (!online.has(user.uid)) this.broadcast({ type: "presence", online: online.size });
	}

	onlineUsers(excludeSocket = null, excludeUid = null) {
		const map = new Map();
		for (const s of this.ctx.getWebSockets()) {
			if (s === excludeSocket) continue;
			const u = s.deserializeAttachment();
			if (u && u.uid !== excludeUid) map.set(u.uid, u.name);
		}
		return map;
	}

	broadcast(message) {
		const payload = JSON.stringify(message);
		for (const s of this.ctx.getWebSockets()) {
			try { s.send(payload); } catch { s.close(1011, "Delivery failed"); }
		}
	}

	// Lưu tin nhắn về Laravel (best-effort, Laravel xử lý idempotent theo id)
	async persist(msg, room) {
		if (!this.env.LARAVEL_WEBHOOK_URL || !this.env.CHAT_SECRET) return;
		const body = JSON.stringify({ id: msg.id, room, user_id: msg.uid, name: msg.name, text: msg.text, ts: msg.ts });
		try {
			await fetch(this.env.LARAVEL_WEBHOOK_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Signature": await hmacHex(this.env.CHAT_SECRET, body) },
				body
			});
		} catch (err) {
			console.error("persist failed", String(err));
		}
	}
}

/* ---------- helpers ---------- */

function safeText(value, maxLength) {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function b64urlToBytes(str) {
	const b64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
	const bin = atob(b64);
	return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmacKey(secret, usage) {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function hmacHex(secret, body) {
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(body));
	return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Token: base64url(JSON).base64url(HMAC-SHA256(body))
async function verifyToken(token, secret) {
	if (!secret) { console.log("auth: CHAT_SECRET missing on Worker"); return null; }
	if (!token) { console.log("auth: no token"); return null; }
	try {
		const [body, sig] = token.split(".");
		if (!body || !sig) { console.log("auth: malformed token"); return null; }
		const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), b64urlToBytes(sig), encoder.encode(body));
		if (!ok) { console.log("auth: bad signature (secret mismatch)"); return null; }
		const claims = JSON.parse(decoder.decode(b64urlToBytes(body)));
		const now = Math.floor(Date.now() / 1000);
		if (!claims.exp || claims.exp < now) { console.log("auth: expired", claims.exp, now); return null; }
		if (!claims.uid || !/^[A-Za-z0-9_-]{1,64}$/.test(claims.room || "")) { console.log("auth: bad uid/room"); return null; }
		return claims;
	} catch (err) {
		console.log("auth: exception", String(err));
		return null;
	}
}
}
