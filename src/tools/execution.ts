// src/tools/execution.ts
import { z } from 'zod';
import type { McpToolResponse, ToolDefinition, DatabaseType } from './types.js';
// Import pgConfig to potentially pass the configured DB name if needed by adapter methods
import { MySqlAdapter, PostgresAdapter, IDatabaseAdapter, QueryResult } from '../db_adapter.js';
import { pgConfig, pgPool } from '../config.js'; // Import pgPool for direct client usage
import type { PoolClient as PgClient } from 'pg'; // Import PgClient type
import { performance } from 'perf_hooks';

// --- Helper Function to Get Adapter ---
function getDbAdapter(dbType: DatabaseType): IDatabaseAdapter {
    if (dbType === 'mysql') { return new MySqlAdapter(); }
    else if (dbType === 'postgres') { return new PostgresAdapter(); }
    else { throw new Error(`Unsupported database type: ${dbType}`); }
}

// --- Tool: ping ---
// No changes needed
const pingRawInput = {
    message: z.string().optional().default("Ping").describe("Optional message to include in the pong response.")
};
const PingInputSchema = z.object(pingRawInput);
const pingHandler = async (args: z.infer<typeof PingInputSchema>, extra: any): Promise<McpToolResponse> => {
    console.error(`[ping] Received ping with message: ${args.message}`);
    const response: McpToolResponse = {
        isError: false,
        content: [{ type: "text", text: `Pong! (${args.message})` }]
    };
    console.error(`[ping] Returning pong.`);
    return response;
};
export const pingTool: ToolDefinition = {
  name: "ping",
  description: "A simple tool to check if the MCP server is responding. Returns 'Pong!'",
  rawInputSchema: pingRawInput,
  handler: pingHandler,
};


