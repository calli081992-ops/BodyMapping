import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../config.js";

const s3Client = new S3Client({ region: env.AWS_REGION });

export const buildObjectKey = ({ organizationId, clientId, noteId }) =>
  `${organizationId}/${clientId}/${noteId}.pdf`;

export const uploadEncryptedPdf = async ({ organizationId, clientId, noteId, pdfBuffer }) => {
  const objectKey = buildObjectKey({ organizationId, clientId, noteId });
  const putCommand = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: objectKey,
    Body: pdfBuffer,
    ContentType: "application/pdf",
    ServerSideEncryption: env.AWS_KMS_KEY_ID ? "aws:kms" : "AES256",
    SSEKMSKeyId: env.AWS_KMS_KEY_ID,
    Metadata: {
      tenant: organizationId,
      client: clientId,
      note: noteId,
    },
  });

  const result = await s3Client.send(putCommand);

  return {
    objectKey,
    etag: result.ETag ?? null,
  };
};

// Short-lived, signed URL for downloading a stored encrypted PDF. TTL is bounded by
// PDF_DOWNLOAD_URL_TTL_SECONDS so links expire quickly.
export const createEncryptedPdfDownloadUrl = async ({ objectKey, expiresInSeconds = env.PDF_DOWNLOAD_URL_TTL_SECONDS }) => {
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: objectKey,
  });
  const url = await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  return { url, expiresInSeconds };
};
