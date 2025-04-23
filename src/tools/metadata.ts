// src/tools/metadata.ts
import { z } from 'zod';
import type { McpToolResponse, ToolDefinition, DatabaseType } from './types.js';
import { MySqlAdapter, PostgresAdapter, IDatabaseAdapter, SchemaDetails, Relationship, ImplicitRelationship, ColumnDefinition, IndexDefinition, ConstraintDefinition } from '../db_adapter.js';
import { performance } from 'perf_hooks';

// --- Helper Function to Get Adapter ---
function getDbAdapter(dbType: DatabaseType): IDatabaseAdapter {
    if (dbType === 'mysql') { return new MySqlAdapter(); }
    else if (dbType === 'postgres') { return new PostgresAdapter(); }
    else { throw new Error(`Unsupported database type: ${dbType}`); }
}

// --- Local Helper Functions (Unchanged from previous version) ---
type ColumnDiff = { sourceDef: ColumnDefinition | null; targetDef: ColumnDefinition | null; };
type TableDiff = { sourceOnlyColumns: string[]; targetOnlyColumns: string[]; differingColumns: Map<string, ColumnDiff>; };
type SchemaDiff = { sourceOnlyTables: string[]; targetOnlyTables: string[]; differingTables: Map<string, TableDiff>; identicalTables: string[]; };
function diffSchemas(sourceSchema: SchemaDetails, targetSchema: SchemaDetails): SchemaDiff { const diff: SchemaDiff = { sourceOnlyTables: [], targetOnlyTables: [], differingTables: new Map(), identicalTables: [] }; const allTableNames = new Set([...sourceSchema.keys(), ...targetSchema.keys()]); for (const tableName of allTableNames) { const sourceTableDetails = sourceSchema.get(tableName); const targetTableDetails = targetSchema.get(tableName); const sourceColumns = sourceTableDetails?.columns; const targetColumns = targetTableDetails?.columns; if (sourceColumns && !targetColumns) { diff.sourceOnlyTables.push(tableName); } else if (!sourceColumns && targetColumns) { diff.targetOnlyTables.push(tableName); } else if (sourceColumns && targetColumns) { const tableDiff: TableDiff = { sourceOnlyColumns: [], targetOnlyColumns: [], differingColumns: new Map() }; let differencesFound = false; const allColumnNames = new Set([...sourceColumns.keys(), ...targetColumns.keys()]); for (const columnName of allColumnNames) { const sourceCol = sourceColumns.get(columnName); const targetCol = targetColumns.get(columnName); if (sourceCol && !targetCol) { tableDiff.sourceOnlyColumns.push(columnName); differencesFound = true; } else if (!sourceCol && targetCol) { tableDiff.targetOnlyColumns.push(columnName); differencesFound = true; } else if (sourceCol && targetCol) { if (sourceCol.type !== targetCol.type || sourceCol.isNullable !== targetCol.isNullable || String(sourceCol.defaultValue).toUpperCase() !== String(targetCol.defaultValue).toUpperCase()) { tableDiff.differingColumns.set(columnName, { sourceDef: sourceCol, targetDef: targetCol }); differencesFound = true; } } } if (differencesFound) { diff.differingTables.set(tableName, tableDiff); } else { diff.identicalTables.push(tableName); } } } return diff; }
function formatSchemaDiff(diff: SchemaDiff, sourceIdentifier: string, targetIdentifier: string, dbType: DatabaseType): string {
    const identifierType = dbType === 'postgres' ? 'schema' : 'database';
    let report = `Schema Comparison Report (${identifierType} ${sourceIdentifier} vs ${identifierType} ${targetIdentifier}):\n\n`;
    let changesFound = false; if (diff.sourceOnlyTables.length > 0) { report += `Tables ONLY in Source (${sourceIdentifier}):\n - ${diff.sourceOnlyTables.join('\n - ')}\n\n`; changesFound = true; } if (diff.targetOnlyTables.length > 0) { report += `Tables ONLY in Target (${targetIdentifier}):\n - ${diff.targetOnlyTables.join('\n - ')}\n\n`; changesFound = true; } if (diff.differingTables.size > 0) { report += `Tables with Differences:\n`; changesFound = true; for (const [tableName, tableDiff] of diff.differingTables.entries()) { report += `\n [+] Table: ${tableName}\n`; if (tableDiff.sourceOnlyColumns.length > 0) { report += `   - Columns ONLY in Source: ${tableDiff.sourceOnlyColumns.join(', ')}\n`; } if (tableDiff.targetOnlyColumns.length > 0) { report += `   - Columns ONLY in Target: ${tableDiff.targetOnlyColumns.join(', ')}\n`; } if (tableDiff.differingColumns.size > 0) { report += `   - Differing Column Definitions:\n`; for (const [colName, colDiff] of tableDiff.differingColumns.entries()) { report += `     * ${colName}:\n`; report += `       - Source (${sourceIdentifier}): Type=${colDiff.sourceDef?.type}, Nullable=${colDiff.sourceDef?.isNullable}, Default=${colDiff.sourceDef?.defaultValue ?? 'NULL'}\n`; report += `       - Target (${targetIdentifier}): Type=${colDiff.targetDef?.type}, Nullable=${colDiff.targetDef?.isNullable}, Default=${colDiff.targetDef?.defaultValue ?? 'NULL'}\n`; } } } report += "\n"; } if (!changesFound) { report += "No differences found between the schemas (based on table existence and column definitions).\n"; } else if (diff.identicalTables.length > 0) { report += `Identical Tables: ${diff.identicalTables.join(', ')}\n`; }
    return report;
}
function generateSchemaExplanationText(identifier: string, schemaData: SchemaDetails, dbType: DatabaseType): string {
    const identifierType = dbType === 'postgres' ? 'Schema' : 'Database';
    let text = `Schema Explanation for ${dbType.toUpperCase()} ${identifierType}: ${identifier}\n\n`;
    if (schemaData.size === 0) { return text + "No tables found matching the criteria."; }
    const escapeId = (id: string) => dbType === 'mysql' ? `\`${id}\`` : `"${id}"`;
    for (const [tableName, details] of schemaData.entries()) { text += `Table: ${escapeId(tableName)}\n`; if (details.columns.size > 0) { text += "  Columns:\n"; for (const [colName, colDef] of details.columns.entries()) { text += `    - ${escapeId(colName)}: ${colDef.type}`; text += colDef.isNullable === 'NO' ? ' (NOT NULL)' : ' (NULLABLE)'; if (colDef.defaultValue !== null && colDef.defaultValue !== undefined) text += ` (Default: ${colDef.defaultValue})`; if (colDef.isPrimaryKey) text += ' [PRIMARY KEY]'; if (colDef.isAutoIncrement) text += ' [AUTO_INCREMENT]'; if (colDef.comment) text += ` -- ${colDef.comment}`; text += '\n'; } } else { text += "  (No columns found)\n"; } if (details.indexes && details.indexes.size > 0) { text += "  Indexes:\n"; for (const [indexName, indexDef] of details.indexes.entries()) { const isPkIndex = indexName.endsWith('_pkey') || indexName === 'PRIMARY'; const hasPkConstraint = details.constraints?.some(c => c.type === 'PRIMARY KEY'); if (isPkIndex && hasPkConstraint) continue; text += `    - ${escapeId(indexName)} (${indexDef.isUnique ? 'UNIQUE ' : ''}${indexDef.type}): [${indexDef.columns.map(c => escapeId(c)).join(', ')}]\n`; } } if (details.constraints && details.constraints.length > 0) { text += "  Constraints:\n"; for (const constraint of details.constraints) { text += `    - ${escapeId(constraint.name)} (${constraint.type}): `; if (constraint.type === 'FOREIGN KEY') { text += `[${constraint.columns?.map(c => escapeId(c)).join(', ')}] REFERENCES ${escapeId(constraint.referencedTable ?? '')} [${constraint.referencedColumns?.map(c => escapeId(c)).join(', ')}]`; } else if (constraint.type === 'CHECK') { text += `${constraint.checkClause}`; } else if (constraint.columns) { text += `[${constraint.columns.map(c => escapeId(c)).join(', ')}]`; } text += '\n'; } } text += "\n"; }
    return text;
}
function findPathsBFS(startNode: string, endNode: string, maxDepth: number, adjList: Map<string, Relationship[]>): string[][] { const paths: string[][] = []; const queue: { node: string; path: string[]; depth: number }[] = [{ node: startNode, path: [startNode], depth: 0 }]; const visitedInPath: Set<string> = new Set(); while (queue.length > 0) { const { node, path, depth } = queue.shift()!; const pathKey = `${node} | ${path.join('->')}`; if (visitedInPath.has(pathKey)) { continue; } visitedInPath.add(pathKey); if (node === endNode) { paths.push(path); continue; } if (depth >= maxDepth) { continue; } const relationships = adjList.get(node) || []; for (const rel of relationships) { const neighbor = rel.referencedTable === node ? rel.sourceTable : rel.referencedTable; if (!path.includes(neighbor)) { const newPath = [...path, neighbor]; queue.push({ node: neighbor, path: newPath, depth: depth + 1 }); } } } return paths; }


