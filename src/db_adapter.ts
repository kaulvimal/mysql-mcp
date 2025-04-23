// src/db_adapter.ts
import pg from 'pg';
import type { Pool as PgPool, PoolClient as PgClient, QueryResult as PgQueryResult } from 'pg';
import mysql from 'mysql2/promise';
import type { Pool as MySqlPool, PoolConnection as MySqlConnection, RowDataPacket, FieldPacket, OkPacket, ResultSetHeader } from 'mysql2/promise';
import { mysqlPool, pgPool, mysqlEnabled, pgEnabled, mysqlConfig, pgConfig } from './config.js';
import type { McpToolResponse, DatabaseType } from './tools/types.js'; // Ensure DatabaseType is imported
import { formatErrorResponse } from './tools/utils.js';
import { performance } from 'perf_hooks';

// --- Common Types ---
export type QueryResult = { rows: any[]; fields?: any[]; rowCount?: number | null; affectedRows?: number; insertId?: number | string; command?: string; };
export type ColumnDefinition = { name: string; type: string; isNullable: string; defaultValue: string | null; isPrimaryKey?: boolean; isAutoIncrement?: boolean; comment?: string; };
export type IndexDefinition = { name: string; columns: string[]; isUnique: boolean; type: string; };
export type ConstraintDefinition = { name: string; type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK'; columns?: string[]; referencedTable?: string; referencedColumns?: string[]; checkClause?: string; };
// SchemaDetails key is table name. Nested maps use column/index name as key.
export type SchemaDetails = Map<string, { columns: Map<string, ColumnDefinition>; indexes?: Map<string, IndexDefinition>; constraints?: ConstraintDefinition[]; }>;
export type Relationship = { constraintName: string; sourceTable: string; sourceColumns: string[]; referencedTable: string; referencedColumns: string[]; type: 'explicit'; };
export type ImplicitRelationship = { sourceTable: string; sourceColumn: string; referencedTable: string; referencedColumn: string; type: 'implicit'; };
// export type DatabaseType = 'mysql' | 'postgres'; // Already imported from types.js

// --- Database Adapter Interface ---
// Methods now generally accept an 'identifier' which is databaseName for MySQL
// and schemaName for PostgreSQL for schema-related operations.
// Connection-level operations might still specifically need databaseName.
export interface IDatabaseAdapter {
    databaseType: DatabaseType;
    // Executes a query. Needs databaseName for MySQL's USE statement. PG ignores it (uses pool config).
    executeQuery(databaseName: string, query: string, params?: any[]): Promise<QueryResult>;
    // Identifier is databaseName (mysql) or schemaName (postgres)
    getSchemaDetails(identifier: string, tables?: string[]): Promise<SchemaDetails>;
    // Identifier is databaseName (mysql) or schemaName (postgres)
    getIndexes(identifier: string, table?: string): Promise<RowDataPacket[] | any[]>;
    // Identifier is databaseName (mysql) or schemaName (postgres)
    getConstraints(identifier: string, table?: string, constraintType?: string): Promise<RowDataPacket[] | any[]>;
    // Identifier is databaseName (mysql) or schemaName (postgres)
    getTableColumns(identifier: string, tableName: string): Promise<RowDataPacket[] | any[]>;
    // Identifier is databaseName (mysql) or schemaName (postgres)
    getRelationships(identifier: string, tables?: string[]): Promise<Relationship[]>;
    // Needs databaseName for MySQL's USE statement. PG ignores it.
    explainQuery(databaseName: string, query: string, format?: 'TEXT' | 'JSON'): Promise<QueryResult>;
    // Needs databaseName for PG connection context. MySQL uses GLOBAL status.
    getPerformanceMetrics(databaseName?: string, metricTypes?: string[]): Promise<any>;
    // Checks if a query is read-only based on adapter type.
    isReadOnlyQuery(query: string): boolean;
    // Formats errors. Identifier is dbName (mysql) or schemaName (postgres).
    formatError(toolName: string, operationDesc: string, error: any, identifier?: string, tableName?: string): McpToolResponse;
}

// --- MySQL Adapter Implementation ---
// Remains largely the same, using the passed 'identifier' as databaseName.
export class MySqlAdapter implements IDatabaseAdapter {
    databaseType: DatabaseType = 'mysql';
    private pool: MySqlPool;
    constructor() { if (!mysqlPool) { throw new Error("MySQL pool is not initialized. Check configuration."); } this.pool = mysqlPool; }
    private isMySqlReadOnlyQueryUtil(query: string): boolean { const ALLOWED_QUERY_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'WITH']; const FORBIDDEN_KEYWORDS = [ 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'SET', 'LOCK', 'UNLOCK', 'CALL', 'LOAD', 'HANDLER', 'DO', 'PREPARE', 'EXECUTE', 'DEALLOCATE' ]; const upperQuery = query.trim().toUpperCase(); const firstWord = upperQuery.split(/[\s(]+/)[0]; if (!ALLOWED_QUERY_PREFIXES.includes(firstWord)) { console.error(`[isMySqlReadOnlyQueryUtil] Query rejected: Does not start with allowed prefix. Found: '${firstWord}'`); return false; } for (const keyword of FORBIDDEN_KEYWORDS) { const regex = new RegExp(`\\b${keyword}\\b`); if (regex.test(upperQuery)) { console.error(`[isMySqlReadOnlyQueryUtil] Query rejected: Contains potentially forbidden keyword '${keyword}'.`); return false; } } return true; }
    // Accepts databaseName as 'identifier'
    private async fetchMySqlSchemaDetails(connection: MySqlConnection, databaseName: string, requestedTables?: string[]): Promise<SchemaDetails> { const schemaDetails: SchemaDetails = new Map(); const hasSpecificTables = requestedTables && requestedTables.length > 0; let columnSql = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?`; const columnParams: any[] = [databaseName]; if (hasSpecificTables) { columnSql += ` AND TABLE_NAME IN (?)`; columnParams.push(requestedTables); } columnSql += ` ORDER BY TABLE_NAME, ORDINAL_POSITION;`; const [columns] = await connection.query<RowDataPacket[]>(columnSql, columnParams); for (const col of columns) { const tableName = col.TABLE_NAME; if (!schemaDetails.has(tableName)) { schemaDetails.set(tableName, { columns: new Map(), indexes: new Map(), constraints: [] }); } const tableMap = schemaDetails.get(tableName)!; tableMap.columns.set(col.COLUMN_NAME, { name: col.COLUMN_NAME, type: col.COLUMN_TYPE, isNullable: col.IS_NULLABLE, defaultValue: col.COLUMN_DEFAULT, isPrimaryKey: col.COLUMN_KEY === 'PRI', isAutoIncrement: col.EXTRA.toLowerCase().includes('auto_increment'), comment: col.COLUMN_COMMENT }); } let indexSql = `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX, INDEX_TYPE FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ?`; const indexParams: any[] = [databaseName]; if (hasSpecificTables) { indexSql += ` AND TABLE_NAME IN (?)`; indexParams.push(requestedTables); } indexSql += ` ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;`; const [indexesInfo] = await connection.query<RowDataPacket[]>(indexSql, indexParams); const tempIndexes: Map<string, { tableName: string, name: string, columns: Map<number, string>, isUnique: boolean, type: string }> = new Map(); for (const idx of indexesInfo) { const uniqueIndexKey = `${idx.TABLE_NAME}.${idx.INDEX_NAME}`; if (!tempIndexes.has(uniqueIndexKey)) { tempIndexes.set(uniqueIndexKey, { tableName: idx.TABLE_NAME, name: idx.INDEX_NAME, columns: new Map(), isUnique: idx.NON_UNIQUE === 0, type: idx.INDEX_TYPE }); } tempIndexes.get(uniqueIndexKey)!.columns.set(idx.SEQ_IN_INDEX, idx.COLUMN_NAME); } for (const indexData of tempIndexes.values()) { const tableDetails = schemaDetails.get(indexData.tableName); if (tableDetails) { const orderedColumns = Array.from(indexData.columns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); if (!tableDetails.indexes) tableDetails.indexes = new Map(); tableDetails.indexes?.set(indexData.name, { name: indexData.name, columns: orderedColumns, isUnique: indexData.isUnique, type: indexData.type }); } } let constraintSql = `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION, ccu.CHECK_CLAUSE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_NAME = kcu.TABLE_NAME LEFT JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS ccu ON tc.CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK', 'UNIQUE', 'PRIMARY KEY')`; const constraintParams: any[] = [databaseName]; if (hasSpecificTables) { constraintSql += ` AND tc.TABLE_NAME IN (?)`; constraintParams.push(requestedTables); } constraintSql += ` ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;`; const [constraintsInfo] = await connection.query<RowDataPacket[]>(constraintSql, constraintParams); const tempConstraints = new Map<string, { tableName: string; name: string; type: ConstraintDefinition['type']; columns: Map<number, string>; checkClause?: string; referencedTable?: string; referencedColumns?: Map<number, string>; }>(); for (const con of constraintsInfo) { const uniqueConstraintKey = `${con.TABLE_NAME}.${con.CONSTRAINT_NAME}`; if (!tempConstraints.has(uniqueConstraintKey)) { tempConstraints.set(uniqueConstraintKey, { tableName: con.TABLE_NAME, name: con.CONSTRAINT_NAME, type: con.CONSTRAINT_TYPE, columns: new Map(), checkClause: con.CONSTRAINT_TYPE === 'CHECK' ? con.CHECK_CLAUSE : undefined, referencedTable: con.CONSTRAINT_TYPE === 'FOREIGN KEY' ? con.REFERENCED_TABLE_NAME : undefined, referencedColumns: con.CONSTRAINT_TYPE === 'FOREIGN KEY' ? new Map() : undefined, }); } const constraintData = tempConstraints.get(uniqueConstraintKey)!; if (con.COLUMN_NAME && con.ORDINAL_POSITION !== null) { constraintData.columns.set(con.ORDINAL_POSITION, con.COLUMN_NAME); if (con.CONSTRAINT_TYPE === 'FOREIGN KEY' && con.REFERENCED_COLUMN_NAME) { constraintData.referencedColumns?.set(con.ORDINAL_POSITION, con.REFERENCED_COLUMN_NAME); } } } for (const constraintData of tempConstraints.values()) { const tableDetails = schemaDetails.get(constraintData.tableName); if (tableDetails) { if (!tableDetails.constraints) tableDetails.constraints = []; const orderedColumns = Array.from(constraintData.columns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); let orderedReferencedColumns: string[] | undefined = undefined; if (constraintData.type === 'FOREIGN KEY' && constraintData.referencedColumns) { orderedReferencedColumns = Array.from(constraintData.referencedColumns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); } const pkExists = tableDetails.constraints.some(c => c.type === 'PRIMARY KEY'); if (constraintData.type === 'PRIMARY KEY' && pkExists) continue; tableDetails.constraints.push({ name: constraintData.name, type: constraintData.type, columns: orderedColumns, referencedTable: constraintData.referencedTable, referencedColumns: orderedReferencedColumns, checkClause: constraintData.checkClause }); } } return schemaDetails; }
    // Needs databaseName for USE statement
    async executeQuery(databaseName: string, query: string, params: any[] = []): Promise<QueryResult> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); await connection.query(`USE \`${databaseName}\`;`); const [results, fields] = await connection.query(query, params); if (Array.isArray(results)) { return { rows: results, fields: fields }; } else if (typeof results === 'object' && results !== null && ('affectedRows' in results || 'insertId' in results)) { const okResult = results as OkPacket | ResultSetHeader; return { rows: [], affectedRows: okResult.affectedRows, insertId: 'insertId' in okResult ? okResult.insertId : undefined }; } else { return { rows: [results] }; } } finally { if (connection) connection.release(); } }
    // Identifier is databaseName
    async getSchemaDetails(databaseName: string, tables?: string[]): Promise<SchemaDetails> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); return await this.fetchMySqlSchemaDetails(connection, databaseName, tables); } finally { if (connection) connection.release(); } }
    // Identifier is databaseName
    async getIndexes(databaseName: string, table?: string): Promise<RowDataPacket[]> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); let indexes: RowDataPacket[] = []; const dbId = mysql.escapeId(databaseName); if (table) { const tableId = mysql.escapeId(table); const sql = `SHOW INDEX FROM ${tableId} IN ${dbId};`; const [results] = await connection.query<RowDataPacket[]>(sql); indexes = results; } else { const [tablesResult] = await connection.query<RowDataPacket[]>(`SHOW TABLES IN ${dbId};`); const tableNames = tablesResult.map(row => Object.values(row)[0] as string); for (const tableName of tableNames) { const tableId = mysql.escapeId(tableName); const tableSql = `SHOW INDEX FROM ${tableId} IN ${dbId};`; try { const [tableIndexes] = await connection.query<RowDataPacket[]>(tableSql); indexes.push(...tableIndexes.map(idx => ({ ...idx, Table_name_explicit: tableName }))); } catch (tableError: any) { console.error(`[MySqlAdapter.getIndexes] Error fetching indexes for table '${tableName}':`, tableError); } } } return indexes; } finally { if (connection) connection.release(); } }
    // Identifier is databaseName
    async getConstraints(databaseName: string, table?: string, constraintType?: string): Promise<RowDataPacket[]> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); let sql = `SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ?`; const params: string[] = [databaseName]; if (table) { sql += ` AND TABLE_NAME = ?`; params.push(table); } if (constraintType) { sql += ` AND CONSTRAINT_TYPE = ?`; params.push(constraintType); } sql += ` ORDER BY TABLE_NAME, CONSTRAINT_TYPE, CONSTRAINT_NAME;`; const [constraints] = await connection.query<RowDataPacket[]>(sql, params); return constraints; } finally { if (connection) connection.release(); } }
    // Identifier is databaseName
    async getTableColumns(databaseName: string, tableName: string): Promise<RowDataPacket[]> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); await connection.query(`USE \`${databaseName}\`;`); const [rows] = await connection.query<RowDataPacket[]>(`DESCRIBE \`${tableName}\`;`); return rows; } finally { if (connection) connection.release(); } }
    // Identifier is databaseName
    async getRelationships(databaseName: string, tables?: string[]): Promise<Relationship[]> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); const relationships: Relationship[] = []; const sql = `SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME WHERE kcu.CONSTRAINT_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL ${tables && tables.length > 0 ? 'AND kcu.TABLE_NAME IN (?)' : ''} ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;`; const params: any[] = [databaseName]; if (tables && tables.length > 0) { params.push(tables); } const [results] = await connection.query<RowDataPacket[]>(sql, params); const groupedByConstraint: Map<string, { sourceTable: string; sourceColumns: Map<number, string>; referencedTable: string; referencedColumns: Map<number, string>; }> = new Map(); for (const row of results) { const key = row.CONSTRAINT_NAME; if (!groupedByConstraint.has(key)) { groupedByConstraint.set(key, { sourceTable: row.TABLE_NAME, sourceColumns: new Map(), referencedTable: row.REFERENCED_TABLE_NAME, referencedColumns: new Map() }); } const group = groupedByConstraint.get(key)!; group.sourceColumns.set(row.ORDINAL_POSITION, row.COLUMN_NAME); group.referencedColumns.set(row.ORDINAL_POSITION, row.REFERENCED_COLUMN_NAME); } for (const [constraintName, group] of groupedByConstraint.entries()) { const orderedSourceColumns = Array.from(group.sourceColumns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); const orderedReferencedColumns = Array.from(group.referencedColumns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); relationships.push({ constraintName: constraintName, sourceTable: group.sourceTable, sourceColumns: orderedSourceColumns, referencedTable: group.referencedTable, referencedColumns: orderedReferencedColumns, type: 'explicit' }); } return relationships; } finally { if (connection) connection.release(); } }
    // Needs databaseName for USE statement
    async explainQuery(databaseName: string, query: string, format: 'TEXT' | 'JSON' = 'TEXT'): Promise<QueryResult> { const explainPrefix = format === 'JSON' ? 'EXPLAIN FORMAT=JSON ' : 'EXPLAIN '; const explainQuery = explainPrefix + query; return this.executeQuery(databaseName, explainQuery); }
    // Uses SHOW GLOBAL STATUS, databaseName optional but kept for interface consistency
    async getPerformanceMetrics(databaseName?: string, metricTypes?: string[]): Promise<any> { let connection: MySqlConnection | null = null; try { connection = await this.pool.getConnection(); const defaultMetrics = ['Uptime', 'Threads_connected', 'Threads_running', 'Queries', 'Slow_queries', 'Connections']; const metricsToFetch = metricTypes && metricTypes.length > 0 ? metricTypes : defaultMetrics; const escapeFn = mysql.escape; const likeClauses = metricsToFetch.map(m => `Variable_name LIKE ${escapeFn(m.includes('%') ? m : m + '%')}`).join(' OR '); const sql = `SHOW GLOBAL STATUS WHERE ${likeClauses};`; const [rows] = await connection.query<RowDataPacket[]>(sql); const metrics: Record<string, string> = {}; rows.forEach(row => { metrics[row.Variable_name] = row.Value; }); return metrics; } finally { if (connection) connection.release(); } }
    isReadOnlyQuery(query: string): boolean { return this.isMySqlReadOnlyQueryUtil(query); }
    // Identifier is databaseName
    formatError(toolName: string, operationDesc: string, error: any, identifier?: string, tableName?: string): McpToolResponse {
        // Pass databaseType explicitly
        // FIX: Ensure correct argument order and types
        return formatErrorResponse(toolName, operationDesc, error, this.databaseType, identifier, tableName);
    }
}