// --- Tool: execute_query ---
const executeQueryRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public'). Users should qualify table names in the query if not using the default search path."),
    query: z.string().describe("The read-only SQL query to execute."),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Optional array of parameters for parameterized queries (e.g., using ? or $1 placeholders)."),
    pagination: z.object({
        limit: z.coerce.number().int().positive().describe("Maximum number of rows to return."),
        offset: z.coerce.number().int().nonnegative().optional().default(0).describe("Number of rows to skip."),
    }).optional().describe("Optional pagination for SELECT queries."),
    include_performance_metrics: z.boolean().optional().default(false).describe("Whether to include query execution time in the response."),
};
const ExecuteQueryInputSchema = z.object(executeQueryRawInput);
const executeQueryHandler = async (args: z.infer<typeof ExecuteQueryInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, query, params = [], pagination, include_performance_metrics } = args;
    const schemaName = args.schemaName || (databaseType === 'postgres' ? 'public' : undefined); // Default schema for PG

    let adapter: IDatabaseAdapter;
    let identifier: string | undefined;
    let executionDbName: string; // DB name passed to MySQL adapter
    let contextType: string;
    let pgClient: PgClient | null = null; // Explicit client for PG transactions

    try {
        adapter = getDbAdapter(databaseType);

        if (databaseType === 'mysql') {
            if (!databaseName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'databaseName' for databaseType 'mysql'." }] };
            identifier = databaseName;
            executionDbName = databaseName;
            contextType = 'database';
        } else { // postgres
            if (!schemaName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'schemaName' for databaseType 'postgres'." }] };
            if (!pgPool) throw new Error("PostgreSQL pool is not initialized."); // Ensure pool exists
            identifier = schemaName;
            executionDbName = pgConfig.database || 'postgres'; // Not directly used by query execution, but for context
            contextType = 'schema';
            // Get client for transaction
            pgClient = await pgPool.connect();
        }

    } catch (error: any) {
        if (pgClient) pgClient.release(); // Release client if connection failed after getting it
        return { isError: true, content: [{ type: "text", text: `Failed to initialize database adapter or connection: ${error.message}` }] };
    }

    let finalQuery = query;
    let finalParams = [...params];

    if (!adapter.isReadOnlyQuery(query)) {
        if (pgClient) pgClient.release();
        return adapter.formatError('execute_query', 'check read-only status', { message: "Only read-only queries (SELECT, SHOW, EXPLAIN, DESCRIBE) are allowed." }, identifier, undefined);
    }

    if (pagination) {
        if (query.trim().match(/^SELECT/i) || query.trim().match(/^WITH/i)) {
             const limitPlaceholder = databaseType === 'postgres' ? `$${finalParams.length + 1}` : '?';
             const offsetPlaceholder = databaseType === 'postgres' ? `$${finalParams.length + 2}` : '?';
             finalQuery += ` LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;
             finalParams.push(pagination.limit);
             finalParams.push(pagination.offset ?? 0);
             console.error(`[${databaseType}-execute_query] Applying pagination: LIMIT ${pagination.limit}, OFFSET ${pagination.offset ?? 0}`);
        } else {
            console.warn(`[${databaseType}-execute_query] Pagination requested but the query is not a SELECT/WITH statement. Pagination ignored.`);
        }
    }

    console.error(`[${databaseType}-execute_query] Executing read-only SQL in ${contextType} context '${identifier}': ${finalQuery.substring(0, 100)}...`);

    try {
        const startTime = performance.now();
        let results: QueryResult;

        if (databaseType === 'postgres' && pgClient && identifier) {
            // Use transaction to set search_path locally for this query
            await pgClient.query('BEGIN');
            // Set search_path: specified schema first, then public as fallback
            await pgClient.query(`SET LOCAL search_path TO ${pgClient.escapeIdentifier(identifier)}, public`);
            console.error(`[postgres-execute_query] Set LOCAL search_path to '${identifier}, public'`);
            const pgQueryResult = await pgClient.query(finalQuery, finalParams);
            await pgClient.query('COMMIT'); // Commit transaction
            // Format result similar to adapter's executeQuery
            results = {
                 rows: pgQueryResult.rows,
                 fields: pgQueryResult.fields.map(f => ({ name: f.name, tableID: f.tableID, columnID: f.columnID, dataTypeID: f.dataTypeID })),
                 rowCount: pgQueryResult.rowCount,
                 command: pgQueryResult.command,
             };
        } else {
            // MySQL execution (or PG error before client connection)
            results = await adapter.executeQuery(executionDbName, finalQuery, finalParams);
        }

        const endTime = performance.now();
        const executionTime = include_performance_metrics ? (endTime - startTime).toFixed(2) + ' ms' : null;

        console.error(`[${databaseType}-execute_query] Query executed successfully in ${contextType} context '${identifier}'. ${executionTime ? `(${executionTime})` : ''}`);

        let resultText: string;
        if (results.rows && results.rows.length > 0) {
            resultText = `Query Result (${results.rows.length} rows):\n\n${JSON.stringify(results.rows, null, 2)}`;
        } else if (results.rows && results.rows.length === 0) {
            resultText = `Query executed successfully. Result set is empty.`;
            if (results.affectedRows !== undefined) { resultText += `\nAffected Rows: ${results.affectedRows}`; }
        } else if (results.affectedRows !== undefined) {
            resultText = `Query executed successfully.\nAffected Rows: ${results.affectedRows}`;
             if (results.insertId !== undefined) { resultText += `\nInsert ID: ${results.insertId}`; }
        } else {
            resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
        }
        if (executionTime) { resultText += `\n\nExecution Time: ${executionTime}`; }

        return { content: [{ type: "text", text: resultText }] };
    } catch (error: any) {
        console.error(`[${databaseType}-execute_query] Error executing query in ${contextType} context '${identifier}':`, error);
        if (pgClient) {
            try { await pgClient.query('ROLLBACK'); } catch (rbErr) { console.error('Error rolling back PG transaction:', rbErr); }
        }
        return adapter.formatError('execute_query', `execute query in ${contextType} context '${identifier}'`, error, identifier);
    } finally {
        if (pgClient) {
            pgClient.release();
            console.error(`[postgres-execute_query] Released PG client.`);
        }
    }
};
export const executeQueryTool: ToolDefinition = {
    name: "execute_query",
    description: "Executes a standard read-only SQL query (SELECT, SHOW, EXPLAIN, DESCRIBE). Requires 'databaseName' for MySQL context, or 'schemaName' for PostgreSQL context (sets search_path). Supports parameters and pagination.",
    rawInputSchema: executeQueryRawInput,
    handler: executeQueryHandler,
};

// --- Tool: execute_batch ---
// Similar logic: use transaction and SET LOCAL search_path for PG
const executeBatchRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public')."),
    queries: z.array(z.string().min(1)).min(1).describe("An array of one or more read-only SQL statements to execute sequentially."),
    stop_on_error: z.boolean().optional().default(true).describe("If true, stops execution if any query fails. If false, attempts all queries."),
};
const ExecuteBatchInputSchema = z.object(executeBatchRawInput);
const executeBatchHandler = async (args: z.infer<typeof ExecuteBatchInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, queries, stop_on_error } = args;
    const schemaName = args.schemaName || (databaseType === 'postgres' ? 'public' : undefined); // Default schema for PG
    let adapter: IDatabaseAdapter;
    const batchResults: any[] = [];
    let errorsEncountered: any[] = [];
    let identifier: string | undefined;
    let executionDbName: string;
    let contextType: string;
    let pgClient: PgClient | null = null;

    try {
        adapter = getDbAdapter(databaseType);
        if (databaseType === 'mysql') {
            if (!databaseName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'databaseName' for databaseType 'mysql'." }] };
            identifier = databaseName;
            executionDbName = databaseName;
            contextType = 'database';
        } else { // postgres
            if (!schemaName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'schemaName' for databaseType 'postgres'." }] };
            if (!pgPool) throw new Error("PostgreSQL pool is not initialized.");
            identifier = schemaName;
            executionDbName = pgConfig.database || 'postgres';
            contextType = 'schema';
            pgClient = await pgPool.connect(); // Get client for transaction
        }
    } catch (error: any) {
         if (pgClient) pgClient.release();
        return { isError: true, content: [{ type: "text", text: `Failed to initialize database adapter or connection: ${error.message}` }] };
    }

    // Pre-check all queries for read-only status
    for (let i = 0; i < queries.length; i++) {
        if (!adapter.isReadOnlyQuery(queries[i])) {
            if (pgClient) pgClient.release();
            return adapter.formatError('execute_batch', `check read-only status for query #${i + 1}`, { message: `Query #${i + 1} in the batch is not a valid read-only query.` }, identifier);
        }
    }

    console.error(`[${databaseType}-execute_batch] Starting batch execution of ${queries.length} read-only queries in ${contextType} context '${identifier}'...`);

    try {
        if (databaseType === 'postgres' && pgClient && identifier) {
            // Use a single transaction for the whole batch with the correct search_path
            await pgClient.query('BEGIN');
            await pgClient.query(`SET LOCAL search_path TO ${pgClient.escapeIdentifier(identifier)}, public`);
            console.error(`[postgres-execute_batch] Set LOCAL search_path to '${identifier}, public' for batch`);

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                console.error(`[postgres-execute_batch] Executing query #${i + 1}: ${query.substring(0, 100)}...`);
                try {
                    const results = await pgClient.query(query); // Execute within transaction
                    batchResults.push({ queryIndex: i + 1, success: true, results: results.rows });
                    console.error(`[postgres-execute_batch] Query #${i + 1} executed successfully.`);
                } catch (error: any) {
                    console.error(`[postgres-execute_batch] Error executing query #${i + 1}:`, error);
                    const formattedError = adapter.formatError('execute_batch', `execute query #${i+1}`, error, identifier);
                    errorsEncountered.push({ queryIndex: i + 1, error: formattedError.content[0].text });
                    batchResults.push({ queryIndex: i + 1, success: false, error: formattedError.content[0].text });
                    if (stop_on_error) {
                        console.error(`[postgres-execute_batch] Stopping batch due to error on query #${i + 1}. Rolling back.`);
                        await pgClient.query('ROLLBACK'); // Rollback on error if stop_on_error is true
                        throw new Error(`Batch stopped due to error on query #${i + 1}`); // Stop further processing
                    }
                    // If not stopping on error, continue to next query
                }
            }
            // If loop completes without stop_on_error rollback, commit the transaction
             if (errorsEncountered.length === 0 || !stop_on_error) {
                 await pgClient.query('COMMIT');
                 console.error(`[postgres-execute_batch] Committed transaction.`);
             }

        } else { // MySQL execution
            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                console.error(`[mysql-execute_batch] Executing query #${i + 1}: ${query.substring(0, 100)}...`);
                try {
                    const results = await adapter.executeQuery(executionDbName, query);
                    batchResults.push({ queryIndex: i + 1, success: true, results: results.rows });
                    console.error(`[mysql-execute_batch] Query #${i + 1} executed successfully.`);
                } catch (error: any) {
                    console.error(`[mysql-execute_batch] Error executing query #${i + 1}:`, error);
                    const formattedError = adapter.formatError('execute_batch', `execute query #${i+1}`, error, identifier);
                    errorsEncountered.push({ queryIndex: i + 1, error: formattedError.content[0].text });
                    batchResults.push({ queryIndex: i + 1, success: false, error: formattedError.content[0].text });
                    if (stop_on_error) {
                        console.error(`[mysql-execute_batch] Stopping batch due to error on query #${i + 1}.`);
                        break;
                    }
                }
            }
        }
    } catch (batchError: any) {
        // Catch errors from transaction management or the re-thrown error on stop_on_error
        console.error(`[${databaseType}-execute_batch] Error during batch execution in ${contextType} context '${identifier}':`, batchError);
        // Ensure rollback if client exists and error occurred during transaction
         if (pgClient && !(batchError.message?.includes('Batch stopped due to error'))) { // Avoid double rollback message
             try { await pgClient.query('ROLLBACK'); console.error(`[postgres-execute_batch] Rolled back transaction due to batch error.`); } catch (rbErr) { console.error('Error rolling back PG transaction after batch error:', rbErr); }
         }
         // Return only if it's not the deliberately thrown error
          if (!(batchError.message?.includes('Batch stopped due to error'))) {
              return adapter.formatError('execute_batch', `execute batch in ${contextType} context '${identifier}'`, batchError, identifier);
          }
          // If it was the stop_on_error, the results are already populated for the summary below.
    } finally {
         if (pgClient) {
             pgClient.release();
             console.error(`[postgres-execute_batch] Released PG client.`);
         }
    }

    console.error(`[${databaseType}-execute_batch] Batch execution finished. Successes: ${batchResults.filter(r => r.success).length}, Failures: ${errorsEncountered.length}`);
    let responseText = `Batch Execution Summary (${batchResults.filter(r => r.success).length} Success, ${errorsEncountered.length} Failure):\n\n`;
    responseText += JSON.stringify(batchResults, null, 2);

    return {
        isError: errorsEncountered.length > 0,
        content: [{ type: "text", text: responseText }]
    };
};
export const executeBatchTool: ToolDefinition = {
    name: "execute_batch",
    description: "Executes multiple read-only SQL statements sequentially. Requires 'databaseName' for MySQL context, or 'schemaName' for PostgreSQL context (sets search_path).",
    rawInputSchema: executeBatchRawInput,
    handler: executeBatchHandler,
};

