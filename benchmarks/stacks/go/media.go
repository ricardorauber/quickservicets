package main

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxFileSize = 1 << 20 // 1 MiB, inclusive
	// maxUploadBody bounds the whole multipart body; a larger file part is still answered with 413.
	maxUploadBody = 16 << 20
)

var acceptedTypes = []string{"image/png", "image/jpeg"}
var mediaReadOnly = []string{"id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"}

type media struct {
	id        string
	createdAt time.Time
	updatedAt time.Time
	filename  string
	mimeType  string
	size      float64
	storage   string
}

func appendMedia(b []byte, m *media) []byte {
	b = append(b, `{"id":`...)
	b = appendString(b, m.id)
	b = append(b, `,"createdAt":`...)
	b = appendTime(b, m.createdAt)
	b = append(b, `,"updatedAt":`...)
	b = appendTime(b, m.updatedAt)
	b = append(b, `,"filename":`...)
	b = appendString(b, m.filename)
	b = append(b, `,"mimeType":`...)
	b = appendString(b, m.mimeType)
	b = append(b, `,"size":`...)
	b = appendNumber(b, m.size)
	b = append(b, `,"storage":`...)
	b = appendString(b, m.storage)
	b = append(b, `,"url":`...)
	b = appendString(b, "/media/"+m.id+"/file")
	return append(b, '}')
}

func writeMedia(w http.ResponseWriter, status int, m *media) {
	buf := getBuffer()
	defer putBuffer(buf)
	*buf = appendMedia(*buf, m)
	writeJSON(w, status, *buf)
}

func mediaNotFound(w http.ResponseWriter) { writeError(w, http.StatusNotFound, "Media not found", nil) }

// detectType recognizes formats from their magic bytes; "" when the content is not recognized.
func detectType(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && bytes.HasPrefix(b, []byte("RIFF")) && string(b[8:12]) == "WEBP":
		return "image/webp"
	case bytes.HasPrefix(b, []byte("%PDF-")):
		return "application/pdf"
	}
	return ""
}

// essence is a MIME type without parameters, in lower case.
func essence(contentType string) string {
	value, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(value))
}

func isControl(r rune) bool { return r <= 0x1f || r == 0x7f }

// sanitizeFilename keeps the base name (after the last / or \), without control characters, at most 255 UTF-16
// code units.
func sanitizeFilename(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if isControl(r) {
			return -1
		}
		return r
	}, name)
	if len(name) > 255 {
		units := 0
		for i, r := range name {
			units += utf16.RuneLen(r)
			if units > 255 {
				return name[:i]
			}
		}
	}
	return name
}

// extension is the lowercased extension of the file name including the dot, empty when it has none.
func extension(filename string) string {
	if dot := strings.LastIndexByte(filename, '.'); dot > 0 {
		return strings.ToLower(filename[dot:])
	}
	return ""
}

var fileBuffers = sync.Pool{New: func() any { return bytes.NewBuffer(make([]byte, 0, 64<<10)) }}

// upload is what POST /media read from the multipart body.
type upload struct {
	found    bool // the first "file" part is a file
	data     *bytes.Buffer
	tooLarge bool
	declared string
	filename string
	others   []string // names of the other parts, in order, without duplicates
}

func readUpload(reader *multipart.Reader) (*upload, error) {
	u := &upload{}
	seenFile := false
	for {
		part, err := reader.NextRawPart()
		if errors.Is(err, io.EOF) {
			return u, nil
		}
		if err != nil {
			return u, err
		}
		_, params, _ := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		name := params["name"]
		filename, isFile := params["filename"]
		switch {
		case name == "file" && !seenFile:
			seenFile = true
			if isFile {
				u.found = true
				u.declared = essence(part.Header.Get("Content-Type"))
				u.filename = filename
				u.data = fileBuffers.Get().(*bytes.Buffer)
				u.data.Reset()
				if _, err := u.data.ReadFrom(io.LimitReader(part, maxFileSize+1)); err != nil {
					return u, err
				}
				u.tooLarge = u.data.Len() > maxFileSize
			}
		case name == "file":
		case !slices.Contains(u.others, name):
			u.others = append(u.others, name)
		}
		if _, err := io.Copy(io.Discard, part); err != nil {
			return u, err
		}
	}
}

func (u *upload) release() {
	if u.data != nil && u.data.Cap() <= 2<<20 {
		fileBuffers.Put(u.data)
	}
}

