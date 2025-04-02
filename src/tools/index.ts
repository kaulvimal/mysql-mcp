// src/tools/index.ts
import type { ToolDefinition } from './types.js'; // Import shared type

// Import individual tool definitions and tool arrays
import { getTableColumnsTool } from './schema.js'; // Renamed tool
import { runSqlQueryTool } from './query.js';
import { metadataTools } from './metadata.js'; // Array of new metadata tools
// Import placeholder arrays (even if empty, keeps structure consistent)
import { transactionTools } from './transaction.js';
import { optimizationTools } from './optimization.js';
import { visualizationTools } from './visualization.js';
// import { analysisTools } from './analysis'; // Assuming analysis.ts exists or will be added

// Combine all tool definitions into a single array
// Ensure each imported item is a tool definition object or an array of them
const allTools: ToolDefinition[] = [
  getTableColumnsTool, // Updated name
  runSqlQueryTool,
  ...metadataTools,      // Spread the array of metadata tools
  ...transactionTools,   // Spread placeholder arrays
  // ...analysisTools,
  ...optimizationTools,
  ...visualizationTools,
];

// Filter out any potential undefined/null entries just in case placeholders are empty/invalid
const validTools = allTools.filter(tool => tool && typeof tool === 'object');

// Export the flattened array of valid tool definitions
export default validTools;
