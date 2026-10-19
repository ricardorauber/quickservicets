package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

type user struct {
	id        string
	createdAt time.Time
	updatedAt time.Time
	email     string
	name      string
	role      string
	age       pgtype.Float8
}

const userColumns = "id, created_at, updated_at, email, name, role, age"

func (u *user) scan(row pgx.Row) error {
	return row.Scan(&u.id, &u.createdAt, &u.updatedAt, &u.email, &u.name, &u.role, &u.age)
}

func appendUser(b []byte, u *user, mask uint) []byte {
	b = append(b, '{')
	first := true
	if mask&userID != 0 {
		b = appendKey(b, &first, "id")
		b = appendString(b, u.id)
	}
	if mask&userCreatedAt != 0 {
		b = appendKey(b, &first, "createdAt")
		b = appendTime(b, u.createdAt)
	}
	if mask&userUpdatedAt != 0 {
		b = appendKey(b, &first, "updatedAt")
		b = appendTime(b, u.updatedAt)
	}
	if mask&userEmail != 0 {
		b = appendKey(b, &first, "email")
		b = appendString(b, u.email)
	}
	if mask&userName != 0 {
		b = appendKey(b, &first, "name")
		b = appendString(b, u.name)
	}
	if mask&userRole != 0 {
		b = appendKey(b, &first, "role")
		b = appendString(b, u.role)
	}
	if mask&userAge != 0 {
		b = appendKey(b, &first, "age")
		if u.age.Valid {
			b = appendNumber(b, u.age.Float64)
		} else {
			b = append(b, "null"...)
		}
	}
	return append(b, '}')
}

func writeUser(w http.ResponseWriter, status int, u *user, mask uint) {
	buf := getBuffer()
	defer putBuffer(buf)
	*buf = appendUser(*buf, u, mask)
	writeJSON(w, status, *buf)
}

func userNotFound(w http.ResponseWriter) { writeError(w, http.StatusNotFound, "User not found", nil) }

func emailTaken(w http.ResponseWriter) {
	writeError(w, http.StatusConflict, "Value already exists", []detail{{"email", "Value already exists"}})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (a *app) listUsers(w http.ResponseWriter, r *http.Request) {
	params := parseParams(r.URL.RawQuery)
	sel, apiErr := parseSelection(usersEntity, params)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	q, details := parseListQuery(usersEntity, params)
	if details != nil {
		invalidQuery(w, details)
		return
	}
	pageSQL, pageArgs := q.page()
	batch := &pgx.Batch{}
	batch.Queue("SELECT count(*) FROM users"+q.where, q.args...)
	batch.Queue("SELECT "+userColumns+" FROM users"+q.where+" ORDER BY "+q.orderBy+pageSQL, pageArgs...)
	results := a.db.SendBatch(r.Context(), batch)
	defer results.Close()

	var total int64
	if err := results.QueryRow().Scan(&total); err != nil {
		internalError(w, err)
		return
	}
	rows, err := results.Query()
	if err != nil {
		internalError(w, err)
		return
	}
	buf := getBuffer()
	defer putBuffer(buf)
	var scanErr error
	*buf = appendPage(*buf, total, &q, func(b []byte) []byte {
		var u user
		for n := 0; rows.Next(); n++ {
			if scanErr = u.scan(rows); scanErr != nil {
				break
			}
			if n > 0 {
				b = append(b, ',')
			}
			b = appendUser(b, &u, sel.mask)
		}
		return b
	})
	rows.Close()
	if scanErr == nil {
		scanErr = rows.Err()
	}
	if scanErr != nil {
		internalError(w, scanErr)
		return
	}
	writeJSON(w, http.StatusOK, *buf)
}

func (a *app) getUser(w http.ResponseWriter, r *http.Request) {
	sel, apiErr := parseSelection(usersEntity, parseParams(r.URL.RawQuery))
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	var u user
	err := u.scan(a.db.QueryRow(r.Context(), "SELECT "+userColumns+" FROM users WHERE id = $1", r.PathValue("id")))
	if errors.Is(err, pgx.ErrNoRows) {
		userNotFound(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeUser(w, http.StatusOK, &u, sel.mask)
}

// userInput is a validated create or patch body; nil pointers are fields the body did not set.
type userInput struct {
	email, name, role *string
	age               *pgtype.Float8
}

const maxJSONBody = 1 << 20

// readObject reads a JSON body that must be an object, or writes the error and returns nil.
func readObject(w http.ResponseWriter, r *http.Request) map[string]json.RawMessage {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "Body too large", nil)
		} else {
			writeError(w, http.StatusBadRequest, "Invalid JSON body", nil)
		}
		return nil
	}
	if !json.Valid(body) {
		writeError(w, http.StatusBadRequest, "Invalid JSON body", nil)
		return nil
	}
	if trimmed := bytes.TrimLeft(body, " \t\r\n"); trimmed[0] != '{' {
		invalidBody(w, []detail{{"", "Body must be a JSON object"}})
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body, &object); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body", nil)
		return nil
	}
	return object
}

// isJSSpace reports whether r is matched by \s in a JavaScript regular expression.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// isEmail matches ^[^\s@]+@[^\s@]+\.[^\s@]+$ (with JavaScript's \s).
func isEmail(s string) bool {
	if strings.ContainsFunc(s, isJSSpace) || strings.Count(s, "@") != 1 {
		return false
	}
	at := strings.IndexByte(s, '@')
	domain := s[at+1:]
	return at > 0 && len(domain) >= 3 && strings.Contains(domain[1:len(domain)-1], ".")
}

// utf16Length is the length of s in UTF-16 code units, like JavaScript's String.prototype.length.
func utf16Length(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// rawString decodes a JSON string value; ok is false when the value is not a string.
func rawString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	return s, json.Unmarshal(raw, &s) == nil
}

