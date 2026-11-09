package policy

import (
	"context"
	"database/sql"
	"errors"
)

// SQLPolicy is a production storage adapter. The caller supplies a pgx/libpq
// compatible *sql.DB and the migrations in db/006_labgo_core.sql.
// No Postgres driver is vendored. Use transactions for rule mutations elsewhere.
type SQLPolicy struct{ DB *sql.DB }

const effectiveACLQuery = `
WITH RECURSIVE chain AS (
 SELECT id, parent_id, tenant_id, 1 depth
 FROM labnext.go_resources
 WHERE tenant_id = $1 AND id = $3
 UNION ALL
 SELECT p.id, p.parent_id, p.tenant_id, chain.depth + 1
 FROM labnext.go_resources p
 JOIN chain ON p.id = chain.parent_id AND p.tenant_id = chain.tenant_id
 WHERE chain.depth < 64
), scoped AS (
 SELECT e.effect
 FROM chain
 JOIN labnext.go_acl e ON e.tenant_id = chain.tenant_id AND e.resource_id = chain.id
 WHERE e.action = $4 AND (
   e.subject_kind = 'everyone'
   OR (e.subject_kind = 'user' AND e.subject_id = $2)
   OR (e.subject_kind = 'group' AND EXISTS (
      SELECT 1 FROM labnext.go_group_members m
      WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.group_id = e.subject_id
   ))
 )
)
SELECT COALESCE(bool_or(effect = 'deny'), false),
       COALESCE(bool_or(effect = 'allow'), false)
FROM scoped
`

func (p SQLPolicy) Can(ctx context.Context, tenant, user, resource, action string) (bool, error) {
	if p.DB == nil {
		return false, errors.New("PostgreSQL ACL is unavailable")
	}
	if tenant == "" || user == "" || resource == "" || action == "" {
		return false, nil
	}
	var denied, allowed bool
	err := p.DB.QueryRowContext(ctx, effectiveACLQuery, tenant, user, resource, action).Scan(&denied, &allowed)
	if err != nil {
		return false, err
	}
	return allowed && !denied, nil
}
