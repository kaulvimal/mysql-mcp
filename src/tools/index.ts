// src/tools/index.ts
import type { ToolDefinition } from './types.js'; // Import shared type

// Import individual tool definitions and tool arrays
import { getTableColumnsTool } from './schema.js';
import { runSqlQueryTool } from './query.js';
import { metadataTools } from './metadata.js';
import { executionTools } from './execution.js'; // Contains informational placeholders
import { visualizationTools } from './visualization.js'; // Contains visualize_schema
import { performanceTools } from './performance.js'; // Contains get_performance_metrics
// Import placeholder arrays (even if empty, keeps structure consistent)
import { optimizationTools } from './optimization.js';
// import { analysisTools } from './analysis'; // Skipped

// Combine all tool definitions into a single array
const allTools: ToolDefinition[] = [
  getTableColumnsTool,
  runSqlQueryTool, // Kept, but marked as deprecated in description
  ...metadataTools,
  ...executionTools,
  ...visualizationTools, // Includes schema visualization
  ...performanceTools,   // Includes performance metrics tool
  // ...analysisTools,   // Skipped
  ...optimizationTools,  // Still placeholder
];

// Filter out any potential undefined/null entries just in case placeholders are empty/invalid
// Especially relevant for placeholder arrays like optimizationTools
const validTools = allTools.filter(tool => tool && typeof tool === 'object');

// Export the flattened array of valid tool definitions
export default validTools;
