import { DurableObject } from "cloudflare:workers";

import { Env } from "./index";

// Single instance of an Infinichat room

// Read/write to the DurableObject KV store with the SQLite backend enabled!
// Pricing is more favorable for a large number of writes:
// 		2 Key-value methods like get(), put(), delete(), or list() store and query
// 		data in a hidden SQLite table and are billed as rows read and rows written.
// (25B Reads, 50M Writes to SQL backend in the free tier)
// https://developers.cloudflare.com/workers/platform/pricing/#sqlite-storage-backend

// Useful resources:
// https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation-api

// Max number of regions one client can subscribe to at once
const MAX_ACTIVE_REGIONS = 24;

// Side-length of a region in characters
// https://developers.cloudflare.com/durable-objects/platform/pricing/#key-value-storage-backend
// ! Changing this value will corrupt any previously-saved regions
// A "storage unit" is 4KB, which would be 64x64 chars approximately
// Unicode chars can be between 1-4 bytes each. We're billed in multiples of 4KB,
// optimize for ~1.2 bytes per char per 4KB, shoot for slightly under 4KB.
// Keep regions approximately-square -> aspect ratio of ~2:3

// 72 B * 48 B = 3456 B
// 4 KB / 3456 B => optimized for 1.16 bytes / char
const REGION_WIDTH = 3 * 24; // 72
const REGION_HEIGHT = 2 * 24; // 48

interface ClientState {
	subscribedRegions: string[];
}

interface IncomingMessage {
	type: string;
	data: Record<string, any>;
}

export default class InfinichatInstance extends DurableObject {
	// This object represents an entire Infinichat room, which handles
	// websocket messages and ephemeral state

	state: DurableObjectState;
	env: Env;

	// List of websockets that are actively connected
	clients: Map<WebSocket, ClientState>;
	// List of regions that are actively being watched and by whom
	activeRegions: Map<string, WebSocket[]>;

	// Region memory cache
	// DurableObjects billed for 128MB of memory regardless of actual usage
	// We should shoot for 64MB of cached data,

	constructor(state: DurableObjectState, env: Env) {
		// Constructor executes when DO is first created
		// OR after a hibernating ws connection wakes back up

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
				clientState = JSON.parse(ws.deserializeAttachment());
			} catch (e) {
				// The existing state is not set or is corrupt
				// This does not matter, we've defaulted to an empty clientState already
			}

