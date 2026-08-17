import axios from "axios";

import { env } from "../config.js";

const pauboxClient = axios.create({
  baseURL: `https://api.paubox.net/v1/${env.PAUBOX_API_ENDPOINT}`,
  headers: {
    Authorization: `Bearer ${env.PAUBOX_API_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 15_000,
});

export const sendEncryptedNoteEmail = async ({ toEmail, attachmentBuffer, noteId }) => {
  const response = await pauboxClient.post("/messages", {
    data: {
      message: {
        recipients: [toEmail],
        forceSecureNotification: true,
        headers: {
          subject: "Your encrypted session note",
          from: env.PAUBOX_FROM_EMAIL,
        },
        content: {
          "text/plain":
            "Your provider shared an encrypted session document. Open the attached PDF in your secure mail portal.",
        },
        attachments: [
          {
            fileName: `soap-note-${noteId}.pdf`,
            contentType: "application/pdf",
            content: attachmentBuffer.toString("base64"),
          },
        ],
      },
    },
  });

  const messageId = response.data?.data?.id ?? response.data?.id ?? null;
  return { messageId };
};