// --- Tool: prepare_statement ---
// Treat similarly to execute_query regarding context and PG search_path
const prepareStatementRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public')."),
    query: z.string().describe("The read-only SQL query template with placeholders (e.g., ?, $1)."),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default([]).describe("Array of parameter values to bind to the query placeholders."),
};
const PrepareStatementInputSchema = z.object(prepareStatementRawInput);
const prepareStatementHandler = async (args: z.infer<typeof PrepareStatementInputSchema>, extra: any): Promise<McpToolResponse> => {
    // This handler can reuse the executeQueryHandler logic as the adapter handles parameterization internally
     const { databaseType, databaseName, schemaName, query, params = [] } = args;
     console.warn(`[${databaseType}-prepare_statement] Executing as standard query. True prepare/execute cycle not implemented separately.`);
     // Call executeQueryHandler with the same arguments
     return executeQueryHandler({
        databaseType,
        databaseName, // Pass along even if potentially undefined for PG case within executeQueryHandler
        schemaName,   // Pass along schemaName
        query,
        params,
        // Add other executeQuery args if needed (pagination, include_performance_metrics defaults to false)
        include_performance_metrics: false,
     }, extra);
};
export const prepareStatementTool: ToolDefinition = {
    name: "prepare_statement",
    description: "Executes a read-only SQL statement with parameters (Note: currently executes directly, not via true prepare/execute cycle). Requires 'databaseName' for MySQL context, or 'schemaName' for PostgreSQL context (sets search_path).",
    rawInputSchema: prepareStatementRawInput,
    handler: prepareStatementHandler,
};

