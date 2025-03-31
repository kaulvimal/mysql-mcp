import time
from typing import Dict, Any, List, Optional, Tuple, Union
import mysql.connector
from mysql.connector import Error as MySQLError

from ..utils.formatting import format_rows_to_dict

class QueryService:
  def execute_query(
      self,
      connection: mysql.connector.connection.MySQLConnection,
      query: str,
      params: Optional[List[Any]] = None,
      fetch_results: bool = True
  ) -> Tuple[bool, Union[List[Dict[str, Any]], int, str], float, Optional[int], Optional[Exception]]:
      """
      Executes a SQL query and returns results

      Returns: (success, result, execution_time, row_count, error)
      """
      cursor = None
      start_time = time.time()

      try:
          cursor = connection.cursor()

          # Execute the query
          if params:
              cursor.execute(query, params)
          else:
              cursor.execute(query)

          # For SELECT queries, fetch results
          if cursor.description and fetch_results:
              rows = cursor.fetchall()
              result = format_rows_to_dict(cursor, rows)
              row_count = len(rows)
          else:
              # For non-SELECT queries like INSERT/UPDATE/DELETE
              if query.strip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')):
                  result = cursor.rowcount
                  row_count = cursor.rowcount
                  # Commit changes for non-SELECT queries
                  connection.commit()
              else:
                  # For other statements like CREATE, DROP, etc.
                  result = "Query executed successfully"
                  row_count = 0
                  connection.commit()

          execution_time = time.time() - start_time
          return True, result, execution_time, row_count, None

      except Exception as e:
          execution_time = time.time() - start_time
          return False, None, execution_time, None, e

      finally:
          if cursor:
              cursor.close()