// --- Tool Handlers ---

// Tool: get_indexes
const getIndexesRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    table: z.string().optional().describe("Optional: Limit results to a specific table.")
};
const GetIndexesInputSchema = z.object(getIndexesRawInput);
const getIndexesHandler = async (args: z.infer<typeof GetIndexesInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, table } = args;
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

        console.error(`[${databaseType}-get_indexes] Fetching indexes for ${identifierType} '${identifier}'${table ? ` Table '${table}'` : ''}...`);
        const indexes = await adapter.getIndexes(identifier, table);

        if (indexes.length === 0) {
            const message = table
                ? `No indexes found for table '${table}' in ${identifierType} '${identifier}'.`
                : `No indexes found in ${identifierType} '${identifier}'.`;
            return { content: [{ type: "text", text: message }] };
        }
        const formattedIndexes = JSON.stringify(indexes, null, 2);
        const title = table
            ? `Indexes for table '${table}' in ${identifierType} '${identifier}':`
            : `Indexes for ${identifierType} '${identifier}':`;
        return { content: [{ type: "text", text: `${title}\n\n${formattedIndexes}` }] };
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('get_indexes', table ? `get indexes for table '${table}'` : 'get indexes', error, errorIdentifier, table);
    }
};

// Tool: get_constraints
const getConstraintsRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    table: z.string().optional().describe("Optional: Limit results to a specific table."),
    constraint_type: z.enum(["PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "CHECK"]).optional().describe("Optional: Filter by constraint type.")
};
const GetConstraintsInputSchema = z.object(getConstraintsRawInput);
const getConstraintsHandler = async (args: z.infer<typeof GetConstraintsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, table, constraint_type } = args;
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

        console.error(`[${databaseType}-get_constraints] Fetching constraints for ${identifierType} '${identifier}'${table ? ` Table '${table}'` : ''}${constraint_type ? ` Type '${constraint_type}'` : ''}...`);
        const constraints = await adapter.getConstraints(identifier, table, constraint_type);

        if (constraints.length === 0) {
            let message = `No constraints found matching criteria in ${identifierType} '${identifier}'.`;
            if(table) message = `No constraints found for table '${table}' in ${identifierType} '${identifier}'.`;
            if(constraint_type) message += ` (Type: ${constraint_type})`;
            return { content: [{ type: "text", text: message }] };
        }
        const formattedConstraints = JSON.stringify(constraints, null, 2);
        let title = `Constraints matching criteria in ${identifierType} '${identifier}':`;
        if(table) title = `Constraints for table '${table}' in ${identifierType} '${identifier}':`;
        return { content: [{ type: "text", text: `${title}\n\n${formattedConstraints}` }] };
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('get_constraints', table ? `get constraints for table '${table}'` : 'get constraints', error, errorIdentifier, table);
    }
};

