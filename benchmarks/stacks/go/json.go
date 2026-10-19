package main

import (
	"log"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
)

// Responses are written with append-style encoders into pooled buffers: the records are flat and the field
// selection is dynamic, so this is both simpler and cheaper than reflection-based encoding/json.

var bufferPool = sync.Pool{New: func() any { b := make([]byte, 0, 4096); return &b }}

func getBuffer() *[]byte { return bufferPool.Get().(*[]byte) }

func putBuffer(b *[]byte) {
	if cap(*b) > 1<<16 {
		return
	}
	*b = (*b)[:0]
	bufferPool.Put(b)
}

var jsonContentType = []string{"application/json"}

func writeJSON(w http.ResponseWriter, status int, body []byte) {
	h := w.Header()
	h["Content-Type"] = jsonContentType
	h["Content-Length"] = []string{strconv.Itoa(len(body))}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// detail is one entry of an error's details.
type detail struct{ field, message string }

var errorCodes = map[int]string{
	http.StatusBadRequest:            "VALIDATION_ERROR",
	http.StatusNotFound:              "NOT_FOUND",
	http.StatusConflict:              "CONFLICT",
	http.StatusRequestEntityTooLarge: "PAYLOAD_TOO_LARGE",
	http.StatusUnsupportedMediaType:  "UNSUPPORTED_MEDIA_TYPE",
	http.StatusInternalServerError:   "INTERNAL_ERROR",
}

// writeError writes {"error":{"code","message","details"?}}; details is omitted when nil.
func writeError(w http.ResponseWriter, status int, message string, details []detail) {
	buf := getBuffer()
	defer putBuffer(buf)
	b := append(*buf, `{"error":{"code":`...)
	b = appendString(b, errorCodes[status])
	b = append(b, `,"message":`...)
	b = appendString(b, message)
	if details != nil {
		b = append(b, `,"details":[`...)
		for i, d := range details {
			if i > 0 {
				b = append(b, ',')
			}
			b = append(b, `{"field":`...)
			b = appendString(b, d.field)
			b = append(b, `,"message":`...)
			b = appendString(b, d.message)
			b = append(b, '}')
		}
		b = append(b, ']')
	}
	b = append(b, "}}"...)
	*buf = b
	writeJSON(w, status, b)
}

func invalidQuery(w http.ResponseWriter, details []detail) {
	writeError(w, http.StatusBadRequest, "Invalid query", details)
}

func invalidBody(w http.ResponseWriter, details []detail) {
	writeError(w, http.StatusBadRequest, "Invalid body", details)
}

func internalError(w http.ResponseWriter, err error) {
	log.Printf("internal error: %v", err)
	writeError(w, http.StatusInternalServerError, "Internal server error", nil)
}

const hex = "0123456789abcdef"

// appendString appends s as a JSON string. Values come from PostgreSQL text columns (valid UTF-8) or from the
// service itself; invalid bytes are replaced with U+FFFD like encoding/json does.
func appendString(b []byte, s string) []byte {
	b = append(b, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			if c >= 0x20 && c != '"' && c != '\\' {
				i++
				continue
			}
			b = append(b, s[start:i]...)
			switch c {
			case '"', '\\':
				b = append(b, '\\', c)
			case '\n':
				b = append(b, '\\', 'n')
			case '\r':
				b = append(b, '\\', 'r')
			case '\t':
				b = append(b, '\\', 't')
			case '\b':
				b = append(b, '\\', 'b')
			case '\f':
				b = append(b, '\\', 'f')
			default:
				b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
			}
			i++
			start = i
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b = append(b, s[start:i]...)
			b = append(b, `�`...)
			i++
			start = i
			continue
		}
		i += size
	}
	b = append(b, s[start:]...)
	return append(b, '"')
}

// appendNumber writes integral values as JSON integers and others in their shortest round-trip form.
func appendNumber(b []byte, v float64) []byte {
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.AppendInt(b, int64(v), 10)
	}
	return strconv.AppendFloat(b, v, 'g', -1, 64)
}

// appendTime writes the UTC time with exactly three fractional digits, like Date.prototype.toISOString.
func appendTime(b []byte, t time.Time) []byte {
	b = append(b, '"')
	b = t.UTC().AppendFormat(b, "2006-01-02T15:04:05.000Z")
	return append(b, '"')
}

// appendKey writes the separator (when the object already has a field) and "name":.
func appendKey(b []byte, first *bool, name string) []byte {
	if !*first {
		b = append(b, ',')
	}
	*first = false
	b = append(b, '"')
	b = append(b, name...)
	return append(b, '"', ':')
}

// now is the current time truncated to milliseconds, so what is stored and what is returned are equal.
func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// apiError is an error response decided before the handler writes anything.
type apiError struct {
	status  int
	message string
	details []detail
}

func (e *apiError) write(w http.ResponseWriter) { writeError(w, e.status, e.message, e.details) }
