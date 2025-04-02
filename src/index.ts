// src/index.ts
// Import MCP server components
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import the aggregated list of tool definitions with .js extension
import allTools from './tools/index.js';
// Import dbConfig with .js extension
import { dbConfig } from './config.js';
// --- *** END OF FIX *** ---


// --- Create MCP Server Instance ---
const server = new McpServer({
  // Consider reading name/version from package.json
  name: "mysql-mcp-server",
  version: "1.1.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// --- Register all imported tools ---
// console.error(`Registering ${allTools.length} tool(s)...`);
allTools.forEach(tool => {
  // Ensure the tool definition is valid before registering
  if (tool && typeof tool === 'object' && tool.name && tool.description && tool.rawInputSchema && tool.handler) {
    // console.error(` - Registering tool: ${tool.name}`);
    // Use the correct Zod schema type expected by server.tool
    // Assuming inputSchema is a Zod schema object, directly pass it
    server.tool(
      tool.name,
      tool.description,
      tool.rawInputSchema,
      tool.handler
    );
  } else {
    // Log the problematic item for debugging if it's not a valid tool definition
    console.warn(`Skipping invalid or incomplete tool definition:`, tool);
  }
});
// console.error("Tool registration complete.");

// --- Main Function to Start the Server ---
async function main() {
  // Ensure db config seems okay before starting transport
  if (!dbConfig.host || !dbConfig.user) {
     console.error("ERROR: Cannot start server due to missing database configuration (DB_HOST, DB_USER). Check .env file.");
     process.exit(1); // Exit if config is fundamentally broken
  }

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (error) {
     console.error("Failed to connect server to transport:", error);
     process.exit(1);
  }
}

// --- Run the Main Function ---
main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
