<?php

namespace App\Http\Controllers;

use App\Support\Api;
use App\Support\ApiError;
use App\Support\Clock;
use App\Support\Records;
use App\Support\Schema;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Throwable;

final class MediaController
{
    private const MAX_SIZE = 1024 * 1024;

    private const ACCEPTED = ['image/png' => true, 'image/jpeg' => true];

    private const READ_ONLY = [
        'id' => true, 'createdAt' => true, 'updatedAt' => true, 'filename' => true, 'mimeType' => true,
        'size' => true, 'storage' => true, 'url' => true,
    ];

    public function store(Request $request): JsonResponse
    {
        $contentType = strtolower((string) $request->headers->get('Content-Type'));
        if (! str_starts_with($contentType, 'multipart/form-data')) {
            return Api::error(415, 'Must be multipart/form-data');
        }

        $file = $request->file('file');
        if (! $file instanceof UploadedFile) {
            throw ApiError::invalidBody([['field' => 'file', 'message' => 'Is required']]);
        }

        $declared = strtolower(trim(explode(';', (string) $file->getClientMimeType(), 2)[0]));
        $detected = self::detect($file->getPathname());
        if ($detected !== null && $declared !== '' && $declared !== 'application/octet-stream' && $declared !== $detected) {
            return Api::error(415, 'File content does not match its type', [
                ['field' => 'file', 'message' => "Detected $detected, declared $declared"],
            ]);
        }
        $type = $detected ?? $declared;

        $size = $file->getSize();
        if ($size > self::MAX_SIZE) {
            return Api::error(413, 'File too large');
        }
        if (! isset(self::ACCEPTED[$type])) {
            throw ApiError::invalidBody([['field' => 'file', 'message' => 'File type not allowed']]);
        }

        $details = [];
        foreach ([...$request->request->keys(), ...$request->files->keys()] as $name) {
            $name = (string) $name;
            if ($name !== 'file') {
                $details[] = ['field' => $name, 'message' => isset(self::READ_ONLY[$name]) ? 'Field is read-only' : 'Unknown field'];
            }
        }
        if ($details !== []) {
            throw ApiError::invalidBody($details);
        }

        $filename = self::filename((string) $file->getClientOriginalName());
        $dot = strrpos($filename, '.');
        $extension = $dot !== false && $dot > 0 ? strtolower(substr($filename, $dot)) : '';
        $id = Str::uuid7()->toString();
        $key = 'media/'.$id.'/'.Str::uuid7()->toString().$extension;
        $path = self::uploadDir().'/'.$key;

        $file->move(dirname($path), basename($path));
        $now = Clock::now();
        try {
            DB::table('media')->insert([
                'id' => $id,
                'created_at' => $now,
                'updated_at' => $now,
                'filename' => $filename,
                'mime_type' => $type,
                'size' => $size,
                'storage' => 'default',
                'storage_key' => $key,
            ]);
        } catch (Throwable $e) {
            @unlink($path);

            throw $e;
        }

        return Api::json([
            'id' => $id,
            'createdAt' => $now,
            'updatedAt' => $now,
            'filename' => $filename,
            'mimeType' => $type,
            'size' => $size,
            'storage' => 'default',
            'url' => "/media/$id/file",
        ], 201);
    }

    public function show(string $id): JsonResponse
    {
        $row = DB::table('media')->where('id', $id)->first(Schema::MEDIA_COLUMNS);

        return $row === null ? Api::notFound('Media not found') : Api::json(Records::media($row));
    }

    public function file(string $id): BinaryFileResponse|JsonResponse
    {
        $row = DB::table('media')->where('id', $id)->first(['filename', 'mime_type', 'storage_key']);
        $path = $row === null ? null : self::uploadDir().'/'.$row->storage_key;
        if ($path === null || ! is_file($path)) {
            return Api::notFound('Media not found');
        }
        $name = preg_replace('/["\\\\\x00-\x1F]/', '', $row->filename);

        return new BinaryFileResponse($path, 200, [
            'Content-Type' => $row->mime_type,
            'Content-Disposition' => 'inline; filename="'.$name.'"',
        ], public: false, autoEtag: false, autoLastModified: false);
    }

    /** The type the content shows, from its first bytes. */
    private static function detect(string $path): ?string
    {
        $handle = fopen($path, 'rb');
        $head = $handle === false ? '' : (string) fread($handle, 16);
        if ($handle !== false) {
            fclose($handle);
        }

        return match (true) {
            str_starts_with($head, "\x89PNG\r\n\x1A\n") => 'image/png',
            str_starts_with($head, "\xFF\xD8\xFF") => 'image/jpeg',
            str_starts_with($head, 'GIF87a'), str_starts_with($head, 'GIF89a') => 'image/gif',
            str_starts_with($head, 'RIFF') && substr($head, 8, 4) === 'WEBP' => 'image/webp',
            str_starts_with($head, '%PDF-') => 'application/pdf',
            default => null,
        };
    }

    /** The base name, without control characters, at most 255 UTF-16 code units. */
    private static function filename(string $name): string
    {
        $segments = preg_split('#[\\\\/]#', $name);
        $name = preg_replace('/[\x00-\x1F\x7F]/', '', (string) end($segments));

        return mb_strlen($name) > 255 ? mb_substr($name, 0, 255) : $name;
    }

    private static function uploadDir(): string
    {
        return rtrim((string) config('media.upload_dir'), '/');
    }
}
