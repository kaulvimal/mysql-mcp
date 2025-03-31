from pydantic import BaseModel
from typing import Optional, Dict, Any, List, Union

class ErrorDetail(BaseModel):
  code: str
  message: str
  details: Optional[str] = None

class ResponseMetadata(BaseModel):
  execution_time: float
  row_count: Optional[int] = None

class MCPResponse(BaseModel):
  success: bool
  data: Optional[Any] = None
  metadata: Optional[ResponseMetadata] = None
  error: Optional[ErrorDetail] = None