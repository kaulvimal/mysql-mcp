// src/tools/visualization.ts
import { z } from 'zod';
import type { McpToolResponse, ToolDefinition, DatabaseType } from './types.js';
import { MySqlAdapter, PostgresAdapter, IDatabaseAdapter, SchemaDetails, ColumnDefinition, IndexDefinition, ConstraintDefinition } from '../db_adapter.js';

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


// --- Formatting Helpers (Operate on generic SchemaDetails) ---

// Helper to generate JSON suitable for ERD rendering
function formatAsJsonERD(schemaData: SchemaDetails, includeColumns: boolean): string {
    const erdJson: Record<string, any> = { tables: [], relationships: [] };
    for (const [tableName, details] of schemaData.entries()) {
        const tableDef: Record<string, any> = { name: tableName };
        if (includeColumns && details.columns) {
            tableDef.columns = [];
            for (const [colName, colDef] of details.columns.entries()) {
                tableDef.columns.push({
                    name: colName,
                    type: colDef.type,
                    isPrimaryKey: colDef.isPrimaryKey ?? false, // Ensure boolean
                    isNullable: colDef.isNullable === 'YES',
                    // Add other relevant flags if needed, e.g., isAutoIncrement
                });
            }
        }
        erdJson.tables.push(tableDef);
        // Extract FK relationships from constraints array
        details.constraints?.forEach(con => {
            if (con.type === 'FOREIGN KEY' && con.columns && con.referencedTable && con.referencedColumns) {
                erdJson.relationships.push({
                    sourceTable: tableName,
                    sourceColumns: con.columns,
                    targetTable: con.referencedTable,
                    targetColumns: con.referencedColumns,
                    constraintName: con.name,
                });
            }
        });
    }
    return JSON.stringify(erdJson, null, 2);
}

// Helper to generate DOT language output
function formatAsDot(schemaData: SchemaDetails, includeColumns: boolean, dbType: DatabaseType): string {
    let dot = 'digraph Schema {\n';
    dot += '  rankdir=LR;\n'; // Left-to-right layout
    dot += '  node [shape=plaintext];\n\n'; // Use HTML-like labels for nodes

    const dotId = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_'); // Basic sanitization for DOT ID

    for (const [tableName, details] of schemaData.entries()) {
        const nodeId = dotId(tableName);
        dot += `  ${nodeId} [label=<\n`; // Use HTML-like label
        dot += `    <TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" BGCOLOR="white">\n`;
        dot += `      <TR><TD ALIGN="CENTER" BGCOLOR="lightblue"><B>${tableName}</B></TD></TR>\n`; // Header row

        if (includeColumns && details.columns) {
            for (const [colName, colDef] of details.columns.entries()) {
                const portId = dotId(colName); // Sanitize column name for port ID
                let colLabel = `${colName} <I>(${colDef.type}${colDef.isNullable === 'YES' ? '' : ' NOT NULL'})</I>`;
                if (colDef.isPrimaryKey) colLabel = `<B>${colLabel} [PK]</B>`;
                dot += `      <TR><TD ALIGN="LEFT" PORT="${portId}">${colLabel}</TD></TR>\n`; // Column row with port
            }
        } else if (!includeColumns) {
             dot += `      <TR><TD ALIGN="LEFT">// Columns omitted</TD></TR>\n`;
        } else {
             dot += `      <TR><TD ALIGN="LEFT">// No columns found</TD></TR>\n`;
        }
        dot += `    </TABLE>\n`;
        dot += `  >];\n\n`;
    }

    // Add edges for FK relationships
    for (const [tableName, details] of schemaData.entries()) {
        const sourceNodeId = dotId(tableName);
        details.constraints?.forEach(con => {
            if (con.type === 'FOREIGN KEY' && con.referencedTable) {
                 const targetNodeId = dotId(con.referencedTable);
                 dot += `  ${sourceNodeId} -> ${targetNodeId} [label="${con.name}"];\n`;
            }
        });
    }
    dot += '}';
    return dot;
}


