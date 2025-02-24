import InfinichatInstance from "./InfinichatInstance";

export interface Env {
	INFINICHAT_INSTANCE: DurableObjectNamespace<InfinichatInstance>;
}

// Base worker
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Must match "/ws?name=<room name>" format
		if (URL.parse(request.url)?.pathname !== "/ws") {
			return new Response("Bad request", { status: 400 });
		}

		// Validation
		const instanceName = URL.parse(request.url)?.searchParams.get("name")?.trim();
		if (!instanceName || instanceName.length < 3 || instanceName.length > 16) {
			return new Response(
				JSON.stringify({
					error: "Instance name must be between 3 and 16 chars",
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
					},
				}
			);
		}

		// Expect an upgrade request (should this be moved before validation?)
		const upgradeHeader = request.headers.get("Upgrade");
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Durable Object expected Upgrade: websocket", { status: 426 });
		}

		// Durable Object
		const id = env.INFINICHAT_INSTANCE.idFromName(instanceName.toLowerCase());
		const instance = env.INFINICHAT_INSTANCE.get(id);

		return instance.fetch(request);
	},
};

export { InfinichatInstance };
