package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type organization struct {
	id        string
	createdAt time.Time
	updatedAt time.Time
	name      string
	slug      string
	members   []string
}

const organizationColumns = "id, created_at, updated_at, name, slug"

// membersColumn is the member ids of each organization row, in position order ('{}' when it has none).
const membersColumn = ", ARRAY(SELECT m.target_id FROM organizations__members m WHERE m.owner_id = o.id ORDER BY m.position)"

func (o *organization) scan(row pgx.Row, withMembers bool) error {
	if withMembers {
		return row.Scan(&o.id, &o.createdAt, &o.updatedAt, &o.name, &o.slug, &o.members)
	}
	return row.Scan(&o.id, &o.createdAt, &o.updatedAt, &o.name, &o.slug)
}

// appendOrganization writes the record; with populated set, members are the full user records in position order
// (ids whose user no longer exists are left out).
func appendOrganization(b []byte, o *organization, mask uint, populated map[string]*user) []byte {
	b = append(b, '{')
	first := true
	if mask&orgID != 0 {
		b = appendKey(b, &first, "id")
		b = appendString(b, o.id)
	}
	if mask&orgCreatedAt != 0 {
		b = appendKey(b, &first, "createdAt")
		b = appendTime(b, o.createdAt)
	}
	if mask&orgUpdatedAt != 0 {
		b = appendKey(b, &first, "updatedAt")
		b = appendTime(b, o.updatedAt)
	}
	if mask&orgName != 0 {
		b = appendKey(b, &first, "name")
		b = appendString(b, o.name)
	}
	if mask&orgSlug != 0 {
		b = appendKey(b, &first, "slug")
		b = appendString(b, o.slug)
	}
	if mask&orgMembers != 0 {
		b = appendKey(b, &first, "members")
		b = append(b, '[')
		n := 0
		for _, id := range o.members {
			if populated != nil {
				u := populated[id]
				if u == nil {
					continue
				}
				if n > 0 {
					b = append(b, ',')
				}
				b = appendUser(b, u, usersEntity.allFields())
			} else {
				if n > 0 {
					b = append(b, ',')
				}
				b = appendString(b, id)
			}
			n++
		}
		b = append(b, ']')
	}
	return append(b, '}')
}

// loadMembers reads the users referenced by the organizations with one query.
func (a *app) loadMembers(ctx context.Context, organizations []organization) (map[string]*user, error) {
	var ids []string
	for i := range organizations {
		ids = append(ids, organizations[i].members...)
	}
	users := make(map[string]*user, len(ids))
	if len(ids) == 0 {
		return users, nil
	}
	rows, err := a.db.Query(ctx, "SELECT "+userColumns+" FROM users WHERE id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]user, 0, len(ids))
	for rows.Next() {
		list = append(list, user{})
		if err := list[len(list)-1].scan(rows); err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range list {
		users[list[i].id] = &list[i]
	}
	return users, nil
}

func (a *app) listOrganizations(w http.ResponseWriter, r *http.Request) {
	params := parseParams(r.URL.RawQuery)
	sel, apiErr := parseSelection(organizationsEntity, params)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	q, details := parseListQuery(organizationsEntity, params)
	if details != nil {
		invalidQuery(w, details)
		return
	}
	withMembers := sel.mask&orgMembers != 0
	columns := organizationColumns
	if withMembers {
		columns += membersColumn
	}
	pageSQL, pageArgs := q.page()
	batch := &pgx.Batch{}
	batch.Queue("SELECT count(*) FROM organizations"+q.where, q.args...)
	batch.Queue("SELECT "+columns+" FROM organizations o"+q.where+" ORDER BY "+q.orderBy+pageSQL, pageArgs...)
	results := a.db.SendBatch(r.Context(), batch)

	var total int64
	organizations := make([]organization, 0, q.limit)
	err := results.QueryRow().Scan(&total)
	if err == nil {
		var rows pgx.Rows
		if rows, err = results.Query(); err == nil {
			for rows.Next() {
				organizations = append(organizations, organization{})
				if err = organizations[len(organizations)-1].scan(rows, withMembers); err != nil {
					break
				}
			}
			rows.Close()
			if err == nil {
				err = rows.Err()
			}
		}
	}
	if closeErr := results.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		internalError(w, err)
		return
	}

	var populated map[string]*user
	if sel.populate && withMembers {
		if populated, err = a.loadMembers(r.Context(), organizations); err != nil {
			internalError(w, err)
			return
		}
	}
	buf := getBuffer()
	defer putBuffer(buf)
	*buf = appendPage(*buf, total, &q, func(b []byte) []byte {
		for i := range organizations {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendOrganization(b, &organizations[i], sel.mask, populated)
		}
		return b
	})
	writeJSON(w, http.StatusOK, *buf)
}

func organizationNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "Organization not found", nil)
}

func (a *app) getOrganization(w http.ResponseWriter, r *http.Request) {
	sel, apiErr := parseSelection(organizationsEntity, parseParams(r.URL.RawQuery))
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	withMembers := sel.mask&orgMembers != 0
	columns := organizationColumns
	if withMembers {
		columns += membersColumn
	}
	var o organization
	err := o.scan(a.db.QueryRow(r.Context(), "SELECT "+columns+" FROM organizations o WHERE id = $1", r.PathValue("id")), withMembers)
	if errors.Is(err, pgx.ErrNoRows) {
		organizationNotFound(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	var populated map[string]*user
	if sel.populate && withMembers {
		if populated, err = a.loadMembers(r.Context(), []organization{o}); err != nil {
			internalError(w, err)
			return
		}
	}
	buf := getBuffer()
	defer putBuffer(buf)
	*buf = appendOrganization(*buf, &o, sel.mask, populated)
	writeJSON(w, http.StatusOK, *buf)
}

// statsSQL counts members and admins and averages the non-null ages; no row means no such organization.
const statsSQL = `SELECT count(u.id), count(*) FILTER (WHERE u.role = 'admin'), avg(u.age)
FROM organizations o
LEFT JOIN organizations__members m ON m.owner_id = o.id
LEFT JOIN users u ON u.id = m.target_id
WHERE o.id = $1
GROUP BY o.id`

func (a *app) organizationStats(w http.ResponseWriter, r *http.Request) {
	var members, admins int64
	var average pgtype.Float8
	err := a.db.QueryRow(r.Context(), statsSQL, r.PathValue("id")).Scan(&members, &admins, &average)
	if errors.Is(err, pgx.ErrNoRows) {
		organizationNotFound(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	buf := getBuffer()
	defer putBuffer(buf)
	b := append(*buf, `{"members":`...)
	b = appendNumber(b, float64(members))
	b = append(b, `,"admins":`...)
	b = appendNumber(b, float64(admins))
	b = append(b, `,"averageAge":`...)
	if average.Valid {
		b = appendNumber(b, average.Float64)
	} else {
		b = append(b, "null"...)
	}
	*buf = append(b, '}')
	writeJSON(w, http.StatusOK, *buf)
}