func (a *app) createMedia(w http.ResponseWriter, r *http.Request) {
	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		writeError(w, http.StatusUnsupportedMediaType, "Must be multipart/form-data", nil)
		return
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		writeError(w, http.StatusBadRequest, "Invalid multipart body", nil)
		return
	}
	u, err := readUpload(multipart.NewReader(http.MaxBytesReader(w, r.Body, maxUploadBody), params["boundary"]))
	defer u.release()
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "File too large", nil)
		} else {
			writeError(w, http.StatusBadRequest, "Invalid multipart body", nil)
		}
		return
	}
	if !u.found {
		invalidBody(w, []detail{{"file", "Is required"}})
		return
	}
	data := u.data.Bytes()
	mimeType := u.declared
	if detected := detectType(data); detected != "" {
		if u.declared != "" && u.declared != "application/octet-stream" && u.declared != detected {
			writeError(w, http.StatusUnsupportedMediaType, "File content does not match its type",
				[]detail{{"file", "Detected " + detected + ", declared " + u.declared}})
			return
		}
		mimeType = detected
	}
	if u.tooLarge {
		writeError(w, http.StatusRequestEntityTooLarge, "File too large", nil)
		return
	}
	if !slices.Contains(acceptedTypes, mimeType) {
		invalidBody(w, []detail{{"file", "File type not allowed"}})
		return
	}
	if len(u.others) > 0 {
		details := make([]detail, 0, len(u.others))
		for _, name := range u.others {
			if slices.Contains(mediaReadOnly, name) {
				details = append(details, detail{name, "Field is read-only"})
			} else {
				details = append(details, detail{name, "Unknown field"})
			}
		}
		invalidBody(w, details)
		return
	}

	id, err := uuid.NewV7()
	if err != nil {
		internalError(w, err)
		return
	}
	objectID, err := uuid.NewV7()
	if err != nil {
		internalError(w, err)
		return
	}
	t := now()
	m := media{id: id.String(), createdAt: t, updatedAt: t, filename: sanitizeFilename(u.filename), mimeType: mimeType,
		size: float64(len(data)), storage: "default"}
	key := "media/" + m.id + "/" + objectID.String() + extension(m.filename)
	path := filepath.Join(a.uploadDir, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		internalError(w, err)
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		internalError(w, err)
		return
	}
	_, err = a.db.Exec(r.Context(),
		"INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key) VALUES ($1, $2, $2, $3, $4, $5, $6, $7)",
		m.id, m.createdAt, m.filename, m.mimeType, m.size, m.storage, key)
	if err != nil {
		_ = os.Remove(path)
		_ = os.Remove(filepath.Dir(path))
		internalError(w, err)
		return
	}
	writeMedia(w, http.StatusCreated, &m)
}

func (a *app) getMedia(w http.ResponseWriter, r *http.Request) {
	var m media
	err := a.db.QueryRow(r.Context(),
		"SELECT id, created_at, updated_at, filename, mime_type, size, storage FROM media WHERE id = $1", r.PathValue("id"),
	).Scan(&m.id, &m.createdAt, &m.updatedAt, &m.filename, &m.mimeType, &m.size, &m.storage)
	if errors.Is(err, pgx.ErrNoRows) {
		mediaNotFound(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeMedia(w, http.StatusOK, &m)
}

// dispositionName drops quotes, backslashes and control characters (U+0000 to U+001F) from a file name.
func dispositionName(name string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r <= 0x1f {
			return -1
		}
		return r
	}, name)
}

func (a *app) getMediaFile(w http.ResponseWriter, r *http.Request) {
	var filename, mimeType, key string
	var size float64
	err := a.db.QueryRow(r.Context(), "SELECT filename, mime_type, size, storage_key FROM media WHERE id = $1", r.PathValue("id")).
		Scan(&filename, &mimeType, &size, &key)
	if errors.Is(err, pgx.ErrNoRows) {
		mediaNotFound(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	file, err := os.Open(filepath.Join(a.uploadDir, filepath.FromSlash(key)))
	if errors.Is(err, os.ErrNotExist) {
		mediaNotFound(w)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	defer file.Close()
	h := w.Header()
	h["Content-Type"] = []string{mimeType}
	h["Content-Length"] = []string{strconv.FormatInt(int64(size), 10)}
	h["Content-Disposition"] = []string{`inline; filename="` + dispositionName(filename) + `"`}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}
