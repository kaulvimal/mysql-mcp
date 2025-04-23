// src/index.ts
// Import MCP server components
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import the aggregated list of tool definitions
import allTools from './tools/index.js';
// Import config flags to check which DBs are enabled
import { mysqlEnabled, pgEnabled } from './config.js';
import type { McpToolResponse } from "./tools/types.js"; // Import McpToolResponse type

// --- Create MCP Server Instance ---
const server = new McpServer({
  name: "db-mcp-server",
  version: "1.2.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// --- Register all imported tools with Logging Wrapper ---
// Use console.error for logging to avoid interfering with stdout/MCP communication
console.error(`Registering ${allTools.length} tool(s)... (MySQL Enabled: ${mysqlEnabled}, PostgreSQL Enabled: ${pgEnabled})`);
allTools.forEach(tool => {
  if (tool && typeof tool === 'object' && tool.name && tool.description && tool.rawInputSchema && tool.handler) {
    const originalHandler = tool.handler;

    // Create a wrapper handler for logging (using console.error)
    const loggingHandler = async (args: any, extra: any): Promise<McpToolResponse> => {
        console.error(`>>> Received request for tool: ${tool.name}`); // Use console.error
        console.error(`>>> Arguments: ${JSON.stringify(args)}`); // Use console.error
        try {
            const result = await originalHandler(args, extra);
            console.error(`<<< Finished tool: ${tool.name} (Success: ${!result.isError})`); // Use console.error
            // console.error(`<<< Result (partial): ${JSON.stringify(result).substring(0, 200)}...`); // Use console.error if uncommented
            return result;
        } catch (error: any) {
            console.error(`!!! Uncaught error in handler for tool: ${tool.name}`, error); // Already uses console.error
            console.error(`<<< Finished tool: ${tool.name} (Uncaught Error)`); // Use console.error
            return {
                isError: true,
                content: [{ type: "text", text: `Internal server error in tool '${tool.name}': ${error.message}` }]
            };
        }
    };

    // Register the tool with the logging wrapper handler
    server.tool(
      tool.name,
      tool.description,
      tool.rawInputSchema,
      loggingHandler // Use the wrapped handler
    );
  } else {
    console.error(`Skipping invalid or incomplete tool definition:`, tool); // Use console.error (was warn)
  }
});
console.error("Tool registration complete."); // Use console.error

// --- Main Function to Start the Server ---
async function main() {
  if (!mysqlEnabled && !pgEnabled) {
     console.error("ERROR: Cannot start server. No valid database configuration found for MySQL or PostgreSQL. Check .env file.");
     process.exit(1);
  } else {
      console.error("DB MCP Server starting with configured databases..."); // Use console.error
  }

  const transport = new StdioServerTransport();
  try {
    console.error("Attempting to connect MCP server to STDIO transport..."); // Use console.error
    await server.connect(transport);
    console.error("MCP Server connected via STDIO transport. Waiting for requests..."); // Use console.error
  } catch (error) {
     console.error("Failed to connect server to transport:", error); // Already uses console.error
     process.exit(1);
  }
}

// --- Run the Main Function ---
main().catch((error) => {
  console.error("Fatal error starting MCP server:", error); // Already uses console.error
  process.exit(1);
});
