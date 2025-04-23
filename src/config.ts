// src/config.ts
import 'dotenv/config'; // Load .env file variables into process.env
import mysql from 'mysql2/promise';
import pg from 'pg'; // Import the pg library
import fs from 'fs'; // Import the file system module
import path from 'path'; // Import the path module

// --- MySQL Configuration ---
const mysqlConfig = {
  host: process.env.MYSQL_HOST, // Renamed env var
  user: process.env.MYSQL_USER, // Renamed env var
  password: process.env.MYSQL_PASSWORD, // Renamed env var
  port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306, // Renamed env var
  // database: process.env.MYSQL_DB_NAME // Optional default DB
};

// --- PostgreSQL Configuration ---
const pgConfig = {
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432,
  database: process.env.PG_DATABASE, // PG often requires a database name
  ssl: {
    rejectUnauthorized: true, // Keep verification enabled
    // Read the CA certificate file content
    // Make sure 'ca-certificate.crt' is in the project root or adjust the path
    ca: fs.readFileSync(path.resolve(process.cwd(), '/Users/vimalkaul/Herd/mysql-mcp/ca-certificate.crt')).toString(),
  }
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
  console.error("PostgreSQL configuration found, enabling PostgreSQL support.");
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
  ...pgConfig,
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
            // console.error("Successfully connected to MySQL database pool.");
            mysqlConnection.release();
        } catch (err) {
            console.error("FATAL: Failed to connect to MySQL database pool:", err);
            // Decide if failure is critical
            // process.exit(1);
        }
    }

    if (pgPool) {
        let pgClient;
        try {
            pgClient = await pgPool.connect();
            // console.error("Successfully connected to PostgreSQL database pool.");
            pgClient.release();
        } catch (err) {
            console.error("FATAL: Failed to connect to PostgreSQL database pool:", err);
            // Decide if failure is critical
            // process.exit(1);
        }
    }
}

// Run connection tests
testConnections();


// --- Export individual configs if needed elsewhere ---
export { mysqlConfig, pgConfig, mysqlEnabled, pgEnabled };
