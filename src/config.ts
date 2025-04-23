// src/config.ts
import 'dotenv/config'; // Load .env file variables into process.env
import mysql from 'mysql2/promise';
import pg from 'pg'; // Import the pg library
import fs from 'fs'; // Import the file system module
import path from 'path'; // Import the path module

// --- MySQL Configuration ---
const mysqlConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306,
  // database: process.env.MYSQL_DB_NAME // Optional default DB
};

// --- PostgreSQL Configuration ---
const pgSslCaPath = process.env.PG_SSL_CA_PATH; // Read the CA path from .env
let pgSslConfig: pg.PoolConfig['ssl'] = undefined; // Initialize ssl config as undefined

if (pgSslCaPath) {
    try {
        // Resolve the path relative to the project root (or use absolute path directly)
        const resolvedCaPath = path.resolve(process.cwd(), pgSslCaPath);
        console.error(`Attempting to read PostgreSQL CA certificate from: ${resolvedCaPath}`);
        // Read the certificate file content
        const caCert = fs.readFileSync(resolvedCaPath).toString();
        pgSslConfig = {
            rejectUnauthorized: true, // Keep verification enabled (recommended)
            ca: caCert,
        };
        console.error("Successfully loaded PostgreSQL CA certificate for SSL.");
    } catch (err: any) {
        console.error(`FATAL: Failed to read PostgreSQL CA certificate file from path specified in PG_SSL_CA_PATH (${pgSslCaPath}). Error: ${err.message}`);
        // Decide if this is critical - exit if SSL is mandatory
        // process.exit(1);
        // Or allow connection without custom CA if desired (potentially insecure)
        // pgSslConfig = { rejectUnauthorized: true }; // Example: Still require SSL but use system CAs
        pgSslConfig = undefined; // Fallback: Don't use SSL if CA load fails
        console.warn("Proceeding without custom PostgreSQL SSL CA certificate due to read error.");
    }
} else {
    console.warn("PG_SSL_CA_PATH not defined in .env. PostgreSQL connection will not use a custom CA certificate for SSL.");
    // Set default SSL behavior if needed, e.g., require SSL but use system CAs
    // pgSslConfig = { rejectUnauthorized: true }; // Example
}


const pgConfig: pg.PoolConfig = { // Explicitly type pgConfig
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432,
  database: process.env.PG_DATABASE, // PG often requires a database name
  ssl: pgSslConfig, // Use the dynamically loaded ssl config
};

// --- Environment Variable Validation ---
let mysqlEnabled = false;
if (mysqlConfig.host && mysqlConfig.user) {
  console.error("MySQL configuration found, enabling MySQL support.");
  mysqlEnabled = true;
} else {
  console.warn("MySQL configuration (MYSQL_HOST, MYSQL_USER) not found in .env. MySQL tools will be unavailable.");
}

let pgEnabled = false;
if (pgConfig.host && pgConfig.user && pgConfig.database) {
  // Check if SSL is configured and potentially required
  if (pgSslConfig) {
      console.error("PostgreSQL configuration found with SSL CA, enabling PostgreSQL support.");
  } else {
       console.warn("PostgreSQL configuration found, but SSL CA certificate is not configured or failed to load. Enabling PostgreSQL support without custom CA.");
       // Add a stronger warning or exit if SSL with a specific CA is mandatory for your setup
       // if (process.env.REQUIRE_PG_SSL_CA === 'true') {
       //    console.error("ERROR: Custom PostgreSQL SSL CA is required but failed to load. Exiting.");
       //    process.exit(1);
       // }
  }
  pgEnabled = true;
} else {
  console.warn("PostgreSQL configuration (PG_HOST, PG_USER, PG_DATABASE) not found or incomplete in .env. PostgreSQL tools will be unavailable.");
}

if (!mysqlEnabled && !pgEnabled) {
    console.error("ERROR: No valid database configuration found for either MySQL or PostgreSQL. Exiting.");
    process.exit(1);
}


// --- Connection Pools ---

// MySQL Pool (only create if enabled)
export const mysqlPool = mysqlEnabled ? mysql.createPool({
  ...mysqlConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
}) : null;

// PostgreSQL Pool (only create if enabled)
// pg uses Pool slightly differently
export const pgPool = pgEnabled ? new pg.Pool({
  ...pgConfig, // pgConfig now includes the ssl property
  max: 10, // equivalent to connectionLimit
  idleTimeoutMillis: 300000,
  connectionTimeoutMillis: 5000,
}) : null;


// --- Test Connections (Optional but Recommended) ---
async function testConnections() {
    if (mysqlPool) {
        let mysqlConnection;
        try {
            mysqlConnection = await mysqlPool.getConnection();
            console.error("Successfully connected to MySQL database pool."); // Keep success message
            mysqlConnection.release();
        } catch (err) {
            console.error("FATAL: Failed to connect to MySQL database pool:", err);
            // process.exit(1); // Decide if failure is critical
        }
    }

    if (pgPool) {
        let pgClient;
        try {
            pgClient = await pgPool.connect();
            console.error("Successfully connected to PostgreSQL database pool."); // Keep success message
            pgClient.release();
        } catch (err) {
            console.error("FATAL: Failed to connect to PostgreSQL database pool:", err);
             // process.exit(1); // Decide if failure is critical
        }
    }
}

// Run connection tests
testConnections();


// --- Export individual configs if needed elsewhere ---
export { mysqlConfig, pgConfig, mysqlEnabled, pgEnabled }; // pgConfig includes ssl now
