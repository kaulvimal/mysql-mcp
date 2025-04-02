// src/tools/schema.ts
import { z } from 'zod';
import mysql, { RowDataPacket } from 'mysql2/promise';
import { dbConfig } from '../config.js'; // Use .js extension for relative import

// Define the raw shape for Zod validation
const getTableSchemaRawInput = {
  databaseName: z.string().describe("The name of the database containing the table."),
  tableName: z.string().describe("The name of the table whose schema you want to retrieve."),
};

type McpToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Define the handler function for the tool
// Use explicit types for args based on the raw shape
const getTableSchemaHandler = async (args: { databaseName: string; tableName: string; }, extra: any): Promise<McpToolResponse> => {
  const { databaseName, tableName } = args;
  let connection: mysql.Connection | null = null;

  try {
    connection = await mysql.createConnection(dbConfig);
    await connection.query(`USE \`${databaseName}\`;`);
    const [rows] = await connection.query<RowDataPacket[]>(`DESCRIBE \`${tableName}\`;`);

    if (!rows || rows.length === 0) {
      return { content: [{ type: "text", text: `Table '${tableName}' not found in database '${databaseName}' or it is empty.` }] };
    }

    let schemaDescription = `Schema for table '${tableName}' in database '${databaseName}':\n\n`;
    schemaDescription += rows.map(row =>
      `- Column: ${row.Field}\n  Type: ${row.Type}\n  Null: ${row.Null}\n  Key: ${row.Key || 'N/A'}\n  Default: ${row.Default === null ? 'NULL' : row.Default || 'N/A'}\n  Extra: ${row.Extra || 'N/A'}`
    ).join('\n\n');

    return { content: [{ type: "text", text: schemaDescription }] };

  } catch (error: any) {
    console.error(`[get-table-schema] Error:`, error);
    let errorMessage = `Failed to retrieve schema for table '${tableName}' in database '${databaseName}'.`;
     if (error.code === 'ER_BAD_DB_ERROR') errorMessage = `Database '${databaseName}' does not exist or access denied.`;
     else if (error.code === 'ER_NO_SUCH_TABLE') errorMessage = `Table '${tableName}' does not exist in database '${databaseName}'.`;
     else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') errorMessage = `Could not connect to the MySQL database host '${dbConfig.host}'.`;
     else if (error.code === 'ER_ACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${dbConfig.user}' to the database.`;

    return { isError: true, content: [{ type: "text", text: errorMessage + `\nDetails: ${error.message || error}` }] };
  } finally {
    if (connection) await connection.end();
  }
};

// Export the tool definition object
export const getTableSchemaTool = {
  name: "get-table-schema",
  description: "Retrieves the schema (column definitions) of a specific MySQL table.",
  rawInputSchema: getTableSchemaRawInput,
  handler: getTableSchemaHandler,
};
