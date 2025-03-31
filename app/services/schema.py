import time
from typing import Dict, Any, List, Optional, Tuple, Union
import mysql.connector
from mysql.connector import Error as MySQLError

class SchemaService:
 def get_schema(
     self,
     connection: mysql.connector.connection.MySQLConnection,
     detail_level: str = "basic",
     include_relationships: bool = True,
     tables: Optional[List[str]] = None
 ) -> Tuple[bool, Dict[str, Any], Optional[Exception]]:
     """
     Retrieves database schema information at varying levels of detail

     Args:
         connection: MySQL connection
         detail_level: "basic", "detailed", or "complete"
         include_relationships: Whether to include foreign key relationships
         tables: Optional list of tables to filter by

     Returns:
         (success, schema_data, error)
     """
     try:
         schema_data = {}
         cursor = connection.cursor(dictionary=True)

         # Get current database
         cursor.execute("SELECT DATABASE() as db_name")
         db_result = cursor.fetchone()
         current_db = db_result["db_name"] if db_result and db_result["db_name"] else None

         if not current_db:
             return False, {}, ValueError("No database selected")

         schema_data["database"] = current_db

         # Get database character set and collation
         cursor.execute("""
             SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
             FROM information_schema.SCHEMATA
             WHERE SCHEMA_NAME = %s
         """, (current_db,))
         db_info = cursor.fetchone()

         if db_info:
             schema_data["character_set"] = db_info["DEFAULT_CHARACTER_SET_NAME"]
             schema_data["collation"] = db_info["DEFAULT_COLLATION_NAME"]

         # Get tables
         table_query = """
             SELECT
                 TABLE_NAME,
                 ENGINE,
                 TABLE_ROWS,
                 AUTO_INCREMENT,
                 CREATE_TIME,
                 UPDATE_TIME,
                 TABLE_COMMENT
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = %s
         """

         params = [current_db]

         if tables:
             table_query += " AND TABLE_NAME IN (%s)" % ','.join(['%s'] * len(tables))
             params.extend(tables)

         cursor.execute(table_query, params)
         tables_data = cursor.fetchall()

         schema_data["tables"] = {}

         # Process each table
         for table in tables_data:
             table_name = table["TABLE_NAME"]
             table_info = {
                 "name": table_name,
                 "engine": table["ENGINE"],
                 "row_count_estimate": table["TABLE_ROWS"],
                 "auto_increment": table["AUTO_INCREMENT"],
                 "created": table["CREATE_TIME"].isoformat() if table["CREATE_TIME"] else None,
                 "updated": table["UPDATE_TIME"].isoformat() if table["UPDATE_TIME"] else None,
                 "comment": table["TABLE_COMMENT"],
                 "columns": []
             }

             # Get columns for this table
             cursor.execute("""
                 SELECT
                     COLUMN_NAME,
                     ORDINAL_POSITION,
                     COLUMN_DEFAULT,
                     IS_NULLABLE,
                     DATA_TYPE,
                     CHARACTER_MAXIMUM_LENGTH,
                     NUMERIC_PRECISION,
                     NUMERIC_SCALE,
                     COLUMN_TYPE,
                     COLUMN_KEY,
                     EXTRA,
                     COLUMN_COMMENT
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                 ORDER BY ORDINAL_POSITION
             """, (current_db, table_name))

             columns = cursor.fetchall()

             for column in columns:
                 column_info = {
                     "name": column["COLUMN_NAME"],
                     "position": column["ORDINAL_POSITION"],
                     "default": column["COLUMN_DEFAULT"],
                     "nullable": column["IS_NULLABLE"] == "YES",
                     "data_type": column["DATA_TYPE"],
                     "column_type": column["COLUMN_TYPE"],
                     "key": column["COLUMN_KEY"],
                     "extra": column["EXTRA"],
                     "comment": column["COLUMN_COMMENT"]
                 }

                 # Add length/precision/scale based on data type
                 if column["CHARACTER_MAXIMUM_LENGTH"]:
                     column_info["max_length"] = column["CHARACTER_MAXIMUM_LENGTH"]
                 elif column["NUMERIC_PRECISION"]:
                     column_info["precision"] = column["NUMERIC_PRECISION"]
                     if column["NUMERIC_SCALE"]:
                         column_info["scale"] = column["NUMERIC_SCALE"]

                 table_info["columns"].append(column_info)

             # If detail level is detailed or complete, add indexes
             if detail_level in ["detailed", "complete"]:
                 cursor.execute("""
                     SELECT
                         INDEX_NAME,
                         NON_UNIQUE,
                         GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns,
                         INDEX_TYPE,
                         COMMENT
                     FROM information_schema.STATISTICS
                     WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                     GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COMMENT
                 """, (current_db, table_name))

                 indexes = cursor.fetchall()
                 table_info["indexes"] = []

                 for index in indexes:
                     index_info = {
                         "name": index["INDEX_NAME"],
                         "unique": not index["NON_UNIQUE"],
                         "columns": index["columns"].split(","),
                         "type": index["INDEX_TYPE"],
                         "comment": index["COMMENT"]
                     }
                     table_info["indexes"].append(index_info)

             # If include_relationships is True, add foreign keys
             if include_relationships:
                 cursor.execute("""
                     SELECT
                         CONSTRAINT_NAME,
                         COLUMN_NAME,
                         REFERENCED_TABLE_NAME,
                         REFERENCED_COLUMN_NAME
                     FROM information_schema.KEY_COLUMN_USAGE
                     WHERE TABLE_SCHEMA = %s
                       AND TABLE_NAME = %s
                       AND REFERENCED_TABLE_NAME IS NOT NULL
                 """, (current_db, table_name))

                 foreign_keys = cursor.fetchall()

                 if foreign_keys:
                     table_info["foreign_keys"] = []

                     # Group by constraint name
                     fk_dict = {}
                     for fk in foreign_keys:
                         constraint_name = fk["CONSTRAINT_NAME"]
                         if constraint_name not in fk_dict:
                             fk_dict[constraint_name] = {
                                 "name": constraint_name,
                                 "columns": [],
                                 "referenced_table": fk["REFERENCED_TABLE_NAME"],
                                 "referenced_columns": []
                             }

                         fk_dict[constraint_name]["columns"].append(fk["COLUMN_NAME"])
                         fk_dict[constraint_name]["referenced_columns"].append(fk["REFERENCED_COLUMN_NAME"])

                     table_info["foreign_keys"] = list(fk_dict.values())

             # If detail level is complete, add triggers and more details
             if detail_level == "complete":
                 # Get triggers
                 cursor.execute("""
                     SELECT
                         TRIGGER_NAME,
                         ACTION_TIMING,
                         EVENT_MANIPULATION,
                         ACTION_STATEMENT
                     FROM information_schema.TRIGGERS
                     WHERE TRIGGER_SCHEMA = %s AND EVENT_OBJECT_TABLE = %s
                 """, (current_db, table_name))

                 triggers = cursor.fetchall()
                 if triggers:
                     table_info["triggers"] = []
                     for trigger in triggers:
                         trigger_info = {
                             "name": trigger["TRIGGER_NAME"],
                             "timing": trigger["ACTION_TIMING"],
                             "event": trigger["EVENT_MANIPULATION"],
                             "statement": trigger["ACTION_STATEMENT"]
                         }
                         table_info["triggers"].append(trigger_info)

                 # Get create table statement
                 cursor.execute(f"SHOW CREATE TABLE `{table_name}`")
                 create_table = cursor.fetchone()
                 if create_table:
                     table_info["create_statement"] = create_table["Create Table"]

             schema_data["tables"][table_name] = table_info

         cursor.close()
         return True, schema_data, None

     except Exception as e:
         if cursor:
             cursor.close()
         return False, {}, e
 def find_relationships(
    self,
    connection: mysql.connector.connection.MySQLConnection,
    tables: Optional[List[str]] = None,
    include_implicit: bool = True
    ) -> Tuple[bool, Dict[str, Any], Optional[Exception]]:
    """
    Discovers explicit and implicit relationships between tables

    Args:
        connection: MySQL connection
        tables: Optional list of tables to filter by
        include_implicit: Whether to include potential implicit relationships

    Returns:
        (success, relationships_data, error)
    """
    try:
        relationships_data = {
            "explicit": [],
            "implicit": []
        }

        cursor = connection.cursor(dictionary=True)

        # Get current database
        cursor.execute("SELECT DATABASE() as db_name")
        db_result = cursor.fetchone()
        current_db = db_result["db_name"] if db_result and db_result["db_name"] else None

        if not current_db:
            return False, {}, ValueError("No database selected")

        # Build table filter condition
        table_filter = ""
        params = [current_db]

        if tables:
            table_filter = " AND (k.TABLE_NAME IN (%s) OR k.REFERENCED_TABLE_NAME IN (%s))" % (
                ','.join(['%s'] * len(tables)),
                ','.join(['%s'] * len(tables))
            )
            params.extend(tables * 2)

        # Get explicit relationships (foreign keys)
        cursor.execute(f"""
            SELECT
                k.CONSTRAINT_NAME,
                k.TABLE_NAME as source_table,
                k.COLUMN_NAME as source_column,
                k.REFERENCED_TABLE_NAME as target_table,
                k.REFERENCED_COLUMN_NAME as target_column,
                rc.UPDATE_RULE,
                rc.DELETE_RULE
            FROM information_schema.KEY_COLUMN_USAGE k
            JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                ON k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
                AND k.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
            WHERE k.TABLE_SCHEMA = %s
            AND k.REFERENCED_TABLE_NAME IS NOT NULL
            {table_filter}
            ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
        """, params)

        explicit_relationships = cursor.fetchall()

        # Group explicit relationships by constraint
        explicit_grouped = {}
        for rel in explicit_relationships:
            constraint_key = f"{rel['source_table']}_{rel['CONSTRAINT_NAME']}"

            if constraint_key not in explicit_grouped:
                explicit_grouped[constraint_key] = {
                    "name": rel["CONSTRAINT_NAME"],
                    "source_table": rel["source_table"],
                    "target_table": rel["target_table"],
                    "columns": [],
                    "update_rule": rel["UPDATE_RULE"],
                    "delete_rule": rel["DELETE_RULE"]
                }

            explicit_grouped[constraint_key]["columns"].append({
                "source_column": rel["source_column"],
                "target_column": rel["target_column"]
            })

        relationships_data["explicit"] = list(explicit_grouped.values())

        # Find implicit relationships if requested
        if include_implicit:
            # Get all tables and their columns
            table_query = """
                SELECT TABLE_NAME
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = %s
                AND TABLE_TYPE = 'BASE TABLE'
            """

            table_params = [current_db]
            if tables:
                table_query += " AND TABLE_NAME IN (%s)" % ','.join(['%s'] * len(tables))
                table_params.extend(tables)

            cursor.execute(table_query, table_params)
            all_tables = [row["TABLE_NAME"] for row in cursor.fetchall()]

            # Get columns for all tables
            columns_data = {}
            for table in all_tables:
                cursor.execute("""
                    SELECT
                        COLUMN_NAME,
                        DATA_TYPE,
                        COLUMN_TYPE,
                        COLUMN_KEY
                    FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                """, (current_db, table))

                columns_data[table] = cursor.fetchall()

            # Find potential implicit relationships based on naming conventions and data types
            for source_table, source_columns in columns_data.items():
                for target_table, target_columns in columns_data.items():
                    # Skip self-relationships for implicit detection
                    if source_table == target_table:
                        continue

                    # Check for columns that might be implicit foreign keys
                    for source_col in source_columns:
                        source_col_name = source_col["COLUMN_NAME"].lower()
                        source_col_type = source_col["DATA_TYPE"]

                        # Skip if column is already part of an explicit foreign key
                        is_explicit_fk = False
                        for rel in explicit_relationships:
                            if (rel["source_table"] == source_table and
                                rel["source_column"] == source_col["COLUMN_NAME"]):
                                is_explicit_fk = True
                                break

                        if is_explicit_fk:
                            continue

                        # Check for common naming patterns
                        potential_matches = []

                        # Pattern 1: column named like 'target_table_id' or 'target_tableid'
                        if source_col_name.endswith('_id') or source_col_name.endswith('id'):
                            base_name = source_col_name[:-3] if source_col_name.endswith('_id') else source_col_name[:-2]
                            if target_table.lower() == base_name or target_table.lower().startswith(base_name):
                                potential_matches.extend([col for col in target_columns
                                                        if col["COLUMN_KEY"] == "PRI" and
                                                        col["DATA_TYPE"] == source_col_type])

                        # Pattern 2: column named exactly like a primary key in another table
                        potential_matches.extend([col for col in target_columns
                                                if col["COLUMN_KEY"] == "PRI" and
                                                col["COLUMN_NAME"] == source_col["COLUMN_NAME"] and
                                                col["DATA_TYPE"] == source_col_type])

                        # If we found potential matches, add them as implicit relationships
                        for match in potential_matches:
                            relationships_data["implicit"].append({
                                "source_table": source_table,
                                "source_column": source_col["COLUMN_NAME"],
                                "target_table": target_table,
                                "target_column": match["COLUMN_NAME"],
                                "confidence": "medium",
                                "reason": f"Column naming and type match: {source_col_type}"
                            })

        cursor.close()
        return True, relationships_data, None

    except Exception as e:
        if 'cursor' in locals() and cursor:
            cursor.close()
        return False, {}, e