import { DurableObject } from "cloudflare:workers";

import { Env } from "./index";

// Single instance of an Infinichat room

// Useful resources:
// https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation-api

type RegionList = [number, number][];

interface ClientState {
	subscribedRegions: RegionList;
}

type IncomingMessage = {
	type: string;
	data: Record<string, any>;
};

export class InfinichatInstance extends DurableObject {
	// This object represents an entire Infinichat room, which handles
	// websocket messages and ephemeral state

	state: DurableObjectState;
	env: Env;

	// List of websockets that are actively connected
	clients: Map<WebSocket, ClientState>;
	// List of regions that are actively being watched and by whom
	activeRegions: Map<[number, number], WebSocket[]>;

	constructor(state: DurableObjectState, env: Env) {
		// Constructor executes when DO is first created
		// OR after a hibernating ws connection wakes back up

		// This object may have been woken up after hibernating

		super(state, env);
		this.state = state;
		this.env = env;

		this.clients = new Map();
		this.activeRegions = new Map();

		// If one websocket wakes up a DurableObject that had multiple clients,
		// we'll need to re-instantiate those as well, even if they might not have
		// been the originator of the wake-up.
		this.state.getWebSockets().forEach((ws) => {
			let clientState: ClientState = {
				subscribedRegions: [],
			};

			// Attempt to load any data about this specific ws connection
			// This is relevant in the case that we're waking up
			try {
				const existingData = JSON.parse(ws.deserializeAttachment());
				if (existingData) {
					clientState = existingData as ClientState; // !
				}

				// TODO update this.activeRegions with subscription info
			} catch (e) {
				// The existing state is not set or is corrupt
				// This does not matter, we've defaulted to an empty clientState already
			}

			// Re-apply associate client with state
			this.clients.set(ws, clientState);
		});
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

	async webSocketMessage(ws: WebSocket, payload: string | ArrayBuffer): void | Promise<void> {
		let message: IncomingMessage;

		try {
			message = this.deserialize(payload);
		} catch (e: unknown) {
			console.error("Could not parse incoming message, error: " + e);
			return;
		}

		// Call handler for this message dynamically, if it exists
		const handler = this.messageHandlers[message.type as keyof typeof this.messageHandlers];
		if (!handler) {
			console.error(`Handler for message type "${message.type}" does not exist`);
			return;
		}

		return handler(ws, message.data);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
		//
	}

	async webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
		//
	}

	// Dynamically define handlers for different message types:
	// unsubscribe -> stop listening to changes to region
	// update -> change a specific character / set of characters
	// fetch -> request contents of a region
	async subscribe(ws: WebSocket, data: { regions: RegionList }) {
		if (!data.regions) {
			console.error("Client region subscribe request malformed");
			return;
		}
		if (!data.regions?.length) {
			console.error("Client tried to subscribe to 0 regions");
			return;
		}
		if (data.regions?.length > 20) {
			// Out of bounds
			console.error(`Client tried to subscribe to too many regions: ${data.regions.length}`);
		}

		// Client state should be attached to websocket, but we'll be aware of
		// the impossible case where it is not
		const clientState = this.clients.get(ws);
		const existingRegions: RegionList = clientState?.subscribedRegions ?? [];

		// Add regions, remove duplicates while noting new subscriptions
		const newSubscriptions: RegionList = [];
		const subscribedRegions = [...existingRegions, ...data.regions].reduce((accum, region) => {
			if (accum.indexOf(region) === -1) accum.push(region);
			if (!existingRegions.includes(region)) newSubscriptions.push(region);
			return accum;
		}, [] as RegionList);

		// Update subscribed regions on this ws
		this.clients.set(ws, {
			subscribedRegions,
		});
	}
	unsubscribe(ws: WebSocket, data: Record<string, any>) {}
	update(ws: WebSocket, data: Record<string, any>) {}
	load(ws: WebSocket, data: Record<string, any>) {}

	// Helper fn to generate uniform websocket messages
	serialize(type: string, data: Record<string, any>): string {
		return JSON.stringify({
			id: this.ctx.id.toString(),
			name: this.ctx.id.name,
			type,
			data,
		});
	}

	// Parse incoming websocket messages
	deserialize(rawMessage: string | ArrayBuffer): IncomingMessage {
		const payload = JSON.parse(rawMessage.toString());

		if (!payload?.message || !payload?.data) {
			throw new Error("Incoming websocket message had an unexpected struture");
		}

		return {
			type: payload.type,
			data: payload.payload,
		};
	}
}
