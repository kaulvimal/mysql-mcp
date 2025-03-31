from typing import Dict, Any, Tuple
from mysql.connector import Error as MySQLError

def handle_mysql_error(error: MySQLError) -> Tuple[str, str, str]:
  """
  Transforms a MySQL error into a more user-friendly error format
  Returns: (error_code, error_message, error_details)
  """
  error_code = f"MYSQL-{error.errno}" if hasattr(error, 'errno') else "MYSQL-ERROR"
  error_message = str(error)
  error_details = None

  # Handle specific error cases to provide better error messages
  if hasattr(error, 'errno'):
      if error.errno == 1045:
          error_message = "Access denied. Please check your username and password."
      elif error.errno == 1049:
          error_message = "Database does not exist."
      elif error.errno == 1044:
          error_message = "Access denied for the specified database."
      elif error.errno == 2003:
          error_message = "Could not connect to MySQL server. Please verify host and port."

  return error_code, error_message, error_details

def format_error_response(error: Exception) -> Dict[str, Any]:
  """
  Formats an exception into a standardized error response
  """
  if isinstance(error, MySQLError):
      code, message, details = handle_mysql_error(error)
      return {
          "code": code,
          "message": message,
          "details": details
      }
  else:
      return {
          "code": "INTERNAL-ERROR",
          "message": str(error),
          "details": type(error).__name__
      }