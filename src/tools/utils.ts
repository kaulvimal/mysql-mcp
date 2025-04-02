// src/tools/utils.ts
import { pool } from '../config.js'; // Import pool for error messages
import type { McpToolResponse } from './types.js'; // Import shared type

// --- Read-Only Query Check ---
const ALLOWED_QUERY_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'WITH'];
const FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'GRANT', 'REVOKE', 'SET', 'LOCK', 'UNLOCK', 'CALL', 'LOAD', 'HANDLER', 'DO',
    'PREPARE', 'EXECUTE', 'DEALLOCATE'
];

export function isReadOnlyQuery(query: string): boolean {
    const upperQuery = query.trim().toUpperCase();
    const firstWord = upperQuery.split(/[\s(]+/)[0];

    if (!ALLOWED_QUERY_PREFIXES.includes(firstWord)) {
         console.warn(`[isReadOnlyQuery] Query rejected: Does not start with allowed prefix. Found: '${firstWord}'`);
        return false;
    }

    if (FORBIDDEN_KEYWORDS.some(keyword => upperQuery.includes(keyword))) {
        let forbiddenFound = false;
        for (const keyword of FORBIDDEN_KEYWORDS) {
             const index = upperQuery.indexOf(keyword);
             if (index !== -1) {
                 const prevChar = index === 0 ? ' ' : upperQuery[index - 1];
                 const nextChar = index + keyword.length >= upperQuery.length ? ' ' : upperQuery[index + keyword.length];
                 const isWholeWord = /[\s(]/.test(prevChar) && /[\s(;,]/.test(nextChar);
                 if(isWholeWord) {
                    forbiddenFound = true;
                    break;
                 }
             }
         }
         if (forbiddenFound) {
             console.warn(`[isReadOnlyQuery] Query rejected: Contains potentially forbidden keyword.`);
             return false;
         }
    }
    return true;
}

// --- Shared Error Formatting Helper ---
/**
 * Formats an error into the standard McpToolResponse error structure.
 * Logs the full error server-side.
 * @param toolName Name of the tool where the error occurred.
 * @param operationDesc Description of the operation being attempted.
 * @param error The caught error object.
 * @param dbName Optional database name context.
 * @param tableName Optional table name context.
 * @returns McpToolResponse object representing the error.
 */
export function formatErrorResponse(toolName: string, operationDesc: string, error: any, dbName?: string, tableName?: string): McpToolResponse {
    console.error(`[${toolName}] Error ${operationDesc}:`, error); // Log full error server-side
    let baseMessage = `Failed to ${operationDesc}.`;
     if (tableName && dbName) baseMessage = `Failed to ${operationDesc} for table '${tableName}' in database '${dbName}'.`;
     else if (dbName) baseMessage = `Failed to ${operationDesc} in database '${dbName}'.`;

    let specificError = '';
    // Attempt to get host/user from pool config for connection errors
    const host = pool.config.host ?? 'unknown host';
    const user = pool.config.user ?? 'unknown user';

    if (error.code) {
        switch (error.code) {
            case 'ER_BAD_DB_ERROR': specificError = `Database '${dbName}' does not exist or access denied.`; break;
            case 'ER_NO_SUCH_TABLE': specificError = `Table '${tableName}' does not exist in database '${dbName}'.`; break;
            case 'ER_PARSE_ERROR': specificError = `SQL Syntax Error: ${error.message || 'Check generated query syntax.'}`; break;
            case 'ECONNREFUSED':
            case 'ENOTFOUND': specificError = `Could not connect to the MySQL database host '${error.address || host}'. Check connection details.`; break;
            case 'ER_ACCESS_DENIED_ERROR': specificError = `Access denied for user '${error.user || user}' to the database server. Check credentials.`; break;
            case 'ER_DBACCESS_DENIED_ERROR': specificError = `Access denied for user '${error.user || user}' to database '${dbName}'.`; break;
            case 'ER_TABLEACCESS_DENIED_ERROR': specificError = `Access denied for user '${error.user || user}' to table '${tableName}'.`; break;
            case 'ER_SPECIFIC_ACCESS_DENIED_ERROR': specificError = `Specific privilege required is denied for user '${user}'.`; break;
            // Add other relevant read-only error codes if needed
            default: specificError = `MySQL Error Code: ${error.code}.`;
        }
    }

    return {
        isError: true,
        content: [{ type: "text", text: `${baseMessage} ${specificError}\nServer Details: ${error.message || error}` }] // Include original message cautiously
    };
}
