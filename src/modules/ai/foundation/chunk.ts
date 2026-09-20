/* Cắt tài liệu thành đoạn ~size ký tự theo đoạn văn (dùng cả ở seed nên KHÔNG phụ thuộc Nest/Prisma). */
export function chunkText(content: string, size = 700): string[] {
  const paras = content.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size * 1.5) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur) out.push(cur);
  return out;
}