			// Re-associate state with the client
			this.clients.set(ws, clientState);
			// Re-subscribe
			this.addClientToRegions(ws, clientState.subscribedRegions);
		});
	}

	async fetch(request: Request): Promise<Response> {
		// New request / client is passed in from base worker
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

		// webSocketMessages will handle future messages from here
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

		// Custom message handlers
		if (message.type === "subscribe") return this.subscribe(ws, message.data);
		if (message.type === "load") return this.load(ws, message.data);
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

	async sendMessage(ws: WebSocket, type: string, data: Record<string, any>) {
		try {
			const messageString = this.serializeMsg(type, data);
			ws.send(messageString);
		} catch (e) {
			// Connection is dead
			this.clients.delete(ws);
		}
	}

	// Dynamically define handlers for different message types:
	// unsubscribe -> stop listening to changes to region
	// update -> change a specific character / set of characters
	// load -> request contents of a region
	async subscribe(ws: WebSocket, data: Record<string, any>) {
		if (!data.regions || !Array.isArray(data.regions)) {
			this.handleError(ws, "Subscribe request is malformed");
			return;
		}
		if (!data.regions.length) {
			this.handleError(ws, "Specify at least 1 region to subscribe to");
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
		this.triggerClientSave(ws);

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

		// Send newly subscribed regions
		this.sendRegions(ws, subscribedRegions);
	}
	unsubscribe(ws: WebSocket, data: Record<string, any>) {
		if (!data.regions || !Array.isArray(data.regions)) {
			this.handleError(ws, "Unsubscribe request is malformed");
			return;
		}
		if (data.regions.some((region) => !this.isValidRegion(region))) {
			this.handleError(ws, "One or more region keys is invalid");
			return;
		}

		const clientState = this.clients.get(ws);
		const existingRegions: string[] = clientState?.subscribedRegions ?? [];

		// Remove from client's region list
		const updatedRegions = existingRegions.filter((region) => !data.regions.includes(region));
		this.clients.set(ws, {
			subscribedRegions: updatedRegions,
		});
		this.triggerClientSave(ws);

		this.removeClientFromRegions(ws, data.regions);
	}

	update(ws: WebSocket, data: Record<string, any>) {
		// TODO
		// Data should include x,y coordinates of each change as well as the new value.
		// By specifically indicating which coordinate is updated, we can avoid accidentally
		// overwriting changes made by others (including deletes, spaces, etc.) that might be
		// lost if we sent a full region update
		// TODO sender-rate limit
		// TODO send incremental updates
		// IDEA this is where we can attach additional metadata (such as owner) to any
		// specific cells. We could also use an LLM to look at nearby cells to generate
		// adjacent text - which we could color a very light gray to indicate machine-generated
	}
	load(ws: WebSocket, data: Record<string, any>) {
		if (!data.regions || !Array.isArray(data.regions)) {
			this.handleError(ws, "Unsubscribe request is malformed");
			return;
		}
		if (!data.regions.length) {
			this.handleError(ws, "Specify at least 1 region to load");
			return;
		}
		if (data.regions.length > MAX_ACTIVE_REGIONS) {
			this.handleError(ws, `Cannot load more than ${MAX_ACTIVE_REGIONS} regions at a time`);
			return;
		}
		if (data.regions.some((region) => !this.isValidRegion(region))) {
			this.handleError(ws, "One or more region keys is invalid");
			return;
		}

		this.sendRegions(ws, data.regions);
	}

	// Trigger an update of the stored ClientState associated with this websocket
	// This data will used to reinstantiate the instance if it hibernates
	// ! side effects
	triggerClientSave(ws: WebSocket) {
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

	// Remove a client from a list of regions, or all regions if not specified
	removeClientFromRegions(ws: WebSocket, regions?: string[]) {
		const targetRegions = regions ?? Array.from(this.activeRegions.keys());

		targetRegions.forEach((region: string) => {
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

	// Clean up subscriptions and anything else associated with a client
	cleanupClient(ws: WebSocket) {
		this.clients.delete(ws);
		this.removeClientFromRegions(ws);
	}

	//
	async loadRegion(region: string) {
		return ((await this.ctx.storage.get(region)) as string) ?? "";
	}

	// Saves region value to disk - the runtime will likely cache it for us
	async saveRegion(region: string, regionData: string) {
		// Delete regions if they're empty
		if (regionData.trim().length === 0) {
			await this.ctx.storage.delete(region);
			return;
		}

		// Enforce limits
		if (regionData.length !== REGION_WIDTH * REGION_HEIGHT) {
			throw new Error(
				`Tried to save a region of length ${regionData.length}, expected exactly ${
					REGION_WIDTH * REGION_HEIGHT
				}`
			);
		}

		await this.ctx.storage.put(region, regionData);
	}

	// Invoke on a region to clear its cached data, if any
	unloadRegion(region: string) {
		this.activeRegions.delete(region);
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

	// Send full region data to a client
	async sendRegions(ws: WebSocket, regions: string[]) {
		const storedRegions = await this.ctx.storage.get(regions);

		// Uninstantiated regions are explicitly null
		const regionData: Record<string, string | null> = {};

		storedRegions.forEach((data, region) => {
			if (data !== undefined && typeof data !== "string") {
				// Unexpected state, data should always be a string
				console.warn(
					`Region data was of type "${typeof data}", expected type "string" - corruption?`
				);
				data = null;
			}

			regionData[region] = data ? data.toString() : null;
		});

		ws.send(
			this.serializeMsg("regionData", {
				regions: regionData,
			})
		);
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
