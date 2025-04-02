# MySQL MCP Server
## Overview
This project provides a read-only Model Context Protocol (MCP) server for interacting with MySQL databases. It allows clients compatible with MCP to inspect database schemas, retrieve metadata, and execute read-only SQL queries through a set of defined tools. The server is built with extensibility in mind and enforces read-only operations for safety.

## Features & Implemented Tools

The server exposes several tools via MCP for database interaction. All tools are designed for read-only operations.

### Schema & Metadata Tools

* **`get_table_columns`**: Retrieves column definitions for a specific table.
* **`get_schema`**: Fetches detailed schema information including tables, columns, indexes, and constraints, with varying detail levels.
* **`get_indexes`**: Retrieves index information for a specific table or all tables.
* **`get_constraints`**: Fetches constraint information (Primary Key, Foreign Key, Unique, Check) for a specific table or all tables.
* **`compare_schemas`**: Compares the structure (tables and columns) of two different database schemas.
* **`explain_schema`**: Generates a textual or structured (JSON) description of the database schema.
* **`detect_schema_changes`**: Returns a snapshot of the current schema. (Note: Does not compare against a specific past time).
* **`find_relationships`**: Discovers explicit foreign key relationships. Can optionally attempt to find implicit relationships based on naming conventions (use with caution).
* **`find_navigation_paths`**: Finds paths between two tables using explicit foreign key relationships (BFS algorithm).

### Query Execution Tools

* **`execute_query`**: Executes a given read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN).
* **`execute_batch`**: Runs multiple read-only SQL queries sequentially. Can stop on the first error or attempt all.
* **`prepare_statement`**: Prepares and executes a read-only SQL statement with parameters.
* **`explain_query`**: Executes `EXPLAIN` on a given SQL statement to show the query execution plan (TEXT or JSON format).
* **`get_query_history`**: Placeholder tool. Server-side query history is not currently implemented.

### Visualization Tools

* **`visualize_schema`**: Generates schema representations (tables, columns, relationships) in JSON, DOT (Graphviz), or Mermaid syntax suitable for creating ER diagrams.

### Performance Tools

* **`get_performance_metrics`**: Retrieves selected global status variables from MySQL (e.g., Uptime, Threads, Queries). Does not provide query-specific history.


## Setup & Installation

1.  **Prerequisites:**
    * Node.js
    * npm
    * Access to a MySQL database

2.  **Clone the Repository:**
    ```bash
    git clone https://github.com/kaulvimal/mysql-mcp
    cd mysql-mcp-server
    ```

3.  **Install Dependencies:**
    ```bash
    npm install
    ```
4.  **Build the Project:**
    * Compile the TypeScript code to JavaScript:
        ```bash
        npm run build
        ```
        This will create a `build` directory with the compiled code.

5. **Using the server**

1.  Create a shell script (e.g., `mysql-mcp.sh`) in the project root or a convenient location:

	```bash
    #!/bin/bash
    # Set environment variables (if not using .env or want to override)
    # export DB_HOST=localhost
    # export DB_USER=root
    # export DB_PASSWORD=""
    # export DB_PORT=3306
    node $(dirname "$0")/build/index.js
    ```

2.  Make the script executable:
    ```bash
    chmod +x mysql-mcp.sh
    ```

3. Integration Example (Cursor)

To integrate this server with an Cursor, you can configure the client to run the server's execution script:

```json
{
  "mcpServers": {
    "mysql-mcp": {
      "command": "/path/to/your/mysql-mcp.sh" // Replace with the actual path to your script
    }
  }
}