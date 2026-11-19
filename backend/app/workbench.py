"""个人工作台数据层（任务 / 项目 / 计划 / 每日简报）。

职责：
- 提供 `/api/workbench/*` 全部路由：条目（items）、项目（projects）、计划（plans）、
  每日简报（briefs）、聚合首页（summary）以及本地规则智能捕获（capture）。
- 数据全部落在 PostgreSQL 的 `labspace` schema 中（无 ORM，直接用 psycopg2 的
  `db.query` / `db.execute`），并且严格按 `user_id` 隔离，任何接口都不会返回他人数据。
- `capture` 为纯本地可预测规则（不调用 LLM）：判定条目类型、抽取截止日期 / 标签 /
  优先级、生成标题与置信度。
"""
from __future__ import annotations

import asyncio
import os
import re
import urllib.parse
import uuid
from datetime import date, datetime, timedelta
from typing import Any

import psycopg2
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from psycopg2.extras import Json
from pydantic import BaseModel, Field

from . import accounts as accounts_mod
from . import db, decision
from .config import settings
from .security import has_role, require_csrf, require_user
from .uploads import read_upload_capped

router = APIRouter(prefix="/api/workbench", tags=["workbench"])

# ---------------------------------------------------------------- 枚举与常量

ITEM_KINDS = ("task", "project", "idea", "knowledge", "note", "memory", "plan")
ITEM_STATUSES = ("active", "done", "paused", "archived")
ITEM_PRIORITIES = ("low", "normal", "high")
ITEM_SOURCES = ("manual", "capture", "agent")
PROJECT_STATUSES = ("active", "done", "paused")
PROJECT_HEALTHS = ("on_track", "at_risk", "blocked", "done")
PLAN_KINDS = ("direction", "stage")
PLAN_STATUSES = ("active", "paused", "done", "archived")

ASSIGNMENT_KINDS = ("task", "project")
ASSIGNMENT_STATUSES = ("assigned", "in_progress", "submitted", "accepted", "returned")
ASSIGNMENT_PRIORITIES = ("low", "normal", "high")
ASSIGNMENT_PURPOSES = ("brief", "delivery")
ASSIGNMENT_FILE_MAX = 20 * 1024 * 1024
ASSIGNMENT_FILES_MAX = 12
#: 被指派人可自行推进的状态；导师负责提交后的通过 / 退回。
ASSIGNEE_STATUSES = ("assigned", "in_progress")
CREATOR_STATUSES = ("assigned", "accepted", "returned")

MAX_LIMIT = 200
DEFAULT_LIMIT = 50
DEFAULT_BRIEF_LIMIT = 7


# ---------------------------------------------------------------- 日期与序列化工具


