from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import time
from typing import Dict, Any

from .models.request_models import MCPRequest
from .services.connection import DatabaseConnectionManager
from .services.query import QueryService
from .utils.error_handling import format_error_response
from .utils.formatting import format_response
from .services.schema import SchemaService
from .services.transaction import TransactionService

app = FastAPI(
  title="MySQL MCP Server",
  description="Model Context Protocol server for MySQL databases",
  version="0.1.0"
)

# Add CORS middleware
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],  # In production, restrict this
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)

# Initialize services
db_connection_manager = DatabaseConnectionManager()
query_service = QueryService()
schema_service = SchemaService()
transaction_service = TransactionService()

@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
  start_time = time.time()
  response = await call_next(request)
  process_time = time.time() - start_time
  response.headers["X-Process-Time"] = str(process_time)
  return response

@app.post("/api/mcp")
async def process_mcp_request(request: MCPRequest):
  """
  Main endpoint for handling all MCP requests
  """
  action = request.action.lower()

  # Handle test_connection action
  if action == "test_connection":
      return handle_test_connection(request)

  # Handle execute_query action
  elif action == "execute_query":
      return handle_execute_query(request)

  # Handle get_schema action
  elif action == "get_schema":
      return handle_get_schema(request)

  # Handle find_relationships action
  elif action == "find_relationships":
      return handle_find_relationships(request)

  # Handle transaction action
  elif action == "transaction":
      return handle_transaction(request)

  # Handle get_transaction_status action
  elif action == "get_transaction_status":
      return handle_get_transaction_status(request)

  # Add more handlers for other actions as we implement them
  else:
      error_details = {
          "code": "UNSUPPORTED_ACTION",
          "message": f"The action '{request.action}' is not supported.",
          "details": "Please check the documentation for supported actions."
      }
      return format_response(success=False, error=error_details)

def handle_test_connection(request: MCPRequest):
	"""
	Handles the test_connection action to verify database connectivity
	"""
	start_time = time.time()

	# Attempt to connect to the database
	# If a session_id is provided, try to reuse that connection
	if request.session_id:
		success, conn_or_error = db_connection_manager.get_connection(request.session_id)
		session_id = request.session_id

		# If the session is invalid, create a new connection
		if not success:
			success, conn_or_error, session_id = db_connection_manager.connect(request.connection)
	else:
		# Create a new connection and session
		success, conn_or_error, session_id = db_connection_manager.connect(request.connection)

	if success:
		# Connection successful, get server info
		try:
			cursor = conn_or_error.cursor()
			cursor.execute("SELECT @@version, @@version_comment, DATABASE()")
			version, version_comment, current_db = cursor.fetchone()
			cursor.close()

			# IMPORTANT: We're keeping the connection open in all cases now
			# No longer closing the connection even if no session_id was provided

			data = {
				"connected": True,
				"server_version": version,
				"server_info": version_comment,
				"current_database": current_db,
				"session_id": session_id
			}

			execution_time = time.time() - start_time
			return format_response(
				success=True,
				data=data,
				execution_time=execution_time
			)
		except Exception as e:
			# Close the connection on error
			db_connection_manager.close_connection(session_id)

			error_details = format_error_response(e)
			execution_time = time.time() - start_time
			return format_response(
				success=False,
				error=error_details,
				execution_time=execution_time
			)
	else:
		# Connection failed
		error_details = format_error_response(conn_or_error)
		execution_time = time.time() - start_time
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

def handle_execute_query(request: MCPRequest):
	"""
	Handles the execute_query action
	"""
	start_time = time.time()

	# Get query parameters
	query = request.parameters.get("query")
	params = request.parameters.get("params")
	include_performance_metrics = request.parameters.get("include_performance_metrics", False)

	if not query:
		error_details = {
			"code": "INVALID_PARAMETERS",
			"message": "Missing required parameter: query",
			"details": "The execute_query action requires a query parameter"
		}
		return format_response(success=False, error=error_details)

	# Get connection (either new or from session)
	if request.session_id:
		success, conn_or_error = db_connection_manager.get_connection(request.session_id)
		session_id = request.session_id
	else:
		success, conn_or_error, session_id = db_connection_manager.connect(request.connection)

	if not success:
		error_details = format_error_response(conn_or_error)
		execution_time = time.time() - start_time
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

	# Execute the query
	query_success, result, query_time, row_count, error = query_service.execute_query(
		conn_or_error,
		query,
		params
	)

	# Add query to history
	if request.session_id:
		db_connection_manager.add_to_query_history(request.session_id, query)

	# Close the connection ONLY if no session ID was provided
	if not request.session_id:
		db_connection_manager.close_connection(session_id)

	# Format response
	execution_time = time.time() - start_time

	if query_success:
		additional_metadata = {}
		if include_performance_metrics:
			additional_metadata["query_execution_time"] = query_time

		return format_response(
			success=True,
			data=result,
			execution_time=execution_time,
			row_count=row_count,
			additional_metadata=additional_metadata
		)
	else:
		error_details = format_error_response(error)
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

