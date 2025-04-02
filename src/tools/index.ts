// src/tools/index.ts
import type { ToolDefinition } from './types.js'; // Import shared type

// Import individual tool definitions and tool arrays
import { getTableColumnsTool } from './schema.js';
import { runSqlQueryTool } from './query.js';
import { metadataTools } from './metadata.js'; // Read-only metadata tools
import { executionTools } from './execution.js'; // New execution tools
// Import placeholder arrays (even if empty, keeps structure consistent)
import { transactionTools } from './transaction.js';
import { optimizationTools } from './optimization.js';
import { visualizationTools } from './visualization.js';
// import { analysisTools } from './analysis';

// Combine all tool definitions into a single array
const allTools: ToolDefinition[] = [
  getTableColumnsTool,
  runSqlQueryTool, // Kept, but marked as deprecated in description
  ...metadataTools,
  ...executionTools, // Add new execution tools
  ...transactionTools,
  // ...analysisTools,
  ...optimizationTools,
  ...visualizationTools,
];

// Filter out any potential undefined/null entries just in case placeholders are empty/invalid
const validTools = allTools.filter(tool => tool && typeof tool === 'object');

// Export the flattened array of valid tool definitions
export default validTools;
