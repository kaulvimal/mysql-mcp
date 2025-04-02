// src/tools/types.ts

/**
 * Defines the standard structure for a successful or error response from an MCP tool.
 */
export type McpToolResponse = {
  // Array of content blocks, typically text for simple responses.
  content: { type: "text"; text: string }[];
  // Optional flag to indicate if the response represents an error state.
  isError?: boolean;
};

/**
 * Defines the structure for a tool definition object used for registration.
 */
export type ToolDefinition = {
    name: string;
    description: string;
    // The raw Zod schema definition object (not the parsed schema).
    rawInputSchema: Record<string, any>;
    // The handler function that executes the tool's logic.
    handler: (args: any, extra: any) => Promise<McpToolResponse>;
};
