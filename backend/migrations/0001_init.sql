-- LabSpace 门户库初始结构（由 app/db.py 的 SCHEMA 常量迁出）。
-- 约定：文件名 NNNN_描述.sql，按文件名顺序执行，执行过的记在 labspace.schema_migrations。
-- 只追加、不改历史文件：已经跑过的迁移在别的机器上任然要能重放。

-- 说明：规格书里把这四张表列作「可能已废弃」——
--   labspace.agent_sessions / agent_messages / knowledge_docs / knowledge_spaces
-- 实测仍在用（后端 17/13/20/9 处读写引用，Agent 会话与知识库都靠它们），
-- 因此本次迁移**原样保留**，不做删除或改名；真要下线时另开迁移 + 数据迁移。

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
