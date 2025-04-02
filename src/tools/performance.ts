// src/tools/performance.ts
import { z } from 'zod';
import { pool } from '../config.js';
import type { McpToolResponse, ToolDefinition } from './types.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { formatErrorResponse } from './utils.js';

// --- Tool: get_performance_metrics ---
const getPerformanceMetricsRawInput = {
    // query_id: z.string().optional().describe("Optional ID of a previous query to get metrics for (Not currently supported)."),
    metric_types: z.array(z.string()).optional().describe("Optional: Specific metric types or patterns (e.g., ['Uptime', 'Threads_%', 'Queries']). Uses defaults if omitted."),
};
const GetPerformanceMetricsInputSchema = z.object(getPerformanceMetricsRawInput);

const getPerformanceMetricsHandler = async (args: z.infer<typeof GetPerformanceMetricsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { metric_types } = args;
    let connection: PoolConnection | null = null;

    // Explain limitations
    let message = "Performance Metrics:\n\n";
    message += "**Limitation:** Query-specific historical performance metrics (using `query_id`) are not tracked by this server.\n";
    message += "The following are selected **global** status variables.\n\n";

    // Define default or requested metrics to fetch
    // Using LIKE patterns for flexibility
    const defaultMetrics = ['Uptime', 'Threads_connected', 'Threads_running', 'Queries', 'Slow_queries', 'Connections'];
    const metricsToFetch = metric_types && metric_types.length > 0 ? metric_types : defaultMetrics;
    const likeClauses = metricsToFetch.map(m => `Variable_name LIKE ${mysql.escape(m.includes('%') ? m : m + '%')}`).join(' OR ');

    const sql = `SHOW GLOBAL STATUS WHERE ${likeClauses};`;

    try {
        connection = await pool.getConnection();
        console.error(`[get_performance_metrics] Fetching global status variables...`);

        const [rows] = await connection.query<RowDataPacket[]>(sql);

        if (rows.length === 0) {
             message += "Could not retrieve the requested status variables.";
        } else {
             rows.forEach(row => {
                 message += `${row.Variable_name}: ${row.Value}\n`;
             });
        }

        return { content: [{ type: "text", text: message }] };

    } catch (error: any) {
        // Add specific error message if status query fails
        return formatErrorResponse('get_performance_metrics', `retrieve global status metrics`, error);
    } finally {
        if (connection) connection.release();
    }
     // Safeguard Return
     return { isError: true, content: [{ type: "text", text: "[get_performance_metrics] Unexpected error: Handler ended without returning result." }] };
};

export const getPerformanceMetricsTool: ToolDefinition = {
  name: "get_performance_metrics",
  description: "Retrieves basic global performance metrics from MySQL (e.g., Uptime, Threads, Queries). Does not support query-specific historical metrics.",
  rawInputSchema: getPerformanceMetricsRawInput,
  handler: getPerformanceMetricsHandler,
};


// --- Aggregate Performance Tools ---
export const performanceTools: ToolDefinition[] = [
    getPerformanceMetricsTool,
];
