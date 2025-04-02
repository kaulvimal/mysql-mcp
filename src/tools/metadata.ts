// src/tools/metadata.ts
import { z } from 'zod';
import { pool } from '../config.js';
import type { McpToolResponse, ToolDefinition } from './types.js';
import type { PoolConnection, RowDataPacket, OkPacket, Connection, FieldPacket } from 'mysql2/promise';
import mysql from 'mysql2/promise';
import { formatErrorResponse } from './utils.js'; // Import shared error formatter

// --- Helper Types ---
type ColumnDefinition = { name: string; type: string; isNullable: string; defaultValue: string | null; isPrimaryKey?: boolean; isAutoIncrement?: boolean; comment?: string; };
type SchemaDetails = Map<string, { columns: Map<string, ColumnDefinition>; indexes?: Map<string, IndexDefinition>; constraints?: ConstraintDefinition[]; }>;
type IndexDefinition = { name: string; columns: string[]; isUnique: boolean; type: string; };
type ConstraintDefinition = { name: string; type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK'; columns?: string[]; referencedTable?: string; referencedColumns?: string[]; checkClause?: string; };
type Relationship = { constraintName: string; sourceTable: string; sourceColumns: string[]; referencedTable: string; referencedColumns: string[]; type: 'explicit'; };
type ImplicitRelationship = { sourceTable: string; sourceColumn: string; referencedTable: string; referencedColumn: string; type: 'implicit'; };
type ColumnDiff = { sourceDef: ColumnDefinition | null; targetDef: ColumnDefinition | null; };
type TableDiff = { sourceOnlyColumns: string[]; targetOnlyColumns: string[]; differingColumns: Map<string, ColumnDiff>; };
type SchemaDiff = { sourceOnlyTables: string[]; targetOnlyTables: string[]; differingTables: Map<string, TableDiff>; identicalTables: string[]; };

// --- Zod Schemas ---

// --- Helper Function to Fetch Schema Details ---
async function fetchSchemaDetails(connection: PoolConnection | Connection, dbName: string, requestedTables?: string[]): Promise<SchemaDetails> {
    const schemaDetails: SchemaDetails = new Map();
    const hasSpecificTables = requestedTables && requestedTables.length > 0;
    // 1. Fetch Columns
    let columnSql = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?`;
    const columnParams: any[] = [dbName];
    if (hasSpecificTables) { columnSql += ` AND TABLE_NAME IN (?)`; columnParams.push(requestedTables); }
    columnSql += ` ORDER BY TABLE_NAME, ORDINAL_POSITION;`;
    const [columns] = await connection.query<RowDataPacket[]>(columnSql, columnParams);
    for (const col of columns) {
        const tableName = col.TABLE_NAME;
        if (!schemaDetails.has(tableName)) { schemaDetails.set(tableName, { columns: new Map(), indexes: new Map(), constraints: [] }); }
        const tableMap = schemaDetails.get(tableName)!;
        tableMap.columns.set(col.COLUMN_NAME, { name: col.COLUMN_NAME, type: col.COLUMN_TYPE, isNullable: col.IS_NULLABLE, defaultValue: col.COLUMN_DEFAULT, isPrimaryKey: col.COLUMN_KEY === 'PRI', isAutoIncrement: col.EXTRA.toLowerCase().includes('auto_increment'), comment: col.COLUMN_COMMENT });
    }
    // 2. Fetch Indexes
    let indexSql = `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX, INDEX_TYPE FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ?`;
    const indexParams: any[] = [dbName];
    if (hasSpecificTables) { indexSql += ` AND TABLE_NAME IN (?)`; indexParams.push(requestedTables); }
    indexSql += ` ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;`;
    const [indexesInfo] = await connection.query<RowDataPacket[]>(indexSql, indexParams);
    const tempIndexes: Map<string, { tableName: string, name: string, columns: Map<number, string>, isUnique: boolean, type: string }> = new Map();
    for (const idx of indexesInfo) {
        const uniqueIndexKey = `${idx.TABLE_NAME}.${idx.INDEX_NAME}`;
        if (!tempIndexes.has(uniqueIndexKey)) { tempIndexes.set(uniqueIndexKey, { tableName: idx.TABLE_NAME, name: idx.INDEX_NAME, columns: new Map(), isUnique: idx.NON_UNIQUE === 0, type: idx.INDEX_TYPE }); }
        tempIndexes.get(uniqueIndexKey)!.columns.set(idx.SEQ_IN_INDEX, idx.COLUMN_NAME);
    }
    for (const indexData of tempIndexes.values()) {
        const tableDetails = schemaDetails.get(indexData.tableName);
        if (tableDetails) { const orderedColumns = Array.from(indexData.columns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); tableDetails.indexes?.set(indexData.name, { name: indexData.name, columns: orderedColumns, isUnique: indexData.isUnique, type: indexData.type }); }
    }
    // 3. Fetch Constraints
    let constraintSql = `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, ccu.CHECK_CLAUSE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_NAME = kcu.TABLE_NAME LEFT JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS ccu ON tc.CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK')`;
    const constraintParams: any[] = [dbName];
    if (hasSpecificTables) { constraintSql += ` AND tc.TABLE_NAME IN (?)`; constraintParams.push(requestedTables); }
    constraintSql += ` ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;`;
    const [constraintsInfo] = await connection.query<RowDataPacket[]>(constraintSql, constraintParams);
    const tempConstraints: Map<string, ConstraintDefinition & { tableName: string, refCols?: Map<string, string> }> = new Map();
    for (const con of constraintsInfo) {
        const uniqueConstraintKey = `${con.TABLE_NAME}.${con.CONSTRAINT_NAME}`;
        if (!tempConstraints.has(uniqueConstraintKey)) { tempConstraints.set(uniqueConstraintKey, { tableName: con.TABLE_NAME, name: con.CONSTRAINT_NAME, type: con.CONSTRAINT_TYPE, columns: [], checkClause: con.CONSTRAINT_TYPE === 'CHECK' ? con.CHECK_CLAUSE : undefined, referencedTable: con.CONSTRAINT_TYPE === 'FOREIGN KEY' ? con.REFERENCED_TABLE_NAME : undefined, refCols: con.CONSTRAINT_TYPE === 'FOREIGN KEY' ? new Map() : undefined, referencedColumns: [] }); }
        const constraintData = tempConstraints.get(uniqueConstraintKey)!;
        if (con.COLUMN_NAME && !constraintData.columns?.includes(con.COLUMN_NAME)) { constraintData.columns?.push(con.COLUMN_NAME); }
        if (con.CONSTRAINT_TYPE === 'FOREIGN KEY' && con.COLUMN_NAME && con.REFERENCED_COLUMN_NAME) { constraintData.refCols?.set(con.COLUMN_NAME, con.REFERENCED_COLUMN_NAME); }
    }
    for (const constraintData of tempConstraints.values()) {
        const tableDetails = schemaDetails.get(constraintData.tableName);
        if (tableDetails) { if (constraintData.type === 'FOREIGN KEY' && constraintData.columns && constraintData.refCols) { constraintData.referencedColumns = constraintData.columns.map(col => constraintData.refCols!.get(col)).filter((refCol): refCol is string => refCol !== undefined); delete constraintData.refCols; } tableDetails.constraints?.push(constraintData); }
    }
    return schemaDetails;
}

// --- Helper Function to Compare Two Schemas ---
function diffSchemas(sourceSchema: SchemaDetails, targetSchema: SchemaDetails): SchemaDiff {
    const diff: SchemaDiff = { sourceOnlyTables: [], targetOnlyTables: [], differingTables: new Map(), identicalTables: [] };
    const allTableNames = new Set([...sourceSchema.keys(), ...targetSchema.keys()]);
    for (const tableName of allTableNames) {
        const sourceTableDetails = sourceSchema.get(tableName); const targetTableDetails = targetSchema.get(tableName);
        const sourceTable = sourceTableDetails?.columns; const targetTable = targetTableDetails?.columns;
        if (sourceTable && !targetTable) { diff.sourceOnlyTables.push(tableName); }
        else if (!sourceTable && targetTable) { diff.targetOnlyTables.push(tableName); }
        else if (sourceTable && targetTable) {
            const tableDiff: TableDiff = { sourceOnlyColumns: [], targetOnlyColumns: [], differingColumns: new Map() }; let differencesFound = false;
            const allColumnNames = new Set([...sourceTable.keys(), ...targetTable.keys()]);
            for (const columnName of allColumnNames) {
                const sourceCol = sourceTable.get(columnName); const targetCol = targetTable.get(columnName);
                if (sourceCol && !targetCol) { tableDiff.sourceOnlyColumns.push(columnName); differencesFound = true; }
                else if (!sourceCol && targetCol) { tableDiff.targetOnlyColumns.push(columnName); differencesFound = true; }
                else if (sourceCol && targetCol) { if (sourceCol.type !== targetCol.type || sourceCol.isNullable !== targetCol.isNullable || (sourceCol.defaultValue ?? 'NULL').toUpperCase() !== (targetCol.defaultValue ?? 'NULL').toUpperCase()) { tableDiff.differingColumns.set(columnName, { sourceDef: sourceCol, targetDef: targetCol }); differencesFound = true; } }
            } if (differencesFound) { diff.differingTables.set(tableName, tableDiff); } else { diff.identicalTables.push(tableName); }
        }
    } return diff;
}

// --- Helper Function to Format Schema Diff ---
function formatSchemaDiff(diff: SchemaDiff, sourceDb: string, targetDb: string): string {
    let report = `Schema Comparison Report (${sourceDb} vs ${targetDb}):\n\n`; let changesFound = false;
    if (diff.sourceOnlyTables.length > 0) { report += `Tables ONLY in Source (${sourceDb}):\n - ${diff.sourceOnlyTables.join('\n - ')}\n\n`; changesFound = true; }
    if (diff.targetOnlyTables.length > 0) { report += `Tables ONLY in Target (${targetDb}):\n - ${diff.targetOnlyTables.join('\n - ')}\n\n`; changesFound = true; }
    if (diff.differingTables.size > 0) {
        report += `Tables with Differences:\n`; changesFound = true;
        for (const [tableName, tableDiff] of diff.differingTables.entries()) {
            report += `\n [+] Table: ${tableName}\n`;
            if (tableDiff.sourceOnlyColumns.length > 0) { report += `   - Columns ONLY in Source: ${tableDiff.sourceOnlyColumns.join(', ')}\n`; }
            if (tableDiff.targetOnlyColumns.length > 0) { report += `   - Columns ONLY in Target: ${tableDiff.targetOnlyColumns.join(', ')}\n`; }
            if (tableDiff.differingColumns.size > 0) {
                report += `   - Differing Column Definitions:\n`;
                for (const [colName, colDiff] of tableDiff.differingColumns.entries()) { report += `     * ${colName}:\n`; report += `       - Source (${sourceDb}): Type=${colDiff.sourceDef?.type}, Nullable=${colDiff.sourceDef?.isNullable}, Default=${colDiff.sourceDef?.defaultValue ?? 'NULL'}\n`; report += `       - Target (${targetDb}): Type=${colDiff.targetDef?.type}, Nullable=${colDiff.targetDef?.isNullable}, Default=${colDiff.targetDef?.defaultValue ?? 'NULL'}\n`; }
            }
        } report += "\n";
    } if (!changesFound) { report += "No differences found between the schemas (based on table existence and column definitions).\n"; } else { if (diff.identicalTables.length > 0) { report += `Identical Tables: ${diff.identicalTables.join(', ')}\n`; } } return report;
}

// --- Tool Handlers ---

// --- Tool: get_indexes ---
const getIndexesRawInput = {
    databaseName: z.string().describe("The name of the database."),
    table: z.string().optional().describe("Optional: The specific table to get indexes for. If omitted, gets indexes for all tables in the database.")
};
const GetIndexesInputSchema = z.object(getIndexesRawInput);
const getIndexesHandler = async (args: z.infer<typeof GetIndexesInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, table } = args; let connection: PoolConnection | null = null;
    try {
        connection = await pool.getConnection();
        let indexes: RowDataPacket[] = [];
        if (table) {
            const sql = `SHOW INDEX FROM ${mysql.escapeId(table)} IN ${mysql.escapeId(databaseName)};`;
            console.error(`[get_indexes] Executing: ${sql}`);
             try { const [results] = await connection.query<RowDataPacket[]>(sql); indexes = results; }
             catch (showIndexError: any) { if (showIndexError.code === 'ER_NO_SUCH_TABLE') { return { content: [{ type: "text", text: `Table '${table}' not found in database '${databaseName}'.` }] }; } throw showIndexError; }
        } else {
            const [tablesResult] = await connection.query<RowDataPacket[]>(`SHOW TABLES IN ${mysql.escapeId(databaseName)};`);
            const tableNames = tablesResult.map(row => Object.values(row)[0] as string);
            for (const tableName of tableNames) {
                const tableSql = `SHOW INDEX FROM ${mysql.escapeId(tableName)} IN ${mysql.escapeId(databaseName)};`;
                 console.error(`[get_indexes] Executing: ${tableSql}`);
                try { const [tableIndexes] = await connection.query<RowDataPacket[]>(tableSql); indexes.push(...tableIndexes.map(idx => ({ ...idx, Table_name_explicit: tableName }))); }
                catch (tableError: any) { console.error(`[get_indexes] Error fetching indexes for table '${tableName}':`, tableError); }
            }
        }
        if (indexes.length === 0) {
            const message = table ? `No indexes found for table '${table}' in database '${databaseName}' (or table does not exist).` : `No indexes found across accessible tables in database '${databaseName}'.`;
            return { content: [{ type: "text", text: message }] };
        }
        const formattedIndexes = JSON.stringify(indexes, null, 2);
        const title = table ? `Indexes for table '${table}' in database '${databaseName}':` : `Indexes for accessible tables in database '${databaseName}':`;
        return { content: [{ type: "text", text: `${title}\n\n${formattedIndexes}` }] };
    }
    catch (error: any) { return formatErrorResponse('get_indexes', table ? `get indexes for table '${table}'` : 'get indexes', error, databaseName, table); }
    finally { if (connection) connection.release(); }
    return { isError: true, content: [{ type: "text", text: "[get_indexes] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: get_constraints ---
const getConstraintsRawInput = {
    databaseName: z.string().describe("The name of the database."),
    table: z.string().optional().describe("Optional: The specific table to get constraints for."),
    constraint_type: z.enum(["PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "CHECK"]).optional().describe("Optional: Filter by constraint type.")
};
const GetConstraintsInputSchema = z.object(getConstraintsRawInput);
const getConstraintsHandler = async (args: z.infer<typeof GetConstraintsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, table, constraint_type } = args; let connection: PoolConnection | null = null;
    try {
        connection = await pool.getConnection();
        let sql = `SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ?`;
        const params: string[] = [databaseName];
        if (table) { sql += ` AND TABLE_NAME = ?`; params.push(table); }
        if (constraint_type) { sql += ` AND CONSTRAINT_TYPE = ?`; params.push(constraint_type); }
        sql += ` ORDER BY TABLE_NAME, CONSTRAINT_TYPE, CONSTRAINT_NAME;`;
        console.error(`[get_constraints] Executing query on INFORMATION_SCHEMA...`);
        const [constraints] = await connection.query<RowDataPacket[]>(sql, params);
        if (constraints.length === 0) {
             let message = `No constraints found matching the criteria in database '${databaseName}'.`;
             if(table) message = `No constraints found matching the criteria for table '${table}' in database '${databaseName}'.`;
             return { content: [{ type: "text", text: message }] };
        }
        const formattedConstraints = JSON.stringify(constraints, null, 2);
        let title = `Constraints matching criteria in database '${databaseName}':`;
        if(table) title = `Constraints matching criteria for table '${table}' in database '${databaseName}':`;
        return { content: [{ type: "text", text: `${title}\n\n${formattedConstraints}` }] };
    }
    catch (error: any) { return formatErrorResponse('get_constraints', table ? `get constraints for table '${table}'` : 'get constraints', error, databaseName, table); }
    finally { if (connection) connection.release(); }
    return { isError: true, content: [{ type: "text", text: "[get_constraints] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: get_schema ---
const getSchemaRawInput = {
    databaseName: z.string().describe("The name of the database."),
    detail_level: z.enum(["basic", "detailed", "complete"]).default("detailed").describe("Level of detail: basic (tables), detailed (tables, columns), complete (tables, columns, indexes, constraints)."),
    tables: z.array(z.string()).optional().describe("Optional: List of specific tables to include.")
};
const GetSchemaInputSchema = z.object(getSchemaRawInput);
const getSchemaHandler = async (args: z.infer<typeof GetSchemaInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, detail_level, tables } = args; let connection: PoolConnection | null = null;
    try {
        connection = await pool.getConnection();
        console.error(`[get_schema] Fetching schema for DB '${databaseName}' with detail '${detail_level}'...`);
        const schemaData = await fetchSchemaDetails(connection, databaseName, tables);
        if (detail_level === 'basic') {
             const basicSchema: Record<string, {}> = {};
             for (const tableName of schemaData.keys()) { basicSchema[tableName] = {}; }
              return { content: [{ type: "text", text: `Tables in ${databaseName}:\n${JSON.stringify(Object.keys(basicSchema), null, 2)}` }] };
        } else if (detail_level === 'detailed') {
             for (const tableDetails of schemaData.values()) { delete tableDetails.indexes; delete tableDetails.constraints; }
        }
        const resultObject: Record<string, any> = {};
         for (const [tableName, details] of schemaData.entries()) {
             resultObject[tableName] = {
                 columns: Object.fromEntries(details.columns.entries()),
                 indexes: detail_level === 'complete' ? Object.fromEntries(details.indexes?.entries() ?? []) : undefined,
                 constraints: detail_level === 'complete' ? details.constraints : undefined,
             };
             if (detail_level !== 'complete') {
                 if (!resultObject[tableName].indexes) delete resultObject[tableName].indexes;
                 if (!resultObject[tableName].constraints) delete resultObject[tableName].constraints;
             }
         }
        if (Object.keys(resultObject).length === 0) {
             return { content: [{ type: "text", text: `No tables found matching criteria in database '${databaseName}'.` }] };
        }
        const jsonResult = JSON.stringify(resultObject, null, 2);
        return { content: [{ type: "text", text: `Schema details for '${databaseName}' (Level: ${detail_level}):\n\n${jsonResult}` }] };
    }
    catch (error: any) { return formatErrorResponse('get_schema', `retrieve schema details for '${databaseName}'`, error, databaseName); }
    finally { if (connection) connection.release(); }
    return { isError: true, content: [{ type: "text", text: "[get_schema] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: compare_schemas ---
const compareSchemasRawInput = {
    sourceDatabaseName: z.string().describe("The primary database schema to compare."),
    target_connection: z.object({
        host: z.string().describe("Hostname or IP address of the target database server."), // ADDED describe
        user: z.string().describe("Username for connecting to the target database."), // ADDED describe
        password: z.string().optional().describe("Password for the target database user (optional)."), // ADDED describe
        port: z.number().int().positive().optional().default(3306).describe("Port number for the target database server (default: 3306)."), // ADDED describe
        databaseName: z.string().describe("The database name in the target connection."),
    }).describe("Connection details for the database schema to compare against.")
};
const CompareSchemasInputSchema = z.object(compareSchemasRawInput);
const compareSchemasHandler = async (args: z.infer<typeof CompareSchemasInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { sourceDatabaseName, target_connection } = args; let sourceConnection: PoolConnection | null = null; let targetConnection: Connection | null = null;
    try {
        console.error(`[compare_schemas] Getting connection from pool for source DB: ${sourceDatabaseName}`);
        sourceConnection = await pool.getConnection();
        console.error(`[compare_schemas] Creating connection for target DB: ${target_connection.databaseName} on ${target_connection.host}`);
        targetConnection = await mysql.createConnection({ host: target_connection.host, user: target_connection.user, password: target_connection.password, port: target_connection.port, database: target_connection.databaseName });
        await targetConnection.ping(); console.error(`[compare_schemas] Target connection successful.`);
        console.error(`[compare_schemas] Fetching schema details for source: ${sourceDatabaseName}`);
        const sourceSchema = await fetchSchemaDetails(sourceConnection, sourceDatabaseName);
        console.error(`[compare_schemas] Fetched ${sourceSchema.size} tables from source.`);
        console.error(`[compare_schemas] Fetching schema details for target: ${target_connection.databaseName}`);
        const targetSchema = await fetchSchemaDetails(targetConnection, target_connection.databaseName);
        console.error(`[compare_schemas] Fetched ${targetSchema.size} tables from target.`);
        console.error(`[compare_schemas] Comparing schemas...`);
        const schemaDiff = diffSchemas(sourceSchema, targetSchema);
        console.error(`[compare_schemas] Formatting report...`);
        const report = formatSchemaDiff(schemaDiff, sourceDatabaseName, target_connection.databaseName);
        return { content: [{ type: "text", text: report }] };
    }
    catch (error: any) {
        let operationDesc = `compare schema between '${sourceDatabaseName}' and '${target_connection.databaseName}'`;
        let dbNameForError = sourceDatabaseName;
        if (error.message.includes('target') || (targetConnection && error.address === target_connection.host)) { dbNameForError = target_connection.databaseName; operationDesc += ` (Error likely related to target DB: ${target_connection.databaseName} on ${target_connection.host})`; }
        else { operationDesc += ` (Error likely related to source DB: ${sourceDatabaseName})`; }
        return formatErrorResponse('compare_schemas', operationDesc, error, dbNameForError);
     }
    finally {
        if (sourceConnection) { console.error("[compare_schemas] Releasing source connection."); sourceConnection.release(); }
        if (targetConnection) { console.error("[compare_schemas] Closing target connection."); await targetConnection.end(); }
    }
    return { isError: true, content: [{ type: "text", text: "[compare_schemas] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: explain_schema ---
const explainSchemaRawInput = {
    databaseName: z.string().describe("The database whose schema needs explanation."),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to explain. If omitted, explains all tables."),
    format: z.enum(["text", "structured"]).default("text").describe("Output format: 'text' (natural language) or 'structured' (JSON).")
};
const ExplainSchemaInputSchema = z.object(explainSchemaRawInput);
function generateSchemaExplanationText(dbName: string, schemaData: SchemaDetails): string {
    let text = `Schema Explanation for Database: ${dbName}\n\n`;
    if (schemaData.size === 0) { return text + "No tables found matching the criteria."; }
    for (const [tableName, details] of schemaData.entries()) {
        text += `Table: ${mysql.escapeId(tableName)}\n`;
        if (details.columns.size > 0) {
            text += "  Columns:\n";
            for (const [colName, colDef] of details.columns.entries()) {
                text += `    - ${mysql.escapeId(colName)}: ${colDef.type}`;
                text += colDef.isNullable === 'NO' ? ' (NOT NULL)' : ' (NULLABLE)';
                if (colDef.defaultValue !== null) text += ` (Default: ${colDef.defaultValue})`;
                if (colDef.isPrimaryKey) text += ' [PRIMARY KEY]';
                if (colDef.isAutoIncrement) text += ' [AUTO_INCREMENT]';
                if (colDef.comment) text += ` -- ${colDef.comment}`;
                text += '\n';
            }
        } else { text += "  (No columns found)\n"; }
        if (details.indexes && details.indexes.size > 0) {
            text += "  Indexes:\n";
            for (const [indexName, indexDef] of details.indexes.entries()) {
                 if (indexName === 'PRIMARY' && Array.from(details.columns.values()).some(c => c.isPrimaryKey)) continue;
                text += `    - ${mysql.escapeId(indexName)} (${indexDef.isUnique ? 'UNIQUE ' : ''}${indexDef.type}): [${indexDef.columns.map(c => mysql.escapeId(c)).join(', ')}]\n`;
            }
        }
         if (details.constraints && details.constraints.length > 0) {
            text += "  Constraints:\n";
            for (const constraint of details.constraints) {
                 text += `    - ${mysql.escapeId(constraint.name)} (${constraint.type}): `;
                 if (constraint.type === 'FOREIGN KEY') { text += `[${constraint.columns?.map(c => mysql.escapeId(c)).join(', ')}] REFERENCES ${mysql.escapeId(constraint.referencedTable ?? '')} [${constraint.referencedColumns?.map(c => mysql.escapeId(c)).join(', ')}]`; }
                 else if (constraint.type === 'CHECK') { text += `${constraint.checkClause}`; }
                 else if (constraint.columns) { text += `[${constraint.columns.map(c => mysql.escapeId(c)).join(', ')}]`; }
                 text += '\n';
            }
         }
        text += "\n";
    }
    return text;
 }
const explainSchemaHandler = async (args: z.infer<typeof ExplainSchemaInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, tables, format } = args; let connection: PoolConnection | null = null;
    try {
        connection = await pool.getConnection();
        console.error(`[explain_schema] Fetching schema details for DB '${databaseName}'...`);
        const schemaData = await fetchSchemaDetails(connection, databaseName, tables);
        if (format === 'structured') {
             const resultObject: Record<string, any> = {};
             for (const [tableName, details] of schemaData.entries()) {
                 resultObject[tableName] = { columns: Object.fromEntries(details.columns.entries()), indexes: Object.fromEntries(details.indexes?.entries() ?? []), constraints: details.constraints };
             }
            const jsonResult = JSON.stringify(resultObject, null, 2);
            return { content: [{ type: "text", text: `Structured Schema for '${databaseName}':\n\n${jsonResult}` }] };
        }
        else { const explanationText = generateSchemaExplanationText(databaseName, schemaData); return { content: [{ type: "text", text: explanationText }] }; }
    }
    catch (error: any) { return formatErrorResponse('explain_schema', `explain schema for '${databaseName}'`, error, databaseName); }
    finally { if (connection) connection.release(); }
     return { isError: true, content: [{ type: "text", text: "[explain_schema] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: detect_schema_changes ---
const detectSchemaChangesRawInput = {
    databaseName: z.string().describe("The database to check for schema changes."),
    baseline_time: z.string().datetime({ message: "Invalid ISO 8601 datetime format" }).optional().describe("Optional: ISO 8601 timestamp. NOTE: This implementation cannot compare against a past state; it returns the current schema.")
};
const DetectSchemaChangesInputSchema = z.object(detectSchemaChangesRawInput);
const detectSchemaChangesHandler = async (args: z.infer<typeof DetectSchemaChangesInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, baseline_time } = args; let connection: PoolConnection | null = null;
    try {
        let message = `Schema Change Detection for '${databaseName}':\n\n`;
        message += "NOTE: This tool currently returns the *current* schema details. It cannot reliably compare against a specific past baseline time (`${baseline_time}`) without external snapshot storage or database audit logs.\n\n";
        message += "You can use the returned current schema as a baseline for future comparisons.\n\n";
        connection = await pool.getConnection();
        console.error(`[detect_schema_changes] Fetching current schema for DB '${databaseName}'...`);
        const schemaData = await fetchSchemaDetails(connection, databaseName);
         const resultObject: Record<string, any> = {};
         for (const [tableName, details] of schemaData.entries()) {
             resultObject[tableName] = { columns: Object.fromEntries(details.columns.entries()), indexes: Object.fromEntries(details.indexes?.entries() ?? []), constraints: details.constraints };
         }
        const jsonResult = JSON.stringify(resultObject, null, 2);
        message += `Current Schema Snapshot:\n${jsonResult}`;
        return { content: [{ type: "text", text: message }] };
    }
    catch (error: any) { return formatErrorResponse('detect_schema_changes', `fetch current schema for '${databaseName}'`, error, databaseName); }
    finally { if (connection) connection.release(); }
     return { isError: true, content: [{ type: "text", text: "[detect_schema_changes] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: find_relationships ---
const findRelationshipsRawInput = {
    databaseName: z.string().describe("The database to search within."),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to focus on. If omitted, searches the entire database."),
    include_implicit: z.boolean().default(false).describe("Attempt to find implicit relationships based on naming conventions (e.g., 'table_id' column). WARNING: Can be inaccurate.")
};
const FindRelationshipsInputSchema = z.object(findRelationshipsRawInput);
async function fetchExplicitRelationships(connection: PoolConnection | Connection, dbName: string, tableNames?: string[]): Promise<Relationship[]> {
    const relationships: Relationship[] = [];
    const sql = `SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME WHERE kcu.CONSTRAINT_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL ${tableNames && tableNames.length > 0 ? 'AND kcu.TABLE_NAME IN (?)' : ''} ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;`;
    const params: any[] = [dbName]; if (tableNames && tableNames.length > 0) { params.push(tableNames); }
    const [results] = await connection.query<RowDataPacket[]>(sql, params);
    const groupedByConstraint: Map<string, Relationship> = new Map();
    for (const row of results) { const key = row.CONSTRAINT_NAME; if (!groupedByConstraint.has(key)) { groupedByConstraint.set(key, { constraintName: row.CONSTRAINT_NAME, sourceTable: row.TABLE_NAME, sourceColumns: [], referencedTable: row.REFERENCED_TABLE_NAME, referencedColumns: [], type: 'explicit' }); } groupedByConstraint.get(key)!.sourceColumns.push(row.COLUMN_NAME); groupedByConstraint.get(key)!.referencedColumns.push(row.REFERENCED_COLUMN_NAME); } return Array.from(groupedByConstraint.values());
 }
async function fetchImplicitRelationships(connection: PoolConnection | Connection, dbName: string, tableNames?: string[]): Promise<ImplicitRelationship[]> {
    console.log("[find_relationships] Attempting to detect implicit relationships..."); const implicitRelationships: ImplicitRelationship[] = [];
    let columnSql = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_KEY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?`; const columnParams: any[] = [dbName]; if (tableNames && tableNames.length > 0) { columnSql += ` AND TABLE_NAME IN (?)`; columnParams.push(tableNames); } columnSql += ` ORDER BY TABLE_NAME, ORDINAL_POSITION;`; const [allColumns] = await connection.query<RowDataPacket[]>(columnSql, columnParams);
    const existingTables = new Set<string>(); const primaryKeys: Map<string, string> = new Map(); allColumns.forEach(col => { existingTables.add(col.TABLE_NAME); if (col.COLUMN_KEY === 'PRI') { primaryKeys.set(col.TABLE_NAME, col.COLUMN_NAME); } });
    for (const tableName of existingTables) { if (!primaryKeys.has(tableName)) { const idColumn = allColumns.find(col => col.TABLE_NAME === tableName && col.COLUMN_NAME.toLowerCase() === 'id'); if (idColumn) { primaryKeys.set(tableName, idColumn.COLUMN_NAME); } } }
    for (const col of allColumns) { const sourceTable = col.TABLE_NAME; const sourceColumn = col.COLUMN_NAME; if (col.COLUMN_KEY === 'PRI') continue; if (sourceColumn.toLowerCase().endsWith('_id')) { const potentialRefTable = sourceColumn.substring(0, sourceColumn.length - 3); if (existingTables.has(potentialRefTable)) { if (sourceTable !== potentialRefTable) { const referencedPK = primaryKeys.get(potentialRefTable); if (referencedPK) { console.log(`[find_relationships] Found potential implicit relationship: ${sourceTable}.${sourceColumn} -> ${potentialRefTable}.${referencedPK}`); implicitRelationships.push({ sourceTable: sourceTable, sourceColumn: sourceColumn, referencedTable: potentialRefTable, referencedColumn: referencedPK, type: 'implicit' }); } } } } } console.log(`[find_relationships] Found ${implicitRelationships.length} potential implicit relationship(s).`); return implicitRelationships;
 }
const findRelationshipsHandler = async (args: z.infer<typeof FindRelationshipsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, tables, include_implicit } = args; let connection: PoolConnection | null = null;
    try {
        let resultsText = '';
        let combinedResults: (Relationship | ImplicitRelationship)[] = [];
        if (include_implicit) { resultsText += "NOTE: Implicit relationship detection is based on naming conventions (`table_id` -> `table`.`id` or PK) and may be inaccurate.\n\n"; }
        connection = await pool.getConnection();
        console.error(`[find_relationships] Fetching explicit FK relationships for DB '${databaseName}'...`);
        const explicitRelationships = await fetchExplicitRelationships(connection, databaseName, tables);
        combinedResults = [...explicitRelationships];
        if (include_implicit) { const implicitRelationships = await fetchImplicitRelationships(connection, databaseName, tables); combinedResults = [...combinedResults, ...implicitRelationships]; }
        if (combinedResults.length === 0) { resultsText += `No explicit${include_implicit ? ' or potential implicit' : ''} relationships found matching the criteria in database '${databaseName}'.`; }
        else { resultsText += `Found ${explicitRelationships.length} explicit${include_implicit ? ` and ${combinedResults.length - explicitRelationships.length} potential implicit` : ''} relationship(s) in '${databaseName}':\n\n`; resultsText += JSON.stringify(combinedResults, null, 2); }
        return { content: [{ type: "text", text: resultsText }] };
    }
    catch (error: any) { return formatErrorResponse('find_relationships', `find relationships for '${databaseName}'`, error, databaseName); }
    finally { if (connection) connection.release(); }
     return { isError: true, content: [{ type: "text", text: "[find_relationships] Unexpected error: Handler ended without returning result." }] };
};

// --- Tool: find_navigation_paths ---
const findNavigationPathsRawInput = {
    databaseName: z.string().describe("The database containing the tables and relationships."),
    source_table: z.string().describe("The starting table name."),
    target_table: z.string().describe("The destination table name."),
    max_hops: z.coerce.number().int().positive().optional().default(5).describe("Maximum number of relationship hops allowed in the path.")
};
const FindNavigationPathsInputSchema = z.object(findNavigationPathsRawInput);
function findPathsBFS(startNode: string, endNode: string, maxDepth: number, adjList: Map<string, (Relationship | ImplicitRelationship)[]>): string[][] {
    const paths: string[][] = []; const queue: { node: string; path: string[]; depth: number }[] = [{ node: startNode, path: [startNode], depth: 0 }]; const visitedInPath: Map<string, Set<string>> = new Map();
    while (queue.length > 0) { const { node, path, depth } = queue.shift()!; if (!visitedInPath.has(node)) { visitedInPath.set(node, new Set()); } if (visitedInPath.get(node)!.has(JSON.stringify(path))) { continue; } visitedInPath.get(node)!.add(JSON.stringify(path)); if (node === endNode) { paths.push(path); continue; } if (depth >= maxDepth) { continue; } const relationships = adjList.get(node) || []; for (const rel of relationships) { const neighbor = rel.referencedTable === node ? rel.sourceTable : rel.referencedTable; if (!path.includes(neighbor)) { const newPath = [...path, neighbor]; queue.push({ node: neighbor, path: newPath, depth: depth + 1 }); } } } return paths;
 }
const findNavigationPathsHandler = async (args: z.infer<typeof FindNavigationPathsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseName, source_table, target_table, max_hops } = args; let connection: PoolConnection | null = null;
    try {
        if (source_table === target_table) { return { content: [{ type: "text", text: "Source and target tables are the same." }] }; }
        connection = await pool.getConnection();
        console.error(`[find_navigation_paths] Fetching relationships for DB '${databaseName}'...`);
        const relationshipsToUse = await fetchExplicitRelationships(connection, databaseName); // Use explicit only
        if (relationshipsToUse.length === 0) { return { content: [{ type: "text", text: `No relationships found in database '${databaseName}' to build navigation paths.` }] }; }
        const adjList: Map<string, (Relationship | ImplicitRelationship)[]> = new Map(); const allTables = new Set<string>();
        relationshipsToUse.forEach(rel => { // rel is definitely Relationship here
            allTables.add(rel.sourceTable); allTables.add(rel.referencedTable);
            if (!adjList.has(rel.sourceTable)) adjList.set(rel.sourceTable, []);
            adjList.get(rel.sourceTable)!.push(rel);
            if (!adjList.has(rel.referencedTable)) adjList.set(rel.referencedTable, []);
            const reverseRel: Relationship = { constraintName: rel.constraintName + "_rev", sourceTable: rel.referencedTable, sourceColumns: rel.referencedColumns, referencedTable: rel.sourceTable, referencedColumns: rel.sourceColumns, type: 'explicit' };
            adjList.get(rel.referencedTable)!.push(reverseRel);
        });
        if (!allTables.has(source_table)) { return { content: [{ type: "text", text: `Source table '${source_table}' not found or has no relationships in database '${databaseName}'.` }] }; }
        if (!allTables.has(target_table)) { return { content: [{ type: "text", text: `Target table '${target_table}' not found or has no relationships in database '${databaseName}'.` }] }; }
        console.error(`[find_navigation_paths] Performing BFS from '${source_table}' to '${target_table}' (max hops: ${max_hops})...`);
        const paths = findPathsBFS(source_table, target_table, max_hops, adjList);
        let resultsText = `Navigation Path Search from '${source_table}' to '${target_table}' (Max Hops: ${max_hops}):\n\n`;
        if (paths.length === 0) { resultsText += `No path found within ${max_hops} hops.`; }
        else { resultsText += `Found ${paths.length} path(s):\n`; paths.forEach((path, index) => { resultsText += ` Path ${index + 1}: ${path.join(' -> ')}\n`; }); }
        return { content: [{ type: "text", text: resultsText }] };
    }
    catch (error: any) { return formatErrorResponse('find_navigation_paths', `find paths between '${source_table}' and '${target_table}'`, error, databaseName); }
    finally { if (connection) connection.release(); }
     return { isError: true, content: [{ type: "text", text: "[find_navigation_paths] Unexpected error: Handler ended without returning result." }] };
};


// --- Tool Definitions ---
export const getIndexesTool: ToolDefinition = { name: "get_indexes", description: "Retrieves index information...", rawInputSchema: getIndexesRawInput, handler: getIndexesHandler };
export const getConstraintsTool: ToolDefinition = { name: "get_constraints", description: "Retrieves constraint information...", rawInputSchema: getConstraintsRawInput, handler: getConstraintsHandler };
export const getSchemaTool: ToolDefinition = { name: "get_schema", description: "Retrieves database schema information...", rawInputSchema: getSchemaRawInput, handler: getSchemaHandler };
export const compareSchemasTool: ToolDefinition = { name: "compare_schemas", description: "Compares the schemas...", rawInputSchema: compareSchemasRawInput, handler: compareSchemasHandler };
export const explainSchemaTool: ToolDefinition = { name: "explain_schema", description: "Generates descriptions...", rawInputSchema: explainSchemaRawInput, handler: explainSchemaHandler };
export const detectSchemaChangesTool: ToolDefinition = { name: "detect_schema_changes", description: "Identifies schema changes...", rawInputSchema: detectSchemaChangesRawInput, handler: detectSchemaChangesHandler };
export const findRelationshipsTool: ToolDefinition = { name: "find_relationships", description: "Discovers relationships...", rawInputSchema: findRelationshipsRawInput, handler: findRelationshipsHandler };
export const findNavigationPathsTool: ToolDefinition = { name: "find_navigation_paths", description: "Finds relationship paths...", rawInputSchema: findNavigationPathsRawInput, handler: findNavigationPathsHandler };


// --- Aggregate Metadata Tools (READ-ONLY) ---
export const metadataTools: ToolDefinition[] = [
    getSchemaTool,
    getIndexesTool,
    getConstraintsTool,
    compareSchemasTool,
    explainSchemaTool,
    detectSchemaChangesTool,
    findRelationshipsTool,
    findNavigationPathsTool,
];
