// src/tools/visualization.ts
import { z } from 'zod';
import { pool } from '../config.js';
import type { McpToolResponse, ToolDefinition } from './types.js';
// Corrected Import from metadata.ts
import { fetchSchemaDetails } from './metadata.js';
import type { SchemaDetails, ColumnDefinition } from './metadata.js'; // Import ColumnDefinition too
// End Correction
import { formatErrorResponse } from './utils.js';
import type { PoolConnection } from 'mysql2/promise';
import mysql from 'mysql2/promise'; // Keep for potential future use, though escapeId isn't used now

// --- Formatting Helpers ---

// Helper to generate JSON suitable for ERD rendering (focus on tables, columns, FKs)
function formatAsJsonERD(schemaData: SchemaDetails, includeColumns: boolean): string {
    const erdJson: Record<string, any> = { tables: [], relationships: [] };
    for (const [tableName, details] of schemaData.entries()) {
        const tableDef: Record<string, any> = { name: tableName };
        if (includeColumns) {
            tableDef.columns = [];
            for (const [colName, colDef] of details.columns.entries()) {
                tableDef.columns.push({ name: colName, type: colDef.type, isPrimaryKey: colDef.isPrimaryKey, isNullable: colDef.isNullable === 'YES', });
            }
        }
        erdJson.tables.push(tableDef);
        details.constraints?.forEach(con => {
            if (con.type === 'FOREIGN KEY' && con.columns && con.referencedTable && con.referencedColumns) {
                erdJson.relationships.push({ sourceTable: tableName, sourceColumns: con.columns, targetTable: con.referencedTable, targetColumns: con.referencedColumns, constraintName: con.name, });
            }
        });
    }
    return JSON.stringify(erdJson, null, 2);
}

// Helper to generate DOT language output
function formatAsDot(schemaData: SchemaDetails, includeColumns: boolean): string {
    let dot = 'digraph Schema {\n';
    dot += '  rankdir=LR;\n';
    dot += '  node [shape=plaintext];\n\n';
    for (const [tableName, details] of schemaData.entries()) {
        // DOT requires quotes for node IDs if they aren't simple identifiers
        dot += `  "${tableName}" [label=<\n`;
        dot += `    <TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n`;
        dot += `      <TR><TD ALIGN="CENTER" BGCOLOR="lightblue"><B>${tableName}</B></TD></TR>\n`;
        if (includeColumns) {
            for (const [colName, colDef] of details.columns.entries()) {
                let colLabel = `${colName} <I>(${colDef.type}${colDef.isNullable === 'YES' ? '' : ' NOT NULL'})</I>`;
                if (colDef.isPrimaryKey) colLabel = `<B>${colLabel} [PK]</B>`;
                // Port names in DOT should also be quoted if not simple
                dot += `      <TR><TD ALIGN="LEFT" PORT="${colName}">${colLabel}</TD></TR>\n`;
            }
        }
        dot += `    </TABLE>\n`;
        dot += `  >];\n\n`;
    }
    for (const [tableName, details] of schemaData.entries()) {
        details.constraints?.forEach(con => {
            if (con.type === 'FOREIGN KEY' && con.columns && con.referencedTable && con.referencedColumns) {
                 // Node IDs need quotes
                 dot += `  "${tableName}" -> "${con.referencedTable}" [label="${con.name}"];\n`;
            }
        });
    }
    dot += '}';
    return dot;
}

// Helper to simplify MySQL types for Mermaid
function simplifyDataType(mysqlType: string): string {
    const lowerType = mysqlType.toLowerCase();
    if (lowerType.startsWith('bigint')) return 'BIGINT';
    if (lowerType.startsWith('int') || lowerType.startsWith('tinyint') || lowerType.startsWith('smallint') || lowerType.startsWith('mediumint')) return 'INT';
    if (lowerType.startsWith('varchar')) return 'VARCHAR';
    if (lowerType.startsWith('char')) return 'CHAR';
    if (lowerType.startsWith('text') || lowerType.startsWith('mediumtext') || lowerType.startsWith('longtext')) return 'TEXT';
    if (lowerType.startsWith('datetime')) return 'DATETIME';
    if (lowerType.startsWith('timestamp')) return 'TIMESTAMP';
    if (lowerType.startsWith('date')) return 'DATE';
    if (lowerType.startsWith('time')) return 'TIME';
    if (lowerType.startsWith('float') || lowerType.startsWith('double') || lowerType.startsWith('decimal')) return 'DECIMAL';
    if (lowerType.startsWith('boolean') || lowerType === 'bool') return 'BOOLEAN';
    if (lowerType.startsWith('enum') || lowerType.startsWith('set')) return 'ENUM';
    if (lowerType.startsWith('blob') || lowerType.startsWith('mediumblob') || lowerType.startsWith('longblob')) return 'BLOB';
    return mysqlType.split('(')[0].split(' ')[0].toUpperCase();
}

