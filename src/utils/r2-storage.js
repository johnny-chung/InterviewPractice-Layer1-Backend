// Cloudflare R2 object storage helper (S3 compatible)
/**
 * Provides thin wrappers around AWS SDK S3Client for R2 usage.
 * Exported helpers:
 *  - putObject(key, body, contentType): Uploads bytes/Buffer.
 *  - getObjectBytes(key): Downloads entire object into a Buffer.
 * Lazily instantiates S3 client so tests can mock before first use.
 */
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const config = require("../config");

if (
  !config.r2 ||
  !config.r2.bucket ||
  !config.r2.accessKeyId ||
  !config.r2.secretAccessKey
) {
  // Allow app to start for non-upload routes, but any storage call will throw clearer message.
  // Intentionally not throwing at module load to keep tests/dev flexible when storage not needed.
}

let s3Client;
function getClient() {
  /**
   * getClient
   * Lazily create and cache S3Client instance (region 'auto' for R2) using configured credentials.
   * @returns {S3Client}
   */
  if (!s3Client) {
    const { endpoint, accessKeyId, secretAccessKey } = config.r2 || {};
    s3Client = new S3Client({
      region: "auto",
      endpoint,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }
  return s3Client;
}

async function putObject(key, body, contentType) {
  /**
   * putObject
   * Upload object bytes.
   * @param {string} key Object key within bucket
   * @param {Buffer|Uint8Array|string} body Content
   * @param {string} contentType MIME type
   * @returns {Promise<string>} key
   */
  const bucket = config.r2.bucket;
  if (!bucket) throw new Error("R2 bucket not configured");
  const client = getClient();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await client.send(cmd);
  return key;
}

async function getObjectBytes(key) {
  /**
   * getObjectBytes
   * Download object fully into memory. Suitable for <=10MB files used here.
   * @param {string} key
   * @returns {Promise<Buffer>}
   */
  const bucket = config.r2.bucket;
  if (!bucket) throw new Error("R2 bucket not configured");
  const client = getClient();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const resp = await client.send(cmd);
  const stream = resp.Body; // Node.js Readable
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { putObject, getObjectBytes };