// --- PostgreSQL Adapter Implementation ---
// Methods now accept schemaName as 'identifier' where appropriate.
export class PostgresAdapter implements IDatabaseAdapter {
    databaseType: DatabaseType = 'postgres';
    private pool: PgPool;
    constructor() { if (!pgPool) { throw new Error("PostgreSQL pool is not initialized. Check configuration."); } this.pool = pgPool; }

    // Removed private getSchemaName() helper

    // Ignores databaseName, uses pool configuration
    async executeQuery(databaseName: string, query: string, params: any[] = []): Promise<QueryResult> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // databaseName parameter is ignored here, connection pool determines the DB
             console.error(`[PostgresAdapter.executeQuery] Executing query (databaseName parameter '${databaseName}' ignored, using pool config)...`);
             const pgQueryResult: PgQueryResult = await client.query(query, params);
             return {
                 rows: pgQueryResult.rows,
                 fields: pgQueryResult.fields.map(f => ({ name: f.name, tableID: f.tableID, columnID: f.columnID, dataTypeID: f.dataTypeID })),
                 rowCount: pgQueryResult.rowCount,
                 command: pgQueryResult.command,
             };
         } finally {
             if (client) client.release();
         }
    }

    // Accepts schemaName as 'identifier'
    // Internal method updated to accept schemaName directly
    private async fetchPostgresSchemaDetails(client: PgClient, schemaName: string, requestedTables?: string[]): Promise<SchemaDetails> {
        const schemaDetails: SchemaDetails = new Map();
        const hasSpecificTables = requestedTables && requestedTables.length > 0;
        let startTime: number;
        // FIX: Use pgConfig for database name, not client.database
        const currentDb = pgConfig.database || 'unknown'; // Get current DB for logging from config

        // 1. Fetch Columns
        console.error(`[fetchPostgresSchemaDetails] Fetching columns for DB '${currentDb}', Schema '${schemaName}'...`);
        startTime = performance.now();
        // Use schemaName parameter directly in the WHERE clause
        let columnSql = `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, (SELECT COUNT(*) > 0 FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema AND ccu.table_name = tc.table_name WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND ccu.column_name = c.column_name) AS is_primary_key, (SELECT pg_catalog.col_description(cls.oid, c.ordinal_position::int) FROM pg_catalog.pg_class cls WHERE cls.relname = c.table_name AND cls.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = c.table_schema)) as column_comment FROM information_schema.columns c WHERE c.table_schema = $1`; const columnParams: any[] = [schemaName]; let paramIndex = 2; if (hasSpecificTables) { columnSql += ` AND c.table_name = ANY($${paramIndex++}::text[])`; columnParams.push(requestedTables); } columnSql += ` ORDER BY c.table_name, c.ordinal_position;`;
        const { rows: columns } = await client.query(columnSql, columnParams);
        console.error(`[fetchPostgresSchemaDetails] Fetched ${columns.length} columns in ${(performance.now() - startTime).toFixed(2)} ms.`);
        for (const col of columns) { const tableName = col.table_name; if (!schemaDetails.has(tableName)) { schemaDetails.set(tableName, { columns: new Map(), indexes: new Map(), constraints: [] }); } const tableMap = schemaDetails.get(tableName)!; const isAutoIncrement = typeof col.column_default === 'string' && col.column_default.startsWith('nextval('); tableMap.columns.set(col.column_name, { name: col.column_name, type: col.udt_name, isNullable: col.is_nullable, defaultValue: col.column_default, isPrimaryKey: col.is_primary_key, isAutoIncrement: isAutoIncrement, comment: col.column_comment }); }

        // 2. Fetch Indexes
        console.error(`[fetchPostgresSchemaDetails] Fetching indexes for DB '${currentDb}', Schema '${schemaName}'...`);
        startTime = performance.now();
        // Use schemaName parameter directly in the WHERE clause
        let indexSql = `SELECT ix.indrelid::regclass::text AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, am.amname AS index_type, (ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_subscripts(ix.indkey, 1) k ORDER BY k))::text[] AS columns_in_index_def, pg_get_expr(ix.indpred, ix.indrelid) AS filter_condition FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_am am ON am.oid = i.relam JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND i.relkind = 'i'`; const indexParams: any[] = [schemaName]; paramIndex = 2; if (hasSpecificTables) { indexSql += ` AND t.relname = ANY($${paramIndex++}::text[])`; indexParams.push(requestedTables); } indexSql += ` ORDER BY table_name, index_name;`;
        const { rows: indexesInfo } = await client.query(indexSql, indexParams);
        console.error(`[fetchPostgresSchemaDetails] Fetched ${indexesInfo.length} index definitions in ${(performance.now() - startTime).toFixed(2)} ms.`);
        for (const idx of indexesInfo) { const tableDetails = schemaDetails.get(idx.table_name); if (tableDetails) { if (!tableDetails.indexes) tableDetails.indexes = new Map(); const columns = idx.columns_in_index_def.map((def: string) => def.replace(/"/g, '').split('(')[0].trim()); tableDetails.indexes.set(idx.index_name, { name: idx.index_name, columns: columns, isUnique: idx.is_unique, type: idx.index_type }); } }

        // 3. Fetch Constraints (FK, CHECK, UNIQUE, PK)
        console.error(`[fetchPostgresSchemaDetails] Fetching constraints for DB '${currentDb}', Schema '${schemaName}'...`);
        startTime = performance.now();
        // Use schemaName parameter directly in the WHERE clause
        let constraintSql = `SELECT tc.constraint_name, tc.table_name, tc.constraint_type, kcu.column_name, ccu.check_clause, rc.unique_constraint_name AS referenced_constraint_name, kcu_ref.table_name AS referenced_table_name, kcu_ref.column_name AS referenced_column_name, kcu.ordinal_position, kcu_ref.ordinal_position as referenced_ordinal_position FROM information_schema.table_constraints tc LEFT JOIN information_schema.key_column_usage kcu ON tc.constraint_catalog = kcu.constraint_catalog AND tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name LEFT JOIN information_schema.check_constraints ccu ON tc.constraint_catalog = ccu.constraint_catalog AND tc.constraint_schema = ccu.constraint_schema AND tc.constraint_name = ccu.constraint_name LEFT JOIN information_schema.referential_constraints rc ON tc.constraint_catalog = rc.constraint_catalog AND tc.constraint_schema = rc.constraint_schema AND tc.constraint_name = rc.constraint_name LEFT JOIN information_schema.key_column_usage kcu_ref ON rc.unique_constraint_catalog = kcu_ref.constraint_catalog AND rc.unique_constraint_schema = kcu_ref.constraint_schema AND rc.unique_constraint_name = kcu_ref.constraint_name AND kcu.position_in_unique_constraint = kcu_ref.ordinal_position WHERE tc.constraint_schema = $1 AND tc.constraint_type IN ('FOREIGN KEY', 'CHECK', 'UNIQUE', 'PRIMARY KEY')`; const constraintParams: any[] = [schemaName]; paramIndex = 2; if (hasSpecificTables) { constraintSql += ` AND tc.table_name = ANY($${paramIndex++}::text[])`; constraintParams.push(requestedTables); } constraintSql += ` ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;`;
        const { rows: constraintsInfo } = await client.query(constraintSql, constraintParams);
        console.error(`[fetchPostgresSchemaDetails] Fetched ${constraintsInfo.length} constraint definitions in ${(performance.now() - startTime).toFixed(2)} ms.`);
        const tempConstraints = new Map<string, { tableName: string; name: string; type: ConstraintDefinition['type']; columns: Map<number, string>; checkClause?: string; referencedTable?: string; referencedColumns?: Map<number, string>; }>(); for (const con of constraintsInfo) { const uniqueConstraintKey = `${con.table_name}.${con.constraint_name}`; if (!tempConstraints.has(uniqueConstraintKey)) { tempConstraints.set(uniqueConstraintKey, { tableName: con.table_name, name: con.constraint_name, type: con.constraint_type, columns: new Map(), checkClause: con.constraint_type === 'CHECK' ? con.check_clause : undefined, referencedTable: con.constraint_type === 'FOREIGN KEY' ? con.referenced_table_name : undefined, referencedColumns: con.constraint_type === 'FOREIGN KEY' ? new Map() : undefined }); } const constraintData = tempConstraints.get(uniqueConstraintKey)!; if (con.column_name && con.ordinal_position !== null) { constraintData.columns.set(con.ordinal_position, con.column_name); if (con.constraint_type === 'FOREIGN KEY' && con.referenced_column_name && con.referenced_ordinal_position !== null) { constraintData.referencedColumns?.set(con.referenced_ordinal_position, con.referenced_column_name); } } }
        console.error(`[fetchPostgresSchemaDetails] Processing ${tempConstraints.size} unique constraints...`);
        startTime = performance.now();
        for (const constraintData of tempConstraints.values()) { const tableDetails = schemaDetails.get(constraintData.tableName); if (tableDetails) { if (!tableDetails.constraints) tableDetails.constraints = []; const orderedColumns = Array.from(constraintData.columns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); let orderedReferencedColumns: string[] | undefined = undefined; if (constraintData.type === 'FOREIGN KEY' && constraintData.referencedColumns) { orderedReferencedColumns = Array.from(constraintData.referencedColumns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]); } const pkExists = tableDetails.constraints.some(c => c.type === 'PRIMARY KEY'); if (constraintData.type === 'PRIMARY KEY' && pkExists) continue; tableDetails.constraints.push({ name: constraintData.name, type: constraintData.type, columns: orderedColumns, referencedTable: constraintData.referencedTable, referencedColumns: orderedReferencedColumns, checkClause: constraintData.checkClause }); } }
        console.error(`[fetchPostgresSchemaDetails] Finished processing constraints in ${(performance.now() - startTime).toFixed(2)} ms.`);

        return schemaDetails;
    }

    // Identifier is schemaName
    async getSchemaDetails(schemaName: string, tables?: string[]): Promise<SchemaDetails> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // Pass schemaName directly to the internal fetch method
             return await this.fetchPostgresSchemaDetails(client, schemaName, tables);
         } finally {
             if (client) client.release();
         }
    }
    // Identifier is schemaName
    async getIndexes(schemaName: string, table?: string): Promise<any[]> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // Use schemaName directly
             let sql = `SELECT indexname, indexdef, tablename FROM pg_indexes WHERE schemaname = $1`;
             const queryParams: any[] = [schemaName];
             let paramIndex = 2;
             if (table) {
                 sql += ` AND tablename = $${paramIndex++}`;
                 queryParams.push(table);
             }
             sql += ` ORDER BY tablename, indexname;`;
             const result = await client.query(sql, queryParams);
             return result.rows;
         } finally {
             if (client) client.release();
         }
    }
    // Identifier is schemaName
    async getConstraints(schemaName: string, table?: string, constraintType?: string): Promise<any[]> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // Use schemaName directly
             let sql = `SELECT constraint_name, table_name, constraint_type FROM information_schema.table_constraints WHERE constraint_schema = $1`;
             const queryParams: any[] = [schemaName];
             let paramIndex = 2;
             if (table) {
                 sql += ` AND table_name = $${paramIndex++}`;
                 queryParams.push(table);
             }
             if (constraintType) {
                 sql += ` AND constraint_type = $${paramIndex++}`;
                 queryParams.push(constraintType);
             }
             sql += ` ORDER BY table_name, constraint_name;`;
             const result = await client.query(sql, queryParams);
             return result.rows;
         } finally {
             if (client) client.release();
         }
    }
    // Identifier is schemaName
    async getTableColumns(schemaName: string, tableName: string): Promise<any[]> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // Use schemaName directly
             const sql = `SELECT column_name, data_type, is_nullable, column_default, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position;`;
             const result = await client.query(sql, [schemaName, tableName]);
             return result.rows;
         } finally {
             if (client) client.release();
         }
    }
    // Identifier is schemaName
    async getRelationships(schemaName: string, tables?: string[]): Promise<Relationship[]> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // Use schemaName directly
             const relationships: Relationship[] = [];
             const sql = `SELECT rc.constraint_name, tc.table_name AS source_table, kcu.column_name AS source_column, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column, kcu.ordinal_position FROM information_schema.referential_constraints rc JOIN information_schema.table_constraints tc ON tc.constraint_catalog = rc.constraint_catalog AND tc.constraint_schema = rc.constraint_schema AND tc.constraint_name = rc.constraint_name JOIN information_schema.key_column_usage kcu ON kcu.constraint_catalog = rc.constraint_catalog AND kcu.constraint_schema = rc.constraint_schema AND kcu.constraint_name = rc.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_catalog = rc.unique_constraint_catalog AND ccu.constraint_schema = rc.unique_constraint_schema AND ccu.constraint_name = rc.unique_constraint_name WHERE tc.constraint_schema = $1 AND tc.constraint_type = 'FOREIGN KEY' ${tables && tables.length > 0 ? `AND tc.table_name = ANY($2::text[])` : ''} ORDER BY rc.constraint_name, kcu.ordinal_position;`;
             const params: any[] = [schemaName];
             if (tables && tables.length > 0) {
                 params.push(tables);
             }
             const { rows } = await client.query(sql, params);
             const groupedByConstraint: Map<string, { sourceTable: string; sourceColumns: Map<number, string>; referencedTable: string; referencedColumns: Map<number, string>; }> = new Map();
             for (const row of rows) {
                 const key = row.constraint_name;
                 if (!groupedByConstraint.has(key)) {
                     groupedByConstraint.set(key, { sourceTable: row.source_table, sourceColumns: new Map(), referencedTable: row.referenced_table, referencedColumns: new Map() });
                 }
                 const group = groupedByConstraint.get(key)!;
                 group.sourceColumns.set(row.ordinal_position, row.source_column);
                 group.referencedColumns.set(row.ordinal_position, row.referenced_column);
             }
             for (const [constraintName, group] of groupedByConstraint.entries()) {
                 const orderedSourceColumns = Array.from(group.sourceColumns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
                 const orderedReferencedColumns = Array.from(group.referencedColumns.entries()).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
                 relationships.push({ constraintName: constraintName, sourceTable: group.sourceTable, sourceColumns: orderedSourceColumns, referencedTable: group.referencedTable, referencedColumns: orderedReferencedColumns, type: 'explicit' });
             }
             return relationships;
         } finally {
             if (client) client.release();
         }
    }
    // Ignores databaseName, uses pool configuration
    async explainQuery(databaseName: string, query: string, format: 'TEXT' | 'JSON' = 'TEXT'): Promise<QueryResult> {
         console.error(`[PostgresAdapter.explainQuery] Explaining query (databaseName parameter '${databaseName}' ignored, using pool config)...`);
         const explainPrefix = format === 'JSON' ? 'EXPLAIN (FORMAT JSON) ' : 'EXPLAIN ';
         const explainQuery = explainPrefix + query;
         // Call executeQuery which handles connection and ignores databaseName
         const result = await this.executeQuery(databaseName, explainQuery);
         // Handle potential JSON structure difference
         if (format === 'JSON' && Array.isArray(result.rows) && result.rows.length > 0 && result.rows[0]['QUERY PLAN']) {
             return { rows: result.rows[0]['QUERY PLAN'], rowCount: 1, command: 'EXPLAIN' };
         } else if (format === 'JSON' && Array.isArray(result.rows)) {
            return { rows: result.rows, rowCount: result.rows.length, command: 'EXPLAIN' };
         }
         return result;
    }
    // Needs databaseName for pg_stat_database query
    async getPerformanceMetrics(databaseName?: string, metricTypes?: string[]): Promise<any> {
         let client: PgClient | null = null;
         try {
             client = await this.pool.connect();
             // Use provided databaseName, or fallback to pool's config DB name
             const dbNameToQuery = databaseName || this.pool.options.database || pgConfig.database;
             if (!dbNameToQuery) {
                 throw new Error("Database name is required for PostgreSQL performance metrics but was not provided and cannot be determined from pool options.");
             }
             console.error(`[PostgresAdapter.getPerformanceMetrics] Fetching metrics for database '${dbNameToQuery}'...`);
             // Note: pg_stat_activity is cluster-wide, pg_stat_database is per-database
             const activitySql = `SELECT state, count(*) FROM pg_stat_activity WHERE datname = $1 GROUP BY state;`; // Filter activity by current DB
             const dbStatsSql = `SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname = $1;`;
             const activityResult = await client.query(activitySql, [dbNameToQuery]);
             const dbStatsResult = await client.query(dbStatsSql, [dbNameToQuery]);
             const metrics: Record<string, any> = {
                 activity_summary: activityResult.rows.reduce((acc, row) => {
                     acc[row.state || 'unknown'] = parseInt(row.count, 10);
                     return acc;
                 }, {}),
                 database_stats: dbStatsResult.rows[0] || {},
             };
             return metrics;
         } finally {
             if (client) client.release();
         }
    }
    isReadOnlyQuery(query: string): boolean {
         const upperQuery = query.trim().toUpperCase();
         const firstWord = upperQuery.split(/[\s(]+/)[0];
         const allowedPrefixes = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW'];

         if (allowedPrefixes.includes(firstWord)) {
             if (upperQuery.includes('FOR UPDATE') || upperQuery.includes('FOR SHARE')) {
                 console.error(`[PostgresAdapter.isReadOnlyQuery] Query rejected: Contains locking clause (FOR UPDATE/SHARE).`);
                 return false;
             }
             return true;
         }
         const forbiddenKeywords = [
             'INSERT', 'UPDATE', 'DELETE', 'REPLACE',
             'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
             'GRANT', 'REVOKE',
             'SET',
             'LOCK',
             'CALL',
             'DO',
             'REFRESH',
             'PREPARE', 'EXECUTE', 'DEALLOCATE'
         ];
         for (const keyword of forbiddenKeywords) {
             const regex = new RegExp(`\\b${keyword}\\b`);
             if (regex.test(upperQuery)) {
                 console.error(`[PostgresAdapter.isReadOnlyQuery] Query rejected: Contains forbidden keyword '${keyword}'.`);
                 return false;
             }
         }
         console.error(`[PostgresAdapter.isReadOnlyQuery] Query rejected: Does not start with allowed read-only prefix.`);
         return false;
    }
    // Identifier is schemaName
    formatError(toolName: string, operationDesc: string, error: any, identifier?: string, tableName?: string): McpToolResponse {
        // FIX: Ensure correct argument order and types
        // The 4th argument should be the DatabaseType ('mysql' or 'postgres')
        // The 5th argument is the identifier (db name or schema name)
        return formatErrorResponse(toolName, operationDesc, error, this.databaseType, identifier, tableName);
    }
}