// Helper to check if an identifier needs quoting (REMOVED - No longer used)
// function needsQuotes(identifier: string): boolean { ... }

// Helper to safely format identifier for Mermaid (MODIFIED - Always return raw)
function safeMermaidIdentifier(identifier: string): string {
    // Return the identifier directly without adding backticks
    return identifier;
    // Previous logic: return needsQuotes(identifier) ? mysql.escapeId(identifier) : identifier;
}


// Helper to generate Mermaid ER Diagram syntax (Using raw identifiers)
function formatAsMermaid(schemaData: SchemaDetails, includeColumns: boolean): string {
    let mermaid = 'erDiagram\n';

    // Define tables and columns
    for (const [tableName, details] of schemaData.entries()) {
        const safeTableName = safeMermaidIdentifier(tableName); // Now returns raw name
        mermaid += `  ${safeTableName} {\n`;
        if (includeColumns && details.columns) {
            for (const [colName, colDef] of details.columns.entries()) {
                const simplifiedType = simplifyDataType(colDef.type);
                const safeColName = safeMermaidIdentifier(colName); // Now returns raw name
                mermaid += `    ${simplifiedType} ${safeColName}`;
                if (colDef.isPrimaryKey) mermaid += ' PK';
                if (colDef.comment) {
                    const escapedComment = colDef.comment.replace(/"/g, '#quot;');
                    mermaid += ` "${escapedComment}"`;
                }
                mermaid += '\n';
            }
        } else if (!includeColumns) {
             mermaid += `    // Columns omitted\n`;
        } else {
             mermaid += `    // No columns found\n`;
        }
        mermaid += '  }\n\n';
    }

    // Define relationships (FKs)
    for (const [tableName, details] of schemaData.entries()) {
        details.constraints?.forEach(con => {
            if (con.type === 'FOREIGN KEY' && con.columns && con.referencedTable && con.referencedColumns) {
                const safeSourceTable = safeMermaidIdentifier(tableName); // Now returns raw name
                const safeTargetTable = safeMermaidIdentifier(con.referencedTable); // Now returns raw name
                const label = `${con.columns.join(',')} -> ${con.referencedColumns.join(',')}`;
                mermaid += `  ${safeSourceTable} ||--|{ ${safeTargetTable} : "${label}"\n`;
            }
        });
    }

    return mermaid;
}


// --- Tool: visualize_schema ---
const visualizeSchemaRawInput = {
    databaseName: z.string().describe("The database whose schema needs visualization."),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to include. If omitted, includes all tables."),
    include_columns: z.boolean().optional().default(true).describe("Whether to include column details in the output."),
    format: z.enum(["json", "dot", "mermaid"]).default("mermaid").describe("Output format: 'json' (structured), 'dot' (Graphviz), 'mermaid' (Mermaid syntax)."),
};
const VisualizeSchemaInputSchema = z.object(visualizeSchemaRawInput);

const visualizeSchemaHandler = async (args: z.infer<typeof VisualizeSchemaInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, tables, include_columns, format } = args;
    let connection: PoolConnection | null = null;

    try {
        connection = await pool.getConnection();
        console.error(`[visualize_schema] Fetching schema details for DB '${databaseName}'...`);
        const schemaData = await fetchSchemaDetails(connection, databaseName, tables);

        if (schemaData.size === 0) {
            return { content: [{ type: "text", text: `No tables found matching criteria in database '${databaseName}'.` }] };
        }

        console.error(`[visualize_schema] Formatting schema as ${format}...`);
        let formattedOutput = '';
        switch (format) {
            case 'json': formattedOutput = formatAsJsonERD(schemaData, include_columns); break;
            case 'dot': formattedOutput = formatAsDot(schemaData, include_columns); break;
            case 'mermaid': formattedOutput = formatAsMermaid(schemaData, include_columns); break; // Uses formatter without backticks
            default: return formatErrorResponse('visualize_schema', `generate schema visualization`, new Error(`Invalid format specified: ${format}`), databaseName);
        }

        return { content: [{ type: "text", text: formattedOutput }] };

    } catch (error: any) {
        return formatErrorResponse('visualize_schema', `generate schema visualization for '${databaseName}'`, error, databaseName);
    } finally {
        if (connection) connection.release();
    }
     return { isError: true, content: [{ type: "text", text: "[visualize_schema] Unexpected error: Handler ended without returning result." }] };
};

export const visualizeSchemaTool: ToolDefinition = {
  name: "visualize_schema",
  description: "Generates a representation of the database schema (tables, columns, relationships) suitable for ER diagrams, in JSON, DOT (Graphviz), or Mermaid format.",
  rawInputSchema: visualizeSchemaRawInput,
  handler: visualizeSchemaHandler,
};

// --- Aggregate Visualization Tools ---
export const visualizationTools: ToolDefinition[] = [
    visualizeSchemaTool,
];
