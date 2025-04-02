// src/tools/query.ts
import { z } from 'zod';
import mysql, { OkPacket, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { dbConfig } from '../config.js'; // Use .js extension for relative import

// Define the raw shape for Zod validation
const runSqlQueryRawInput = {
  databaseName: z.string().describe("The name of the database to run the query against."),
  sqlQuery: z.string().describe("The SQL query to execute. IMPORTANT: Ensure this query is safe and intended."),
};

type McpToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Define the handler function for the tool
// Use explicit types for args based on the raw shape
const runSqlQueryHandler = async (args: { databaseName: string; sqlQuery: string; }, extra: any): Promise<McpToolResponse> => {
  const { databaseName, sqlQuery } = args;
  let connection: mysql.Connection | null = null;

  const trimmedQuery = sqlQuery.trim().toUpperCase();
  if (trimmedQuery.startsWith('DROP ') || trimmedQuery.startsWith('DELETE ') || trimmedQuery.startsWith('UPDATE ') || trimmedQuery.startsWith('INSERT ')) {
     console.warn(`[run-sql-query] WARNING: Executing potentially destructive query type.`);
  }

  try {
    connection = await mysql.createConnection(dbConfig);
    await connection.query(`USE \`${databaseName}\`;`);

    console.error(`[run-sql-query] Executing SQL in DB '${databaseName}': ${sqlQuery.substring(0, 100)}...`);
    const [results] = await connection.query(sqlQuery);
    console.error(`[run-sql-query] Query executed successfully.`);

    // Format results
    let resultText: string;
    if (Array.isArray(results)) {
      resultText = `Query Result (${results.length} rows):\n\n${JSON.stringify(results, null, 2)}`;
    } else if (typeof results === 'object' && results !== null && ('affectedRows' in results || 'insertId' in results)) {
      const okResult = results as OkPacket | ResultSetHeader;
      resultText = `Query executed successfully.\n` +
                   `Affected Rows: ${okResult.affectedRows}\n` +
                   `Insert ID: ${'insertId' in okResult ? okResult.insertId : 'N/A'}\n` +
                   `Changed Rows: ${'changedRows' in okResult ? okResult.changedRows : 'N/A'}`;
    } else {
      resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
    }

    return { content: [{ type: "text", text: resultText }] };

  } catch (error: any) {
    console.error(`[run-sql-query] Error executing query:`, error);
    let errorMessage = `Failed to execute query in database '${databaseName}'.`;
    if (error.code === 'ER_BAD_DB_ERROR') errorMessage = `Database '${databaseName}' does not exist or access denied.`;
    else if (error.code === 'ER_PARSE_ERROR') errorMessage = `SQL Syntax Error near '${error.sqlMessage?.substring(0, 100)}...'`;
    else if (error.code === 'ER_NO_SUCH_TABLE') errorMessage = `Table mentioned in query does not exist.`;
    else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') errorMessage = `Could not connect to the MySQL database host '${dbConfig.host}'.`;
    else if (error.code === 'ER_ACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${dbConfig.user}' to the database.`;
    else if (error.code === 'ER_DBACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${dbConfig.user}' to database '${databaseName}'.`;

    return { isError: true, content: [{ type: "text", text: errorMessage + `\nDetails: ${error.message || error}` }] };
  } finally {
    if (connection) await connection.end();
  }
};

// Export the tool definition object
export const runSqlQueryTool = {
  name: "run-sql-query",
  description: "Executes a given SQL query against a specified MySQL database. WARNING: This tool allows executing arbitrary SQL and can modify or delete data if the DB user has permissions. Use with extreme caution.",
  rawInputSchema: runSqlQueryRawInput,
  handler: runSqlQueryHandler,
};
