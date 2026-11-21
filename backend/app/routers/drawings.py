"""drawings 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter

from ..config import settings
from ..routers.deps import (
    safe_component as _safe_component,
)

router = APIRouter()


def _user_dir(user: dict[str, Any]) -> str:
    """用户在实验室文件空间中的个人目录（/srv/lab/users/<name>）。"""
    candidates = [
        user.get("preferred_username"),
        user.get("name"),
        (user.get("email") or "").split("@")[0],
        user.get("id"),
    ]
    for c in candidates:
        if c:
            comp = _safe_component(str(c))
            path = os.path.join(settings.users_root, comp)
            if os.path.isdir(path):
                return path
    comp = _safe_component(str(user.get("email", "")).split("@")[0] or str(user.get("id")))
    return os.path.join(settings.users_root, comp)
