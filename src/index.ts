import InfinichatInstance from "./InfinichatInstance";

export interface Env {
	INFINICHAT_INSTANCE: DurableObjectNamespace<InfinichatInstance>;
}

// Base worker
export default {};

export { InfinichatInstance };
