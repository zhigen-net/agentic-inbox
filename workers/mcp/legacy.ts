import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Preserve the existing DO export/binding for migration compatibility. Public MCP uses
// authenticated stateless HTTP above; old sessions must reconnect and have no tools.
export class EmailMCP extends McpAgent<any> {
	server = new McpServer({
		name: "agentic-inbox-retired-session",
		version: "2.0.0",
	});
	async init() {}
}
