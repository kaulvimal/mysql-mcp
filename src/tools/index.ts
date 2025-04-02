// src/tools/index.ts

// Import individual tool definitions
import { getTableSchemaTool } from './schema.js';
import { runSqlQueryTool } from './query.js';
// import { transactionTools } from './transaction.js'; // Assuming it exports an array
// Import other tool definitions as they are created
// import { analysisTools } from './analysis';
// import { optimizationTools } from './optimization';
// import { visualizationTools } from './visualization';

// Combine all tool definitions into a single array
// Ensure each imported item is a tool definition object or an array of them
const allTools = [
  getTableSchemaTool,
  runSqlQueryTool,
  // ...transactionTools, // Spread the array if transactionTools exports multiple
  // ...analysisTools,
  // ...optimizationTools,
  // ...visualizationTools,
];

// Export the array of tool definitions
export default allTools;
