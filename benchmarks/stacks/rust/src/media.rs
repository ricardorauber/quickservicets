//! `/media` uploads and `/media/{id}`, `/media/{id}/file`.

use std::path::PathBuf;

use axum::{
    extract::{FromRequest, Multipart, Path, Request, State, multipart::MultipartError},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::{
    SharedState,
    error::{ApiError, detail},
    model::{MEDIA_COLUMNS, Media, json_response, new_id, now_ms},
};

const MAX_SIZE: usize = 1024 * 1024;
const ACCEPTED: &[&str] = &["image/png", "image/jpeg"];
const READ_ONLY: &[&str] = &["id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"];

/// The `file` part: its name, declared type and the first `MAX_SIZE + 1` bytes, with the full size.
struct FilePart {
    filename: String,
    declared: Option<String>,
    data: Vec<u8>,
    size: usize,
}

/// A media type without parameters, lowercased.
fn essence(content_type: &str) -> String {
    content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase()
}

/// The type of the content from its magic bytes, for the formats this service recognizes.
fn detect(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else {
        None
    }
}

/// The base name of an uploaded file name, without control characters, at most 255 UTF-16 code units.
fn sanitize_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name = String::with_capacity(base.len());
    let mut units = 0;
    for c in base.chars().filter(|&c| !matches!(c, '\u{0}'..='\u{1F}' | '\u{7F}')) {
        units += c.len_utf16();
        if units > 255 {
            break;
        }
        name.push(c);
    }
    name
}

/// The lowercased extension including the dot (`.png`), or empty; a leading dot does not start one.
fn extension(filename: &str) -> String {
    match filename.rfind('.') {
        Some(dot) if dot > 0 => filename[dot..].to_lowercase(),
        _ => String::new(),
    }
}

fn multipart_error(error: MultipartError) -> ApiError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "File too large")
    } else {
        ApiError::new(StatusCode::BAD_REQUEST, "Invalid multipart body")
    }
}

pub async fn upload(State(state): State<SharedState>, request: Request) -> Result<Response, ApiError> {
    let is_multipart = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("multipart/form-data"));
    if !is_multipart {
        return Err(ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Must be multipart/form-data"));
    }
    let mut multipart =
        Multipart::from_request(request, &()).await.map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid multipart body"))?;

    let mut file: Option<FilePart> = None;
    let mut other_parts: Vec<String> = Vec::new();
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or("").to_owned();
        if name != "file" {
            other_parts.push(name);
            continue;
        }
        if file.is_some() {
            continue;
        }
        // A `file` part without a file name is a plain field, not a file.
        let Some(filename) = field.file_name().map(str::to_owned) else { continue };
        let declared = field.content_type().map(str::to_owned);
        let mut data = Vec::new();
        let mut size = 0;
        while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
            size += chunk.len();
            let room = (MAX_SIZE + 1).saturating_sub(data.len());
            data.extend_from_slice(&chunk[..chunk.len().min(room)]);
        }
        file = Some(FilePart { filename, declared, data, size });
    }

    let Some(file) = file else {
        return Err(ApiError::invalid_body(vec![detail("file", "Is required")]));
    };
    let declared = file.declared.as_deref().map(essence);
    let mime_type = match (detect(&file.data), declared.as_deref()) {
        (Some(detected), None | Some("application/octet-stream")) => Some(detected.to_owned()),
        (Some(detected), Some(declared)) if declared == detected => Some(detected.to_owned()),
        (Some(detected), Some(declared)) => {
            return Err(ApiError::with_details(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "File content does not match its type",
                vec![detail("file", format!("Detected {detected}, declared {declared}"))],
            ));
        }
        (None, declared) => declared.map(str::to_owned),
    };
    if file.size > MAX_SIZE {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "File too large"));
    }
    let Some(mime_type) = mime_type.filter(|mime_type| ACCEPTED.contains(&mime_type.as_str())) else {
        return Err(ApiError::invalid_body(vec![detail("file", "File type not allowed")]));
    };
    if !other_parts.is_empty() {
        let details = other_parts
            .into_iter()
            .map(|name| {
                let message = if READ_ONLY.contains(&name.as_str()) { "Field is read-only" } else { "Unknown field" };
                detail(name, message)
            })
            .collect();
        return Err(ApiError::invalid_body(details));
    }

    let now = now_ms();
    let filename = sanitize_filename(&file.filename);
    let media = Media {
        id: new_id(),
        created_at: now,
        updated_at: now,
        mime_type,
        size: file.size as f64,
        storage: "default".to_owned(),
        filename,
    };
    let storage_key = format!("media/{}/{}{}", media.id, new_id(), extension(&media.filename));
    let path: PathBuf = state.upload_dir.join(&storage_key);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, &file.data).await?;

    let inserted = async {
        let client = state.pool.get().await?;
        let statement = client
            .prepare_cached(
                "INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key) \
                 VALUES ($1, $2, $2, $3, $4, $5, $6, $7)",
            )
            .await?;
        client
            .execute(&statement, &[&media.id, &media.created_at, &media.filename, &media.mime_type, &media.size, &media.storage, &storage_key])
            .await?;
        Ok::<_, ApiError>(())
    }
    .await;
    if let Err(error) = inserted {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(json_response(StatusCode::CREATED, &media))
}

pub async fn read(State(state): State<SharedState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let client = state.pool.get().await?;
    let statement = client.prepare_cached(&format!("SELECT {MEDIA_COLUMNS} FROM media WHERE id = $1")).await?;
    let row = client.query_opt(&statement, &[&id]).await?;
    drop(client);
    let media = row.map(|row| Media::from_row(&row)).ok_or_else(|| ApiError::not_found("Media not found"))?;
    Ok(json_response(StatusCode::OK, &media))
}

/// `inline; filename="..."` without quotes, backslashes and control characters in the name.
fn content_disposition(filename: &str) -> HeaderValue {
    let clean: String = filename.chars().filter(|&c| !matches!(c, '"' | '\\' | '\u{0}'..='\u{1F}')).collect();
    HeaderValue::from_bytes(format!("inline; filename=\"{clean}\"").as_bytes()).unwrap_or_else(|_| HeaderValue::from_static("inline"))
}

pub async fn file(State(state): State<SharedState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let client = state.pool.get().await?;
    let statement = client.prepare_cached("SELECT filename, mime_type, storage_key FROM media WHERE id = $1").await?;
    let row = client.query_opt(&statement, &[&id]).await?;
    drop(client);
    let row = row.ok_or_else(|| ApiError::not_found("Media not found"))?;
    let (filename, mime_type, storage_key): (String, String, String) = (row.get(0), row.get(1), row.get(2));
    let bytes = match tokio::fs::read(state.upload_dir.join(&storage_key)).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(ApiError::not_found("Media not found")),
        Err(error) => return Err(error.into()),
    };
    let content_type = HeaderValue::from_str(&mime_type).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    Ok(([(header::CONTENT_TYPE, content_type), (header::CONTENT_DISPOSITION, content_disposition(&filename))], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames() {
        assert_eq!(sanitize_filename("../../etc/evil.png"), "evil.png");
        assert_eq!(sanitize_filename("a\\b\u{1}c.PNG"), "bc.PNG");
        assert_eq!(extension("bc.PNG"), ".png");
        assert_eq!(extension("noext"), "");
        assert_eq!(extension(".hidden"), "");
        assert_eq!(sanitize_filename(&"x".repeat(300)).len(), 255);
    }
}