// Helper to simplify data types for Mermaid (can be expanded)
function simplifyDataType(dataType: string): string {
    const lowerType = dataType.toLowerCase();
    // MySQL checks
    if (lowerType.startsWith('bigint')) return 'BIGINT';
    if (lowerType.startsWith('int') || lowerType.startsWith('tinyint') || lowerType.startsWith('smallint') || lowerType.startsWith('mediumint')) return 'INT';
    if (lowerType.startsWith('varchar')) return 'VARCHAR';
    if (lowerType.startsWith('char')) return 'CHAR';
    if (lowerType.startsWith('text') || lowerType.startsWith('mediumtext') || lowerType.startsWith('longtext')) return 'TEXT';
    if (lowerType.startsWith('datetime')) return 'DATETIME';
    if (lowerType.startsWith('timestamp')) return 'TIMESTAMP';
    if (lowerType.startsWith('date')) return 'DATE';
    if (lowerType.startsWith('time')) return 'TIME';
    if (lowerType.startsWith('float') || lowerType.startsWith('double') || lowerType.startsWith('decimal') || lowerType.startsWith('numeric')) return 'DECIMAL'; // Added numeric
    if (lowerType.startsWith('boolean') || lowerType === 'bool' || lowerType === 'tinyint(1)') return 'BOOLEAN'; // Added tinyint(1)
    if (lowerType.startsWith('enum') || lowerType.startsWith('set')) return 'ENUM';
    if (lowerType.startsWith('blob') || lowerType.startsWith('mediumblob') || lowerType.startsWith('longblob') || lowerType === 'bytea') return 'BLOB'; // Added bytea (PG)
    // PostgreSQL checks (some overlap, some specific)
    if (lowerType.startsWith('character varying')) return 'VARCHAR';
    if (lowerType.startsWith('character')) return 'CHAR';
    if (lowerType.startsWith('timestamp with time zone') || lowerType.startsWith('timestamp without time zone')) return 'TIMESTAMP';
    if (lowerType.startsWith('time with time zone') || lowerType.startsWith('time without time zone')) return 'TIME';
    if (lowerType === 'integer') return 'INT';
    if (lowerType === 'serial' || lowerType === 'bigserial') return 'SERIAL'; // PG auto-increment types
    if (lowerType === 'uuid') return 'UUID';
    if (lowerType === 'json' || lowerType === 'jsonb') return 'JSON';
    if (lowerType.includes('[]')) return 'ARRAY'; // Basic array check

    // Fallback: Take the first word, uppercase
    return dataType.split(/[\s(]+/)[0].toUpperCase();
}

// Helper to safely format identifier for Mermaid
function safeMermaidIdentifier(identifier: string): string {
    return identifier;
}

// Helper to generate Mermaid ER Diagram syntax
function formatAsMermaid(schemaData: SchemaDetails, includeColumns: boolean): string {
    let mermaid = 'erDiagram\n';

    // Define tables and columns
    for (const [tableName, details] of schemaData.entries()) {
        const safeTableName = safeMermaidIdentifier(tableName);
        mermaid += `  ${safeTableName} {\n`;
        if (includeColumns && details.columns) {
            for (const [colName, colDef] of details.columns.entries()) {
                const simplifiedType = simplifyDataType(colDef.type);
                const safeColName = safeMermaidIdentifier(colName);
                mermaid += `    ${simplifiedType} ${safeColName}`;
                if (colDef.isPrimaryKey) mermaid += ' PK';
                if (colDef.isNullable === 'NO') mermaid += ' "NOT NULL"';
                if (colDef.comment) {
                    const escapedComment = colDef.comment.replace(/"/g, '#quot;');
                    mermaid += ` "${escapedComment}"`;
                }
                mermaid += '\n';
            }
        } else if (!includeColumns) {
             mermaid += `    # Columns omitted\n`;
        } else {
             mermaid += `    # No columns found\n`;
        }
        mermaid += '  }\n\n';
    }

    // Define relationships (FKs)
    for (const [tableName, details] of schemaData.entries()) {
        details.constraints?.forEach(con => {
            if (con.type === 'FOREIGN KEY' && con.columns && con.referencedTable && con.referencedColumns) {
                const safeSourceTable = safeMermaidIdentifier(tableName);
                const safeTargetTable = safeMermaidIdentifier(con.referencedTable);
                const columnPairs = con.columns.map((col, i) => `${col} -> ${con.referencedColumns?.[i] ?? '?'}`).join(', ');
                const label = `${con.name} (${columnPairs})`;
                mermaid += `  ${safeSourceTable} ||--|{ ${safeTargetTable} : "${label}"\n`;
            }
        });
    }

    return mermaid;
}


// --- Tool: visualize_schema ---
const visualizeSchemaRawInput = {
    databaseType: z.enum(['mysql', 'postgres']).describe("The type of database (mysql or postgres)."),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to include. If omitted, includes all tables in the specified database/schema."),
    include_columns: z.boolean().optional().default(true).describe("Whether to include column details in the output."),
    format: z.enum(["json", "dot", "mermaid"]).default("mermaid").describe("Output format: 'json' (structured for ERDs), 'dot' (Graphviz), 'mermaid' (Mermaid syntax)."),
};
const VisualizeSchemaInputSchema = z.object(visualizeSchemaRawInput);

const visualizeSchemaHandler = async (args: z.infer<typeof VisualizeSchemaInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, tables, include_columns, format } = args;
    const schemaName = args.schemaName || (databaseType === 'postgres' ? 'public' : undefined); // Default schema for PG
    let adapter: IDatabaseAdapter;
    let identifier: string;
    let identifierType: string;

    try {
        adapter = getDbAdapter(databaseType);
        if (databaseType === 'mysql') {
            if (!databaseName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'databaseName' for databaseType 'mysql'." }] };
            identifier = databaseName;
            identifierType = 'database';
        } else { // postgres
            if (!schemaName) return { isError: true, content: [{ type: "text", text: "Missing required parameter 'schemaName' for databaseType 'postgres'." }] };
            identifier = schemaName;
            identifierType = 'schema';
        }

        console.error(`[${databaseType}-visualize_schema] Fetching schema details for ${identifierType} '${identifier}'...`);
        // Fetch complete schema details using the correct identifier
        const schemaData: SchemaDetails = await adapter.getSchemaDetails(identifier, tables);

        if (schemaData.size === 0) {
            return { content: [{ type: "text", text: `No tables found matching criteria in ${identifierType} '${identifier}'.` }] };
        }

        console.error(`[${databaseType}-visualize_schema] Formatting schema as ${format}...`);
        let formattedOutput = '';
        let contentType = 'text/plain'; // Default

        switch (format) {
            case 'json':
                formattedOutput = formatAsJsonERD(schemaData, include_columns);
                contentType = 'application/json';
                break;
            case 'dot':
                formattedOutput = formatAsDot(schemaData, include_columns, databaseType);
                contentType = 'text/vnd.graphviz';
                break;
            case 'mermaid':
                // Wrap Mermaid code in backticks for Markdown rendering
                formattedOutput = "```mermaid\n" + formatAsMermaid(schemaData, include_columns) + "\n```";
                contentType = 'text/markdown'; // Indicate it's Markdown containing Mermaid
                break;
            default:
                 // Should be caught by Zod, but handle defensively
                 return adapter.formatError('visualize_schema', `generate schema visualization`, new Error(`Invalid format specified: ${format}`), identifier);
        }

        // Return formatted output
        return { content: [{ type: "text", text: formattedOutput }] }; // Currently sending as plain text

    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('visualize_schema', `generate schema visualization for ${databaseType === 'mysql' ? 'database' : 'schema'} '${errorIdentifier}'`, error, errorIdentifier);
    }
};

export const visualizeSchemaTool: ToolDefinition = {
  name: "visualize_schema",
  description: "Generates a representation of the database schema (tables, columns, relationships) suitable for ER diagrams, in JSON, DOT (Graphviz), or Mermaid syntax for a specific MySQL database or PostgreSQL schema.",
  rawInputSchema: visualizeSchemaRawInput,
  handler: visualizeSchemaHandler,
};

// --- Aggregate Visualization Tools ---
export const visualizationTools: ToolDefinition[] = [
    visualizeSchemaTool,
];
