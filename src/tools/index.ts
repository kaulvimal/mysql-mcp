// src/tools/index.ts
import type { ToolDefinition } from './types.js'; // Import shared type

// Import individual tool definitions and tool arrays from refactored files
import { getTableColumnsTool } from './schema.js';
import { metadataTools } from './metadata.js';
// Import executionTools which now includes pingTool
import { executionTools } from './execution.js';
import { visualizationTools } from './visualization.js';
import { performanceTools } from './performance.js';

// Combine all tool definitions into a single array
const allTools: ToolDefinition[] = [
  getTableColumnsTool,
  ...metadataTools,
  ...executionTools, // This now includes pingTool
  ...visualizationTools,
  ...performanceTools,
];

// Filter out any potential undefined/null entries just in case (good practice)
const validTools = allTools.filter(tool => tool && typeof tool === 'object');

// Export the flattened array of valid tool definitions
export default validTools;
