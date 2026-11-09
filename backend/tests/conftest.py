"""测试环境：不连数据库、不连内网，只验证纯逻辑与出站边界。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# 导入 app.config 时才会读取这些值；给一份自签测试密钥，避免落到真实环境变量上
os.environ.setdefault("LABSPACE_SESSION_SECRET", "test-secret-please-do-not-use-in-prod")
os.environ.setdefault("LABSPACE_DB_DSN", "postgresql://test:test@127.0.0.1:5432/test")