// Tool: get_schema
const getSchemaRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    detail_level: z.enum(["basic", "detailed", "complete"]).default("detailed"),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to include. If omitted, includes all tables in the specified database/schema.")
};
const GetSchemaInputSchema = z.object(getSchemaRawInput);
const getSchemaHandler = async (args: z.infer<typeof GetSchemaInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, detail_level, tables } = args;
    const schemaName = args.schemaName || (databaseType === 'postgres' ? 'public' : undefined); // Default schema for PG
    let adapter: IDatabaseAdapter;
    let response: McpToolResponse;
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

        console.error(`[${databaseType}-get_schema] Fetching schema for ${identifierType} '${identifier}' with detail '${detail_level}'...`);

        if (detail_level === 'basic') {
            let schemaDataBasic: SchemaDetails | null = await adapter.getSchemaDetails(identifier, tables);
            let responseTextBasic = "";
            if (!schemaDataBasic || schemaDataBasic.size === 0) {
                 responseTextBasic = `No tables found matching criteria in ${identifierType} '${identifier}'.`;
            } else {
                const tableNames = Array.from(schemaDataBasic.keys());
                responseTextBasic = `Tables in ${identifierType} '${identifier}':\n${tableNames.join('\n')}`;
            }
            response = { content: [{ type: "text", text: responseTextBasic }] };
            console.error(`[${databaseType}-get_schema] Prepared basic response text (first 200 chars): ${responseTextBasic.substring(0, 200)}...`);
            console.error(`[${databaseType}-get_schema] Final basic response content object: ${JSON.stringify(response.content)}`);
            schemaDataBasic = null;
            await new Promise(resolve => setImmediate(resolve));
            console.error(`[${databaseType}-get_schema] Yielded to event loop. Returning basic response.`);
            return response;
        }

        const schemaData: SchemaDetails = await adapter.getSchemaDetails(identifier, tables);
        if (schemaData.size === 0) {
            response = { content: [{ type: "text", text: `No tables found matching criteria in ${identifierType} '${identifier}'.` }] };
        } else {
            const resultObject: Record<string, any> = {};
            for (const [tableName, details] of schemaData.entries()) {
                resultObject[tableName] = {
                    columns: details.columns ? Object.fromEntries(details.columns.entries()) : {},
                    indexes: (detail_level === 'complete' && details.indexes) ? Object.fromEntries(details.indexes.entries()) : undefined,
                    constraints: detail_level === 'complete' ? details.constraints : undefined,
                };
                if (detail_level !== 'complete') {
                    if (resultObject[tableName].indexes === undefined) delete resultObject[tableName].indexes;
                    if (resultObject[tableName].constraints === undefined) delete resultObject[tableName].constraints;
                }
            }
            const jsonResult = JSON.stringify(resultObject, null, 2);
            console.error(`[${databaseType}-get_schema] Size of generated schema JSON: ${jsonResult.length} bytes`);
            const responseText = `Schema details for ${identifierType} '${identifier}' (Level: ${detail_level}):\n\n${jsonResult}`;
            response = { content: [{ type: "text", text: responseText }] };
            console.error(`[${databaseType}-get_schema] Prepared response text (first 200 chars): ${responseText.substring(0, 200)}...`);
        }

        console.error(`[${databaseType}-get_schema] Final response content object: ${JSON.stringify(response.content)}`);
        await new Promise(resolve => setImmediate(resolve));
        console.error(`[${databaseType}-get_schema] Yielded to event loop. Returning detailed/complete response.`);
        return response;

    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        response = adapter.formatError('get_schema', `retrieve schema details for ${databaseType === 'mysql' ? 'database' : 'schema'} '${errorIdentifier}'`, error, errorIdentifier);
        console.error(`[${databaseType}-get_schema] Handler returning error: ${JSON.stringify(response.content)}`);
        await new Promise(resolve => setImmediate(resolve));
        console.error(`[${databaseType}-get_schema] Yielded to event loop after error.`);
        return response;
    }
};

