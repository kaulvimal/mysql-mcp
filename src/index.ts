// --- *** Load environment variables *** ---
// Import and configure dotenv to load variables from a .env file
// Make sure to run 'npm install dotenv'
import 'dotenv/config';

// --- *** Debugging: Check if .env variables are loaded *** ---
// console.log(`DEBUG: DB_USER from process.env = ${process.env.DB_USER}`);
// console.log(`DEBUG: DB_HOST from process.env = ${process.env.DB_HOST}`);
// You can uncomment the lines above for debugging .env issues
// --- *** End of Debugging *** ---

// Import McpServer and StdioServerTransport from the SDK
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Import Zod for input validation
import { z } from "zod";
// Import mysql2 promise-based library (ensure you've run 'npm install mysql2')
import mysql, { OkPacket, RowDataPacket, ResultSetHeader } from 'mysql2/promise'; // Import specific types

// --- Database Configuration ---
// Reads configuration from .env file.
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Ensure DB_PORT is parsed correctly or default
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306
};

// --- Create MCP Server Instance ---
const server = new McpServer({
  name: "mysql-schema-inspector",
  version: "1.1.0", // Incremented version
  capabilities: {
    resources: {},
    tools: {},
  },
});

// --- Define the 'get-table-schema' Tool ---
server.tool(
  "get-table-schema",
  "Retrieves the schema (column definitions) of a specific MySQL table.",
  // Pass the raw Zod shape directly as the third argument
  {
    databaseName: z.string().describe("The name of the database containing the table."),
    tableName: z.string().describe("The name of the table whose schema you want to retrieve."),
  },
  // Async handler function for the tool
  async (args: { databaseName: string; tableName: string; }, extra) => {
    const { databaseName, tableName } = args;
    let connection: mysql.Connection | null = null;
    // console.log('DEBUG: [get-table-schema] Attempting MySQL connection with config:', dbConfig);

    try {
      connection = await mysql.createConnection(dbConfig);
      await connection.query(`USE \`${databaseName}\`;`);
      const [rows] = await connection.query<mysql.RowDataPacket[]>(`DESCRIBE \`${tableName}\`;`);

      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: `Table '${tableName}' not found in database '${databaseName}' or it is empty.` }] };
      }

      let schemaDescription = `Schema for table '${tableName}' in database '${databaseName}':\n\n`;
      schemaDescription += rows.map(row =>
        `- Column: ${row.Field}\n  Type: ${row.Type}\n  Null: ${row.Null}\n  Key: ${row.Key || 'N/A'}\n  Default: ${row.Default === null ? 'NULL' : row.Default || 'N/A'}\n  Extra: ${row.Extra || 'N/A'}`
      ).join('\n\n');

      return { content: [{ type: "text", text: schemaDescription }] };

    } catch (error: any) {
      console.error(`[get-table-schema] Error connecting/querying MySQL with config: user='${dbConfig.user}', host='${dbConfig.host}'`);
      console.error("[get-table-schema] Full error details:", error);

      let errorMessage = `Failed to retrieve schema for table '${tableName}' in database '${databaseName}'.`;
       if (error.code === 'ER_BAD_DB_ERROR') errorMessage = `Database '${databaseName}' does not exist or access denied.`;
       else if (error.code === 'ER_NO_SUCH_TABLE') errorMessage = `Table '${tableName}' does not exist in database '${databaseName}'.`;
       else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') errorMessage = `Could not connect to the MySQL database host '${dbConfig.host}'.`;
       else if (error.code === 'ER_ACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${dbConfig.user}' to the database.`;

      return { isError: true, content: [{ type: "text", text: errorMessage + `\nDetails: ${error.message || error}` }] };
    } finally {
      if (connection) await connection.end();
    }
  },
);

// --- *** NEW TOOL: run-sql-query *** ---
server.tool(
  "run-sql-query",
  "Executes a given SQL query against a specified MySQL database. WARNING: This tool allows executing arbitrary SQL and can modify or delete data if the DB user has permissions. Use with extreme caution.",
  // Input schema
  {
    databaseName: z.string().describe("The name of the database to run the query against."),
    sqlQuery: z.string().describe("The SQL query to execute. IMPORTANT: Ensure this query is safe and intended."),
  },
  // Async handler function
  async (args: { databaseName: string; sqlQuery: string; }, extra) => {
    const { databaseName, sqlQuery } = args;
    let connection: mysql.Connection | null = null;

    // Basic check for potentially harmful commands (incomplete, for demonstration only)
    const trimmedQuery = sqlQuery.trim().toUpperCase();
    if (trimmedQuery.startsWith('DROP ') || trimmedQuery.startsWith('DELETE ') || trimmedQuery.startsWith('UPDATE ') || trimmedQuery.startsWith('INSERT ')) {
       console.warn(`[run-sql-query] WARNING: Executing potentially destructive query: ${sqlQuery}`);
       // In a real application, you might block certain keywords or operations here,
       // or require specific confirmation.
    }

    // console.log('DEBUG: [run-sql-query] Attempting MySQL connection with config:', dbConfig);

    try {
      // 1. Establish connection
      connection = await mysql.createConnection(dbConfig);

      // 2. Select database
      await connection.query(`USE \`${databaseName}\`;`);

      // 3. Execute the user-provided query
      //    WARNING: THIS IS THE DANGEROUS PART - EXECUTING ARBITRARY USER INPUT AS SQL
      console.log(`[run-sql-query] Executing SQL in DB '${databaseName}': ${sqlQuery}`);
      const [results] = await connection.query(sqlQuery); // Use generic query here
      console.log(`[run-sql-query] Query executed successfully.`);

      // 4. Format results based on query type
      let resultText: string;
      if (Array.isArray(results)) {
        // Likely a SELECT query (returns RowDataPacket[])
        resultText = `Query Result (${results.length} rows):\n\n${JSON.stringify(results, null, 2)}`;
      } else if (typeof results === 'object' && results !== null && ('affectedRows' in results || 'insertId' in results)) {
        // Likely INSERT, UPDATE, DELETE (returns OkPacket or ResultSetHeader)
        const okResult = results as OkPacket | ResultSetHeader; // Type assertion
        resultText = `Query executed successfully.\n` +
                     `Affected Rows: ${okResult.affectedRows}\n` +
                     `Insert ID: ${'insertId' in okResult ? okResult.insertId : 'N/A'}\n` +
                     `Changed Rows: ${'changedRows' in okResult ? okResult.changedRows : 'N/A'}`;
      } else {
        // Other commands (e.g., CREATE, ALTER) might return different structures
        // For simplicity, just stringify the result object
        resultText = `Query executed. Result:\n\n${JSON.stringify(results, null, 2)}`;
      }

      // 5. Return success
      return {
        content: [{ type: "text", text: resultText }]
      };

    } catch (error: any) {
      // 6. Handle errors (connection, SQL syntax, permissions, etc.)
      console.error(`[run-sql-query] Error executing query in DB '${databaseName}': ${sqlQuery}`);
      console.error(`[run-sql-query] Error connecting/querying MySQL with config: user='${dbConfig.user}', host='${dbConfig.host}'`);
      console.error("[run-sql-query] Full error details:", error);

      let errorMessage = `Failed to execute query in database '${databaseName}'.`;
      if (error.code === 'ER_BAD_DB_ERROR') errorMessage = `Database '${databaseName}' does not exist or access denied.`;
      else if (error.code === 'ER_PARSE_ERROR') errorMessage = `SQL Syntax Error near '${error.sqlMessage?.substring(0, 100)}...'`; // Show part of SQL message
      else if (error.code === 'ER_NO_SUCH_TABLE') errorMessage = `Table mentioned in query does not exist.`; // Example specific SQL error
      else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') errorMessage = `Could not connect to the MySQL database host '${dbConfig.host}'.`;
      else if (error.code === 'ER_ACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${dbConfig.user}' to the database.`;
      else if (error.code === 'ER_DBACCESS_DENIED_ERROR') errorMessage = `Access denied for user '${dbConfig.user}' to database '${databaseName}'.`;
      // Add more specific SQL error codes as needed

      return {
        isError: true,
        content: [{ type: "text", text: errorMessage + `\nDetails: ${error.message || error}` }]
      };
    } finally {
      // 7. Ensure connection is closed
      if (connection) {
        await connection.end();
        // console.log("[run-sql-query] MySQL connection closed.");
      }
    }
  }
);
// --- *** END OF NEW TOOL *** ---


// --- Main Function to Start the Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Run the Main Function ---
main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