def handle_get_schema(request: MCPRequest):
	"""
	Handles the get_schema action to retrieve database schema information
	"""
	start_time = time.time()

	# Get parameters
	detail_level = request.parameters.get("detail_level", "basic")
	include_relationships = request.parameters.get("include_relationships", True)
	tables = request.parameters.get("tables")

	# Validate detail_level
	if detail_level not in ["basic", "detailed", "complete"]:
		error_details = {
			"code": "INVALID_PARAMETERS",
			"message": "Invalid detail_level parameter",
			"details": "detail_level must be one of: basic, detailed, complete"
		}
		return format_response(success=False, error=error_details)

	# Get connection (either new or from session)
	if request.session_id:
		success, conn_or_error = db_connection_manager.get_connection(request.session_id)
		session_id = request.session_id
	else:
		success, conn_or_error, session_id = db_connection_manager.connect(request.connection)

	if not success:
		error_details = format_error_response(conn_or_error)
		execution_time = time.time() - start_time
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

	# Get schema information
	schema_success, schema_data, error = schema_service.get_schema(
		conn_or_error,
		detail_level,
		include_relationships,
		tables
	)

	# Close the connection ONLY if no session ID was provided
	if not request.session_id:
		db_connection_manager.close_connection(session_id)

	# Format response
	execution_time = time.time() - start_time

	if schema_success:
		return format_response(
			success=True,
			data=schema_data,
			execution_time=execution_time
		)
	else:
		error_details = format_error_response(error)
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

def handle_find_relationships(request: MCPRequest):
	"""
	Handles the find_relationships action to discover relationships between tables
	"""
	start_time = time.time()

	# Get parameters
	tables = request.parameters.get("tables")
	include_implicit = request.parameters.get("include_implicit", True)

	# Get connection (either new or from session)
	if request.session_id:
		success, conn_or_error = db_connection_manager.get_connection(request.session_id)
		session_id = request.session_id
	else:
		success, conn_or_error, session_id = db_connection_manager.connect(request.connection)

	if not success:
		error_details = format_error_response(conn_or_error)
		execution_time = time.time() - start_time
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

	# Find relationships
	rel_success, relationships_data, error = schema_service.find_relationships(
		conn_or_error,
		tables,
		include_implicit
	)

	# Close the connection ONLY if no session ID was provided
	if not request.session_id:
		db_connection_manager.close_connection(session_id)

	# Format response
	execution_time = time.time() - start_time

	if rel_success:
		return format_response(
			success=True,
			data=relationships_data,
			execution_time=execution_time
		)
	else:
		error_details = format_error_response(error)
		return format_response(
			success=False,
			error=error_details,
			execution_time=execution_time
		)

def handle_transaction(request: MCPRequest):
  """
  Handles the transaction action to manage database transactions
  """
  start_time = time.time()

  # Get parameters
  operation = request.parameters.get("operation")
  isolation_level = request.parameters.get("isolation_level")

  if not operation:
      error_details = {
          "code": "INVALID_PARAMETERS",
          "message": "Missing required parameter: operation",
          "details": "The transaction action requires an operation parameter (begin, commit, or rollback)"
      }
      return format_response(success=False, error=error_details)

  # Transaction management requires a session
  if not request.session_id:
      error_details = {
          "code": "SESSION_REQUIRED",
          "message": "Transaction management requires a session",
          "details": "Please provide a session_id or first call test_connection to establish a session"
      }
      return format_response(success=False, error=error_details)

  # Get connection from session
  success, conn_or_error = db_connection_manager.get_connection(request.session_id)

  if not success:
      error_details = format_error_response(conn_or_error)
      execution_time = time.time() - start_time
      return format_response(
          success=False,
          error=error_details,
          execution_time=execution_time
      )

  # Manage transaction
  tx_success, result_data, error = transaction_service.manage_transaction(
      conn_or_error,
      operation,
      isolation_level
  )

  # Format response
  execution_time = time.time() - start_time

  if tx_success:
      return format_response(
          success=True,
          data=result_data,
          execution_time=execution_time
      )
  else:
      error_details = format_error_response(error)
      return format_response(
          success=False,
          error=error_details,
          execution_time=execution_time
      )

def handle_get_transaction_status(request: MCPRequest):
  """
  Handles the get_transaction_status action
  """
  start_time = time.time()

  # Transaction status requires a session
  if not request.session_id:
      error_details = {
          "code": "SESSION_REQUIRED",
          "message": "Transaction status check requires a session",
          "details": "Please provide a session_id or first call test_connection to establish a session"
      }
      return format_response(success=False, error=error_details)

  # Get connection from session
  success, conn_or_error = db_connection_manager.get_connection(request.session_id)

  if not success:
      error_details = format_error_response(conn_or_error)
      execution_time = time.time() - start_time
      return format_response(
          success=False,
          error=error_details,
          execution_time=execution_time
      )

  # Get transaction status
  status_success, status_data, error = transaction_service.get_transaction_status(conn_or_error)

  # Format response
  execution_time = time.time() - start_time

  if status_success:
      return format_response(
          success=True,
          data=status_data,
          execution_time=execution_time
      )
  else:
      error_details = format_error_response(error)
      return format_response(
          success=False,
          error=error_details,
          execution_time=execution_time
      )