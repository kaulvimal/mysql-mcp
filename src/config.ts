// src/config.ts
import 'dotenv/config'; // Load .env file variables into process.env
import mysql from 'mysql2/promise';

/**
 * Database configuration object.
 * Reads connection details from environment variables loaded via dotenv.
 */
const dbConnectionConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  // Consider adding database: process.env.DB_NAME if a default DB is often used
  // waitForConnections: true, // Part of pool options below
  // connectionLimit: 10,     // Part of pool options below
  // queueLimit: 0            // Part of pool options below
};

// Basic validation to ensure essential variables are loaded
if (!dbConnectionConfig.host || !dbConnectionConfig.user) {
  console.error( // Use console.error for important warnings/errors
    'ERROR: DB_HOST or DB_USER environment variables are not set in .env file. Database connections will fail.'
  );
  // Exit gracefully if essential config is missing
  process.exit(1);
  // throw new Error('Missing essential database configuration in .env file (DB_HOST, DB_USER)');
}

/**
 * MySQL Connection Pool.
 * Use pool.getConnection() to get a connection and connection.release() when done.
 * Handles connection management, reuse, and limits.
 */
export const pool = mysql.createPool({
  ...dbConnectionConfig,
  waitForConnections: true, // Wait for available connection if pool is full
  connectionLimit: 10,      // Max number of connections in pool
  queueLimit: 0             // Max number of connection requests to queue (0 = no limit)
});

// Optional: Test the pool connection on startup
pool.getConnection()
  .then(connection => {
    // console.error("Successfully connected to database pool.");
    connection.release();
  })
  .catch(err => {
    console.error("FATAL: Failed to connect to database pool:", err);
    process.exit(1); // Exit if pool cannot be established
  });

// Export the original config too, if needed elsewhere, though pool is preferred
export const dbConfig = dbConnectionConfig;

// You can add other configurations here as needed (e.g., logging levels)