func isNull(raw json.RawMessage) bool { return string(raw) == "null" }

var userWritable = []string{"email", "name", "role", "age"}
var systemFields = []string{"id", "createdAt", "updatedAt"}

// validateUser checks a create (required fields) or patch body; every problem is reported, one per field.
func validateUser(object map[string]json.RawMessage, create bool) (userInput, []detail) {
	var in userInput
	var details []detail
	add := func(field, message string) { details = append(details, detail{field, message}) }

	stringField := func(name string, check func(string) string) *string {
		raw, present := object[name]
		switch {
		case !present:
			if create && name != "role" {
				add(name, "Is required")
			}
			return nil
		case isNull(raw):
			add(name, "Cannot be null")
			return nil
		}
		s, ok := rawString(raw)
		if !ok {
			if name == "role" {
				add(name, "Must be one of: member, admin")
			} else {
				add(name, "Must be a string")
			}
			return nil
		}
		if message := check(s); message != "" {
			add(name, message)
			return nil
		}
		return &s
	}
	in.email = stringField("email", func(s string) string {
		if !isEmail(s) {
			return "Must be a valid email"
		}
		return ""
	})
	in.name = stringField("name", func(s string) string {
		switch n := utf16Length(s); {
		case n < 1:
			return "Must be at least 1 characters"
		case n > 100:
			return "Must be at most 100 characters"
		}
		return ""
	})
	in.role = stringField("role", func(s string) string {
		if !slices.Contains(roles, s) {
			return "Must be one of: member, admin"
		}
		return ""
	})
	if raw, present := object["age"]; present {
		if isNull(raw) {
			in.age = &pgtype.Float8{}
		} else if c := raw[0]; c != '-' && (c < '0' || c > '9') {
			add("age", "Must be a number")
		} else if value, err := strconv.ParseFloat(string(raw), 64); (err != nil && !errors.Is(err, strconv.ErrRange)) || value != math.Trunc(value) || math.IsInf(value, 0) {
			add("age", "Must be an integer")
		} else if value < 0 {
			add("age", "Must be at least 0")
		} else if value > 150 {
			add("age", "Must be at most 150")
		} else {
			in.age = &pgtype.Float8{Float64: value, Valid: true}
		}
	}
	var extra []string
	for key := range object {
		if !slices.Contains(userWritable, key) {
			extra = append(extra, key)
		}
	}
	slices.Sort(extra)
	for _, key := range extra {
		if slices.Contains(systemFields, key) {
			add(key, "Field is read-only")
		} else {
			add(key, "Unknown field")
		}
	}
	return in, details
}

func (a *app) createUser(w http.ResponseWriter, r *http.Request) {
	object := readObject(w, r)
	if object == nil {
		return
	}
	in, details := validateUser(object, true)
	if details != nil {
		invalidBody(w, details)
		return
	}
	id, err := uuid.NewV7()
	if err != nil {
		internalError(w, err)
		return
	}
	t := now()
	u := user{id: id.String(), createdAt: t, updatedAt: t, email: *in.email, name: *in.name, role: "member"}
	if in.role != nil {
		u.role = *in.role
	}
	if in.age != nil {
		u.age = *in.age
	}
	_, err = a.db.Exec(r.Context(),
		"INSERT INTO users ("+userColumns+") VALUES ($1, $2, $2, $3, $4, $5, $6)",
		u.id, u.createdAt, u.email, u.name, u.role, u.age)
	if isUniqueViolation(err) {
		emailTaken(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeUser(w, http.StatusCreated, &u, usersEntity.allFields())
}

func (a *app) updateUser(w http.ResponseWriter, r *http.Request) {
	object := readObject(w, r)
	if object == nil {
		return
	}
	in, details := validateUser(object, false)
	if details != nil {
		invalidBody(w, details)
		return
	}
	var sql strings.Builder
	sql.WriteString("UPDATE users SET updated_at = $1")
	args := []any{now()}
	set := func(column string, value any) {
		args = append(args, value)
		sql.WriteString(", " + column + " = $" + strconv.Itoa(len(args)))
	}
	if in.email != nil {
		set("email", *in.email)
	}
	if in.name != nil {
		set("name", *in.name)
	}
	if in.role != nil {
		set("role", *in.role)
	}
	if in.age != nil {
		set("age", *in.age)
	}
	args = append(args, r.PathValue("id"))
	sql.WriteString(" WHERE id = $" + strconv.Itoa(len(args)) + " RETURNING " + userColumns)

	var u user
	err := u.scan(a.db.QueryRow(r.Context(), sql.String(), args...))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		userNotFound(w)
	case isUniqueViolation(err):
		emailTaken(w)
	case err != nil:
		internalError(w, err)
	default:
		writeUser(w, http.StatusOK, &u, usersEntity.allFields())
	}
}

// deleteUserSQL deletes the user and, in the same statement, moves updatedAt of every organization that listed it.
// The subqueries see the rows as they were before the statement, so the junction rows are still there when the
// organizations are found; the foreign key then cascades them away. Remaining members keep their positions.
const deleteUserSQL = `WITH deleted AS (
	DELETE FROM users WHERE id = $1 RETURNING id
), touched AS (
	UPDATE organizations SET updated_at = $2
	WHERE id IN (SELECT owner_id FROM organizations__members WHERE target_id IN (SELECT id FROM deleted))
)
SELECT count(*) FROM deleted`

func (a *app) deleteUser(w http.ResponseWriter, r *http.Request) {
	var deleted int
	if err := a.db.QueryRow(r.Context(), deleteUserSQL, r.PathValue("id"), now()).Scan(&deleted); err != nil {
		internalError(w, err)
		return
	}
	if deleted == 0 {
		userNotFound(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
