const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('crypto');
const path = require('path');

// MinIO's own env style gives a bare host plus MINIO_USE_SSL / MINIO_PORT
// (e.g. storage.dotnetpro.tech, true, 443); the S3 SDK needs a full URL.
// Accept either, so a bare host doesn't make every upload fail ("Invalid URL").
function toEndpointUrl(raw) {
  const v = (raw || '').trim().replace(/\/+$/, '');
  if (!v || /^https?:\/\//i.test(v)) return v;
  const ssl = String(process.env.MINIO_USE_SSL ?? 'true').toLowerCase() !== 'false';
  const port = String(process.env.MINIO_PORT || '').trim();
  const defaultPort = ssl ? '443' : '80';
  return `${ssl ? 'https' : 'http'}://${v}${port && port !== defaultPort ? `:${port}` : ''}`;
}

const ENDPOINT = toEndpointUrl(process.env.MINIO_ENDPOINT); // e.g. https://storage.dotnetpro.tech
const BUCKET   = process.env.MINIO_BUCKET;   // e.g. relux
const BASE_URL  = `${ENDPOINT}/${BUCKET}`;

const s3 = new S3Client({
  endpoint:       ENDPOINT,
  region:         'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});

// Upload a buffer and return { key, url }
async function uploadFile(buffer, originalName, mimeType, prefix = 'uploads') {
  // Extension comes from the validated MIME type, never the client's filename
  // (an "image/png" named evil.html must not be stored as .html).
  const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  const ext = EXT_BY_MIME[mimeType] || '';
  const key = `${prefix}/${randomUUID()}${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
  }));
  return { key, url: `${BASE_URL}/${key}` };
}

// Derive the public URL for a given key (bucket is public-read — no presigning needed)
function getFileUrl(key) {
  return `${BASE_URL}/${key}`;
}

// Extract the S3 key from a stored MinIO URL; returns null for any other URL
function extractKey(url) {
  if (!url || !url.startsWith(BASE_URL + '/')) return null;
  return url.slice(BASE_URL.length + 1);
}

// List objects under an optional prefix
async function listFiles(prefix = '') {
  const result = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (result.Contents || []).map((obj) => ({
    key:          obj.Key,
    url:          getFileUrl(obj.Key),
    size:         obj.Size,
    lastModified: obj.LastModified,
  }));
}

// Delete a file by its S3 key
async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// Delete the old key (best-effort) then upload a new object in the same folder
async function replaceFile(oldKey, buffer, mimeType) {
  if (oldKey) await deleteFile(oldKey).catch(() => {});
  const ext    = path.extname(oldKey || '').toLowerCase() || `.${mimeType.split('/')[1]}`;
  const folder = oldKey ? oldKey.split('/').slice(0, -1).join('/') : 'uploads';
  const key    = `${folder}/${randomUUID()}${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimeType }));
  return { key, url: getFileUrl(key) };
}

// ── Direct browser → MinIO uploads ──────────────────────────────────────────
// The browser PUTs the file straight to MinIO with a short-lived signed URL;
// the API never sees the bytes. The URL is signed for one key, one content
// type and one exact size, so it can't be reused to write anything else.
//
// MINIO_PUBLIC_ENDPOINT: the address browsers use, if it differs from the one
// the API uses (e.g. an internal Docker hostname). Signatures cover the host,
// so the URL must be signed for the address the browser will actually call.
// MINIO_PUBLIC_URL is accepted as the same setting.
const PUBLIC_ENDPOINT = toEndpointUrl(process.env.MINIO_PUBLIC_ENDPOINT || process.env.MINIO_PUBLIC_URL) || ENDPOINT || '';
//
// Its own client: recent AWS SDKs add an x-amz-checksum-crc32 to signed URLs,
// computed over an EMPTY body at signing time. MinIO checks it against the
// uploaded file and rejects every upload. WHEN_REQUIRED keeps it out.
const publicS3 = new S3Client({
  endpoint: PUBLIC_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY, secretAccessKey: process.env.MINIO_SECRET_KEY },
});
const PUBLIC_BASE_URL = `${PUBLIC_ENDPOINT}/${BUCKET}`;

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

async function createPresignedUpload({ prefix, contentType, size, expiresIn = 300 }) {
  const ext = IMAGE_EXT[contentType];
  if (!ext) throw new Error('unsupported content type');
  const key = `${prefix}/${randomUUID()}${ext}`;
  const uploadUrl = await getSignedUrl(
    publicS3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) }
  );
  return { key, uploadUrl, url: `${PUBLIC_BASE_URL}/${key}`, expiresIn };
}

// First bytes of each allowed format — the stored content must really be one.
const MAGIC = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a',
  'image/webp': (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
};

/**
 * Confirm a directly-uploaded object exists and is the image it claims to be
 * (reads only the first 16 bytes — the API never downloads the file).
 * Returns { ok: true } or { ok: false, reason }.
 */
async function verifyUploadedImage(key, { maxBytes }) {
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    return { ok: false, reason: err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' ? 'missing' : 'unreachable' };
  }
  const type = head.ContentType;
  if (!MAGIC[type]) return { ok: false, reason: 'type' };
  if (!head.ContentLength || head.ContentLength > maxBytes) return { ok: false, reason: 'size' };
  const part = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: 'bytes=0-15' }));
  const bytes = Buffer.from(await part.Body.transformToByteArray());
  if (!MAGIC[type](bytes)) return { ok: false, reason: 'content' };
  return { ok: true };
}

// Key for a URL under either the API's or the browser's MinIO address.
function keyFromAnyUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith(PUBLIC_BASE_URL + '/')) return url.slice(PUBLIC_BASE_URL.length + 1);
  return extractKey(url);
}

module.exports = {
  uploadFile, getFileUrl, extractKey, listFiles, deleteFile, replaceFile,
  createPresignedUpload, verifyUploadedImage, keyFromAnyUrl, IMAGE_EXT,
};
