import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import dayjs from "dayjs";

const lineHeight = 16;
const margin = 50;

const drawSection = (page, font, y, title, content) => {
  page.drawText(title, {
    x: margin,
    y,
    size: 12,
    font,
    color: rgb(0.16, 0.16, 0.16),
  });
  const wrapped = content
    .split(/\r?\n/)
    .flatMap((line) => line.match(/.{1,98}/g) ?? [""]);

  let nextY = y - lineHeight;
  for (const line of wrapped) {
    page.drawText(line, {
      x: margin + 8,
      y: nextY,
      size: 10,
      font,
      color: rgb(0, 0, 0),
    });
    nextY -= lineHeight;
  }
  return nextY - 8;
};

export const buildSoapNotePdfBuffer = async ({
  note,
  therapistName,
  organizationName,
  client,
}) => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 750;

  page.drawText("SOAP Session Note", {
    x: margin,
    y,
    size: 18,
    font: boldFont,
    color: rgb(0.05, 0.12, 0.3),
  });
  y -= 28;

  const noteDate = dayjs(note.session_at ?? note.created_at).format("YYYY-MM-DD HH:mm");
  const headerRows = [
    `Organization: ${organizationName}`,
    `Therapist: ${therapistName}`,
    `Client: ${client.first_name} ${client.last_name}`,
    `Session Date: ${noteDate}`,
    `Retention Until: ${dayjs(note.retention_until).format("YYYY-MM-DD")}`,
    `Record ID: ${note.id}`,
  ];

  for (const row of headerRows) {
    page.drawText(row, {
      x: margin,
      y,
      size: 10,
      font,
    });
    y -= 14;
  }
  y -= 10;

  y = drawSection(page, boldFont, y, "Subjective", note.subjective);
  y = drawSection(page, boldFont, y, "Objective", note.objective);
  y = drawSection(page, boldFont, y, "Assessment", note.assessment);
  drawSection(page, boldFont, y, "Plan", note.plan);

  return Buffer.from(await pdfDoc.save());
};
