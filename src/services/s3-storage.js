import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../config.js";

const s3Client = new S3Client({ region: env.AWS_REGION });

export const uploadEncryptedPdf = async ({ organizationId, clientId, noteId, pdfBuffer }) => {
  const objectKey = `${organizationId}/${clientId}/${noteId}.pdf`;
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

export const createSignedPdfDownloadUrl = async ({ objectKey, expiresInSeconds }) => {
  const getCommand = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: objectKey,
    ResponseContentType: "application/pdf",
  });

  const url = await getSignedUrl(s3Client, getCommand, {
    expiresIn: expiresInSeconds,
  });
  return { url };
};
