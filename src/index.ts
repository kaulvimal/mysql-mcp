// Import McpServer and StdioServerTransport from the SDK
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Import Zod for input validation
import { z } from "zod";
// Import mysql2 promise-based library (ensure you've run 'npm install mysql2')
import mysql from 'mysql2/promise';
import 'dotenv/config';

const dbConfig = {
  host: process.env.DB_HOST ,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306
};

// --- Create MCP Server Instance ---
const server = new McpServer({
  name: "mysql-schema-inspector",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// --- Define the 'get-table-schema' Tool ---
server.tool(
  "get-table-schema",
  "Retrieves the schema (column definitions) of a specific MySQL table.",
  // --- *** FIX APPLIED HERE *** ---
  // Pass the raw Zod shape directly as the third argument
  {
    databaseName: z.string().describe("The name of the database containing the table."),
    tableName: z.string().describe("The name of the table whose schema you want to retrieve."),
  },
  // --- *** END OF FIX *** ---
  // Async handler function for the tool
  // Update the type for 'args' to match the raw shape definition
  async (args: { databaseName: string; tableName: string; }, extra) => {
    const { databaseName, tableName } = args; // Destructure arguments
    let connection: mysql.Connection | null = null;

    try {
      // 1. Establish connection to MySQL
      connection = await mysql.createConnection(dbConfig);

      // 2. Select the specified database
      await connection.query(`USE \`${databaseName}\`;`);

      // 3. Get the table schema using DESCRIBE
      const [rows] = await connection.query<mysql.RowDataPacket[]>(`DESCRIBE \`${tableName}\`;`);

      // 4. Format the schema information
      if (!rows || rows.length === 0) {
        return {
          content: [{ type: "text", text: `Table '${tableName}' not found in database '${databaseName}' or it is empty.` }]
        };
      }

      // Build a descriptive string from the schema rows
      let schemaDescription = `Schema for table '${tableName}' in database '${databaseName}':\n\n`;
      schemaDescription += rows.map(row =>
        `- Column: ${row.Field}\n` +
        `  Type: ${row.Type}\n` +
        `  Null: ${row.Null}\n` +
        `  Key: ${row.Key || 'N/A'}\n` +
        `  Default: ${row.Default === null ? 'NULL' : row.Default || 'N/A'}\n` +
        `  Extra: ${row.Extra || 'N/A'}`
      ).join('\n\n');

      // 5. Return the formatted schema (Success)
      return {
        content: [
          {
            type: "text",
            text: schemaDescription
          }
        ]
      };

    } catch (error: any) {
      // 6. Handle errors
      console.error("Error in get-table-schema tool:", error);

      // Provide a user-friendly error message
      let errorMessage = `Failed to retrieve schema for table '${tableName}' in database '${databaseName}'.`;
      if (error.code === 'ER_BAD_DB_ERROR') {
        errorMessage = `Database '${databaseName}' does not exist or access denied.`;
      } else if (error.code === 'ER_NO_SUCH_TABLE') {
        errorMessage = `Table '${tableName}' does not exist in database '${databaseName}'.`;
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
         errorMessage = `Could not connect to the MySQL database host '${dbConfig.host}'. Please check the connection details and ensure the server is running.`;
      } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
         errorMessage = `Access denied for user '${dbConfig.user}' to the database. Please check credentials.`;
      }
      // Add more specific error checks as needed

      // Return the error using the isError flag and type: "text"
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: errorMessage + `\nDetails: ${error.message || error}`
          }
        ]
      };

    } finally {
      // 7. Ensure the connection is closed
      if (connection) {
        await connection.end();
      }
    }
  },
);

// --- Main Function to Start the Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MySQL Schema MCP Server running on stdio");
}

// --- Run the Main Function ---
main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
