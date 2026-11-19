"""天气预测：Open-Meteo 公共 API（无需密钥）。

- 地理编码：https://geocoding-api.open-meteo.com/v1/search
- 预报：https://api.open-meteo.com/v1/forecast
- WMO 天气代码 → 中文描述（见 WMO_TEXT）
"""
from __future__ import annotations

import os
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .http import async_client as http_client
from .security import require_user

router = APIRouter(prefix="/api/weather", tags=["weather"])

GEO_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
DEFAULT_CITY = os.getenv("LABSPACE_WEATHER_CITY", "杨陵")
DEFAULT_LAT = float(os.getenv("LABSPACE_WEATHER_LAT", "34.27173"))
DEFAULT_LON = float(os.getenv("LABSPACE_WEATHER_LON", "108.07891"))
TIMEOUT = float(os.getenv("LABSPACE_WEATHER_TIMEOUT", "15"))

WMO_TEXT: dict[int, str] = {
    0: "晴",
    1: "晴间多云",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "大毛毛雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "米雪",
    80: "阵雨",
    81: "强阵雨",
    82: "暴雨",
    85: "阵雪",
    86: "强阵雪",
    95: "雷阵雨",
    96: "雷阵雨伴冰雹",
    99: "强雷阵雨伴冰雹",
}

_cache: dict[str, Any] = {}


def _describe(code: int | None) -> str:
    if code is None:
        return "未知"
    return WMO_TEXT.get(int(code), f"天气代码 {code}")


async def _geocode(city: str) -> dict[str, Any]:
    async with http_client(timeout=TIMEOUT) as client:
        resp = await client.get(GEO_URL, params={"name": city, "count": 1, "language": "zh", "format": "json"})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"地理编码服务返回 HTTP {resp.status_code}")
    results = resp.json().get("results") or []
    if not results:
        raise HTTPException(status_code=404, detail=f"未找到城市「{city}」")
    first = results[0]
    return {
        "name": first.get("name") or city,
        "admin": first.get("admin1") or "",
        "country": first.get("country") or "",
        "latitude": float(first.get("latitude")),
        "longitude": float(first.get("longitude")),
        "timezone": first.get("timezone") or "Asia/Shanghai",
    }


@router.get("")
@router.get("/")
async def get_weather(
    city: str = Query(default=""),
    days: int = Query(default=7, ge=1, le=16),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    key = f"{city or DEFAULT_CITY}:{days}"
    cached = _cache.get(key)
    if cached and time.time() - cached["at"] < 1800:
        return cached["value"]

    location = await _geocode(city or DEFAULT_CITY)
    params = {
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
        "timezone": location["timezone"],
        "forecast_days": days,
    }
    async with http_client(timeout=TIMEOUT) as client:
        resp = await client.get(FORECAST_URL, params=params)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"天气服务返回 HTTP {resp.status_code}")
    payload = resp.json()
    current = payload.get("current") or {}
    daily = payload.get("daily") or {}
    daily_list: list[dict[str, Any]] = []
    dates = daily.get("time") or []
    codes = daily.get("weather_code") or []
    maxes = daily.get("temperature_2m_max") or []
    mins = daily.get("temperature_2m_min") or []
    probs = daily.get("precipitation_probability_max") or []
    sums = daily.get("precipitation_sum") or []
    for idx, day in enumerate(dates):
        code = codes[idx] if idx < len(codes) else None
        daily_list.append(
            {
                "date": day,
                "code": code,
                "description": _describe(code),
                "max": maxes[idx] if idx < len(maxes) else None,
                "min": mins[idx] if idx < len(mins) else None,
                "precipitation": sums[idx] if idx < len(sums) else None,
                "precipitationProbability": probs[idx] if idx < len(probs) else None,
            }
        )
    value = {
        "city": location["name"],
        "admin": location["admin"],
        "country": location["country"],
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "timezone": location["timezone"],
        "current": {
            "temperature": current.get("temperature_2m"),
            "apparent": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "wind": current.get("wind_speed_10m"),
            "code": current.get("weather_code"),
            "description": _describe(current.get("weather_code")),
        },
        "daily": daily_list,
        "updated_at": time.strftime("%Y-%m-%d %H:%M"),
        "source": "Open-Meteo",
    }
    _cache[key] = {"at": time.time(), "value": value}
    return value
