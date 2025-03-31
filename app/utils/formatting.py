from typing import Dict, Any, List, Optional, Union

def format_response(
  success: bool,
  data: Optional[Any] = None,
  execution_time: Optional[float] = None,
  row_count: Optional[int] = None,
  error: Optional[Dict[str, str]] = None,
  additional_metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
  """
  Creates a standardized response format
  """
  metadata = {}

  if execution_time is not None:
      metadata["execution_time"] = execution_time

  if row_count is not None:
      metadata["row_count"] = row_count

  if additional_metadata:
      metadata.update(additional_metadata)

  response = {
      "success": success,
  }

  if data is not None:
      response["data"] = data

  if metadata:
      response["metadata"] = metadata

  if error:
      response["error"] = error

  return response

def format_rows_to_dict(cursor, rows) -> List[Dict[str, Any]]:
  """
  Converts database rows to list of dictionaries using column names
  """
  field_names = [i[0] for i in cursor.description]
  result = []

  for row in rows:
      row_dict = {}
      for i, field_name in enumerate(field_names):
          # Handle various data types, especially dates and binary data
          if isinstance(row[i], bytes):
              row_dict[field_name] = row[i].hex()
          else:
              row_dict[field_name] = row[i]
      result.append(row_dict)

  return result