// --- Tool: get_query_history ---
// No changes needed
const getQueryHistoryRawInput = {
    limit: z.coerce.number().int().positive().optional().default(20).describe("Maximum number of history entries to return."),
    offset: z.coerce.number().int().nonnegative().optional().default(0).describe("Number of history entries to skip."),
};
const GetQueryHistoryInputSchema = z.object(getQueryHistoryRawInput);
const getQueryHistoryHandler = async (args: z.infer<typeof GetQueryHistoryInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { limit, offset } = args;
    console.error(`[get_query_history] Tool called, but server-side query history is not implemented.`);
    return {
        isError: false,
        content: [{ type: "text", text: `Query history is not currently stored or tracked by this server.` }]
    };
};
export const getQueryHistoryTool: ToolDefinition = {
    name: "get_query_history",
    description: "Retrieves previous queries executed via this server. NOTE: Server-side history is not currently implemented.",
    rawInputSchema: getQueryHistoryRawInput,
    handler: getQueryHistoryHandler,
};

// --- Tool: explain_query ---
// Use transaction and SET LOCAL search_path for PG
const explainQueryRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public')."),
    query: z.string().describe("The SQL query to explain."),
    format: z.enum(["TEXT", "JSON"]).optional().default("TEXT").describe("Output format for the execution plan (TEXT or JSON)."),
};
const ExplainQueryInputSchema = z.object(explainQueryRawInput);
const explainQueryHandler = async (args: z.infer<typeof ExplainQueryInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, query, format } = args;
    const schemaName = args.schemaName || (databaseType === 'postgres' ? 'public' : undefined); // Default schema for PG
    let adapter: IDatabaseAdapter;
    let identifier: string | undefined;
    let executionDbName: string;
    let contextType: string;
    let pgClient: PgClient | null = null;

    try {
        adapter = getDbAdapter(databaseType);
        if (databaseType === 'mysql') {
            if (!databaseName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'databaseName' for databaseType 'mysql'." }] };
            identifier = databaseName;
            executionDbName = databaseName;
            contextType = 'database';
        } else { // postgres
            if (!schemaName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'schemaName' for databaseType 'postgres'." }] };
             if (!pgPool) throw new Error("PostgreSQL pool is not initialized.");
            identifier = schemaName;
            executionDbName = pgConfig.database || 'postgres';
            contextType = 'schema';
            pgClient = await pgPool.connect(); // Get client for transaction
        }
    } catch (error: any) {
         if (pgClient) pgClient.release();
         return { isError: true, content: [{ type: "text", text: `Failed to initialize database adapter or connection: ${error.message}` }] };
    }

    console.error(`[${databaseType}-explain_query] Explaining query in ${contextType} context '${identifier}' (Format: ${format}): ${query.substring(0, 150)}...`);

    try {
        let results: QueryResult;
        const explainPrefix = format === 'JSON' ? 'EXPLAIN (FORMAT JSON) ' : 'EXPLAIN ';
        const explainQuery = explainPrefix + query;

        if (databaseType === 'postgres' && pgClient && identifier) {
             // Use transaction to set search_path locally for this query
            await pgClient.query('BEGIN');
            await pgClient.query(`SET LOCAL search_path TO ${pgClient.escapeIdentifier(identifier)}, public`);
             console.error(`[postgres-explain_query] Set LOCAL search_path to '${identifier}, public'`);
            const pgQueryResult = await pgClient.query(explainQuery); // Use explainQuery
            await pgClient.query('COMMIT'); // Commit transaction

             // Format result similar to adapter's explainQuery
             results = {
                 rows: pgQueryResult.rows,
                 fields: pgQueryResult.fields.map(f => ({ name: f.name, tableID: f.tableID, columnID: f.columnID, dataTypeID: f.dataTypeID })),
                 rowCount: pgQueryResult.rowCount,
                 command: pgQueryResult.command,
             };
        } else {
             // MySQL execution
             results = await adapter.explainQuery(executionDbName, query, format); // Use original query here
        }

        console.error(`[${databaseType}-explain_query] EXPLAIN executed successfully.`);

        let resultText: string;
        // Format based on expected output
        if (format === 'JSON') {
            // PG EXPLAIN (FORMAT JSON) returns an array containing one object with the plan
             const planData = (databaseType === 'postgres' && Array.isArray(results.rows) && results.rows.length > 0 && results.rows[0]['QUERY PLAN'])
                ? results.rows[0]['QUERY PLAN'] // Extract the actual plan array
                : results.rows; // Use rows directly for MySQL or if structure differs
            resultText = `EXPLAIN Query Plan (JSON):\n\n${JSON.stringify(planData, null, 2)}`;
        } else { // TEXT format
            if (Array.isArray(results.rows)) {
                 resultText = `EXPLAIN Query Plan (TEXT):\n\n` +
                    results.rows.map(row =>
                        typeof row === 'object' && row !== null
                        ? Object.values(row).join('\t')
                        : String(row)
                    ).join('\n');
            } else {
                 resultText = `EXPLAIN Query Plan (TEXT):\n\n${JSON.stringify(results.rows)}`;
            }
        }
        return { content: [{ type: "text", text: resultText }] };
    } catch (error: any) {
        console.error(`[${databaseType}-explain_query] Error executing EXPLAIN in ${contextType} context '${identifier}':`, error);
         if (pgClient) {
            try { await pgClient.query('ROLLBACK'); } catch (rbErr) { console.error('Error rolling back PG transaction:', rbErr); }
        }
        return adapter.formatError('explain_query', `explain query in ${contextType} context '${identifier}'`, error, identifier);
    } finally {
         if (pgClient) {
             pgClient.release();
             console.error(`[postgres-explain_query] Released PG client.`);
         }
    }
};
export const explainQueryTool: ToolDefinition = {
    name: "explain_query",
    description: "Retrieves the query execution plan (EXPLAIN) for a given SQL statement. Requires 'databaseName' for MySQL context, or 'schemaName' for PostgreSQL context (sets search_path).",
    rawInputSchema: explainQueryRawInput,
    handler: explainQueryHandler,
};

// --- Aggregate Execution Tools ---
export const executionTools: ToolDefinition[] = [
    pingTool,
    executeQueryTool,
    executeBatchTool,
    prepareStatementTool,
    getQueryHistoryTool,
    explainQueryTool,
];
