"""LabSpace 业务数据（收藏 / 最近访问等）。

使用独立的 labspace 数据库，表名带 labspace 前缀，避免与既有表冲突。
收藏 / 最近访问的浏览器请求现由 Go 核心（internal/portal）处理，
本模块保留同样的实现，作为 Go 不可用时的 /v1/* 兼顶路径。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pgpool

from .config import settings

log = logging.getLogger("labspace.db")
_pool: pgpool.ThreadedConnectionPool | None = None
_lock = threading.Lock()

SCHEMA = """
CREATE SCHEMA IF NOT EXISTS labspace;
CREATE TABLE IF NOT EXISTS labspace.favorites (
    user_id   text NOT NULL,
    service_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, service_id)
);
CREATE TABLE IF NOT EXISTS labspace.recent (
    user_id   text NOT NULL,
    service_id text NOT NULL,
    visited_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, service_id)
);
CREATE TABLE IF NOT EXISTS labspace.announcements (
    id         text PRIMARY KEY,
    title      text NOT NULL,
    content    text NOT NULL,
    level      text NOT NULL DEFAULT 'info',
    author     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS labspace.drawings (
    id         text PRIMARY KEY,
    user_id    text NOT NULL,
    name       text NOT NULL,
    content    text NOT NULL,
    size       integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 账号管理审计（只记录管理员对 Casdoor 账号的写操作）
CREATE TABLE IF NOT EXISTS labspace.account_audit (
    id         bigserial PRIMARY KEY,
    actor      text NOT NULL,
    action     text NOT NULL,
    target     text NOT NULL,
    detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_audit_created_idx ON labspace.account_audit (created_at DESC);

-- ---------------------------------------------------------------- 个人工作台
CREATE TABLE IF NOT EXISTS labspace.workbench_items (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    kind        text NOT NULL DEFAULT 'note',
    title       text NOT NULL,
    content     text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'active',
    priority    text NOT NULL DEFAULT 'normal',
    tags        text[] NOT NULL DEFAULT '{}',
    project_id  text,
    plan_id     text,
    due_date    date,
    source      text NOT NULL DEFAULT 'manual',
    ai_class    text,
    ai_reason   text,
    confidence  double precision,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_items_user_idx ON labspace.workbench_items (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.workbench_projects (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'active',
    health      text NOT NULL DEFAULT 'on_track',
    progress    integer NOT NULL DEFAULT 0,
    next_step   text NOT NULL DEFAULT '',
    due_date    date,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_projects_user_idx ON labspace.workbench_projects (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.workbench_plans (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    kind        text NOT NULL DEFAULT 'direction',
    title       text NOT NULL,
    outcome     text NOT NULL DEFAULT '',
    metrics     text NOT NULL DEFAULT '',
    horizon     text NOT NULL DEFAULT '',
    progress    integer NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'active',
    next_step   text NOT NULL DEFAULT '',
    due_date    date,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_plans_user_idx ON labspace.workbench_plans (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.workbench_briefs (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    brief_date  date NOT NULL,
    content     text NOT NULL DEFAULT '',
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, brief_date)
);

-- 导师指派：一条记录只对创建者（导师）与被指派人可见（ACL 在 API 层强制）。
CREATE TABLE IF NOT EXISTS labspace.workbench_assignments (
    id             text PRIMARY KEY,
    creator_id     text NOT NULL,
    creator_name   text NOT NULL DEFAULT '',
    assignee_id    text NOT NULL,
    assignee_name  text NOT NULL DEFAULT '',
    kind           text NOT NULL DEFAULT 'task',
    title          text NOT NULL,
    content        text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'assigned',
    priority       text NOT NULL DEFAULT 'normal',
    due_date       date,
    feedback       text NOT NULL DEFAULT '',
    submitted_at   timestamptz,
    reviewed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_assignments_assignee_idx
    ON labspace.workbench_assignments (assignee_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS workbench_assignments_creator_idx
    ON labspace.workbench_assignments (creator_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.workbench_assignment_submissions (
    id            text PRIMARY KEY,
    assignment_id text NOT NULL,
    author_id     text NOT NULL,
    content       text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_submissions_assignment_idx
    ON labspace.workbench_assignment_submissions (assignment_id, created_at DESC);
-- 附件存 PostgreSQL bytea：只经带 ACL 的下载接口流出，不落共享文件目录。
CREATE TABLE IF NOT EXISTS labspace.workbench_assignment_files (
    id            text PRIMARY KEY,
    assignment_id text NOT NULL,
    submission_id text,
    uploader_id   text NOT NULL,
    purpose       text NOT NULL DEFAULT 'brief',
    filename      text NOT NULL,
    content_type  text NOT NULL DEFAULT 'application/octet-stream',
    size_bytes    bigint NOT NULL DEFAULT 0,
    data          bytea NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_assignment_files_idx
    ON labspace.workbench_assignment_files (assignment_id, created_at);

-- 实习生绑定：把低年级成员挂到一位高年级导师名下，便于任务编排与提醒。
CREATE TABLE IF NOT EXISTS labspace.workbench_mentors (
    user_id    text PRIMARY KEY,
    mentor_id  text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workbench_mentors_mentor_idx
    ON labspace.workbench_mentors (mentor_id);

-- ---------------------------------------------------------------- 知识库
-- 知识库（空间）是文档的顶层容器；分类仍是空间内的文件夹路径（如 项目/2026）。
CREATE TABLE IF NOT EXISTS labspace.knowledge_spaces (
    id          bigserial PRIMARY KEY,
    owner       text NOT NULL,
    owner_name  text NOT NULL DEFAULT '',
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    visibility  text NOT NULL DEFAULT 'private',
    roles       text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner, name)
);
CREATE INDEX IF NOT EXISTS knowledge_spaces_owner_idx ON labspace.knowledge_spaces (owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS labspace.knowledge_docs (
    id          bigserial PRIMARY KEY,
    owner       text NOT NULL,
    owner_name  text NOT NULL DEFAULT '',
    title       text NOT NULL,
    body        text NOT NULL DEFAULT '',
    tags        text[] NOT NULL DEFAULT '{}',
    visibility  text NOT NULL DEFAULT 'private',
    roles       text[] NOT NULL DEFAULT '{}',
    source      text NOT NULL DEFAULT 'manual',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- 分类与文件回链：category 是用户自建的分组；file_* 记录从文件管理入库的来源，
-- 这样知识条目能跳回原文件，重新入库时也能按同一文件覆盖而不是堆重复条目。
ALTER TABLE labspace.knowledge_docs ADD COLUMN IF NOT EXISTS category      text NOT NULL DEFAULT '';
ALTER TABLE labspace.knowledge_docs ADD COLUMN IF NOT EXISTS file_source   text NOT NULL DEFAULT '';
ALTER TABLE labspace.knowledge_docs ADD COLUMN IF NOT EXISTS file_path     text NOT NULL DEFAULT '';
ALTER TABLE labspace.knowledge_docs ADD COLUMN IF NOT EXISTS file_bytes    bigint NOT NULL DEFAULT 0;
ALTER TABLE labspace.knowledge_docs ADD COLUMN IF NOT EXISTS file_modified timestamptz;
ALTER TABLE labspace.knowledge_docs ADD COLUMN IF NOT EXISTS space_id      bigint;
CREATE INDEX IF NOT EXISTS knowledge_docs_space_idx ON labspace.knowledge_docs (space_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_docs_file_link_idx
    ON labspace.knowledge_docs (owner, file_source, file_path) WHERE file_path <> '';
CREATE INDEX IF NOT EXISTS knowledge_docs_owner_idx ON labspace.knowledge_docs (owner, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_docs_updated_idx ON labspace.knowledge_docs (updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_docs_category_idx ON labspace.knowledge_docs (category, updated_at DESC);

-- ---------------------------------------------------------------- Agent 助手
CREATE TABLE IF NOT EXISTS labspace.agent_sessions (
    id            text PRIMARY KEY,
    user_id       text NOT NULL,
    title         text NOT NULL DEFAULT '新会话',
    model         text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'idle',
    message_count integer NOT NULL DEFAULT 0,
    tokens_in     integer NOT NULL DEFAULT 0,
    tokens_out    integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_sessions_user_idx ON labspace.agent_sessions (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.agent_messages (
    id         text PRIMARY KEY,
    session_id text NOT NULL,
    user_id    text NOT NULL,
    role       text NOT NULL,
    content    text NOT NULL DEFAULT '',
    meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_session_idx ON labspace.agent_messages (session_id, created_at);
CREATE TABLE IF NOT EXISTS labspace.agent_memories (
    id             text PRIMARY KEY,
    user_id        text NOT NULL,
    kind           text NOT NULL DEFAULT 'fact',
    title          text NOT NULL DEFAULT '',
    content        text NOT NULL DEFAULT '',
    source_session text NOT NULL DEFAULT '',
    pinned         boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_memories_user_idx ON labspace.agent_memories (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.account_security (
    name        text PRIMARY KEY,
    must_change boolean NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_security_must_idx ON labspace.account_security (must_change) WHERE must_change;

CREATE TABLE IF NOT EXISTS labspace.agent_config (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS labspace.session_revocation (
    subject    text PRIMARY KEY,
    revoked_at timestamptz NOT NULL DEFAULT now(),
    reason     text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS labspace.integration_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS labspace.baserow_accounts (
    email      text PRIMARY KEY,
    secret     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- 实验室延伸功能
CREATE TABLE IF NOT EXISTS labspace.labops_eln_templates (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
    builtin     boolean NOT NULL DEFAULT false,
    owner       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS labspace.labops_eln_entries (
    id          text PRIMARY KEY,
    owner       text NOT NULL,
    template_id text,
    title       text NOT NULL,
    content     jsonb NOT NULL DEFAULT '{}'::jsonb,
    tags        text[] NOT NULL DEFAULT '{}',
    status      text NOT NULL DEFAULT 'draft',
    links       jsonb NOT NULL DEFAULT '{}'::jsonb,
    entry_date  date NOT NULL DEFAULT current_date,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labops_eln_owner_idx ON labspace.labops_eln_entries (owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS labspace.labops_inventory_items (
    id            text PRIMARY KEY,
    owner         text NOT NULL,
    kind          text NOT NULL DEFAULT 'sample',
    name          text NOT NULL,
    code          text NOT NULL UNIQUE,
    location      text NOT NULL DEFAULT '',
    quantity      numeric NOT NULL DEFAULT 0,
    unit          text NOT NULL DEFAULT '份',
    low_threshold numeric NOT NULL DEFAULT 0,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    notes         text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labops_inventory_kind_idx ON labspace.labops_inventory_items (kind, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.labops_inventory_tx (
    id         bigserial PRIMARY KEY,
    item_id    text NOT NULL,
    owner      text NOT NULL,
    delta      numeric NOT NULL,
    kind       text NOT NULL DEFAULT 'out',
    reason     text NOT NULL DEFAULT '',
    operator   text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labops_inventory_tx_item_idx ON labspace.labops_inventory_tx (item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS labspace.labops_pipeline_jobs (
    id          text PRIMARY KEY,
    owner       text NOT NULL,
    pipeline    text NOT NULL,
    name        text NOT NULL,
    params      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status      text NOT NULL DEFAULT 'queued',
    progress    int NOT NULL DEFAULT 0,
    message     text NOT NULL DEFAULT '',
    outputs     jsonb NOT NULL DEFAULT '[]'::jsonb,
    workdir     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS labops_pipeline_owner_idx ON labspace.labops_pipeline_jobs (owner, created_at DESC);

CREATE TABLE IF NOT EXISTS labspace.labops_literature (
    id          text PRIMARY KEY,
    owner       text NOT NULL,
    doi         text NOT NULL DEFAULT '',
    title       text NOT NULL,
    authors     text NOT NULL DEFAULT '',
    journal     text NOT NULL DEFAULT '',
    pub_year    text NOT NULL DEFAULT '',
    abstract    text NOT NULL DEFAULT '',
    url         text NOT NULL DEFAULT '',
    tags        text[] NOT NULL DEFAULT '{}',
    notes       text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'unread',
    embedding   vector,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labops_literature_owner_idx ON labspace.labops_literature (owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS labspace.labops_resources (
    id          text PRIMARY KEY,
    owner       text NOT NULL,
    kind        text NOT NULL DEFAULT 'instrument',
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    location    text NOT NULL DEFAULT '',
    capacity    int NOT NULL DEFAULT 1,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS labspace.labops_bookings (
    id          text PRIMARY KEY,
    resource_id text NOT NULL,
    owner       text NOT NULL,
    start_at    timestamptz NOT NULL,
    end_at      timestamptz NOT NULL,
    purpose     text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'pending',
    approver    text,
    feedback    text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS labops_bookings_slot_idx ON labspace.labops_bookings (resource_id, start_at, end_at);
CREATE TABLE IF NOT EXISTS labspace.labops_supply_requests (
    id          text PRIMARY KEY,
    item_id     text NOT NULL,
    owner       text NOT NULL,
    quantity    numeric NOT NULL DEFAULT 1,
    reason      text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'pending',
    approver    text,
    feedback    text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS labops_supply_status_idx ON labspace.labops_supply_requests (status, created_at DESC);

-- ---------------------------------------------------------------- LaTeX 写作与投稿
CREATE TABLE IF NOT EXISTS labspace.latex_documents (
    id               text PRIMARY KEY,
    owner            text NOT NULL,
    title            text NOT NULL DEFAULT '未命名文稿',
    kind             text NOT NULL DEFAULT 'article',
    venue            text NOT NULL DEFAULT '',
    authors          text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'draft',
    abstract         text NOT NULL DEFAULT '',
    keywords         text[] NOT NULL DEFAULT '{}',
    content          text NOT NULL DEFAULT '',
    project_id       text,
    knowledge_doc_id bigint,
    due_date         date,
    compiled_at      timestamptz,
    compile_ok       boolean,
    compile_log      text NOT NULL DEFAULT '',
    pdf_bytes        integer NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latex_documents_owner_idx ON labspace.latex_documents (owner, updated_at DESC);
CREATE TABLE IF NOT EXISTS labspace.latex_events (
    id         bigserial PRIMARY KEY,
    doc_id     text NOT NULL,
    owner      text NOT NULL,
    kind       text NOT NULL DEFAULT 'status',
    note       text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latex_events_doc_idx ON labspace.latex_events (doc_id, created_at DESC);

-- 上下审稿：批注（挂行号）、回复与状态流转（open / accepted / rejected）
CREATE TABLE IF NOT EXISTS labspace.latex_reviews (
    id         text PRIMARY KEY,
    doc_id     text NOT NULL,
    owner      text NOT NULL,
    author     text NOT NULL DEFAULT '',
    line_from  integer NOT NULL DEFAULT 1,
    line_to    integer NOT NULL DEFAULT 1,
    quote      text NOT NULL DEFAULT '',
    comment    text NOT NULL DEFAULT '',
    status     text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latex_reviews_doc_idx ON labspace.latex_reviews (doc_id, created_at DESC);
CREATE TABLE IF NOT EXISTS labspace.latex_review_replies (
    id         text PRIMARY KEY,
    review_id  text NOT NULL,
    owner      text NOT NULL,
    author     text NOT NULL DEFAULT '',
    content    text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latex_review_replies_review_idx
    ON labspace.latex_review_replies (review_id, created_at);

-- 版本快照：保存 / 编译时把源码存一份，供「版本对比」做行级 diff
CREATE TABLE IF NOT EXISTS labspace.latex_versions (
    id         bigserial PRIMARY KEY,
    event_id   bigint NOT NULL,
    doc_id     text NOT NULL,
    owner      text NOT NULL,
    content    text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latex_versions_event_idx ON labspace.latex_versions (event_id);
CREATE INDEX IF NOT EXISTS latex_versions_doc_idx ON labspace.latex_versions (doc_id, created_at DESC);

-- ---------------------------------------------------------------- 每日论文
-- 「每日论文」按 (天, 人, 主题) 聚合文献源结果：一行一篇，source 记录真实来源
-- （openalex / semanticscholar / crossref / arxiv）；拿不到的字段一律留空，不填占位符。
CREATE TABLE IF NOT EXISTS labspace.daily_papers (
    day        date NOT NULL,
    owner      text NOT NULL,
    topic      text NOT NULL,
    doi        text NOT NULL DEFAULT '',
    title      text NOT NULL,
    authors    text NOT NULL DEFAULT '',
    venue      text NOT NULL DEFAULT '',
    year       int,
    abstract   text NOT NULL DEFAULT '',
    url        text NOT NULL DEFAULT '',
    pdf_url    text NOT NULL DEFAULT '',
    citations  int,
    source     text NOT NULL DEFAULT '',
    score      real,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, owner, topic, doi, title)
);
CREATE INDEX IF NOT EXISTS daily_papers_owner_day_idx
    ON labspace.daily_papers (owner, day DESC, topic);

-- 「每日论文」自主订阅：每人每个主题一条，开启后由每日维护自动抓取。
-- 只存"订阅意图"（主题/数量/是否启用），论文本身仍在 daily_papers 里按日落库，
-- 这样订阅改了不用回填历史数据。
CREATE TABLE IF NOT EXISTS labspace.daily_paper_subs (
    owner      text NOT NULL,
    topic      text NOT NULL,
    limit_n    int NOT NULL DEFAULT 10,
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_run   timestamptz,
    last_count int NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT '',
    PRIMARY KEY (owner, topic)
);

-- ---------------------------------------------------------------- 文献库（多库 + 文件夹）
-- 文献库：每个用户至少有一个 is_default 的默认库，文献按 library_id 归属。
CREATE TABLE IF NOT EXISTS labspace.literature_library (
    id          text PRIMARY KEY,
    owner       text NOT NULL,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    color       text NOT NULL DEFAULT '',
    is_default  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS literature_library_owner_idx
    ON labspace.literature_library (owner, created_at);

-- 文件夹：挂在某个文献库下，parent_id='' 表示库根目录。
CREATE TABLE IF NOT EXISTS labspace.literature_folder (
    id         text PRIMARY KEY,
    owner      text NOT NULL,
    library_id text NOT NULL DEFAULT '',
    parent_id  text NOT NULL DEFAULT '',
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS literature_folder_owner_idx
    ON labspace.literature_folder (owner, library_id);

-- 历史文献没有库/文件夹概念，用空串表示"默认库 / 未分类"，无需回填迁移。
ALTER TABLE labspace.labops_literature ADD COLUMN IF NOT EXISTS library_id text NOT NULL DEFAULT '';
ALTER TABLE labspace.labops_literature ADD COLUMN IF NOT EXISTS folder_id text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS labops_literature_library_idx
    ON labspace.labops_literature (owner, library_id, folder_id);

-- ---------------------------------------------------------------- LaTeX 编译素材
-- 编译素材（.cls / .sty / 图片等）：编译时随源码一起进沙箱。
-- 只存二进制与元信息，不进版本快照（版本快照只存源码）。
CREATE TABLE IF NOT EXISTS labspace.latex_assets (
    id           text PRIMARY KEY,
    doc_id       text NOT NULL,
    owner        text NOT NULL,
    name         text NOT NULL,
    bytes        integer NOT NULL DEFAULT 0,
    content_type text NOT NULL DEFAULT 'application/octet-stream',
    data         bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latex_assets_doc_idx
    ON labspace.latex_assets (doc_id, created_at);

-- ---------------------------------------------------------------- 组会汇报
-- 组会周目录（ISO 周，如 2026-W48）的授权名单。
-- 名单决定"谁能看见 / 管理某周目录"，文件核心的 ACL 决定"放行谁的读写"，
-- 两处都要写；这里存的是门户侧的名单。
CREATE TABLE IF NOT EXISTS labspace.meeting_week_grants (
    year_week  text NOT NULL,
    user_id    text NOT NULL,
    granted_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (year_week, user_id)
);
CREATE INDEX IF NOT EXISTS meeting_week_grants_user_idx ON labspace.meeting_week_grants (user_id);

-- 周目录的压缩状态（压缩由文件核心执行，这里只记录结果供界面展示）。
CREATE TABLE IF NOT EXISTS labspace.meeting_week_state (
    year_week     text PRIMARY KEY,
    compressed    boolean NOT NULL DEFAULT false,
    compressed_at timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- 导师-组员共享
-- 组员名册（v26.11）：每位组员固定 01_组会汇报 / 02_论文 / 03_其他 三个目录，
-- 目录与授权由文件核心落地，这里只存名册（学号、姓名、门户账号）。
CREATE TABLE IF NOT EXISTS labspace.lab_roster (
    id         bigserial PRIMARY KEY,
    advisor    text NOT NULL,
    code       text NOT NULL,
    name       text NOT NULL,
    status     text NOT NULL DEFAULT '在研',
    account    text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (advisor, code, name)
);
CREATE INDEX IF NOT EXISTS lab_roster_advisor_idx ON labspace.lab_roster (advisor);

-- identity（身份：博士后/博士生/硕士生/本科生/实习生/科研助理）是后加的需求。
-- CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，所以这里显式 ALTER（幂等）。
ALTER TABLE labspace.lab_roster ADD COLUMN IF NOT EXISTS identity text NOT NULL DEFAULT '硕士生';

-- 工作台待办挂到具体文件（link_source + link_path）。
-- 待办与文件存储原本是两个独立世界：待办写"整理这批测序数据"，
-- 用户还得自己去文件存储里找那个目录。加两列让它能直接指过去。
-- 存 source+path 而不是文件 id：id 会随重新扫描变化，路径是稳定的。
ALTER TABLE labspace.workbench_items ADD COLUMN IF NOT EXISTS link_source text NOT NULL DEFAULT '';
ALTER TABLE labspace.workbench_items ADD COLUMN IF NOT EXISTS link_path   text NOT NULL DEFAULT '';
"""


def get_pool() -> pgpool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                _pool = pgpool.ThreadedConnectionPool(1, 8, dsn=settings.db_dsn)
                conn = _pool.getconn()
                try:
                    with conn.cursor() as cur:
                        # SAFETY: SCHEMA 是本模块顶部的**编译期常量**（CREATE TABLE /
                        # CREATE INDEX 等固定 DDL 拼接），不接受任何运行期输入，
                        # 因此这里不存在参数化的可能，也不存在注入面。
                        # 需要变动的表结构改动直接改常量，不要改成拼接变量。
                        cur.execute(SCHEMA)
                    conn.commit()
                finally:
                    _pool.putconn(conn)
    return _pool


def query(statement: Any, params: tuple = ()) -> list[dict[str, Any]]:
    """执行一条查询。

    ``statement`` 允许传 ``psycopg2.sql.Composed``：表名/列名这类标识符不能
    用占位符传，必须由驱动做转义后拼接。普通 SQL 仍然照常写字符串。
    """
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # SAFETY: statement 是字面量或 psycopg2.sql.Composed（编译期常量），
            # 值一律在 params 里由驱动转义；分析器只看到变量就报注入，是误报。
            cur.execute(statement, params)  # noqa: S608, python-sql-injection
            rows = cur.fetchall()
            conn.commit()
            return [dict(r) for r in rows]
    finally:
        pool.putconn(conn)


def query_many(statements: list[tuple[str, tuple]]) -> list[list[dict[str, Any]]]:
    """在**单条连接**上依次执行多条查询，返回与入参同序的结果列表。

    背景：连接池上限为 8，如果像工作台首页那样把 12 条查询丢进
    asyncio.gather（每条都经 to_thread 独占一条连接），会直接触发
    psycopg2 的 PoolError: connection pool exhausted。
    批量查询只占一条连接，把 12 次往返压成 1 次线程调度。
    """
    pool = get_pool()
    conn = pool.getconn()
    try:
        out: list[list[dict[str, Any]]] = []
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            for sql, params in statements:
                cur.execute(sql, params)
                out.append([dict(r) for r in cur.fetchall()])
        conn.commit()
        return out
    finally:
        pool.putconn(conn)


def execute(sql: str, params: tuple = ()) -> None:
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
        conn.commit()
    finally:
        pool.putconn(conn)


# 会话吊销：门户会话是无状态 HS256 JWT，只校验签名与 exp，因此"禁用/删除账号"
# 本身不会让已经发出的 Cookie 失效。这张表是唯一的失效手段：早于 revoked_at
# 签发的会话一律作废。
_revocation_cache: dict[str, tuple[float, int | None]] = {}
_revocation_lock = threading.Lock()
REVOCATION_TTL = 15.0


def revoke_sessions(subject: str, reason: str = "") -> None:
    execute(
        """
        INSERT INTO labspace.session_revocation (subject, revoked_at, reason)
        VALUES (%s, now(), %s)
        ON CONFLICT (subject) DO UPDATE
          SET revoked_at = greatest(labspace.session_revocation.revoked_at, now()),
              reason = EXCLUDED.reason
        """,
        (subject, reason),
    )
    with _revocation_lock:
        _revocation_cache.pop(subject, None)


def revoked_before(subject: str) -> int | None:
    """返回该主体会话的失效时刻（Unix 秒）；None 表示没有吊销记录。

    查询失败按"未吊销"处理并记日志：数据库抖动不应该把整个实验室踢下线。
    """
    now = time.monotonic()
    with _revocation_lock:
        hit = _revocation_cache.get(subject)
        if hit and now - hit[0] < REVOCATION_TTL:
            return hit[1]
    try:
        rows = query(
            "SELECT extract(epoch FROM revoked_at)::bigint AS at"
            " FROM labspace.session_revocation WHERE subject = %s",
            (subject,),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("session revocation lookup failed for %s: %s (session accepted)", subject, exc)
        return None
    at = int(rows[0]["at"]) if rows else None
    with _revocation_lock:
        _revocation_cache[subject] = (now, at)
    return at


def list_favorites(user_id: str) -> list[str]:
    return [r["service_id"] for r in query("SELECT service_id FROM labspace.favorites WHERE user_id=%s ORDER BY created_at", (user_id,))]


def add_favorite(user_id: str, service_id: str) -> None:
    execute(
        "INSERT INTO labspace.favorites (user_id, service_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
        (user_id, service_id),
    )


def remove_favorite(user_id: str, service_id: str) -> None:
    execute("DELETE FROM labspace.favorites WHERE user_id=%s AND service_id=%s", (user_id, service_id))


def touch_recent(user_id: str, service_id: str, keep: int = 12) -> None:
    execute(
        """
        INSERT INTO labspace.recent (user_id, service_id, visited_at) VALUES (%s,%s, now())
        ON CONFLICT (user_id, service_id) DO UPDATE SET visited_at = now()
        """,
        (user_id, service_id),
    )
    execute(
        """
        DELETE FROM labspace.recent WHERE user_id=%s AND service_id NOT IN (
            SELECT service_id FROM labspace.recent WHERE user_id=%s ORDER BY visited_at DESC LIMIT %s
        )
        """,
        (user_id, user_id, keep),
    )


def list_recent(user_id: str, limit: int = 12) -> list[str]:
    return [
        r["service_id"]
        for r in query(
            "SELECT service_id FROM labspace.recent WHERE user_id=%s ORDER BY visited_at DESC LIMIT %s",
            (user_id, limit),
        )
    ]


def save_drawing(user_id: str, name: str, content: str) -> dict[str, Any]:
    import uuid

    did = str(uuid.uuid4())
    execute(
        """
        INSERT INTO labspace.drawings (id, user_id, name, content, size)
        VALUES (%s,%s,%s,%s,%s)
        """,
        (did, user_id, name, content, len(content.encode())),
    )
    return {"id": did, "name": name}


def list_drawings(user_id: str) -> list[dict[str, Any]]:
    return query(
        "SELECT id, name, size, updated_at FROM labspace.drawings WHERE user_id=%s ORDER BY updated_at DESC",
        (user_id,),
    )


def get_drawing(user_id: str, drawing_id: str) -> dict[str, Any] | None:
    rows = query(
        "SELECT id, name, content, size, updated_at FROM labspace.drawings WHERE id=%s AND user_id=%s",
        (drawing_id, user_id),
    )
    return rows[0] if rows else None


def delete_drawing(user_id: str, drawing_id: str) -> None:
    execute("DELETE FROM labspace.drawings WHERE id=%s AND user_id=%s", (drawing_id, user_id))


def rename_drawing(user_id: str, drawing_id: str, name: str) -> None:
    execute("UPDATE labspace.drawings SET name=%s, updated_at=now() WHERE id=%s AND user_id=%s", (name, drawing_id, user_id))


def update_drawing(user_id: str, drawing_id: str, name: str, content: str) -> None:
    execute(
        "UPDATE labspace.drawings SET name=%s, content=%s, size=%s, updated_at=now() WHERE id=%s AND user_id=%s",
        (name, content, len(content.encode()), drawing_id, user_id),
    )


# ---------------------------------------------------------------- 公告

def list_announcements() -> list[dict[str, Any]]:
    return query(
        "SELECT id, title, content, level, author, created_at, expires_at FROM labspace.announcements "
        "WHERE (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 20"
    )


def add_announcement(title: str, content: str, level: str, author: str) -> dict[str, Any]:
    import uuid

    aid = str(uuid.uuid4())
    execute(
        "INSERT INTO labspace.announcements (id, title, content, level, author) VALUES (%s,%s,%s,%s,%s)",
        (aid, title, content, level, author),
    )
    rows = query("SELECT id, title, content, level, author, created_at FROM labspace.announcements WHERE id=%s", (aid,))
    return rows[0] if rows else {"id": aid}


def delete_announcement(aid: str) -> None:
    execute("DELETE FROM labspace.announcements WHERE id=%s", (aid,))