// Tool: compare_schemas
const compareSchemasRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    sourceDatabaseName: z.string().optional().describe("Source MySQL database name (required if databaseType is 'mysql')."),
    targetDatabaseName: z.string().optional().describe("Target MySQL database name (required if databaseType is 'mysql')."),
    sourceSchemaName: z.string().optional().describe("Source PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    targetSchemaName: z.string().optional().describe("Target PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
};
const CompareSchemasInputSchema = z.object(compareSchemasRawInput);
const compareSchemasHandler = async (args: z.infer<typeof CompareSchemasInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, sourceDatabaseName, targetDatabaseName } = args;
    // Default PG schemas if not provided
    const sourceSchemaName = args.sourceSchemaName || (databaseType === 'postgres' ? 'public' : undefined);
    const targetSchemaName = args.targetSchemaName || (databaseType === 'postgres' ? 'public' : undefined);

    let adapter: IDatabaseAdapter;
    let sourceIdentifier: string;
    let targetIdentifier: string;
    let identifierType: string;

     try {
        adapter = getDbAdapter(databaseType);

        if (databaseType === 'mysql') {
            if (!sourceDatabaseName || !targetDatabaseName) return { isError: true, content: [{ type: "text", text: "Missing required source/target 'databaseName' for databaseType 'mysql'." }] };
            if (sourceDatabaseName === targetDatabaseName) return { content: [{ type: "text", text: "Source and target database names are the same." }] };
            sourceIdentifier = sourceDatabaseName;
            targetIdentifier = targetDatabaseName;
            identifierType = 'database';
        } else { // postgres
            if (!sourceSchemaName || !targetSchemaName) return { isError: true, content: [{ type: "text", text: "Missing required source/target 'schemaName' for databaseType 'postgres'." }] };
             if (sourceSchemaName === targetSchemaName) return { content: [{ type: "text", text: "Source and target schema names are the same." }] };
            sourceIdentifier = sourceSchemaName;
            targetIdentifier = targetSchemaName;
            identifierType = 'schema';
        }

        console.error(`[${databaseType}-compare_schemas] Comparing ${identifierType}: '${sourceIdentifier}' vs '${targetIdentifier}'...`);
        console.error(`[${databaseType}-compare_schemas] Fetching schema for source: ${sourceIdentifier}`);
        const sourceSchema = await adapter.getSchemaDetails(sourceIdentifier);
        console.error(`[${databaseType}-compare_schemas] Fetched ${sourceSchema.size} tables from source.`);
        console.error(`[${databaseType}-compare_schemas] Fetching schema for target: ${targetIdentifier}`);
        const targetSchema = await adapter.getSchemaDetails(targetIdentifier);
        console.error(`[${databaseType}-compare_schemas] Fetched ${targetSchema.size} tables from target.`);
        console.error(`[${databaseType}-compare_schemas] Comparing schemas...`);
        const schemaDiff = diffSchemas(sourceSchema, targetSchema);
        console.error(`[${databaseType}-compare_schemas] Formatting report...`);
        const report = formatSchemaDiff(schemaDiff, sourceIdentifier, targetIdentifier, databaseType); // Pass dbType
        return { content: [{ type: "text", text: report }] };
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorSource = databaseType === 'mysql' ? sourceDatabaseName : sourceSchemaName;
        const errorTarget = databaseType === 'mysql' ? targetDatabaseName : targetSchemaName;
        let likelyIdentifier = errorSource;
        if (error.message && errorTarget && error.message.includes(errorTarget)) {
            likelyIdentifier = errorTarget;
        }
        return adapter.formatError('compare_schemas', `compare ${databaseType === 'mysql' ? 'database' : 'schema'} between '${errorSource}' and '${errorTarget}'`, error, likelyIdentifier);
    }
};


