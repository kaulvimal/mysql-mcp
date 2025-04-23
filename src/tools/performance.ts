// src/tools/performance.ts
import { z } from 'zod';
import type { McpToolResponse, ToolDefinition, DatabaseType } from './types.js';
// Import Adapters and Interface
import { MySqlAdapter, PostgresAdapter, IDatabaseAdapter } from '../db_adapter.js';
// Import pgConfig to get default DB name if needed
import { pgConfig } from '../config.js';

// --- Helper Function to Get Adapter ---
function getDbAdapter(dbType: DatabaseType): IDatabaseAdapter {
    if (dbType === 'mysql') {
        return new MySqlAdapter();
    } else if (dbType === 'postgres') {
        return new PostgresAdapter();
    } else {
        throw new Error(`Unsupported database type: ${dbType}`);
    }
}

// --- Tool: get_performance_metrics ---
const getPerformanceMetricsRawInput = {
    databaseType: z.enum(['mysql', 'postgres']).describe("The type of database (mysql or postgres)."),
    // Keep databaseName - PG needs it for pg_stat_database, MySQL uses GLOBAL status but good for context.
    databaseName: z.string().optional().describe("The target database name. Required for PostgreSQL pg_stat_database query (defaults to connection database if omitted). Optional for MySQL (uses GLOBAL STATUS)."),
    metric_types: z.array(z.string()).optional().describe("Optional: Specific metric types or patterns (e.g., ['Uptime', 'Threads_%', 'Queries']). Uses defaults if omitted. Interpretation depends on databaseType."),
};
const GetPerformanceMetricsInputSchema = z.object(getPerformanceMetricsRawInput);

const getPerformanceMetricsHandler = async (args: z.infer<typeof GetPerformanceMetricsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, metric_types } = args;
    // Determine the databaseName to use, especially for PostgreSQL
    const databaseName = args.databaseName || (databaseType === 'postgres' ? pgConfig.database : undefined);

    let adapter: IDatabaseAdapter;

    // Validate databaseName for PostgreSQL if adapter requires it
     if (databaseType === 'postgres' && !databaseName) {
         // Attempted to default from pgConfig, but still missing
          return { isError: true, content: [{ type: "text", text: "Missing required parameter 'databaseName' for PostgreSQL performance metrics (could not determine from connection config)." }] };
     }

    try {
        adapter = getDbAdapter(databaseType);
    } catch (error: any) {
         return { isError: true, content: [{ type: "text", text: `Failed to initialize database adapter: ${error.message}` }] };
    }

    // Construct context description for logging/messages
    const contextDesc = databaseType === 'mysql'
        ? "MySQL server (GLOBAL STATUS)"
        : `PostgreSQL database '${databaseName}'`; // Use the determined databaseName for PG

    let message = `Performance Metrics (${contextDesc}):\n\n`;
    message += "**Limitation:** Query-specific historical performance metrics are not tracked by this server.\n";
    message += "The following are selected **global/database-level** status variables or statistics.\n\n";

    try {
        console.error(`[${databaseType}-get_performance_metrics] Fetching performance metrics for ${contextDesc}...`);

        // Pass databaseName - PG adapter uses it, MySQL adapter might ignore it but it's available
        const metrics = await adapter.getPerformanceMetrics(databaseName, metric_types);

        if (!metrics || Object.keys(metrics).length === 0) {
             message += "Could not retrieve the requested performance metrics or no metrics matched.";
        } else {
             // Format the returned metrics object
             message += JSON.stringify(metrics, null, 2);
        }

        return { content: [{ type: "text", text: message }] };

    } catch (error: any) {
        console.error(`[${databaseType}-get_performance_metrics] Error fetching metrics for ${contextDesc}:`, error);
        // Pass databaseName for error context if available
        return adapter.formatError('get_performance_metrics', `retrieve performance metrics`, error, databaseName);
    }
};

export const getPerformanceMetricsTool: ToolDefinition = {
  name: "get_performance_metrics",
  description: "Retrieves basic global/database-level performance metrics/statistics from MySQL or PostgreSQL (e.g., Uptime, Threads, Queries, Activity). Requires 'databaseName' for PostgreSQL context.",
  rawInputSchema: getPerformanceMetricsRawInput,
  handler: getPerformanceMetricsHandler,
};


// --- Aggregate Performance Tools ---
export const performanceTools: ToolDefinition[] = [
    getPerformanceMetricsTool,
];
