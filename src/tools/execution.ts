// src/tools/execution.ts
import { z } from 'zod';
import { pool } from '../config.js';
import type { McpToolResponse, ToolDefinition } from './types.js';
import type { PoolConnection, OkPacket, RowDataPacket, ResultSetHeader, FieldPacket } from 'mysql2/promise';
import { isReadOnlyQuery, formatErrorResponse } from './utils.js'; // Import the utility function
import { performance } from 'perf_hooks'; // For performance metrics
import mysql from 'mysql2/promise'; // For escape method

// --- Tool: execute_query ---
const executeQueryRawInput = {
  databaseName: z.string().describe("The name of the database to run the query against."),
  query: z.string().describe("The read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN) to execute."),
  params: z.array(z.any()).optional().describe("Optional array of parameters for prepared statement placeholders (?)."),
  pagination: z.object({
      limit: z.coerce.number().int().positive().describe("Number of rows to return."),
      offset: z.coerce.number().int().nonnegative().optional().default(0).describe("Number of rows to skip."),
  }).optional().describe("Optional pagination settings."),
  include_performance_metrics: z.boolean().optional().default(false).describe("Include query execution time in the response."),
};
const ExecuteQueryInputSchema = z.object(executeQueryRawInput);

const executeQueryHandler = async (args: z.infer<typeof ExecuteQueryInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, query, params = [], pagination, include_performance_metrics } = args;
    let connection: PoolConnection | null = null;
    let finalQuery = query;
    let finalParams = [...params]; // Copy params array

    // 1. Check if the core query is read-only BEFORE adding pagination
    if (!isReadOnlyQuery(query)) {
        return { isError: true, content: [{ type: "text", text: "Error: Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed." }] };
    }

    // 2. Apply pagination if requested
    if (pagination) {
        // Basic check to avoid adding LIMIT to non-SELECT queries where it might not make sense
        if (query.trim().toUpperCase().startsWith('SELECT')) {
            finalQuery += " LIMIT ? OFFSET ?";
            finalParams.push(pagination.limit);
            finalParams.push(pagination.offset ?? 0); // Use default offset if not provided
        } else {
            console.warn(`[execute_query] Pagination requested but the query is not a SELECT statement. Pagination ignored.`);
        }
    }

    console.error(`[execute_query] Executing read-only SQL in DB '${databaseName}': ${finalQuery.substring(0, 100)}...`);

    try {
        connection = await pool.getConnection();
        await connection.query(`USE \`${databaseName}\`;`);

        const startTime = include_performance_metrics ? performance.now() : 0;

        // Execute the query with optional parameters
        const [results, fields] = await connection.query(finalQuery, finalParams);

        const endTime = include_performance_metrics ? performance.now() : 0;
        const executionTime = include_performance_metrics ? (endTime - startTime).toFixed(2) + ' ms' : null;

        console.error(`[execute_query] Query executed successfully in DB '${databaseName}'. ${executionTime ? `(${executionTime})` : ''}`);

        // Format results
        let resultText: string;
         if (Array.isArray(results)) {
             if (results.length > 0 && typeof results[0] === 'object' && results[0] !== null) {
                  resultText = `Query Result (${results.length} rows):\n\n${JSON.stringify(results, null, 2)}`;
             } else if (results.length === 0) {
                  resultText = `Query executed successfully. Result set is empty.`;
             } else {
                 resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
             }
         } else if (typeof results === 'object' && results !== null && ('affectedRows' in results || 'insertId' in results)) {
             const okResult = results as OkPacket | ResultSetHeader;
             resultText = `Query executed successfully (unexpected result type for read-only query).\n` +
                          `Affected Rows: ${okResult.affectedRows}\n` +
                          `Insert ID: ${'insertId' in okResult && okResult.insertId !== 0 ? okResult.insertId : 'N/A'}\n` +
                          `Changed Rows: ${'changedRows' in okResult ? okResult.changedRows : 'N/A'}`;
              console.warn(`[execute_query] Received OkPacket/ResultSetHeader for a query assumed to be read-only: ${finalQuery.substring(0,100)}...`);
         } else {
             resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
         }

        // Add performance metrics if requested
        if (executionTime) {
            resultText += `\n\nExecution Time: ${executionTime}`;
        }

        return { content: [{ type: "text", text: resultText }] };

    } catch (error: any) {
        console.error(`[execute_query] Error executing query in DB '${databaseName}':`, error);
        // Use the shared error formatter
        return formatErrorResponse('execute_query', `execute query in '${databaseName}'`, error, databaseName);
    } finally {
        if (connection) connection.release();
    }
};
export const executeQueryTool: ToolDefinition = {
  name: "execute_query",
  description: "Executes a standard read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN) with optional parameters, pagination, and performance metrics.",
  rawInputSchema: executeQueryRawInput,
  handler: executeQueryHandler,
};


