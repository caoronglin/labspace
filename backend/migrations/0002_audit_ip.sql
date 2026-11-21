-- 审计表补客户端 IP。
-- 没有 IP 的审计日志回答不了「是谁从哪台机器改的」；出问题时这是第一个要看的字段。
-- 用空串默认值而不是 NULL：老代码路径（还没接审计埋点的地方）不会因此报错。
ALTER TABLE labspace.account_audit ADD COLUMN IF NOT EXISTS ip text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS account_audit_actor_idx ON labspace.account_audit (actor, created_at DESC);
