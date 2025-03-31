from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List, Union

class ConnectionConfig(BaseModel):
  host: str
  port: int = 3306
  user: str
  password: str
  database: Optional[str] = None

class MCPRequest(BaseModel):
  connection: ConnectionConfig
  action: str
  parameters: Dict[str, Any] = {}
  session_id: Optional[str] = None
