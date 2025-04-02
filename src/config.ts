// src/config.ts
import 'dotenv/config'; // Load .env file variables into process.env

/**
 * Database configuration object.
 * Reads connection details from environment variables loaded via dotenv.
 * Ensure your .env file has DB_HOST, DB_USER, DB_PASSWORD, and optionally DB_PORT.
 */
export const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Ensure DB_PORT is parsed correctly or default to 3306
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  // You might want to add other options like connection pooling settings here later
};

// Basic validation to ensure essential variables are loaded
if (!dbConfig.host || !dbConfig.user) {
  console.warn(
    'WARN: DB_HOST or DB_USER environment variables are not set in .env file. Database connections will likely fail.'
  );
  // Depending on requirements, you might throw an error here instead:
  // throw new Error('Missing essential database configuration in .env file (DB_HOST, DB_USER)');
}

// You can add other configurations here as needed (e.g., logging levels)
