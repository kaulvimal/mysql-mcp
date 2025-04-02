// src/tools/schema.ts
import { z } from 'zod';
import { pool } from '../config.js'; // Import the pool
import type { McpToolResponse, ToolDefinition } from './types.js'; // Import shared types
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Define the raw shape for Zod validation
const getTableColumnsRawInput = {
  databaseName: z.string().describe("The name of the database containing the table."),
  tableName: z.string().describe("The name of the table whose columns you want to retrieve."),
};

// Define the handler function for the tool
// Use explicit types for args based on the raw shape
const getTableColumnsHandler = async (args: { databaseName: string; tableName: string; }, extra: any): Promise<McpToolResponse> => {
  const { databaseName, tableName } = args;
  let connection: PoolConnection | null = null; // Use PoolConnection type

  try {
    connection = await pool.getConnection(); // Get connection from pool
    await connection.query(`USE \`${databaseName}\`;`);
    // DESCRIBE is simple and effective for column listing
    const [rows] = await connection.query<RowDataPacket[]>(`DESCRIBE \`${tableName}\`;`);

    if (!rows || rows.length === 0) {
      // Table might exist but be empty, DESCRIBE still works. This means table not found or access denied.
      // Check for specific errors if needed, but the query failure will be caught below.
      // For now, assume query success means table exists. If rows are empty, it implies an issue caught by the catch block.
       return { isError: true, content: [{ type: "text", text: `Could not retrieve columns for table '${tableName}' in database '${databaseName}'. It might not exist or you lack permissions.` }] };
    }

    let schemaDescription = `Columns for table '${tableName}' in database '${databaseName}':\n\n`;
    schemaDescription += rows.map(row =>
      `- Column: ${row.Field}\n  Type: ${row.Type}\n  Null: ${row.Null}\n  Key: ${row.Key || 'N/A'}\n  Default: ${row.Default === null ? 'NULL' : row.Default || 'N/A'}\n  Extra: ${row.Extra || 'N/A'}`
    ).join('\n\n');

    return { content: [{ type: "text", text: schemaDescription }] };

  } catch (error: any) {
    console.error(`[get_table_columns] Error:`, error); // Log full error server-side
    let errorMessage = `Failed to retrieve columns for table '${tableName}' in database '${databaseName}'.`;
    // Map common error codes
    if (error.code === 'ER_BAD_DB_ERROR') errorMessage = `Database '${databaseName}' does not exist or access denied.`;
    else if (error.code === 'ER_NO_SUCH_TABLE') errorMessage = `Table '${tableName}' does not exist in database '${databaseName}'.`;
    else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') errorMessage = `Could not connect to the MySQL database host '${pool.config.host}'.`;
    else if (error.code === 'ER_ACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${pool.config.user}' to the database server.`;
    else if (error.code === 'ER_DBACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${pool.config.user}' to database '${databaseName}'.`;
    else if (error.code === 'ER_TABLEACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${pool.config.user}' to table '${tableName}'.`;


    return { isError: true, content: [{ type: "text", text: errorMessage + `\nServer Details: ${error.message || error}` }] }; // Provide server details cautiously
  } finally {
    if (connection) connection.release(); // Release connection back to pool
  }
};

// Export the tool definition object conforming to ToolDefinition type
export const getTableColumnsTool: ToolDefinition = {
  name: "get_table_columns", // Renamed from get-table-schema
  description: "Retrieves the column definitions (schema) of a specific MySQL table.",
  rawInputSchema: getTableColumnsRawInput,
  handler: getTableColumnsHandler,
};
