// src/tools/utils.ts
import { mysqlPool, pgPool, mysqlConfig, pgConfig } from '../config.js'; // Import pools and configs
import type { McpToolResponse, DatabaseType } from './types.js'; // Import shared types including DatabaseType

// Note: isReadOnlyQuery function is removed from here.
// The logic is now implemented within MySqlAdapter and PostgresAdapter respectively.

// --- Shared Error Formatting Helper ---
/**
 * Formats an error into the standard McpToolResponse error structure.
 * Logs the full error server-side.
 * Handles common errors for both MySQL and PostgreSQL.
 * @param toolName Name of the tool where the error occurred.
 * @param operationDesc Description of the operation being attempted.
 * @param error The caught error object.
 * @param databaseType The type of database ('mysql' or 'postgres').
 * @param identifier Optional database name (for mysql) or schema name (for postgres) context.
 * @param tableName Optional table name context.
 * @returns McpToolResponse object representing the error.
 */
export function formatErrorResponse(
    toolName: string,
    operationDesc: string,
    error: any,
    databaseType?: DatabaseType, // Added databaseType
    identifier?: string,        // Renamed from dbName to identifier
    tableName?: string
): McpToolResponse {
    // Determine identifier type for logging/messages
    const identifierType = databaseType === 'postgres' ? 'schema' : 'database';
    const logDbType = databaseType || 'unknown DB';

    console.error(`[${toolName}] Error (${logDbType}) ${operationDesc}:`, error); // Log full error server-side

    // Construct base message using identifier
    let baseMessage = `Failed to ${operationDesc}.`;
    if (tableName && identifier) baseMessage = `Failed to ${operationDesc} for table '${tableName}' in ${identifierType} '${identifier}'.`;
    else if (identifier) baseMessage = `Failed to ${operationDesc} in ${identifierType} '${identifier}'.`;

    let specificError = '';
    const dbType = databaseType || (mysqlPool ? 'mysql' : (pgPool ? 'postgres' : undefined)); // Infer if not provided

    // --- MySQL Error Handling ---
    if (dbType === 'mysql') {
        const host = mysqlConfig.host ?? 'unknown host';
        const user = mysqlConfig.user ?? 'unknown user';
        // Use 'identifier' as databaseName here
        const databaseName = identifier;
        if (error.code) {
            switch (error.code) {
                case 'ER_BAD_DB_ERROR': specificError = `MySQL Error: Database '${databaseName}' does not exist or access denied.`; break;
                case 'ER_NO_SUCH_TABLE': specificError = `MySQL Error: Table '${tableName}' does not exist in database '${databaseName}'.`; break;
                case 'ER_PARSE_ERROR': specificError = `MySQL Syntax Error: ${error.message || 'Check generated query syntax.'}`; break;
                case 'ECONNREFUSED':
                case 'ENOTFOUND': specificError = `MySQL Error: Could not connect to the database host '${error.address || host}'. Check connection details.`; break;
                case 'ER_ACCESS_DENIED_ERROR': specificError = `MySQL Error: Access denied for user '${error.user || user}' to the database server. Check credentials.`; break;
                case 'ER_DBACCESS_DENIED_ERROR': specificError = `MySQL Error: Access denied for user '${error.user || user}' to database '${databaseName}'.`; break;
                case 'ER_TABLEACCESS_DENIED_ERROR': specificError = `MySQL Error: Access denied for user '${error.user || user}' to table '${tableName}'.`; break;
                case 'ER_SPECIFIC_ACCESS_DENIED_ERROR': specificError = `MySQL Error: Specific privilege required is denied for user '${user}'.`; break;
                default: specificError = `MySQL Error Code: ${error.code}.`;
            }
        }
    }
    // --- PostgreSQL Error Handling ---
    else if (dbType === 'postgres') {
        const host = pgConfig.host ?? 'unknown host';
        const user = pgConfig.user ?? 'unknown user';
        // Use 'identifier' as schemaName here for context messages
        const schemaName = identifier;
        // Database name comes from config for connection errors
        const databaseName = pgConfig.database ?? 'unknown database';
        if (error.code) {
            switch (error.code) {
                // Connection Errors
                case 'ECONNREFUSED': specificError = `PostgreSQL Error: Connection refused to host '${host}'. Is the server running and accessible?`; break;
                case 'ENOTFOUND': specificError = `PostgreSQL Error: Host '${host}' not found. Check hostname.`; break;
                case 'ETIMEOUT': specificError = `PostgreSQL Error: Connection timed out to host '${host}'.`; break;
                // Authentication Errors
                case '28000': // invalid_authorization_specification
                case '28P01': specificError = `PostgreSQL Error: Authentication failed for user '${user}'. Check password.`; break;
                // Database Access Errors
                case '3D000': specificError = `PostgreSQL Error: Database '${databaseName}' does not exist.`; break; // Uses configured DB name
                case '42501': specificError = `PostgreSQL Error: Permission denied for database '${databaseName}' or required object/schema '${schemaName}'.`; break; // Insufficient privilege
                // Schema/Table Errors
                case '42P01': specificError = `PostgreSQL Error: Relation (table/view) '${tableName}' or schema '${schemaName}' not found.`; break; // undefined_table / undefined_schema
                case '3F000': specificError = `PostgreSQL Error: Schema '${schemaName}' does not exist.`; break; // invalid_schema_name
                case '42703': specificError = `PostgreSQL Error: Column does not exist. (${error.message})`; break; // undefined_column
                // Data Errors / Constraints
                case '23502': specificError = `PostgreSQL Error: Not-null constraint violation. (${error.column || 'unknown column'})`; break; // not_null_violation
                case '23503': specificError = `PostgreSQL Error: Foreign key constraint violation. (${error.constraint || 'unknown constraint'})`; break; // foreign_key_violation
                case '23505': specificError = `PostgreSQL Error: Unique constraint violation. (${error.constraint || 'unknown constraint'})`; break; // unique_violation
                case '23514': specificError = `PostgreSQL Error: Check constraint violation. (${error.constraint || 'unknown constraint'})`; break; // check_violation
                // Syntax Errors
                case '42601': specificError = `PostgreSQL Syntax Error: ${error.message || 'Check generated query syntax.'}`; break; // syntax_error
                case '42704': specificError = `PostgreSQL Error: Undefined object. (${error.message})`; break; // undefined_object
                case '22P02': specificError = `PostgreSQL Error: Invalid text representation for expected data type. (${error.message})`; break; // invalid_text_representation (e.g., non-integer to int column)

                default: specificError = `PostgreSQL Error Code: ${error.code}.`;
            }
        } else if (error.routine) {
             // Sometimes PG errors are better identified by the routine where they occurred
             specificError = `PostgreSQL Error in routine: ${error.routine}.`;
        }
    }

    // Include original message cautiously for more detail
    const originalErrorMessage = error.message || String(error);
    // Avoid duplicating code if specificError already includes it
    const detailedMessage = specificError.includes(originalErrorMessage)
                            ? `${baseMessage} ${specificError}`
                            : `${baseMessage} ${specificError}\nServer Details: ${originalErrorMessage}`;

    return {
        isError: true,
        content: [{ type: "text", text: detailedMessage }]
    };
}