// --- Tool: execute_batch ---
const executeBatchRawInput = {
    databaseName: z.string().describe("The database where the queries should be executed."),
    queries: z.array(z.string().min(1)).min(1).describe("An array of read-only SQL query strings to execute."),
    stop_on_error: z.boolean().optional().default(true).describe("If true, stops execution if any query fails. If false, attempts to run all queries."),
};
const ExecuteBatchInputSchema = z.object(executeBatchRawInput);

const executeBatchHandler = async (args: z.infer<typeof ExecuteBatchInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, queries, stop_on_error } = args;
    let connection: PoolConnection | null = null;
    const batchResults: any[] = [];
    let errorsEncountered: any[] = [];

    // 1. Validate all queries are read-only upfront
    for (let i = 0; i < queries.length; i++) {
        if (!isReadOnlyQuery(queries[i])) {
            return { isError: true, content: [{ type: "text", text: `Error: Query #${i + 1} in the batch is not a valid read-only query.` }] };
        }
    }

    console.error(`[execute_batch] Starting batch execution of ${queries.length} read-only queries in DB '${databaseName}'...`);

    try {
        connection = await pool.getConnection();
        await connection.query(`USE \`${databaseName}\`;`);

        for (let i = 0; i < queries.length; i++) {
            const query = queries[i];
            console.error(`[execute_batch] Executing query #${i + 1}: ${query.substring(0, 100)}...`);
            try {
                const [results] = await connection.query(query);
                batchResults.push({ queryIndex: i + 1, success: true, results: results });
                console.error(`[execute_batch] Query #${i + 1} executed successfully.`);
            } catch (error: any) {
                console.error(`[execute_batch] Error executing query #${i + 1}:`, error);
                const formattedError = formatErrorResponse('execute_batch', `execute query #${i+1}`, error, databaseName);
                errorsEncountered.push({ queryIndex: i + 1, error: formattedError.content[0].text }); // Store formatted error message
                batchResults.push({ queryIndex: i + 1, success: false, error: formattedError.content[0].text });
                if (stop_on_error) {
                    console.error(`[execute_batch] Stopping batch due to error on query #${i + 1}.`);
                    break; // Stop processing further queries
                }
            }
        }

        console.error(`[execute_batch] Batch execution finished. Successes: ${batchResults.filter(r => r.success).length}, Failures: ${errorsEncountered.length}`);

        // Format final response
        let responseText = `Batch Execution Summary (${batchResults.filter(r => r.success).length} Success, ${errorsEncountered.length} Failure):\n\n`;
        responseText += JSON.stringify(batchResults, null, 2); // Include detailed results/errors

        return {
            // Mark overall response as error if any query failed
            isError: errorsEncountered.length > 0,
            content: [{ type: "text", text: responseText }]
        };

    } catch (error: any) // Catch errors establishing connection or setting USE database
    {
        console.error(`[execute_batch] Error during batch setup in DB '${databaseName}':`, error);
        return formatErrorResponse('execute_batch', `set up batch execution in '${databaseName}'`, error, databaseName);
    } finally {
        if (connection) connection.release();
    }
};
export const executeBatchTool: ToolDefinition = {
  name: "execute_batch",
  description: "Executes multiple read-only SQL statements sequentially. Ensures all queries are read-only before starting. Can stop on first error or attempt all.",
  rawInputSchema: executeBatchRawInput,
  handler: executeBatchHandler,
};