// Tool: explain_schema
const explainSchemaRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to include."),
    format: z.enum(["text", "structured"]).default("text").describe("Output format ('text' or 'structured' JSON).")
};
const ExplainSchemaInputSchema = z.object(explainSchemaRawInput);
const explainSchemaHandler = async (args: z.infer<typeof ExplainSchemaInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, tables, format } = args;
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

        console.error(`[${databaseType}-explain_schema] Fetching schema details for ${identifierType} '${identifier}'...`);
        const schemaData = await adapter.getSchemaDetails(identifier, tables);

        if (format === 'structured') {
            const resultObject: Record<string, any> = {};
            for (const [tableName, details] of schemaData.entries()) {
                resultObject[tableName] = {
                    columns: Object.fromEntries(details.columns.entries()),
                    indexes: Object.fromEntries(details.indexes?.entries() ?? []),
                    constraints: details.constraints
                };
            }
            const jsonResult = JSON.stringify(resultObject, null, 2);
            return { content: [{ type: "text", text: `Structured Schema for ${identifierType} '${identifier}':\n\n${jsonResult}` }] };
        } else {
            const explanationText = generateSchemaExplanationText(identifier, schemaData, databaseType); // Pass identifier
            return { content: [{ type: "text", text: explanationText }] };
        }
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('explain_schema', `explain ${databaseType === 'mysql' ? 'database' : 'schema'} '${errorIdentifier}'`, error, errorIdentifier);
    }
};

