import mysql.connector
from mysql.connector import Error as MySQLError
import time
import uuid
from typing import Dict, Optional, Any, Tuple

from ..models.request_models import ConnectionConfig

class DatabaseConnectionManager:
  def __init__(self):
      self.connections = {}  # Session ID to connection mapping
      self.session_data = {}  # Session ID to additional session data
      self.session_timeout = 3600

  def connect(self, config: ConnectionConfig, session_id: Optional[str] = None) -> Tuple[bool, Any, Optional[str]]:
      """
      Establishes a connection to MySQL with given configuration
      Returns: (success, connection_or_error, session_id)
      """
      try:
          start_time = time.time()

          connection = mysql.connector.connect(
              host=config.host,
              port=config.port,
              user=config.user,
              password=config.password,
              database=config.database if config.database else None
          )

          # Generate session ID if not provided
          if session_id is None:
              session_id = str(uuid.uuid4())

          # Store connection in connection pool
          self.connections[session_id] = connection
          self.session_data[session_id] = {
              "creation_time": start_time,
              "last_used": start_time,
              "current_db": config.database,
              "query_history": []
          }

          return True, connection, session_id

      except MySQLError as err:
          return False, err, session_id

  def get_connection(self, session_id: str) -> Tuple[bool, Any]:
      """
      Retrieves an existing connection by session ID
      Returns: (success, connection_or_error)
      """
      if session_id in self.connections:
          connection = self.connections.get(session_id)

          # Update last used timestamp
          self.session_data[session_id]["last_used"] = time.time()

          # Check if connection is still alive
          try:
              if connection.is_connected():
                  return True, connection
              else:
                  # Try to reconnect
                  connection.reconnect()
                  return True, connection
          except MySQLError as err:
              return False, err
      else:
          return False, ValueError(f"No active connection found for session ID: {session_id}")

  def close_connection(self, session_id: str) -> Tuple[bool, Optional[Any]]:
      """
      Closes a database connection
      Returns: (success, error_if_any)
      """
      if session_id in self.connections:
          try:
              connection = self.connections.get(session_id)
              if connection.is_connected():
                  connection.close()

              # Clean up session data
              self.connections.pop(session_id, None)
              self.session_data.pop(session_id, None)
              return True, None
          except MySQLError as err:
              return False, err
      return True, None  # No error if session didn't exist

  def add_to_query_history(self, session_id: str, query: str) -> bool:
      """
      Adds query to session history
      """
      if session_id in self.session_data:
          self.session_data[session_id]["query_history"].append({
              "query": query,
              "timestamp": time.time()
          })
          return True
      return False
  def cleanup_expired_sessions(self):
    """
    Closes and removes expired sessions
    """
    current_time = time.time()
    expired_sessions = []

    for session_id, session_info in self.session_data.items():
        if current_time - session_info["last_used"] > self.session_timeout:
            expired_sessions.append(session_id)

    for session_id in expired_sessions:
        self.close_connection(session_id)

    return len(expired_sessions)

  def get_connection(self, session_id: str) -> Tuple[bool, Any]:
    """
    Retrieves an existing connection by session ID
    Returns: (success, connection_or_error)
    """
    # First, clean up any expired sessions
    self.cleanup_expired_sessions()

    if session_id in self.connections:
        connection = self.connections.get(session_id)

        # Update last used timestamp
        self.session_data[session_id]["last_used"] = time.time()

        # Check if connection is still alive
        try:
            if connection.is_connected():
                return True, connection
            else:
                # Try to reconnect
                connection.reconnect()
                return True, connection
        except MySQLError as err:
            return False, err
    else:
        return False, ValueError(f"No active connection found for session ID: {session_id}")