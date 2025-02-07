import { DurableObject } from "cloudflare:workers";

import Env from "./index";

// Single instance of an Infinichat room

// Useful resources:
// https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation-api

export class InfinichatInstance extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		// Constructor executes when DO is first created
		// OR after a hibernating ws connection wakes back up
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		// New request / client is passed in from a worker
		// Each DO instance represents a single room that multiple users can connect to

		// Websocket setup
		const wsPair = new WebSocketPair();
		const [client, server] = Object.values(wsPair);

		// This is where the handoff between the worker and DO takes place
		// Accepting the websocket here allows for hibernation, which keeps the
		// connection alive but doesn't bill compute time when idle.
		this.ctx.acceptWebSocket(server);

		// Upgrade
		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
		//
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
		//
	}

	async webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
		//
	}

	// Helper fn to generate uniform websocket messages
	serialize(payload: Record<string, any>): string {
		return JSON.stringify({
			id: this.ctx.id.toString(),
			name: this.ctx.id.name,
			payload,
		});
	}
}