// Tool: detect_schema_changes
const detectSchemaChangesRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    baseline_time: z.string().datetime({ message: "Invalid ISO 8601 datetime format" }).optional().describe("Baseline time (currently ignored).")
};
const DetectSchemaChangesInputSchema = z.object(detectSchemaChangesRawInput);
const detectSchemaChangesHandler = async (args: z.infer<typeof DetectSchemaChangesInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, baseline_time } = args;
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

        let message = `Schema Change Detection for ${identifierType} '${identifier}':\n\nNOTE: This tool currently returns the *current* schema details (baseline_time is ignored).\n\n`;
        console.error(`[${databaseType}-detect_schema_changes] Fetching current schema for ${identifierType} '${identifier}'...`);
        const schemaData = await adapter.getSchemaDetails(identifier);
        const resultObject: Record<string, any> = {};
        for (const [tableName, details] of schemaData.entries()) {
            resultObject[tableName] = {
                columns: Object.fromEntries(details.columns.entries()),
                indexes: Object.fromEntries(details.indexes?.entries() ?? []),
                constraints: details.constraints
            };
        }
        const jsonResult = JSON.stringify(resultObject, null, 2);
        message += `Current Schema Snapshot:\n${jsonResult}`;
        return { content: [{ type: "text", text: message }] };
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('detect_schema_changes', `fetch current schema for ${databaseType === 'mysql' ? 'database' : 'schema'} '${errorIdentifier}'`, error, errorIdentifier);
    }
};


// Tool: find_relationships
const findRelationshipsRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    tables: z.array(z.string()).optional().describe("Optional: Specific tables to include.")
};
const FindRelationshipsInputSchema = z.object(findRelationshipsRawInput);
const findRelationshipsHandler = async (args: z.infer<typeof FindRelationshipsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, tables } = args;
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

        let resultsText = '';
        console.error(`[${databaseType}-find_relationships] Fetching explicit FK relationships for ${identifierType} '${identifier}'...`);
        const explicitRelationships = await adapter.getRelationships(identifier, tables);
        let combinedResults: Relationship[] = [...explicitRelationships];

        if (combinedResults.length === 0) {
            resultsText += `No explicit foreign key relationships found in ${identifierType} '${identifier}'.`;
        } else {
            resultsText += `Found ${explicitRelationships.length} explicit relationship(s) in ${identifierType} '${identifier}':\n\n${JSON.stringify(combinedResults, null, 2)}`;
        }
        return { content: [{ type: "text", text: resultsText }] };
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
        const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('find_relationships', `find relationships for ${databaseType === 'mysql' ? 'database' : 'schema'} '${errorIdentifier}'`, error, errorIdentifier);
    }
};

// Tool: find_navigation_paths
const findNavigationPathsRawInput = {
    databaseType: z.enum(['mysql', 'postgres']),
    databaseName: z.string().optional().describe("The MySQL database name (required if databaseType is 'mysql')."),
    schemaName: z.string().optional().describe("The PostgreSQL schema name (required if databaseType is 'postgres', defaults to 'public' if omitted)."),
    source_table: z.string().describe("The starting table name."),
    target_table: z.string().describe("The target table name."),
    max_hops: z.coerce.number().int().positive().optional().default(5).describe("Maximum number of relationship hops allowed.")
};
const FindNavigationPathsInputSchema = z.object(findNavigationPathsRawInput);
const findNavigationPathsHandler = async (args: z.infer<typeof FindNavigationPathsInputSchema>, extra: any): Promise<McpToolResponse> => {
    const { databaseType, databaseName, source_table, target_table, max_hops } = args;
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

        if (source_table === target_table) {
            return { content: [{ type: "text", text: "Source and target tables are the same." }] };
        }

        console.error(`[${databaseType}-find_navigation_paths] Fetching relationships for ${identifierType} '${identifier}'...`);
        const relationshipsToUse: Relationship[] = await adapter.getRelationships(identifier);

        if (relationshipsToUse.length === 0) {
            return { content: [{ type: "text", text: `No explicit relationships found in ${identifierType} '${identifier}' to search for paths.` }] };
        }

        const adjList: Map<string, Relationship[]> = new Map();
        const allTables = new Set<string>();
        relationshipsToUse.forEach(rel => {
            allTables.add(rel.sourceTable);
            allTables.add(rel.referencedTable);
            if (!adjList.has(rel.sourceTable)) adjList.set(rel.sourceTable, []);
            adjList.get(rel.sourceTable)!.push(rel);
            if (!adjList.has(rel.referencedTable)) adjList.set(rel.referencedTable, []);
            const reverseRel: Relationship = {
                constraintName: rel.constraintName + "_rev",
                sourceTable: rel.referencedTable,
                sourceColumns: rel.referencedColumns,
                referencedTable: rel.sourceTable,
                referencedColumns: rel.sourceColumns,
                type: 'explicit'
            };
            adjList.get(rel.referencedTable)!.push(reverseRel);
        });

        if (!allTables.has(source_table)) {
            return { content: [{ type: "text", text: `Source table '${source_table}' not found among tables with relationships in ${identifierType} '${identifier}'.` }] };
        }
        if (!allTables.has(target_table)) {
            return { content: [{ type: "text", text: `Target table '${target_table}' not found among tables with relationships in ${identifierType} '${identifier}'.` }] };
        }

        console.error(`[${databaseType}-find_navigation_paths] Performing BFS from '${source_table}' to '${target_table}' (max hops: ${max_hops}) in ${identifierType} '${identifier}'...`);
        const paths = findPathsBFS(source_table, target_table, max_hops, adjList);

        let resultsText = `Navigation Path Search from '${source_table}' to '${target_table}' in ${identifierType} '${identifier}' (Max Hops: ${max_hops}):\n\n`;
        if (paths.length === 0) {
            resultsText += `No path found within ${max_hops} hops using explicit relationships.`;
        } else {
            resultsText += `Found ${paths.length} path(s):\n`;
            paths.forEach((path, index) => {
                resultsText += ` Path ${index + 1}: ${path.join(' -> ')}\n`;
            });
        }
        return { content: [{ type: "text", text: resultsText }] };
    } catch (error: any) {
        adapter = adapter! ?? getDbAdapter(databaseType || 'mysql');
         const errorIdentifier = databaseType === 'mysql' ? databaseName : schemaName;
        return adapter.formatError('find_navigation_paths', `find paths between '${source_table}' and '${target_table}' in ${databaseType === 'mysql' ? 'database' : 'schema'} '${errorIdentifier}'`, error, errorIdentifier);
    }
};