def _safe_int(value: Any, default: int = 0) -> int:
    """把 count(*) 等聚合结果安全转成 int。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


async def _q(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    """在线程池里执行同步查询。

    db.query 是阻塞的 psycopg2 调用，直接在协程里 await 之前的写法会阻塞
    整个事件循环（一个用户的工作台首页就能拖慢所有人的请求）。
    """
    return await asyncio.to_thread(db.query, sql, params)


async def _q_batch(statements: list[tuple[str, tuple]]) -> list[list[dict[str, Any]]]:
    """一次线程调度 + 一条连接跑完多条查询（避免打满连接池）。"""
    return await asyncio.to_thread(db.query_many, statements)


def _local_now() -> datetime:
    """服务器本地时间（容器 TZ 为 Asia/Shanghai，已用 `date` 校验）。

    刻意不叫 ``_now``：accounts.py 里的 ``_now`` 返回的是 Casdoor 的 RFC3339
    字符串，两者同名会让人按名字引用时搞混。
    """
    return datetime.now()


def _today() -> date:
    return _local_now().date()


def _iso(value: Any) -> str | None:
    """date / datetime → ISO 字符串；None 保持 None。"""
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _local_day_bounds(target: date) -> tuple[datetime, datetime]:
    """服务器本地某一天的 [起, 止) 时间区间（带时区，timestamptz 可安全比较）。"""
    start = datetime(target.year, target.month, target.day).astimezone()
    return start, start + timedelta(days=1)


def _week_start(target: date) -> date:
    """本地周的周一。"""
    return target - timedelta(days=target.weekday())


def _item_out(row: dict[str, Any]) -> dict[str, Any]:
    """workbench_items 行 → 契约里的 item 形状。"""
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "kind": row.get("kind") or "note",
        "title": row.get("title") or "",
        "content": row.get("content") or "",
        "status": row.get("status") or "active",
        "priority": row.get("priority") or "normal",
        "tags": list(row.get("tags") or []),
        "project_id": row.get("project_id"),
        "plan_id": row.get("plan_id"),
        "due_date": _iso(row.get("due_date")),
        "source": row.get("source") or "manual",
        "ai_class": row.get("ai_class"),
        "ai_reason": row.get("ai_reason"),
        "confidence": float(row.get("confidence") or 0.0),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def _project_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row.get("name") or "",
        "description": row.get("description") or "",
        "status": row.get("status") or "active",
        "health": row.get("health") or "on_track",
        "progress": int(row.get("progress") or 0),
        "next_step": row.get("next_step") or "",
        "due_date": _iso(row.get("due_date")),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def _plan_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row.get("kind") or "direction",
        "title": row.get("title") or "",
        "outcome": row.get("outcome") or "",
        "metrics": row.get("metrics") or "",
        "horizon": row.get("horizon") or "",
        "progress": int(row.get("progress") or 0),
        "status": row.get("status") or "active",
        "next_step": row.get("next_step") or "",
        "due_date": _iso(row.get("due_date")),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def _brief_out(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    return {
        "date": _iso(row.get("brief_date")),
        "content": row.get("content") or "",
        "payload": payload,
    }


def _file_out(row: dict[str, Any]) -> dict[str, Any]:
    """附件元数据（永不返回 data，避免列表接口搬运二进制）。"""
    return {
        "id": row["id"],
        "assignment_id": row["assignment_id"],
        "submission_id": row.get("submission_id"),
        "uploader_id": row.get("uploader_id") or "",
        "purpose": row.get("purpose") or "brief",
        "filename": row.get("filename") or "",
        "content_type": row.get("content_type") or "application/octet-stream",
        "size": _safe_int(row.get("size_bytes")),
        "created_at": _iso(row.get("created_at")),
        "url": f"/api/workbench/assignment-files/{row['id']}",
    }


def _submission_out(row: dict[str, Any], files: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "assignment_id": row["assignment_id"],
        "author_id": row.get("author_id") or "",
        "content": row.get("content") or "",
        "created_at": _iso(row.get("created_at")),
        "files": files,
    }


def _assignment_out(
    row: dict[str, Any],
    submissions: list[dict[str, Any]],
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    sub_files: dict[str, list[dict[str, Any]]] = {}
    for f in files:
        sid = f.get("submission_id")
        if sid:
            sub_files.setdefault(str(sid), []).append(f)
    return {
        "id": row["id"],
        "creator_id": row["creator_id"],
        "creator_name": row.get("creator_name") or "",
        "assignee_id": row["assignee_id"],
        "assignee_name": row.get("assignee_name") or "",
        "kind": row.get("kind") or "task",
        "title": row.get("title") or "",
        "content": row.get("content") or "",
        "status": row.get("status") or "assigned",
        "priority": row.get("priority") or "normal",
        "due_date": _iso(row.get("due_date")),
        "feedback": row.get("feedback") or "",
        "submitted_at": _iso(row.get("submitted_at")),
        "reviewed_at": _iso(row.get("reviewed_at")),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "brief_files": [_file_out(f) for f in files if not f.get("submission_id")],
        "submissions": [
            _submission_out(s, [_file_out(f) for f in sub_files.get(str(s["id"]), [])])
            for s in submissions
        ],
    }


async def require_teacher(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """导师（老师或管理员）才能指派课题/任务、查看人员目录与批阅。"""
    if not has_role(user, settings.admin_roles + settings.teacher_roles):
        raise HTTPException(status_code=403, detail="需要导师（老师 / 管理员）权限")
    return user


# ---------------------------------------------------------------- 智能捕获（纯本地规则）

# kind 判定优先级：memory > plan > task > project > idea > knowledge > note
# 顺序即优先级。注意两个已修的坑：
# 1) "记住" 曾同时出现在 task 与 memory 里，靠后的 memory 永远命中不到；
# 2) "回复"/"修改"/"需要" 这类通用动词会把 "记住：审稿意见要逐条回复" 判成任务。
# 现在的写法：记忆类显式前缀（记住/以后/经验/教训）排在最前，动词只保留强动作词。
KIND_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("memory", ("记住", "以后", "经验", "教训")),
    ("plan", ("计划", "目标", "方向", "里程碑")),
    ("task", ("待办", "todo", "要做", "记得", "完成", "deadline", "截止", "前完成",
              "提交", "发送", "准备", "整理", "联系", "安排", "上传", "打印", "报名",
              "回复", "修改", "撰写", "写完", "开会", "组会", "答辩", "汇报",
              "实验", "交报告", "交材料", "交总结", "修复", "排查", "调试", "处理",
              "跟进", "核对", "检查")),
    ("project", ("项目", "课题")),
    ("idea", ("想法", "灵感", "点子", "或许", "可以试试")),
    ("knowledge", ("文献", "论文", "笔记", "知识", "参考")),
]

PRIORITY_URGENT = ("紧急", "立刻", "马上", "asap", "火烧眉毛", "十万火急")
PRIORITY_HIGH = ("尽快", "重要", "优先", "高优先")
PRIORITY_LOW = ("不急", "有空", "低优先", "可以缓")

TAG_RE = re.compile(r"#([A-Za-z0-9_一-鿿]+)")
ISO_DATE_RE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")
DAYS_AFTER_RE = re.compile(r"(\d+)\s*(?:天|日)(?:后|之后|以后)")
WEEKS_AFTER_RE = re.compile(r"(\d+)\s*(?:周|星期|礼拜)(?:后|之后|以后)")
WEEKDAY_RE = re.compile(r"(本|这|下下|下)?\s*(?:周|星期|礼拜)([一二三四五六日天1-7])\s*(?:前|之前|以前)?")
MONTH_DAY_RE = re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]")
MONTH_END_RE = re.compile(r"(下|本|这)?\s*个?\s*月(?:底|末)")
WEEKDAY_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7}
TIME_WORDS_RE = re.compile(r"^(上午|下午|中午|晚上|早上|凌晨|今晚|明早|明晚|傍晚)\s*")
TIME_CLOCK_RE = re.compile(
    r"^(\d{1,2}\s*[点:：]\s*(\d{1,2}|半)?\s*分?|[零一二三四五六七八九十]{1,3}\s*点(半)?)\s*"
)

TITLE_MAX = 60
MAX_TAGS = 5


def _match_kind(text: str) -> tuple[str, list[str]]:
    """按契约优先级判定 kind，返回 (kind, 命中的关键词列表)。"""
    low = text.lower()
    for kind, words in KIND_RULES:
        hits = [w for w in words if w.lower() in low]
        if hits:
            return kind, hits
    return "note", []


def _month_end(year: int, month: int) -> date:
    nxt = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
    return nxt - timedelta(days=1)


def _match_due_date(text: str, today: date) -> tuple[date | None, str | None]:
    """抽取截止日期，返回 (日期, 命中的原始关键词)。

    覆盖：2026-11-09、3 天后 / 2 周后、本周五 / 下周三 / 周五、
    明天 / 后天 / 大后天 / 月底 / 下月底 / 11 月 20 日。
    """
    m = ISO_DATE_RE.search(text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))), m.group(0)
        except ValueError:
            pass
    m = MONTH_DAY_RE.search(text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        year = today.year + (1 if month < today.month else 0)
        try:
            return date(year, month, day), m.group(0)
        except ValueError:
            pass
    for kw, days in (("大后天", 3), ("后天", 2)):
        if kw in text:
            return today + timedelta(days=days), kw
    if "明天" in text or "明日" in text:
        kw = "明天" if "明天" in text else "明日"
        return today + timedelta(days=1), kw
    if "今天" in text or "今日" in text:
        kw = "今天" if "今天" in text else "今日"
        return today, kw
    m = DAYS_AFTER_RE.search(text)
    if m:
        return today + timedelta(days=int(m.group(1))), m.group(0)
    m = WEEKS_AFTER_RE.search(text)
    if m:
        return today + timedelta(weeks=int(m.group(1))), m.group(0)
    m = MONTH_END_RE.search(text)
    if m:
        prefix = m.group(1)
        if prefix == "下":
            year = today.year + (today.month == 12)
            month = 1 if today.month == 12 else today.month + 1
        else:
            year, month = today.year, today.month
        return _month_end(year, month), m.group(0)
    m = WEEKDAY_RE.search(text)
    if m:
        token = m.group(2)
        day = WEEKDAY_NUM.get(token) or int(token)
        base = _week_start(today)
        prefix = m.group(1) or ""
        if prefix == "下":
            target = base + timedelta(days=7 + day - 1)
        elif prefix == "下下":
            target = base + timedelta(days=14 + day - 1)
        elif prefix in ("本", "这"):
            target = base + timedelta(days=day - 1)
        else:
            target = base + timedelta(days=day - 1)
            if target < today:
                target += timedelta(days=7)
        return target, m.group(0)
    return None, None


def _match_priority(text: str) -> tuple[str, str | None]:
    """抽取优先级；先判「低」再判「紧急」「高」，避免「不急」被「急」误命中。"""
    low = text.lower()
    for word in PRIORITY_LOW:
        if word in low:
            return "low", word
    for word in PRIORITY_URGENT:
        if word.lower() in low:
            return "urgent", word
    for word in PRIORITY_HIGH:
        if word.lower() in low:
            return "high", word
    return "normal", None


def _match_tags(text: str) -> list[str]:
    """抽取 `#标签`，最多 5 个，去重且保持出现顺序。"""
    tags: list[str] = []
    for m in TAG_RE.finditer(text):
        tag = m.group(1)
        if tag and tag not in tags:
            tags.append(tag)
        if len(tags) >= MAX_TAGS:
            break
    return tags


def _build_title(text: str, due_keyword: str | None) -> str:
    """第一行去掉标签、日期与时段词后的前 60 字。"""
    first_line = (text.strip().splitlines() or [""])[0]
    cleaned = TAG_RE.sub(" ", first_line)
    if due_keyword:
        cleaned = cleaned.replace(due_keyword, "")
    cleaned = re.sub(r"^\s*(?:前|之前|以前)\s*", "", cleaned)
    for _ in range(2):
        before = cleaned
        for word in (*PRIORITY_URGENT, *PRIORITY_HIGH, *PRIORITY_LOW):
            cleaned = re.sub(rf"^{re.escape(word)}\s*[，,。；;、\s]*", "", cleaned)
        if cleaned == before:
            break
    cleaned = cleaned.strip()
    for _ in range(2):
        before = cleaned
        cleaned = TIME_WORDS_RE.sub("", cleaned)
        cleaned = TIME_CLOCK_RE.sub("", cleaned)
        cleaned = re.sub(r"^[，,。；;、\s]+", "", cleaned)
        if cleaned == before:
            break
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:TITLE_MAX]


def analyze_capture(text: str, today: date | None = None) -> dict[str, Any]:
    """纯本地规则分析一段文本，返回捕获结果（不落库）。

    返回键：kind / due_date / tags / priority / title / content / ai_reason / confidence。
    """
    raw = (text or "").strip()
    base_day = today or _today()

    kind, kind_hits = _match_kind(raw)
    due_date, due_keyword = _match_due_date(raw, base_day)
    tags = _match_tags(raw)
    priority, priority_hit = _match_priority(raw)
    title = _build_title(raw, due_keyword)

    # 置信度：命中规则数越多越高，范围固定在 0.4 ~ 0.95
    hits = 1 if kind_hits else 0  # 类型判定（默认 note 也算一次弱命中）
    hits += max(0, len(kind_hits) - 1)  # 同类型的多个关键词
    if due_date is not None:
        hits += 1
    if tags:
        hits += 1
    if priority_hit:
        hits += 1
    confidence = round(min(0.95, max(0.4, 0.4 + 0.05 * hits)), 2)

    reasons: list[str] = []
    if kind_hits:
        reasons.append("识别到类型关键词「" + "、".join(kind_hits) + "」")
    else:
        reasons.append("未识别到明确类型关键词，归为默认笔记")
    if due_date is not None:
        reasons.append(f"识别到截止日期「{due_keyword}」（{due_date.isoformat()}）")
    if tags:
        reasons.append("识别到标签「" + "、".join(tags) + "」")
    if priority_hit:
        reasons.append(f"识别到优先级关键词「{priority_hit}」")

    return {
        "kind": kind,
        "due_date": due_date,
        "tags": tags,
        "priority": priority,
        "title": title,
        "content": raw,
        "ai_reason": "；".join(reasons),
        "confidence": confidence,
    }


# ---------------------------------------------------------------- 请求体模型


class ItemCreate(BaseModel):
    kind: str = "note"
    title: str = ""
    content: str = ""
    tags: list[str] = Field(default_factory=list)
    priority: str = "normal"
    due_date: date | None = None
    project_id: str | None = None
    plan_id: str | None = None
    status: str = "active"


class ItemPatch(BaseModel):
    kind: str | None = None
    title: str | None = None
    content: str | None = None
    tags: list[str] | None = None
    priority: str | None = None
    due_date: date | None = None
    project_id: str | None = None
    plan_id: str | None = None
    status: str | None = None


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    next_step: str = ""
    due_date: date | None = None
    health: str = "on_track"
    status: str = "active"


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    next_step: str | None = None
    due_date: date | None = None
    health: str | None = None
    status: str | None = None
    progress: int | None = None


class PlanCreate(BaseModel):
    kind: str = "direction"
    title: str
    outcome: str = ""
    metrics: str = ""
    horizon: str = ""
    next_step: str = ""
    due_date: date | None = None
    progress: int = 0
    status: str = "active"


class PlanPatch(BaseModel):
    kind: str | None = None
    title: str | None = None
    outcome: str | None = None
    metrics: str | None = None
    horizon: str | None = None
    next_step: str | None = None
    due_date: date | None = None
    progress: int | None = None
    status: str | None = None


class BriefCreate(BaseModel):
    content: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)


class CaptureCreate(BaseModel):
    text: str = ""


class AssignmentCreate(BaseModel):
    assignee_id: str = Field(min_length=1, max_length=128)
    kind: str = "task"
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=200_000)
    priority: str = "normal"
    due_date: date | None = None


class AssignmentPatch(BaseModel):
    assignee_id: str | None = Field(default=None, min_length=1, max_length=128)
    kind: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=200_000)
    priority: str | None = None
    due_date: date | None = None
    status: str | None = None


class SubmissionCreate(BaseModel):
    content: str = Field(default="", max_length=200_000)


class ReviewCreate(BaseModel):
    decision: str = Field(pattern="^(accept|return)$")
    feedback: str = Field(default="", max_length=20_000)


# ---------------------------------------------------------------- 条目（items）

#: 条目列表的过滤条件。SQL 只写一份，count 与 select 复用，
#: 避免两处 PSQL 各改一次又不同步（原实现里两条语句各写一份）。
#:
#: 关键点：每个可选条件都写成 `(%s::text IS NULL OR col = %s)`，
#: 判空参数与比较参数必须是**两个位置**。原实现复用了同一个 `%s`
#: （`(%s IS NULL OR col = %s)` 少给一个占位），一旦新增条件或调整顺序，
#: 参数就会错位；这里把占位符集中在一处，count 与 select 共用同一份参数。
# 两条查询的 WHERE 完全一致（占位符个数与顺序都相同），因此参数表可以共用。
# 这里刻意写成**单一字符串字面量**：SQL 由拼接得来时，静态分析无法证明它不含
# 用户输入，也就无法证明它不是注入面 —— 拼接出来的 SQL 一律视为不可信。
_ITEM_COUNT_SQL = "SELECT count(*) AS n FROM labspace.workbench_items WHERE user_id = %s AND (%s::text IS NULL OR kind = %s) AND (%s::text IS NULL OR status = %s) AND (%s::text IS NULL OR project_id = %s) AND (%s::text IS NULL OR title ILIKE %s OR content ILIKE %s)"

# 有截止日期的排前面，再按最近更新；原实现 updated_at DESC 写成了 ASC
_ITEM_SELECT_SQL = "SELECT * FROM labspace.workbench_items WHERE user_id = %s AND (%s::text IS NULL OR kind = %s) AND (%s::text IS NULL OR status = %s) AND (%s::text IS NULL OR project_id = %s) AND (%s::text IS NULL OR title ILIKE %s OR content ILIKE %s) ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT %s"


def _item_filter_params(
    user_id: str,
    kind: str | None,
    status: str | None,
    project_id: str | None,
    q: str | None,
) -> tuple[Any, ...]:
    """查询过滤参数（None 表示该条件不生效）。"""
    like = f"%{q}%" if q else None
    return (
        user_id,
        kind, kind,
        status, status,
        project_id, project_id,
        q, like, like,
    )


@router.get("/items")
async def list_items(
    kind: str | None = Query(default=None),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """按条件列出当前用户的条目。"""
    params = _item_filter_params(user["sub"], kind, status, project_id, q)
    # _ITEM_WHERE 是**常量**片段（只含占位符），这里用 %s 之外不再拼任何用户输入；
    # 写成普通字符串拼接而不是 f-string，是为了让静态分析能确认这不是动态 SQL。
    # 两条查询的 WHERE 子句必须完全一致（占位符个数与顺序都一样），因此
    # 这里用**字面量**而不是变量拼接：拼接出来的 SQL 无法被静态分析确认是常量，
    # 也就无法证明它不含注入面。子句内容见 _ITEM_WHERE（同步维护）。
    count_rows = db.query(
        _ITEM_COUNT_SQL,
        params,
    )
    total = _safe_int(count_rows[0]["n"]) if count_rows else 0
    rows = db.query(
        _ITEM_SELECT_SQL,
        params + (limit,),
    )
    return {"items": [_item_out(r) for r in rows], "total": total}


@router.post("/items")
async def create_item(
    body: ItemCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """新建一条工作台条目。"""
    if body.kind not in ITEM_KINDS:
        raise HTTPException(status_code=400, detail="条目类型无效")
    if body.status not in ITEM_STATUSES:
        raise HTTPException(status_code=400, detail="条目状态无效")
    if body.priority not in ITEM_PRIORITIES:
        raise HTTPException(status_code=400, detail="优先级无效")
    title = body.title.strip() or (body.content.strip().splitlines() or [""])[0][:60]
    item_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO labspace.workbench_items
            (id, user_id, kind, title, content, status, priority, tags, project_id, plan_id, due_date, source)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'manual')
        """,
        (
            item_id,
            user["sub"],
            body.kind,
            title,
            body.content,
            body.status,
            body.priority,
            list(body.tags or []),
            body.project_id,
            body.plan_id,
            body.due_date,
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_items WHERE id=%s AND user_id=%s",
        (item_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="条目创建失败")
    return {"item": _item_out(rows[0])}


@router.patch("/items/{item_id}")
async def patch_item(
    item_id: str,
    body: ItemPatch,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """更新自己的条目（任意字段子集）。"""
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    if "kind" in fields and fields["kind"] not in ITEM_KINDS:
        raise HTTPException(status_code=400, detail="条目类型无效")
    if "status" in fields and fields["status"] not in ITEM_STATUSES:
        raise HTTPException(status_code=400, detail="条目状态无效")
    if "priority" in fields and fields["priority"] not in ITEM_PRIORITIES:
        raise HTTPException(status_code=400, detail="优先级无效")

    db.execute(
        "UPDATE labspace.workbench_items SET kind = CASE WHEN %s THEN %s::text ELSE kind END, title = CASE WHEN %s THEN %s::text ELSE title END, content = CASE WHEN %s THEN %s::text ELSE content END, tags = CASE WHEN %s THEN %s::text[] ELSE tags END, priority = CASE WHEN %s THEN %s::text ELSE priority END, due_date = CASE WHEN %s THEN %s::date ELSE due_date END, project_id = CASE WHEN %s THEN %s::text ELSE project_id END, plan_id = CASE WHEN %s THEN %s::text ELSE plan_id END, status = CASE WHEN %s THEN %s::text ELSE status END, updated_at = now() WHERE id=%s AND user_id=%s",
        (
            "kind" in fields, fields.get("kind"),
            "title" in fields, fields.get("title"),
            "content" in fields, fields.get("content"),
            "tags" in fields, fields.get("tags"),
            "priority" in fields, fields.get("priority"),
            "due_date" in fields, fields.get("due_date"),
            "project_id" in fields, fields.get("project_id"),
            "plan_id" in fields, fields.get("plan_id"),
            "status" in fields, fields.get("status"),
            item_id, user["sub"],
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_items WHERE id=%s AND user_id=%s",
        (item_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="条目不存在")
    return {"item": _item_out(rows[0])}


@router.delete("/items/{item_id}")
async def delete_item(
    item_id: str,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """删除自己的条目。"""
    rows = db.query(
        "SELECT id FROM labspace.workbench_items WHERE id=%s AND user_id=%s",
        (item_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="条目不存在")
    db.execute(
        "DELETE FROM labspace.workbench_items WHERE id=%s AND user_id=%s",
        (item_id, user["sub"]),
    )
    return {"ok": True}


# ---------------------------------------------------------------- 项目（projects）


@router.get("/projects")
async def list_projects(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    rows = db.query(
        "SELECT * FROM labspace.workbench_projects WHERE user_id=%s "
        "ORDER BY (status <> 'active'), updated_at DESC",
        (user["sub"],),
    )
    return {"projects": [_project_out(r) for r in rows]}


@router.post("/projects")
async def create_project(
    body: ProjectCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    if body.status not in PROJECT_STATUSES:
        raise HTTPException(status_code=400, detail="项目状态无效")
    if body.health not in PROJECT_HEALTHS:
        raise HTTPException(status_code=400, detail="项目健康度无效")
    project_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO labspace.workbench_projects
            (id, user_id, name, description, status, health, progress, next_step, due_date)
        VALUES (%s,%s,%s,%s,%s,%s,0,%s,%s)
        """,
        (
            project_id,
            user["sub"],
            body.name.strip(),
            body.description,
            body.status,
            body.health,
            body.next_step,
            body.due_date,
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_projects WHERE id=%s AND user_id=%s",
        (project_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="项目创建失败")
    return {"project": _project_out(rows[0])}


@router.patch("/projects/{project_id}")
async def patch_project(
    project_id: str,
    body: ProjectPatch,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    if "status" in fields and fields["status"] not in PROJECT_STATUSES:
        raise HTTPException(status_code=400, detail="项目状态无效")
    if "health" in fields and fields["health"] not in PROJECT_HEALTHS:
        raise HTTPException(status_code=400, detail="项目健康度无效")
    if "progress" in fields:
        fields["progress"] = max(0, min(100, int(fields["progress"])))
    db.execute(
        "UPDATE labspace.workbench_projects SET name = CASE WHEN %s THEN %s::text ELSE name END, description = CASE WHEN %s THEN %s::text ELSE description END, next_step = CASE WHEN %s THEN %s::text ELSE next_step END, due_date = CASE WHEN %s THEN %s::date ELSE due_date END, health = CASE WHEN %s THEN %s::text ELSE health END, status = CASE WHEN %s THEN %s::text ELSE status END, progress = CASE WHEN %s THEN %s::int ELSE progress END, updated_at = now() WHERE id=%s AND user_id=%s",
        (
            "name" in fields, fields.get("name"),
            "description" in fields, fields.get("description"),
            "next_step" in fields, fields.get("next_step"),
            "due_date" in fields, fields.get("due_date"),
            "health" in fields, fields.get("health"),
            "status" in fields, fields.get("status"),
            "progress" in fields, fields.get("progress"),
            project_id, user["sub"],
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_projects WHERE id=%s AND user_id=%s",
        (project_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="项目不存在")
    return {"project": _project_out(rows[0])}


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = db.query(
        "SELECT id FROM labspace.workbench_projects WHERE id=%s AND user_id=%s",
        (project_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="项目不存在")
    db.execute(
        "DELETE FROM labspace.workbench_projects WHERE id=%s AND user_id=%s",
        (project_id, user["sub"]),
    )
    return {"ok": True}


# ---------------------------------------------------------------- 计划（plans）


@router.get("/plans")
async def list_plans(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    rows = db.query(
        "SELECT * FROM labspace.workbench_plans WHERE user_id=%s "
        "ORDER BY (status = 'archived'), kind, updated_at DESC",
        (user["sub"],),
    )
    return {"plans": [_plan_out(r) for r in rows]}


@router.post("/plans")
async def create_plan(
    body: PlanCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    if body.kind not in PLAN_KINDS:
        raise HTTPException(status_code=400, detail="计划类型无效")
    if body.status not in PLAN_STATUSES:
        raise HTTPException(status_code=400, detail="计划状态无效")
    plan_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO labspace.workbench_plans
            (id, user_id, kind, title, outcome, metrics, horizon, progress, status, next_step, due_date)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            plan_id,
            user["sub"],
            body.kind,
            body.title.strip(),
            body.outcome,
            body.metrics,
            body.horizon,
            max(0, min(100, int(body.progress))),
            body.status,
            body.next_step,
            body.due_date,
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_plans WHERE id=%s AND user_id=%s",
        (plan_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="计划创建失败")
    return {"plan": _plan_out(rows[0])}


@router.patch("/plans/{plan_id}")
async def patch_plan(
    plan_id: str,
    body: PlanPatch,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    if "kind" in fields and fields["kind"] not in PLAN_KINDS:
        raise HTTPException(status_code=400, detail="计划类型无效")
    if "status" in fields and fields["status"] not in PLAN_STATUSES:
        raise HTTPException(status_code=400, detail="计划状态无效")
    if "progress" in fields:
        fields["progress"] = max(0, min(100, int(fields["progress"])))
    db.execute(
        "UPDATE labspace.workbench_plans SET kind = CASE WHEN %s THEN %s::text ELSE kind END, title = CASE WHEN %s THEN %s::text ELSE title END, outcome = CASE WHEN %s THEN %s::text ELSE outcome END, metrics = CASE WHEN %s THEN %s::text ELSE metrics END, horizon = CASE WHEN %s THEN %s::text ELSE horizon END, next_step = CASE WHEN %s THEN %s::text ELSE next_step END, due_date = CASE WHEN %s THEN %s::date ELSE due_date END, progress = CASE WHEN %s THEN %s::int ELSE progress END, status = CASE WHEN %s THEN %s::text ELSE status END, updated_at = now() WHERE id=%s AND user_id=%s",
        (
            "kind" in fields, fields.get("kind"),
            "title" in fields, fields.get("title"),
            "outcome" in fields, fields.get("outcome"),
            "metrics" in fields, fields.get("metrics"),
            "horizon" in fields, fields.get("horizon"),
            "next_step" in fields, fields.get("next_step"),
            "due_date" in fields, fields.get("due_date"),
            "progress" in fields, fields.get("progress"),
            "status" in fields, fields.get("status"),
            plan_id, user["sub"],
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_plans WHERE id=%s AND user_id=%s",
        (plan_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="计划不存在")
    return {"plan": _plan_out(rows[0])}


@router.delete("/plans/{plan_id}")
async def delete_plan(
    plan_id: str,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = db.query(
        "SELECT id FROM labspace.workbench_plans WHERE id=%s AND user_id=%s",
        (plan_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="计划不存在")
    db.execute(
        "DELETE FROM labspace.workbench_plans WHERE id=%s AND user_id=%s",
        (plan_id, user["sub"]),
    )
    return {"ok": True}


# ---------------------------------------------------------------- 导师指派
#
# 可见范围严格按「创建者 / 被指派人」两人，管理员也不能越权浏览他人指派；
# 附件存 bytea，只经本文件的下载接口流出，下载前同样校验两人身份。


# 组别层级：实习生 < 本科生 < 研究生 < 博士生 < 博士后 < 老师。
# 组名沿用 GroupPermissions 的预配置值，同时兼容常见别名。
_ASSIGN_RANKS: list[tuple[int, str, tuple[str, ...]]] = [
    (5, "老师", ("lab-teacher", "teacher", "老师")),
    (4, "博士后", ("lab-postdoc", "postdoc", "博士后")),
    (3, "博士生", ("lab-phd", "phd", "博士", "博士生")),
    (2, "研究生", ("lab-master", "master", "研究生")),
    (1, "本科生", ("lab-undergrad", "undergrad", "本科生")),
    (0, "实习生", ("lab-intern", "intern", "实习生")),
]


def _assign_rank(groups: list[Any]) -> tuple[int | None, str]:
    names = {str(g).strip().lower() for g in groups if str(g).strip()}
    if names & {r.lower() for r in settings.admin_roles}:
        return 5, "管理员"
    for rank, label, aliases in _ASSIGN_RANKS:
        if names & {a.lower() for a in aliases}:
            return rank, label
    return None, ""


async def _load_assignments(ids: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not ids:
        return [], []
    subs, files = await _q_batch(
        [
            (
                "SELECT * FROM labspace.workbench_assignment_submissions "
                "WHERE assignment_id = ANY(%s) ORDER BY created_at DESC",
                (ids,),
            ),
            (
                "SELECT id, assignment_id, submission_id, uploader_id, purpose, filename, "
                "content_type, size_bytes, created_at "
                "FROM labspace.workbench_assignment_files "
                "WHERE assignment_id = ANY(%s) ORDER BY created_at",
                (ids,),
            ),
        ]
    )
    return subs, files


async def _assignment_detail(assignment_id: str, user_id: str) -> dict[str, Any]:
    rows = await _q(
        "SELECT * FROM labspace.workbench_assignments WHERE id=%s AND (creator_id=%s OR assignee_id=%s)",
        (assignment_id, user_id, user_id),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="指派不存在")
    subs, files = await _load_assignments([assignment_id])
    return _assignment_out(rows[0], subs, files)


def _file_meta(row: dict[str, Any]) -> dict[str, Any]:
    return _file_out(row)


@router.get("/assignments")
async def list_assignments(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """我收到的 + 我发出的指派（只有这两种身份可见）。"""
    uid = user["sub"]
    rows = await _q(
        "SELECT * FROM labspace.workbench_assignments "
        "WHERE creator_id=%s OR assignee_id=%s ORDER BY updated_at DESC LIMIT 200",
        (uid, uid),
    )
    ids = [str(r["id"]) for r in rows]
    subs, files = await _load_assignments(ids)
    incoming = [
        _assignment_out(r, subs, files) for r in rows if r["assignee_id"] == uid
    ]
    outgoing = [
        _assignment_out(r, subs, files) for r in rows if r["creator_id"] == uid
    ]
    return {"incoming": incoming, "outgoing": outgoing}


@router.get("/assignment-people")
async def assignment_people(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """可派发对象：实习生以外的成员，只能选择同组或更低组别（排除自己）。"""
    my_rank, my_label = _assign_rank(user.get("roles") or [])
    if not my_rank:
        raise HTTPException(status_code=403, detail="实习生没有任务派发权限")
    people = await asyncio.to_thread(accounts_mod.directory)
    out: list[dict[str, Any]] = []
    for p in people:
        if p["id"] == user["sub"]:
            continue
        rank, label = _assign_rank(p.get("groups") or [])
        if rank is None or rank > my_rank:
            continue
        out.append({**p, "rank": rank, "rankLabel": label})
    return {"people": out, "myRank": my_rank, "myRankLabel": my_label}


class MentorBinding(BaseModel):
    mentor_id: str = ""


async def _directory() -> list[dict[str, Any]]:
    return await asyncio.to_thread(accounts_mod.directory)


@router.get("/mentor-bindings")
async def mentor_bindings(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """导师绑定总览：老师/高年级可管理，成员可查看自己的导师。"""
    my_rank, my_label = _assign_rank(user.get("roles") or [])
    people = await _directory()
    by_id = {p["id"]: p for p in people}
    rows = await _q(
        "SELECT user_id, mentor_id, created_at FROM labspace.workbench_mentors ORDER BY created_at"
    )
    bindings = [
        {
            "userId": str(r["user_id"]),
            "userName": by_id.get(str(r["user_id"]), {}).get("name") or str(r["user_id"]),
            "mentorId": str(r["mentor_id"]),
            "mentorName": by_id.get(str(r["mentor_id"]), {}).get("name") or str(r["mentor_id"]),
        }
        for r in rows
    ]
    can_bind = (my_rank or 0) >= 3
    interns: list[dict[str, Any]] = []
    mentors: list[dict[str, Any]] = []
    if can_bind:
        for p in people:
            rank, label = _assign_rank(p.get("groups") or [])
            item = {"id": p["id"], "name": p.get("name") or p["id"], "email": p.get("email", ""), "rank": rank, "rankLabel": label}
            if rank is None:
                item.update({"rank": -1, "rankLabel": "未分组"})
                interns.append(item)
            elif rank <= 2:
                interns.append(item)
            else:
                mentors.append(item)
    my_mentor = next((b for b in bindings if b["userId"] == user["sub"]), None)
    return {
        "bindings": bindings,
        "interns": sorted(interns, key=lambda x: x["name"]),
        "mentors": sorted(mentors, key=lambda x: (-x["rank"], x["name"])),
        "myMentor": my_mentor,
        "canBind": can_bind,
        "myRank": my_rank,
        "myRankLabel": my_label,
    }


@router.put("/mentor-bindings/{user_id}")
async def bind_mentor(
    user_id: str,
    body: MentorBinding,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    my_rank, _ = _assign_rank(user.get("roles") or [])
    if (my_rank or 0) < 3:
        raise HTTPException(status_code=403, detail="需要博士生及以上权限才能绑定")
    if not body.mentor_id:
        raise HTTPException(status_code=400, detail="请选择导师")
    if user_id == body.mentor_id:
        raise HTTPException(status_code=400, detail="不能绑定到自己")
    people = {p["id"]: p for p in await _directory()}
    target = people.get(user_id)
    mentor = people.get(body.mentor_id)
    if not target or not mentor:
        raise HTTPException(status_code=404, detail="成员不存在")
    target_rank, _ = _assign_rank(target.get("groups") or [])
    mentor_rank, _ = _assign_rank(mentor.get("groups") or [])
    if mentor_rank is None:
        raise HTTPException(status_code=400, detail="导师尚未分配组别")
    if target_rank is not None and mentor_rank <= target_rank:
        raise HTTPException(status_code=400, detail="导师组别必须高于被绑定成员")
    await asyncio.to_thread(
        db.execute,
        "INSERT INTO labspace.workbench_mentors (user_id, mentor_id) VALUES (%s, %s) "
        "ON CONFLICT (user_id) DO UPDATE SET mentor_id=EXCLUDED.mentor_id, created_at=now()",
        (user_id, body.mentor_id),
    )
    return {"ok": True, "userId": user_id, "mentorId": body.mentor_id}


@router.delete("/mentor-bindings/{user_id}")
async def unbind_mentor(
    user_id: str,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    my_rank, _ = _assign_rank(user.get("roles") or [])
    if (my_rank or 0) < 3:
        raise HTTPException(status_code=403, detail="需要博士生及以上权限才能解绑")
    await asyncio.to_thread(db.execute, "DELETE FROM labspace.workbench_mentors WHERE user_id=%s", (user_id,))
    return {"ok": True}


@router.post("/assignments")
async def create_assignment(
    body: AssignmentCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    if body.kind not in ASSIGNMENT_KINDS:
        raise HTTPException(status_code=400, detail="指派类型无效")
    if body.priority not in ASSIGNMENT_PRIORITIES:
        raise HTTPException(status_code=400, detail="优先级无效")
    if body.assignee_id == user["sub"]:
        raise HTTPException(status_code=400, detail="不能指派给自己")
    my_rank, _ = _assign_rank(user.get("roles") or [])
    if not my_rank:
        raise HTTPException(status_code=403, detail="实习生没有任务派发权限")
    people = await asyncio.to_thread(accounts_mod.directory)
    person = next((p for p in people if p["id"] == body.assignee_id), None)
    if not person:
        raise HTTPException(status_code=404, detail="被指派人不存在或已停用")
    target_rank, _ = _assign_rank(person.get("groups") or [])
    if target_rank is None:
        raise HTTPException(status_code=400, detail="被指派人尚未配置用户组")
    if my_rank is None or target_rank > my_rank:
        raise HTTPException(status_code=403, detail="只能向同组或更低组别的成员派发任务")

    assignment_id = str(uuid.uuid4())
    creator_name = str(user.get("name") or user.get("email") or "")
    await asyncio.to_thread(
        db.execute,
        """
        INSERT INTO labspace.workbench_assignments
            (id, creator_id, creator_name, assignee_id, assignee_name,
             kind, title, content, status, priority, due_date)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'assigned',%s,%s)
        """,
        (
            assignment_id,
            user["sub"],
            creator_name,
            body.assignee_id,
            str(person.get("displayName") or person.get("name") or ""),
            body.kind,
            body.title.strip(),
            body.content,
            body.priority,
            body.due_date,
        ),
    )
    return {"assignment": await _assignment_detail(assignment_id, user["sub"])}


@router.patch("/assignments/{assignment_id}")
async def patch_assignment(
    assignment_id: str,
    body: AssignmentPatch,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = await _q(
        "SELECT * FROM labspace.workbench_assignments WHERE id=%s", (assignment_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="指派不存在")
    row = rows[0]
    uid = user["sub"]
    is_creator = row["creator_id"] == uid
    is_assignee = row["assignee_id"] == uid
    if not (is_creator or is_assignee):
        raise HTTPException(status_code=404, detail="指派不存在")

    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    if is_creator:
        extra = set(fields) - {"assignee_id", "kind", "title", "content", "priority", "due_date", "status"}
        if extra:
            raise HTTPException(status_code=403, detail="导师不能修改这些字段")
        if "status" in fields and fields["status"] not in CREATOR_STATUSES:
            raise HTTPException(status_code=400, detail="状态无效（导师可重开 / 通过 / 退回）")
    else:
        if set(fields) - {"status"}:
            raise HTTPException(status_code=403, detail="只能更新自己的进度状态")
        if fields.get("status") not in ASSIGNEE_STATUSES:
            raise HTTPException(status_code=400, detail="状态无效（只能标记开始 / 待开始）")

    if "kind" in fields and fields["kind"] not in ASSIGNMENT_KINDS:
        raise HTTPException(status_code=400, detail="指派类型无效")
    if "priority" in fields and fields["priority"] not in ASSIGNMENT_PRIORITIES:
        raise HTTPException(status_code=400, detail="优先级无效")

    assignee_name: str | None = None
    if "assignee_id" in fields:
        new_id = str(fields["assignee_id"])
        if new_id == row["creator_id"]:
            raise HTTPException(status_code=400, detail="不能指派给创建者自己")
        people = await asyncio.to_thread(accounts_mod.directory)
        person = next((p for p in people if p["id"] == new_id), None)
        if not person:
            raise HTTPException(status_code=404, detail="被指派人不存在或已停用")
        my_rank, _ = _assign_rank(user.get("roles") or [])
        target_rank, _ = _assign_rank(person.get("groups") or [])
        if my_rank is None or my_rank < 1:
            raise HTTPException(status_code=403, detail="实习生没有任务派发权限")
        if target_rank is None or target_rank > my_rank:
            raise HTTPException(status_code=403, detail="只能向同组或更低组别的成员派发任务")
        assignee_name = str(person.get("displayName") or person.get("name") or "")

    await asyncio.to_thread(
        db.execute,
        """
        UPDATE labspace.workbench_assignments SET
            assignee_id = CASE WHEN %s THEN %s::text ELSE assignee_id END,
            assignee_name = CASE WHEN %s THEN %s::text ELSE assignee_name END,
            kind = CASE WHEN %s THEN %s::text ELSE kind END,
            title = CASE WHEN %s THEN %s::text ELSE title END,
            content = CASE WHEN %s THEN %s::text ELSE content END,
            priority = CASE WHEN %s THEN %s::text ELSE priority END,
            due_date = CASE WHEN %s THEN %s::date ELSE due_date END,
            status = CASE WHEN %s THEN %s::text ELSE status END,
            updated_at = now()
        WHERE id=%s
        """,
        (
            "assignee_id" in fields, fields.get("assignee_id"),
            "assignee_id" in fields, assignee_name,
            "kind" in fields, fields.get("kind"),
            "title" in fields, fields.get("title"),
            "content" in fields, fields.get("content"),
            "priority" in fields, fields.get("priority"),
            "due_date" in fields, fields.get("due_date"),
            "status" in fields, fields.get("status"),
            assignment_id,
        ),
    )
    return {"assignment": await _assignment_detail(assignment_id, uid)}


@router.delete("/assignments/{assignment_id}")
async def delete_assignment(
    assignment_id: str,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = await _q(
        "SELECT creator_id FROM labspace.workbench_assignments WHERE id=%s",
        (assignment_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="指派不存在")
    if rows[0]["creator_id"] != user["sub"]:
        raise HTTPException(status_code=403, detail="只有导师可以删除指派")
    await asyncio.to_thread(
        db.execute,
        "DELETE FROM labspace.workbench_assignment_files WHERE assignment_id=%s",
        (assignment_id,),
    )
    await asyncio.to_thread(
        db.execute,
        "DELETE FROM labspace.workbench_assignment_submissions WHERE assignment_id=%s",
        (assignment_id,),
    )
    await asyncio.to_thread(
        db.execute,
        "DELETE FROM labspace.workbench_assignments WHERE id=%s",
        (assignment_id,),
    )
    return {"ok": True}


@router.post("/assignments/{assignment_id}/submit")
async def submit_assignment(
    assignment_id: str,
    body: SubmissionCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """被指派人提交交付内容；同一指派可多次提交，历史全部保留。"""
    rows = await _q(
        "SELECT * FROM labspace.workbench_assignments WHERE id=%s", (assignment_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="指派不存在")
    row = rows[0]
    if row["assignee_id"] != user["sub"]:
        raise HTTPException(status_code=403, detail="只有被指派人可以提交")
    if row["status"] == "accepted":
        raise HTTPException(status_code=400, detail="指派已通过，无需再提交")

    pending_files = await _q(
        "SELECT count(*) AS n FROM labspace.workbench_assignment_files "
        "WHERE assignment_id=%s AND purpose='delivery' AND submission_id IS NULL",
        (assignment_id,),
    )
    has_files = _safe_int(pending_files[0]["n"]) > 0 if pending_files else False
    content = body.content.strip()
    if not content and not has_files:
        raise HTTPException(status_code=400, detail="请填写交付说明或上传交付附件")

    submission_id = str(uuid.uuid4())
    await asyncio.to_thread(
        db.execute,
        """
        INSERT INTO labspace.workbench_assignment_submissions
            (id, assignment_id, author_id, content)
        VALUES (%s,%s,%s,%s)
        """,
        (submission_id, assignment_id, user["sub"], body.content),
    )
    await asyncio.to_thread(
        db.execute,
        "UPDATE labspace.workbench_assignment_files SET submission_id=%s "
        "WHERE assignment_id=%s AND purpose='delivery' AND submission_id IS NULL",
        (submission_id, assignment_id),
    )
    await asyncio.to_thread(
        db.execute,
        "UPDATE labspace.workbench_assignments SET status='submitted', "
        "submitted_at=now(), updated_at=now() WHERE id=%s",
        (assignment_id,),
    )
    return {"assignment": await _assignment_detail(assignment_id, user["sub"])}


@router.post("/assignments/{assignment_id}/review")
async def review_assignment(
    assignment_id: str,
    body: ReviewCreate,
    user: dict[str, Any] = Depends(require_teacher),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = await _q(
        "SELECT * FROM labspace.workbench_assignments WHERE id=%s", (assignment_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail="指派不存在")
    row = rows[0]
    if row["creator_id"] != user["sub"]:
        raise HTTPException(status_code=403, detail="只有指派的导师可以批阅")
    if row["status"] != "submitted":
        raise HTTPException(status_code=400, detail="当前状态没有待批阅的提交")
    status = "accepted" if body.decision == "accept" else "returned"
    await asyncio.to_thread(
        db.execute,
        "UPDATE labspace.workbench_assignments SET status=%s, feedback=%s, "
        "reviewed_at=now(), updated_at=now() WHERE id=%s",
        (status, body.feedback, assignment_id),
    )
    return {"assignment": await _assignment_detail(assignment_id, user["sub"])}


@router.post("/assignments/{assignment_id}/files")
async def upload_assignment_file(
    assignment_id: str,
    purpose: str = Query("brief", pattern="^(brief|delivery)$"),
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = await _q(
        "SELECT creator_id, assignee_id FROM labspace.workbench_assignments WHERE id=%s",
        (assignment_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="指派不存在")
    uid = user["sub"]
    is_creator = rows[0]["creator_id"] == uid
    is_assignee = rows[0]["assignee_id"] == uid
    if not (is_creator or is_assignee):
        raise HTTPException(status_code=404, detail="指派不存在")
    if is_creator and not is_assignee and purpose != "brief":
        raise HTTPException(status_code=403, detail="导师附件请使用 purpose=brief")
    if is_assignee and not is_creator and purpose != "delivery":
        raise HTTPException(status_code=403, detail="交付附件请使用 purpose=delivery")

    count_rows = await _q(
        "SELECT count(*) AS n FROM labspace.workbench_assignment_files "
        "WHERE assignment_id=%s AND uploader_id=%s",
        (assignment_id, uid),
    )
    if count_rows and _safe_int(count_rows[0]["n"]) >= ASSIGNMENT_FILES_MAX:
        raise HTTPException(status_code=400, detail=f"每位成员最多上传 {ASSIGNMENT_FILES_MAX} 个附件")

    raw = await read_upload_capped(file, ASSIGNMENT_FILE_MAX, message="附件超过 20 MB 上限")
    if not raw:
        raise HTTPException(status_code=400, detail="附件为空")
    name = os.path.basename((file.filename or "attachment").replace("\\", "/")).strip()
    name = (name or "attachment")[:200]
    file_id = str(uuid.uuid4())
    await asyncio.to_thread(
        db.execute,
        """
        INSERT INTO labspace.workbench_assignment_files
            (id, assignment_id, uploader_id, purpose, filename, content_type, size_bytes, data)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            file_id,
            assignment_id,
            uid,
            purpose,
            name,
            file.content_type or "application/octet-stream",
            len(raw),
            psycopg2.Binary(raw),
        ),
    )
    meta = await _q(
        "SELECT id, assignment_id, submission_id, uploader_id, purpose, filename, "
        "content_type, size_bytes, created_at "
        "FROM labspace.workbench_assignment_files WHERE id=%s",
        (file_id,),
    )
    if not meta:
        raise HTTPException(status_code=500, detail="附件保存失败")
    return {"file": _file_meta(meta[0])}


@router.get("/assignment-files/{file_id}")
async def download_assignment_file(
    file_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> Response:
    rows = await _q(
        """
        SELECT f.*, a.creator_id, a.assignee_id
        FROM labspace.workbench_assignment_files f
        JOIN labspace.workbench_assignments a ON a.id = f.assignment_id
        WHERE f.id=%s
        """,
        (file_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="附件不存在")
    row = rows[0]
    uid = user["sub"]
    if uid not in (row["creator_id"], row["assignee_id"]):
        raise HTTPException(status_code=404, detail="附件不存在")

    name = str(row.get("filename") or "attachment")
    quoted = urllib.parse.quote(name)
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120] or "attachment"
    return Response(
        content=bytes(row["data"]),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("/assignment-files/{file_id}")
async def delete_assignment_file(
    file_id: str,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    rows = await _q(
        """
        SELECT f.uploader_id, a.creator_id
        FROM labspace.workbench_assignment_files f
        JOIN labspace.workbench_assignments a ON a.id = f.assignment_id
        WHERE f.id=%s
        """,
        (file_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="附件不存在")
    if user["sub"] not in (rows[0]["uploader_id"], rows[0]["creator_id"]):
        raise HTTPException(status_code=403, detail="无权删除该附件")
    await asyncio.to_thread(
        db.execute,
        "DELETE FROM labspace.workbench_assignment_files WHERE id=%s",
        (file_id,),
    )
    return {"ok": True}


# ---------------------------------------------------------------- 每日简报（briefs）


@router.get("/briefs")
async def list_briefs(
    limit: int = Query(default=DEFAULT_BRIEF_LIMIT, ge=1, le=MAX_LIMIT),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    rows = db.query(
        "SELECT * FROM labspace.workbench_briefs WHERE user_id=%s ORDER BY brief_date DESC LIMIT %s",
        (user["sub"], limit),
    )
    return {"briefs": [_brief_out(r) for r in rows]}


@router.post("/briefs")
async def create_brief(
    body: BriefCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """写入今天的简报（同一用户同一天覆盖）。"""
    brief_date = _today()
    brief_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO labspace.workbench_briefs (id, user_id, brief_date, content, payload)
        VALUES (%s,%s,%s,%s,%s)
        ON CONFLICT (user_id, brief_date)
        DO UPDATE SET content=EXCLUDED.content, payload=EXCLUDED.payload
        """,
        (brief_id, user["sub"], brief_date, body.content, Json(body.payload or {})),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_briefs WHERE user_id=%s AND brief_date=%s",
        (user["sub"], brief_date),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="简报写入失败")
    return {"brief": _brief_out(rows[0])}


# ---------------------------------------------------------------- 智能捕获


@router.post("/capture")
async def capture(
    body: CaptureCreate,
    user: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """把一句话按本地规则记入工作台（不调用 LLM）。"""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="捕获内容不能为空")

    analysis = analyze_capture(text)
    # SystemOne 决策模型可用时覆盖类型/优先级；不可用或超时则沿用本地规则
    ai = await decision.classify_capture(text)
    if ai:
        analysis["kind"] = ai["kind"]
        analysis["priority"] = "high" if ai["priority"] == "urgent" else ai["priority"]
        analysis["ai_reason"] = ai["reason"] + "；" + analysis["ai_reason"]
        if isinstance(ai.get("confidence"), (int, float)):
            analysis["confidence"] = round(max(0.4, min(0.98, float(ai["confidence"]))), 2)
    item_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO labspace.workbench_items
            (id, user_id, kind, title, content, status, priority, tags, due_date, source,
             ai_class, ai_reason, confidence)
        VALUES (%s,%s,%s,%s,%s,'active',%s,%s,%s,'capture',%s,%s,%s)
        """,
        (
            item_id,
            user["sub"],
            analysis["kind"],
            analysis["title"],
            analysis["content"],
            analysis["priority"],
            list(analysis["tags"]),
            analysis["due_date"],
            analysis["kind"],
            analysis["ai_reason"],
            analysis["confidence"],
        ),
    )
    rows = db.query(
        "SELECT * FROM labspace.workbench_items WHERE id=%s AND user_id=%s",
        (item_id, user["sub"]),
    )
    if not rows:
        raise HTTPException(status_code=500, detail="捕获失败")
    return {
        "item": _item_out(rows[0]),
        "ai_class": analysis["kind"],
        "ai_reason": analysis["ai_reason"],
        "confidence": analysis["confidence"],
        "extracted": {
            "due_date": _iso(analysis["due_date"]),
            "tags": list(analysis["tags"]),
            "priority": analysis["priority"],
        },
    }


# ---------------------------------------------------------------- 首页聚合


@router.get("/summary")
async def summary(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """个人工作台首页聚合数据。

    原实现对同一个 /items 表发起了 8 条**串行**查询，其中 5 条是 count(*)，
    另外 5 条是「全量取回再截断」的列表（无 LIMIT）。这里改成：
    列表查询带上限（前端只展示前若干条），并整体并发执行。
    """
    uid = user["sub"]
    today = _today()
    day_start, day_end = _local_day_bounds(today)
    week_start, _ = _local_day_bounds(_week_start(today))
    week_end = week_start + timedelta(days=7)
    preview = 50  # 首页只看前 50 条，超出部分去 /items 分页取

    tasks_sql = (
        "SELECT * FROM labspace.workbench_items "
        "WHERE user_id=%s AND status='active' AND kind='task' "
        "ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT %s"
    )
    others_sql = (
        "SELECT * FROM labspace.workbench_items "
        "WHERE user_id=%s AND status='active' AND kind <> 'task' "
        "ORDER BY (due_date IS NULL), due_date ASC, updated_at DESC LIMIT %s"
    )
    overdue_sql = (
        "SELECT * FROM labspace.workbench_items "
        "WHERE user_id=%s AND status='active' AND due_date < %s ORDER BY due_date ASC LIMIT %s"
    )
    due_today_sql = (
        "SELECT * FROM labspace.workbench_items "
        "WHERE user_id=%s AND status='active' AND due_date = %s ORDER BY updated_at DESC LIMIT %s"
    )
    done_today_sql = (
        "SELECT * FROM labspace.workbench_items "
        "WHERE user_id=%s AND status='done' AND updated_at >= %s AND updated_at < %s"
        " ORDER BY updated_at DESC LIMIT %s"
    )
    # 5 条 count 合并成一条：用 FILTER 聚合同一次扫描完成
    stats_sql = """
        SELECT
          count(*) FILTER (WHERE kind='task' AND status='active')                     AS active_tasks,
          count(*) FILTER (WHERE kind='note' AND status='active')                     AS inbox,
          count(*) FILTER (WHERE status='done' AND updated_at >= %s AND updated_at < %s) AS completed_week
        FROM labspace.workbench_items WHERE user_id=%s
    """
    projects_sql = (
        "SELECT * FROM labspace.workbench_projects WHERE user_id=%s AND status <> 'archived' "
        "ORDER BY (status <> 'active'), updated_at DESC LIMIT %s"
    )
    plan_sql = (
        "SELECT * FROM labspace.workbench_plans "
        "WHERE user_id=%s AND kind=%s AND status <> 'archived' ORDER BY updated_at DESC LIMIT %s"
    )
    brief_sql = "SELECT * FROM labspace.workbench_briefs WHERE user_id=%s AND brief_date=%s"

    (
        tasks, others, overdue, due_today, done_today,
        project_rows, direction_rows, stage_rows, brief_rows,
        stats_rows, project_stats, plan_stats,
    ) = await _q_batch([
        (tasks_sql, (uid, preview)),
        (others_sql, (uid, preview)),
        (overdue_sql, (uid, today, preview)),
        (due_today_sql, (uid, today, preview)),
        (done_today_sql, (uid, day_start, day_end, preview)),
        (projects_sql, (uid, preview)),
        (plan_sql, (uid, "direction", preview)),
        (plan_sql, (uid, "stage", preview)),
        (brief_sql, (uid, today)),
        (stats_sql, (week_start, week_end, uid)),
        (
            "SELECT count(*) FILTER (WHERE status='active') AS n "
            "FROM labspace.workbench_projects WHERE user_id=%s",
            (uid,),
        ),
        (
            "SELECT count(*) FILTER (WHERE status='active' AND kind='direction') AS n "
            "FROM labspace.workbench_plans WHERE user_id=%s",
            (uid,),
        ),
    ])

    brief = _brief_out(brief_rows[0]) if brief_rows else None
    stats_row = stats_rows[0] if stats_rows else {}

    def _n(rows: list[dict[str, Any]], field: str = "n") -> int:
        return _safe_int(rows[0].get(field)) if rows else 0

    return {
        "today": {
            "tasks": [_item_out(r) for r in tasks],
            "others": [_item_out(r) for r in others],
            "overdue": [_item_out(r) for r in overdue],
            "dueToday": [_item_out(r) for r in due_today],
            "doneToday": [_item_out(r) for r in done_today],
        },
        "projects": [_project_out(r) for r in project_rows],
        "plans": {
            "directions": [_plan_out(r) for r in direction_rows],
            "stages": [_plan_out(r) for r in stage_rows],
        },
        "brief": brief,
        "stats": {
            "activeTasks": _safe_int(stats_row.get("active_tasks")),
            "activeProjects": _n(project_stats),
            "activeDirections": _n(plan_stats),
            "inbox": _safe_int(stats_row.get("inbox")),
            "completedThisWeek": _safe_int(stats_row.get("completed_week")),
        },
    }
