package main

import (
	"math"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type fieldKind int

const (
	kindID fieldKind = iota
	kindDate
	kindString
	kindNumber
	kindEnum
)

// field is a column field of an entity: selectable, sortable and filterable.
type field struct {
	name   string
	column string
	kind   fieldKind
	values []string // enum values
	bit    uint
}

// entity describes what the list and read routes of a collection accept.
type entity struct {
	columns    []field  // filterable and sortable fields
	selectable []string // names accepted by `fields`, in output order; bit i is selectable[i]
	populate   []string // reference fields that `populate` accepts
}

func (e *entity) column(name string) *field {
	for i := range e.columns {
		if e.columns[i].name == name {
			return &e.columns[i]
		}
	}
	return nil
}

func (e *entity) allFields() uint { return 1<<len(e.selectable) - 1 }

var roles = []string{"member", "admin"}

const (
	userID uint = 1 << iota
	userCreatedAt
	userUpdatedAt
	userEmail
	userName
	userRole
	userAge
)

var usersEntity = &entity{
	columns: []field{
		{"id", "id", kindID, nil, userID},
		{"createdAt", "created_at", kindDate, nil, userCreatedAt},
		{"updatedAt", "updated_at", kindDate, nil, userUpdatedAt},
		{"email", "email", kindString, nil, userEmail},
		{"name", "name", kindString, nil, userName},
		{"role", "role", kindEnum, roles, userRole},
		{"age", "age", kindNumber, nil, userAge},
	},
	selectable: []string{"id", "createdAt", "updatedAt", "email", "name", "role", "age"},
}

const (
	orgID uint = 1 << iota
	orgCreatedAt
	orgUpdatedAt
	orgName
	orgSlug
	orgMembers
)

var organizationsEntity = &entity{
	columns: []field{
		{"id", "id", kindID, nil, orgID},
		{"createdAt", "created_at", kindDate, nil, orgCreatedAt},
		{"updatedAt", "updated_at", kindDate, nil, orgUpdatedAt},
		{"name", "name", kindString, nil, orgName},
		{"slug", "slug", kindString, nil, orgSlug},
	},
	selectable: []string{"id", "createdAt", "updatedAt", "name", "slug", "members"},
	populate:   []string{"members"},
}

// param is one key=value pair of the query string, in the order the client sent them.
type param struct{ key, value string }

// parseParams splits a raw query string like url.ParseQuery, but keeps the order and the repeated keys.
func parseParams(raw string) []param {
	var params []param
	for raw != "" {
		var pair string
		pair, raw, _ = strings.Cut(raw, "&")
		if pair == "" {
			continue
		}
		key, value, _ := strings.Cut(pair, "=")
		key, err := url.QueryUnescape(key)
		if err != nil {
			continue
		}
		value, err = url.QueryUnescape(value)
		if err != nil {
			continue
		}
		params = append(params, param{key, value})
	}
	return params
}

func first(params []param, key string) (string, bool) {
	for _, p := range params {
		if p.key == key {
			return p.value, true
		}
	}
	return "", false
}

// splitList splits a comma-separated value, trimming items and dropping empty ones.
func splitList(raw string) []string {
	items := strings.Split(raw, ",")
	out := items[:0]
	for _, item := range items {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// selection holds the validated `populate` and `fields` parameters of a list or read route.
type selection struct {
	mask     uint
	populate bool
}

// parseSelection validates `populate` (first) and `fields`, as QuickService does, and returns the error to send.
func parseSelection(e *entity, params []param) (selection, *apiError) {
	sel := selection{mask: e.allFields()}
	if raw, ok := first(params, "populate"); ok {
		var details []detail
		for _, path := range splitList(raw) {
			if slices.Contains(e.populate, path) {
				sel.populate = true
			} else {
				details = append(details, detail{"populate", "Cannot populate: " + path})
			}
		}
		if details != nil {
			return sel, &apiError{400, details[0].message, details}
		}
	}
	if raw, ok := first(params, "fields"); ok {
		names := splitList(raw)
		if len(names) == 0 {
			return sel, &apiError{400, "Invalid query", []detail{{"fields", "Must list at least one field"}}}
		}
		var details []detail
		mask := uint(0)
		for _, name := range names {
			index := slices.Index(e.selectable, name)
			if index < 0 {
				if !slices.ContainsFunc(details, func(d detail) bool { return d.message == "Unknown field: "+name }) {
					details = append(details, detail{"fields", "Unknown field: " + name})
				}
				continue
			}
			mask |= 1 << index
		}
		if details != nil {
			return sel, &apiError{400, "Invalid query", details}
		}
		sel.mask = mask
	}
	return sel, nil
}

const (
	defaultLimit  = 20
	maxLimit      = 100
	maxListValues = 100
)

// listQuery is a validated list query: a WHERE clause with its arguments, an ORDER BY clause and the page.
type listQuery struct {
	where   string
	args    []any
	orderBy string
	limit   int
	offset  int
}

var operators = []string{"eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull",
	"containsAny", "containsAll", "size", "isEmpty"}

var operatorsByKind = map[fieldKind][]string{
	kindID:     {"eq", "ne", "in", "nin", "exists", "isNull"},
	kindEnum:   {"eq", "ne", "in", "nin", "exists", "isNull"},
	kindString: {"eq", "ne", "in", "nin", "exists", "isNull", "contains", "startsWith"},
	kindNumber: {"eq", "ne", "in", "nin", "exists", "isNull", "gt", "gte", "lt", "lte"},
	kindDate:   {"eq", "ne", "in", "nin", "exists", "isNull", "gt", "gte", "lt", "lte"},
}

var comparisons = map[string]string{"eq": " = ", "ne": " <> ", "gt": " > ", "gte": " >= ", "lt": " < ", "lte": " <= "}

// whereKey matches where[<field>][<op>] and where[<field>][<op>][<comparison>].
func whereKey(key string) (name, op, comparison string, ok bool) {
	rest, found := strings.CutPrefix(key, "where[")
	if !found {
		return
	}
	segment := func() (string, bool) {
		end := strings.IndexByte(rest, ']')
		if end <= 0 {
			return "", false
		}
		value := rest[:end]
		rest = rest[end+1:]
		return value, true
	}
	if name, ok = segment(); !ok {
		return
	}
	if rest, ok = strings.CutPrefix(rest, "["); !ok {
		return
	}
	if op, ok = segment(); !ok {
		return
	}
	if rest == "" {
		return name, op, "", true
	}
	if rest, ok = strings.CutPrefix(rest, "["); !ok {
		return
	}
	if comparison, ok = segment(); !ok || rest != "" {
		return "", "", "", false
	}
	return name, op, comparison, true
}

var iso8601 = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$`)

var dateLayouts = []string{"2006-01-02T15:04:05.999999999Z07:00", "2006-01-02T15:04Z07:00", "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02"}

// convert parses one filter value by field type, or returns the message clients read.
func convert(raw string, f *field) (any, string) {
	switch f.kind {
	case kindNumber:
		value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
			return nil, "Must be a number"
		}
		return value, ""
	case kindEnum:
		if slices.Contains(f.values, raw) {
			return raw, ""
		}
		return nil, "Must be one of: " + strings.Join(f.values, ", ")
	case kindDate:
		if iso8601.MatchString(raw) {
			for _, layout := range dateLayouts {
				if t, err := time.Parse(layout, raw); err == nil {
					return t, ""
				}
			}
		}
		return nil, "Must be an ISO 8601 date"
	default:
		return raw, ""
	}
}

func likePattern(value string, prefix bool) string {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
	if prefix {
		return escaped + "%"
	}
	return "%" + escaped + "%"
}

// condition validates one where[...] parameter and appends its SQL to q.
func (q *listQuery) condition(e *entity, name, op, comparison, raw, key string, add func(string, string)) {
	f := e.column(name)
	if f == nil {
		add(key, `Field "`+name+`" cannot be filtered`)
		return
	}
	if !slices.Contains(operators, op) {
		add(key, `Unknown operator "`+op+`"`)
		return
	}
	if !slices.Contains(operatorsByKind[f.kind], op) {
		add(key, `Operator "`+op+`" is not allowed for this field`)
		return
	}
	if comparison != "" {
		add(key, `Unknown operator "`+op+`"`)
		return
	}
	var sql string
	placeholder := func(value any) string {
		q.args = append(q.args, value)
		return "$" + strconv.Itoa(len(q.args))
	}
	switch op {
	case "exists", "isNull":
		if raw != "true" && raw != "false" {
			add(key, "Must be true or false")
			return
		}
		if (op == "exists") == (raw == "true") {
			sql = f.column + " IS NOT NULL"
		} else {
			sql = f.column + " IS NULL"
		}
	case "in", "nin":
		items := splitList(raw)
		if len(items) == 0 {
			add(key, "Must list at least one value")
			return
		}
		if len(items) > maxListValues {
			add(key, "Must list at most 100 values")
			return
		}
		var values any
		switch f.kind {
		case kindNumber:
			numbers := make([]float64, 0, len(items))
			for _, item := range items {
				value, message := convert(item, f)
				if message != "" {
					add(key, message)
					return
				}
				numbers = append(numbers, value.(float64))
			}
			values = numbers
		case kindDate:
			dates := make([]time.Time, 0, len(items))
			for _, item := range items {
				value, message := convert(item, f)
				if message != "" {
					add(key, message)
					return
				}
				dates = append(dates, value.(time.Time))
			}
			values = dates
		default:
			for _, item := range items {
				if _, message := convert(item, f); message != "" {
					add(key, message)
					return
				}
			}
			values = items
		}
		if op == "in" {
			sql = f.column + " = ANY(" + placeholder(values) + ")"
		} else {
			sql = f.column + " <> ALL(" + placeholder(values) + ")"
		}
	default:
		value, message := convert(raw, f)
		if message != "" {
			add(key, message)
			return
		}
		switch op {
		case "contains", "startsWith":
			sql = f.column + ` ILIKE ` + placeholder(likePattern(value.(string), op == "startsWith"))
		default:
			sql = f.column + comparisons[op] + placeholder(value)
		}
	}
	if q.where == "" {
		q.where = " WHERE " + sql
	} else {
		q.where += " AND " + sql
	}
}

func parseSort(e *entity, raw string, given bool, add func(string, string)) string {
	var order strings.Builder
	var seen []string
	if !given {
		order.WriteString("created_at DESC")
	} else {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			name, descending := strings.CutPrefix(part, "-")
			f := e.column(name)
			if f == nil {
				add("sort", `Field "`+name+`" cannot be sorted`)
				continue
			}
			if slices.Contains(seen, name) {
				add("sort", `Field "`+name+`" is listed more than once`)
				continue
			}
			seen = append(seen, name)
			if order.Len() > 0 {
				order.WriteString(", ")
			}
			order.WriteString(f.column)
			if descending {
				order.WriteString(" DESC")
			}
		}
	}
	if !slices.Contains(seen, "id") {
		if order.Len() > 0 {
			order.WriteString(", ")
		}
		order.WriteString("id DESC")
	}
	return order.String()
}

func isInteger(raw string) bool {
	digits := strings.TrimPrefix(raw, "-")
	if digits == "" {
		return false
	}
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return false
		}
	}
	return true
}

func parseInteger(raw string, given bool, name string, min, max, fallback int, message string, add func(string, string)) int {
	if !given {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if !isInteger(raw) || err != nil || value < min || value > max {
		add(name, message)
		return fallback
	}
	return value
}

// parseListQuery validates the parameters of a list route: unknown and repeated parameters, filters, sort and page.
func parseListQuery(e *entity, params []param) (listQuery, []detail) {
	var details []detail
	add := func(field, message string) { details = append(details, detail{field, message}) }
	q := listQuery{}
	var sortRaw, limitRaw, offsetRaw string
	var hasSort, hasLimit, hasOffset bool
	seen := make(map[string]struct{}, len(params))
	for _, p := range params {
		if _, repeated := seen[p.key]; repeated {
			add(p.key, "Parameter is repeated")
			continue
		}
		seen[p.key] = struct{}{}
		if name, op, comparison, ok := whereKey(p.key); ok {
			q.condition(e, name, op, comparison, p.value, p.key, add)
			continue
		}
		switch p.key {
		case "sort":
			sortRaw, hasSort = p.value, true
		case "limit":
			limitRaw, hasLimit = p.value, true
		case "offset":
			offsetRaw, hasOffset = p.value, true
		case "fields", "populate":
		default:
			add(p.key, "Unknown parameter")
		}
	}
	q.orderBy = parseSort(e, sortRaw, hasSort, add)
	q.limit = parseInteger(limitRaw, hasLimit, "limit", 1, maxLimit, defaultLimit, "Must be an integer from 1 to 100", add)
	q.offset = parseInteger(offsetRaw, hasOffset, "offset", 0, 1<<53-1, 0, "Must be an integer of at least 0", add)
	return q, details
}

// page appends LIMIT and OFFSET placeholders after the filter arguments.
func (q *listQuery) page() (string, []any) {
	n := len(q.args)
	args := append(slices.Clip(q.args), q.limit, q.offset)
	return " LIMIT $" + strconv.Itoa(n+1) + " OFFSET $" + strconv.Itoa(n+2), args
}

// appendPage writes {"data":[...],"total":n,"limit":l,"offset":o} around the items written by items.
func appendPage(b []byte, total int64, q *listQuery, items func([]byte) []byte) []byte {
	b = append(b, `{"data":[`...)
	b = items(b)
	b = append(b, `],"total":`...)
	b = strconv.AppendInt(b, total, 10)
	b = append(b, `,"limit":`...)
	b = strconv.AppendInt(b, int64(q.limit), 10)
	b = append(b, `,"offset":`...)
	b = strconv.AppendInt(b, int64(q.offset), 10)
	return append(b, '}')
}