// --- Tool Definitions ---
export const getIndexesTool: ToolDefinition = { name: "get_indexes", description: "Retrieves index information for a specific MySQL database or PostgreSQL schema.", rawInputSchema: getIndexesRawInput, handler: getIndexesHandler };
export const getConstraintsTool: ToolDefinition = { name: "get_constraints", description: "Retrieves constraint information for a specific MySQL database or PostgreSQL schema.", rawInputSchema: getConstraintsRawInput, handler: getConstraintsHandler };
export const getSchemaTool: ToolDefinition = { name: "get_schema", description: "Retrieves schema information (tables, columns, etc.) for a specific MySQL database or PostgreSQL schema.", rawInputSchema: getSchemaRawInput, handler: getSchemaHandler };
export const compareSchemasTool: ToolDefinition = { name: "compare_schemas", description: "Compares the structure (tables, columns) of two MySQL databases or two PostgreSQL schemas.", rawInputSchema: compareSchemasRawInput, handler: compareSchemasHandler };
export const explainSchemaTool: ToolDefinition = { name: "explain_schema", description: "Generates descriptions of tables, columns, constraints, etc., for a specific MySQL database or PostgreSQL schema.", rawInputSchema: explainSchemaRawInput, handler: explainSchemaHandler };
export const detectSchemaChangesTool: ToolDefinition = { name: "detect_schema_changes", description: "Identifies schema changes by showing a snapshot of the current schema for a specific MySQL database or PostgreSQL schema (baseline time ignored).", rawInputSchema: detectSchemaChangesRawInput, handler: detectSchemaChangesHandler };
export const findRelationshipsTool: ToolDefinition = { name: "find_relationships", description: "Discovers explicit foreign key relationships within a specific MySQL database or PostgreSQL schema.", rawInputSchema: findRelationshipsRawInput, handler: findRelationshipsHandler };
export const findNavigationPathsTool: ToolDefinition = { name: "find_navigation_paths", description: "Finds relationship paths between two tables within a specific MySQL database or PostgreSQL schema.", rawInputSchema: findNavigationPathsRawInput, handler: findNavigationPathsHandler };

// --- Aggregate Metadata Tools (READ-ONLY) ---
export const metadataTools: ToolDefinition[] = [ getSchemaTool, getIndexesTool, getConstraintsTool, compareSchemasTool, explainSchemaTool, detectSchemaChangesTool, findRelationshipsTool, findNavigationPathsTool ];
