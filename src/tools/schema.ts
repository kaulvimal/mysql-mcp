// src/tools/schema.ts
import { z } from 'zod';
import type { McpToolResponse, ToolDefinition, DatabaseType } from './types.js'; // Import shared types
import { MySqlAdapter, PostgresAdapter, IDatabaseAdapter } from '../db_adapter.js';

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

// --- Tool: get_table_columns ---
const getTableColumnsRawInput = {
  databaseType: z.enum(['mysql', 'postgres']).describe("The type of database (mysql or postgres)."),
  databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
  schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
  tableName: z.string().describe("The name of the table whose columns you want to retrieve."),
};
const GetTableColumnsInputSchema = z.object(getTableColumnsRawInput);

const getTableColumnsHandler = async (args: z.infer<typeof GetTableColumnsInputSchema>, extra: any): Promise<McpToolResponse> => {
  const { databaseType, databaseName, tableName } = args;
  // Use provided schemaName for PG, default to 'public' if not given
  const schemaName = args.schemaName || (databaseType === 'postgres' ? 'public' : undefined);

  let adapter: IDatabaseAdapter;
  let identifier: string; // Will hold dbName for mysql, schemaName for postgres
  let identifierType: string;

  try {
      adapter = getDbAdapter(databaseType);

      // Validate and set identifier
      if (databaseType === 'mysql') {
          if (!databaseName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'databaseName' for databaseType 'mysql'." }] };
          identifier = databaseName;
          identifierType = 'database';
      } else { // postgres
          if (!schemaName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'schemaName' for databaseType 'postgres'." }] };
          identifier = schemaName;
          identifierType = 'schema';
      }

      console.error(`[${databaseType}-get_table_columns] Fetching columns for table '${tableName}' in ${identifierType} '${identifier}'...`);

      // Use the adapter to get columns, passing the correct identifier
      const columns = await adapter.getTableColumns(identifier, tableName);

      if (!columns || columns.length === 0) {
        // Adapter's getTableColumns should handle specific errors (like table not found)
        // Provide a generic message if it returns empty without error
        return adapter.formatError('get_table_columns', `retrieve columns for table '${tableName}'`, { message: `No columns found for table '${tableName}' in ${identifierType} '${identifier}'. It might not exist or you lack permissions.` }, identifier, tableName);
      }

      // Format the output based on database type
      let schemaDescription = `Columns for table '${tableName}' in ${identifierType} '${identifier}':\n\n`;

      if (databaseType === 'mysql') {
          // Format based on MySQL DESCRIBE output
           schemaDescription += columns.map((row: any) =>
             `- Column: ${row.Field}\n  Type: ${row.Type}\n  Null: ${row.Null}\n  Key: ${row.Key || 'N/A'}\n  Default: ${row.Default === null ? 'NULL' : row.Default || 'N/A'}\n  Extra: ${row.Extra || 'N/A'}`
           ).join('\n\n');
      } else { // postgres
          // Format based on PostgreSQL information_schema output
          schemaDescription += columns.map((row: any) =>
             `- Column: ${row.column_name}\n  Type: ${row.data_type} (${row.udt_name || ''})\n  Null: ${row.is_nullable}\n  Default: ${row.column_default === null ? 'NULL' : row.column_default || 'N/A'}`
           ).join('\n\n');
      }

      return { content: [{ type: "text", text: schemaDescription }] };

  } catch (error: any) {
    console.error(`[${databaseType}-get_table_columns] Error fetching columns for table '${tableName}':`, error); // Log full error server-side
    adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
    const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
    // Use the adapter's error formatter
    return adapter.formatError('get_table_columns', `retrieve columns for table '${tableName}'`, error, errorIdentifier, tableName);
  }
};

// Export the tool definition object conforming to ToolDefinition type
export const getTableColumnsTool: ToolDefinition = {
  name: "get_table_columns",
  description: "Retrieves the column definitions (schema) of a specific table within a MySQL database or PostgreSQL schema.",
  rawInputSchema: getTableColumnsRawInput, // Use the raw schema object
  handler: getTableColumnsHandler,
};

// --- Aggregate Schema Tools ---
// If you add more tools to this file later, ensure they follow the same pattern
export const schemaTools: ToolDefinition[] = [
    getTableColumnsTool,
];