// --- Tool: prepare_statement ---
const prepareStatementRawInput = {
    databaseName: z.string().describe("The database where the statement should be prepared and executed."),
    query: z.string().describe("The read-only SQL query with placeholders (?) to prepare."),
    params: z.array(z.any()).optional().describe("Optional array of parameters to bind to the placeholders for execution."),
};
const PrepareStatementInputSchema = z.object(prepareStatementRawInput);

const prepareStatementHandler = async (args: z.infer<typeof PrepareStatementInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, query, params = [] } = args;
    let connection: PoolConnection | null = null;

    // 1. Validate the query is read-only
    if (!isReadOnlyQuery(query)) {
        return { isError: true, content: [{ type: "text", text: "Error: Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) can be prepared and executed." }] };
    }

    console.error(`[prepare_statement] Preparing read-only SQL in DB '${databaseName}': ${query.substring(0, 100)}...`);

    try {
        connection = await pool.getConnection();
        await connection.query(`USE \`${databaseName}\`;`);

        // 2. Prepare and Execute
        // Note: `prepare` itself doesn't return results, `execute` does.
        // For read-only, we typically prepare and execute immediately.
        console.error(`[prepare_statement] Executing prepared statement with ${params.length} params...`);
        const [results, fields] = await connection.execute(query, params);
        console.error(`[prepare_statement] Prepared statement executed successfully.`);

        // Format results (similar to execute_query)
        let resultText: string;
         if (Array.isArray(results)) {
             if (results.length > 0 && typeof results[0] === 'object' && results[0] !== null) {
                  resultText = `Prepared Statement Result (${results.length} rows):\n\n${JSON.stringify(results, null, 2)}`;
             } else if (results.length === 0) {
                  resultText = `Prepared statement executed successfully. Result set is empty.`;
             } else {
                 resultText = `Prepared statement executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
             }
         } else { // Should not happen for read-only execute
             resultText = `Prepared statement executed. Unexpected Result:\n\n${JSON.stringify(results, null, 2)}`;
         }

        return { content: [{ type: "text", text: resultText }] };

    } catch (error: any) {
        console.error(`[prepare_statement] Error preparing/executing statement in DB '${databaseName}':`, error);
        return formatErrorResponse('prepare_statement', `prepare/execute statement in '${databaseName}'`, error, databaseName);
    } finally {
        // Prepared statements are typically cached per connection by mysql2,
        // but we don't need explicit deallocation here as we get/release connections from the pool.
        if (connection) connection.release();
    }
};
export const prepareStatementTool: ToolDefinition = {
  name: "prepare_statement",
  description: "Prepares and executes a read-only SQL statement with parameters, enhancing security and potentially performance for repeated queries.",
  rawInputSchema: prepareStatementRawInput,
  handler: prepareStatementHandler,
};


// --- Tool: get_query_history ---
const getQueryHistoryRawInput = {
    limit: z.coerce.number().int().positive().optional().default(20).describe("Maximum number of history entries to return."),
    offset: z.coerce.number().int().nonnegative().optional().default(0).describe("Number of history entries to skip."),
};
const GetQueryHistoryInputSchema = z.object(getQueryHistoryRawInput);

const getQueryHistoryHandler = async (args: z.infer<typeof GetQueryHistoryInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { limit, offset } = args;
    console.warn(`[get_query_history] Tool called, but server-side query history is not implemented.`);
    // TODO: Implement query history storage (e.g., in-memory cache per session, database table).
    // This requires managing session state or a persistent log, which is outside the current scope.
    return {
        isError: false, // Not technically an error, just not implemented
        content: [{ type: "text", text: `Query history is not currently stored or tracked by this MCP server.`+
                                        `\nRequested Limit: ${limit}, Offset: ${offset}` }]
    };
};
export const getQueryHistoryTool: ToolDefinition = {
  name: "get_query_history",
  description: "Retrieves previous queries. NOTE: Server-side query history tracking is not currently implemented.",
  rawInputSchema: getQueryHistoryRawInput,
  handler: getQueryHistoryHandler,
};


// --- Tool: explain_query ---
const explainQueryRawInput = {
    databaseName: z.string().describe("The database context for the query."),
    query: z.string().describe("The SQL query to explain (SELECT, INSERT, UPDATE, DELETE)."),
    format: z.enum(["TEXT", "JSON"]).optional().default("TEXT").describe("Output format for EXPLAIN ('TEXT' or 'JSON')."),
};
const ExplainQueryInputSchema = z.object(explainQueryRawInput);

const explainQueryHandler = async (args: z.infer<typeof ExplainQueryInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, query, format } = args;
    let connection: PoolConnection | null = null;

    // Note: The query being explained *can* be a write query. EXPLAIN itself is read-only.
    // No need to call isReadOnlyQuery on args.query here.

    const explainPrefix = format === 'JSON' ? 'EXPLAIN FORMAT=JSON ' : 'EXPLAIN ';
    const explainQuery = explainPrefix + query;

    console.error(`[explain_query] Explaining query in DB '${databaseName}': ${explainQuery.substring(0, 150)}...`);

    try {
        connection = await pool.getConnection();
        await connection.query(`USE \`${databaseName}\`;`);

        const [results] = await connection.query(explainQuery);
        console.error(`[explain_query] EXPLAIN executed successfully.`);

        let resultText: string;
        if (format === 'JSON') {
            // Results should be an array containing a single row with the JSON plan
             const jsonPlan = results && Array.isArray(results) && results.length > 0 ? results[0] : null;
             resultText = `EXPLAIN Query Plan (JSON):\n\n${JSON.stringify(jsonPlan, null, 2)}`;
        } else {
             // Format TEXT output (often comes as multiple rows)
             if (Array.isArray(results)) {
                  // Simple formatting: join rows, assuming text format
                  resultText = `EXPLAIN Query Plan (TEXT):\n\n` +
                                results.map(row => Object.values(row).join('\t')).join('\n');
             } else {
                  resultText = `EXPLAIN Query Plan (TEXT):\n\n${JSON.stringify(results)}`; // Fallback
             }
        }

        return { content: [{ type: "text", text: resultText }] };

    } catch (error: any) {
        console.error(`[explain_query] Error executing EXPLAIN in DB '${databaseName}':`, error);
        // Provide specific error message if EXPLAIN fails (e.g., syntax error in original query)
         if (error.code === 'ER_PARSE_ERROR') {
             return formatErrorResponse('explain_query', `explain query due to syntax error in the original query`, error, databaseName);
         }
        return formatErrorResponse('explain_query', `explain query in '${databaseName}'`, error, databaseName);
    } finally {
        if (connection) connection.release();
    }
};
export const explainQueryTool: ToolDefinition = {
  name: "explain_query",
  description: "Retrieves the query execution plan (EXPLAIN) for a given SQL statement in TEXT or JSON format.",
  rawInputSchema: explainQueryRawInput,
  handler: explainQueryHandler,
};


// --- Aggregate Execution Tools ---
export const executionTools: ToolDefinition[] = [
    executeQueryTool,
    executeBatchTool,
    prepareStatementTool,
    getQueryHistoryTool,
    explainQueryTool,
];
