import { DurableObject } from "cloudflare:workers";

import { Env } from "./index";

// Single instance of an Infinichat room

// Useful resources:
// https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation-api

// Max number of regions one client can subscribe to at once
const MAX_ACTIVE_REGIONS = 20;

type RegionList = string[];

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
	activeRegions: Map<string, WebSocket[]>;

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

				// TODO update this.activeRegions with individual subscription info
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

	async webSocketMessage(ws: WebSocket, payload: string | ArrayBuffer): Promise<void> {
		let message: IncomingMessage;

		try {
			message = this.deserializeMsg(payload);
		} catch (e: unknown) {
			console.error("Could not parse incoming message, error: " + e);

			this.handleError(ws, "Unexpected message payload");
			return;
		}

		// Call handler for this message dynamically, if it exists
		if (!["subscribe", "unsubscribe", "update", "load"].includes(message.type)) {
			this.handleError(ws, `Unknown message type: "${message.type}"`);
			return;
		}

		if (message.type === "subscribe") return this.subscribe(ws, message.data);
		//
		return;
	}

	// async webSocketClose(
	// 	ws: WebSocket,
	// 	code: number,
	// 	reason: string,
	// 	wasClean: boolean
	// ): void | Promise<void> {
	// 	//
	// }

	// async webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
	// 	//
	// }

	async handleError(ws: WebSocket, error: string) {
		ws.send(this.serializeMsg("error", { error }));
		console.error(error);
	}

	// Dynamically define handlers for different message types:
	// unsubscribe -> stop listening to changes to region
	// update -> change a specific character / set of characters
	// load -> request contents of a region
	async subscribe(ws: WebSocket, data: Record<string, any>) {
		if (!data.regions || !Array.isArray(data.regions)) {
			this.handleError(ws, "Subscription request is malformed");
			return;
		}
		if (!data.regions.length) {
			this.handleError(ws, "Must subscribe to at least 1 region");
			return;
		}
		if (data.regions.length > MAX_ACTIVE_REGIONS) {
			this.handleError(ws, `Cannot subscribe to more than ${MAX_ACTIVE_REGIONS} regions`);
			return;
		}
		if (data.regions.some((region) => !this.isValidRegion(region))) {
			this.handleError(ws, "One or more region keys is invalid");
			return;
		}

		// Client state should be attached to websocket, but we'll be aware of
		// the impossible case where it is not
		const clientState = this.clients.get(ws);
		const existingRegions: string[] = clientState?.subscribedRegions ?? [];

		// Add regions, remove duplicates while noting new subscriptions
		const newSubscriptions: string[] = [];

		// Note the order here: older subscriptions first, new ones last
		const allRegions = [...existingRegions, ...data.regions].reduce<string[]>(
			(accum: string[], region: string) => {
				// Avoid duplicates subscriptions to the same regions
				if (accum.indexOf(region) === -1) accum.push(region);
				if (!existingRegions.includes(region)) newSubscriptions.push(region);

				return accum;
			},
			[]
		);

		// Keep only the maximum subscribed regions - we'll remove first entries in the array
		// which should presumably be the oldest subscriptions
		const subscribedRegions = allRegions.slice(Math.max(0, allRegions.length - MAX_ACTIVE_REGIONS));

		// Identify regions that were implicitly unsubscribed by overflowing the max active size
		// i> slice returns (start, end]
		const unsubscribedRegions = allRegions.slice(
			0,
			Math.max(0, allRegions.length - MAX_ACTIVE_REGIONS)
		);

		// Update subscribed regions attached to this client
		this.clients.set(ws, {
			subscribedRegions: allRegions,
		});
		this.saveClientData(ws);

		// Update tracked regions to match the new state
		this.addClientToRegions(ws, subscribedRegions);
		this.removeClientFromRegions(ws, unsubscribedRegions);

		//
		ws.send(
			this.serializeMsg("subscriptions", {
				subscribedRegions,
				unsubscribedRegions,
			})
		);

		// TODO send region data
		// ws.send(this.serializeMsg("regionData", {
		// 	regions: subscribedRegions.map(region => )
		// }))
	}
	unsubscribe(ws: WebSocket, data: Record<string, any>) {}
	update(ws: WebSocket, data: Record<string, any>) {}
	load(ws: WebSocket, data: Record<string, any>) {}

	// Trigger an update of the stored ClientState associated with this websocket
	// This data will used to reinstantiate the instance if it hibernates
	saveClientData(ws: WebSocket) {
		const attachmentData = this.clients.get(ws);
		if (!attachmentData) return;

		// ClienState as a string
		const attachment = JSON.stringify(attachmentData);
		ws.serializeAttachment(attachment);
	}

	// Marks the websocket as a subscriber to a list of regions in activeRegions
	// NOTE we're not validating region strings here - be mindful
	addClientToRegions(ws: WebSocket, regions: string[]) {
		regions.forEach((region: string) => {
			const existingClients = this.activeRegions.get(region) ?? [];

			if (existingClients.indexOf(ws) !== -1) return;

			existingClients.push(ws);
			this.activeRegions.set(region, existingClients);
		});
	}

	removeClientFromRegions(ws: WebSocket, regions: string[]) {
		regions.forEach((region: string) => {
			const existingClients = this.activeRegions.get(region) ?? [];

			const idx = existingClients.indexOf(ws);
			if (idx === -1) return;

			existingClients.splice(idx, 1);

			if (existingClients.length === 0) {
				// This client was the only subscriber, clean up
				this.unloadRegion(region);
				return;
			}

			this.activeRegions.set(region, existingClients);
		});
	}

	// Invoke on a region to clear its cached data, if any
	unloadRegion(region: string) {
		// TODO
		this.activeRegions.delete(region);
	}
	loadRegion(region: string) {
		// TODO
	}

	// Must be a string formatted "[number]-[number]"
	isValidRegion(regionString: string): regionString is string {
		if (!regionString?.length) return false;

		// There must be exactly two numbers
		const splitRegion = regionString.split("-");
		if (splitRegion.length !== 2) return false;

		// They must be numbers
		if (isNaN(+splitRegion[0]) || isNaN(+splitRegion[1])) return false;

		// They must be whole numbers
		if (+splitRegion[0] % 1 !== 0) return false;
		if (+splitRegion[1] % 1 !== 0) return false;

		return true;
	}

	serializeRegion(region: string) {
		//
	}

	// Helper fn to generate uniform websocket messages
	serializeMsg(type: string, data: Record<string, any>): string {
		return JSON.stringify({
			id: this.ctx.id.toString(),
			name: this.ctx.id.name,
			type,
			data,
		});
	}

	// Parse incoming websocket messages
	deserializeMsg(rawMessage: string | ArrayBuffer): IncomingMessage {
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
