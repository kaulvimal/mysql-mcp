import time
from typing import Dict, Any, List, Optional, Tuple, Union
import mysql.connector
from mysql.connector import Error as MySQLError

class TransactionService:
  def manage_transaction(
      self,
      connection: mysql.connector.connection.MySQLConnection,
      operation: str,
      isolation_level: Optional[str] = None
  ) -> Tuple[bool, Dict[str, Any], Optional[Exception]]:
      """
      Manages database transactions (begin, commit, rollback)

      Args:
          connection: MySQL connection
          operation: "begin", "commit", or "rollback"
          isolation_level: Optional isolation level for "begin" operation

      Returns:
          (success, result_data, error)
      """
      cursor = None
      try:
          cursor = connection.cursor()
          result_data = {"operation": operation}

          if operation.lower() == "begin":
              # Set isolation level if specified
              if isolation_level:
                  valid_isolation_levels = [
                      "READ UNCOMMITTED",
                      "READ COMMITTED",
                      "REPEATABLE READ",
                      "SERIALIZABLE"
                  ]

                  if isolation_level.upper() not in valid_isolation_levels:
                      return False, {}, ValueError(
                          f"Invalid isolation level. Must be one of: {', '.join(valid_isolation_levels)}"
                      )

                  cursor.execute(f"SET TRANSACTION ISOLATION LEVEL {isolation_level}")
                  result_data["isolation_level"] = isolation_level

              # Start transaction
              connection.start_transaction()
              result_data["status"] = "Transaction started"

          elif operation.lower() == "commit":
              connection.commit()
              result_data["status"] = "Transaction committed"

          elif operation.lower() == "rollback":
              connection.rollback()
              result_data["status"] = "Transaction rolled back"

          else:
              return False, {}, ValueError(
                  "Invalid operation. Must be one of: begin, commit, rollback"
              )

          cursor.close()
          return True, result_data, None

      except Exception as e:
          if cursor:
              cursor.close()
          return False, {}, e

  def get_transaction_status(
      self,
      connection: mysql.connector.connection.MySQLConnection
  ) -> Tuple[bool, Dict[str, Any], Optional[Exception]]:
      """
      Checks the current transaction state

      Args:
          connection: MySQL connection

      Returns:
          (success, status_data, error)
      """
      cursor = None
      try:
          cursor = connection.cursor(dictionary=True)

          # Check if autocommit is enabled
          cursor.execute("SELECT @@autocommit as autocommit")
          autocommit_result = cursor.fetchone()
          autocommit = bool(autocommit_result["autocommit"])

          # Get current transaction isolation level
          cursor.execute("SELECT @@transaction_isolation as isolation_level")
          isolation_result = cursor.fetchone()
          isolation_level = isolation_result["isolation_level"]

          # Check if in transaction by examining connection properties
          in_transaction = False

          # MySQL Connector Python has an 'in_transaction' property in newer versions
          if hasattr(connection, 'in_transaction'):
              in_transaction = connection.in_transaction
          else:
              # For older versions, check if autocommit is off
              if not autocommit:
                  # If autocommit is off, we might be in a transaction
                  # Try a simple query to see if we're in a transaction
                  try:
                      # Create a simple temporary table
                      temp_table_name = f"mcp_tx_check_{int(time.time())}"
                      cursor.execute(f"CREATE TEMPORARY TABLE {temp_table_name} (id INT)")
                      cursor.execute(f"DROP TEMPORARY TABLE {temp_table_name}")
                      # If we got here without error and autocommit is off, we're in a transaction
                      in_transaction = True
                  except:
                      # If there was an error, we might still be in a transaction
                      in_transaction = not autocommit

          status_data = {
              "in_transaction": in_transaction,
              "autocommit": autocommit,
              "isolation_level": isolation_level
          }

          cursor.close()
          return True, status_data, None

      except Exception as e:
          if cursor:
              cursor.close()
          return False, {}, e