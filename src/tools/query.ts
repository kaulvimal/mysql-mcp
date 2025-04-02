// src/tools/query.ts
import { z } from 'zod';
import { pool } from '../config.js'; // Import the pool
import type { McpToolResponse, ToolDefinition } from './types.js'; // Import shared types
import type { PoolConnection, OkPacket, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

// Define the raw shape for Zod validation
const runSqlQueryRawInput = {
  databaseName: z.string().describe("The name of the database to run the query against."),
  sqlQuery: z.string().describe("The read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN) to execute."), // Updated description
};

// --- Read-Only Query Check ---
const ALLOWED_QUERY_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'WITH']; // Allow CTEs before SELECT
const FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'GRANT', 'REVOKE', 'SET', 'LOCK', 'UNLOCK', 'CALL', 'LOAD', 'HANDLER', 'DO'
    // Add more potentially harmful keywords if necessary
];

function isReadOnlyQuery(query: string): boolean {
    const upperQuery = query.trim().toUpperCase();

    // Check for forbidden keywords anywhere in the query (basic check)
    // Note: This might block legitimate SELECTs with comments containing these words.
    // A more robust SQL parser would be needed for perfect accuracy.
    if (FORBIDDEN_KEYWORDS.some(keyword => upperQuery.includes(keyword + ' ') || upperQuery.includes(keyword + '('))) {
        // Double check if it's a SELECT statement despite containing a keyword (e.g., in a comment or string literal)
        // This is still imperfect.
        if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('WITH')) {
             console.warn(`[run-sql-query] Query rejected: Contains forbidden keyword.`);
             return false;
        }
    }

    // Check if the query starts with an allowed prefix
    if (!ALLOWED_QUERY_PREFIXES.some(prefix => upperQuery.startsWith(prefix + ' ') || upperQuery.startsWith(prefix + '('))) {
         console.warn(`[run-sql-query] Query rejected: Does not start with allowed prefix (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH).`);
        return false;
    }

    // Basic check passed
    return true;
}

// Define the handler function for the tool
const runSqlQueryHandler = async (args: { databaseName: string; sqlQuery: string; }, extra: any): Promise<McpToolResponse> => {
  const { databaseName, sqlQuery } = args;
  let connection: PoolConnection | null = null;

  // --- Enforce Read-Only ---
  if (!isReadOnlyQuery(sqlQuery)) {
      return {
          isError: true,
          content: [{ type: "text", text: "Error: Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed." }]
      };
  }
  // --- End Read-Only Enforcement ---


  console.error(`[run-sql-query] Executing read-only SQL in DB '${databaseName}': ${sqlQuery.substring(0, 100)}...`);

  try {
    connection = await pool.getConnection();
    await connection.query(`USE \`${databaseName}\`;`);

    const [results] = await connection.query(sqlQuery);
    console.error(`[run-sql-query] Query executed successfully in DB '${databaseName}'.`);

    // Format results (same logic as before, should only get results from read-only queries now)
    let resultText: string;
    if (Array.isArray(results)) {
        if (results.length > 0 && typeof results[0] === 'object' && results[0] !== null) {
             resultText = `Query Result (${results.length} rows):\n\n${JSON.stringify(results, null, 2)}`;
        } else if (results.length === 0) {
             resultText = `Query executed successfully. Result set is empty.`;
        }
         else {
            resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
        }
    } else if (typeof results === 'object' && results !== null && ('affectedRows' in results || 'insertId' in results)) {
      // This block should ideally not be reached with read-only enforcement, but kept as fallback
      const okResult = results as OkPacket | ResultSetHeader;
      resultText = `Query executed successfully (unexpected result type for read-only query).\n` +
                   `Affected Rows: ${okResult.affectedRows}\n` +
                   `Insert ID: ${'insertId' in okResult && okResult.insertId !== 0 ? okResult.insertId : 'N/A'}\n` +
                   `Changed Rows: ${'changedRows' in okResult ? okResult.changedRows : 'N/A'}`;
       console.warn(`[run-sql-query] Received OkPacket/ResultSetHeader for a query assumed to be read-only: ${sqlQuery.substring(0,100)}...`);
    } else {
      resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
    }

    return { content: [{ type: "text", text: resultText }] };

  } catch (error: any) {
    console.error(`[run-sql-query] Error executing query in DB '${databaseName}':`, error);
    let errorMessage = `Failed to execute query in database '${databaseName}'.`;
    if (error.code === 'ER_BAD_DB_ERROR') errorMessage = `Database '${databaseName}' does not exist or access denied.`;
    else if (error.code === 'ER_PARSE_ERROR') errorMessage = `SQL Syntax Error: ${error.message || 'Check your query syntax.'}`;
    else if (error.code === 'ER_NO_SUCH_TABLE') errorMessage = `Table mentioned in the query does not exist in database '${databaseName}'.`;
    else if (error.code === 'ER_BAD_FIELD_ERROR') errorMessage = `Column mentioned in the query does not exist.`;
    else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') errorMessage = `Could not connect to the MySQL database host '${pool.config.host}'.`;
    else if (error.code === 'ER_ACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${pool.config.user}' to the database server.`;
    else if (error.code === 'ER_DBACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${pool.config.user}' to database '${databaseName}'.`;
    else if (error.code === 'ER_TABLEACCESS_DENIED_ERROR') errorMessage = `Table/view access denied for user '${pool.config.user}'.`;
    else if (error.code === 'ER_COLUMNACCESS_DENIED_ERROR') errorMessage = `Column access denied for user '${pool.config.user}'.`;

    return { isError: true, content: [{ type: "text", text: errorMessage + `\nServer Details: ${error.message || error}` }] };
  } finally {
    if (connection) connection.release();
  }
};

// Export the tool definition object conforming to ToolDefinition type
export const runSqlQueryTool: ToolDefinition = {
  name: "run-sql-query",
  description: "Executes a given READ-ONLY SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN) against a specified MySQL database.", // Updated description
  rawInputSchema: runSqlQueryRawInput,
  handler: runSqlQueryHandler,
};
