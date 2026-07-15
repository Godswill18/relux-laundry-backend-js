const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const path = require('path');

const ENDPOINT = process.env.MINIO_ENDPOINT; // e.g. https://storage.dotnetpro.tech
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
  const ext = path.extname(originalName).toLowerCase();
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

module.exports = { uploadFile, getFileUrl, extractKey, listFiles, deleteFile, replaceFile };
